// RFC3339 timestamps from the daemon, rendered for the UI.  Pure
// functions; the operator's locale comes from the browser (Intl
// uses the default `Intl.Locale`), so internationalization (Slice
// E.8) will plug in by passing a locale arg.

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const ABS = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
});

// Relative for recent (<24 h), absolute beyond.  The 24 h cliff is
// where "5 hours ago" stops feeling more informative than the date
// itself.  Returns the absolute fallback on parse failure so we
// never render `Invalid Date`.
export function formatRelative(rfc3339: string, now: Date = new Date()): string {
  const t = Date.parse(rfc3339);
  if (Number.isNaN(t)) return rfc3339;
  const deltaMs = t - now.getTime();
  const absMs = Math.abs(deltaMs);
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (absMs > ONE_DAY) return ABS.format(new Date(t));
  // Pick the largest unit that yields |n| >= 1 so "just now"
  // doesn't lose to "0 hours ago".
  const sec = deltaMs / 1000;
  const min = sec / 60;
  const hr = min / 60;
  if (Math.abs(hr) >= 1) return RTF.format(Math.round(hr), 'hour');
  if (Math.abs(min) >= 1) return RTF.format(Math.round(min), 'minute');
  return RTF.format(Math.round(sec), 'second');
}

export function formatAbsolute(rfc3339: string): string {
  const t = Date.parse(rfc3339);
  if (Number.isNaN(t)) return rfc3339;
  return ABS.format(new Date(t));
}
