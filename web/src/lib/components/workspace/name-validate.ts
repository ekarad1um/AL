// Client-side mirror of the daemon's `validate_workspace_name`
// ([modules/file_mgr/registry.rs:32-52]).  We reject locally to
// avoid the round-trip for trivial typos; the backend still does
// its own check, which is the source of truth.  The two must stay
// in sync -- if the daemon's allowlist relaxes or tightens, update
// the constants here.

const MAX_BYTES = 128;
const ENCODER = new TextEncoder();

export function validateWorkspaceName(name: string): string | null {
  if (name.length === 0) return 'Name cannot be empty.';
  // Use UTF-8 byte count, not `String.length` (which counts UTF-16
  // code units) -- the daemon uses `name.len()` on a UTF-8 string.
  if (ENCODER.encode(name).length > MAX_BYTES) {
    return `Name must be ${MAX_BYTES} bytes or fewer.`;
  }
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) {
    return 'Name cannot contain slashes or NUL bytes.';
  }
  // `char::is_whitespace` is Unicode-aware; this regex covers the
  // common cases (space, tab, NBSP, ideographic spaces).  We don't
  // try to match the full property set -- the backend is the final
  // arbiter and will reject any edge case we miss with `bad_request`.
  if (/^\s/.test(name) || /\s$/.test(name)) {
    return 'Name cannot start or end with whitespace.';
  }
  // Reject ASCII / C0 / C1 control characters.  The daemon uses
  // `char::is_control` which matches the Unicode `Cc` category.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(name)) {
    return 'Name cannot contain control characters.';
  }
  return null;
}
