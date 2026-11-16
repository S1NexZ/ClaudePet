import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CELL, ROW_FRAMES } from './stateMap.js';

export interface Pet {
  id: string;
  displayName: string;
  image: string;
  cell: { w: 192; h: 208 };
  rows: { frames: number }[];
  /** Optional per-pack fixes from tweaks.json: row index -> max half-width (px) kept around the head centre. */
  tweaks: { trimHalfWidth?: Record<string, number>; /** peel a light rim off the character ('remove') or turn it into a dark outline ('dark') */ lightFringe?: 'remove' | 'dark'; fringeCream?: boolean; stabilize?: boolean };
}

/** Loads a Codex-format pet pack (pet.json + spritesheet) from a directory. */
export async function loadPet(dir: string): Promise<Pet> {
  const root = resolve(dir);
  let meta: { id?: string; displayName?: string; spritesheetPath?: string };
  try {
    meta = JSON.parse(await readFile(join(root, 'pet.json'), 'utf8'));
  } catch {
    throw new Error(`Cannot read pet.json in ${root}`);
  }
  const sheet = join(root, meta.spritesheetPath ?? 'spritesheet.webp');
  try { await access(sheet); } catch { throw new Error(`Spritesheet not found: ${meta.spritesheetPath ?? 'spritesheet.webp'} in ${root}`); }
  let tweaks: Pet['tweaks'] = {};
  try { tweaks = JSON.parse(await readFile(join(root, 'tweaks.json'), 'utf8')); } catch { /* no or broken tweaks: none */ }
  return {
    tweaks,
    id: meta.id ?? 'pet',
    displayName: meta.displayName ?? meta.id ?? 'pet',
    image: sheet,
    cell: { ...CELL },
    rows: ROW_FRAMES.map((frames) => ({ frames })),
  };
}
