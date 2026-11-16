import { describe, it, expect } from 'vitest';
import { clampScale } from './petScale.js';

describe('clampScale', () => {
  it('keeps values in range, rounds to 0.05, falls back to 1 for junk', () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.1)).toBe(0.6);
    expect(clampScale(9)).toBe(1.8);
    expect(clampScale(1.23)).toBe(1.25);
    expect(clampScale('big')).toBe(1);
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(undefined)).toBe(1);
  });
});
