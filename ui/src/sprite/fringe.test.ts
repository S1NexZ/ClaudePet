import { describe, it, expect } from 'vitest';
import { removeLightFringe } from './fringe.js';

const W = [250, 250, 250, 255], O = [217, 119, 87, 255], K = [10, 10, 10, 255], T = [0, 0, 0, 0];
const grid = (rows: string[]) => {
  const map: Record<string, number[]> = { w: W, o: O, k: K, '.': T };
  const h = rows.length, w = rows[0].length, d = new Uint8ClampedArray(w * h * 4);
  rows.forEach((r, y) => [...r].forEach((c, x) => d.set(map[c], (y * w + x) * 4)));
  return { d, w, h };
};
const show = (d: Uint8ClampedArray, w: number, h: number) =>
  Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => {
    const i = (y * w + x) * 4; if (d[i + 3] < 64) return '.'; return d[i] >= 200 && d[i + 1] >= 200 ? 'w' : d[i] > 100 ? 'o' : 'k';
  }).join(''));

describe('removeLightFringe', () => {
  it('peels a light rim off the outside, keeps the body', () => {
    const { d, w, h } = grid(['.......', '.wwwww.', '.wooow.', '.wooow.', '.wwwww.', '.......']);
    const n = removeLightFringe(d, w, h);
    expect(show(d, w, h)).toEqual(['.......', '.......', '..ooo..', '..ooo..', '.......', '.......']);
    expect(n).toBe(14);
  });
  it('peels a thick (2 px) rim completely; a light pixel inside the body (an eye) stays', () => {
    const { d, w, h } = grid(['.........', '.wwwwwww.', '.wwwwwww.', '.wwoooww.', '.wwowoww.', '.wwoooww.', '.wwwwwww.', '.wwwwwww.', '.........']);
    removeLightFringe(d, w, h);
    expect(show(d, w, h)).toEqual(['.........', '.........', '.........', '...ooo...', '...owo...', '...ooo...', '.........', '.........', '.........']);
  });
  it('does not touch colored or dark edges', () => {
    const { d, w, h } = grid(['....', '.oo.', '.kk.', '....']);
    expect(removeLightFringe(d, w, h)).toBe(0);
    expect(show(d, w, h)).toEqual(['....', '.oo.', '.kk.', '....']);
  });
  it('dark mode recolors the rim as an outline instead of deleting it', () => {
    const { d, w, h } = grid(['.....', '.www.', '.wow.', '.www.', '.....']);
    removeLightFringe(d, w, h, 'dark');
    expect(show(d, w, h)).toEqual(['.....', '.kkk.', '.kok.', '.kkk.', '.....']);
  });
  it('a body touching the cell border counts the border as outside', () => {
    const { d, w, h } = grid(['wwww', 'wooo', 'wooo']);
    expect(removeLightFringe(d, w, h, 'remove', 1)).toBeGreaterThan(0);
  });
});

describe('removeLightFringe cream rim', () => {
  const px = (rgba: number[][]) => Uint8ClampedArray.from(rgba.flat());
  it('removes a cream rim only when cream is on, and keeps the body', () => {
    // row of 5: transparent, cream rim, body, body, transparent  (w=5,h=1; cell border counts as outside, so the body must be dark)
    const row = () => px([[0, 0, 0, 0], [240, 224, 192, 255], [200, 110, 90, 255], [200, 110, 90, 255], [0, 0, 0, 0]]);
    const off = row(); removeLightFringe(off, 5, 1, 'remove');
    expect(off[1 * 4 + 3]).toBe(255);
    const on = row(); removeLightFringe(on, 5, 1, 'remove', 3, true);
    expect(on[1 * 4 + 3]).toBe(0);
    expect(on[2 * 4 + 3]).toBe(255);
  });
});

describe('removeLightFringe lighter-than-inside rim', () => {
  it('peels a one-pixel lighter rim of any hue but keeps a same-tone edge', () => {
    // 6x6 canvas: transparent frame, 4x4 dark-blue body with a pale-blue top row
    const w = 6, h = 6, d = new Uint8ClampedArray(w * h * 4);
    for (let y = 1; y <= 4; y++) for (let x = 1; x <= 4; x++) {
      const i = (y * w + x) * 4, rim = y === 1;
      d.set(rim ? [150, 170, 220, 255] : [30, 80, 140, 255], i);
    }
    removeLightFringe(d, w, h, 'remove', 3, true);
    expect(d[(1 * w + 2) * 4 + 3]).toBe(0);   // pale rim gone
    expect(d[(4 * w + 2) * 4 + 3]).toBe(255); // body edge same tone stays
    expect(d[(2 * w + 2) * 4 + 3]).toBe(255);
  });
});
