import { UploadPool } from '$lib/api/upload';
import { fftRadix2, hannWindow } from './fft';
import { buildSpectrogramLut, magnitudeToPaletteIndex } from './palette';
import { decodeCanonicalWavSync } from './wav-decode';
import { getSliceBlob } from './slice-fetch';
import { getSpectrogramRecord, putSpectrogramRecord } from '$lib/idb/spectrograms';
import type { SliceRecord } from '$lib/idb/db';

// Slice-card spectrogram pipeline.
//
// Each canonical slice is 44 100 samples (1 s @ 44.1 kHz).  We
// compute a Hann-windowed STFT (FFT 512, hop 256) → log-magnitude
// → colormapped image and stash the PNG bytes both in IDB
// (persistent across tab sessions, keyed by the slice's sha256)
// and in a short-lived module-scope `blob: URL` cache (one entry
// per content hash).
//
// Content-addressed cache:
//   The slice id is the sha256 of its WAV bytes (see
//   [audio/sha256.ts]).  The spectrogram is a deterministic
//   function of those bytes, so an IDB row keyed by sha256 is
//   valid forever for a given hash -- two slices in different
//   categories (or workspaces) with byte-identical content
//   share one cached PNG.  No invalidation logic is needed:
//   different content produces a different filename, which
//   produces a different sha, which produces a fresh cache
//   row.
//
// No proactive eviction:
//   Operator-driven slice delete does NOT evict the spectrogram
//   row.  Another slice anywhere in the IDB may still
//   reference the same content; reasoning about "is this the
//   last reference" per delete would need a cross-store join.
//   The cache grows linearly with unique content hashes seen
//   in a session (~3-4 KB / hash; ~1 MB for thousand-slice
//   workspaces) -- well below origin quota, and below the
//   browser's blob: URL limits (Chrome ~10 k, Safari ~1 k).
//   `resetDB` is the single reset point.

const FFT_SIZE = 512;
const HOP_SIZE = 256;
const FREQ_BINS = FFT_SIZE / 2 + 1;

const CARD_WIDTH = 96;
const CARD_HEIGHT = 64;

const MAX_CONCURRENT_SPECTROGRAMS = 3;
const generatePool = new UploadPool(MAX_CONCURRENT_SPECTROGRAMS);

const HANN_512 = hannWindow(FFT_SIZE);
const PALETTE_N = 256;
const PALETTE = buildSpectrogramLut(PALETTE_N);

// In-memory `blob: URL` cache, keyed by sha256.  Survives the
// tab's lifetime; the underlying PNG bytes survive across tab
// sessions via IDB.  Dedup of concurrent renders via
// `inflight`.
const urlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export async function getSliceSpectrogramUrl(slice: SliceRecord): Promise<string> {
  const sha = slice.id;
  const memUrl = urlCache.get(sha);
  if (memUrl !== undefined) return memUrl;
  const pending = inflight.get(sha);
  if (pending) return pending;

  const work = (async (): Promise<string> => {
    try {
      // Persistent-cache hit?  Read IDB; if present, wrap the
      // PNG in a fresh blob URL.  No etag check -- the cache is
      // valid by content addressing.
      const cached = await getSpectrogramRecord(sha).catch(() => undefined);
      const png = cached?.png ?? (await generatePool.submit(() => generatePng(slice)));
      if (!cached) {
        // Best-effort persist; failures (origin quota) just
        // mean the next session re-renders.
        await putSpectrogramRecord({
          sha256: sha,
          png,
          created_at: new Date().toISOString()
        }).catch(() => undefined);
      }
      const url = URL.createObjectURL(png);
      urlCache.set(sha, url);
      return url;
    } finally {
      inflight.delete(sha);
    }
  })();
  inflight.set(sha, work);
  return work;
}

async function generatePng(slice: SliceRecord): Promise<Blob> {
  const sourceBlob = await getSliceBlob(slice);
  const buf = await sourceBlob.arrayBuffer();
  const { pcm } = decodeCanonicalWavSync(buf);

  const frames = Math.max(1, Math.floor((pcm.length - FFT_SIZE) / HOP_SIZE) + 1);
  const magnitudes = new Float32Array(frames * FREQ_BINS);

  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const normalise = FFT_SIZE / 2;

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

  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is unavailable in this browser.');
  }
  const canvas = new OffscreenCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Failed to acquire OffscreenCanvas 2D context.');

  const imageData = ctx.createImageData(CARD_WIDTH, CARD_HEIGHT);
  const pixels = imageData.data;

  for (let y = 0; y < CARD_HEIGHT; y++) {
    const freqIdx = Math.min(
      FREQ_BINS - 1,
      Math.floor((1 - y / (CARD_HEIGHT - 1)) * (FREQ_BINS - 1))
    );
    for (let x = 0; x < CARD_WIDTH; x++) {
      const frameIdx = Math.min(frames - 1, Math.floor((x / CARD_WIDTH) * frames));
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
  return canvas.convertToBlob({ type: 'image/png' });
}
