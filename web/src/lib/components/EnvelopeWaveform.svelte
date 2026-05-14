<script lang="ts">
  import { onMount } from 'svelte';
  import type { PcmSource } from '$lib/audio/pcm-source';
  import {
    nextVisualRenderAt,
    visualDevicePixelRatio
  } from '$lib/components/dashboard/visualRuntime';
  import { hexToRgba } from '$lib/utils/color';

  // Generic min/max envelope waveform.  One component, two
  // surfaces: the dashboard's live opus stream (`streams` store)
  // and the per-category InputPane's microphone recorder both
  // implement `PcmSource`, so they paint with the same engine.
  // Centralising means:
  //   * one place to tune the render math (anti-aliasing,
  //     contour smoothing, baseline color)
  //   * one place to fix bugs -- the recorder's old custom
  //     component would jitter while the streams' version
  //     wouldn't because only the latter had a smoothed render
  //     cursor; with `PcmSource.renderCursor` baked into the
  //     contract, both surfaces get cursor smoothing for free
  //   * one performance budget -- shared scratch buffers, one
  //     resize-observer pattern, one RAF loop shape
  //
  // The component is generic on the source so we can paint any
  // future PCM provider (a decoded WAV playback ring, a remote
  // shared source, etc.) without copying the canvas math.
  //
  // Rendering pipeline per RAF:
  //   1. `nextVisualRenderAt(now, lastRenderAt)` paces the loop to
  //      MAX_RENDER_HZ (handles 120 Hz / 144 Hz displays without
  //      accidentally dropping to 72 Hz).
  //   2. Apply any pending canvas resize (recorded by the
  //      ResizeObserver between frames).
  //   3. Ask the source for a smoothed end-sample via
  //      `renderCursor(now)`.  Returning 0 means "no data yet" -- we
  //      paint just the background + center-line and skip the
  //      envelope reads.
  //   4. Snap that end-sample DOWN to a bin boundary so the
  //      pixel-to-bin mapping is fixed in absolute time across
  //      frames; carry the sub-sample remainder as a sub-pixel
  //      `ctx.translate` so the visual scroll matches the
  //      cursor's continuous motion without the bin-grid
  //      reorganisation flicker `envelopeAt`-with-raw-cursor
  //      would otherwise produce on high-density audio.  See
  //      the "Stable bin alignment" comment inside `draw` for
  //      the per-frame math.
  //   5. Read min/max into caller-owned `loBuf` / `hiBuf` (sized
  //      to the canvas width + 1 in backing pixels -- the extra
  //      phantom slot extends the contour past the right edge
  //      so the sub-pixel translate doesn't leave a pulsing
  //      0..1-px background gap there).
  //   6. Paint background + centre line (un-translated), then
  //      translate by `-subPxOffset` and paint the fill +
  //      top / bottom contour lines on top.
  interface Props {
    source: PcmSource;
    seconds?: number;
    color?: string;
    background?: string;
  }
  // zinc-50 background is the nested-data tier across the app
  // (Active Head card, expanded category body); a waveform inside
  // one of those tiers reads as a sibling, not an outlier.
  let { source, seconds = 3, color = '#3b82f6', background = '#fafafa' }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  onMount(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) return;

    let hiBuf: Float32Array = new Float32Array(0);
    let loBuf: Float32Array = new Float32Array(0);

    // RAF-coalesced resize: ResizeObserver records target dims,
    // RAF applies them in the same frame as the next draw so a
    // window-edge drag does not flash blank pixels.
    let pendingW = 1;
    let pendingH = 1;
    let needsResize = true;

    const updatePendingSize = (): void => {
      const dpr = visualDevicePixelRatio();
      const r = el.getBoundingClientRect();
      pendingW = Math.max(1, Math.floor(r.width * dpr));
      pendingH = Math.max(1, Math.floor(r.height * dpr));
      needsResize = true;
    };

    updatePendingSize();
    const ro = new ResizeObserver(updatePendingSize);
    ro.observe(el);
    window.addEventListener('resize', updatePendingSize, { passive: true });

    const fillRgba = hexToRgba(color, 0.15);
    const gridStroke = '#e4e4e7';

    let raf: number | null = null;
    let lastRenderAt = Number.NEGATIVE_INFINITY;

    const draw = (now: DOMHighResTimeStamp): void => {
      const renderAt = nextVisualRenderAt(now, lastRenderAt);
      if (renderAt === null) {
        raf = requestAnimationFrame(draw);
        return;
      }
      lastRenderAt = renderAt;

      if (needsResize) {
        if (el.width !== pendingW) el.width = pendingW;
        if (el.height !== pendingH) el.height = pendingH;
        // Buffer length is `pendingW + 1`: the extra slot at
        // index `w` is the phantom column that extends the
        // contour past the canvas right edge (see "Phantom
        // slot" note below).
        if (hiBuf.length !== pendingW + 1) {
          hiBuf = new Float32Array(pendingW + 1);
          loBuf = new Float32Array(pendingW + 1);
        }
        needsResize = false;
      }
      const w = el.width;
      const h = el.height;
      const mid = h / 2;
      const amp = mid * 0.92;

      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);

      // Centre-line baseline -- visible across surfaces so the
      // operator's eye finds zero-crossing immediately.  Painted
      // un-translated so it stays anchored to the canvas frame
      // (not scrolling with the audio).
      ctx.strokeStyle = gridStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();

      const sampleRate = source.sampleRate;
      if (sampleRate <= 0) {
        // Idle source (recorder not started, or torn down).  Skip
        // the envelope read; the baseline-only paint above keeps
        // the canvas visually present without showing stale data.
        raf = requestAnimationFrame(draw);
        return;
      }
      const endSample = source.renderCursor(now);
      if (endSample <= 0) {
        raf = requestAnimationFrame(draw);
        return;
      }

      // ── Stable bin alignment ────────────────────────────────
      // The pixel-to-bin mapping must be FIXED in absolute time
      // across frames, or the same audio peak migrates between
      // adjacent pixels every RAF and reads as flicker.  The
      // mechanism: `samplesPerBin` is the integer number of
      // PCM samples per visual column (constant for a given
      // canvas width + duration).  We snap `endSample` down to
      // a multiple of `samplesPerBin` -- so each column `x`
      // always covers `[(k - (w-x))*M, (k - (w-x-1))*M)` for the
      // current bin index `k = snappedEnd / M`.  Bin contents
      // are stable in absolute sample time; the only thing that
      // changes between frames is which bin a given column
      // refers to, and bins simply shift leftward as the cursor
      // advances.
      //
      // Without this snap, `envelopeAt(endSample, ...)` would
      // compute bin boundaries from `endSample - windowSamples`,
      // which moves by `cursorAdvance % samplesPerBin` samples
      // every frame -- around 80-120 samples per RAF at 48 kHz
      // / 60 Hz, well above the per-bin sample resolution.  A
      // peak that lands near bin boundary B at frame N lands
      // near boundary B-2 (or B-3) at frame N+1, and whichever
      // bin owns the peak's max value alternates between
      // adjacent pixels at the frame rate.  On dense audio
      // (speech, music, mic noise) this manifests as the whole
      // waveform "shimmering" -- the user-visible flicker.
      //
      // The sub-sample remainder `(endSample - snappedEnd)`
      // becomes a sub-pixel `ctx.translate` so the visual
      // scroll keeps the cursor's continuous motion even though
      // `snappedEnd` only ratchets in `samplesPerBin`-sample
      // steps.  Net visual: per frame the image translates
      // leftward by exactly `(cursorAdvance / samplesPerBin)`
      // pixels (the same rate the cursor itself advances), the
      // bin grid stays locked in absolute time, and no pixel's
      // value changes between frames except where it crosses a
      // new bin's worth of data.
      //
      // The lag this introduces -- the rightmost pixel showing
      // samples up to `snappedEnd` rather than `endSample` --
      // is bounded by `samplesPerBin - 1`, ≈ 7.5 ms at 48 kHz
      // with 360 samples per bin, well below perception.
      const samplesPerBin = Math.max(1, Math.round((sampleRate * seconds) / w));
      const snappedEnd = Math.floor(endSample / samplesPerBin) * samplesPerBin;
      const subPxOffset = (endSample - snappedEnd) / samplesPerBin;

      source.envelopeAt(snappedEnd, w * samplesPerBin, w, loBuf, hiBuf);

      // Phantom slot at index `w` carries slot `w-1`'s value so
      // the stroked + filled contours have a segment extending
      // past the canvas right edge.  Without it, the sub-pixel
      // translate of up to 1 px would leave a 0..1-px-wide gap
      // of background colour on the right edge that pulses
      // every bin cycle -- which would itself read as a thin
      // strip of right-edge flicker even after the central
      // bin-grid drift is fixed.
      loBuf[w] = loBuf[w - 1];
      hiBuf[w] = hiBuf[w - 1];

      ctx.save();
      ctx.translate(-subPxOffset, 0);

      // Filled envelope (translucent).  Two passes: upper contour
      // left-to-right, lower contour right-to-left, close + fill
      // so the polygon wraps both sides of the centre line.  Loop
      // bound is `x <= w` (inclusive) so the phantom slot
      // participates in the polygon.
      ctx.fillStyle = fillRgba;
      ctx.beginPath();
      ctx.moveTo(0, mid - hiBuf[0] * amp);
      for (let x = 1; x <= w; x++) ctx.lineTo(x, mid - hiBuf[x] * amp);
      for (let x = w; x >= 0; x--) ctx.lineTo(x, mid - loBuf[x] * amp);
      ctx.closePath();
      ctx.fill();

      // Top and bottom contour lines.  `round` line-join smooths
      // the steep transitions a high-zoom render would otherwise
      // show.
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(0, mid - hiBuf[0] * amp);
      for (let x = 1; x <= w; x++) ctx.lineTo(x, mid - hiBuf[x] * amp);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, mid - loBuf[0] * amp);
      for (let x = 1; x <= w; x++) ctx.lineTo(x, mid - loBuf[x] * amp);
      ctx.stroke();

      ctx.restore();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      ro.disconnect();
      window.removeEventListener('resize', updatePendingSize);
    };
  });
</script>

<canvas bind:this={canvas} class="block h-full w-full rounded-md"></canvas>
