// Shared interface implemented by every PCM source the waveform
// renderer can plot against -- the dashboard's network-fed
// `streams` store, the per-pane `Recorder` instance, or any other
// rolling-window source we add later (e.g. a decoded WAV
// playthrough).  Centralising the contract lets one
// `EnvelopeWaveform.svelte` paint every surface; the source owns
// the data shape and the jitter-smoothing, the renderer owns the
// canvas math.
//
// Why both `renderCursor` and `envelopeAt`?
//   * `renderCursor` advances at the source's nominal sample
//     rate from RAF time, decoupling visual flow from packet /
//     chunk arrival.  This is what eliminates the "waveform
//     blinks" effect you'd otherwise see when chunks arrive in
//     bursts (~94 Hz worklet vs 60 Hz RAF -- some frames see
//     two chunks worth of motion, others see none, producing a
//     visible step pattern).
//   * `envelopeAt(endSample, …)` is the actual data read: given
//     an end-sample chosen by the caller (typically the cursor),
//     fill caller-owned buffers with min / max per visual column.
//     Caller-owned buffers eliminate per-RAF allocations.
//
// The cursor returns the latest available sample when the source
// has no smoothing concerns (and 0 when the source is idle, so
// the renderer can skip drawing entirely without a separate
// `isActive` field).
export interface PcmSource {
  // Current native sample rate.  Returns 0 when the source is
  // idle (e.g. recorder hasn't been started, or stopped after a
  // capture).  The renderer's draw loop short-circuits on 0 so
  // an unmounted source doesn't paint stale buffers.
  readonly sampleRate: number;

  // Smoothed render-cursor sample index for the visual playhead.
  // `nowMs` is the RAF `DOMHighResTimeStamp` -- the source
  // advances its cursor from this timestamp at the nominal
  // sample rate, so a slow RAF + bursty data still produces a
  // smooth rolling envelope.  Implementations may clamp to the
  // available range and reset on long stalls.
  renderCursor(nowMs: number): number;

  // Fill caller-owned `lo` / `hi` buffers with the min / max
  // sample value within each of `bins` equal-width slots
  // covering `[endSample - samples, endSample)`.  Out-of-range
  // bins (before the oldest available sample, or beyond the
  // latest write) read as 0 so the renderer paints a flat
  // baseline for the unavailable region rather than reading
  // stale ring contents.
  envelopeAt(
    endSample: number,
    samples: number,
    bins: number,
    lo: Float32Array,
    hi: Float32Array
  ): void;
}
