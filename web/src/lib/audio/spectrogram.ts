import { UploadPool } from '$lib/api/upload';
import { fftRadix2, hannWindow } from './fft';
import { buildPlasmaLut, magnitudeToPaletteIndex } from './palette';
import { decodeCanonicalWavSync } from './wav-decode';
import { getSliceBlob } from './slice-fetch';
import type { SliceRecord } from '$lib/idb/db';

// Slice-card spectrogram pipeline.
//
// Each canonical slice is 44 100 samples (1 s @ 44.1 kHz).  We
// compute a Hann-windowed STFT (FFT 512, hop 256) → log-magnitude
// → plasma-colormapped image and stash the PNG bytes as a blob URL
// keyed by slice id.  The blob URL is what `SliceCard.svelte`
// drops into its `<img>` src.
//
// Why the FFT lives in JS and not the daemon:
//   1. The slices are local-IDB-only in B.4-B.5; there's no server
//      surface for the daemon to render against.
//   2. The thumbnail is decoration; an operator never needs
//      sample-accurate spectral analysis from this surface.
//   3. The browser's `AnalyserNode` (used by the dashboard) is
//      real-time-stream-oriented; for an offline render of a
//      one-shot 1 s clip a plain radix-2 FFT (already shipped in
//      [fft.ts](./fft.ts)) is the simpler tool.
//
// Why the cache lives at module scope (not in a store):
//   The cache survives component unmount / remount within one
//   tab.  When the operator collapses a category then re-expands
//   it, the SliceCards remount and rerequest URLs -- a per-store
//   cache would have to coordinate with both stores' lifecycle.
//   Module scope is simpler and exactly matches what an operator
//   tab session is: one cache per page.

const FFT_SIZE = 512;
const HOP_SIZE = 256;
const FREQ_BINS = FFT_SIZE / 2 + 1; // 257 -- DC through Nyquist inclusive.

// Card visible size at desktop (px); spectrogram renders into this
// exact pixel grid so the `<img>` tag doesn't pay for in-browser
// upscaling.  Matches the grid template in `SlicePane.svelte`.
const CARD_WIDTH = 96;
const CARD_HEIGHT = 64;

// Bounded-concurrency cap on simultaneous spectrogram renders.
// Each render runs three synchronous main-thread blocks --
// WAV decode (44 100 sample Int16 → Float32 loop), 171-frame
// radix-2 FFT, and a 6144-pixel palette walk -- adding up to
// ~10-25 ms per slice on a modern laptop.  Without a cap, a
// cold expand of an N-slice category fires N renders in
// parallel; their synchronous blocks then run back-to-back in
// the microtask queue and starve RAF for ~N × 15 ms, visibly
// dropping frames on the dashboard's live waveform + Top-K
// surfaces (which share the same main thread).  Capping at 3
// keeps the worst-case main-thread block per macrotask to
// ~3 × 15 ms ≈ 45 ms, which lets a 60 Hz RAF tick land
// between batches.
//
// 3 matches `MAX_CONCURRENT_INDEX_FETCHES` in
// [stores/slices.svelte.ts] and the upload pool's cap -- same
// reasoning (one operator per device + we want the work spread
// over time, not bunched).  The slice-bytes fetch pool runs at
// 6 because its work is network-bound + browser-parallelised;
// this CPU-bound pool stays tighter on purpose.
const MAX_CONCURRENT_SPECTROGRAMS = 3;
const generatePool = new UploadPool(MAX_CONCURRENT_SPECTROGRAMS);

// Precomputed Hann window.  Lives at module scope so the cost is
// paid exactly once per tab, not once per spectrogram.  dB range
// is sourced from [palette.ts](./palette.ts)'s
// `SPECTROGRAM_DB_FLOOR` / `SPECTROGRAM_DB_CEILING` exports via
// `magnitudeToPaletteIndex`, shared with the dashboard's live
// `SpectrogramCanvas`.
const HANN_512 = hannWindow(FFT_SIZE);

// 256-entry plasma LUT shared with the dashboard's live
// `SpectrogramCanvas`.  Both surfaces sample the same colour ramp,
// so a 4 kHz energy peak that reads as a bright-yellow band on a
// slice card reads as a bright-yellow band on the dashboard's
// live spectrogram too -- the operator's eye picks up the
// correspondence without having to re-calibrate between surfaces.
// 256 entries is enough resolution at 96×64 (the eye can't tell
// a 256-step LUT from a continuous gradient at thumbnail scale).
const PALETTE_N = 256;
const PALETTE = buildPlasmaLut(PALETTE_N);

// Cache of blob: URLs keyed by slice id.  We dedup concurrent
// generation via the `inflight` map so two simultaneous renders
// (e.g. two re-mounted SliceCards firing $effect at the same RAF)
// share one decode.
//
// Race-safety against `revokeSliceSpectrograms` mid-render uses
// the same per-id owner-token pattern as `slice-fetch.ts`: the
// post-await cache write only happens when the id's token still
// matches the one this `generate` call allocated.  See the
// `inflightTokens` discussion in [slice-fetch.ts] for the full
// rationale -- the design is identical here, with the extra
// detail that the discarded artefact is a `blob:` URL rather
// than a raw `Blob`, and `blob:` URLs require an explicit
// `URL.revokeObjectURL` to release the underlying object (JS
// GC alone won't free it).  So the "token mismatch" branch
// revokes the URL synchronously before it can leak.
const urlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const inflightTokens = new Map<string, symbol>();

export async function getSliceSpectrogramUrl(slice: SliceRecord): Promise<string> {
  const cached = urlCache.get(slice.id);
  if (cached) return cached;
  const pending = inflight.get(slice.id);
  if (pending) return pending;
  // Allocate the owner token BEFORE the IIFE so the closure
  // captures a fully-initialised binding (sidesteps the
  // "used-before-assigned" TDZ shape that would land if we
  // tried to compare against the `work` promise directly).
  const token = Symbol();
  inflightTokens.set(slice.id, token);
  const work = (async (): Promise<string> => {
    let url: string | null = null;
    try {
      // Route the actual render through `generatePool` so a cold
      // expand of an N-slice category fires at most
      // `MAX_CONCURRENT_SPECTROGRAMS` synchronous WAV-decode +
      // FFT + pixel-render bursts before yielding.  The pool's
      // `submit` resolves with the task's value, so the
      // cache-write + token-check semantics below stay
      // unchanged.  Cache hits earlier in `getSliceSpectrogramUrl`
      // (`urlCache.get(...)` / `inflight.get(...)`) still
      // short-circuit before reaching the pool, so a cold
      // expand of a previously-visited category re-resolves
      // every URL instantly without burning pool slots.
      url = await generatePool.submit(() => generate(slice));
      if (inflightTokens.get(slice.id) === token) {
        urlCache.set(slice.id, url);
      } else {
        // Revoked (or replaced by a successor) while `generate`
        // was running.  Skip the cache write AND revoke the URL
        // synchronously so the underlying canvas blob is
        // released -- a `blob:` URL is not eligible for plain GC.
        // The awaiter still receives the URL (we return it
        // below); SliceCard's `$effect` carries a `cancelled`
        // flag that no-ops the `<img src>` assignment in the
        // typical case, but if the assignment lands first there
        // is at most a single frame of "broken image" chrome
        // before SliceCard's unmount removes the `<img>`.
        URL.revokeObjectURL(url);
      }
      return url;
    } finally {
      if (inflightTokens.get(slice.id) === token) {
        inflight.delete(slice.id);
        inflightTokens.delete(slice.id);
      }
    }
  })();
  inflight.set(slice.id, work);
  return work;
}

// Revoke + drop cache entries for the given slice ids.  Called by
// the slices store on per-row delete + bulk clear paths so the
// browser can release the underlying canvas blobs.  Iterable
// rather than array so callers can pass a `Set` / `Map.keys()`
// directly.
//
// Clearing the token map is load-bearing for the identity check
// in `getSliceSpectrogramUrl`: a `generate` that resolves after
// this delete sees `inflightTokens.get(id) !== token`, skips the
// cache write, and revokes the URL it produced.  Without it, a
// render that started just before the revoke would silently
// rebuild the cache for a deleted slice AND register a fresh
// `blob:` URL that nothing ever revokes -- a permanent
// per-leaked-slice ~3-4 KB hold of the PNG bytes.
export function revokeSliceSpectrograms(sliceIds: Iterable<string>): void {
  for (const id of sliceIds) {
    const url = urlCache.get(id);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      urlCache.delete(id);
    }
    inflight.delete(id);
    inflightTokens.delete(id);
  }
}

async function generate(slice: SliceRecord): Promise<string> {
  // Decode the canonical WAV (44-byte skip + Int16 → Float32 loop)
  // -- cheaper than `AudioContext.decodeAudioData` and preserves
  // the slice's exact 44 100 sample count.  `getSliceBlob`
  // resolves either to the local Blob (freshly produced) or to a
  // lazy fetch through the daemon's `GET /assets/datasets/<class>/
  // <filename>` for committed-but-blob-less slices (uploads have
  // dropped the blob from IDB, or the record was synthesised by
  // category sync from a server listing).
  const sourceBlob = await getSliceBlob(slice);
  const buf = await sourceBlob.arrayBuffer();
  const { pcm } = decodeCanonicalWavSync(buf);

  // Number of complete frames that fit into the slice's PCM.
  // The slice is fixed-length (44 100 samples) so `frames` is a
  // constant 171 in steady state -- floor((44100 - 512) / 256) + 1.
  // Computing it from `pcm.length` is defensive for slices that
  // aren't canonical-length yet (e.g. a future partial-upload retry).
  const frames = Math.max(1, Math.floor((pcm.length - FFT_SIZE) / HOP_SIZE) + 1);
  const magnitudes = new Float32Array(frames * FREQ_BINS);

  // Scratch buffers reused across frames.  `imag` re-zeroes every
  // iteration; `real` gets overwritten.
  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);

  // Normalisation factor for the windowed FFT.  Hann coherent
  // gain ≈ 0.5; dividing by FFT_SIZE/2 puts a full-scale sine
  // peak at ≈ -6 dB, which matches the DB_FLOOR/DB_CEILING range
  // chosen above.
  const normalise = FFT_SIZE / 2;

  // Magnitudes are stored linear (not dB) so the second-pass pixel
  // walk routes them straight through the shared
  // `magnitudeToPaletteIndex` helper without a redundant log10
  // round-trip.  Storing pre-log values also lets the helper own
  // the dB-range mapping, keeping the dashboard's live renderer
  // and this offline path on one source of truth.
  for (let f = 0; f < frames; f++) {
    const start = f * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = pcm[start + i] * HANN_512[i];
      imag[i] = 0;
    }
    fftRadix2(real, imag);
    for (let k = 0; k < FREQ_BINS; k++) {
      const re = real[k];
      const im = imag[k];
      magnitudes[f * FREQ_BINS + k] = Math.sqrt(re * re + im * im) / normalise;
    }
  }

  // Render to an `OffscreenCanvas`.  Available in Chrome / Edge /
  // Firefox always, and Safari 16.4+ -- the same browser baseline
  // we already require for `AudioWorklet`.  An older Safari falls
  // back to the spectrogram-less card (the catch surfaces `null`
  // up the chain; SliceCard renders the neutral placeholder).
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is unavailable in this browser.');
  }
  const canvas = new OffscreenCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Failed to acquire OffscreenCanvas 2D context.');

  const imageData = ctx.createImageData(CARD_WIDTH, CARD_HEIGHT);
  const pixels = imageData.data;

  // Map each canvas pixel to one (time, freq) cell.  Nearest-
  // neighbour sampling is intentionally cheap -- at thumbnail
  // resolution the operator can't tell smoothed-bilinear from
  // nearest, and the pass runs hot (6 144 pixels × spectrogram
  // size).  Layout: x → time (oldest left), y → frequency (low
  // at bottom).
  for (let y = 0; y < CARD_HEIGHT; y++) {
    // Flip y so y=0 is high freq (top) and y=CARD_HEIGHT-1 is
    // low freq (bottom).  This is the spectrogram convention
    // the dashboard already uses.
    const freqIdx = Math.min(
      FREQ_BINS - 1,
      Math.floor((1 - y / (CARD_HEIGHT - 1)) * (FREQ_BINS - 1))
    );
    for (let x = 0; x < CARD_WIDTH; x++) {
      const frameIdx = Math.min(frames - 1, Math.floor((x / CARD_WIDTH) * frames));
      // Shared helper -- identical mapping is what guarantees a
      // 4 kHz energy peak that reads as bright yellow on a slice
      // card reads as bright yellow on the live dashboard too.
      const pi = magnitudeToPaletteIndex(magnitudes[frameIdx * FREQ_BINS + freqIdx], PALETTE_N);
      const src = pi * 3;
      const p = (y * CARD_WIDTH + x) * 4;
      pixels[p] = PALETTE[src];
      pixels[p + 1] = PALETTE[src + 1];
      pixels[p + 2] = PALETTE[src + 2];
      pixels[p + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  // PNG keeps the colormap discrete; JPEG would soft-blur the
  // narrow plasma bands.  PNG @ 96×64 is ~3-4 KB; 100 slices = ~400 KB
  // of cached image bytes per workspace.  Tolerable.
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return URL.createObjectURL(blob);
}
