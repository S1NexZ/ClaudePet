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

import { removeColorSpill } from './fringe.js';
describe('removeColorSpill (a purple rim left by the key colour)', () => {
  const W = 12, H = 12;
  const blob = (inner: [number, number, number], rim: [number, number, number]) => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) {
      const i = (y * W + x) * 4, edge = x === 2 || y === 2 || x === 9 || y === 9;
      const c = edge ? rim : inner;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = edge ? 150 : 255;
    }
    return d;
  };
  it('takes the inner colour for a purple rim and keeps the alpha', () => {
    const d = blob([240, 240, 240], [150, 60, 170]);
    const n = removeColorSpill(d, W, H);
    expect(n).toBeGreaterThan(0);
    const i = (2 * W + 5) * 4;
    expect([d[i], d[i + 1], d[i + 2]]).toEqual([240, 240, 240]);
    expect(d[i + 3]).toBe(150);
  });
  it('leaves a purple character alone', () => {
    const d = blob([150, 60, 170], [150, 60, 170]);
    const before = Array.from(d);
    expect(removeColorSpill(d, W, H)).toBe(0);
    expect(Array.from(d)).toEqual(before);
  });
  it('leaves a non-purple rim alone', () => {
    const d = blob([240, 240, 240], [20, 20, 20]);
    expect(removeColorSpill(d, W, H)).toBe(0);
  });
  it('peels a rim that is two pixels wide', () => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 1; y < 11; y++) for (let x = 1; x < 11; x++) {
      const i = (y * W + x) * 4, ring = Math.min(x - 1, y - 1, 10 - x, 10 - y);
      const c = ring < 2 ? [150, 60, 170] : [240, 240, 240];
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = ring === 0 ? 120 : ring === 1 ? 200 : 255;
    }
    removeColorSpill(d, W, H);
    for (const [x, y] of [[1, 5], [2, 5]]) { const i = (y * W + x) * 4; expect([d[i], d[i + 1], d[i + 2]]).toEqual([240, 240, 240]); }
  });
  it('drops a faint lone purple pixel and keeps a near-black outline', () => {
    const d = new Uint8ClampedArray(W * H * 4);
    const lone = 0; d[lone] = 150; d[lone + 1] = 60; d[lone + 2] = 170; d[lone + 3] = 60;
    for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) { const i = (y * W + x) * 4; const edge = x === 4 || y === 4 || x === 9 || y === 9; const c = edge ? [26, 15, 23] : [240, 240, 240]; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
    removeColorSpill(d, W, H);
    expect(d[lone + 3]).toBe(0);
    const o = (4 * W + 6) * 4; expect([d[o], d[o + 1], d[o + 2]]).toEqual([26, 15, 23]);
  });
});

describe('removeColorSpill: dark violet rim', () => {
  it('makes a dark semi-transparent violet rim grey and keeps its brightness', () => {
    const W2 = 12, H2 = 12, d = new Uint8ClampedArray(W2 * H2 * 4);
    for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) {
      const i = (y * W2 + x) * 4, edge = x === 2 || y === 2 || x === 9 || y === 9;
      const c = edge ? [60, 20, 70] : [240, 240, 240];
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = edge ? 180 : 255;
    }
    removeColorSpill(d, W2, H2);
    const i = (2 * W2 + 5) * 4;
    expect(d[i]).toBe(d[i + 1]); expect(d[i + 1]).toBe(d[i + 2]); // no tint left (it took the inner colour or went grey)
    expect(d[i + 3]).toBe(180);
  });
});
