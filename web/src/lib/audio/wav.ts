// PCM-16 mono WAV encoder.
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
// the whole file, a single DataView write loop.  No streaming, no
// chunking -- clips are short enough that the full buffer fits in
// memory comfortably and the cost dominates fully on the GC churn
// from chunked Blob concatenation otherwise.

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
const HEADER_BYTES = 44;

// Encode `samples` (Float32 in [-1, 1]) as a PCM-16 mono WAV blob.
// Values outside the unit range are clamped to ±1 before
// quantisation -- a true overflow at int16 would wrap to -32768 and
// produce a click; clamping degrades gracefully to a flat ceiling.
//
// Quantisation uses the asymmetric int16 range: -1.0 maps to -32768,
// +1.0 maps to +32767.  Multiplying by 0x7FFF in both directions
// (the textbook formula) would lose half a bit of dynamic range on
// the negative side; this asymmetric formulation matches what most
// audio toolchains do and survives a lossless round-trip.
export function encodeWavPcm16(samples: Float32Array, sampleRate = WAV_SAMPLE_RATE): Blob {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataLength);
  const view = new DataView(buffer);
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

  let offset = HEADER_BYTES;
  for (const s of samples) {
    const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: WAV_MIME });
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
