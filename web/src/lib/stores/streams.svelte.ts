import { createStreamClient, type SocketState, type StreamClient } from '$lib/stream/client';
import type { TopK } from '$lib/stream/proto';
import type { PcmSource } from '$lib/audio/pcm-source';
import { CursorSmoother } from '$lib/audio/cursor-smoother';
import { envelopeFromRing, pushToRing } from '$lib/audio/ring-buffer';

// Singleton store wrapping the streaming worker.  Reactive fields (Svelte
// $state) update at human-readable rates (inference at ~4 Hz, status on
// change).  The PCM ring buffer is intentionally NON-reactive: at 50 Hz +
// 960 samples per frame, marking it $state would thrash every consumer.
// Renderers poll snapshot() at RAF instead.

const PCM_SAMPLE_RATE = 48_000;
const PCM_BUFFER_SECONDS = 10;
const DEFAULT_RENDER_LATENCY_MS = 120;

export interface HeadInfo {
  head_id: string | null;
  head_version: number | null;
}

class StreamsStore implements PcmSource {
  audioStatus = $state<SocketState>('closed');
  inferStatus = $state<SocketState>('closed');
  latestTopK = $state<TopK[]>([]);
  head = $state<HeadInfo>({ head_id: null, head_version: null });
  unsupportedReason = $state<string | null>(null);
  inferenceFps = $state(0);

  readonly sampleRate = PCM_SAMPLE_RATE;
  readonly renderLatencyMs = DEFAULT_RENDER_LATENCY_MS;
  // PCM ring capacity in seconds.  Sized for visualizer lookback
  // (the dashboard's live waveform reads a sliding window from
  // here), NOT for long-form capture -- the InputPane stream
  // capture taps `pushPcm` via `tap()` below to accumulate beyond
  // ring rollover.  Exposed as a constant so `EnvelopeWaveform`
  // and other visualizers can size their internal scratch buffers
  // against the maximum window they could ever paint.
  readonly ringSeconds = PCM_BUFFER_SECONDS;
  private readonly ring = new Float32Array(PCM_SAMPLE_RATE * PCM_BUFFER_SECONDS);
  private writeIdx = 0;
  private totalSamplesWritten = 0;

  // Exclusive sample index of the latest PCM write.  Used by
  // visualizers (`EnvelopeWaveform`, the dashboard's `WaveformCanvas`)
  // to anchor a shared playhead so panels reading the ring at
  // slightly different moments still align on the same audio-time
  // window.  Read-only -- `pushPcm` is the only mutator.  (The
  // InputPane stream capture used to read this to size a
  // post-stop `snapshotAt` window; it now accumulates via `tap()`
  // below instead, since the ring is too shallow for long-form
  // capture.)
  get latestSample(): number {
    return this.totalSamplesWritten;
  }

  // PLL-style smoothing keeps normal playback within ±2.5 % so
  // packet jitter doesn't surface as visible speed jumps.  Looser
  // depth bounds than the recorder's smoother because network
  // packet jitter is bigger than worklet chunk jitter.
  private readonly smoother = new CursorSmoother({
    latencyMs: DEFAULT_RENDER_LATENCY_MS,
    minDepthMs: 32,
    maxDepthMs: 500,
    resetAfterMs: 250,
    maxFrameMs: 100,
    slewGain: 0.1,
    maxSlew: 0.025
  });

  private client: StreamClient | null = null;
  private started = false;
  private inferenceTimes: number[] = [];
  // PCM taps fired AFTER each frame lands in the ring (so a tap can
  // read `latestSample` and see the just-pushed packet included).
  // Used by `InputPane`'s stream-capture mode to accumulate the
  // captured signal beyond the ring's 10 s rollover -- the ring
  // itself is sized for visualizer lookback, not for long-form
  // capture.
  private readonly pcmTaps = new Set<(pcm: Float32Array) => void>();

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

  // Monotonic exclusive sample index for the visual playhead.
  // The PCM ring fills from decoded 20 ms opus packets which the
  // browser can deliver in bursts (two back-to-back then a ~40 ms
  // gap), so anchoring to "latest write" inherits that burstiness.
  // The `CursorSmoother` runs the ring as a jitter buffer: cursor
  // sits `latencyMs` behind the live edge and advances from RAF
  // time at nominal rate.  Signature matches `PcmSource` so
  // `EnvelopeWaveform` paints stream and mic data with one path.
  renderCursor(nowMs: number = performance.now()): number {
    return this.smoother.step(this.totalSamplesWritten, this.ring.length, this.sampleRate, nowMs);
  }

  // Min/max waveform envelope ending at `endSample`, written
  // directly into caller-owned buffers (no per-RAF allocation for
  // the ~144k-sample window).
  envelopeAt(
    endSample: number,
    samples: number,
    bins: number,
    lo: Float32Array,
    hi: Float32Array
  ): void {
    envelopeFromRing(this.ring, this.totalSamplesWritten, endSample, samples, bins, lo, hi);
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
    this.writeIdx = pushToRing(this.ring, this.writeIdx, pcm);
    this.totalSamplesWritten += pcm.length;
    // Fan out to taps AFTER the ring write so taps reading
    // `latestSample` from inside the callback see the just-pushed
    // packet's samples included.  `pushToRing` has copied `pcm`'s
    // contents into the ring, so the original transferred
    // ArrayBuffer would otherwise GC at function return; a tap that
    // retains the reference keeps the buffer alive for free.
    if (this.pcmTaps.size > 0) {
      for (const tap of this.pcmTaps) tap(pcm);
    }
  }

  // Subscribe to each PCM packet pushed into the ring.  The callback
  // receives a reference to the worker-transferred Float32Array;
  // the tap may retain it (no extra memcpy required) or read +
  // drop, the store does not depend on either choice.  Returns a
  // dispose closure that removes the tap idempotently.  Order of
  // dispatch across multiple taps is insertion order.
  tap(cb: (pcm: Float32Array) => void): () => void {
    this.pcmTaps.add(cb);
    return () => {
      this.pcmTaps.delete(cb);
    };
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

export const streams = new StreamsStore();
