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
//
// ## On-demand lifecycle (`acquire` / refcount)
//
// The worker -- and therefore the daemon's two WebSocket subscriptions
// (`/stream/audio`, `/stream/infer`) -- is gated on a refcount of
// active consumers.  Every UI surface that reads from the streams
// (dashboard panels, deploy-preview, InputPane stream capture)
// calls `streams.acquire()` on mount and disposes on unmount.  The
// store opens the worker on 0→1 and tears it down on 1→0; nothing
// runs while no one's watching.
//
// Why refcount instead of always-on:
//   - The Opus decode loop runs at ~50 Hz, each frame transferring
//     a Float32Array via worker postMessage.  On the workspace list
//     / detail (preview OFF, no stream-input capture) and the
//     converter route this is pure waste -- main-thread CPU,
//     allocator churn, and ~16 KB/s daemon-side bandwidth burnt
//     for surfaces that never read the ring.
//   - The 4-Hz inference stream is lighter but still pins a WS,
//     keeps the daemon's classifier pipeline awake, and posts
//     reactive `latestTopK` writes that re-trigger downstream
//     $derived chains even when no panel consumes them.
//
// Refcount + dispose-closure form keeps the consumer side trivial:
// `$effect(() => streams.acquire())` for unconditional mounts, or
// `$effect(() => { if (cond) return streams.acquire(); })` for
// gated lifetimes.  Svelte 5 runs the returned closure as the
// effect's cleanup, so route transitions and conditional toggles
// just work.
//
// Reset discipline on 1→0:
//   - Status fields snap back to `'closed'` -- the worker is gone,
//     anything else is misleading.
//   - `latestTopK`, `inferenceFps`, `head`, and the FPS rolling
//     window reset so a re-acquire doesn't surface stale numbers
//     from a prior session.
//   - The PCM ring is zeroed and `totalSamplesWritten` resets.
//     The smoother auto-resets after `resetAfterMs` (250 ms) of
//     no new samples, so its internal cursor untangles on its own
//     -- no explicit reset call needed.
//   - `unsupportedReason` is kept: WebCodecs availability is a
//     browser-capability fact that doesn't change between
//     acquires.

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
  // Count of live `acquire()` holders.  Worker runs while > 0.
  // Plain field (not `$state`): consumers don't render based on
  // refcount; they read the reactive status/topK fields, which
  // are driven by the worker's posted messages on the live edge.
  private refcount = 0;
  private inferenceTimes: number[] = [];
  // PCM taps fired AFTER each frame lands in the ring (so a tap can
  // read `latestSample` and see the just-pushed packet included).
  // Used by `InputPane`'s stream-capture mode to accumulate the
  // captured signal beyond the ring's 10 s rollover -- the ring
  // itself is sized for visualizer lookback, not for long-form
  // capture.
  private readonly pcmTaps = new Set<(pcm: Float32Array) => void>();

  // Increment the consumer refcount.  Opens the worker (and both
  // WebSockets) on 0→1.  Returns a dispose closure that decrements;
  // the worker stops on 1→0.  Dispose is idempotent so callers can
  // safely return it directly from a Svelte `$effect`:
  //
  //   $effect(() => streams.acquire());                          // page-scoped
  //   $effect(() => { if (active) return streams.acquire(); });  // gated
  //
  // Multiple acquirers coexist: each gets its own dispose, and the
  // worker stays alive until every one of them runs.  See the
  // module-level docblock for the why and the reset discipline.
  acquire(): () => void {
    this.refcount += 1;
    if (this.refcount === 1) this.connectClient();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refcount -= 1;
      if (this.refcount === 0) this.disconnectClient();
    };
  }

  private connectClient(): void {
    if (this.client) return;
    // Optimistically reflect the impending connection attempt
    // synchronously, BEFORE constructing the client.  The
    // alternative is to let consumers paint one frame of the
    // construction-time `'closed'` sentinel: the dashboard's
    // panel pills, the deploy-preview pill, and InputPane's
    // dropdown suffix would all flash a red "disconnected"
    // for the gap between this acquire and the worker's first
    // status post (`worker.postMessage('start')` resolves on
    // a microtask, then the worker's `openChannel` posts back
    // 'connecting' on another microtask).  Setting the field
    // here makes the very same render frame that triggered
    // acquire see the truthful "we are trying" state instead
    // of "we gave up."
    //
    // Idempotent against the worker's authoritative path: the
    // worker's first message for each channel is also
    // `state: 'connecting'`, which is a no-op against this
    // optimistic write.  Subsequent transitions to 'open' /
    // 'error' / 'closed' land normally.
    //
    // Caveat: the WebCodecs-unsupported branch of the worker
    // never calls `openChannel('audio')`, so without
    // compensation the audio half would hang at our optimistic
    // 'connecting' forever.  See `web/src/lib/stream/worker.ts`
    // -- it now posts `state: 'closed'` for audio after the
    // 'unsupported' message in that branch so the field flips
    // to 'closed' the moment the worker decides not to try.
    this.audioStatus = 'connecting';
    this.inferStatus = 'connecting';
    // Capture the freshly-constructed client in a local so each
    // listener closure can verify, on every fire, that the store's
    // `this.client` still points at the one whose Topics it
    // registered on.  Why: `Worker.terminate()` (called inside
    // `client.stop()` during `disconnectClient`) per the HTML
    // spec only discards tasks queued on the WORKER's event loop;
    // messages the worker already posted to the MAIN thread's
    // queue still fire after terminate.  Without this gate, those
    // stale messages emit on the old Topics, run the old listeners,
    // and overwrite the just-reset state (ring writes from
    // `pushPcm`, `audioStatus` flips, `latestTopK` updates, etc.).
    // A subsequent re-acquire would then inherit stale ring data
    // and a wrong status transition.  Comparing against the
    // captured `client` (and not, say, against `null`) also handles
    // the rapid disconnect → reconnect case correctly: the new
    // session's `this.client` differs from every prior captured
    // client, so old listeners no-op while the new ones proceed.
    const client = createStreamClient();
    this.client = client;
    client.audio.on(({ pcm }) => {
      if (this.client !== client) return;
      this.pushPcm(pcm);
    });
    client.inference.on(({ top_k, head_id, head_version }) => {
      if (this.client !== client) return;
      this.latestTopK = top_k;
      if (head_id !== this.head.head_id || head_version !== this.head.head_version) {
        this.head = { head_id, head_version };
      }
      this.trackInferenceFps();
    });
    client.status.on(({ channel, state }) => {
      if (this.client !== client) return;
      if (channel === 'audio') this.audioStatus = state;
      else this.inferStatus = state;
    });
    client.unsupported.on((reason) => {
      if (this.client !== client) return;
      this.unsupportedReason = reason;
    });
    client.start();
  }

  private disconnectClient(): void {
    // Tear the worker down first when one exists.  The early-return
    // sat at the top of this method before; moving it INSIDE so the
    // reactive-state reset below always runs even when `client` is
    // already null.  Two scenarios benefit:
    //
    //   1. A connectClient that threw between the optimistic
    //      `audioStatus = 'connecting'` writes above and the
    //      `client.start()` call would leave the store with status
    //      'connecting' and `client === null`.  An unconditional
    //      reset on the eventual dispose snaps the visible state
    //      back to 'closed' instead of stranding consumers on the
    //      optimistic flag.
    //   2. A double-call defends against a refactor where this
    //      method might be invoked from a new path (e.g., a
    //      hypothetical `forget()` analog).  Idempotent resets
    //      cost nothing -- the `$state` setter is a Object.is no-op
    //      when the value already matches.
    if (this.client) {
      this.client.stop();
      this.client = null;
    }
    // Snap reactive state back to "no live stream".  Leaving the
    // last-observed values would be misleading: a "Top-K" list
    // rendered without a worker behind it implies "this is what's
    // firing right now," and an `audioStatus = 'open'` suggests
    // a live WS that no longer exists.  Resetting also means a
    // subsequent re-acquire starts fresh -- no first-frame ghost
    // of pre-disconnect numbers.  Status fields land at the same
    // sentinel they hold on first construction so consumers can't
    // tell "never acquired" from "released" -- both legitimately
    // mean "no stream behind this surface right now."
    this.audioStatus = 'closed';
    this.inferStatus = 'closed';
    this.latestTopK = [];
    this.inferenceFps = 0;
    this.head = { head_id: null, head_version: null };
    this.inferenceTimes.length = 0;
    // Zero the PCM ring + counters so a visualizer mounting after
    // re-acquire (`renderCursor` reads `totalSamplesWritten`)
    // doesn't paint the pre-disconnect tail before the worker's
    // first new packet lands.  The smoother auto-resets after
    // `resetAfterMs` (250 ms) of no fresh samples so its internal
    // cursor settles on its own.
    this.ring.fill(0);
    this.writeIdx = 0;
    this.totalSamplesWritten = 0;
    // `unsupportedReason` deliberately persists: WebCodecs
    // availability is a browser-capability fact that doesn't
    // change across acquire cycles, and the dashboard's banner
    // should still surface it on the next mount without waiting
    // for the worker to re-announce.
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
