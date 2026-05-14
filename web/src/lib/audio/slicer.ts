import { SLICE_SAMPLES } from './wav';

// Chunk a trimmed range of PCM samples into fixed-length slices.
//
// Architecture spec ([ARCHITECTURE.md §A.4 item 3.4]): every
// slice is exactly `SLICE_SAMPLES` = 44 100 samples = 1 s at
// 44.1 kHz.  We FLOOR-divide the trimmed range so each emitted
// slice contains 1 s of *real* audio -- a sub-slice trailing
// remainder is dropped, not silence-padded.  Half-silence
// slices were training-quality poison: for the background-noise
// category the zero tail shifted the energy distribution; for
// event categories the truncated event lost its tail.  The
// daemon's [`to_waveform`] in [modules/preproc/wav_io.rs] pads
// or truncates each input to `WaveformLen` = 44 032 samples on
// its own, so the web-side "pad to 44 100" the old algorithm
// added was never load-bearing for the daemon -- only for the
// (incorrect) "every full second produces a slice" UX.
//
// The trim UI enforces a >= 1 s gap between handles (see
// [TrimWaveform.svelte]'s `minGapSamples = SLICE_SAMPLES`), so a
// committed trim always yields >= 1 slice.  The caller's
// `canSlice` guard further requires `trimRangeSamples >=
// SLICE_SAMPLES`; the worst case reachable here (span = 0)
// returns an empty array.
//
// Behaviour:
//   - 1.0 s trimmed range -> 1 slice.
//   - 2.5 s trimmed range -> 2 slices; the trailing 0.5 s is
//     dropped (operator can extend the trim to claim it; the
//     status hint telegraphs the unused remainder).
//   - 5.0 s trimmed range -> 5 slices.
//
// Returns a fresh array of fresh `Float32Array`s -- each slice
// owns its buffer (`TypedArray.prototype.slice` allocates a new
// ArrayBuffer, unlike `subarray` which would alias the input).
// Inputs are not modified.
export function chunkPcmToSlices(
  pcm: Float32Array,
  startSamples: number,
  endSamples: number,
  sliceSamples: number = SLICE_SAMPLES
): Float32Array[] {
  if (sliceSamples <= 0) {
    throw new Error('sliceSamples must be positive');
  }
  // Clamp the range to the PCM bounds.  Off-by-one slop in the
  // trim UI (sub-sample drift) shouldn't cause us to read past
  // the end of the buffer.
  const clampedStart = Math.max(0, Math.min(startSamples, pcm.length));
  const clampedEnd = Math.max(clampedStart, Math.min(endSamples, pcm.length));
  const span = clampedEnd - clampedStart;
  const count = Math.floor(span / sliceSamples);
  if (count === 0) return [];

  const out: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    const offset = clampedStart + i * sliceSamples;
    // `.slice(begin, end)` allocates a fresh buffer + memcpy in
    // one pass.  Cheaper than `new Float32Array(n) + .set(...)`,
    // which zero-fills the destination before overwriting it.
    out.push(pcm.slice(offset, offset + sliceSamples));
  }
  return out;
}

// Helper for the trim UI: how many full slices a given range
// produces.  Trailing partials are dropped, matching the slicer
// itself.  Used to telegraph the slice count on the Slice
// button label and the selection-status hint.
export function sliceCountFor(
  startSamples: number,
  endSamples: number,
  sliceSamples: number = SLICE_SAMPLES
): number {
  if (sliceSamples <= 0) return 0;
  const span = Math.max(0, endSamples - startSamples);
  return Math.floor(span / sliceSamples);
}
