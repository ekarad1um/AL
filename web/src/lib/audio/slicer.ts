import { SLICE_SAMPLES } from './wav';
import { wouldNanAtPreproc } from './silence';

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

// Filtered slicing: same as [`chunkPcmToSlices`] but drops
// windows that the daemon's preproc would NaN-reject (digital
// silence in any FFT frame).  Returns the kept slices plus the
// silent-skip count for the post-slice "X of Y skipped" notice.
//
// The skipped windows are never encoded / hashed / uploaded:
// they'd just consume the operator's drop-ratio budget at
// training time and surface as `DropRatioExceeded`.  Filtering
// here means a sliced batch is guaranteed to survive
// `extract_features` on the `dropped_nan` axis; the only way a
// committed slice still drops at preproc is `dropped_io`,
// which is structurally unreachable for FE-encoded PCM-i16
// (the daemon's WAV ingest accepts our shape unconditionally).
//
// Inlines `chunkPcmToSlices`'s clamping so the silence check
// runs against the *unallocated* PCM region (~88 KB per
// reject) rather than a freshly-allocated 1 s buffer.  On a
// recording that's mostly silence (a long bird-call trap with
// sparse events, say), this avoids 100+ transient
// `Float32Array` allocations whose only purpose was to be
// immediately GC'd; on the common case (every window kept)
// it's the same work as the prior implementation.
export function chunkPcmToValidSlices(
  pcm: Float32Array,
  startSamples: number,
  endSamples: number,
  sliceSamples: number = SLICE_SAMPLES
): { kept: Float32Array[]; silentDropped: number } {
  if (sliceSamples <= 0) {
    throw new Error('sliceSamples must be positive');
  }
  const clampedStart = Math.max(0, Math.min(startSamples, pcm.length));
  const clampedEnd = Math.max(clampedStart, Math.min(endSamples, pcm.length));
  const span = clampedEnd - clampedStart;
  const count = Math.floor(span / sliceSamples);
  if (count === 0) return { kept: [], silentDropped: 0 };

  const kept: Float32Array[] = [];
  let silentDropped = 0;
  for (let i = 0; i < count; i++) {
    const offset = clampedStart + i * sliceSamples;
    // Silence check before allocation: `wouldNanAtPreproc`
    // reads `pcm[offset..offset + PREPROC_WAVEFORM_LEN]`
    // (44 032 samples), which is exactly the prefix the
    // daemon's preproc consumes from a 44 100-sample slice.
    // Skipping silent windows here is bit-for-bit equivalent
    // to slicing them and then filtering -- `pcm.slice` would
    // just memcpy the same samples the silence check already
    // touched.
    if (wouldNanAtPreproc(pcm, offset)) {
      silentDropped++;
      continue;
    }
    // `.slice(begin, end)` allocates a fresh buffer + memcpy
    // in one pass.  Cheaper than `new Float32Array(n) +
    // .set(...)`, which zero-fills before overwriting.  Each
    // slice owns its buffer (subarray would alias the input
    // and break the encoder's contract).
    kept.push(pcm.slice(offset, offset + sliceSamples));
  }
  return { kept, silentDropped };
}
