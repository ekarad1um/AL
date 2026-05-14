<script lang="ts">
  import { onMount } from 'svelte';
  import { visualDevicePixelRatio } from '$lib/components/dashboard/visualRuntime';
  import { hexToRgba } from '$lib/utils/color';
  import { envelopeFromRing } from '$lib/audio/ring-buffer';

  // Static waveform display for a saved draft clip.  Renders the
  // entire PCM Float32Array as a min/max envelope across canvas
  // width bins -- no RAF loop, just an idempotent draw on mount +
  // resize + when the underlying PCM reference changes.
  //
  // Visually consistent with `LiveRecorderWaveform`: same baseline,
  // same fill + contour treatment, same zinc-50 background.  Two
  // sibling surfaces in the same expanded category row should read
  // as the same primitive applied to different data (live vs.
  // saved); the only operator-noticeable difference is that the
  // static version doesn't scroll.
  //
  // B.4 will overlay range-selection handles on this base; the
  // component is intentionally focused so that extension is purely
  // additive (drop in handles inside the same canvas wrapper).
  interface Props {
    pcm: Float32Array;
    color?: string;
    background?: string;
  }
  let { pcm, color = '#3b82f6', background = '#fafafa' }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  onMount(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) return;

    let hiBuf: Float32Array = new Float32Array(0);
    let loBuf: Float32Array = new Float32Array(0);
    let pendingW = 1;
    let pendingH = 1;
    let needsRender = true;

    const updatePendingSize = (): void => {
      const dpr = visualDevicePixelRatio();
      const r = el.getBoundingClientRect();
      pendingW = Math.max(1, Math.floor(r.width * dpr));
      pendingH = Math.max(1, Math.floor(r.height * dpr));
      needsRender = true;
      schedule();
    };

    // Re-render when the PCM reference changes (operator records or
    // imports again, so the same component instance gets a new
    // draft).  Reading `pcm` inside this effect makes it a
    // dependency.  The Svelte 5 reactivity model picks up the prop
    // change here -- the parent passes a fresh Float32Array, the
    // effect runs.
    $effect(() => {
      // Touch the reactive binding so the effect tracks pcm.
      void pcm;
      needsRender = true;
      schedule();
    });

    let rafHandle = 0;
    // Arrow functions (rather than `function` declarations) preserve
    // the TS narrowing on `ctx` -- declarations are hoisted, which
    // makes the type checker assume the function could run before the
    // `if (!ctx) return;` narrowing point and widens the type back to
    // include null.  Const arrow functions are not hoisted, so the
    // narrowing flows through the closure cleanly.
    const schedule = (): void => {
      if (rafHandle !== 0) return;
      rafHandle = requestAnimationFrame(() => {
        rafHandle = 0;
        render();
      });
    };

    const render = (): void => {
      if (!needsRender) return;
      if (el.width !== pendingW) el.width = pendingW;
      if (el.height !== pendingH) el.height = pendingH;
      if (hiBuf.length !== pendingW) {
        hiBuf = new Float32Array(pendingW);
        loBuf = new Float32Array(pendingW);
      }
      needsRender = false;

      const w = el.width;
      const h = el.height;
      const mid = h / 2;
      const amp = mid * 0.92;

      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = '#e4e4e7';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();

      // Whole-clip min/max envelope.  `envelopeFromRing` treats
      // `pcm` as a non-wrapping ring (totalWritten = pcm.length,
      // endSample = pcm.length) -- same algorithm the live
      // EnvelopeWaveform uses, so the static + live renderings
      // share one bin-mapping path.
      if (pcm.length > 0 && w > 0) {
        envelopeFromRing(pcm, pcm.length, pcm.length, pcm.length, w, loBuf, hiBuf);

        ctx.fillStyle = hexToRgba(color, 0.15);
        ctx.beginPath();
        ctx.moveTo(0, mid - hiBuf[0] * amp);
        for (let x = 1; x < w; x++) ctx.lineTo(x, mid - hiBuf[x] * amp);
        for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, mid - loBuf[x] * amp);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.25;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(0, mid - hiBuf[0] * amp);
        for (let x = 1; x < w; x++) ctx.lineTo(x, mid - hiBuf[x] * amp);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, mid - loBuf[0] * amp);
        for (let x = 1; x < w; x++) ctx.lineTo(x, mid - loBuf[x] * amp);
        ctx.stroke();
      }
    };

    updatePendingSize();
    const ro = new ResizeObserver(updatePendingSize);
    ro.observe(el);
    window.addEventListener('resize', updatePendingSize, { passive: true });

    return () => {
      if (rafHandle !== 0) cancelAnimationFrame(rafHandle);
      ro.disconnect();
      window.removeEventListener('resize', updatePendingSize);
    };
  });
</script>

<canvas bind:this={canvas} class="block h-full w-full rounded-md"></canvas>
