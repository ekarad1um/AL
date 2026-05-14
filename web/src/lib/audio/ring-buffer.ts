// Bounded ring-buffer helpers for the streams + recorder PCM
// pipelines.  Both surfaces use the same shape: a Float32Array
// `ring` of fixed capacity, a `writeIdx` cursor mod-N, and a
// monotonic `totalWritten` counter.  Extracted so both stores
// share one implementation -- changing the wrap logic in one
// place keeps them in lock-step.

// Append `frame` to `ring` starting at `writeIdx`, wrapping at
// the ring boundary.  Returns the next write index.  No-op when
// the ring is empty or the frame is empty.  Callers also bump
// their own `totalWritten` by `frame.length`.
export function pushToRing(ring: Float32Array, writeIdx: number, frame: Float32Array): number {
  const r = ring.length;
  if (r === 0) return writeIdx;
  const n = frame.length;
  if (n === 0) return writeIdx;
  const space = r - writeIdx;
  if (n <= space) {
    ring.set(frame, writeIdx);
  } else {
    ring.set(frame.subarray(0, space), writeIdx);
    ring.set(frame.subarray(space), 0);
  }
  return (writeIdx + n) % r;
}

// Fill caller-owned `lo` / `hi` buffers with the min / max sample
// value within each of `bins` equal-width slots covering
// `[endSample - samples, endSample)`.  Out-of-range bins (before
// the oldest available sample) read as 0 so the renderer paints
// a flat baseline.  Allocation-free in the hot path -- the
// caller reuses `lo` / `hi` across RAFs.
export function envelopeFromRing(
  ring: Float32Array,
  totalWritten: number,
  endSample: number,
  samples: number,
  bins: number,
  lo: Float32Array,
  hi: Float32Array
): void {
  const n = Math.min(bins, lo.length, hi.length);
  if (n <= 0) return;
  lo.fill(0, 0, n);
  hi.fill(0, 0, n);

  if (totalWritten === 0 || samples <= 0) return;
  const r = ring.length;
  if (r === 0) return;
  const oldestAvailable = Math.max(0, totalWritten - r);
  const clampedEnd = Math.max(oldestAvailable, Math.min(Math.floor(endSample), totalWritten));
  const requestedStart = clampedEnd - samples;
  const samplesPerBin = samples / n;

  for (let x = 0; x < n; x++) {
    const rawStart = Math.floor(requestedStart + x * samplesPerBin);
    const rawEnd = Math.floor(requestedStart + (x + 1) * samplesPerBin);
    const start = Math.max(rawStart, oldestAvailable);
    const stop = Math.min(rawEnd, clampedEnd);
    if (stop <= start) continue;

    let min = 0;
    let max = 0;
    for (let p = start; p < stop; p++) {
      const v = ring[p % r];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    lo[x] = min;
    hi[x] = max;
  }
}
