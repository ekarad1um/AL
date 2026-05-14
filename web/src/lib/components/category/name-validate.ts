// Client-side mirror of the daemon's `AssetPath` component rule
// ([modules/common/asset_path.rs]).  We validate locally to avoid
// the round-trip for trivial typos; the backend remains the source
// of truth and will reject anything we miss with `bad_request`.
//
// AssetPath rules (single component):
//   - Non-empty.
//   - Matches the byte allowlist `[A-Za-z0-9._-]`.
//   - Does NOT start with `.` (rules out `.`, `..`, and `.hidden`
//     with one rule).
//   - Per-component length <= 255 bytes (filesystem `NAME_MAX`
//     floor).
//
// We add one frontend-only rule on top of the daemon contract:
//   - Does NOT start with `_`.  Underscore-wrapped names
//     (`_background_noise_`, `_unknown_`) are reserved for the
//     Speech-Commands synthetic classes that the dataset layer
//     materialises automatically.  Disallowing them on the
//     operator-typed path keeps the display surface from showing
//     two rows that pretty-print to the same label, and avoids
//     accidental collisions with the daemon-synthesised mandatory
//     row.
//
// The full AssetPath also has a path-total <= 256 bytes cap and a
// depth <= 8 cap, but those constrain multi-segment paths
// (`datasets/<class>/<file>`).  A single category name is one
// segment, so the per-component cap is the operative one.

const ALLOWED_RE = /^[A-Za-z0-9._-]+$/;
const MAX_BYTES = 255;
const ENCODER = new TextEncoder();

export function validateCategoryName(name: string): string | null {
  if (name.length === 0) return 'Category name cannot be empty.';
  if (name.startsWith('.')) {
    return 'Category name cannot start with a dot.';
  }
  if (name.startsWith('_')) {
    return 'Category name cannot start with an underscore (reserved for built-in classes).';
  }
  if (!ALLOWED_RE.test(name)) {
    return 'Only letters, digits, dots, hyphens, and underscores are allowed.';
  }
  // UTF-8 byte count, not `String.length`: the daemon uses
  // `name.len()` on a UTF-8 string.  In practice every character we
  // accept (ASCII subset) is 1 byte, so the two counts coincide --
  // the encoder pass is defence in depth.
  if (ENCODER.encode(name).length > MAX_BYTES) {
    return `Category name must be ${MAX_BYTES} bytes or fewer.`;
  }
  return null;
}

// Case-insensitive uniqueness check.  AssetPath itself is byte-
// level case-sensitive, so `Cat` and `cat` are different identities
// to the daemon -- but the underlying filesystem may collapse them
// (HFS+ default on macOS, NTFS).  Reject case-insensitive
// collisions client-side so the operator never ends up with two
// rows that the filesystem can't distinguish.
export function findCaseInsensitiveDuplicate(
  candidate: string,
  existing: Iterable<string>
): string | null {
  const lower = candidate.toLowerCase();
  for (const name of existing) {
    if (name === candidate) return name; // exact match -- caller decides whether to allow re-add
    if (name.toLowerCase() === lower) return name;
  }
  return null;
}
