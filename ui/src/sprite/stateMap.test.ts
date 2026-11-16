import { describe, it, expect } from 'vitest';
import { rowForState, ROW_FRAMES } from './stateMap.js';
import type { PetState } from '../../../shared/src/types.js';

const EXPECTED: Record<PetState, number> = {
  idle: 0, sleeping: 0, thinking: 7, writing: 7, running: 7,
  reading: 8, testing: 8, waiting: 6, done: 3, error: 5, subagent: 1,
};

describe('rowForState', () => {
  it.each(Object.entries(EXPECTED))('%s -> row %i', (state, row) =>
    expect(rowForState(state as PetState)).toBe(row));
  it('every mapped row exists in the Codex atlas (9 rows)', () => {
    expect(ROW_FRAMES).toEqual([6, 8, 8, 4, 5, 8, 6, 6, 6]);
    for (const r of Object.values(EXPECTED)) expect(r).toBeLessThan(ROW_FRAMES.length);
  });
});
