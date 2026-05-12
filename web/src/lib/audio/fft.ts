// Real-input FFT for the live spectrogram.
//
// AnalyserNode is faster (native + SIMD) but its AudioContext starts
// suspended on cold load and only resumes after a user gesture; we'd
// have a black spectrogram until the operator clicked.  A 512-point
// radix-2 Cooley-Tukey runs in ~50 µs / frame on V8 -- well inside
// one frame's budget -- with no autoplay dependency.  The forward FFT
// operates in place on `(real, imag)`; callers pre-window the input
// and zero `imag` before each transform.

/** Compute the in-place radix-2 forward FFT on (real, imag).  Length must
 *  be a power of two; both buffers must be the same length. */
export function fftRadix2(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error(`fftRadix2: length must be a power of two, got ${n}`);
  }

  // Bit-reversal permutation -- reorders inputs so the iterative butterfly
  // stages below visit the right pairs at each level.
  for (let i = 1, j = 0; i < n; ++i) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }

  // Iterative Cooley-Tukey: log2(N) stages of N/2 butterflies each.  The
  // twiddle factor (wReal, wImag) is the principal len-th root of unity;
  // we advance it incrementally inside the inner loop to avoid per-step
  // trig calls.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wReal = Math.cos(ang);
    const wImag = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let rotR = 1;
      let rotI = 0;
      for (let k = 0; k < half; ++k) {
        const iK = i + k;
        const iKHalf = i + k + half;
        const aR = real[iK];
        const aI = imag[iK];
        const bR0 = real[iKHalf];
        const bI0 = imag[iKHalf];
        const bR = bR0 * rotR - bI0 * rotI;
        const bI = bR0 * rotI + bI0 * rotR;
        real[iK] = aR + bR;
        imag[iK] = aI + bI;
        real[iKHalf] = aR - bR;
        imag[iKHalf] = aI - bI;
        const nrotR = rotR * wReal - rotI * wImag;
        const nrotI = rotR * wImag + rotI * wReal;
        rotR = nrotR;
        rotI = nrotI;
      }
    }
  }
}

/** Build a Hann analysis window of length n.  Hann is the standard
 *  general-purpose choice for spectrogram displays: low spectral leakage,
 *  reasonable main-lobe width, no nulls to worry about.  We materialize
 *  it once so the inner loop only does a multiply per sample. */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  const denom = n - 1;
  for (let i = 0; i < n; ++i) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  }
  return w;
}
