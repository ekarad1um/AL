// Smooth a "playhead" sample cursor across bursty / jitter-prone
// PCM source clocks (network packets, AudioWorklet render quanta).
// Shared by `streams` (network opus stream) and `Recorder` (mic
// worklet) so the dashboard's live waveform and the recorder's
// live waveform get the same anti-aliasing pipeline.
//
// Algorithm: initialise the cursor `latencyMs` behind the live
// edge, then advance from RAF time at the nominal sample rate
// with a small proportional slew to track the live edge.  Large
// discontinuities (tab throttle, reconnects, stalls) snap back
// to the delayed live edge.
//
// Both consumers tune the same shape with different constants -- the
// network source needs a deeper buffer for packet jitter; the mic
// source can run tighter because the worklet's chunk jitter is
// bounded by the render-quantum cadence.

export interface SmoothingConfig {
  readonly latencyMs: number;
  // Hold rather than rewind if the buffer depth dips below this.
  readonly minDepthMs: number;
  // Snap to the live edge if depth grows past this.
  readonly maxDepthMs: number;
  // Snap on a single RAF gap longer than this (tab throttle).
  readonly resetAfterMs: number;
  // Cap the per-frame advance so a recovery tick doesn't fast-forward.
  readonly maxFrameMs: number;
  // Proportional slew gain (multiplier on normalised depth error).
  readonly slewGain: number;
  // Hard cap on per-frame slew so normal jitter never visibly speeds
  // up or slows down playback.
  readonly maxSlew: number;
}

export class CursorSmoother {
  private sample = 0;
  private timeMs = 0;
  private initialized = false;

  constructor(private readonly config: SmoothingConfig) {}

  reset(): void {
    this.sample = 0;
    this.timeMs = 0;
    this.initialized = false;
  }

  // Advance the cursor.  `latest` is the producer's exclusive
  // monotonic write index; `ringLength` bounds how far back the
  // source can serve.  Returns the floored cursor sample index.
  step(latest: number, ringLength: number, sampleRate: number, nowMs: number): number {
    if (latest === 0) {
      this.sample = 0;
      this.timeMs = nowMs;
      this.initialized = false;
      return 0;
    }
    const cfg = this.config;
    const oldestAvailable = Math.max(0, latest - ringLength);
    const samplesPerMs = sampleRate / 1000;
    const latencySamples = Math.max(0, cfg.latencyMs * samplesPerMs);
    const minDepthSamples = Math.min(latencySamples, cfg.minDepthMs * samplesPerMs);
    const maxDepthSamples = Math.max(latencySamples + 1, cfg.maxDepthMs * samplesPerMs);

    if (!this.initialized || this.sample < oldestAvailable || this.sample > latest) {
      return this.snapToEdge(latest, oldestAvailable, latencySamples, nowMs);
    }

    const rawDtMs = nowMs - this.timeMs;
    if (rawDtMs <= 0) return Math.floor(this.sample);
    this.timeMs = nowMs;

    const depthSamples = latest - this.sample;
    if (rawDtMs > cfg.resetAfterMs || depthSamples > maxDepthSamples) {
      return this.snapToEdge(latest, oldestAvailable, latencySamples, nowMs);
    }
    if (depthSamples < minDepthSamples) {
      // Underrun: hold rather than rewinding.  The next producer
      // tick will refill and bring depth back above min.
      return Math.floor(this.sample);
    }

    const dtMs = Math.min(rawDtMs, cfg.maxFrameMs);
    const normalizedError =
      latencySamples > 0
        ? (depthSamples - latencySamples) / latencySamples
        : depthSamples > 0
          ? 1
          : 0;
    let slew = normalizedError * cfg.slewGain;
    if (slew > cfg.maxSlew) slew = cfg.maxSlew;
    else if (slew < -cfg.maxSlew) slew = -cfg.maxSlew;
    const next = this.sample + dtMs * samplesPerMs * (1 + slew);

    const monotonicFloor = Math.max(this.sample, oldestAvailable);
    this.sample = Math.max(monotonicFloor, Math.min(next, latest));
    return Math.floor(this.sample);
  }

  private snapToEdge(
    latest: number,
    oldestAvailable: number,
    latencySamples: number,
    nowMs: number
  ): number {
    const cursor = Math.max(oldestAvailable, Math.min(latest, latest - latencySamples));
    this.sample = cursor;
    this.timeMs = nowMs;
    this.initialized = true;
    return Math.floor(cursor);
  }
}
