<script lang="ts">
  import { onMount } from 'svelte';
  import { streams } from '$lib/stores/streams.svelte';
  import { nextVisualRenderAt, visualDevicePixelRatio } from './visualRuntime';

  interface Props {
    seconds?: number;
    color?: string;
    background?: string;
  }
  // zinc-50 background: nested-data tier matching the Active Head card,
  // one step below the white panel.
  let { seconds = 3, color = '#3b82f6', background = '#fafafa' }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let raf: number | null = null;

  onMount(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) return;

    let hiBuf: Float32Array = new Float32Array(0);
    let loBuf: Float32Array = new Float32Array(0);
    const windowSamples = streams.sampleRate * seconds;

    // ResizeObserver only records the new dimensions; the canvas reset
    // (which wipes the pixel buffer) is deferred to the next RAF so
    // reset + render happen in the same frame -- no blank flash while
    // dragging the window edge.
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

    let lastRenderAt = Number.NEGATIVE_INFINITY;
    const draw = (now: DOMHighResTimeStamp) => {
      const renderAt = nextVisualRenderAt(now, lastRenderAt);
      if (renderAt === null) {
        raf = requestAnimationFrame(draw);
        return;
      }
      lastRenderAt = renderAt;

      if (needsResize) {
        if (el.width !== pendingW) el.width = pendingW;
        if (el.height !== pendingH) el.height = pendingH;
        if (hiBuf.length !== pendingW) {
          hiBuf = new Float32Array(pendingW);
          loBuf = new Float32Array(pendingW);
        }
        needsResize = false;
      }
      const w = el.width;
      const h = el.height;
      const mid = h / 2;
      const amp = mid * 0.92;

      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = gridStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();

      const endSample = streams.renderCursor(streams.renderLatencyMs, now);
      streams.envelopeAt(endSample, windowSamples, w, loBuf, hiBuf);

      // Filled envelope (translucent).
      ctx.fillStyle = fillRgba;
      ctx.beginPath();
      ctx.moveTo(0, mid - hiBuf[0] * amp);
      for (let x = 1; x < w; x++) ctx.lineTo(x, mid - hiBuf[x] * amp);
      for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, mid - loBuf[x] * amp);
      ctx.closePath();
      ctx.fill();

      // Top and bottom contour lines.
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

  function hexToRgba(hex: string, alpha: number): string {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
</script>

<canvas bind:this={canvas} class="block h-full w-full rounded-md"></canvas>
