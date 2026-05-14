// Colour helpers shared across canvas surfaces.

// Convert a `#rrggbb` string + alpha (0..1) into a CSS `rgba(...)`
// value.  Used by waveform renderers for the translucent fill
// behind the contour line.
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
