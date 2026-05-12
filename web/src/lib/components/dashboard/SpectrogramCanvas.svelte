<script lang="ts">
  import { onMount } from 'svelte';
  import { streams } from '$lib/stores/streams.svelte';
  import { fftRadix2, hannWindow } from '$lib/audio/fft';
  import { nextVisualRenderAt, visualDevicePixelRatio } from './visualRuntime';

  interface Props {
    seconds?: number;
    minDb?: number;
    maxDb?: number;
    maxHz?: number;
    fftSize?: number;
    smoothing?: number;
  }
  let {
    seconds = 3,
    minDb = -90,
    maxDb = -10,
    maxHz = 12_000,
    fftSize = 512,
    smoothing = 0.6
  }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  // JS FFT on the PCM ring buffer -- no AudioContext, so the autoplay
  // gesture gate doesn't apply and the spectrogram is alive on cold
  // load.  A 512-point FFT + smoothing pass is small; catch-up is bounded
  // below so slow frames never replay an unbounded column backlog.
  const COLUMN_RATE_HZ = 60;
  const MAX_COLUMNS_PER_FRAME = 4;

  onMount(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';

    // Power-of-two fftSize is required by fftRadix2; bail silently in
    // production (fft.ts still throws in dev).
    if (!Number.isInteger(Math.log2(fftSize))) return;

    const sampleRate = streams.sampleRate;
    // Real FFT yields N/2 unique bins; cap to maxHz so the display
    // tracks speech band, not the full 0..24 kHz of a 48 kHz capture.
    const halfBins = fftSize >> 1;
    const useBins = Math.min(halfBins, Math.ceil((maxHz / (sampleRate / 2)) * halfBins));
    const historyColumns = Math.max(1, Math.ceil(seconds * COLUMN_RATE_HZ));
    const columnStepSamples = Math.max(1, Math.round(sampleRate / COLUMN_RATE_HZ));

    // Pre-allocated working buffers; never reallocated inside the loop.
    const hann = hannWindow(fftSize);
    const pcmBuf = new Float32Array(fftSize);
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    // Smooth magnitudes (not dB) -- matches AnalyserNode's perceptual feel.
    const smoothedMag = new Float32Array(useBins);
    let writeCol = 0;
    let lastColumnEndSample = 0;
    let initializedColumns = false;

    // Hann coherent gain is 0.5 so peak magnitude of a unity sinusoid is
    // N/4; scale by 1/(N/2) to land near 0 dB for unity input.
    const magScale = 1 / halfBins;

    let pixelW = 1;
    let pixelH = 1;
    // 256-entry viridis-ish RGB lookup, pre-computed once.  Replaces a
    // per-pixel function call + array allocation with two table reads.
    // Uint8ClampedArray clamps writes to 0..255 so the build code can
    // drop the per-channel Math.min/Math.max.
    const PALETTE_N = 256;
    const palette = new Uint8ClampedArray(PALETTE_N * 3);
    for (let i = 0; i < PALETTE_N; i++) {
      const t = i / (PALETTE_N - 1);
      const o = i * 3;
      palette[o] = 255 * (t * 3 - 1.4);
      palette[o + 1] = 255 * (t * 1.7);
      palette[o + 2] = 255 * (0.6 + (0.5 - t) * 1.4);
    }
    const emptyColor = `rgb(${palette[0]}, ${palette[1]}, ${palette[2]})`;

    // Native raster stage: one spectrogram column is one source-canvas pixel.
    // RAF rendering only scales/scrolls this tiny image via drawImage instead
    // of rebuilding a full DPR-sized ImageData buffer on the main thread.
    const raster =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(historyColumns, useBins)
        : document.createElement('canvas');
    raster.width = historyColumns;
    raster.height = useBins;
    const rasterCtx = raster.getContext('2d', { alpha: false });
    if (!rasterCtx) return;
    rasterCtx.imageSmoothingEnabled = false;
    const columnImage = rasterCtx.createImageData(1, useBins);
    const columnPixels = columnImage.data;

    const clearRaster = (): void => {
      rasterCtx.fillStyle = emptyColor;
      rasterCtx.fillRect(0, 0, historyColumns, useBins);
    };
    clearRaster();

    // ResizeObserver only records the new dimensions; the canvas reset
    // (which wipes the pixel buffer) is deferred to the next RAF so
    // reset + render happen in the same frame -- no blank flash while
    // dragging the window edge.
    let pendingW = 1;
    let pendingH = 1;
    let needsResize = true;

    const applyResizeIfNeeded = (): void => {
      if (!needsResize) return;
      if (el.width !== pendingW) el.width = pendingW;
      if (el.height !== pendingH) el.height = pendingH;
      pixelW = pendingW;
      pixelH = pendingH;
      needsResize = false;
    };

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

    const ingestAt = (endSample: number): void => {
      const pcm = streams.snapshotAt(endSample, fftSize, pcmBuf);
      // Windowed real input; imag zeroed in-place.
      for (let i = 0; i < fftSize; i++) {
        real[i] = pcm[i] * hann[i];
        imag[i] = 0;
      }
      fftRadix2(real, imag);
      for (let k = 0; k < useBins; k++) {
        const mag = Math.hypot(real[k], imag[k]) * magScale;
        const sm = smoothing * smoothedMag[k] + (1 - smoothing) * mag;
        smoothedMag[k] = sm;
        const db = 20 * Math.log10(Math.max(1e-10, sm));
        let p = (((db - minDb) * (PALETTE_N - 1)) / (maxDb - minDb)) | 0;
        if (p < 0) p = 0;
        else if (p >= PALETTE_N) p = PALETTE_N - 1;
        const src = p * 3;
        const y = useBins - 1 - k;
        const dst = y * 4;
        columnPixels[dst] = palette[src];
        columnPixels[dst + 1] = palette[src + 1];
        columnPixels[dst + 2] = palette[src + 2];
        columnPixels[dst + 3] = 255;
      }
      rasterCtx.putImageData(columnImage, writeCol, 0);
      writeCol = (writeCol + 1) % historyColumns;
    };

    const ingestUntil = (endSample: number): void => {
      if (endSample < fftSize) return;
      if (!initializedColumns) {
        lastColumnEndSample = endSample - columnStepSamples;
        initializedColumns = true;
      }

      // If the tab was throttled or the stream reconnected, rebuild from a
      // recent edge instead of burning time replaying thousands of stale
      // columns.  This keeps the spectrogram locked to the same render cursor
      // as the waveform after visibility or network stalls.
      const backlogColumns = Math.floor((endSample - lastColumnEndSample) / columnStepSamples);
      if (backlogColumns > historyColumns) {
        clearRaster();
        // Discontinuity: drop stale color history and EMA state together.
        smoothedMag.fill(0);
        writeCol = 0;
        lastColumnEndSample = endSample - columnStepSamples;
      } else if (backlogColumns > MAX_COLUMNS_PER_FRAME) {
        lastColumnEndSample = endSample - MAX_COLUMNS_PER_FRAME * columnStepSamples;
      }

      let guard = 0;
      while (
        lastColumnEndSample + columnStepSamples <= endSample &&
        guard < MAX_COLUMNS_PER_FRAME
      ) {
        lastColumnEndSample += columnStepSamples;
        ingestAt(lastColumnEndSample);
        guard++;
      }
    };

    const render = (endSample: number): void => {
      ctx.fillStyle = emptyColor;
      ctx.fillRect(0, 0, pixelW, pixelH);
      if (!initializedColumns) return;

      const columnW = pixelW / historyColumns;
      const phase = Math.max(0, Math.min(1, (endSample - lastColumnEndSample) / columnStepSamples));
      let dx = -phase * columnW;
      const firstCount = historyColumns - writeCol;
      const rasterSource = raster as CanvasImageSource;

      if (firstCount > 0) {
        const dw = firstCount * columnW;
        ctx.drawImage(rasterSource, writeCol, 0, firstCount, useBins, dx, 0, dw, pixelH);
        dx += dw;
      }
      if (writeCol > 0) {
        const dw = writeCol * columnW;
        ctx.drawImage(rasterSource, 0, 0, writeCol, useBins, dx, 0, dw, pixelH);
      }

      // Fill the sub-column future gap with the latest known column so the
      // whole image scrolls smoothly between FFT hops without flashing a blank
      // strip on the right edge.
      const gap = phase * columnW;
      if (gap > 0.01) {
        const latestCol = (writeCol + historyColumns - 1) % historyColumns;
        ctx.drawImage(rasterSource, latestCol, 0, 1, useBins, pixelW - gap, 0, gap, pixelH);
      }
    };

    let raf: number | null = null;
    let lastRenderAt = Number.NEGATIVE_INFINITY;
    const tick = (now: DOMHighResTimeStamp): void => {
      const renderAt = nextVisualRenderAt(now, lastRenderAt);
      if (renderAt === null) {
        raf = requestAnimationFrame(tick);
        return;
      }
      lastRenderAt = renderAt;

      applyResizeIfNeeded();
      const endSample = streams.renderCursor(streams.renderLatencyMs, now);
      ingestUntil(endSample);
      render(endSample);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', updatePendingSize);
    };
  });
</script>

<canvas bind:this={canvas} class="block h-full w-full rounded-md bg-zinc-950"></canvas>
