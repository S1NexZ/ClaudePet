/** height of the pet's own part of the stage (pet + buttons + status): the anchor's distance from the window's top */
export const IDLE_H = 238;
export interface Anchor { cx: number; bottom: number }
export interface Area { x: number; y: number; width: number; height: number }

/**
 * The window is a constant-size transparent stage (no resizing, so the OS can never show a stale frame of the pet in the wrong place).
 * The pet stands at its top and the panels open below it; the anchor is the bottom centre of the pet's own (idle) part, IDLE_H below the window's top.
 * The part below the work area may stick out: only the pet itself is kept on screen.
 */
export function placeStage(a: Anchor, w: number, h: number, wa: Area): { x: number; y: number; width: number; height: number } {
  const cx = Math.min(Math.max(a.cx, wa.x + 60), wa.x + wa.width - 60);
  const bottom = Math.min(a.bottom, wa.y + wa.height);
  return { x: Math.round(cx - w / 2), y: Math.round(bottom - IDLE_H), width: w, height: h };
}

/** Parses window.json; accepts the older {x,bottom} format (window was 424 px wide then). */
export function restoreAnchor(json: string): Anchor | null {
  try {
    const p = JSON.parse(json);
    if (typeof p?.bottom !== 'number') return null;
    if (typeof p.cx === 'number') return { cx: p.cx, bottom: p.bottom };
    if (typeof p.x === 'number') return { cx: p.x + 212, bottom: p.bottom };
  } catch { /* fallthrough */ }
  return null;
}
