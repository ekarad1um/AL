// Trained-head export orchestrator.  Two public entry points share
// the same per-head fetch + validate + entry-build core:
//
//   * `exportHead(input)`  -- single-head quick export from the
//                              HeadsTable row affordance.  Packs
//                              package.json + one head/<id>.{mpk,json}
//                              pair into its own `.alpkg`.
//   * `buildHeadEntries(workspaceId, heads, signal, onHeadDone?)`
//                            -- entries-only helper for the unified
//                              workspace exporter (which prepends
//                              its own package.json and combines
//                              with dataset entries before packing).
//
// Per-head pipeline (one call to `fetchAndValidateOneHead`):
//
//   1. GET /assets/heads/<id>.mpk   (binary weights)
//   2. GET /assets/heads/<id>.json  (HeadManifest JSON)
//   3. Parse + structural-validate the manifest.
//   4. Cross-check against the operator-clicked HeadRecord
//      (head_id, sha256, n_classes, size_bytes, workspace_revision).
//   5. Re-hash the weight bytes; verify against manifest.sha256.
//   6. Emit the two AlpkgEntry pair (`head/<id>.mpk`, `head/<id>.json`).
//
// Validation order mirrors the spec's "metadata first, then size +
// hash for the weight data".  We never claim the weights are good
// before the manifest agrees on their identity, and we fail closed
// at the first mismatch with a typed `ExportError` carrying the
// phase so the UI can pick the right copy.

import type { ApiErrorBody, HeadManifest, HeadRecord, Uuid } from './types';
import { ApiError } from './http';
import { heads } from './endpoints';
import { sha256Hex } from '$lib/audio/sha256';
import {
  buildAlpkgManifest,
  packAlpkg,
  safeFilenameSlug,
  type AlpkgEntry,
  type AlpkgManifest
} from '$lib/utils/alpkg';

// MARK: Public types

export type ExportPhase =
  | 'fetching-weights'
  | 'fetching-manifest'
  | 'validating'
  | 'packing'
  | 'downloading';

/// Typed pipeline failure.  `phase` names the step that threw so
/// the UI can pick operator copy ("Couldn't download head
/// weights" vs "Head metadata is malformed") without parsing the
/// message string.  Underlying daemon `ApiError` (when present)
/// is preserved on `cause` so the existing `errorCopy` machinery
/// can extract its code + body verbatim for the inline banner.
///
/// `headId` carries the offending head when the pipeline is in a
/// multi-head walk (`buildHeadEntries`); single-head call sites
/// leave it null because the head identity is obvious from
/// context.
export class ExportError extends Error {
  readonly phase: ExportPhase;
  readonly headId: Uuid | null;
  constructor(phase: ExportPhase, message: string, options?: { cause?: unknown; headId?: Uuid }) {
    super(message, options);
    this.name = 'ExportError';
    this.phase = phase;
    this.headId = options?.headId ?? null;
  }
}

export interface ExportHeadInput {
  workspaceId: Uuid;
  workspaceName: string;
  /// The list-row the operator clicked.  The pipeline cross-
  /// validates this against the daemon's per-head manifest -- a
  /// race where the row went stale between list + click surfaces
  /// as a typed `ExportError` rather than a successfully packed
  /// but inconsistent artefact.
  head: HeadRecord;
}

export interface ExportHeadOptions {
  /// Caller-supplied abort -- propagates into the fetch chain
  /// so a workspace-swap mid-export tears down the pipeline.
  signal?: AbortSignal;
}

export interface ExportResult {
  /// Filename suggested via `<a download>`.  Operating-system
  /// SaveAs dialogs may still rewrite this for collision
  /// avoidance, but the suggested name guarantees the `.alpkg`
  /// extension survives.
  filename: string;
  /// Packed archive size in bytes.  Exposed primarily for
  /// post-export telemetry / status copy.
  size_bytes: number;
}

// MARK: Public entry -- single-head export

export async function exportHead(
  input: ExportHeadInput,
  opts: ExportHeadOptions = {}
): Promise<ExportResult> {
  const { signal } = opts;
  const { workspaceId, workspaceName, head } = input;

  // The full fetch + validate dance for the one head.  Throws
  // typed `ExportError` on any mismatch.
  const pair = await fetchAndValidateOneHead(workspaceId, head, signal);

  // Package envelope.  Same `format / version / exported_at`
  // shape the dataset and unified workspace exporters use; the
  // file tree (`head/<id>.{mpk,json}`) names the payload kind
  // without an explicit `kind` discriminator in the envelope.
  const pkg: AlpkgManifest = buildAlpkgManifest();
  const pkgBytes = new TextEncoder().encode(stringifyAlpkgManifest(pkg));
  const entries: AlpkgEntry[] = [{ path: 'package.json', bytes: pkgBytes }, ...pair];

  throwIfAborted(signal, 'packing');
  const alpkgBlob = await packAlpkg(entries);

  throwIfAborted(signal, 'downloading');
  const filename = buildSingleHeadExportFilename(workspaceName, head.head_id);
  triggerDownload(alpkgBlob, filename);

  return { filename, size_bytes: alpkgBlob.size };
}

// MARK: Public entry -- multi-head entries (used by the unified
// workspace exporter; does NOT pack or trigger a download).

/// Fetch + validate every head in turn, return their entry pairs
/// concatenated in input order.  `onHeadDone(done, total)` fires
/// after each head's pair lands so the unified dialog can render
/// `n / total heads`.
///
/// Sequential rather than concurrent: each head's two fetches +
/// hash verification are tens-of-ms work, the head count per
/// workspace is small (typically 1-3, capped by the daemon's
/// `MAX_HEADS_PER_WORKSPACE`), and sequential keeps the progress
/// callback ordering trivial without holding multiple heads'
/// worth of weight bytes simultaneously.  Aborts between heads
/// surface promptly via the per-fetch signal check.
export async function buildHeadEntries(
  workspaceId: Uuid,
  headList: readonly HeadRecord[],
  signal: AbortSignal | undefined,
  onHeadDone?: (done: number, total: number) => void
): Promise<AlpkgEntry[]> {
  const entries: AlpkgEntry[] = [];
  const total = headList.length;
  let done = 0;
  for (const head of headList) {
    throwIfAborted(signal, 'fetching-weights');
    try {
      const pair = await fetchAndValidateOneHead(workspaceId, head, signal);
      entries.push(...pair);
    } catch (e) {
      // Re-throw with the offending head id attached so the
      // unified dialog's banner can name which head failed.  An
      // already-attributed ExportError is preserved (just gets
      // the head id stamped); other throws are wrapped.
      if (e instanceof ExportError && e.headId === null) {
        throw new ExportError(e.phase, e.message, { cause: e.cause, headId: head.head_id });
      }
      throw e;
    }
    done++;
    onHeadDone?.(done, total);
  }
  return entries;
}

// MARK: Internals -- per-head fetch + validate

async function fetchAndValidateOneHead(
  workspaceId: Uuid,
  head: HeadRecord,
  signal: AbortSignal | undefined
): Promise<[AlpkgEntry, AlpkgEntry]> {
  // Phase 1 -- weights.  Goes through the asset GET surface;
  // the daemon streams the on-disk file verbatim, so the
  // resulting buffer is byte-identical to what the daemon
  // hashes for `HeadManifest.sha256`.
  const weightsBytes = await fetchBinary(
    heads.weightsAssetPath(workspaceId, head.head_id),
    signal,
    'fetching-weights'
  );

  // Phase 2 -- manifest.  Same asset surface (not the dedicated
  // `/heads/{id}` route) so the operator-facing path is
  // symmetric with the weight fetch; the orphan-index filter
  // the dedicated route adds is redundant for callers who hold
  // a cached `HeadRecord`.
  const manifestRaw = await fetchBinary(
    heads.manifestAssetPath(workspaceId, head.head_id),
    signal,
    'fetching-manifest'
  );
  const manifest = parseManifestJson(manifestRaw);

  // Phase 3 -- validate.  Metadata-first (cheap structural +
  // cross-checks), then the expensive sha256 of the weights
  // against the manifest's recorded value.  We bail at the first
  // mismatch -- there is no "best-effort" export semantic.
  validateManifest(manifest, head, workspaceId);
  const weightsSha = await sha256Hex(weightsBytes);
  validateWeightsAgainstManifest(weightsBytes, weightsSha, manifest);

  // The embedded `.json` reuses the raw manifest bytes the daemon
  // served, verbatim (vs re-serialising the parsed object):
  //   1. Forward-compat -- a future daemon-side `HeadManifest`
  //      field would land in the parsed object via TS structural
  //      typing but would be silently dropped on the way back
  //      out through an enumerative re-serialiser.
  //   2. Byte-stability across re-exports.  The daemon's
  //      `serde_json` output already has deterministic
  //      whitespace + key ordering; verbatim preserves it
  //      without re-asserting it client-side.
  return [
    { path: `head/${manifest.head_id}.mpk`, bytes: weightsBytes },
    { path: `head/${manifest.head_id}.json`, bytes: manifestRaw }
  ];
}

// MARK: Internals -- fetch

async function fetchBinary(
  url: string,
  signal: AbortSignal | undefined,
  phase: ExportPhase
): Promise<Uint8Array> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw e; // honour caller abort
    throw new ExportError(phase, `Network error fetching ${url}`, { cause: e });
  }
  if (!resp.ok) {
    // Parse the daemon's `{error, code}` envelope so the UI's
    // `errorCopy` helper can pick fixed copy ("Conflict: ...")
    // when the code is recognised, falling back to the message
    // otherwise.  Mirrors `$lib/api/http.ts:parseError`.
    let body: ApiErrorBody;
    try {
      body = (await resp.json()) as ApiErrorBody;
    } catch {
      body = { error: resp.statusText || `HTTP ${resp.status}`, code: 'unknown' };
    }
    throw new ExportError(phase, body.error || `HTTP ${String(resp.status)}`, {
      cause: new ApiError(resp.status, body)
    });
  }
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

// MARK: Internals -- manifest decode + validation

function parseManifestJson(bytes: Uint8Array): HeadManifest {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try {
    return JSON.parse(text) as HeadManifest;
  } catch (e) {
    throw new ExportError('validating', 'Head metadata is not valid JSON', { cause: e });
  }
}

function validateManifest(manifest: HeadManifest, expected: HeadRecord, workspaceId: Uuid): void {
  // Structural shape -- `JSON.parse` returns `any` and the cast
  // to `HeadManifest` is unsound until each load-bearing field is
  // typed at runtime.  A tampered alpkg or a daemon misbehaviour
  // surfaces here rather than as an undefined-method throw deep
  // in the packer.
  if (typeof manifest.head_id !== 'string' || manifest.head_id.length === 0) {
    throw new ExportError('validating', 'Head metadata is missing the head id');
  }
  if (manifest.head_id !== expected.head_id) {
    throw new ExportError(
      'validating',
      `Head metadata reports a different head id (${manifest.head_id} vs ${expected.head_id})`
    );
  }
  // The manifest's `workspace_id` is the daemon's record of which
  // workspace produced the head; a hand-tampered manifest that
  // pointed at a different workspace would surface here rather
  // than slipping into the importer.
  if (typeof manifest.workspace_id !== 'string' || manifest.workspace_id !== workspaceId) {
    throw new ExportError(
      'validating',
      `Head metadata's workspace id (${manifest.workspace_id}) does not match the requested workspace (${workspaceId})`
    );
  }
  if (
    typeof manifest.n_classes !== 'number' ||
    !Number.isInteger(manifest.n_classes) ||
    manifest.n_classes < 1
  ) {
    throw new ExportError('validating', 'Head metadata has a non-positive class count');
  }
  if (typeof manifest.size_bytes !== 'number' || manifest.size_bytes < 0) {
    throw new ExportError('validating', 'Head metadata has an invalid size');
  }
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new ExportError('validating', 'Head metadata has an invalid sha256');
  }
  if (!Array.isArray(manifest.labels)) {
    throw new ExportError('validating', 'Head metadata is missing the labels array');
  }
  if (manifest.labels.length !== manifest.n_classes) {
    throw new ExportError(
      'validating',
      `Head metadata's label count (${String(manifest.labels.length)}) does not match n_classes (${String(manifest.n_classes)})`
    );
  }
  for (let i = 0; i < manifest.labels.length; i++) {
    const lbl = manifest.labels[i];
    if (typeof lbl !== 'string' || lbl.length === 0) {
      throw new ExportError(
        'validating',
        `Head metadata's label at index ${String(i)} is empty or not a string`
      );
    }
  }
  // Cross-check with the `HeadRecord` the operator clicked.  The
  // daemon's `list_heads` route builds rows from the cached
  // `heads.json` index so a divergence here points at a
  // concurrent train / delete that swapped the row out from
  // under the click; surface it as a clear mismatch rather
  // than packing a stale artefact.
  if (manifest.sha256 !== expected.sha256) {
    throw new ExportError(
      'validating',
      `Head metadata sha256 does not match the workspace's index (${manifest.sha256} vs ${expected.sha256})`
    );
  }
  if (manifest.n_classes !== expected.n_classes) {
    throw new ExportError(
      'validating',
      `Head metadata class count (${String(manifest.n_classes)}) does not match the workspace's index (${String(expected.n_classes)})`
    );
  }
  if (manifest.size_bytes !== expected.size_bytes) {
    throw new ExportError(
      'validating',
      `Head metadata size (${String(manifest.size_bytes)}) does not match the workspace's index (${String(expected.size_bytes)})`
    );
  }
  // The workspace revision the head was trained against should
  // match what the row reports.  An off-by-one here points at a
  // race where another producer published between list + click.
  // `workspace_revision` itself is type-checked first because a
  // tampered manifest could omit the entire nested object -- a
  // bare `.id` dereference below would then throw a raw
  // TypeError that bypasses the typed `ExportError` contract
  // the inline banner consumes (every other field check above
  // guards with `typeof X` against the *primitive* slot, so
  // missing top-level fields already surface as ExportError;
  // the nested case needs its own guard).  Cast to `unknown`
  // first so the strict null + typeof checks compile cleanly
  // under `@typescript-eslint/no-unnecessary-condition`: the
  // static type says `WorkspaceRevision` (non-null object) but
  // JSON.parse returns whatever was on the wire.
  const rev = manifest.workspace_revision as unknown;
  if (rev === null || typeof rev !== 'object' || typeof (rev as { id?: unknown }).id !== 'number') {
    throw new ExportError('validating', 'Head metadata workspace_revision is missing or malformed');
  }
  const manifestRevId = (rev as { id: number }).id;
  if (manifestRevId !== expected.workspace_revision.id) {
    throw new ExportError(
      'validating',
      `Head metadata workspace revision (${String(manifestRevId)}) does not match the workspace's index (${String(expected.workspace_revision.id)})`
    );
  }
}

function validateWeightsAgainstManifest(
  bytes: Uint8Array,
  observedSha: string,
  manifest: HeadManifest
): void {
  if (bytes.byteLength !== manifest.size_bytes) {
    throw new ExportError(
      'validating',
      `Head weight size (${String(bytes.byteLength)}) does not match the metadata's size (${String(manifest.size_bytes)})`
    );
  }
  if (observedSha !== manifest.sha256) {
    throw new ExportError(
      'validating',
      'Head weight hash does not match the metadata; the download is corrupted or the head changed mid-export.'
    );
  }
}

// MARK: Internals -- serialisation helpers

function stringifyAlpkgManifest(pkg: AlpkgManifest): string {
  return JSON.stringify(pkg, null, 2) + '\n';
}

// MARK: Internals -- filename + download trigger

function buildSingleHeadExportFilename(workspaceName: string, headId: Uuid): string {
  const wsSlug = safeFilenameSlug(workspaceName, 'workspace');
  const headSlug = headId.replace(/-/g, '').slice(0, 8);
  return `${wsSlug}-head-${headSlug}.alpkg`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.target = '_self';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer the revoke so the browser has time to start the
  // download.  A 30 s budget is plenty for the click handler to
  // hand off to the network stack.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30_000);
}

// MARK: Internals -- abort

function throwIfAborted(signal: AbortSignal | undefined, phase: ExportPhase): void {
  if (signal?.aborted === true) {
    const reason: unknown = signal.reason;
    const reasonMsg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'export aborted';
    throw new ExportError(phase, reasonMsg, { cause: reason });
  }
}
