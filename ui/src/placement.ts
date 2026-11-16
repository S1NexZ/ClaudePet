export interface Anchor { cx: number; bottom: number }
export interface Area { x: number; y: number; width: number; height: number }

/**
 * Window bounds for content of size w×h whose bottom centre (where the pet stands) sits at the anchor,
 * moved inside the work area when it would stick out (Windows' own window drag clamps to it anyway).
 */
export function placeWindow(a: Anchor, w: number, h: number, wa: Area): { x: number; y: number; width: number; height: number } {
  const x = Math.min(Math.max(a.cx - w / 2, wa.x), wa.x + wa.width - w);
  const y = Math.min(Math.max(a.bottom - h, wa.y), wa.y + wa.height - h);
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

/**
 * The window is a constant-size transparent stage (no resizing, so the OS can never show a stale frame of the pet in the wrong place):
 * its bottom centre sits on the anchor; the part above the work area may stick out, only the pet's own spot is kept on screen.
 */
export function placeStage(a: Anchor, w: number, h: number, wa: Area): { x: number; y: number; width: number; height: number } {
  const cx = Math.min(Math.max(a.cx, wa.x + 60), wa.x + wa.width - 60);
  const bottom = Math.min(a.bottom, wa.y + wa.height);
  return { x: Math.round(cx - w / 2), y: Math.round(bottom - h), width: w, height: h };
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
