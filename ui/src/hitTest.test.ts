import { describe, it, expect } from 'vitest';
import { overAny, rectsKey, type Rect } from './hitTest.js';

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const rects = [R(150, 400, 115, 125), R(10, 560, 400, 50)];

describe('overAny', () => {
  it('true inside any rect, false outside all', () => {
    expect(overAny(200, 450, rects)).toBe(true);
    expect(overAny(20, 580, rects)).toBe(true);
    expect(overAny(50, 100, rects)).toBe(false);
  });
  it('edges count, with a small tolerance pad', () => {
    expect(overAny(150, 400, rects)).toBe(true);
    expect(overAny(148, 400, rects, 2)).toBe(true);
    expect(overAny(146, 400, rects, 2)).toBe(false);
  });
  it('no rects: never over', () => expect(overAny(1, 1, [])).toBe(false));
});

describe('rectsKey', () => {
  it('changes only when geometry changes (rounded to px)', () => {
    expect(rectsKey([R(1.2, 2, 3, 4)])).toBe(rectsKey([R(1.4, 2, 3, 4)]));
    expect(rectsKey([R(1, 2, 3, 4)])).not.toBe(rectsKey([R(1, 2, 3, 5)]));
  });
});
