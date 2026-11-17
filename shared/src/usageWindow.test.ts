import { describe, it, expect } from 'vitest';
import { freshestWindow } from './usageWindow.js';

describe('freshestWindow', () => {
  const w = (usedPct: number, resetsAt: number) => ({ usedPct, resetsAt });
  it('same window: the higher usage wins (a lower one is a stale report)', () => {
    expect(freshestWindow(w(98, 100), w(94, 100))).toEqual(w(98, 100));
    expect(freshestWindow(w(94, 100), w(98, 100))).toEqual(w(98, 100));
  });
  it('a later reset time is a newer window, even with lower usage', () => {
    expect(freshestWindow(w(98, 100), w(3, 200))).toEqual(w(3, 200));
    expect(freshestWindow(w(3, 200), w(98, 100))).toEqual(w(3, 200));
  });
  it('a missing side gives the other', () => {
    expect(freshestWindow(null, w(1, 1))).toEqual(w(1, 1));
    expect(freshestWindow(w(1, 1), null)).toEqual(w(1, 1));
    expect(freshestWindow(null, null)).toBeNull();
  });
});
