// Display helpers for byte sizes and durations.  Pure functions, no
// dependencies on the audio pipeline -- usable from any UI surface
// that needs to render a "0:04 · 128 KiB" style metadata strip.

// Duration in `mm:ss` for clips up to an hour, `h:mm:ss` past that.
// Milliseconds round to the nearest second; we never surface sub-
// second precision in operator copy (it reads as noise -- a 4 s clip
// and a 4.2 s clip look indistinguishable in the UI anyway).
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.round(ms / 1000);
  const hr = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  if (hr > 0) return `${hr}:${pad2(min)}:${pad2(sec)}`;
  return `${min}:${pad2(sec)}`;
}

// Binary IEC units (KiB / MiB / GiB).  We use binary because IDB
// storage is reported in binary by the browser and the operator
// reasoning is "does this fit in my origin quota" -- decimal
// kilobytes would mismatch the browser's own DevTools storage
// readout.  One decimal place for KiB/MiB/GiB, none for raw bytes.
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const;
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // 1 decimal at KiB+; trims trailing `.0` for the steady-state
  // "exactly N KiB" case.
  const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  const trimmed = fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
  return `${trimmed} ${SIZE_UNITS[unit]}`;
}

// MM:SS with a centi-second decimal -- used by the live recording
// timer where the operator wants to feel the clock ticking.
export function formatRecordingClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00.0';
  const totalCs = Math.floor(ms / 100); // tenths
  const sec = Math.floor(totalCs / 10);
  const cs = totalCs % 10;
  const min = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${min}:${ss < 10 ? '0' : ''}${ss}.${cs}`;
}
