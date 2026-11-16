/**
 * Some packs draw a light (white) rim around the character. It looks fine on a light background and like a halo on a dark one.
 * Removes it: a pixel is rim when it is light and nearly colorless AND touches transparency; peeling repeats a few times so
 * a rim that is 2-3 px thick goes entirely. Light pixels inside the body (highlights, eyes) never touch transparency and stay.
 * mode 'remove' makes the rim transparent, 'dark' turns it into a dark outline. Mutates RGBA `data`; returns the pixels changed.
 */
export type FringeMode = 'remove' | 'dark';
const DARK = [26, 15, 18] as const;

export function removeLightFringe(data: Uint8ClampedArray, w: number, h: number, mode: FringeMode = 'remove', passes = 3, cream = false): number {
  const isLight = (i: number) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.min(r, g, b) >= 200 && Math.max(r, g, b) - Math.min(r, g, b) <= 40) return true;
    // cream / peach rim (a white outline tinted by the body colour): bright red, light green, not far from white
    return cream && r >= 215 && g >= 165 && b >= 140 && r - b <= 80;
  };
  const touchesTransparency = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return true; // the cell's border counts as outside
      if (data[(ny * w + nx) * 4 + 3] < 64) return true;
    }
    return false;
  };
  if (cream) passes = Math.max(passes, 64); // cream areas that connect to the outside (pale flaps drawn around the body) go entirely
  let changed = 0;
  for (let pass = 0; pass < passes; pass++) {
    const hit: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] >= 64 && isLight(i) && touchesTransparency(x, y)) hit.push(i);
    }
    if (!hit.length) break;
    for (const i of hit) {
      if (mode === 'remove') data[i + 3] = 0;
      else { data[i] = DARK[0]; data[i + 1] = DARK[1]; data[i + 2] = DARK[2]; }
    }
    changed += hit.length;
    if (mode === 'dark') break; // recoloring is a single outline, not a peel
  }
  if (cream) changed += peelLighterRim(data, w, h, mode);
  return changed;
}

/**
 * The rim of some packs is not one colour: it is the body colour lightened (grey on a black hat, pale blue on blue headphones).
 * An edge pixel (touches transparency) counts as rim when it is clearly lighter than the mean of its inner neighbours (opaque
 * pixels that do not touch transparency themselves). One layer, so real 1-px lines (the magnifier, the wrench) survive unless
 * they are lighter than what sits under them.
 */
function peelLighterRim(data: Uint8ClampedArray, w: number, h: number, mode: FringeMode): number {
  const lum = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= 64;
  const isEdge = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && !solid(x + dx, y + dy)) return true;
    return false;
  };
  const hit: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!solid(x, y) || !isEdge(x, y)) continue;
    let sum = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx || dy) && solid(nx, ny) && !isEdge(nx, ny)) { sum += lum((ny * w + nx) * 4); n++; }
    }
    if (n >= 2 && lum((y * w + x) * 4) > sum / n + 28) hit.push((y * w + x) * 4);
  }
  for (const i of hit) {
    if (mode === 'remove') data[i + 3] = 0;
    else { data[i] = DARK[0]; data[i + 1] = DARK[1]; data[i + 2] = DARK[2]; }
  }
  return hit.length;
}
