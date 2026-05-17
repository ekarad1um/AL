// PCM-16 mono WAV encoder + low-level primitives.
//
// The whole dataset pipeline (drafts -> slices -> trainer) commits
// to one canonical audio shape: 44.1 kHz, mono, signed 16-bit
// little-endian PCM in a RIFF/WAVE container.  The rate matches the
// daemon's `TARGET_SR = 44_100` in [modules/preproc/wav_io.rs]; one
// architecture-spec slice is exactly 1 s = 44,100 samples (~88 KB
// once encoded), which is the unit the trainer's preprocessor reads.
// At 88 KB/slice, a workspace's 200 slices total ~17 MB of WAV
// bytes -- well within the daemon's 256 MiB per-upload cap.
//
// The encoder is deliberately allocation-light: one ArrayBuffer for
// the whole file, a single quantise loop.  No streaming, no
// chunking -- clips are short enough that the full buffer fits in
// memory comfortably and the cost dominates fully on the GC churn
// from chunked Blob concatenation otherwise.
//
// `encodeWavPcm16` here is the simple one-shot path for callers
// that already hold a contiguous Float32 buffer at the target rate
// (the slicer is the main user -- 1-second windows, ~176 KB each).
// The recorder + stream/import finalize paths use the stream-encode
// helpers in `resample.ts` (`encodeWavFromChunks` /
// `encodeWavFromFloat32`), which compose `writeWavHeader` +
// `quantiseFloat32ToInt16` below to fold the resample's output
// straight into the WAV ArrayBuffer without an intermediate Float32
// copy.

export const WAV_SAMPLE_RATE = 44_100;

// One architecture-spec slice = exactly 1 s of audio at the target
// rate.  Exposed as a named constant so B.4's slicer + B.5's
// spectrogram engine reference the same number; changing one
// without the other would silently misalign the slice grid.
export const SLICE_SAMPLES = WAV_SAMPLE_RATE;
export const WAV_NUM_CHANNELS = 1;
export const WAV_BITS_PER_SAMPLE = 16;
export const WAV_MIME = 'audio/wav';

// Header is constant for our shape: RIFF (12) + fmt (24) + data (8).
export const WAV_HEADER_BYTES = 44;

// One-time host-endianness detection.  The PCM-16 quantise loop
// writes through an `Int16Array` view when the host is little-
// endian (every shipped browser today: x86, ARM in LE mode, every
// Apple Silicon device) -- the bytes land directly in the LE order
// the WAV container requires, and we sidestep `DataView.setInt16`'s
// per-call bounds-check + endian-swap overhead (measured ~5-10x
// speedup on the inner loop on V8/JSC).  The DataView fallback
// below stays correct on any hypothetical big-endian host -- we
// just don't expect to ever execute it.
const IS_LITTLE_ENDIAN = (() => {
  const probe = new ArrayBuffer(2);
  new Uint16Array(probe)[0] = 0x0102;
  return new Uint8Array(probe)[0] === 0x02;
})();

// Write the canonical 44-byte RIFF/WAVE/fmt /data header into `view`
// starting at offset 0.  `numSamples` is the count of int16 mono
// samples that will follow the header (data section length =
// `numSamples * 2` bytes).
//
// Header is constant-size for our shape (mono PCM-16, no `fact`
// chunk).  Exposed so the stream-encode helpers in `resample.ts`
// can write the header into the WAV ArrayBuffer they're about to
// fill with quantised samples, without reaching back through
// `encodeWavPcm16` (which would also try to allocate the body).
export function writeWavHeader(
  view: DataView,
  numSamples: number,
  sampleRate: number = WAV_SAMPLE_RATE
): void {
  const dataLength = numSamples * 2;
  const blockAlign = WAV_NUM_CHANNELS * (WAV_BITS_PER_SAMPLE / 8);
  const byteRate = sampleRate * blockAlign;

  // RIFF chunk descriptor.
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true); // file length minus first 8 bytes
  writeAscii(view, 8, 'WAVE');

  // `fmt ` subchunk.
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM-fmt subchunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, WAV_NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, WAV_BITS_PER_SAMPLE, true);

  // `data` subchunk.
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLength, true);
}

// Quantise `samples` (Float32 in [-1, 1]) into `samples.length`
// little-endian int16s starting at `buffer[byteOffset]`.
//
// Values outside the unit range are clamped to ±1 before
// quantisation -- a true overflow at int16 would wrap to -32768
// and produce a click; clamping degrades gracefully to a flat
// ceiling.
//
// Quantisation uses the asymmetric int16 range: -1.0 maps to
// -32768, +1.0 maps to +32767.  Multiplying by 0x7FFF in both
// directions (the textbook formula) would lose half a bit of
// dynamic range on the negative side; this asymmetric formulation
// matches what most audio toolchains do and survives a lossless
// round-trip with `decodeCanonicalWavSync` in `wav-decode.ts`,
// which uses the inverse asymmetry.
//
// `byteOffset` must be 2-byte-aligned (the LE fast path needs that
// for `Int16Array` construction); every call site uses a multiple
// of `WAV_HEADER_BYTES + N*2`, which is even, so this is naturally
// satisfied.
export function quantiseFloat32ToInt16(
  buffer: ArrayBuffer,
  byteOffset: number,
  samples: Float32Array
): void {
  const n = samples.length;
  if (IS_LITTLE_ENDIAN) {
    // Fast path: write through an Int16Array view -- the bytes
    // land in LE order without DataView's per-call work.  Raw
    // `Int16Array` assignment would convert via ECMA `ToInt16`
    // (truncation toward zero), which loses the half-LSB of
    // resolution we want for dithered audio; we pre-round with
    // `Math.round` (ECMA "round half toward +Infinity") so the
    // quantisation is bit-identical to the slow path below and
    // the original DataView-based encoder.  The +/-Inf tie-break
    // direction is asymmetric (e.g. `Math.round(-0.5) === -0`),
    // but the asymmetry is symmetric across the encoder/decoder
    // pair -- the inverse mapping in `wav-decode.ts` ingests the
    // produced int16s losslessly.
    const out = new Int16Array(buffer, byteOffset, n);
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    }
    return;
  }
  // Big-endian host (not currently reachable on any shipping web
  // platform, but keeps the encoder portable).
  const view = new DataView(buffer);
  let off = byteOffset;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(off, int16, true);
    off += 2;
  }
}

// One-shot encode for callers that already hold a contiguous Float32
// buffer at `sampleRate`.  No resample step (the slicer's only
// caller hands us 44 100-sample windows already at the canonical
// rate).  Long-form recordings + stream snapshots use the
// `encodeWavFrom*` helpers in `resample.ts` instead -- they fold
// resample + quantise into a single allocation pass and avoid the
// intermediate Float32 copy this entry point's callers would have
// to allocate.
export function encodeWavPcm16(samples: Float32Array, sampleRate = WAV_SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(buffer);
  writeWavHeader(view, samples.length, sampleRate);
  quantiseFloat32ToInt16(buffer, WAV_HEADER_BYTES, samples);
  return new Blob([buffer], { type: WAV_MIME });
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
