import { describe, it, expect } from 'vitest';
import { cleanCell } from './cleanCell.js';

/** Builds an RGBA cell from rows of chars: '#' opaque, '.' transparent. */
function cell(rows: string[]) {
  const h = rows.length, w = rows[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') data.set([10, 20, 30, 255], (y * w + x) * 4); }));
  return { data, w, h };
}
/** Like cell(), plus '+' = faint anti-aliasing pixel (alpha 60). */
function cellAA(rows: string[]) {
  const c = cell(rows.map((r) => r.replace(/\+/g, '.')));
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '+') c.data.set([10, 20, 30, 60], (y * c.w + x) * 4); }));
  return c;
}
const alpha = (d: Uint8ClampedArray, w: number, h: number) =>
  Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (d[(y * w + x) * 4 + 3] ? '#' : '.')).join(''));

describe('cleanCell', () => {
  it('removes neighbour fragments that touch the left/right edge, keeps the main body', () => {
    const { data, w, h } = cell([
      '#...###...#',
      '#..#####..#',
      '...#####...',
      '....###....',
    ]);
    expect(cleanCell(data, w, h)).toBe(2);
    expect(alpha(data, w, h)).toEqual([
      '....###....',
      '...#####...',
      '...#####...',
      '....###....',
    ]);
  });
  it('keeps detached details that do not touch a side edge (sparkles, sweat drops)', () => {
    const { data, w, h } = cell([
      '.#...###...',
      '....#####..',
      '....#####..',
    ]);
    expect(cleanCell(data, w, h)).toBe(0);
    expect(alpha(data, w, h)[0]).toBe('.#...###...');
  });
  it('never removes the largest component even if it touches an edge', () => {
    const { data, w, h } = cell([
      '#####......',
      '#####....#.',
    ]);
    expect(cleanCell(data, w, h)).toBe(0);
    expect(alpha(data, w, h)[0]).toBe('#####......');
  });
  it('an empty cell is left alone', () => {
    const { data, w, h } = cell(['....', '....']);
    expect(cleanCell(data, w, h)).toBe(0);
  });

  it('removes fragments cut straight at the content window edge (inside the cell margins)', () => {
    // window is x=2..12; left fragment has a 4-px vertical cut at x=2, right one at x=12
    const { data, w, h } = cell([
      '..#...###....#.',
      '..##.#####..##.',
      '..##.#####..##.',
      '..#..#####...#.',
      '......###......',
    ]);
    expect(cleanCell(data, w, h, 4)).toBe(2);
    expect(alpha(data, w, h)[1]).toBe('.....#####.....');
  });
  it('keeps a detached tip that merely reaches the content edge without a straight cut', () => {
    const { data, w, h } = cell([
      '..#...###......',
      '.....#####.....',
      '.....#####.....',
      '.....#####.....',
    ]);
    expect(cleanCell(data, w, h, 4)).toBe(0);
  });

  it('a fragment joined to the body only by faint anti-aliasing pixels is still removed, with its halo', () => {
    const { data, w, h } = cellAA([
      '..#+..###......',
      '..##+#####.....',
      '..##+#####.....',
      '..#++#####.....',
      '..#+..###......',
    ]);
    expect(cleanCell(data, w, h, 4)).toBe(1);
    // fragment and the halo pixels that belonged to it are gone; the body is intact
    expect(alpha(data, w, h).map((r) => r.slice(0, 4))).toEqual(['....', '....', '....', '....', '....']);
    expect(alpha(data, w, h)[1].slice(5, 10)).toBe('#####');
  });
  it('faint edge pixels of the kept body are preserved', () => {
    const { data, w, h } = cellAA([
      '.....+###+.....',
      '....+#####+....',
    ]);
    cleanCell(data, w, h, 4);
    expect(data[(0 * w + 5) * 4 + 3]).toBe(60);
    expect(data[(1 * w + 10) * 4 + 3]).toBe(60);
  });
});
