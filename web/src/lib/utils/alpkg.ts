// Browser-native packer for the `.alpkg` operator-facing artefact
// the Deploy module emits when an operator exports a trained head.
// The artefact is a tiny ZIP archive (deflate-raw compression via
// `CompressionStream`) carrying three entries laid out under a
// `head/` subdirectory plus a top-level `package.json` manifest;
// the choice of ZIP keeps the file operator-inspectable with any
// unzip tool while staying self-describing for a future import
// path.  No third-party JS dependency: the daemon owns the
// authoritative head bytes, the importer round-trips through the
// same SHA-256 hashes we record in `package.json`, and the
// encoder we hand-roll here is small enough (~200 LOC) that it
// reads as one mental unit instead of an opaque vendor blob.
//
// Wire layout (UTF-8, little-endian per the ZIP spec):
//
//   <Local File Header><file 1 deflated bytes>
//   <Local File Header><file 2 deflated bytes>
//   ...
//   <Central Directory entry 1>
//   <Central Directory entry 2>
//   ...
//   <End-of-Central-Directory Record>
//
// Only two record types are emitted; we skip Zip64 entirely
// because the 4 GiB single-file cap is unreachable for trained
// heads (the daemon's `MAX_HEADS_PER_WORKSPACE = 3` and per-head
// `.mpk` payloads land in the low MiB range).  Defensive `>=
// 0xFFFFFFFE` guards below convert the impossible into a typed
// throw rather than silently emitting a corrupt archive.
//
// Compression: `CompressionStream('deflate-raw')` emits the raw
// RFC-1951 stream that ZIP method 8 expects (the bare `'deflate'`
// variant prepends a zlib wrapper per RFC 1950 and would produce
// an unreadable archive).  Supported in Chrome 103+, Firefox 113+,
// Safari 16.4+ -- all 2+ years old, well within the daemon's
// local-tool browser baseline.

// MARK: Public types

/// Each archive entry: a path (UTF-8) inside the archive + raw
/// bytes.  Paths are written verbatim; the caller picks the
/// layout (we use `head/<head_id>.{mpk,json}` for trained heads).
export interface AlpkgEntry {
  /// Slash-separated path inside the archive.  No leading slash.
  /// ASCII-clean recommended (the encoder does not set the
  /// UTF-8-filename ZIP flag); for the head export, every emitted
  /// path is `[A-Za-z0-9._/-]` so the simpler ASCII-only mode
  /// works.
  path: string;
  bytes: Uint8Array;
}

// MARK: Package-manifest schema

/// `package.json` carried at the alpkg root.  Minimal envelope:
/// the format discriminator, the schema version, and the
/// wall-clock the export pipeline ran.  Everything else is
/// derivable from the archive itself -- the `.alpkg` extension
/// + the `head/<id>.{mpk,json}` tree name the payload kind, and
/// the embedded `head/<id>.json` (the daemon's
/// `HeadManifest`) is the canonical source of `head_id`,
/// `workspace_id`, `workspace_revision`, `sha256`, `n_classes`,
/// `size_bytes`, `labels`, and `created_at`.  Duplicating those
/// fields here would invite drift between the envelope and the
/// daemon-authored payload and add nothing the importer can't
/// already verify by hashing the embedded `.mpk` against the
/// embedded manifest's `sha256`.
export interface AlpkgManifest {
  /// Format discriminator -- a literal so the importer can
  /// detect a non-alpkg ZIP before reading any entry.
  format: 'alpkg';
  /// Schema version.  Bumped only on a wire-incompatible change.
  version: 1;
  /// RFC3339 wall-clock at the moment the export pipeline
  /// pressed Save.  Not in any embedded file (the head's
  /// `created_at` records when training published the head, a
  /// different event), so this is the one operator-context
  /// timestamp that earns its keep in the envelope.
  exported_at: string;
}

// MARK: CRC-32 helper

// IEEE 802.3 polynomial, reflected.  Table built lazily on first
// use so the encoder is zero-cost to import in code paths that
// never pack anything (e.g. the importer reading only the central
// directory).
let CRC32_TABLE: Uint32Array | null = null;
function ensureCrcTable(): Uint32Array {
  if (CRC32_TABLE !== null) return CRC32_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  CRC32_TABLE = t;
  return t;
}

/// CRC-32 of the supplied bytes (unsigned).  Each ZIP entry
/// records this over the uncompressed payload regardless of
/// compression method.
export function crc32(bytes: Uint8Array): number {
  const table = ensureCrcTable();
  let c = 0xffffffff;
  for (const b of bytes) {
    c = (table[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// MARK: Deflate helper

/// Raw DEFLATE-compressed bytes (RFC 1951) suitable for ZIP
/// compression method 8.  Wrapped in a `Blob` so the
/// `CompressionStream` consumes a `ReadableStream`; the
/// `Response.arrayBuffer` consumer fully drains the pipe and
/// returns one contiguous buffer.  The `Uint8Array<ArrayBuffer>`
/// return type pins the backing buffer kind so downstream
/// `Blob([...])` constructors accept it without a cast under
/// TS 5.7's narrower `BlobPart` definition (which only admits
/// `ArrayBufferView<ArrayBuffer>` — the wider
/// `Uint8Array<ArrayBufferLike>` default trips a type error
/// even though the runtime would accept either).
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  // The runtime value `bytes` is always backed by an
  // `ArrayBuffer` for our call sites (fetch + TextEncoder both
  // yield owned-buffer typed arrays); the explicit cast just
  // resolves the static narrowing.
  const input = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
  const compressed = input.pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(compressed).arrayBuffer();
  return new Uint8Array(buf);
}

// MARK: ZIP record writers

const SIG_LFH = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
// ZIP method codes: 0 = STORE (no compression), 8 = DEFLATE.  The
// packer always uses DEFLATE; STORE stays in the wire constants for
// hex-grep readability against the ZIP spec.
const METHOD_DEFLATE = 8;
// Fixed DOS time/date at the start of the DOS epoch (1980-01-01
// 00:00:00).  Per-entry timestamps would tie the alpkg's bytes to
// wall-clock time and make the archive non-deterministic across
// re-exports of the same head; pinning to a fixed epoch keeps the
// bytes content-addressable while a higher-level `exported_at`
// timestamp lives in `package.json` where it's a first-class
// metadata field rather than baked into the ZIP wire format.
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;
// ZIP 4 GiB ceiling.  Beyond this the spec requires Zip64; we
// fail closed instead of silently truncating.
const ZIP32_MAX = 0xfffffffe;
const VERSION_NEEDED = 20; // 2.0 (DEFLATE)

function writeU16LE(dst: DataView, off: number, v: number): void {
  dst.setUint16(off, v, true);
}

function writeU32LE(dst: DataView, off: number, v: number): void {
  dst.setUint32(off, v >>> 0, true);
}

/// Local file header preceding each entry's compressed payload.
/// 30-byte fixed prefix + filename + extra (we emit no extras).
/// Returns `Uint8Array<ArrayBuffer>` (not the default wide
/// `Uint8Array<ArrayBufferLike>`) so the value fits TS 5.7's
/// stricter `BlobPart` shape at the packer's Blob construction.
function buildLocalHeader(
  nameBytes: Uint8Array,
  crc: number,
  compressedSize: number,
  uncompressedSize: number
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(30 + nameBytes.length);
  const dv = new DataView(out.buffer);
  writeU32LE(dv, 0, SIG_LFH);
  writeU16LE(dv, 4, VERSION_NEEDED);
  writeU16LE(dv, 6, 0); // general purpose bit flag
  writeU16LE(dv, 8, METHOD_DEFLATE);
  writeU16LE(dv, 10, DOS_TIME);
  writeU16LE(dv, 12, DOS_DATE);
  writeU32LE(dv, 14, crc);
  writeU32LE(dv, 18, compressedSize);
  writeU32LE(dv, 22, uncompressedSize);
  writeU16LE(dv, 26, nameBytes.length);
  writeU16LE(dv, 28, 0); // extra field length
  out.set(nameBytes, 30);
  return out;
}

/// Central-directory entry mirroring the local header but with
/// the LFH offset folded in.  46-byte fixed prefix + filename.
/// See `buildLocalHeader` for the `Uint8Array<ArrayBuffer>`
/// return-type rationale.
function buildCentralEntry(
  nameBytes: Uint8Array,
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
  localOffset: number
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(46 + nameBytes.length);
  const dv = new DataView(out.buffer);
  writeU32LE(dv, 0, SIG_CD);
  writeU16LE(dv, 4, (3 << 8) | VERSION_NEEDED); // version made by: unix (3) + 2.0
  writeU16LE(dv, 6, VERSION_NEEDED);
  writeU16LE(dv, 8, 0); // general purpose bit flag
  writeU16LE(dv, 10, METHOD_DEFLATE);
  writeU16LE(dv, 12, DOS_TIME);
  writeU16LE(dv, 14, DOS_DATE);
  writeU32LE(dv, 16, crc);
  writeU32LE(dv, 20, compressedSize);
  writeU32LE(dv, 24, uncompressedSize);
  writeU16LE(dv, 28, nameBytes.length);
  writeU16LE(dv, 30, 0); // extra field length
  writeU16LE(dv, 32, 0); // file comment length
  writeU16LE(dv, 34, 0); // disk number start
  writeU16LE(dv, 36, 0); // internal file attributes
  writeU32LE(dv, 38, 0); // external file attributes
  writeU32LE(dv, 42, localOffset);
  out.set(nameBytes, 46);
  return out;
}

function buildEocd(entryCount: number, cdSize: number, cdOffset: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(22);
  const dv = new DataView(out.buffer);
  writeU32LE(dv, 0, SIG_EOCD);
  writeU16LE(dv, 4, 0); // disk number
  writeU16LE(dv, 6, 0); // CD start disk
  writeU16LE(dv, 8, entryCount); // CD entries this disk
  writeU16LE(dv, 10, entryCount); // CD entries total
  writeU32LE(dv, 12, cdSize);
  writeU32LE(dv, 16, cdOffset);
  writeU16LE(dv, 20, 0); // zip comment length
  return out;
}

// MARK: Public packer

/// Pack the supplied entries into a `.alpkg` blob using ZIP +
/// DEFLATE.  Entries are written in the order supplied; the
/// `package.json` root manifest is conventionally first so a
/// streaming reader can detect the archive kind before seeking
/// the central directory.
///
/// Throws `RangeError` if any entry (or the archive total) would
/// exceed the ZIP32 4 GiB ceiling -- this is unreachable for
/// trained heads but documented as a typed failure rather than
/// silent corruption.
export async function packAlpkg(entries: readonly AlpkgEntry[]): Promise<Blob> {
  if (entries.length === 0) {
    throw new Error('alpkg: must supply at least one entry');
  }

  const encoder = new TextEncoder();
  // `Uint8Array<ArrayBuffer>` everywhere in the parts pipeline so
  // TS 5.7's stricter `BlobPart` (which insists on
  // `ArrayBufferView<ArrayBuffer>` rather than the looser
  // `Uint8Array<ArrayBufferLike>`) accepts every push without a
  // cast.  Per-entry input bytes are passed through `deflateRaw`
  // which returns the narrow shape; the helpers below also return
  // narrow.
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const cdEntries: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let entryCount = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    if (nameBytes.length > 0xffff) {
      throw new RangeError(`alpkg: filename too long (${nameBytes.length} bytes): ${entry.path}`);
    }
    const uncompressedSize = entry.bytes.length;
    if (uncompressedSize > ZIP32_MAX) {
      throw new RangeError(
        `alpkg: entry ${entry.path} exceeds ZIP32 size cap (${uncompressedSize} bytes)`
      );
    }
    const crc = crc32(entry.bytes);
    const compressed = await deflateRaw(entry.bytes);
    if (compressed.length > ZIP32_MAX) {
      throw new RangeError(
        `alpkg: entry ${entry.path} compressed size exceeds ZIP32 cap (${compressed.length} bytes)`
      );
    }
    const lfh = buildLocalHeader(nameBytes, crc, compressed.length, uncompressedSize);
    parts.push(lfh, compressed);
    cdEntries.push(buildCentralEntry(nameBytes, crc, compressed.length, uncompressedSize, offset));
    offset += lfh.length + compressed.length;
    if (offset > ZIP32_MAX) {
      throw new RangeError(`alpkg: archive size exceeds ZIP32 cap at entry ${entry.path}`);
    }
    entryCount++;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const cd of cdEntries) cdSize += cd.length;
  if (cdStart + cdSize > ZIP32_MAX) {
    throw new RangeError('alpkg: central directory offset exceeds ZIP32 cap');
  }
  parts.push(...cdEntries, buildEocd(entryCount, cdSize, cdStart));

  // `application/zip` is the closest standard MIME -- browsers
  // will use it for the SaveAs dialog default extension and
  // operating-system file-type detection; the actual extension
  // `.alpkg` survives via the `<a download>` attribute on the
  // trigger anchor.
  return new Blob(parts, { type: 'application/zip' });
}

// MARK: High-level alpkg API

/// Build the three-field `package.json` envelope.  Pure --
/// `now` is the only argument; tests can pin it for byte-
/// stable archive comparisons.  The function exists primarily
/// to give the schema one named construction site so a future
/// schema bump (v2) can be located by grep rather than by
/// chasing every inline object literal.
export function buildAlpkgManifest(now?: string): AlpkgManifest {
  return {
    format: 'alpkg',
    version: 1,
    exported_at: now ?? new Date().toISOString()
  };
}

// MARK: Filename safety

/// Reduce a workspace name to a filename-safe slug.  Same
/// allowlist as `AssetPath` (`[A-Za-z0-9._-]`) plus a run-
/// collapsing step so spaces / punctuation become a single
/// underscore.  Empty input (or input that reduces to empty)
/// falls back to the supplied `fallback`.
export function safeFilenameSlug(s: string, fallback: string): string {
  // Replace runs of disallowed bytes with a single underscore;
  // strip leading/trailing underscores so `"-- weird --"` ->
  // `"weird"` rather than `"_weird_"`.
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}
