// SHA-256 of arbitrary binary input, returned as lowercase hex.
// Wraps the platform `crypto.subtle.digest` (~0.1 ms / 88 KB on
// modern hardware) so the slice pipeline can derive a stable
// content-addressed id at production time without a per-byte JS
// loop.
//
// Why content addressing:
//   The slice's sha256 is the canonical identity across every
//   surface -- the daemon-side filename (`<sha>.wav`), the IDB
//   primary key, the spectrogram cache key, the in-memory blob
//   cache key.  The daemon's PUT receipt's `sha256` MUST equal
//   the value we computed before sending; a mismatch indicates
//   transport corruption and is treated as an upload failure.
//
// Why hash the WAV bytes (not the raw PCM):
//   The daemon computes sha256 over the request body, which is
//   the WAV envelope (44-byte header + Int16 LE PCM samples).
//   Matching exactly what the daemon hashes lets the receipt's
//   value flow through to the same id with no transformation.

export async function sha256Hex(data: ArrayBuffer | ArrayBufferView): Promise<string> {
  // TS 5.7 narrows `TypedArray.buffer` to `ArrayBuffer |
  // SharedArrayBuffer`; the platform's `crypto.subtle.digest`
  // accepts the union via `BufferSource`, but the TS lib type
  // for the slice path produces the wider union.  An explicit
  // copy into a fresh `ArrayBuffer` resolves the narrowing
  // without a runtime cost worth measuring.
  const buffer: ArrayBuffer =
    data instanceof ArrayBuffer
      ? data
      : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
          .buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toHex(new Uint8Array(digest));
}

// Hex-encode a byte array.  Lowercase to match the daemon's
// `hex_lowercase` helper (the upload receipt's `sha256` field
// uses lowercase hex too).
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}
