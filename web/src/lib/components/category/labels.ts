// Category label utilities.  Single source of truth for
// transforming an AssetPath-form category id into the operator-
// facing display label.  Both the dataset accordion and the
// dashboard's top-K meter route through `prettyCategoryName` so
// the same `_background_noise_` row reads identically on both
// surfaces.
//
// AssetPath form (wire / disk identifier): the AssetPath component
// shape (`[A-Za-z0-9._-]`, ≤ 255 bytes, no leading `.`, no leading
// `_` for operator-typed names — see `name-validate.ts`).  This is
// what the daemon stores as a directory under
// `<workspace>/datasets/<class>/`.
//
// Display form:
//   * Reserved synthetics — labels that both START and END with
//     `_` (e.g. `_background_noise_`, `_unknown_`).  Underscores
//     are treated as word separators and the first letter of
//     each word is capitalized for title case: "Background
//     Noise", "Unknown".  These come from upstream label sets
//     (Speech-Commands convention); the operator never types
//     them.
//   * Operator-typed labels — passed through verbatim.  A
//     workspace operator who types `Cat`, `dog2`, or
//     `my-class_42` sees their own casing + punctuation; the
//     formatter never re-cases or re-punctuates user input.

export const MANDATORY_BACKGROUND_NOISE = '_background_noise_';

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

// Pretty form of a category name.  Two-branch:
//
//   1. Reserved synthetic (`_..._`) — strips the wrapper
//      underscores, splits the remainder on `_` / `-` / any
//      whitespace, capitalizes the first letter of every word,
//      and joins with single spaces.  `_background_noise_` →
//      "Background Noise", `_unknown_` → "Unknown".  Hyphen is
//      in the split class for forward-compat: no shipped
//      synthetic uses one, but a future upstream label set
//      could, and `_foo-bar_` reading as "Foo Bar" matches how
//      the operator reads the underscore form.  An all-
//      separator inner (the only way `parts` is empty after the
//      length filter) falls back to the verbatim wire form so
//      the operator can still distinguish the row.
//   2. Operator-typed — verbatim.  The wire-form name-validator
//      already disallows operator-typed names starting with `_`
//      (see `name-validate.ts`), so a label that doesn't fit
//      pattern 1 came directly from the operator; their chosen
//      casing + punctuation is the display.
export function prettyCategoryName(name: string): string {
  if (name.length >= 2 && name.startsWith('_') && name.endsWith('_')) {
    const parts = name
      .slice(1, -1)
      .split(/[\s_-]+/)
      .filter((p) => p.length > 0);
    if (parts.length === 0) return name;
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  return name;
}

// Format a labels array for display.  Every entry routes through
// `prettyCategoryName` so reserved synthetics render in title case
// while operator-typed labels pass through verbatim, and the
// result is comma-joined.  Pass `opts.max` to cap the visible
// count and append a trailing ellipsis when the list exceeds the
// cap; omit `opts.max` (or leave undefined) for the full list --
// suitable for HTML `title` tooltips where the operator wants to
// see every label.
//
//   formatLabelsList(['_unknown_', 'cat'])            → "Unknown, cat"
//   formatLabelsList(['a','b','c','d'], { max: 2 })   → "a, b, …"
export function formatLabelsList(labels: readonly string[], opts: { max?: number } = {}): string {
  const pretty = labels.map(prettyCategoryName);
  if (opts.max === undefined || pretty.length <= opts.max) {
    return pretty.join(', ');
  }
  return `${pretty.slice(0, opts.max).join(', ')}, …`;
}
