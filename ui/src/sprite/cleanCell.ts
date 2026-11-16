/** Pixels at least this opaque form blobs; fainter ones are anti-aliasing halo. */
const SOLID = 128;

/**
 * Sprite packs often let a neighbouring frame's hair spill into a cell. Removes every
 * connected blob (except the largest one, the character) that either touches the cell's
 * left/right edge or is cut straight at the content's left/right boundary: at least
 * `minCut` rows on that boundary, which a natural shape's tip doesn't have.
 * Blobs are built from solid pixels only, so a fragment glued to the character by faint
 * anti-aliasing is still separate; the faint halo of a removed blob is removed with it.
 * Mutates RGBA `data` in place; returns the number of blobs removed.
 */
export function cleanCell(data: Uint8ClampedArray, w: number, h: number, minCut = 8): number {
  const n = w * h;
  const label = new Int32Array(n);
  const sizes: number[] = [0];
  const touches: boolean[] = [false];
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (label[start] || data[start * 4 + 3] < SOLID) continue;
    const id = sizes.length;
    let size = 0, edge = false;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      size++;
      if (x === 0 || x === w - 1) edge = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!label[q] && data[q * 4 + 3] >= SOLID) { label[q] = id; stack.push(q); }
      }
    }
    sizes.push(size);
    touches.push(edge);
  }
  if (sizes.length <= 2) return 0; // nothing, or the character alone

  // content window = x-range of all solid pixels; count the rows each blob occupies on its boundary columns
  let minX = w, maxX = -1;
  for (let p = 0; p < n; p++) if (label[p]) { const x = p % w; if (x < minX) minX = x; if (x > maxX) maxX = x; }
  const cut = new Int32Array(sizes.length);
  for (let y = 0; y < h; y++) {
    const l = label[y * w + minX] || label[y * w + Math.min(minX + 1, w - 1)];
    const r = label[y * w + maxX] || label[y * w + Math.max(maxX - 1, 0)];
    if (l) cut[l]++;
    if (r && maxX - minX > 2) cut[r]++;
  }
  let main = 1;
  for (let i = 2; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
  const drop = touches.map((t, i) => i !== 0 && i !== main && (t || cut[i] >= minCut));
  const removed = drop.filter(Boolean).length;
  if (!removed) return 0;

  // faint pixels follow their nearest solid blob (5x5 neighbourhood): the halo of a dropped blob goes too
  const clear: number[] = [];
  for (let p = 0; p < n; p++) {
    if (label[p]) { if (drop[label[p]]) clear.push(p); continue; }
    if (data[p * 4 + 3] === 0) continue;
    const x = p % w, y = (p - x) / w;
    let dKept = 9, dDropped = 9; // Chebyshev distance to the nearest kept / dropped solid pixel
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const l = label[ny * w + nx];
      if (!l) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (drop[l]) { if (d < dDropped) dDropped = d; } else if (d < dKept) dKept = d;
    }
    if (dDropped < dKept) clear.push(p); // ties go to the kept body
  }
  for (const p of clear) data[p * 4 + 3] = 0;
  return removed;
}
