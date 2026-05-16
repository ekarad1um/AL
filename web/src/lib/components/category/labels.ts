// Category label utilities.  Single source of truth for
// transforming an AssetPath-form category id into the operator-
// facing display label.  Both the dataset accordion and the
// dashboard's top-K meter route through `prettyCategoryName` so the
// same `_background_noise_` row reads identically on both surfaces.
//
// AssetPath form (wire / disk identifier): the AssetPath component
// shape (`[A-Za-z0-9._-]`, ≤ 255 bytes, no leading `.`, no leading
// `_` for operator-typed names — see `name-validate.ts`).  This is
// what the daemon stores as a directory under
// `<workspace>/datasets/<class>/`.
//
// Display form: UPPERCASE with underscores / hyphens treated as
// word separators.  The mandatory `_background_noise_` synthetic
// renders as "BACKGROUND NOISE"; a user-typed `cat` renders as
// "CAT"; `my-class_42` renders as "MY CLASS 42".  All-caps reads
// as a label (banner / chip), not a shell identifier, and gives
// the chip + drop-down + meter row a consistent visual weight on
// either surface regardless of the on-disk casing.

export const MANDATORY_BACKGROUND_NOISE = '_background_noise_';
export const MANDATORY_DISPLAY = 'BACKGROUND NOISE';

// Per-category slice-count threshold for "training-ready".
// `_background_noise_` is held to a higher bar (20 vs 10) because
// it carries the negative-class burden in the speech-commands-style
// classifier -- the trainer needs more examples of "what isn't
// any of the target classes" than of any one target class.
export const THRESHOLD_BACKGROUND_NOISE = 20;
export const THRESHOLD_STANDARD = 10;

// Per-category cumulative slice cap.  Bounds how many slices a
// single class can accumulate, mirroring the workspace list's
// `MAX_WORKSPACES = 16` cap on a different surface.  The number is
// a UI guideline -- the daemon has no equivalent ceiling -- chosen
// to:
//   - sit ~10x above the `_background_noise_` 20-slice training
//     threshold and ~20x above the 10-slice standard, so an
//     operator who's working toward "training-ready" never hits
//     the cap;
//   - bound origin-quota growth.  Each slice carries an ~88 KB
//     WAV blob in IDB plus a 96x64 spectrogram blob URL;
//     at 200 slices a class is ~18 MB which is meaningful but not
//     pathological;
//   - signal "this is past diminishing returns".  More data is
//     usually better, but training a small head on 1000+ examples
//     of one class vs 30 of another would skew the model toward
//     the majority.  The cap nudges the operator to balance
//     across classes rather than over-collecting any single one.
// When the count meets the cap the Slice button degrades to an
// "At cap · N/MAX" disabled state identical in shape to the
// Workspace list's "At cap · count/MAX_WORKSPACES" New-workspace
// button -- consistent across modules.
export const MAX_SLICES_PER_CATEGORY = 200;

export function isMandatoryCategory(name: string): boolean {
  return name === MANDATORY_BACKGROUND_NOISE;
}

export function thresholdFor(name: string): number {
  return isMandatoryCategory(name) ? THRESHOLD_BACKGROUND_NOISE : THRESHOLD_STANDARD;
}

// Pretty form of a category name.  Strips leading / trailing
// underscores (so Speech-Commands synthetics like `_unknown_` lose
// the wrappers), splits on `_` / `-` / whitespace runs, joins with
// a single space, then uppercases the whole string.  Mandatory
// synthetic short-circuits to the cached display to avoid a
// redundant transform.
export function prettyCategoryName(name: string): string {
  if (name === MANDATORY_BACKGROUND_NOISE) return MANDATORY_DISPLAY;
  const stripped = name.replace(/^[_-]+/, '').replace(/[_-]+$/, '');
  if (stripped.length === 0) return name.toUpperCase(); // pathological all-underscore input
  return stripped
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .join(' ')
    .toUpperCase();
}
