// Spectrogram intensity colormap.  Eight RGB stops, linearly
// interpolated.  Pure tonal grayscale at roughly even CIE L*
// steps (~12 per stop) so equal dB increments read as comparable
// density steps across the band.
//
// Inverted direction (silence is LIGHT, peak is DARK) -- the
// classical ink-on-paper / Sona-Graph / journal-figure idiom for
// light-mode spectrograms.  Dark = loud, the way ink on a page
// carries visual weight; silence dissolves into the surrounding
// canvas like blank paper.
//
// Why grayscale instead of the brand-blue tonal ramp we shipped
// previously: the dashboard puts the waveform (a blue line on
// `#fafafa`) directly above the spectrogram (also on `#fafafa`).
// A blue-tonal spectrogram visually rhymed with the waveform's
// blue line and the two surfaces blurred into one "blue stack."
// Pure grayscale gives the spectrogram its own visual identity
// as the DATA surface, and frees blue to mean INTERACTIVE
// exclusively -- waveform line, slider thumb, focus ring,
// selected card border, upload progress.  One hue per role:
// blue for "the operator can act on this," gray for "this is
// the signal."
//
// Two cross-surface invariants drive the endpoint choices:
//   * Floor `#fafafa` is pinned to the waveform's background
//     (Tailwind `bg-zinc-50`).  The live `SpectrogramCanvas`
//     uses the same class on its `<canvas>`, so silence on the
//     dashboard dissolves into the surrounding panel chrome AND
//     into the waveform's background sitting directly above it
//     -- the whole audio panel reads as one unified light field
//     with signal painted into it.  Slice cards sit on
//     `bg-zinc-100` placeholder + white card chrome; `#fafafa`
//     reads as a hair-light off-white inside that nest, which
//     demarcates the spectrogram thumbnail from its card without
//     a visible border.
//   * Peak is near-black (`#1d1d1d`, the L* ≈ 10 neutral that
//     matches the app's `text-zinc-900` ink density).  Reads as
//     "loud" on both surfaces -- bands stand out as dark ink
//     strokes against light paper, the same density convention
//     body text uses on the rest of the page.
//
// A single ramp is used on both surfaces; "peak on a slice card
// == peak on the dashboard" lets the operator move between
// curation and live capture without re-calibrating.

const SPECTROGRAM_STOPS: readonly (readonly [number, number, number])[] = [
  [250, 250, 250], // 0.000  #fafafa  floor — pinned to waveform/canvas bg
  [217, 217, 217], // 0.143  #d9d9d9  L*≈86  soft gray
  [181, 181, 181], // 0.286  #b5b5b5  L*≈73  light mid-gray
  [149, 149, 149], // 0.429  #959595  L*≈61  mid gray
  [117, 117, 117], // 0.571  #757575  L*≈48  mid-dark gray
  [86, 86, 86], //    0.714  #565656  L*≈35  dark gray
  [54, 54, 54], //    0.857  #363636  L*≈22  very dark gray
  [29, 29, 29] //     1.000  #1d1d1d  L*≈10  near-black (peak)
];

const LAST = SPECTROGRAM_STOPS.length - 1;

// Map `t` in [0, 1] to an [r, g, b] triple in [0, 255].  Out-of-
// range finite inputs are clamped; NaN propagates (the only callers
// — `buildSpectrogramLut` and `magnitudeToPaletteIndex` consumers —
// feed finite values, so a NaN guard would be dead weight).
export function spectrogramColor(t: number): [number, number, number] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const scaled = clamped * LAST;
  const i = Math.floor(scaled);
  const frac = scaled - i;
  const a = SPECTROGRAM_STOPS[i];
  // `Math.min` guards the t === 1 case where `i === LAST` and the
  // upper stop would otherwise read out of bounds.
  const b = SPECTROGRAM_STOPS[Math.min(LAST, i + 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac)
  ];
}

// Interleaved RGB lookup of `n` evenly-spaced spectrogram colours,
// shaped for direct `imageData.data` writes: 3·n bytes laid out as
// `[r₀, g₀, b₀, r₁, g₁, b₁, …]`.  Both the live `SpectrogramCanvas`
// and the per-slice `spectrogram.ts` renderer consume this single
// LUT — the cross-surface colour invariant lives here.
// `Uint8ClampedArray` mirrors `ImageData.data`, so writers skip the
// per-channel min/max guards.
export function buildSpectrogramLut(n: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(n * 3);
  // Guard the n === 1 case (degenerate single-entry palette) so
  // the divisor below stays positive.
  const denom = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) {
    const [r, g, b] = spectrogramColor(i / denom);
    const o = i * 3;
    lut[o] = r;
    lut[o + 1] = g;
    lut[o + 2] = b;
  }
  return lut;
}

// Default dB range.  With Hann-windowed FFT magnitudes normalised
// by FFT_SIZE/2, a full-scale sine peaks near -6 dB and the typical
// noise floor sits near -70 dB; [-80, 0] spreads the useful band
// (room tone through speech-bandwidth peaks) across roughly the
// middle 60% of the grayscale ramp, where each ~12-L* step
// remains comfortably above the eye's discrimination threshold.
// Both renderers MUST use the same range — overriding via Props
// is allowed only when both surfaces move together, otherwise
// the cross-surface colour invariant breaks.
export const SPECTROGRAM_DB_FLOOR = -80;
export const SPECTROGRAM_DB_CEILING = 0;

// Map a normalised FFT magnitude (|X[k]| already divided by
// FFT_SIZE/2) to an integer palette index in [0, paletteN).  Clamps
// so per-pixel callers can drop their own min/max guards.  The
// 1e-10 epsilon keeps log10 finite on silent DC bins; the result
// floors below `floor` and lands at index 0 (the light floor).
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
