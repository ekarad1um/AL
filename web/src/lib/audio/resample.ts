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
//
// On top of the resample primitives, this module also exposes the
// input-module finalize entry points (`encodeWavFromFloat32`,
// `encodeWavFromChunks`).  These fold "resample + quantise +
// blob-wrap" into a single allocation pass: the resampler's output
// is consumed in place by the quantiser, which writes int16s
// directly into the pre-sized WAV ArrayBuffer.  No intermediate
// Float32 copy of the resampled signal, no `getChannelData().slice()`
// of the rendered buffer, and -- for the chunked recorder path --
// no full-buffer concat of the captured frames.  Memory peak at
// 50 min @ 48 kHz mono (the recording duration cap) drops from
// ~2.65 GiB (old: chunks + merged + OAC source + OAC output +
// slice'd output + WAV all coexist during `.slice()`) to ~1.07 GiB
// (new: chunks + OAC source overlap only during the populate loop,
// then source + output during render).  The new peak is the
// memory budget the recording cap is sized against.

import {
  WAV_HEADER_BYTES,
  WAV_MIME,
  WAV_SAMPLE_RATE,
  encodeWavPcm16,
  quantiseFloat32ToInt16,
  writeWavHeader
} from './wav';

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

// Decode an arbitrary-format audio file to a `Float32Array` at the
// browser's *native* sample rate, plus the discovered rate so the
// caller can decide whether to resample.  Caller is responsible for
// running the result through `encodeWavFromFloat32` (or another
// resample-capable consumer) when the rate differs from the
// canonical target.
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

// ─── Stream-encode finalize ─────────────────────────────────────
//
// Two entry points for the "give me a PCM-16 WAV blob at
// `outputRate`" pipeline that the input module's three capture
// paths (mic recorder, stream snapshot, WAV import) all converge
// on.  Both fold resample + quantise into a single allocation
// pass:
//
//   1. Allocate the OAC source AudioBuffer at `inputRate` exactly
//      once.
//   2. Populate its internal storage via direct `getChannelData(0)
//      .set(...)` writes (either one contiguous copy, or
//      chunk-by-chunk).  No `merged` intermediate, no second
//      `copyToChannel` memcpy.
//   3. `await offline.startRendering()` returns the AudioBuffer
//      holding the resampled output.
//   4. Quantise its internal storage straight into a pre-allocated
//      WAV ArrayBuffer -- skip the `.slice()` of `getChannelData(0)`
//      that the naive "resample to Float32 then encode" pair
//      otherwise allocates.
//   5. Wrap the WAV ArrayBuffer in a Blob.
//
// Rate-match fast path: when `inputRate === outputRate` we skip
// the OAC round-trip entirely and quantise the input straight into
// the WAV.  At ~88 KB/s, every byte of avoided copy translates to
// real wall-clock savings on long recordings.
//
// The output sample count is returned alongside the blob so the
// caller can derive `durationMs` (`pcm.length / outputRate * 1000`)
// without having to re-measure via the blob.

export interface EncodedWav {
  blob: Blob;
  outputSamples: number;
}

// Stream-encode a contiguous Float32 input (typical for the stream-
// snapshot path -- `streams.snapshotAt` already returns a freshly-
// allocated owned Float32, and for `decodeAudioFile`'s downmixed
// PCM).  The input is not mutated; the caller retains ownership and
// may free it after the awaited blob resolves.
export async function encodeWavFromFloat32(
  samples: Float32Array,
  inputRate: number,
  outputRate: number = WAV_SAMPLE_RATE
): Promise<EncodedWav> {
  if (samples.length === 0) return emptyWav(outputRate);
  if (inputRate === outputRate) {
    return {
      blob: encodeWavPcm16(samples, outputRate),
      outputSamples: samples.length
    };
  }
  const offline = makeOfflineContext(samples.length, inputRate, outputRate);
  const sourceBuf = offline.createBuffer(1, samples.length, inputRate);
  // `getChannelData(0).set` writes through the AudioBuffer's
  // internal storage view -- same memcpy cost as `copyToChannel`
  // but without the extra DOM-call overhead.  TS 5.7's tighter
  // Float32Array<ArrayBufferLike> discriminator doesn't apply to
  // `.set`, so no cast needed here (vs `copyToChannel`).
  sourceBuf.getChannelData(0).set(samples);
  return renderAndQuantise(offline, sourceBuf, outputRate);
}

// Stream-encode a sequence of Float32 chunks (mic recorder path:
// the AudioWorklet posts ~128-sample frames at the render quantum
// and we accumulate them in an array until stop()).  The chunks
// array is consumed -- entries are nulled out as each chunk is
// folded into the OAC source storage (or into the WAV bytes in
// the rate-match fast path), so the underlying transferred
// ArrayBuffers can GC during the populate loop instead of being
// pinned until the whole finalize completes.  The caller MUST
// release its own reference to the chunks array after passing it
// in and treat the array as moved-from.
//
// `totalSamples` MUST equal the sum of `chunks[i].length`.  The
// recorder tracks this via `capturedSamples` updated alongside
// every chunk push, so the invariant holds by construction.
export async function encodeWavFromChunks(
  chunks: Float32Array[],
  totalSamples: number,
  inputRate: number,
  outputRate: number = WAV_SAMPLE_RATE
): Promise<EncodedWav> {
  if (totalSamples === 0) return emptyWav(outputRate);
  if (inputRate === outputRate) {
    return {
      blob: encodeMonoChunksToWav(chunks, totalSamples, outputRate),
      outputSamples: totalSamples
    };
  }
  const offline = makeOfflineContext(totalSamples, inputRate, outputRate);
  const sourceBuf = offline.createBuffer(1, totalSamples, inputRate);
  const dest = sourceBuf.getChannelData(0);
  // Erase chunk slots inline so the transferred ArrayBuffers can
  // be GC'd as we fold them into `dest` -- otherwise 50 min of
  // captured Float32 (~550 MiB at 48 kHz mono) stays pinned for
  // the duration of the OAC render on top of the source buffer.
  // The runtime null is safe; the `Float32Array[]`-typed view is
  // moved-from after this loop.
  const slots = chunks as (Float32Array | null)[];
  let off = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    dest.set(chunk, off);
    off += chunk.length;
    slots[i] = null;
  }
  return renderAndQuantise(offline, sourceBuf, outputRate);
}

// Run the OAC render and fold the result into a WAV blob.  Wires
// the source buffer through a `BufferSource` node -- the offline
// context's only render strategy.
async function renderAndQuantise(
  offline: OfflineAudioContext,
  sourceBuf: AudioBuffer,
  outputRate: number
): Promise<EncodedWav> {
  const node = offline.createBufferSource();
  node.buffer = sourceBuf;
  node.connect(offline.destination);
  node.start();
  const rendered = await offline.startRendering();
  // `getChannelData(0)` returns the AudioBuffer's internal storage
  // view (not a copy) -- `encodeWavPcm16` reads from it directly
  // into the WAV's int16 region.  Nothing outside this function
  // references the AudioBuffer afterwards, so its storage GCs when
  // this scope exits.
  const samples = rendered.getChannelData(0);
  return {
    blob: encodeWavPcm16(samples, outputRate),
    outputSamples: samples.length
  };
}

// OAC factory.  `Math.ceil` (not floor) so a fractional final
// sample isn't truncated; the resampler pads any trailing slot with
// silence.  The clamp to `>= 1` guards against tiny inputs whose
// `ceil(length * ratio)` rounds to zero (browser rejects a
// zero-length OfflineAudioContext).
function makeOfflineContext(
  inputSamples: number,
  inputRate: number,
  outputRate: number
): OfflineAudioContext {
  const outputLength = Math.max(1, Math.ceil((inputSamples * outputRate) / inputRate));
  return new OfflineAudioContext(1, outputLength, outputRate);
}

// Rate-match fast path for the chunked input.  Avoids the OAC
// round-trip when input and output rates already match -- we just
// quantise into the WAV's int16 region chunk-by-chunk.

function encodeMonoChunksToWav(
  chunks: Float32Array[],
  totalSamples: number,
  sampleRate: number
): Blob {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + totalSamples * 2);
  const view = new DataView(buffer);
  writeWavHeader(view, totalSamples, sampleRate);
  // Quantise chunk-by-chunk straight into the WAV's int16 region.
  // Same null-out-as-we-go pattern as the resample path so the
  // captured Float32 frames release during the encode rather than
  // staying pinned through the whole blob construction.
  const slots = chunks as (Float32Array | null)[];
  let byteOff = WAV_HEADER_BYTES;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    quantiseFloat32ToInt16(buffer, byteOff, chunk);
    byteOff += chunk.length * 2;
    slots[c] = null;
  }
  return new Blob([buffer], { type: WAV_MIME });
}

// Empty-input convenience.  Produces a syntactically valid WAV with
// a zero-length data section; the canonical decoder handles it
// (`sampleCount = 0`) and downstream `durationMs` rounds to 0.
// Callers above guard against `length === 0` upstream so this is
// rarely hit -- it's a defensive end-stop, not a hot path.
function emptyWav(sampleRate: number): EncodedWav {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(buffer);
  writeWavHeader(view, 0, sampleRate);
  return {
    blob: new Blob([buffer], { type: WAV_MIME }),
    outputSamples: 0
  };
}
