// Plasma colormap for spectrogram intensity.  Eight RGB stops
// digitised from matplotlib's `plasma` colormap; linear
// interpolation between adjacent stops yields a smooth gradient
// from deep purple (low energy) → magenta → orange → bright yellow
// (high energy).
//
// Why plasma, not viridis / inferno / etc.?  Plasma's high-energy
// end is yellow rather than white, which keeps peak energies
// readable on the white card background that surrounds each
// slice thumbnail.  Viridis-style ends would visually blend into
// the page chrome.
//
// We don't load a third-party colormap library.  Eight stops is
// enough resolution for a 96×64 thumbnail (the eye can't tell
// the difference between this 7-step interpolation and a full
// LUT at thumbnail scale), and the inline data avoids a build-time
// dependency for a hundred bytes of constants.

const PLASMA_STOPS: readonly (readonly [number, number, number])[] = [
  [13, 8, 135], // 0.000  #0d0887  deep indigo
  [71, 3, 159], // 0.143  #47039f
  [114, 1, 168], // 0.286  #7201a8
  [156, 23, 158], // 0.429  #9c179e
  [197, 67, 131], // 0.571  #c54583
  [230, 124, 93], // 0.714  #e67c5d
  [248, 189, 38], // 0.857  #f8bd26
  [240, 249, 33] // 1.000  #f0f921  bright yellow
];

const LAST = PLASMA_STOPS.length - 1;

// Map `t` in [0, 1] to an [r, g, b] triple in [0, 255].  Out-of-
// range inputs are clamped (NaN clamps to 0 via the comparison
// short-circuit).
export function plasmaColor(t: number): [number, number, number] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const scaled = clamped * LAST;
  const i = Math.floor(scaled);
  const frac = scaled - i;
  const a = PLASMA_STOPS[i];
  // `Math.min` guards the t === 1 case where `i === LAST` and the
  // upper stop would otherwise read out of bounds.
  const b = PLASMA_STOPS[Math.min(LAST, i + 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac)
  ];
}

// Interleaved RGB lookup of `n` evenly-spaced plasma colours,
// shaped for direct `imageData.data` writes.  Layout: 3 × n bytes,
// `[r₀, g₀, b₀, r₁, g₁, b₁, …]`.  The dashboard's live
// `SpectrogramCanvas` and the per-slice `spectrogram.ts` renderer
// both consume this -- using one LUT instead of two ad-hoc
// approximations keeps the two surfaces colour-identical, so a
// frequency band that reads as bright yellow on a slice card
// reads as bright yellow on the live spectrogram too.
//
// `Uint8ClampedArray` is the right return type: the consumer
// builds an `ImageData` whose `.data` is already a clamped array,
// so copy / write paths can drop per-channel min/max guards.
export function buildPlasmaLut(n: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(n * 3);
  // Guard the n === 1 case (degenerate single-entry palette) so
  // the divisor below stays positive.
  const denom = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) {
    const [r, g, b] = plasmaColor(i / denom);
    const o = i * 3;
    lut[o] = r;
    lut[o + 1] = g;
    lut[o + 2] = b;
  }
  return lut;
}

// Default dB range for spectrogram coloring.  Hann-windowed FFT
// with magnitude normalised by FFT_SIZE/2 puts a full-scale sine
// peak at ≈ -6 dB and a typical clean noise floor near -70 dB;
// mapping [-80, 0] to the full plasma stack lands the operator's
// useful dynamic range in the middle of the visible gamut.  The
// dashboard's live `SpectrogramCanvas` and the offline slice-card
// renderer both share these defaults so a 4 kHz band that reads
// as orange on a slice card reads as orange on the live dashboard
// too.  Callers may override (the SpectrogramCanvas exposes them
// as Props) but the SAME range MUST be used across both surfaces
// to preserve cross-surface colour parity.
export const SPECTROGRAM_DB_FLOOR = -80;
export const SPECTROGRAM_DB_CEILING = 0;

// Map a normalised FFT magnitude to an integer plasma palette
// index in [0, paletteN).  `magnitude` is the absolute |X[k]|
// already divided by FFT_SIZE/2 (so a full-scale Hann-windowed
// sine peaks near 0.5 ≈ -6 dB).  Clamps to the palette bounds so
// callers can drop per-pixel min/max guards.
//
// 1e-10 keeps log10 finite on exactly-zero magnitudes (silent DC
// bin); at -200 dB the result floors below `floor` and renders as
// the deepest plasma indigo.
export function magnitudeToPaletteIndex(
  magnitude: number,
  paletteN: number,
  floor: number = SPECTROGRAM_DB_FLOOR,
  ceiling: number = SPECTROGRAM_DB_CEILING
): number {
  const db = 20 * Math.log10(magnitude < 1e-10 ? 1e-10 : magnitude);
  // The `| 0` of the original inlined code coerced through Int32,
  // which truncates toward zero.  Math.floor is the same for non-
  // negative inputs and well-defined for negatives, so we keep the
  // semantics symmetric whether the caller clamps before or after.
  let idx = Math.floor(((db - floor) * (paletteN - 1)) / (ceiling - floor));
  if (idx < 0) idx = 0;
  else if (idx >= paletteN) idx = paletteN - 1;
  return idx;
}
