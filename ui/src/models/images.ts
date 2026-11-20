/** Pixel size of a WebP (VP8 / VP8L / VP8X) or PNG, read from the header only; null for anything else. */
export function imageSize(b: Buffer): { w: number; h: number; format: 'webp' | 'png' } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('ascii', 12, 16) === 'IHDR')
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), format: 'png' };
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const k = b.toString('ascii', 12, 16);
    if (k === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), format: 'webp' };
    if (k === 'VP8L' && b[20] === 0x2f) { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1, format: 'webp' }; }
    if (k === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, format: 'webp' };
  }
  return null;
}
/** The atlas layout the pet's animator is built for: 8 columns of 192x208 cells and 9 rows (1536x1872) or, for v2 packs, 11 rows (1536x2288). */
export const SHEET = { w: 1536, h: 1872 } as const;
export const SHEET_V2_H = 2288;
export const sheetSizeOk = (s: { w: number; h: number }): boolean => s.w === SHEET.w && (s.h === SHEET.h || s.h === SHEET_V2_H);

export interface LayoutRowMeta { id: string; frames: number; loopMs?: number }
export interface Layout { cell: { w: number; h: number }; cols: number; rows: LayoutRowMeta[] }
export const LAYOUT_MAX_SIDE = 6144;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** pet.json "layout" (optional): null when absent, throws Error on a malformed one. Same rules as the Rust side. */
export function parseLayout(meta: unknown): Layout | null {
  const l = (meta as { layout?: any } | null)?.layout;
  if (l === undefined || l === null) return null;
  const bad = (m: string): never => { throw new Error(`bad layout: ${m}`); };
  if (typeof l !== 'object' || Array.isArray(l)) bad('not an object');
  const { cell, cols, rows } = l;
  if (!cell || !isInt(cell.w, 64, 512) || !isInt(cell.h, 64, 512)) bad('cell');
  if (!isInt(cols, 1, 16)) bad('cols');
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 32) bad('rows');
  const seen = new Set<string>();
  const out = (rows as any[]).map((r): LayoutRowMeta => {
    if (!r || typeof r.id !== 'string' || !/^[a-z0-9_-]{1,24}$/.test(r.id) || seen.has(r.id)) return bad('row id');
    seen.add(r.id);
    if (!isInt(r.frames, 1, cols)) return bad(`frames of ${r.id}`);
    if (r.loopMs !== undefined && !isInt(r.loopMs, 200, 20000)) return bad(`loopMs of ${r.id}`);
    return r.loopMs === undefined ? { id: r.id, frames: r.frames } : { id: r.id, frames: r.frames, loopMs: r.loopMs };
  });
  return { cell: { w: cell.w, h: cell.h }, cols, rows: out };
}

/** Pixel size a layout's sheet must have, or null when it exceeds the per-side limit. */
export const layoutSheetSize = (l: Layout): { w: number; h: number } | null => {
  const w = l.cols * l.cell.w, h = l.rows.length * l.cell.h;
  return w > LAYOUT_MAX_SIDE || h > LAYOUT_MAX_SIDE ? null : { w, h };
};
