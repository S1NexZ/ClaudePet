import type { UsageWindow } from './types.js';

/**
 * Which of two reports of the same limit window is current. Within one window (same reset time) usage only grows, so a lower value is a
 * stale report (an idle session re-renders its status line with numbers from its last API response); a later reset time is a newer window.
 */
export function freshestWindow(a: UsageWindow | null, b: UsageWindow | null): UsageWindow | null {
  if (!a) return b;
  if (!b) return a;
  if (a.resetsAt !== b.resetsAt) return a.resetsAt > b.resetsAt ? a : b;
  return b.usedPct > a.usedPct ? b : a;
}
