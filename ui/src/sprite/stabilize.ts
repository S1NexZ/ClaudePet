const SOLID = 128;

/** Mean x of the solid pixels in the top `headRows` rows of the cell's content, or null if the cell is empty. */
export function headCenter(data: Uint8ClampedArray, w: number, h: number, headRows = 40): number | null {
  let top = -1;
  for (let p = 0; p < w * h && top < 0; p++) if (data[p * 4 + 3] >= SOLID) top = Math.floor(p / w);
  if (top < 0) return null;
  let sum = 0, count = 0;
  for (let y = top; y < Math.min(h, top + headRows); y++)
    for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] >= SOLID) { sum += x; count++; }
  return sum / count;
}

/** Clears every pixel farther than `half` px (horizontally) from `center`. Mutates `data`. */
export function trimAround(data: Uint8ClampedArray, w: number, h: number, center: number, half: number): void {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (Math.abs(x - center) > half) data[(y * w + x) * 4 + 3] = 0;
}

/** Returns a copy of the cell moved horizontally by `dx` px (content leaving the cell is dropped). */
export function shiftCell(data: Uint8ClampedArray, w: number, h: number, dx: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    const from = Math.max(0, -dx), to = Math.min(w, w - dx);
    if (to > from) out.set(data.subarray((y * w + from) * 4, (y * w + to) * 4), (y * w + from + dx) * 4);
  }
  return out;
}
