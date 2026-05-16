<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { Recorder, type RecorderResult } from '$lib/audio/recorder.svelte';
  import { drafts } from '$lib/stores/drafts.svelte';
  import { encodeWavPcm16, SLICE_SAMPLES, WAV_SAMPLE_RATE } from '$lib/audio/wav';
  import { decodeAudioFile, resampleMono } from '$lib/audio/resample';
  import { readWavMagic, decodeCanonicalWav } from '$lib/audio/wav-decode';
  import { chunkPcmToSlices, sliceCountFor } from '$lib/audio/slicer';
  import { slices } from '$lib/stores/slices.svelte';
  import { streams } from '$lib/stores/streams.svelte';
  import { formatRecordingClock, formatDuration, formatBytes } from '$lib/utils/format';
  import { MAX_SLICES_PER_CATEGORY, prettyCategoryName } from './labels';
  import LiveRecorderWaveform from './LiveRecorderWaveform.svelte';
  import EnvelopeWaveform from '$lib/components/EnvelopeWaveform.svelte';
  import TrimWaveform from './TrimWaveform.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Tips from '$lib/components/ui/Tips.svelte';
  import Spinner from '$lib/components/Spinner.svelte';
  import { SOCKET_LABEL } from '$lib/components/dashboard/socketPill';
  import type { Uuid } from '$lib/api/types';
  import type { DraftRecord } from '$lib/idb/db';

  // The Input Module per category.  Architecture spec
  // [ARCHITECTURE.md §A.4 item 3] dictates: device selection
  // (mic / drag-drop WAV / live opus stream), single-slot draft,
  // live waveform during capture, static waveform of the saved
  // draft, and export.
  //
  // State machine (per category instance):
  //
  //   empty       -- no draft saved; mic idle; drop zone active
  //   recording   -- mic open, live waveform painting
  //   streaming   -- capturing from the dashboard's live opus
  //                  stream (no mic involved); live waveform reads
  //                  from `streams` instead of `recorder`
  //   finalizing  -- resample + WAV encode (<100 ms typical)
  //   importing   -- WAV decode + resample + encode
  //   draft       -- one saved clip; static waveform + actions
  //   error       -- inline rose banner; record/import buttons still
  //                  enabled (the error is per-attempt, not global)
  //
  // The static + live states share screen space (the waveform area
  // toggles between LiveRecorderWaveform, the streams' shared
  // EnvelopeWaveform, and TrimWaveform).
  //
  // The `Recorder` instance is owned per-pane and torn down via
  // `onDestroy` -- when the category collapses, the pane unmounts
  // and the mic graph goes away.  `streams` is a singleton owned by
  // the layout, so the stream capture mode just observes it.
  interface Props {
    workspaceId: Uuid;
    categoryName: string;
    workspaceName: string; // for export filename
    maxDurationMs?: number;
  }
  let { workspaceId, categoryName, workspaceName, maxDurationMs = 60_000 }: Props = $props();

  // Hard cap on a single dropped / picked WAV.  64 MiB ≈ 12 minutes
  // of mono 44.1 kHz PCM-16 (≈ 88 200 B/s) -- comfortably above the
  // 60-second recording cap so an operator with a longer source
  // recorded elsewhere can still trim a 1 s window out of it.  Past
  // this, the decode + resample either (a) blows multi-second / OOM
  // in a browser tab, or (b) inflates the in-memory Float32Array
  // to gigabyte scale.  Enforced on `file.size` BEFORE the decode
  // pipeline fires so over-cap files never reach the audio decoder;
  // operator copy includes both sizes so the rejection is actionable.
  const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

  type Op = 'recording' | 'streaming' | 'finalizing' | 'importing' | null;

  // `op` is the active in-flight operation; `recorder.state` is the
  // mic graph's state.  Keep them distinct so a long import (no mic
  // involved) doesn't leak into the mic state.
  let op = $state<Op>(null);
  let maxReached = $state(false);
  let error = $state<string | null>(null);
  // Stream-capture state.  The `streams` singleton always has the
  // current 10 s of decoded opus PCM; we anchor a start sample at
  // capture begin and extract the window at stop.  `streamRafId`
  // drives the duration counter (no `setInterval` so the tick
  // freezes with the RAF when the tab is hidden, same shape as the
  // recorder's level loop).  Cap stream capture at the smaller of
  // `maxDurationMs` and the streams' ring length so we never ask
  // for samples that have already rolled out.
  let streamStartedAtMs = $state(0);
  let streamStartSample = 0;
  let streamDurationMs = $state(0);
  let streamRafId = 0;
  let streamAutoStopTimer: ReturnType<typeof setTimeout> | null = null;
  const streamMaxDurationMs = $derived(
    Math.min(maxDurationMs, Math.floor(streams.ringSeconds * 1000))
  );
  // Hoisted near `op` so downstream `$effect` / `$derived` (level
  // meter, waveform branch, header clock) can reference it
  // without a temporal-dead-zone error -- a `$derived` is only
  // observable after its declaration line, so the level-meter
  // code below would otherwise read an undefined binding.
  const isStreaming = $derived(op === 'streaming');
  // Decoded PCM of the *current* saved draft, lazily computed for
  // the static waveform.  Recomputed when the draft reference flips
  // (new record / new import / IDB refresh).
  let draftPcm = $state<Float32Array | null>(null);
  let decodingDraft = $state(false);

  const initialMaxDurationMs = untrack(() => maxDurationMs);
  const recorder = new Recorder({
    maxDurationMs: initialMaxDurationMs,
    onMaxDurationReached: () => {
      maxReached = true;
    }
  });

  // ── Input source selection ────────────────────────────────────
  //
  // The architecture spec [ARCHITECTURE.md §A.4 item 3.1] asks for
  // one picker covering browser microphones AND the daemon's live
  // audio stream.  Collapsing both behind one dropdown lets a
  // single primary `Record` button dispatch on the operator's
  // pick.  The pre-refactor empty state showed Record + Stream as
  // two competing CTAs alongside a mic-only device dropdown,
  // which (a) violated the spec's single-selector intent, (b)
  // made the device picker meaningless for the stream path, and
  // (c) forced two near-identical action-row branches downstream.
  //
  // The state is a *discriminated union* (`InputSource`) so
  // consumers -- `startCapture`, the Record button's
  // disabled / aria-label / title derivations -- read intent
  // directly instead of re-parsing the storage string at every
  // call site.  The dropdown still binds to the storage form
  // (`selectedKey: string`) -- `<select>` operates on strings,
  // so making that the source of truth and deriving the union
  // from it lets us keep `bind:value` instead of a manually-
  // controlled value+onchange pair.
  //
  // Persistence: localStorage under the same key the prior
  // mic-only picker used.  Empty string remains "system default
  // microphone" (so a pre-refactor preference still parses
  // correctly); the sentinel `':stream'` selects the daemon's
  // opus stream.  Real `MediaDevices.deviceId` values are opaque
  // base64 / hex (Chrome, Firefox, Safari all agree in practice),
  // so the leading-colon sentinel cannot collide with a stale
  // device id.  We still pass `{ ideal: deviceId }` to
  // `getUserMedia` from the recorder so a mic unplugged between
  // sessions degrades silently to the system default instead of
  // throwing.

  type InputSource = { kind: 'mic'; deviceId: string } | { kind: 'stream' };

  const SOURCE_STORAGE_KEY = 'acoustics-lab:input-device-id';
  const STREAM_KEY = ':stream';

  function readSavedKey(): string {
    if (typeof window === 'undefined') return '';
    try {
      return localStorage.getItem(SOURCE_STORAGE_KEY) ?? '';
    } catch {
      // Private-mode / quota exceptions -- treat as no preference.
      return '';
    }
  }

  function asSource(key: string): InputSource {
    return key === STREAM_KEY ? { kind: 'stream' } : { kind: 'mic', deviceId: key };
  }

  let audioInputs = $state<MediaDeviceInfo[]>([]);
  let selectedKey = $state<string>(readSavedKey());
  const selectedSource = $derived<InputSource>(asSource(selectedKey));

  // Persist the selection.  An empty `selectedKey` (system-default
  // mic) clears the entry so the storage doesn't fossilise an
  // empty string forever; any other key (specific mic id or the
  // stream sentinel) is written through verbatim.
  $effect(() => {
    const k = selectedKey;
    if (typeof window === 'undefined') return;
    try {
      if (k) localStorage.setItem(SOURCE_STORAGE_KEY, k);
      else localStorage.removeItem(SOURCE_STORAGE_KEY);
    } catch {
      /* Best-effort -- ignore quota / private-mode failures. */
    }
  });

  // `refreshDevices` only runs from a `$effect` block (client-only
  // in Svelte 5), so `navigator` is reachable.  Older Safari builds
  // can still surface a missing `mediaDevices` (e.g. insecure
  // context); we guard for that one specifically and bail without
  // a console error if so.
  async function refreshDevices(): Promise<void> {
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (!md) {
      audioInputs = [];
      return;
    }
    try {
      const all = await md.enumerateDevices();
      audioInputs = all.filter((d) => d.kind === 'audioinput');
      // Drop a stale persisted mic id silently.  Stream selections
      // survive a disconnected daemon -- `audioStatus` reactivity
      // disables the Record button until the socket reopens, then
      // the same selection works again -- but a vanished mic has
      // no equivalent return path, and the recorder's `ideal`
      // constraint would silently fall back to system default on
      // the next `start()` anyway.  Clearing the persisted id
      // here keeps the visible dropdown selection consistent with
      // the recorder's runtime behaviour.
      if (selectedKey && selectedKey !== STREAM_KEY) {
        if (!audioInputs.some((d) => d.deviceId === selectedKey)) {
          selectedKey = '';
        }
      }
    } catch {
      audioInputs = [];
    }
  }

  $effect(() => {
    void refreshDevices();
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (!md) return;
    const onDeviceChange = (): void => {
      void refreshDevices();
    };
    md.addEventListener('devicechange', onDeviceChange);
    return () => {
      md.removeEventListener('devicechange', onDeviceChange);
    };
  });

  // Load the draft slot for this (workspace, category) pair on
  // mount.  Track the props explicitly (so a future re-mount for
  // a different category re-fetches) but `untrack` the refresh
  // call itself -- `drafts.refresh` reads the same slice it
  // writes, and without the wrapper that internal mutation would
  // re-fire this effect and queue a redundant IDB read.  Same
  // reactive-loop hazard documented on `categories.refresh`.
  $effect(() => {
    const id = workspaceId;
    const name = categoryName;
    untrack(() => {
      void drafts.refresh(id, name);
    });
  });

  const draftSlice = $derived(drafts.for(workspaceId, categoryName));
  const draft = $derived(draftSlice.draft);

  // Re-decode the draft PCM when the draft reference changes.
  // Uses `decodeCanonicalWav` (cheap: 44-byte skip + Int16->Float32
  // loop) because the stored blob is always in our canonical
  // format; no AudioContext, no rate conversion.
  $effect(() => {
    const current = draft;
    if (!current) {
      draftPcm = null;
      decodingDraft = false;
      return;
    }
    decodingDraft = true;
    let cancelled = false;
    void decodeCanonicalWav(current.blob)
      .then(({ pcm }) => {
        if (cancelled) return;
        draftPcm = pcm;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        error = e instanceof Error ? e.message : 'Could not decode the stored draft.';
        draftPcm = null;
      })
      .finally(() => {
        if (cancelled) return;
        decodingDraft = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // ── Trim state (B.4) ───────────────────────────────────────────
  //
  // Local mirror of the persisted `draft.trim_start_samples` /
  // `trim_end_samples`.  TrimWaveform writes here on every
  // pointermove (smooth visual); we persist back to the drafts
  // store on pointerup (one IDB write per drag, not per frame).
  //
  // Initialised + reset from the draft via `$effect`.  A fresh
  // re-record / re-import replaces the draft, which triggers this
  // effect and resets the trim to (0, full clip).
  let trimStart = $state(0);
  let trimEnd = $state(0);

  // Compute + clamp via local variables, then write trimStart /
  // trimEnd exactly once at the end.  Earlier this effect read
  // `trimStart` / `trimEnd` in its own clamp conditions, which
  // added them to the effect's dependency set -- so when the
  // TrimWaveform's drag handlers updated `trimStart`, this effect
  // re-ran and reset the value back to the draft's persisted
  // (or default) trim, making the drag appear to do nothing.
  // Reading only `draft` and `draftPcm` keeps this effect scoped
  // to "draft changed, recompute trim" instead of recursively
  // chasing its own writes.
  $effect(() => {
    const current = draft;
    const pcm = draftPcm;
    if (!current || !pcm) return;
    let ns = current.trim_start_samples ?? 0;
    let ne = current.trim_end_samples ?? pcm.length;
    if (ns < 0) ns = 0;
    if (ne > pcm.length) ne = pcm.length;
    if (ne - ns < SLICE_SAMPLES) {
      // Persisted range collapsed below the slicer minimum; reset
      // to the full clip so the operator can re-trim.
      ns = 0;
      ne = pcm.length;
    }
    trimStart = ns;
    trimEnd = ne;
  });

  function onTrimChange(start: number, end: number): void {
    trimStart = start;
    trimEnd = end;
  }
  function onTrimCommit(start: number, end: number): void {
    if (!draft) return;
    void drafts.patchTrim(workspaceId, categoryName, start, end);
  }

  // Slicing flag declared up front so the `canSlice` $derived can
  // reference it without a temporal-dead-zone surprise; the
  // performSlice() helper that actually flips it lives further
  // down in the "Slice action" section.
  let slicing = $state(false);

  const trimRangeSamples = $derived(Math.max(0, trimEnd - trimStart));
  const trimRangeMs = $derived(Math.round((trimRangeSamples / WAV_SAMPLE_RATE) * 1000));
  const projectedSliceCount = $derived(sliceCountFor(trimStart, trimEnd));
  // Samples in the trim range that fall past the last full
  // 1 s slice -- the slicer floor-divides, so anything below
  // a full window is dropped.  Telegraphed in the selection
  // status so the operator can extend the trim and reclaim it
  // instead of wondering where the "missing" slice went.
  const unusedSamples = $derived(
    Math.max(0, trimRangeSamples - projectedSliceCount * SLICE_SAMPLES)
  );
  const unusedMs = $derived(Math.round((unusedSamples / WAV_SAMPLE_RATE) * 1000));
  // Cumulative slice count for this category -- reads from the
  // slices store reactively, so adding / deleting slices flips the
  // Slice button's enabled state in real time without an explicit
  // refresh.  Two derived helpers:
  //   atSliceCap:    the category already holds the cap; no Slice
  //                  click is allowed regardless of selection
  //                  length.  Button degrades to the workspace-list-
  //                  style "At cap · N/MAX" disabled state.
  //   wouldExceedCap: the existing count is below the cap but the
  //                  projected batch would push it past.  Disable
  //                  the click but keep the count visible so the
  //                  operator sees both why it's disabled AND how
  //                  much trim is needed to fit.
  const currentSliceCount = $derived(slices.countFor(workspaceId, categoryName));
  const atSliceCap = $derived(currentSliceCount >= MAX_SLICES_PER_CATEGORY);
  const wouldExceedCap = $derived(
    !atSliceCap && currentSliceCount + projectedSliceCount > MAX_SLICES_PER_CATEGORY
  );
  const sliceCapHeadroom = $derived(Math.max(0, MAX_SLICES_PER_CATEGORY - currentSliceCount));
  const canSlice = $derived(
    !!draftPcm &&
      !slicing &&
      trimRangeSamples >= SLICE_SAMPLES &&
      // 60 s drafts × 1 s slices = 60.  Hard cap matches the
      // recorder's max-duration so a single Slice click never
      // produces an unreasonable batch.
      projectedSliceCount <= 60 &&
      // Cumulative cap: a single click can't push the per-category
      // count past `MAX_SLICES_PER_CATEGORY`.  See the constant's
      // commentary in `labels.ts` for the rationale.
      !atSliceCap &&
      !wouldExceedCap
  );

  // ── Selection playback (B.4 + playback cursor) ────────────────
  //
  // A single shared AudioContext + AudioBuffer is reused across
  // play presses.  The buffer is invalidated when `draftPcm`
  // changes (new clip means new bytes).  Each play creates a
  // fresh AudioBufferSourceNode -- sources are one-shot per spec.
  //
  // Cursor position is sampled at RAF from the AudioContext's
  // currentTime + the offset captured at source.start().  Seek is
  // a stop-current-source + start-fresh dance: cheap because the
  // AudioBuffer is reused, expensive in OS audio-thread terms
  // because each restart hits the scheduler.  We mute audio during
  // drag (`seeking = true`) so the operator gets smooth cursor
  // motion + one restart on pointerup rather than a click-storm.

  let playAudioCtx: AudioContext | null = null;
  let playAudioBuffer: AudioBuffer | null = null;
  let activeSource: AudioBufferSourceNode | null = null;
  let playing = $state(false);
  let playbackSample = $state<number | null>(null);
  // Reference-time fields backing the RAF cursor update.
  let playbackStartCtxTime = 0;
  let playbackStartOffset = 0;
  let playbackRaf = 0;
  // `seeking` is true between `onPlaybackSeek` (first drag tick)
  // and `onPlaybackSeekCommit` (pointerup).  Audio is muted while
  // it's true; the RAF cursor update is paused.
  let seeking = $state(false);
  // Playback level meter.  An AnalyserNode tees off the playback
  // graph so the same vertical bar that reflects mic loudness during
  // recording also reflects audible loudness during playback (works
  // for imported audio too -- we sample the actual signal that's
  // hitting the speakers, not a pre-computed envelope).  The
  // analyser is lazily created on first play and re-used across
  // subsequent plays + seek-restarts.
  let playAnalyser: AnalyserNode | null = null;
  let playLevelBuf: Float32Array | null = null;
  let playbackLevel = $state(0);

  // Invalidate the cached AudioBuffer when the PCM changes.
  $effect(() => {
    void draftPcm;
    playAudioBuffer = null;
  });

  function tickPlayback(): void {
    playbackRaf = 0;
    if (!activeSource || !playAudioCtx || seeking) return;
    const elapsedSec = playAudioCtx.currentTime - playbackStartCtxTime;
    const pos = playbackStartOffset + Math.floor(elapsedSec * WAV_SAMPLE_RATE);
    // Sample RMS from the playback analyser.  Same compressor as
    // the recorder uses on `level` so the bar reads identically
    // whether mic or playback is the source.
    if (playAnalyser) {
      const n = playAnalyser.fftSize;
      if (playLevelBuf?.length !== n) {
        playLevelBuf = new Float32Array(n);
      }
      playAnalyser.getFloatTimeDomainData(playLevelBuf as Float32Array<ArrayBuffer>);
      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        const v = playLevelBuf[i];
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / n);
      // Light exponential smoothing matches `recorder.level`'s
      // 50/50 blend so the visual feel is consistent.
      playbackLevel = playbackLevel * 0.5 + rms * 0.5;
    }
    if (pos >= trimEnd) {
      playbackSample = trimEnd;
      return; // source.onended will fire imminently
    }
    playbackSample = pos;
    playbackRaf = requestAnimationFrame(tickPlayback);
  }

  function stopActiveSource(): void {
    if (activeSource) {
      activeSource.onended = null;
      try {
        activeSource.stop();
      } catch {
        /* deliberate: source may already be stopped */
      }
      activeSource = null;
    }
    if (playbackRaf !== 0) {
      cancelAnimationFrame(playbackRaf);
      playbackRaf = 0;
    }
    // Decay the level to zero so the bar reads "silent" when
    // the source ends (and a stale tail doesn't linger on the
    // next playback start).
    playbackLevel = 0;
  }

  async function startPlayback(fromSample: number): Promise<void> {
    if (!draftPcm) return;
    const safeFrom = Math.max(trimStart, Math.min(trimEnd - 1, fromSample));
    const remainingSamples = trimEnd - safeFrom;
    if (remainingSamples <= 0) return;
    playAudioCtx ??= new AudioContext();
    if (playAudioCtx.state === 'suspended') {
      await playAudioCtx.resume();
    }
    if (!playAudioBuffer) {
      const buf = playAudioCtx.createBuffer(1, draftPcm.length, WAV_SAMPLE_RATE);
      buf.copyToChannel(draftPcm as Float32Array<ArrayBuffer>, 0);
      playAudioBuffer = buf;
    }
    // Lazily create the analyser the first time we play, then
    // reuse.  `fftSize 1024` matches the recorder's analyser; the
    // RAF tick reads `getFloatTimeDomainData` from the latest
    // 1024-sample window which is ~23 ms @ 44.1 kHz -- well below
    // the RAF interval.  `smoothingTimeConstant: 0` returns raw
    // frame data; we do the smoothing in JS for symmetry with the
    // recorder's loop.
    if (!playAnalyser) {
      playAnalyser = playAudioCtx.createAnalyser();
      playAnalyser.fftSize = 1024;
      playAnalyser.smoothingTimeConstant = 0;
      playAnalyser.connect(playAudioCtx.destination);
    }
    stopActiveSource();

    const source = playAudioCtx.createBufferSource();
    source.buffer = playAudioBuffer;
    // Source → analyser → destination: the analyser tees off the
    // signal that's about to hit the speakers so the level bar
    // reads what the operator hears.
    source.connect(playAnalyser);
    const offsetSec = safeFrom / WAV_SAMPLE_RATE;
    const durationSec = remainingSamples / WAV_SAMPLE_RATE;
    source.start(0, offsetSec, durationSec);
    activeSource = source;
    playbackStartCtxTime = playAudioCtx.currentTime;
    playbackStartOffset = safeFrom;
    playbackSample = safeFrom;
    playing = true;
    source.onended = (): void => {
      if (activeSource === source) {
        activeSource = null;
        playing = false;
        playbackSample = null;
        playbackLevel = 0;
      }
    };
    if (playbackRaf === 0) {
      playbackRaf = requestAnimationFrame(tickPlayback);
    }
  }

  async function playSelection(): Promise<void> {
    if (!draftPcm) return;
    await startPlayback(trimStart);
  }

  function stopPlayback(): void {
    stopActiveSource();
    playing = false;
    playbackSample = null;
    seeking = false;
  }

  function teardownPlayback(): void {
    stopPlayback();
    playAudioBuffer = null;
    if (playAnalyser) {
      try {
        playAnalyser.disconnect();
      } catch {
        /* deliberate -- analyser may already be disconnected */
      }
      playAnalyser = null;
    }
    playLevelBuf = null;
    if (playAudioCtx) {
      playAudioCtx.close().catch(() => undefined);
      playAudioCtx = null;
    }
  }

  function onPlaybackSeek(sample: number): void {
    if (!seeking) {
      seeking = true;
      // Stop audio without clearing `playing` -- the cursor stays
      // visible and `Play` button stays in "stop" mode until the
      // operator either commits the seek or hits Stop.
      stopActiveSource();
    }
    playbackSample = Math.max(trimStart, Math.min(trimEnd, sample));
  }

  async function onPlaybackSeekCommit(sample: number): Promise<void> {
    seeking = false;
    const target = Math.max(trimStart, Math.min(trimEnd - 1, sample));
    if (target >= trimEnd - 1) {
      // Dragged to (or past) the end -- treat as natural stop.
      stopPlayback();
      return;
    }
    await startPlayback(target);
  }

  // ── Slice action ─────────────────────────────────────────────

  async function performSlice(): Promise<void> {
    if (!canSlice || !draftPcm) return;
    slicing = true;
    error = null;
    try {
      const windows = chunkPcmToSlices(draftPcm, trimStart, trimEnd);
      const queuedIds: string[] = [];
      for (const samples of windows) {
        const blob = encodeWavPcm16(samples, WAV_SAMPLE_RATE);
        const id = crypto.randomUUID();
        const filename = `${id.slice(0, 8)}.wav`;
        await slices.append({
          id,
          workspace_id: workspaceId,
          category_name: categoryName,
          filename,
          blob,
          state: 'local',
          created_at: new Date().toISOString()
        });
        queuedIds.push(id);
      }
      for (const id of queuedIds) {
        void slices.enqueueUpload(id);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not slice the clip.';
    } finally {
      slicing = false;
    }
  }

  onDestroy(() => {
    recorder.dispose();
    teardownPlayback();
    if (streamAutoStopTimer !== null) {
      clearTimeout(streamAutoStopTimer);
      streamAutoStopTimer = null;
    }
    if (streamRafId !== 0) {
      cancelAnimationFrame(streamRafId);
      streamRafId = 0;
    }
  });

  // Also tear down playback when the underlying draft is removed
  // (operator clicked Discard on the draft).  Otherwise an active
  // play would keep the AudioBufferSourceNode alive against a
  // stale PCM reference.
  $effect(() => {
    if (!draft) stopPlayback();
  });

  // ── Recording controls ───────────────────────────────────────

  async function startRecording(deviceId: string): Promise<void> {
    error = null;
    maxReached = false;
    try {
      op = 'recording';
      await recorder.start({ deviceId: deviceId || undefined });
    } catch {
      // recorder.error already populated; surface inline below.
      op = null;
      return;
    }
    // First successful capture grants device-label visibility;
    // refresh so the dropdown's labels populate without a reload.
    void refreshDevices();
  }

  async function stopRecording(): Promise<void> {
    op = 'finalizing';
    let result: RecorderResult | null;
    try {
      result = await recorder.stop();
    } catch {
      op = null;
      return;
    }
    if (!result) {
      // Tap-too-short: zero samples captured.  Leave the prior
      // draft (if any) intact.
      op = null;
      return;
    }
    try {
      await saveResult(result, 'recorded');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not save the recording.';
    } finally {
      op = null;
    }
  }

  function cancelRecording(): void {
    recorder.cancel();
    maxReached = false;
    op = null;
  }

  // ── Stream capture (opus stream → draft) ───────────────────────
  //
  // The dashboard's opus stream is always-on (started by the
  // layout), so capturing from it is just: anchor a start sample,
  // tick the duration counter at RAF, on stop snapshot the elapsed
  // window from the streams ring and run it through the same
  // resample + encode pipeline that the mic recorder uses.  No
  // device-acquisition step, no AudioContext per pane -- the
  // singleton already handles all of that.
  //
  // The ring is `streams.ringSeconds` (10 s) deep, so a longer
  // capture would silently truncate the early portion.  Cap the
  // stream capture at that depth so the operator gets exactly
  // what they asked for + an honest auto-stop pill when they
  // overshoot.
  function tickStreamDuration(): void {
    if (op !== 'streaming') {
      streamRafId = 0;
      return;
    }
    streamDurationMs = Math.round(performance.now() - streamStartedAtMs);
    streamRafId = requestAnimationFrame(tickStreamDuration);
  }

  function startStream(): void {
    if (op !== null || streams.audioStatus !== 'open') return;
    error = null;
    maxReached = false;
    streamStartedAtMs = performance.now();
    streamStartSample = streams.latestSample;
    streamDurationMs = 0;
    op = 'streaming';
    if (streamRafId === 0) {
      streamRafId = requestAnimationFrame(tickStreamDuration);
    }
    streamAutoStopTimer = setTimeout(() => {
      streamAutoStopTimer = null;
      maxReached = true;
      void stopStream();
    }, streamMaxDurationMs);
  }

  async function stopStream(): Promise<void> {
    if (op !== 'streaming') return;
    if (streamAutoStopTimer !== null) {
      clearTimeout(streamAutoStopTimer);
      streamAutoStopTimer = null;
    }
    if (streamRafId !== 0) {
      cancelAnimationFrame(streamRafId);
      streamRafId = 0;
    }
    op = 'finalizing';
    const endSample = streams.latestSample;
    // Clamp to the ring's available depth -- if for any reason
    // (RAF stall, tab throttle) more than the ring has elapsed
    // between start and stop, the earliest part has already
    // rolled out; honour what we still have.
    const elapsedSamples = Math.min(
      endSample - streamStartSample,
      Math.floor(streams.ringSeconds * streams.sampleRate)
    );
    if (elapsedSamples <= 0) {
      // Tap-too-short or the stream had no fresh samples (closed
      // socket).  Leave the prior draft (if any) intact, same as
      // a zero-sample mic stop.
      op = null;
      return;
    }
    try {
      // Widen to `number` -- `streams.sampleRate` is literally typed
      // as the constant 48000 and `WAV_SAMPLE_RATE` as 44100, so a
      // narrow-types equality check would be `false` at compile
      // time.  The cast lets the rate-equal branch survive a future
      // sample-rate change (or a different PcmSource passed in)
      // without ripping the resample call.
      const captureRate = streams.sampleRate as number;
      const captured = streams.snapshotAt(endSample, elapsedSamples);
      const resampled =
        captureRate === WAV_SAMPLE_RATE
          ? captured
          : await resampleMono(captured, captureRate, WAV_SAMPLE_RATE);
      const blob = encodeWavPcm16(resampled, WAV_SAMPLE_RATE);
      const durationMs = Math.round((resampled.length / WAV_SAMPLE_RATE) * 1000);
      await saveResult(
        { blob, durationMs, sampleRate: WAV_SAMPLE_RATE },
        'imported',
        `live-stream-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`
      );
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not capture the stream.';
    } finally {
      op = null;
    }
  }

  function cancelStream(): void {
    if (streamAutoStopTimer !== null) {
      clearTimeout(streamAutoStopTimer);
      streamAutoStopTimer = null;
    }
    if (streamRafId !== 0) {
      cancelAnimationFrame(streamRafId);
      streamRafId = 0;
    }
    streamDurationMs = 0;
    maxReached = false;
    op = null;
  }

  // ── Capture dispatch ─────────────────────────────────────────
  //
  // One primary `Record` button feeds into `startCapture`; the
  // branch is a thin switch on `selectedSource.kind`.  Mic vs.
  // stream control bodies live above -- this section just routes.
  // Stop / Discard mirror the same shape, branching on the
  // active `op` so the in-flight action row collapses both paths
  // under one Stop + one Discard.
  //
  // `startCapture` keeps the `!canStream` guard even though the
  // button is disabled in that state -- a keyboard activation
  // racing a `closed` socket transition still bottoms out here
  // rather than producing a half-started stream-capture op.

  async function startCapture(): Promise<void> {
    if (isBusy) return;
    if (selectedSource.kind === 'stream') {
      if (!canStream) return;
      startStream();
    } else {
      await startRecording(selectedSource.deviceId);
    }
  }

  async function stopCapture(): Promise<void> {
    if (op === 'recording') await stopRecording();
    else if (op === 'streaming') await stopStream();
  }

  function cancelCapture(): void {
    if (op === 'recording') cancelRecording();
    else if (op === 'streaming') cancelStream();
  }

  async function saveResult(result: RecorderResult, source: 'recorded'): Promise<void>;
  async function saveResult(
    result: { blob: Blob; durationMs: number; sampleRate: number },
    source: 'imported',
    originalName: string
  ): Promise<void>;
  async function saveResult(
    result: { blob: Blob; durationMs: number; sampleRate: number },
    source: 'recorded' | 'imported',
    originalName?: string
  ): Promise<void> {
    const record: DraftRecord = {
      workspace_id: workspaceId,
      category_name: categoryName,
      blob: result.blob,
      duration_ms: result.durationMs,
      sample_rate: result.sampleRate,
      size_bytes: result.blob.size,
      source,
      created_at: new Date().toISOString(),
      ...(originalName !== undefined ? { original_name: originalName } : {})
    };
    await drafts.save(record);
  }

  // ── WAV import ────────────────────────────────────────────────

  let dragging = $state(false);
  let inputEl = $state<HTMLInputElement | undefined>();

  async function importFiles(files: FileList | File[]): Promise<void> {
    if (op !== null) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    const file = list[0];
    if (list.length > 1) {
      error =
        'Only one file at a time -- the Input slot holds the most recent clip only. Drop a single WAV.';
      return;
    }
    // File-size cap.  Reject up front so an over-cap WAV never
    // reaches the decode + resample path -- a 1 GB file would
    // otherwise inflate the Float32Array view by 4x and OOM the
    // tab before the operator could course-correct.  Cleanup
    // mirrors the success path: clear the picker's value so a
    // re-pick of the same file fires another `change` event (a
    // browser quirk: the same value doesn't refire).
    if (file.size > MAX_IMPORT_BYTES) {
      error = `File is ${formatBytes(file.size)}; the import cap is ${formatBytes(
        MAX_IMPORT_BYTES
      )}. Trim it shorter and re-export, then drop again.`;
      if (inputEl) inputEl.value = '';
      return;
    }
    op = 'importing';
    error = null;
    try {
      const magic = await readWavMagic(file);
      if (!magic.valid) {
        error = magic.reason ?? 'Only WAV files are supported.';
        return;
      }
      const { pcm, sampleRate } = await decodeAudioFile(file);
      const targetPcm =
        sampleRate === WAV_SAMPLE_RATE ? pcm : await resampleMono(pcm, sampleRate, WAV_SAMPLE_RATE);
      const blob = encodeWavPcm16(targetPcm, WAV_SAMPLE_RATE);
      const durationMs = Math.round((targetPcm.length / WAV_SAMPLE_RATE) * 1000);
      await saveResult({ blob, durationMs, sampleRate: WAV_SAMPLE_RATE }, 'imported', file.name);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not import the file.';
    } finally {
      op = null;
      if (inputEl) inputEl.value = '';
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragging = false;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void importFiles(files);
  }
  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    dragging = true;
  }
  function onDragLeave(e: DragEvent): void {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as Node).contains(next)) return;
    dragging = false;
  }
  function onPickerChange(e: Event): void {
    const target = e.currentTarget as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      void importFiles(target.files);
    }
  }

  // ── Export / discard ─────────────────────────────────────────

  function exportDraft(): void {
    const current = draft;
    if (!current) return;
    const url = URL.createObjectURL(current.blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = current.created_at.replace(/:/g, '-').replace(/\.\d+Z?$/, '');
    a.download = `${workspaceName}-${categoryName}-${stamp}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Discard collapses the prior Re-record + Delete pair into a
  // single action.  Behaviour: stop playback, drop the draft from
  // IDB + the reactive cache.  The operator then sees the empty
  // state and either records anew or drops a WAV.
  async function discardDraft(): Promise<void> {
    if (!draft) return;
    stopPlayback();
    try {
      await drafts.clear(workspaceId, categoryName);
      maxReached = false;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not discard the clip.';
    }
  }

  function dismissError(): void {
    error = null;
    recorder.reset();
  }

  // Loudness meter (cube-root compressor maps conversational RMS
  // ~0.05 to a ~45 % visual fill).  Bar reserves space whenever
  // there's audio in the pane (mid-capture, or a saved draft)
  // so the layout doesn't bounce when the operator starts /
  // stops playback.  Empty state still hides the bar entirely
  // because there's no audio to visualise.
  //
  // Level source picks the appropriate signal: recorder during
  // mic capture, the streams' last-RMS during stream capture
  // (computed inline below from a small read at the live edge),
  // playback analyser during play, zero otherwise.
  const isPlayingAudio = $derived(playing);
  const showLevelBar = $derived(recorder.state === 'recording' || isStreaming || draft !== null);
  // Stream RMS sample.  Read 1024 samples at the live edge each
  // RAF and compute RMS the same way the recorder does.  Owns its
  // own scratch buffer so the read is allocation-free.
  let streamLevel = $state(0);
  let streamLevelBuf: Float32Array | null = null;
  $effect(() => {
    if (!isStreaming) {
      streamLevel = 0;
      return;
    }
    let cancelled = false;
    let raf = 0;
    const tick = (): void => {
      if (cancelled) return;
      streamLevelBuf ??= new Float32Array(1024);
      streams.snapshot(streamLevelBuf.length, streamLevelBuf);
      let sumSq = 0;
      for (const v of streamLevelBuf) sumSq += v * v;
      const rms = Math.sqrt(sumSq / streamLevelBuf.length);
      streamLevel = streamLevel * 0.5 + rms * 0.5;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  });
  const currentLevel = $derived(
    recorder.state === 'recording'
      ? recorder.level
      : isStreaming
        ? streamLevel
        : isPlayingAudio
          ? playbackLevel
          : 0
  );
  const levelPct = $derived(Math.min(100, Math.cbrt(currentLevel) * 130));
  // Inverse clip-path inset: the meter is a full-height gradient
  // strip; we clip the top `(100 - level)%` to leave the bottom
  // `level%` visible.  This keeps the gradient's *colour-at-height*
  // semantics stable (green near the bottom, rose near the top)
  // regardless of the current fill level.
  const levelClipInset = $derived(`${Math.max(0, 100 - levelPct)}% 0 0 0`);
  // Lifted out of the template because prettier wraps long
  // multi-stop gradient strings, which would split the `style:`
  // attribute value across lines and break HTML attribute parsing.
  // emerald-500 / amber-500 / rose-500 -- bottom = safe, top =
  // clipping, with the transition zone above ~78 %.
  const LEVEL_GRADIENT =
    'linear-gradient(to top, #10b981 0%, #10b981 55%, #f59e0b 78%, #f43f5e 95%)';

  const recorderError = $derived(recorder.error);
  const isRecording = $derived(recorder.state === 'recording');
  const isFinalizing = $derived(op === 'finalizing' || recorder.state === 'finalizing');
  const isImporting = $derived(op === 'importing');
  const isBusy = $derived(isRecording || isStreaming || isFinalizing || isImporting);
  const canStream = $derived(streams.audioStatus === 'open');

  // Record-button gating + copy.  The button is disabled whenever
  // anything is in flight, and additionally when the selected
  // source is the daemon stream but its socket isn't currently
  // open -- keyboard activation in that state would race the
  // stream-start guard inside `startCapture`, so we surface the
  // state visually too.  `recordTitle` is `undefined` for the
  // mic source (no useful tooltip to add beyond the aria-label);
  // for the stream source it carries either the auto-stop hint
  // (open) or a recovery hint (not open).
  const recordDisabled = $derived(isBusy || (selectedSource.kind === 'stream' && !canStream));
  const recordAriaLabel = $derived(
    selectedSource.kind === 'stream'
      ? 'Start capturing from the live opus stream'
      : 'Start recording from microphone'
  );
  const recordTitle = $derived<string | undefined>(
    selectedSource.kind === 'stream'
      ? canStream
        ? `Capture the live opus stream (auto-stops at ${Math.round(streamMaxDurationMs / 1000)}s).`
        : 'Stream is not connected. Open the Dashboard or wait for the daemon to come back online.'
      : undefined
  );
  // Stream option in the source dropdown.  Suffix the label with
  // the socket status -- but only when non-'open', so the default
  // "ready" state stays terse.  `SOCKET_LABEL` is the same socket-
  // pill vocabulary the dashboard uses, kept consistent so the
  // operator sees the same status words on both surfaces.
  const streamOptionLabel = $derived(
    canStream ? 'Daemon opus stream' : `Daemon opus stream · ${SOCKET_LABEL[streams.audioStatus]}`
  );

  const displayName = $derived(prettyCategoryName(categoryName));

  // Device labels are empty until microphone permission has been
  // granted at least once on this origin.  After the operator's
  // first successful capture, `enumerateDevices()` returns real
  // names; until then we fall back to a "Microphone N" placeholder
  // suffixed with a short id fragment so multiple devices remain
  // distinguishable in the dropdown.
  function describeDevice(d: MediaDeviceInfo, idx: number): string {
    if (d.label) return d.label;
    return `Microphone ${idx + 1} (${d.deviceId.slice(0, 6) || 'default'})`;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- `h-full` lets the pane absorb whatever vertical space the
     parent CategoryRow grid hands us; `flex flex-col` then lets
     the waveform / drop-zone slot inside grow with `flex-1` to
     fill that space instead of leaving a band of empty padding
     below the action buttons.
     `min-h-0` on the outer pane is what keeps every child's
     `flex-1 min-h-0` actually able to shrink -- without it the
     pane would inherit its content's intrinsic floor through the
     parent grid and trap the height-fluctuation hidden in the
     waveform slot.  See the waveform-row comment below for the
     same trick re-applied one level deeper.
     `contain-size` is load-bearing for cross-state height
     invariance.  Without it the waveform's `<canvas>` (sized by
     DPR via `element.width` / `element.height` attributes for a
     crisp render -- e.g. 1060 × 530 on a 2x display at 530 px
     pane width) contributes its 2 : 1 *intrinsic aspect ratio*
     to the grid track's content-based sizing, which lifts the
     row from the `min-h-80` floor (320 px) up to ~402 px in
     every state that mounts a canvas (recording, streaming,
     finalizing, draft).  The empty drop-zone state mounts no
     canvas, so it sat flush at 320 px while every other state
     ratcheted ~80 px taller -- the height jump the operator
     would see crossing the record / draft / discard cycle.
     `contain: size` tells the layout engine to ignore this
     pane's content when sizing its grid track, so the track
     stays welded to `min-h-80` regardless of what the
     waveform's natural ratio would otherwise suggest.  Mirrors
     the same trick on [SlicePane.svelte](SlicePane.svelte)
     which was already containing for the symmetric reason
     (slice grid intrinsic-content stretching).  Keep the
     `flex-1 min-h-0` discipline on the waveform row anyway:
     `contain: size` only zeros the *outward* intrinsic-size
     contribution; *inside* the pane, the flex column still
     needs that pair to let the waveform row absorb the
     leftover height under fixed-height chrome.
     Outer padding `px-3 pt-1.5 pb-3` with uniform `gap-1.5`:
     the 6 px above the header + 6 px gap below it sizes the
     heading's neighbourhood to its 11 px text rather than to
     the taller 19 px quota chip beside it.  `pb-3` matches
     `px-3` so the action row (or whichever chip stacked
     last) clears the rounded corner by the same distance it
     clears the sides.  SlicePane mirrors `pt-1.5 pb-3` +
     header `mb-1.5` so the two heading-bottom strips line
     up side-by-side; horizontal `px-3` keeps the chevron-
     to-edge geometry consistent with the CategoryRow body
     and the train accordion family. -->
<div
  class="flex h-full min-h-0 flex-col gap-1.5 overflow-hidden rounded-md border bg-white px-3 pt-1.5 pb-3 transition-colors contain-size {dragging
    ? 'border-blue-400 bg-blue-50/40'
    : 'border-zinc-200'}"
  ondrop={onDrop}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  aria-label="Input module for category {displayName}"
>
  <header class="flex min-h-4.75 items-center justify-between gap-1.5">
    <!-- "Input" alone (the category name lives on the accordion
         header above).  Inner cluster uses `items-center` so the
         10 px ⓘ glyph aligns with the caps' geometric centre;
         baseline alignment would lift it ~1 px high against a
         16.5 px line-box.  Outer header `items-center min-h-4.75`
         (19 px) shares its mechanism with SlicePane's pill-driven
         natural height — same layout MODE on both panes keeps the
         two h4 baselines welded cross-pane. -->
    <div class="flex items-center gap-1.5">
      <h4 class="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Input</h4>
      <Tips label="Input module tips">
        <ul class="space-y-1.5">
          <li>
            <strong class="font-medium text-zinc-900">Prefer the daemon's opus stream.</strong>
            Your slices share the same DSP as inference, so the trained head doesn't see a distribution
            shift after fine-tune.
          </li>
          <li>
            <strong class="font-medium text-zinc-900">Record in the deployment environment.</strong>
            A clean studio capture undertrains noise rejection; the real background is half of what the
            model needs to learn.
          </li>
          <li>
            <strong class="font-medium text-zinc-900">Stay green-to-amber on the meter.</strong>
            Rose means clipping, which erases information the trainer can't recover.
          </li>
        </ul>
      </Tips>
    </div>
    {#if isRecording}
      <span class="inline-flex items-center gap-1.5 text-[11px] text-zinc-600">
        <span class="relative inline-flex h-2 w-2">
          <span
            class="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-rose-400/70"
          ></span>
          <span class="relative inline-flex h-2 w-2 rounded-full bg-rose-500"></span>
        </span>
        <span class="font-mono tabular-nums">{formatRecordingClock(recorder.durationMs)}</span>
      </span>
    {:else if isStreaming}
      <span class="inline-flex items-center gap-1.5 text-[11px] text-zinc-600">
        <!-- Stream uses a blue dot (matches the dashboard's accent
             + WaveformCanvas line colour) to distinguish the source
             from the mic's rose dot at a glance. -->
        <span class="relative inline-flex h-2 w-2">
          <span
            class="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-blue-400/70"
          ></span>
          <span class="relative inline-flex h-2 w-2 rounded-full bg-blue-500"></span>
        </span>
        <span class="font-mono tabular-nums">{formatRecordingClock(streamDurationMs)}</span>
      </span>
    {:else if draft}
      <span class="font-mono text-[11px] tabular-nums text-zinc-500">
        {formatDuration(draft.duration_ms)} · {formatBytes(draft.size_bytes)}
      </span>
    {/if}
  </header>

  <!-- Waveform + vertical loudness meter.  Meter only mounts when
       there's signal to read so an idle pane runs full waveform
       width.  `flex-1 min-h-0` (no `min-h-32` floor) lets this slot
       compress under variable chrome (error chips, "imported from",
       cap notices) so the outer pane stays welded to the grid's
       `min-h-80` floor instead of ratcheting taller when an error
       fires.  Worst-case compression bottoms out at ~70-90 px,
       still readable. -->
  <div class="flex min-h-0 flex-1 gap-2">
    <div class="relative flex-1 overflow-hidden rounded-md bg-zinc-50">
      {#if isRecording || (isFinalizing && !isStreaming)}
        <LiveRecorderWaveform {recorder} />
      {:else if isStreaming}
        <!-- Stream-capture waveform: shared `EnvelopeWaveform` bound
             to the `streams` PcmSource.  Same engine the dashboard
             uses, so what the operator sees here is byte-identical
             to the live opus stream they'd see on the Dashboard
             tab -- minus the spectrogram half. -->
        <EnvelopeWaveform source={streams} />
      {:else if draft && draftPcm}
        <TrimWaveform
          pcm={draftPcm}
          startSamples={trimStart}
          endSamples={trimEnd}
          onChange={onTrimChange}
          onCommit={onTrimCommit}
          {playbackSample}
          onSeek={onPlaybackSeek}
          onSeekCommit={onPlaybackSeekCommit}
        />
      {:else if decodingDraft}
        <div class="flex h-full items-center justify-center text-[11px] text-zinc-500">
          <Spinner class="mr-1.5 h-3 w-3 text-zinc-500" />
          Decoding…
        </div>
      {:else}
        <!-- Empty-state drop zone.  Drag-and-drop is wired on the
             entire pane, but this surface advertises the
             affordance + offers a keyboard / click-accessible
             alternative.  The dashed border re-emphasises the
             pane's drop affordance during a drag-over via the
             parent's `dragging` flag. -->
        <label
          class="flex h-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-zinc-300 px-3 text-center text-[11px] text-zinc-500 transition hover:border-zinc-400 hover:bg-zinc-100/40"
          class:border-blue-400={dragging}
          class:bg-blue-50={dragging}
          title="Drop a WAV file here (up to {formatBytes(MAX_IMPORT_BYTES)}), or click to browse"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-5 w-5 text-zinc-400"
            aria-hidden="true"
          >
            <path d="M12 4v12" />
            <path d="M6 10l6-6 6 6" />
            <path d="M4 20h16" />
          </svg>
          <span>Drag &amp; drop a WAV here</span>
          <span
            class="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 transition group-hover:border-zinc-300"
          >
            Browse files
          </span>
          <input
            bind:this={inputEl}
            type="file"
            accept=".wav,audio/wav,audio/wave,audio/x-wav,audio/vnd.wave"
            class="sr-only"
            onchange={onPickerChange}
            disabled={isBusy}
          />
        </label>
      {/if}
    </div>

    <!-- Vertical loudness meter.  Visible whenever the pane has
         audio to show (mid-capture or a saved draft); only the
         empty state hides it entirely.  Keeping the bar slot
         present across record / idle / playback transitions
         eliminates the horizontal width snap that would otherwise
         happen each time play starts or stops.  The gradient
         lives on a full-height child; clip-path peels from the
         top so the colour at each height stays stable as the
         fill rises (emerald near the bottom → amber mid-high →
         rose at the clip ceiling). -->
    {#if showLevelBar}
      <div
        class="relative w-2 overflow-hidden rounded-full bg-zinc-200/60"
        aria-hidden="true"
        aria-label="Loudness meter"
      >
        <div
          class="absolute inset-0 transition-[clip-path] duration-75"
          style:clip-path="inset({levelClipInset})"
          style:background={LEVEL_GRADIENT}
        ></div>
      </div>
    {/if}
  </div>

  <!-- Selection status (draft only).  Telegraphs the trim range +
       projected slice count.  Amber when below the 1 s slicer
       minimum -- pairs with the disabled Slice button. -->
  {#if draft && draftPcm && !isRecording && !isFinalizing && !isImporting}
    <p
      class="text-[11px] tabular-nums"
      class:text-zinc-500={trimRangeSamples >= SLICE_SAMPLES && !atSliceCap && !wouldExceedCap}
      class:text-amber-700={trimRangeSamples < SLICE_SAMPLES || atSliceCap || wouldExceedCap}
    >
      Selection:
      <span class="font-mono">{(trimRangeMs / 1000).toFixed(1)} s</span>
      ·
      {#if trimRangeSamples < SLICE_SAMPLES}
        Drag the handles to ≥ 1 s to enable slicing.
      {:else if atSliceCap}
        Category at the {MAX_SLICES_PER_CATEGORY}-slice cap. Delete some slices to slice more.
      {:else if wouldExceedCap}
        {projectedSliceCount}
        {projectedSliceCount === 1 ? 'slice' : 'slices'} — only
        <span class="font-mono">{sliceCapHeadroom}</span>
        {sliceCapHeadroom === 1 ? 'slot' : 'slots'} left to the {MAX_SLICES_PER_CATEGORY} cap.
      {:else}
        {projectedSliceCount}
        {projectedSliceCount === 1 ? 'slice' : 'slices'} of 1 s each
        {#if unusedMs >= 10}· <span class="font-mono">{(unusedMs / 1000).toFixed(1)} s</span>
          unused{/if}
      {/if}
    </p>
  {/if}

  <!-- Action row.  Layout is state-dependent; `flex-wrap` keeps
       long button rows tidy on narrow pane widths. -->
  <div class="flex flex-wrap items-center gap-2">
    {#if isRecording || isStreaming}
      <!-- One Stop + one Discard for both capture paths.  The
           aria-label flips with the active op so screen readers
           announce which source the operator is stopping; the
           visible glyph + label are the same since "stop" is the
           same action visually. -->
      <Button
        variant="destructive"
        onclick={() => void stopCapture()}
        ariaLabel={isStreaming ? 'Stop stream capture' : 'Stop recording'}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="1.5" />
        </svg>
        Stop
      </Button>
      <Button variant="secondary" onclick={cancelCapture}>Discard</Button>
    {:else if isFinalizing}
      <Button disabled loading>Encoding…</Button>
    {:else if isImporting}
      <Button disabled loading>Decoding…</Button>
    {:else if draft}
      <!-- Slice is the primary CTA when a draft exists.  The button
           degrades to "At cap · N/MAX" when the category already
           holds `MAX_SLICES_PER_CATEGORY` slices, matching the
           Workspace list's "At cap" New-workspace pattern -- same
           shape across modules, so an operator who's hit the
           workspace cap recognises the slice cap at a glance.
           When the category is below the cap but the projected
           batch would push past, the button stays in its standard
           shape (so the count is still visible) but `disabled`
           latches via the `wouldExceedCap` arm of `canSlice` -- the
           operator sees "Slice · 12" disabled with a tooltip
           pointing them at the headroom they have.  Both states
           are governed by `canSlice`, so the existing disabled
           styling carries through. -->
      <Button
        onclick={performSlice}
        disabled={!canSlice}
        loading={slicing}
        ariaLabel={atSliceCap
          ? `Category at the ${MAX_SLICES_PER_CATEGORY}-slice cap. Delete some slices first.`
          : wouldExceedCap
            ? `Slicing would produce ${projectedSliceCount} slices, exceeding the ${MAX_SLICES_PER_CATEGORY}-slice cap by ${currentSliceCount + projectedSliceCount - MAX_SLICES_PER_CATEGORY}. Trim shorter to fit.`
            : canSlice
              ? `Slice into ${projectedSliceCount} ${projectedSliceCount === 1 ? 'slice' : 'slices'}`
              : 'Slice (selection must be at least 1 second)'}
        title={atSliceCap
          ? `${currentSliceCount} / ${MAX_SLICES_PER_CATEGORY} slices.  Delete some to slice more.`
          : wouldExceedCap
            ? `Would produce ${projectedSliceCount}; only ${sliceCapHeadroom} ${sliceCapHeadroom === 1 ? 'slot' : 'slots'} left until the ${MAX_SLICES_PER_CATEGORY} cap.  Trim shorter to fit.`
            : canSlice
              ? `Append ${projectedSliceCount} slice${projectedSliceCount === 1 ? '' : 's'} to the right pane`
              : 'Selection must be ≥ 1 s to slice'}
      >
        {#if atSliceCap}
          At cap · {currentSliceCount}/{MAX_SLICES_PER_CATEGORY}
        {:else}
          {#if !slicing}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-3 w-3"
              aria-hidden="true"
            >
              <path d="M14.5 17.5l-9-9" />
              <path d="M9 6L6 9l-3-3 3-3z" />
              <path d="M21 15l-3-3 3-3 3 3z" />
              <path d="M14.5 6.5L19 11" />
            </svg>
          {/if}
          Slice{canSlice || wouldExceedCap ? ` · ${projectedSliceCount}` : ''}
        {/if}
      </Button>

      <!-- Text-only secondary, parked next to Slice.  Adjacency
           mirrors the "thing + how to undo it" cluster the dataset
           accordion uses elsewhere (CategoryRow / SliceCard hover
           trashes).  The row reads heavy → light L→R: primary
           Slice, text-only Discard, glyph-only Play/Stop, glyph-
           only Export.  No leading icon — always-visible labelled
           chrome doesn't need a glyph beside an explicit word, and
           the row's icon vocabulary stays reserved for the symbol-
           only utilities. -->
      <Button
        variant="secondary"
        onclick={discardDraft}
        ariaLabel="Discard clip"
        title="Discard clip"
      >
        Discard
      </Button>

      <!-- Play/Stop on the trimmed range (cursor + drag-to-seek
           live inside TrimWaveform).  Glyph-only with `min-h-8.5
           px-2` for a square footprint paired with Export — the
           play triangle / stop square are universal media glyphs,
           and a shape-swap reads as state better than a label-swap.
           `ariaLabel` + `title` keep the verbose phrasing for SR /
           tooltip paths. -->
      {#if playing}
        <Button
          variant="secondary"
          onclick={stopPlayback}
          ariaLabel="Stop playback"
          title="Stop playback"
          class="min-h-8.5 px-2"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        </Button>
      {:else}
        <Button
          variant="secondary"
          onclick={playSelection}
          disabled={!draftPcm || trimRangeSamples <= 0}
          ariaLabel="Play the trimmed selection"
          title="Play the trimmed selection"
          class="min-h-8.5 px-2"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        </Button>
      {/if}

      <!-- Glyph-only at the tail; same `min-h-8.5 px-2` footprint
           as Play/Stop so they read as a paired utility cluster. -->
      <Button
        variant="secondary"
        onclick={exportDraft}
        ariaLabel="Download as WAV"
        title="Download as WAV"
        class="min-h-8.5 px-2"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M12 4v12" />
          <path d="M6 14l6 6 6-6" />
          <path d="M4 20h16" />
        </svg>
      </Button>
    {:else}
      <!-- Empty state: one primary `Record` CTA + a unified input-
           source dropdown.  The dropdown carries the browser's
           audio inputs and the daemon's live opus stream as
           `<optgroup>`-grouped entries; the button dispatches on
           the selected source through `startCapture`.  Stream
           selection survives a closed audio socket -- the
           Record button disables with a recovery-hint title
           until the socket reopens, then the same persisted
           preference works again.  Picker sizing mirrors Button
           md (`text-sm py-1.5`, border zinc-200) so both
           controls share a height baseline.

           Glyph stays the canonical record dot regardless of
           source: "start capture" is the same action, and the
           dropdown + aria-label disambiguate which source we're
           pulling from.  An icon flip would force screen-reader
           tooling to special-case a visual-only signal that
           is already encoded textually. -->
      <Button
        onclick={() => void startCapture()}
        disabled={recordDisabled}
        ariaLabel={recordAriaLabel}
        title={recordTitle}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3" aria-hidden="true">
          <circle cx="12" cy="12" r="6" />
        </svg>
        Record
      </Button>
      <select
        id="input-source-{workspaceId}-{categoryName}"
        bind:value={selectedKey}
        class="select-chevron min-w-0 max-w-56 flex-1 truncate rounded-md border border-zinc-200 bg-white py-1.5 pl-3 text-sm font-medium text-zinc-900 transition hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400"
        aria-label="Input source"
        disabled={isBusy}
      >
        <optgroup label="Microphone">
          <option value="">System default microphone</option>
          {#each audioInputs as device, idx (device.deviceId || idx)}
            <option value={device.deviceId}>{describeDevice(device, idx)}</option>
          {/each}
        </optgroup>
        <optgroup label="Live stream">
          <option value={STREAM_KEY}>{streamOptionLabel}</option>
        </optgroup>
      </select>
    {/if}
  </div>

  {#if maxReached && !isRecording && !isStreaming}
    <span class="text-[11px] text-amber-700"> Auto-stopped at the duration cap. </span>
  {/if}

  <!-- Recorder / generic error chips.  Both share the same
       alert chrome (`px-3 py-2`, rose-50 on rose-200) and the
       same dismiss button with `-mt-1 -mr-2`: the asymmetric
       negative margins compensate for the alert's asymmetric
       padding so the visible gap from the X to BOTH the top
       and right edges is the same 4 px (px-3 − mr-2 = 4 and
       py-2 − mt-1 = 4).  Same geometry rule as the
       training-area dismisses in TrainPane / HeadsList; a
       symmetric `-m-1` would leave the right gap at 8 px
       while the top sat at 4 px, which reads as the button
       hugging the top more than the side. -->
  {#if recorderError}
    <div
      class="flex items-start justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
      role="alert"
    >
      <span class="min-w-0 flex-1">{recorderError}</span>
      <button
        type="button"
        class="-mt-1 -mr-2 shrink-0 rounded-md p-1 text-rose-700 transition hover:bg-rose-100"
        onclick={dismissError}
        aria-label="Dismiss"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          class="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M6 18L18 6" />
        </svg>
      </button>
    </div>
  {/if}
  {#if error}
    <div
      class="flex items-start justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
      role="alert"
    >
      <span class="min-w-0 flex-1">{error}</span>
      <button
        type="button"
        class="-mt-1 -mr-2 shrink-0 rounded-md p-1 text-rose-700 transition hover:bg-rose-100"
        onclick={() => (error = null)}
        aria-label="Dismiss"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          class="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M6 18L18 6" />
        </svg>
      </button>
    </div>
  {/if}

  {#if draft?.source === 'imported' && draft.original_name}
    <p class="text-[11px] text-zinc-400" title={draft.original_name}>
      Imported from <span class="text-zinc-500">{draft.original_name}</span>
    </p>
  {/if}
</div>
