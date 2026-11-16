import type { PetState } from '../../../shared/src/types.js';

/** Frames per row of the Codex pet atlas (1536x1872, 8 cols x 9 rows of 192x208). */
export const ROW_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6] as const;
/** Loop duration per row (ms). Calm pacing: ~4-5.5 fps instead of a fixed 8 fps; run rows stay brisker. */
export const ROW_LOOP_MS = [2200, 1350, 1350, 1200, 1200, 1900, 1600, 1600, 1600] as const;
export const CELL = { w: 192, h: 208 } as const;

const ROW: Record<PetState, number> = {
  idle: 0, sleeping: 0,
  thinking: 7, writing: 7, running: 7,
  reading: 8, testing: 8,
  waiting: 6,
  done: 3,
  error: 5,
  subagent: 1,
};

export const rowForState = (s: PetState): number => ROW[s];
