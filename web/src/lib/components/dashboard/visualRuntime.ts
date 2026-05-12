const MAX_CANVAS_DPR = 2;
const MAX_RENDER_HZ = 120;
const FRAME_INTERVAL_EPSILON_MS = 0.5;

export const VISUAL_MIN_FRAME_INTERVAL_MS = 1000 / MAX_RENDER_HZ;

// Cap backing-store density: CSS size stays unchanged, but 3x/4x panels do not
// multiply canvas work by 9x/16x on weaker GPUs.
export function visualDevicePixelRatio(): number {
  const dpr = globalThis.devicePixelRatio;
  if (typeof dpr !== 'number' || !Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.max(1, Math.min(MAX_CANVAS_DPR, dpr));
}

// Return the logical render timestamp, or null if this RAF should only keep the
// loop alive.  Advancing by fixed intervals (not `nowMs`) gives 144 Hz panels a
// 5-render/1-skip pattern (~120 Hz) instead of accidentally dropping to 72 Hz.
export function nextVisualRenderAt(
  nowMs: DOMHighResTimeStamp,
  lastRenderAtMs: number,
  minIntervalMs = VISUAL_MIN_FRAME_INTERVAL_MS
): number | null {
  if (!Number.isFinite(lastRenderAtMs)) return nowMs;
  const elapsedMs = nowMs - lastRenderAtMs;
  if (elapsedMs + FRAME_INTERVAL_EPSILON_MS < minIntervalMs) return null;
  const intervals = Math.max(1, Math.floor(elapsedMs / minIntervalMs));
  return lastRenderAtMs + intervals * minIntervalMs;
}
