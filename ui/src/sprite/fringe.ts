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

/**
 * Packs cut out of a magenta/violet key colour keep a tinted rim: the semi-transparent pixels along the edge carry the key colour,
 * which shows as a purple outline on a dark background (often 2-3 px wide). A visibly purple pixel within 3 px of transparency takes
 * the colour of its opaque, not-purple neighbours (radius 3) and keeps its own alpha; the pass repeats so a wide rim goes entirely.
 * A faint purple pixel with nothing around it is dropped. A dark purple semi-transparent rim pixel (black mixed with the key colour,
 * which glows violet on a dark background and flickers from frame to frame) is made grey: same brightness, no tint. Where the inside is
 * purple too (a violet character, a bow on the edge) or the pixel is opaque (an outline the artist drew) nothing changes.
 * Mutates RGBA `data`; returns the pixels changed.
 */
export function removeColorSpill(data: Uint8ClampedArray, w: number, h: number): number {
  const alpha = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3]);
  const nearOutside = (x: number, y: number) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if ((dx || dy) && alpha(x + dx, y + dy) < 40) return true;
    return false;
  };
  const purple = (i: number) => {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    if (!d || l <= 0.14 || l > 0.92) return false;
    const s = d / (1 - Math.abs(2 * l - 1));
    let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue *= 60; if (hue < 0) hue += 360;
    return s > 0.2 && hue >= 250 && hue <= 340;
  };
  let changed = 0;
  for (let pass = 0; pass < 3; pass++) {
    const fix: Array<[number, number, number, number]> = [], drop: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 8 || !purple(i) || !nearOutside(x, y)) continue;
      let r = 0, g = 0, b = 0, clean = 0, tinted = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || alpha(nx, ny) < 200) continue;
        const j = (ny * w + nx) * 4;
        if (purple(j)) tinted++; else { r += data[j]; g += data[j + 1]; b += data[j + 2]; clean++; }
      }
      if (clean >= 2 && clean >= 2 * tinted) fix.push([i, Math.round(r / clean), Math.round(g / clean), Math.round(b / clean)]);
      else if (clean === 0 && tinted === 0 && data[i + 3] < 90) drop.push(i);
    }
    if (!fix.length && !drop.length) break;
    for (const [i, r, g, b] of fix) { data[i] = r; data[i + 1] = g; data[i + 2] = b; }
    for (const i of drop) data[i + 3] = 0;
    changed += fix.length + drop.length;
  }
  // dark tinted rim: keep the brightness, drop the colour
  const hueOf = (i: number) => {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    if (!d || l < 0.02 || l > 0.92) return false;
    const sat = d / (1 - Math.abs(2 * l - 1));
    let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue *= 60; if (hue < 0) hue += 360;
    return sat > 0.2 && hue >= 250 && hue <= 340;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 8 || data[i + 3] >= 250 || !hueOf(i) || !nearOutside(x, y)) continue;
    let clean = 0, tinted = 0; // a purple character (a purple inside) keeps its rim
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if ((!dx && !dy) || alpha(x + dx, y + dy) < 200) continue;
      if (purple(((y + dy) * w + x + dx) * 4)) tinted++; else clean++;
    }
    if (clean < 1 || clean < 2 * tinted) continue;
    const grey = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = grey;
    changed++;
  }
  return changed;
}
