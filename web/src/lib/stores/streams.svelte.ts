import { createStreamClient, type SocketState, type StreamClient } from '$lib/stream/client';
import type { TopK } from '$lib/stream/proto';

// Singleton store wrapping the streaming worker.  Reactive fields (Svelte
// $state) update at human-readable rates (inference at ~4 Hz, status on
// change).  The PCM ring buffer is intentionally NON-reactive: at 50 Hz +
// 960 samples per frame, marking it $state would thrash every consumer.
// Renderers poll snapshot() at RAF instead.

const PCM_SAMPLE_RATE = 48_000;
const PCM_BUFFER_SECONDS = 10;
const DEFAULT_RENDER_LATENCY_MS = 120;
const RENDER_CLOCK_MIN_DEPTH_MS = 32;
const RENDER_CLOCK_MAX_DEPTH_MS = 500;
const RENDER_CLOCK_RESET_AFTER_MS = 250;
const RENDER_CLOCK_MAX_FRAME_MS = 100;
// Small PLL correction: keep normal playback within ±2.5% so drift is
// corrected without visible speed jumps.
const RENDER_CLOCK_SLEW_GAIN = 0.1;
const RENDER_CLOCK_MAX_SLEW = 0.025;

export interface HeadInfo {
  head_id: string | null;
  head_version: number | null;
}

class StreamsStore {
  audioStatus = $state<SocketState>('closed');
  inferStatus = $state<SocketState>('closed');
  latestTopK = $state<TopK[]>([]);
  head = $state<HeadInfo>({ head_id: null, head_version: null });
  unsupportedReason = $state<string | null>(null);
  inferenceFps = $state(0);

  readonly sampleRate = PCM_SAMPLE_RATE;
  readonly renderLatencyMs = DEFAULT_RENDER_LATENCY_MS;
  private readonly ring = new Float32Array(PCM_SAMPLE_RATE * PCM_BUFFER_SECONDS);
  private writeIdx = 0;
  private totalSamplesWritten = 0;
  private renderCursorSample = 0;
  private renderCursorTimeMs = performance.now();
  private renderCursorInitialized = false;

  private client: StreamClient | null = null;
  private started = false;
  private inferenceTimes: number[] = [];

  start(): void {
    if (this.started) return;
    this.started = true;
    this.client = createStreamClient();
    this.client.audio.on(({ pcm }) => {
      this.pushPcm(pcm);
    });
    this.client.inference.on(({ top_k, head_id, head_version }) => {
      this.latestTopK = top_k;
      if (head_id !== this.head.head_id || head_version !== this.head.head_version) {
        this.head = { head_id, head_version };
      }
      this.trackInferenceFps();
    });
    this.client.status.on(({ channel, state }) => {
      if (channel === 'audio') this.audioStatus = state;
      else this.inferStatus = state;
    });
    this.client.unsupported.on((reason) => {
      this.unsupportedReason = reason;
    });
    this.client.start();
  }

  stop(): void {
    if (!this.started) return;
    this.client?.stop();
    this.client = null;
    this.started = false;
  }

  // Most-recent `samples` PCM values.  Pass `out` to write in-place and
  // avoid the per-frame allocation (renderers run at 60 Hz so reusing a
  // pre-allocated buffer materially cuts GC churn -- ~35 MB/s at the
  // waveform's 144k-sample window).  When `out` is provided, `samples`
  // is clamped to `out.length`.
  snapshot(samples: number, out?: Float32Array): Float32Array {
    return this.snapshotAt(this.totalSamplesWritten, samples, out);
  }

  // Monotonic exclusive sample index for the visual playhead.  The PCM ring is
  // filled by decoded 20 ms Opus packets, and the browser can deliver those
  // packets in bursts (for example two packets back-to-back followed by a
  // ~40 ms gap).  If the renderer anchors directly to "latest write time", the
  // visual playhead inherits that burstiness even when RAF and canvas work are
  // perfectly smooth.
  //
  // Treat the ring as a tiny jitter buffer instead: initialize a playhead
  // `latencyMs` behind the live edge, then advance it from RAF time at the
  // nominal sample rate.  A small proportional slew keeps the buffer depth near
  // the target without stepping on normal packet jitter; large discontinuities
  // (tab throttling, reconnects, or stalls) reset to the delayed live edge.
  renderCursor(latencyMs = DEFAULT_RENDER_LATENCY_MS, nowMs = performance.now()): number {
    const latest = this.totalSamplesWritten;
    if (latest === 0) {
      this.renderCursorSample = 0;
      this.renderCursorTimeMs = nowMs;
      this.renderCursorInitialized = false;
      return 0;
    }

    const oldestAvailable = Math.max(0, latest - this.ring.length);
    const samplesPerMs = this.sampleRate / 1000;
    const latencySamples = Math.max(0, latencyMs * samplesPerMs);
    const minDepthSamples = Math.min(latencySamples, RENDER_CLOCK_MIN_DEPTH_MS * samplesPerMs);
    const maxDepthSamples = Math.max(latencySamples + 1, RENDER_CLOCK_MAX_DEPTH_MS * samplesPerMs);

    if (
      !this.renderCursorInitialized ||
      this.renderCursorSample < oldestAvailable ||
      this.renderCursorSample > latest
    ) {
      return this.resetRenderCursor(latest, oldestAvailable, latencySamples, nowMs);
    }

    const rawDtMs = nowMs - this.renderCursorTimeMs;
    if (rawDtMs <= 0) return Math.floor(this.renderCursorSample);
    this.renderCursorTimeMs = nowMs;

    const depthSamples = latest - this.renderCursorSample;
    if (rawDtMs > RENDER_CLOCK_RESET_AFTER_MS || depthSamples > maxDepthSamples) {
      return this.resetRenderCursor(latest, oldestAvailable, latencySamples, nowMs);
    }
    if (depthSamples < minDepthSamples) {
      // Underrun edge: hold rather than rewinding to the delayed live edge.
      return Math.floor(this.renderCursorSample);
    }

    const dtMs = Math.min(rawDtMs, RENDER_CLOCK_MAX_FRAME_MS);
    const normalizedError =
      latencySamples > 0
        ? (depthSamples - latencySamples) / latencySamples
        : depthSamples > 0
          ? 1
          : 0;
    const slew = clamp(
      normalizedError * RENDER_CLOCK_SLEW_GAIN,
      -RENDER_CLOCK_MAX_SLEW,
      RENDER_CLOCK_MAX_SLEW
    );
    const next = this.renderCursorSample + dtMs * samplesPerMs * (1 + slew);

    const monotonicFloor = Math.max(this.renderCursorSample, oldestAvailable);
    this.renderCursorSample = Math.max(monotonicFloor, Math.min(next, latest));
    return Math.floor(this.renderCursorSample);
  }

  // Min/max waveform envelope ending at `endSample`, written directly from the
  // PCM ring into caller-owned buffers.  This is the waveform hot path: it
  // avoids copying the full 3 s window (~144k floats) every RAF only to reduce
  // it to one min/max pair per screen column.
  envelopeAt(
    endSample: number,
    samples: number,
    bins: number,
    lo: Float32Array,
    hi: Float32Array
  ): void {
    const n = Math.min(bins, lo.length, hi.length);
    if (n <= 0) return;
    lo.fill(0, 0, n);
    hi.fill(0, 0, n);

    const latest = this.totalSamplesWritten;
    if (latest === 0 || samples <= 0) return;
    const r = this.ring.length;
    const oldestAvailable = Math.max(0, latest - r);
    const clampedEnd = Math.max(oldestAvailable, Math.min(Math.floor(endSample), latest));
    const requestedStart = clampedEnd - samples;
    const samplesPerBin = samples / n;

    for (let x = 0; x < n; x++) {
      const rawStart = Math.floor(requestedStart + x * samplesPerBin);
      const rawEnd = Math.floor(requestedStart + (x + 1) * samplesPerBin);
      const start = Math.max(rawStart, oldestAvailable);
      const stop = Math.min(rawEnd, clampedEnd);
      if (stop <= start) continue;

      let min = 0;
      let max = 0;
      for (let p = start; p < stop; p++) {
        const v = this.ring[p % r];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      lo[x] = min;
      hi[x] = max;
    }
  }

  // Samples ending at an absolute exclusive sample index.  This is the sync
  // primitive used by all visualizers: a caller computes one render cursor and
  // every panel samples the same audio-time window instead of independently
  // asking for "latest" at slightly different moments.
  snapshotAt(endSample: number, samples: number, out?: Float32Array): Float32Array {
    const r = this.ring.length;
    const n = Math.min(samples, r, out?.length ?? Infinity);
    const buf = out ?? new Float32Array(n);
    if (n === 0) return buf;

    buf.fill(0);
    const latest = this.totalSamplesWritten;
    const oldestAvailable = Math.max(0, latest - r);
    const clampedEnd = Math.max(oldestAvailable, Math.min(Math.floor(endSample), latest));
    const requestedStart = clampedEnd - n;
    const copyStart = Math.max(requestedStart, oldestAvailable);
    const copyLen = clampedEnd - copyStart;
    if (copyLen <= 0) return buf;

    const dst = copyStart - requestedStart;
    const start = copyStart % r;
    if (start + copyLen <= r) {
      buf.set(this.ring.subarray(start, start + copyLen), dst);
    } else {
      const head = r - start;
      buf.set(this.ring.subarray(start), dst);
      buf.set(this.ring.subarray(0, copyLen - head), dst + head);
    }
    return buf;
  }

  private pushPcm(pcm: Float32Array): void {
    const n = pcm.length;
    const r = this.ring.length;
    const space = r - this.writeIdx;
    if (n <= space) {
      this.ring.set(pcm, this.writeIdx);
    } else {
      this.ring.set(pcm.subarray(0, space), this.writeIdx);
      this.ring.set(pcm.subarray(space), 0);
    }
    this.writeIdx = (this.writeIdx + n) % r;
    this.totalSamplesWritten += n;
  }

  private resetRenderCursor(
    latest: number,
    oldestAvailable: number,
    latencySamples: number,
    nowMs: number
  ): number {
    const cursor = Math.max(oldestAvailable, Math.min(latest, latest - latencySamples));
    this.renderCursorSample = cursor;
    this.renderCursorTimeMs = nowMs;
    this.renderCursorInitialized = true;
    return Math.floor(cursor);
  }

  private trackInferenceFps(): void {
    const now = performance.now();
    this.inferenceTimes.push(now);
    const cutoff = now - 2_000;
    while (this.inferenceTimes.length > 0 && this.inferenceTimes[0] < cutoff) {
      this.inferenceTimes.shift();
    }
    this.inferenceFps = this.inferenceTimes.length / 2;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export const streams = new StreamsStore();
