// WAV-specific decode helpers.
//
// Two surfaces:
//
// 1. `verifyWavMagic` reads the first 12 bytes of an imported file
//    and confirms the RIFF/WAVE container.  The architecture spec
//    restricts imports to WAV format ("importing formats other than
//    WAV is not supported"); we reject everything else *before* the
//    expensive `AudioContext.decodeAudioData` so the operator sees
//    a clear, fast "only WAV" message instead of a vague
//    "EncodingError: Unable to decode audio data".
//
// 2. `decodeCanonicalWav` parses our own canonical WAV format
//    (44 kHz mono PCM-16, written by `encodeWavPcm16`) directly
//    into a Float32Array.  We bypass `AudioContext.decodeAudioData`
//    for stored drafts because that path resamples to the context's
//    rate (typically 48 kHz on macOS), losing alignment with the
//    44 100-sample slice grid B.4 will need.  For our drafts the
//    bytes are always in our format, so a direct PCM-16 read is
//    correct and avoids the rate-conversion detour.
//
// For *imported* WAV files (which may arrive at any rate / bit
// depth), the pipeline still goes through `decodeAudioFile` +
// `resampleMono` in `resample.ts` -- that's the only place we want
// the browser's WAV decoder to handle the matrix of (sample rate,
// bit depth, channel count) shapes.

import { WAV_SAMPLE_RATE } from './wav';

export interface WavMagicResult {
  valid: boolean;
  reason?: string;
}

// Verify the RIFF/WAVE 12-byte header.  Cheaper than reading the
// whole file (the magic is the first 12 bytes; we don't need the
// rest to make the accept/reject decision).
//
// Layout:
//   bytes 0-3   = "RIFF"
//   bytes 4-7   = file size minus 8 (little-endian; we don't check)
//   bytes 8-11  = "WAVE"
//
// The byte-level chunk parser inside `decodeAudioData` would catch
// these anyway, but its error messages are generic; we want the
// operator-facing message to name the actual problem ("not a WAV
// file") rather than the symptom ("decode failed").
export function verifyWavMagic(header: ArrayBuffer): WavMagicResult {
  if (header.byteLength < 12) {
    return {
      valid: false,
      reason: 'File is too small to be a WAV (need at least 12 bytes for the header).'
    };
  }
  const view = new DataView(header, 0, 12);
  const ascii = (offset: number, length: number): string => {
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  // Allow `RIFX` too (big-endian variant) -- valid WAV but
  // uncommon.  `decodeAudioData` handles both, so we should not
  // reject ahead of it.
  const riff = ascii(0, 4);
  if (riff !== 'RIFF' && riff !== 'RIFX') {
    return {
      valid: false,
      reason: 'Not a WAV file (missing RIFF magic).'
    };
  }
  if (ascii(8, 4) !== 'WAVE') {
    return {
      valid: false,
      reason: 'Not a WAV file (missing WAVE marker).'
    };
  }
  return { valid: true };
}

// Read a file's first 12 bytes for the magic check without
// reading the whole body.  `Blob.slice(0, 12).arrayBuffer()` is
// the standard cheap-prefix pattern.
export async function readWavMagic(blob: Blob): Promise<WavMagicResult> {
  if (blob.size < 12) {
    return { valid: false, reason: 'File is empty or too small to be a WAV.' };
  }
  const header = await blob.slice(0, 12).arrayBuffer();
  return verifyWavMagic(header);
}

// Fast path for stored drafts in our canonical WAV format (mono
// PCM-16 @ `WAV_SAMPLE_RATE`, 44-byte header written by
// `encodeWavPcm16`).  No AudioContext, no rate conversion, just a
// direct Int16 -> Float32 loop.  Assumes the encoder's exact byte
// layout -- arbitrary WAV imports go through `decodeAudioFile` in
// `resample.ts`, which handles (rate, bit-depth, channels) shapes.
//
// Shape matches `decodeAudioFile`'s `{pcm, sampleRate}` so callers
// can pipe either result through the same downstream helpers.
export interface DecodedWav {
  pcm: Float32Array;
  sampleRate: number;
}

// Read sample rate from offset 24 (RIFF/fmt subchunk) -- the
// encoder is the source of the rate, but reading it back lets a
// future canonical-rate change flow through transparently.
//
// PCM-16 LE -> Float32 in [-1, 1] uses the asymmetric quantisation
// matching the encoder: divide by 0x8000 for negatives, by 0x7FFF
// for positives.  Without the asymmetry a true -32768 sample (max
// negative) would decode to -1.0000305..., outside the unit range.
export function decodeCanonicalWavSync(buf: ArrayBuffer): DecodedWav {
  if (buf.byteLength < 44) {
    throw new Error('WAV buffer too small (need at least 44 bytes for the canonical header).');
  }
  const view = new DataView(buf);
  const sampleRate = view.getUint32(24, true);
  const sampleCount = (buf.byteLength - 44) >> 1;
  const pcm = new Float32Array(sampleCount);
  let offset = 44;
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(offset, true);
    pcm[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7fff;
    offset += 2;
  }
  return { pcm, sampleRate };
}

export async function decodeCanonicalWav(blob: Blob): Promise<DecodedWav> {
  return decodeCanonicalWavSync(await blob.arrayBuffer());
}

// Re-export the canonical rate so call sites don't have to import
// from both modules to know what to expect.
export { WAV_SAMPLE_RATE };
