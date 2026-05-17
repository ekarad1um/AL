import { WAV_SAMPLE_RATE } from './wav';
import { encodeWavFromChunks } from './resample';
import type { PcmSource } from './pcm-source';
import { CursorSmoother } from './cursor-smoother';
import { envelopeFromRing, pushToRing } from './ring-buffer';

// Microphone recorder.  Captures raw PCM via an AudioWorklet (no
// codec round-trip), surfaces a level meter + a live PCM ring for
// real-time waveform display, and on stop hands the caller a
// 44.1 kHz mono PCM-16 WAV blob ready to drop in IDB.
//
// Why AudioWorklet and not MediaRecorder?
//   MediaRecorder encodes to opus/webm/ogg (browser-dependent), and
//   we'd have to decodeAudioData() right after to recover PCM -- a
//   lossy round-trip for our master copy.  AudioWorklet hands us
//   Float32 frames directly off the audio graph; no codec, no
//   precision loss.  Bonus: works on Safari 14.5+ where MediaRecorder
//   audio support is patchy.
//
// Why an *inline* worklet (blob: URL) and not a separate .ts file?
//   The worklet is 20 lines.  Shipping it as a separate module pulls
//   Vite's worklet-bundling machinery into the build for a handful of
//   bytes.  The blob: URL pattern is self-contained, has no build
//   integration cost, and the URL is revoked the moment `addModule`
//   resolves so it doesn't leak.
//
// State machine:
//   idle        -- no resources held; safe to call start().
//   requesting  -- awaiting getUserMedia + audio graph wire-up.
//   recording   -- capturing; level + duration tick.
//   finalizing  -- stream torn down; resample + WAV encode in flight.
//   error       -- last attempt failed; call reset() to return to idle.
//
//  start() ─▶ requesting ──(ok)──▶ recording ──stop()──▶ finalizing ──▶ idle
//             │                       │                       │
//             └─── error ◀────────────┴─── error ◀────────────┘
//
// Lifecycle: the consuming component is responsible for calling
// `dispose()` in its `onDestroy` -- same pattern as `streams.start()
// / .stop()` in the layout.  Implicit auto-cleanup via Svelte's
// `onDestroy` would only work inside a component context and would
// hide the contract from the call site.

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'finalizing' | 'error';

export interface RecorderResult {
  blob: Blob;
  durationMs: number;
  sampleRate: number; // always WAV_SAMPLE_RATE = 44_100
}

export interface RecorderOptions {
  // Soft cap on a single recording.  Default 50 min -- the recording
  // module is bounded by two artefact-budget axes, NOT by anything
  // downstream like slice count (an operator can record a long take
  // and pick slices selectively from any subset of it):
  //   - Size: the finalized WAV must fit inside the same 256 MiB
  //     ceiling that `MAX_IMPORT_BYTES` enforces on dropped files,
  //     so recording and import share one storage ceiling.
  //   - Duration: this `maxDurationMs` cap.
  // At fixed-rate 44.1 kHz mono 16-bit PCM (= 88 200 B/s), the two
  // axes collapse onto the same point: 256 MiB / 88.2 KB/s ≈
  // 3 043.5 s ≈ 50 min 43.5 s.  Pinning the duration cap to 50 min
  // (3 000 000 ms) lands just under that size ceiling
  // (252.3 MiB WAV; ~3.7 MiB headroom) and keeps the arithmetic
  // clean, mirroring the original 12 min / 64 MiB design at 4x
  // scale.
  //
  // Other implicit ceilings the cap stays well clear of:
  //   - Finalize-time peak RAM (chunks-during-populate + OAC source
  //     + OAC output + WAV bytes) peaks around 1.07 GiB transiently
  //     at 50 min via the stream-encode finalize in [resample.ts]:
  //     549 MiB chunks overlap with a freshly-allocated 549 MiB
  //     OAC source during the populate loop, then the chunks null
  //     out as they fold in.  Safe on 8 GiB+ machines; a 1-hour
  //     cap would push past 1.3 GiB and tighten the safety margin
  //     on mid-range laptops without buying a round-number
  //     duration in return.
  //   - `formatRecordingClock` formats as `M:SS.c` with the minute
  //     field unpadded; at 50 min the clock reads "50:00.0"
  //     (7 chars, identical width to the prior 12 min "12:00.0").
  //
  // The recorder auto-stops at this duration; the caller's `onstop`
  // callback fires with the finalized result.
  maxDurationMs?: number;
  // Optional callback fired when the recorder auto-stops at the
  // cap.  The component shows a "max length reached" pill.
  onMaxDurationReached?: () => void;
}

export interface StartOptions {
  // Specific audio input device to capture from.  Maps to the
  // `MediaTrackConstraints.deviceId` field via `{ ideal: ... }` so
  // a stale id (device unplugged) falls back to the system default
  // rather than rejecting.  Undefined / empty string = system
  // default (the prior behaviour).
  deviceId?: string;
}

const DEFAULT_MAX_DURATION_MS = 3_000_000;

// Inline AudioWorklet source.  The processor copies each input
// frame's plane 0 (mono channel) and posts it as a transferable so
// the main thread doesn't pay a memcpy on the post.  `process()`
// returns true to keep the node alive between frames.
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch && ch.length > 0) {
      const copy = new Float32Array(ch);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

// Cache the addModule promise per AudioContext so a tab that records
// multiple clips doesn't re-fetch the inline blob each time.
const MODULES = new WeakMap<AudioContext, Promise<void>>();

async function ensureCaptureModule(ctx: AudioContext): Promise<void> {
  const existing = MODULES.get(ctx);
  if (existing) return existing;
  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  // Wrap so we can revoke the URL whether the module load succeeds
  // or fails -- otherwise a transient failure leaks the URL.
  const promise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  MODULES.set(ctx, promise);
  try {
    await promise;
  } catch (e) {
    MODULES.delete(ctx);
    throw e;
  }
}

// Smoothing config for the live-waveform cursor.  Mirrors the
// dashboard `streams` store's shape but with tighter depth bounds
// because the worklet's chunk jitter (128 samples / render quantum,
// ~375 Hz at 48 kHz) is smaller than network packet jitter.
const RECORDER_SMOOTHING = {
  latencyMs: 30,
  minDepthMs: 10,
  maxDepthMs: 200,
  resetAfterMs: 250,
  maxFrameMs: 100,
  slewGain: 0.1,
  maxSlew: 0.025
} as const;

export class Recorder implements PcmSource {
  state = $state<RecorderState>('idle');
  level = $state(0); // RMS, 0..1
  durationMs = $state(0);
  error = $state<string | null>(null);

  // Owner-supplied cap (ms) -- ticking past it triggers an auto-stop.
  private readonly maxDurationMs: number;
  private readonly onMaxDurationReached: (() => void) | undefined;

  // Audio graph + capture state.  All optional because they're built
  // lazily on `start()` and torn down on `stop()` / `cancel()`.
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  // Recorded chunks accumulate here.  Each is a transferred buffer
  // from the worklet (no copy on receipt).  At finalize the array
  // is moved into `encodeWavFromChunks`, which streams them straight
  // into the OAC source storage / WAV bytes -- no concat step.
  private chunks: Float32Array[] = [];
  private capturedSamples = 0;
  private captureRate = 48_000;
  private startedAtMs = 0;
  private levelRaf = 0;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  // RMS analyser scratch buffer; size set on first read.
  private rmsBuf: Float32Array | null = null;

  // Rolling PCM ring for the live-waveform canvas.  Capacity covers
  // the visual window the canvas wants to show (default 3 s); the
  // canvas reads min/max envelopes from this ring at RAF.  Allocated
  // on first `start()` (when we know the capture rate) and reused
  // across subsequent recordings inside the same Recorder instance
  // (no realloc churn).
  private liveRing: Float32Array = new Float32Array(0);
  private liveWriteIdx = 0;
  private liveTotalWritten = 0;
  // Rolling-window capacity in seconds.  Three seconds is the same
  // window the dashboard's `WaveformCanvas` shows; matching it keeps
  // the visual rhythm consistent across surfaces.
  private static readonly LIVE_WINDOW_SECONDS = 3;

  // Live-waveform cursor smoother.  Shared with `streams` -- same
  // jitter-buffer algorithm, just a tighter config (see
  // `RECORDER_SMOOTHING`).
  private readonly smoother = new CursorSmoother(RECORDER_SMOOTHING);

  constructor(options: RecorderOptions = {}) {
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.onMaxDurationReached = options.onMaxDurationReached;
  }

  async start(options: StartOptions = {}): Promise<void> {
    if (this.state === 'recording' || this.state === 'requesting') return;
    this.error = null;
    this.state = 'requesting';
    try {
      // Acquire the mic.  We let the browser pick channel count +
      // sample rate (typically 48 kHz mono on macOS Safari, 48 kHz
      // stereo on Chrome).  Auto-gain / echo / noise-suppression are
      // disabled because they colour the signal in a way that
      // disagrees with downstream classifier expectations; the
      // operator can re-enable in OS settings if they want it.
      //
      // `deviceId` (when supplied) uses `ideal` rather than `exact`
      // so a stale persisted id (mic unplugged between sessions)
      // degrades to the system default instead of throwing
      // `OverconstrainedError`.  The caller can re-enumerate on
      // failure if they want to surface a "device gone" hint.
      const audio: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      };
      if (options.deviceId) {
        audio.deviceId = { ideal: options.deviceId };
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: false
      });
      // Cancelled (dispose / cancel) during the permission prompt:
      // tear down the freshly-acquired stream and bail before we
      // start building the audio graph against a stale lifecycle.
      if (this.state !== 'requesting') {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;

      // AudioContext at the browser default rate -- resampling to
      // `WAV_SAMPLE_RATE` happens at finalize, off this thread.  The
      // capture rate is whatever the device gives (typically 48 kHz
      // on macOS, 44.1 kHz on most ALSA setups); we record at that
      // rate so the live waveform shows exactly what the mic
      // produced.
      this.ctx = new AudioContext();
      this.captureRate = this.ctx.sampleRate;
      // (Re-)allocate the live ring to cover the rolling window at
      // the freshly-discovered capture rate.  Reusing a prior
      // allocation is fine when the rate matches.
      const ringCapacity = Math.ceil(this.captureRate * Recorder.LIVE_WINDOW_SECONDS);
      if (this.liveRing.length !== ringCapacity) {
        this.liveRing = new Float32Array(ringCapacity);
      } else {
        this.liveRing.fill(0);
      }
      this.liveWriteIdx = 0;
      this.liveTotalWritten = 0;
      this.smoother.reset();
      await ensureCaptureModule(this.ctx);
      // Cancelled during worklet module load: cancel() / dispose()
      // already ran teardownGraph (state is no longer 'requesting'),
      // so bail before touching the torn-down context.
      if (this.state !== 'requesting') return;

      this.source = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      // fftSize tradeoff: bigger = smoother RMS (averages more
      // samples per read) but laggier.  1024 @ 48 kHz = 21 ms
      // window -- comfortably below the 33 ms RAF tick.
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0; // raw frame; we smooth in JS

      this.workletNode = new AudioWorkletNode(this.ctx, 'pcm-capture');
      this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
        // Hot path -- runs at the worklet's render-quantum rate
        // (~375 Hz at 48 kHz / 128-sample frames).  Stash for the
        // final WAV encode (consumed chunk-by-chunk at finalize)
        // and copy into the live ring for the waveform canvas to
        // envelope at RAF.  Both writes are O(frame length); the
        // canvas read is O(canvas width).
        if (this.state !== 'recording') return;
        const frame = e.data;
        this.chunks.push(frame);
        this.capturedSamples += frame.length;
        this.pushLiveRing(frame);
      };

      this.source.connect(this.analyser);
      this.source.connect(this.workletNode);
      // Worklet must connect to a sink for Chrome to schedule it,
      // even though we don't want audible monitoring.  A muted gain
      // → destination satisfies the engine without producing sound.
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.workletNode.connect(sink).connect(this.ctx.destination);

      this.chunks = [];
      this.capturedSamples = 0;
      this.durationMs = 0;
      this.level = 0;
      this.startedAtMs = performance.now();
      this.state = 'recording';
      this.startLevelLoop();

      this.autoStopTimer = setTimeout(() => {
        this.autoStopTimer = null;
        this.onMaxDurationReached?.();
        void this.stop();
      }, this.maxDurationMs);
    } catch (e) {
      // Tear down any partially-built graph before surfacing.
      this.teardownGraph();
      this.error = friendlyMicError(e);
      this.state = 'error';
      throw e;
    }
  }

  // Stop the current capture and finalize to a WAV blob.  Returns
  // `null` if there were no samples (impossibly-short tap before the
  // first worklet tick) -- caller decides whether to surface "too
  // short".  Throws on finalize-time errors (resampler hiccup, WAV
  // alloc failure).  A re-entrant stop() while not in `recording`
  // state (idle / finalizing / error) is a no-op that returns null
  // -- the first call owns the in-flight finalize.
  //
  // Finalize hands the captured chunk list straight to
  // `encodeWavFromChunks`, which folds resample + quantise + blob-
  // wrap into a single allocation pass and releases each chunk's
  // ArrayBuffer as it's consumed.  See the module header in
  // `resample.ts` for the memory-peak comparison vs the old
  // concat + slice + encode pipeline.
  async stop(): Promise<RecorderResult | null> {
    if (this.state !== 'recording') return null;
    this.state = 'finalizing';
    if (this.autoStopTimer !== null) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    this.cancelLevelLoop();
    // Pull the captured samples + rate before tearing the graph
    // down; teardown clears the state.  Move the chunks array out
    // of `this` before handing it to the encoder, which takes
    // ownership and nulls slots as it consumes them.
    const totalSamples = this.capturedSamples;
    const inputRate = this.captureRate;
    const chunks = this.chunks;
    this.chunks = [];
    this.teardownGraph();

    try {
      if (totalSamples === 0) {
        this.state = 'idle';
        return null;
      }
      const { blob, outputSamples } = await encodeWavFromChunks(
        chunks,
        totalSamples,
        inputRate,
        WAV_SAMPLE_RATE
      );
      const durationMs = Math.round((outputSamples / WAV_SAMPLE_RATE) * 1000);
      this.durationMs = durationMs;
      this.state = 'idle';
      return {
        blob,
        durationMs,
        sampleRate: WAV_SAMPLE_RATE
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.state = 'error';
      throw e;
    }
  }

  // Discard the in-flight capture without producing a result.  Used
  // when the operator clicks "Cancel" mid-recording.
  cancel(): void {
    if (this.state === 'idle') return;
    if (this.autoStopTimer !== null) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    this.cancelLevelLoop();
    this.chunks = [];
    this.capturedSamples = 0;
    this.durationMs = 0;
    this.teardownGraph();
    this.state = 'idle';
    this.error = null;
  }

  // Reset back to idle after an error so start() can be called again.
  reset(): void {
    if (this.state === 'recording' || this.state === 'requesting' || this.state === 'finalizing') {
      this.cancel();
    }
    this.state = 'idle';
    this.error = null;
    this.level = 0;
    this.durationMs = 0;
  }

  // Final teardown.  Called on component unmount via the constructor's
  // onDestroy hook, or explicitly by callers using the recorder
  // outside a component (rare).
  dispose(): void {
    this.cancel();
  }

  // ─── Live-waveform read API (PcmSource implementation) ───
  //
  // The recorder is a `PcmSource` -- it shares the same surface
  // with `streams.svelte.ts` so a single `EnvelopeWaveform.svelte`
  // can read mic data here OR dashboard stream data there with
  // identical call shapes.  Renderer-owned scratch buffers
  // (`lo`, `hi`) keep the per-RAF allocation cost at zero.

  // Native capture rate (Hz).  Valid only while `state === 'recording'`;
  // returns 0 before the first `start()` so callers can guard.
  get sampleRate(): number {
    return this.state === 'recording' ? this.captureRate : 0;
  }

  // Smoothed render cursor.  The worklet posts at the render
  // quantum (128 frames -- ~375 Hz at 48 kHz) vs 60 Hz RAF, so
  // reading raw `liveTotalWritten` would alias and step.  The
  // shared `CursorSmoother` runs the same jitter-buffer algorithm
  // the dashboard `streams` store uses.
  renderCursor(nowMs: number = performance.now()): number {
    return this.smoother.step(this.liveTotalWritten, this.liveRing.length, this.captureRate, nowMs);
  }

  // Min/max envelope ending at `endSample`, filled into caller-
  // owned buffers.  Out-of-range bins (before oldest available)
  // read as zero so the canvas paints a flat baseline.
  envelopeAt(
    endSample: number,
    samples: number,
    bins: number,
    lo: Float32Array,
    hi: Float32Array
  ): void {
    envelopeFromRing(this.liveRing, this.liveTotalWritten, endSample, samples, bins, lo, hi);
  }

  private pushLiveRing(frame: Float32Array): void {
    this.liveWriteIdx = pushToRing(this.liveRing, this.liveWriteIdx, frame);
    this.liveTotalWritten += frame.length;
  }

  private startLevelLoop(): void {
    const tick = (): void => {
      if (this.state !== 'recording') {
        this.levelRaf = 0;
        return;
      }
      const a = this.analyser;
      if (a) {
        const n = a.fftSize;
        if (this.rmsBuf?.length !== n) {
          this.rmsBuf = new Float32Array(n);
        }
        // Same TS<ArrayBuffer> cast as resample.ts -- the AnalyserNode
        // method signature got tightened in TS 5.7 to require the
        // narrower discriminator; our buffer is always ArrayBuffer-
        // backed.
        a.getFloatTimeDomainData(this.rmsBuf as Float32Array<ArrayBuffer>);
        let sumSq = 0;
        for (let i = 0; i < n; i++) {
          const v = this.rmsBuf[i];
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / n);
        // Light exponential smoothing for steadier visuals.
        this.level = this.level * 0.5 + rms * 0.5;
      }
      this.durationMs = Math.round(performance.now() - this.startedAtMs);
      this.levelRaf = requestAnimationFrame(tick);
    };
    this.levelRaf = requestAnimationFrame(tick);
  }

  private cancelLevelLoop(): void {
    if (this.levelRaf !== 0) {
      cancelAnimationFrame(this.levelRaf);
      this.levelRaf = 0;
    }
  }

  private teardownGraph(): void {
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        /* node may already be disconnected */
      }
      this.workletNode = null;
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        /* deliberate */
      }
      this.analyser = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* deliberate */
      }
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ctx) {
      // Don't await -- close() returning eventually is fine; we don't
      // hold a reference past this point.  Some Safari builds reject
      // close() on already-closed contexts; swallow.
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }
}

// Map the various DOMException flavours getUserMedia surfaces into
// operator copy.  Sentence case + period to match `errorCopy()`.
function friendlyMicError(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name: string }).name;
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access was denied. Allow microphone access in the browser settings and try again.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No microphone was found on this device.';
      case 'NotReadableError':
        return 'The microphone is in use by another application. Close it and try again.';
      case 'AbortError':
        return 'Microphone capture was interrupted. Try again.';
    }
  }
  if (err instanceof Error) return finishCopy(err.message);
  return 'Could not start the microphone.';
}

function finishCopy(s: string): string {
  const t = s.trim();
  if (!t) return 'Could not start the microphone.';
  const head = t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(head) ? head : `${head}.`;
}
