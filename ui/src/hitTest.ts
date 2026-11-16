/** A layout box of an interactive element, in window-local CSS px (= Electron DIP). */
export interface Rect { x: number; y: number; w: number; h: number }

/** Is the point inside any rect (grown by `pad` px on every side)? */
export function overAny(px: number, py: number, rects: Rect[], pad = 0): boolean {
  return rects.some((r) => px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad);
}

/** Stable key so the renderer only reports geometry when it really changed. */
export const rectsKey = (rects: Rect[]): string =>
  rects.map((r) => [r.x, r.y, r.w, r.h].map(Math.round).join(',')).join(';');
