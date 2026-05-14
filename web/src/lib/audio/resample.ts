// Audio shape normalization: arbitrary multichannel buffer at any
// rate -> mono Float32 at `WAV_SAMPLE_RATE` (44.1 kHz).  Two passes:
//
// 1. Downmix to mono by averaging channels -- preserves correlated
//    common signal while attenuating uncorrelated per-channel noise.
//    Taking channel 0 alone would drop right-channel content on
//    stereo phone recordings.
// 2. Resample via `OfflineAudioContext` -- browser-native polyphase
//    filter, off-main-thread.  Target rate is parametric; the
//    pipeline's canonical rate matches the daemon's training
//    preprocessor (`TARGET_SR = 44_100`).

import { WAV_SAMPLE_RATE } from './wav';

// Average all channels of `buffer` into a fresh Float32Array.
// Single-channel buffers short-circuit to a slice of the underlying
// data so the caller can mutate freely without affecting `buffer`.
export function downmixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    // `getChannelData` returns the internal storage; slice so the
    // caller can keep the buffer alive without holding the
    // AudioBuffer.
    return buffer.getChannelData(0).slice();
  }
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  const inv = 1 / buffer.numberOfChannels;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

// Resample a mono Float32 buffer from `inputRate` to `outputRate`.
// No-op when the rates match (returns a slice so the caller still
// owns a mutable copy).  Throws if the browser can't construct an
// OfflineAudioContext at the target rate (rare; Chrome / Firefox
// support 3 kHz..384 kHz; Safari has a tighter window).
export async function resampleMono(
  pcm: Float32Array,
  inputRate: number,
  outputRate: number = WAV_SAMPLE_RATE
): Promise<Float32Array> {
  if (inputRate === outputRate) return pcm.slice();
  if (pcm.length === 0) return new Float32Array(0);

  const ratio = outputRate / inputRate;
  // Round up so we don't truncate a fractional final sample; the
  // browser's resampler fills any trailing samples with silence.
  const outputLength = Math.max(1, Math.ceil(pcm.length * ratio));

  const offline = new OfflineAudioContext(1, outputLength, outputRate);
  const sourceBuf = offline.createBuffer(1, pcm.length, inputRate);
  // TS 5.7+ distinguishes `Float32Array<ArrayBuffer>` from the union
  // `Float32Array<ArrayBufferLike>` (which would include a Shared-
  // ArrayBuffer-backed view).  We never construct a SAB-backed input,
  // so the runtime contract is satisfied; cast away the strict
  // discriminator at the boundary.
  sourceBuf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);

  const node = offline.createBufferSource();
  node.buffer = sourceBuf;
  node.connect(offline.destination);
  node.start();

  const rendered = await offline.startRendering();
  // `getChannelData` is internal storage; slice for ownership safety.
  return rendered.getChannelData(0).slice();
}

// Decode an arbitrary-format audio file to a `Float32Array` at the
// browser's *native* sample rate, plus the discovered rate so the
// caller can decide whether to resample.  Caller is responsible for
// running `resampleMono` afterwards.
//
// The decoding `AudioContext` is single-use; we close it eagerly so
// the audio engine doesn't keep an extra device-locked thread alive
// for the lifetime of the tab.  `decodeAudioData` happily decodes at
// the source rate when the context's sampleRate matches; when they
// differ Chrome silently resamples, which is fine for *just* getting
// the bytes off disk (we'll re-resample anyway via OfflineAudioContext
// for deterministic output rate).
export async function decodeAudioFile(
  blob: Blob
): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctor =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    throw new Error('Web Audio API is unavailable in this browser.');
  }
  const ctx = new Ctor();
  try {
    // Some browsers reject decodeAudioData if the context isn't
    // running yet.  `decodeAudioData` doesn't require an output node,
    // so we don't `resume()` -- it runs on the decoder thread.
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    return {
      pcm: downmixToMono(decoded),
      sampleRate: decoded.sampleRate
    };
  } finally {
    // `close()` rejects in some old Safari builds; swallow because
    // we no longer have a use for the context regardless.
    try {
      await ctx.close();
    } catch {
      /* deliberate: best-effort teardown */
    }
  }
}
