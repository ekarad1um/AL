import { ApiError, isApiError } from '$lib/api/http';

// Map an `ApiError` (or unknown) to a single line of operator-facing
// copy.  The daemon's wire envelope is `{error, code}`; a few `code`s
// uniquely name a condition (e.g. `another_train_running`) and earn
// fixed copy here, but most are generic (`bad_request`, `conflict`,
// `not_found`) so the daemon's own `error` text carries the
// context and we pass it through verbatim.  This keeps the table
// short and avoids drifting copy that contradicts what the daemon
// actually said.
//
// All copy here uses sentence case + a trailing period to match
// ARCHITECTURE.md's "constructive and conversational" error rule.
const FIXED_COPY: Readonly<Record<string, string>> = {
  another_train_running: 'Another training job is already running on this daemon.',
  job_conflict: 'Another operation is already in progress on this resource.',
  event_gap: 'The event stream skipped ahead and needs to catch up from logs. Reconnecting…',
  too_early: 'The daemon is still applying your previous change. Retrying…',
  unavailable: 'The daemon is temporarily unavailable. Please retry in a moment.',
  internal:
    'The daemon hit an internal error. Please retry. If it persists, check the daemon logs.',
  unknown: 'Something went wrong. Please retry.'
};

// Backend `error` text for these codes is sufficiently operator-
// friendly that we pass it straight through (capitalized + period
// normalized).  Listed explicitly so a future copy review can audit
// the pass-throughs without grepping every call site.
const PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  'bad_request',
  'not_found',
  'conflict',
  'method_not_allowed'
]);

export function errorCopy(err: unknown): string {
  if (!isApiError(err)) {
    if (err instanceof Error) return finish(err.message);
    return finish(String(err));
  }
  const fixed = FIXED_COPY[err.code];
  if (fixed) return fixed;
  if (PASSTHROUGH_CODES.has(err.code)) return finish(err.body.error || err.message);
  return finish(err.body.error || err.message || `Request failed (${err.code})`);
}

// Daemon API errors are formatted with thiserror as
// `"<layer>: <real message>"` (e.g. `"fs: workspace name conflict: test"`,
// `"convert: shard not found"`).  The layer tag is engineering
// metadata, not operator copy.  We strip exactly one leading
// known-prefix so the operator sees the real reason; nested
// instances (e.g. an inner `"conflict: test"`) are preserved.
const DAEMON_LAYER_PREFIXES = [
  'fs',
  'file',
  'config',
  'mic',
  'head load',
  'head swap',
  'convert',
  'training',
  'activation',
  'invalid identifier',
  'invalid request',
  'internal'
];
const PREFIX_RE = new RegExp(`^(?:${DAEMON_LAYER_PREFIXES.join('|')}):\\s*`, 'i');

function stripLayerPrefix(s: string): string {
  return s.replace(PREFIX_RE, '');
}

// Sentence-case + trailing period.  Daemon messages are generally
// already well-formed but occasionally arrive lower-case or without
// terminal punctuation; normalize so call sites never have to.
function finish(s: string): string {
  return capFirst(stripLayerPrefix(s));
}

// Sentence-case + trailing period, without the daemon-layer prefix
// stripping that `errorCopy` applies.  Use this for messages that
// arrive *pre-cleaned* (e.g. an SSE terminal event's `message` field,
// which the daemon emits without the `fs:` / `convert:` etc. tag)
// where another `stripLayerPrefix` pass would risk lopping off a
// legitimate leading word that happens to match a known prefix.
// The `fallback` is what we return for blank input -- call sites that
// know the failure shape pass a domain-specific phrase (e.g. "Delete
// failed.") so the operator doesn't see a generic "Something went
// wrong." in a place where the action is unambiguous.
export function capFirst(s: string, fallback = 'Something went wrong.'): string {
  const t = s.trim();
  if (!t) return fallback;
  const head = t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(head) ? head : `${head}.`;
}

// Convenience guard used by stores: detect "the resource is gone"
// regardless of whether the upstream signalled 404 by code or by
// implicit absence (e.g. workspace deleted between fetch and read).
export function isNotFound(err: unknown): boolean {
  return isApiError(err) && (err.status === 404 || err.code === 'not_found');
}

export function isConflict(err: unknown): boolean {
  return isApiError(err) && err.status === 409;
}

export { ApiError };
