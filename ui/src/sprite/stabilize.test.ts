import { describe, it, expect } from 'vitest';
import { headCenter, trimAround, shiftCell } from './stabilize.js';

function cell(rows: string[]) {
  const h = rows.length, w = rows[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') data.set([1, 2, 3, 255], (y * w + x) * 4); }));
  return { data, w, h };
}
const alpha = (d: Uint8ClampedArray, w: number, h: number) =>
  Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (d[(y * w + x) * 4 + 3] ? '#' : '.')).join(''));

describe('headCenter', () => {
  it('is the mean x of solid pixels in the top `headRows` rows of content', () => {
    const { data, w, h } = cell([
      '..........',
      '....###...',   // head: x 4..6 -> centre 5
      '....###...',
      '#########.',   // wide body below is ignored with headRows=2
    ]);
    expect(headCenter(data, w, h, 2)).toBe(5);
  });
  it('empty cell -> null', () => {
    const { data, w, h } = cell(['....', '....']);
    expect(headCenter(data, w, h, 2)).toBeNull();
  });
});

describe('trimAround', () => {
  it('clears everything farther than half-width from the centre', () => {
    const { data, w, h } = cell(['##########', '##########']);
    trimAround(data, w, h, 5, 2);
    expect(alpha(data, w, h)).toEqual(['...#####..', '...#####..']);
  });
});

describe('shiftCell', () => {
  it('moves the picture by dx, dropping what leaves the cell', () => {
    const { data, w, h } = cell(['.##.......', '.#........']);
    expect(alpha(shiftCell(data, w, h, 3), w, h)).toEqual(['....##....', '....#.....']);
    expect(alpha(shiftCell(data, w, h, -2), w, h)).toEqual(['#.........', '..........']);
  });
  it('dx = 0 returns an identical copy with colours intact', () => {
    const { data, w, h } = cell(['.#..']);
    const out = shiftCell(data, w, h, 0);
    expect([...out]).toEqual([...data]);
    expect(out).not.toBe(data);
  });
});
