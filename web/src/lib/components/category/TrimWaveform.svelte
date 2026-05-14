<script lang="ts">
  import StaticWaveform from './StaticWaveform.svelte';
  import { SLICE_SAMPLES, WAV_SAMPLE_RATE } from '$lib/audio/wav';

  // Trim-aware waveform.  Wraps `StaticWaveform` with two draggable
  // handles + a translucent mask over the unselected regions, plus
  // an optional playback cursor used by the play-with-seek flow in
  // `InputPane`.  Architecture spec ([ARCHITECTURE.md §A.4 item
  // 3.3]): "drag the left and right edges to trim the audio
  // (minimum length: 1 s, 44 100 samples)."
  //
  // Three drag affordances share one `dragging` discriminator:
  //   start / end  -- per-handle width adjustment (the spec's
  //                   trim verbs).
  //   window       -- click + drag the empty area BETWEEN the two
  //                   handles to slide both edges together,
  //                   preserving width.  Lets the operator
  //                   reposition a fixed-length window over the
  //                   clip without re-aligning each edge by hand,
  //                   which is the common case when scrubbing
  //                   for a usable 1-2 s region inside a longer
  //                   capture.
  //   playback     -- scrub the play cursor (only when the parent
  //                   wires `onSeek`).
  // Z-stack is `start/end : z-20`, `window : z-auto`, `playback :
  // z-30` -- so the handles and the play cursor still claim their
  // 24 px hit slots even when overlapping the window, and the
  // window only fires in the empty middle.
  //
  // Controlled: the parent owns `startSamples` / `endSamples` and
  // updates them via `onChange` (during drag, smooth) and
  // `onCommit` (on pointerup, persist).  The split lets the parent
  // throttle persistence to drag-commit while still flowing the
  // values back through props for live render.
  //
  // Drag model: document-level `pointermove` / `pointerup` /
  // `pointercancel` listeners are attached via `$effect` for the
  // lifetime of an active drag, then torn down.  This is the same
  // pattern HealthBadge and ContextMenu use for outside-tap
  // dismissal in this codebase, and avoids two earlier hazards:
  //   - Per-handle `setPointerCapture`: tied capture to the
  //     handle DOM node, which Svelte's reactive `style:left`
  //     reconciliation could indirectly release on some browsers.
  //   - `<svelte:window>` listeners: didn't reliably fire from
  //     handle-initiated drags in this project's setup.
  // Capture-phase listeners fire before any descendant
  // `stopPropagation`, so the drag stays glued to the pointer
  // regardless of what other listeners are on the way.
  //
  // Visual chrome: a 24 px wide hit area centred on each handle's
  // percentage, with a 3 px coloured shaft + a 10 × 24 px grip
  // pill at vertical centre.  The hit area is wider than the
  // visible chrome so the operator's pointer reliably grabs the
  // handle even on a thin 128 px tall canvas.
  interface Props {
    pcm: Float32Array;
    startSamples: number;
    endSamples: number;
    onChange: (start: number, end: number) => void;
    onCommit: (start: number, end: number) => void;
    minGapSamples?: number;
    color?: string;
    background?: string;
    // Optional playback cursor.  `null` hides it; a sample index
    // renders a vertical line + draggable grip at that position.
    // `onSeek` (if provided) fires on cursor drag so the parent
    // can mirror the visual scrub; `onSeekCommit` fires on drop
    // so the parent can restart audio playback from the new
    // offset.  Mirrors the trim handle pattern (`onChange` +
    // `onCommit`) so a single drag produces N visual updates +
    // one expensive audio restart.
    playbackSample?: number | null;
    onSeek?: (sample: number) => void;
    onSeekCommit?: (sample: number) => void;
  }
  let {
    pcm,
    startSamples,
    endSamples,
    onChange,
    onCommit,
    minGapSamples = SLICE_SAMPLES,
    color = '#3b82f6',
    background = '#fafafa',
    playbackSample = null,
    onSeek,
    onSeekCommit
  }: Props = $props();

  let wrapper = $state<HTMLDivElement | undefined>();
  // Which affordance is currently being dragged.  `null` outside
  // an active drag.  Drives the `$effect` that attaches the
  // document-level move / up listeners.  `'window'` is the slide-
  // both-edges-together drag rooted in the selection contour;
  // see the file-header comment for the affordance taxonomy.
  let dragging = $state<'start' | 'end' | 'playback' | 'window' | null>(null);
  // Snapshot of the wrapper's geometry at pointerdown.  Using a
  // stale rect for the drag duration is cheaper than calling
  // getBoundingClientRect on every pointermove, and a resize
  // mid-drag is rare enough that the snapshot is safe.  Defaults
  // are non-zero so `clientXToSample` doesn't accidentally
  // divide-by-zero before the first drag.
  let dragRectLeft = 0;
  let dragRectWidth = 1;
  // Anchor for the `'window'` slide.  We translate deltas from
  // the pointer's start position against a frozen (start, end)
  // pair so a long drag accumulates pixel error against ONE
  // baseline, not against each frame's new state.  Driving the
  // slide off the *current* `startSamples` + clientX delta-since-
  // last-move worked for a few hundred ms but accumulated round-
  // trip rounding (sample→percent→sample on every move), which
  // visibly drifted on a slow drag across the whole clip and
  // made width creep by 1-2 samples per second of dragging.
  // Anchoring once at pointerdown collapses every move into a
  // single (clientX, anchorStart, anchorEnd) → (newStart, newEnd)
  // computation, so width is bit-for-bit preserved and the only
  // rounding is one `Math.round` on the delta itself.
  let dragAnchorClientX = 0;
  let dragAnchorStart = 0;
  let dragAnchorEnd = 0;

  // Convert sample positions to percentages of the waveform width.
  // The canvas spans 100 % of the wrapper; handles + mask use the
  // same coordinate.  Guard against zero-length pcm (mounting race
  // when the parent's `decodingDraft` flips before pcm arrives).
  const totalSamples = $derived(pcm.length || 1);
  const startPct = $derived((startSamples / totalSamples) * 100);
  const endPct = $derived((endSamples / totalSamples) * 100);
  // Playback cursor position.  Clamped into the wrapper bounds so a
  // rounding overshoot at end-of-clip can't render the grip past
  // the visible canvas.
  const playbackPct = $derived(
    playbackSample === null
      ? null
      : Math.max(0, Math.min(100, (playbackSample / totalSamples) * 100))
  );

  function clientXToSample(clientX: number, total: number): number {
    if (dragRectWidth <= 0) return 0;
    const pct = (clientX - dragRectLeft) / dragRectWidth;
    const clamped = Math.max(0, Math.min(1, pct));
    return Math.round(clamped * total);
  }

  function startDrag(handle: 'start' | 'end' | 'playback' | 'window', e: PointerEvent): void {
    // preventDefault keeps the OS-level drag-selection out of the
    // way.  No stopPropagation: the document-level capture-phase
    // listeners fire before any bubbled cancellation anyway, and
    // letting bubble proceed avoids surprising siblings.
    e.preventDefault();
    const w = wrapper;
    if (!w) return;
    const rect = w.getBoundingClientRect();
    dragRectLeft = rect.left;
    dragRectWidth = rect.width;
    if (handle === 'window') {
      dragAnchorClientX = e.clientX;
      dragAnchorStart = startSamples;
      dragAnchorEnd = endSamples;
    }
    dragging = handle;
    // Belt-and-suspenders pointer capture.  Document-level
    // listeners are the primary drag path, but touch implicitly
    // captures to `e.target` on pointerdown -- explicitly
    // re-capturing on `currentTarget` keeps the gesture rooted
    // at the handle even if some descendant intercepts.  Wrapped
    // in try/catch because Safari throws on already-released ids.
    try {
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
    } catch {
      /* deliberate */
    }
  }

  // Document-level drag listeners.  Attached only while
  // `dragging !== null`, in the capture phase so descendant
  // `stopPropagation` can't strand the drag, and torn down via
  // the effect's cleanup function when the drag ends or the
  // component unmounts.  This mirrors the
  // `HealthBadge`/`ContextMenu` pattern in this codebase.
  $effect(() => {
    if (dragging === null) return;

    const onMove = (e: PointerEvent): void => {
      if (dragging === null) return;
      if (dragging === 'window') {
        // Slide both handles by the same pixel-derived delta, then
        // clamp `newStart` into `[0, total - width]` so the window
        // pins to whichever bound it hits without ever shrinking
        // (newEnd is derived from newStart + frozen width).  Note
        // the anchor is captured at pointerdown -- using `e.clientX
        // - dragAnchorClientX` against the frozen baseline is what
        // keeps width invariant under rounding; see the
        // `dragAnchorClientX` declaration's commentary for the
        // drift trap this avoids.
        const total = pcm.length;
        if (total <= 0 || dragRectWidth <= 0) return;
        const width = dragAnchorEnd - dragAnchorStart;
        const deltaSamples = Math.round(((e.clientX - dragAnchorClientX) * total) / dragRectWidth);
        const maxStart = Math.max(0, total - width);
        const newStart = Math.max(0, Math.min(dragAnchorStart + deltaSamples, maxStart));
        onChange(newStart, newStart + width);
        return;
      }
      const sample = clientXToSample(e.clientX, pcm.length);
      if (dragging === 'start') {
        const newStart = Math.max(0, Math.min(sample, endSamples - minGapSamples));
        onChange(newStart, endSamples);
      } else if (dragging === 'end') {
        const newEnd = Math.min(pcm.length, Math.max(sample, startSamples + minGapSamples));
        onChange(startSamples, newEnd);
      } else if (onSeek) {
        // dragging === 'playback'; gate is the onSeek presence.
        onSeek(Math.max(0, Math.min(pcm.length, sample)));
      }
    };

    const onUp = (): void => {
      if (dragging === null) return;
      const wasDragging = dragging;
      // Clear first so the effect cleanup tears down the listeners
      // before we fire the commit callback (the commit may trigger
      // a parent re-render that recreates this component, which
      // would otherwise leak the listeners we're about to remove).
      dragging = null;
      if (wasDragging === 'start' || wasDragging === 'end' || wasDragging === 'window') {
        onCommit(startSamples, endSamples);
      } else if (onSeekCommit && playbackSample !== null) {
        onSeekCommit(playbackSample);
      }
    };

    document.addEventListener('pointermove', onMove, { capture: true });
    document.addEventListener('pointerup', onUp, { capture: true });
    document.addEventListener('pointercancel', onUp, { capture: true });
    return () => {
      document.removeEventListener('pointermove', onMove, { capture: true });
      document.removeEventListener('pointerup', onUp, { capture: true });
      document.removeEventListener('pointercancel', onUp, { capture: true });
    };
  });

  // Keyboard nudge support.  ArrowLeft/Right moves by 1 / 100 of
  // the clip; Shift modifier moves by 1 / 10.  Snap-to-end with
  // Home / End.  Commit on every keystroke so the persisted trim
  // matches the visible selection without waiting for a focus blur.
  function onHandleKey(handle: 'start' | 'end', e: KeyboardEvent): void {
    const step = e.shiftKey
      ? Math.max(1, Math.round(pcm.length / 10))
      : Math.max(1, Math.round(pcm.length / 100));
    let delta = 0;
    if (e.key === 'ArrowLeft') delta = -step;
    else if (e.key === 'ArrowRight') delta = step;
    else if (e.key === 'Home') {
      e.preventDefault();
      if (handle === 'start') {
        onChange(0, endSamples);
        onCommit(0, endSamples);
      } else {
        const newEnd = Math.max(startSamples + minGapSamples, minGapSamples);
        onChange(startSamples, newEnd);
        onCommit(startSamples, newEnd);
      }
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      if (handle === 'end') {
        onChange(startSamples, pcm.length);
        onCommit(startSamples, pcm.length);
      } else {
        const newStart = Math.min(endSamples - minGapSamples, pcm.length - minGapSamples);
        onChange(Math.max(0, newStart), endSamples);
        onCommit(Math.max(0, newStart), endSamples);
      }
      return;
    } else {
      return;
    }
    e.preventDefault();
    if (handle === 'start') {
      const newStart = Math.max(0, Math.min(startSamples + delta, endSamples - minGapSamples));
      onChange(newStart, endSamples);
      onCommit(newStart, endSamples);
    } else {
      const newEnd = Math.min(
        pcm.length,
        Math.max(endSamples + delta, startSamples + minGapSamples)
      );
      onChange(startSamples, newEnd);
      onCommit(startSamples, newEnd);
    }
  }

  // Keyboard slide for the selection window.  Arrow keys move the
  // window by 1/100 of the clip (Shift for 1/10); Home/End snap to
  // either edge.  Width is preserved across every key -- we derive
  // `newEnd` from `newStart + width`, never from independent
  // clamps on each bound.  Commit on every keystroke so a quick
  // tap-tap-tap matches the visible position without waiting for
  // focus blur (same shape as `onHandleKey`).
  function onWindowKey(e: KeyboardEvent): void {
    const total = pcm.length;
    if (total <= 0) return;
    const width = endSamples - startSamples;
    const maxStart = Math.max(0, total - width);
    if (maxStart === 0) return; // window already fills the clip -- nowhere to slide
    const step = e.shiftKey
      ? Math.max(1, Math.round(total / 10))
      : Math.max(1, Math.round(total / 100));
    let newStart: number | null = null;
    if (e.key === 'ArrowLeft') newStart = Math.max(0, startSamples - step);
    else if (e.key === 'ArrowRight') newStart = Math.min(maxStart, startSamples + step);
    else if (e.key === 'Home') newStart = 0;
    else if (e.key === 'End') newStart = maxStart;
    else return;
    e.preventDefault();
    if (newStart === startSamples) return; // pinned at boundary; skip commit
    onChange(newStart, newStart + width);
    onCommit(newStart, newStart + width);
  }

  // Format the trim values as seconds for the aria-valuetext label.
  const startSec = $derived((startSamples / WAV_SAMPLE_RATE).toFixed(2));
  const endSec = $derived((endSamples / WAV_SAMPLE_RATE).toFixed(2));
  // Window-slider aria values.  `aria-valuemax` is `total - width`
  // (the highest valid start position given the current window
  // width); it shifts as the two trim handles resize the window,
  // which is correct ARIA semantics for a slider whose effective
  // range depends on context.  `aria-valuenow` tracks the start;
  // `aria-valuetext` carries the human-readable window bounds.
  const windowMax = $derived(Math.max(0, pcm.length - (endSamples - startSamples)));
</script>

<div
  bind:this={wrapper}
  class="relative h-full w-full select-none"
  aria-label="Trim handles -- drag to set the start and end of the slice range"
>
  <StaticWaveform {pcm} {color} {background} />

  <!-- Translucent mask over unselected regions.  Two divs, one on
       each side of the selection.  `pointer-events-none` so they
       never intercept the underlying handle drags. -->
  <div
    class="pointer-events-none absolute inset-y-0 left-0 bg-zinc-900/40"
    style:width="{startPct}%"
  ></div>
  <div
    class="pointer-events-none absolute inset-y-0 bg-zinc-900/40"
    style:left="{endPct}%"
    style:right="0"
  ></div>

  <!-- Start handle.  24 px hit area with a 3 px vertical shaft and
       a 10 × 24 px vertical grip pill at vertical centre.  Hit
       area is wider than the visible chrome so the pointer
       reliably grabs the handle on a thin 128 px tall canvas. -->
  <div
    role="slider"
    aria-label="Trim start"
    aria-valuemin={0}
    aria-valuemax={pcm.length}
    aria-valuenow={startSamples}
    aria-valuetext="{startSec} seconds"
    tabindex="0"
    class="group absolute inset-y-0 z-20 flex w-6 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center"
    class:cursor-grabbing={dragging === 'start'}
    style:left="{startPct}%"
    onpointerdown={(e) => startDrag('start', e)}
    onkeydown={(e) => onHandleKey('start', e)}
  >
    <div
      class="pointer-events-none h-full w-0.75 rounded-full bg-blue-600 shadow-sm transition-colors group-hover:bg-blue-700"
    ></div>
    <div
      class="pointer-events-none absolute top-1/2 left-1/2 h-6 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600 shadow ring-1 ring-white/80 transition-colors group-hover:bg-blue-700"
    ></div>
  </div>

  <!-- Selection contour + window-slide hit target.  The visible
       blue bracket lives on this element's `border-x-2`; the
       *interactive* part is the full box (border + transparent
       middle), which catches `pointerdown` for the slide-both-
       handles-together drag.  Z-stack: this div sits at the
       default z-auto, the two trim handles at z-20 and the
       playback cursor at z-30 -- so a click at either edge
       (where the handles overlap with the contour's left/right
       borders) routes to the handle, a click on the play cursor
       routes to playback, and only the empty middle triggers a
       window slide.  Cursor reflects the same priority: grab
       here, ew-resize on the handles.
       DOM order is `start → window → end` so the keyboard tab
       order matches the visual left-to-right reading (start,
       middle, end).  Stacking is governed by `z-20` on the
       handles regardless of DOM order, so painting still puts
       the handle grips on top of the contour.
       Touch behaviour: `touch-none` matches the handles so a
       horizontal pan inside the selection doesn't kick into
       browser scroll/zoom.
       Focus visibility: `ring-inset` keeps the focus indicator
       inside the contour's box (otherwise it would clip against
       the trim handles sitting on the same edges).  The very
       light blue overlay on focus reads as "this area is now
       keyboard-active" without obscuring the underlying
       waveform. -->
  <div
    role="slider"
    aria-label="Slide selection window -- drag to move both trim edges together"
    aria-valuemin={0}
    aria-valuemax={windowMax}
    aria-valuenow={startSamples}
    aria-valuetext="{startSec} to {endSec} seconds"
    tabindex="0"
    class="absolute inset-y-0 cursor-grab touch-none border-x-2 border-blue-500/70 focus:outline-none focus-visible:bg-blue-500/5 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-inset"
    class:cursor-grabbing={dragging === 'window'}
    style:left="{startPct}%"
    style:width="{Math.max(0, endPct - startPct)}%"
    onpointerdown={(e) => startDrag('window', e)}
    onkeydown={onWindowKey}
  ></div>

  <!-- End handle, mirrored. -->
  <div
    role="slider"
    aria-label="Trim end"
    aria-valuemin={0}
    aria-valuemax={pcm.length}
    aria-valuenow={endSamples}
    aria-valuetext="{endSec} seconds"
    tabindex="0"
    class="group absolute inset-y-0 z-20 flex w-6 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center"
    class:cursor-grabbing={dragging === 'end'}
    style:left="{endPct}%"
    onpointerdown={(e) => startDrag('end', e)}
    onkeydown={(e) => onHandleKey('end', e)}
  >
    <div
      class="pointer-events-none h-full w-0.75 rounded-full bg-blue-600 shadow-sm transition-colors group-hover:bg-blue-700"
    ></div>
    <div
      class="pointer-events-none absolute top-1/2 left-1/2 h-6 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600 shadow ring-1 ring-white/80 transition-colors group-hover:bg-blue-700"
    ></div>
  </div>

  <!-- Playback cursor (optional).  Renders only when the parent
       passes a non-null `playbackSample`.  A 2 px shaft + flag at
       the top so the operator can scrub.  z-30 sits above the
       trim handles so the cursor wins when overlapping (which
       happens any time playback starts at trim_start). -->
  {#if playbackPct !== null}
    <div
      role="slider"
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={pcm.length}
      aria-valuenow={playbackSample ?? 0}
      tabindex="-1"
      class="group absolute inset-y-0 z-30 flex w-6 -translate-x-1/2 touch-none items-start justify-center"
      class:cursor-ew-resize={!!onSeek}
      class:cursor-grabbing={dragging === 'playback'}
      style:left="{playbackPct}%"
      onpointerdown={onSeek ? (e) => startDrag('playback', e) : undefined}
    >
      <div class="pointer-events-none h-full w-0.5 rounded-full bg-rose-500/90 shadow-sm"></div>
      <div
        class="pointer-events-none absolute top-0 left-1/2 h-3 w-2.5 -translate-x-1/2 rounded-b-md bg-rose-500 shadow"
      ></div>
    </div>
  {/if}
</div>
