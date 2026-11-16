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

describe('v2 sheets', () => {
  it('have an idle row of 7 frames and 11 rows; the first nine keep the standard layout', async () => {
    const { ROW_FRAMES_V2 } = await import('./stateMap.js');
    expect(ROW_FRAMES_V2).toHaveLength(11);
    expect(ROW_FRAMES_V2.slice(1, 9)).toEqual(ROW_FRAMES.slice(1));
    expect(ROW_FRAMES_V2[0]).toBe(7);
  });
});
