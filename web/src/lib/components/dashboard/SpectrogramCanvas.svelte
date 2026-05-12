<script lang="ts">
  import { onMount } from 'svelte';
  import { streams } from '$lib/stores/streams.svelte';
  import { fftRadix2, hannWindow } from '$lib/audio/fft';

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
  // load.  512-point radix-2 FFT runs in ~50 µs / frame on V8.
  const COLUMN_RATE_HZ = 60;

  onMount(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    // Power-of-two fftSize is required by fftRadix2; bail silently in
    // production (fft.ts still throws in dev).
    if (!Number.isInteger(Math.log2(fftSize))) return;

    const sampleRate = streams.sampleRate;
    // Real FFT yields N/2 unique bins; cap to maxHz so the display
    // tracks speech band, not the full 0..24 kHz of a 48 kHz capture.
    const halfBins = fftSize >> 1;
    const useBins = Math.min(halfBins, Math.ceil((maxHz / (sampleRate / 2)) * halfBins));
    const historyColumns = Math.max(1, Math.ceil(seconds * COLUMN_RATE_HZ));

    // Pre-allocated working buffers; never reallocated inside the loop.
    const hann = hannWindow(fftSize);
    const pcmBuf = new Float32Array(fftSize);
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    // Smooth magnitudes (not dB) -- matches AnalyserNode's perceptual feel.
    const smoothedMag = new Float32Array(useBins);
    const cols = new Float32Array(historyColumns * useBins);
    let writeCol = 0;
    let colsWritten = 0;

    // Hann coherent gain is 0.5 so peak magnitude of a unity sinusoid is
    // N/4; scale by 1/(N/2) to land near 0 dB for unity input.
    const magScale = 1 / halfBins;

    let pixelW = 1;
    let pixelH = 1;
    let img: ImageData | null = null;
    // bin-per-y depends only on pixelH + useBins (rebuilt on resize).
    // col-base-per-x depends on writeCol/colsWritten/startCol so it's
    // rewritten each frame -- the buffer itself is sized at resize.
    let binByY: Int32Array = new Int32Array(0);
    let colBaseByX: Int32Array = new Int32Array(0);

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

    // ResizeObserver only records the new dimensions; the canvas reset
    // (which wipes the pixel buffer) is deferred to the next RAF so
    // reset + render happen in the same frame -- no blank flash while
    // dragging the window edge.
    const dpr = globalThis.devicePixelRatio || 1;
    let pendingW = Math.max(1, Math.floor(el.getBoundingClientRect().width * dpr));
    let pendingH = Math.max(1, Math.floor(el.getBoundingClientRect().height * dpr));
    let needsResize = true;

    const applyResizeIfNeeded = (): void => {
      if (!needsResize) return;
      if (el.width !== pendingW) el.width = pendingW;
      if (el.height !== pendingH) el.height = pendingH;
      pixelW = pendingW;
      pixelH = pendingH;
      if (img?.width !== pendingW || img.height !== pendingH) {
        img = ctx.createImageData(pendingW, pendingH);
      }
      if (binByY.length !== pixelH) {
        binByY = new Int32Array(pixelH);
        for (let y = 0; y < pixelH; y++) {
          binByY[y] = useBins - 1 - (((y / pixelH) * useBins) | 0);
        }
      }
      if (colBaseByX.length !== pixelW) colBaseByX = new Int32Array(pixelW);
      needsResize = false;
    };

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      pendingW = Math.max(1, Math.floor(r.width * dpr));
      pendingH = Math.max(1, Math.floor(r.height * dpr));
      needsResize = true;
    });
    ro.observe(el);

    const ingest = (): void => {
      const pcm = streams.snapshot(fftSize, pcmBuf);
      if (pcm.length < fftSize) return;
      // Windowed real input; imag zeroed in-place.
      for (let i = 0; i < fftSize; i++) {
        real[i] = pcm[i] * hann[i];
        imag[i] = 0;
      }
      fftRadix2(real, imag);
      const dest = writeCol * useBins;
      for (let k = 0; k < useBins; k++) {
        const mag = Math.hypot(real[k], imag[k]) * magScale;
        const sm = smoothing * smoothedMag[k] + (1 - smoothing) * mag;
        smoothedMag[k] = sm;
        cols[dest + k] = 20 * Math.log10(Math.max(1e-10, sm));
      }
      writeCol = (writeCol + 1) % historyColumns;
      if (colsWritten < historyColumns) colsWritten++;
    };

    const render = (): void => {
      if (!img) return;
      const data = img.data;
      if (colsWritten === 0) {
        data.fill(0);
        ctx.putImageData(img, 0, 0);
        return;
      }
      const startCol = (writeCol - colsWritten + historyColumns) % historyColumns;
      const span = maxDb - minDb;

      // colBase per x: depends on the scrolling-window's startCol so it
      // changes every frame.  Fill the pre-allocated table once outside
      // the y loop -- O(pixelW) instead of O(pixelW * pixelH).
      for (let x = 0; x < pixelW; x++) {
        const colOff = ((x / pixelW) * colsWritten) | 0;
        colBaseByX[x] = ((startCol + colOff) % historyColumns) * useBins;
      }

      // Row-major iteration matches the ImageData layout (contiguous
      // 4-byte writes per pixel along a row), so the CPU streams cache
      // lines instead of jumping `pixelW * 4` bytes between writes.
      // The palette LUT replaces the per-pixel `palette()` call and its
      // [r, g, b] allocation with two indexed reads.
      const scale = (PALETTE_N - 1) / span;
      for (let y = 0; y < pixelH; y++) {
        const bin = binByY[y];
        let i = y * pixelW * 4;
        for (let x = 0; x < pixelW; x++) {
          const db = cols[colBaseByX[x] + bin];
          let p = ((db - minDb) * scale) | 0;
          if (p < 0) p = 0;
          else if (p >= PALETTE_N) p = PALETTE_N - 1;
          p *= 3;
          data[i] = palette[p];
          data[i + 1] = palette[p + 1];
          data[i + 2] = palette[p + 2];
          data[i + 3] = 255;
          i += 4;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    let raf: number | null = null;
    const tick = (): void => {
      applyResizeIfNeeded();
      ingest();
      render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  });
</script>

<canvas bind:this={canvas} class="block h-full w-full rounded-md bg-zinc-950"></canvas>
