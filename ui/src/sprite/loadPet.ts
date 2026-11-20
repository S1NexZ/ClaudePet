import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CELL, ROW_FRAMES, ROW_FRAMES_V2 } from './stateMap.js';
import { imageSize, SHEET_V2_H, parseLayout } from '../models/images.js';

export interface Pet {
  id: string;
  displayName: string;
  image: string;
  cell: { w: number; h: number };
  rows: { frames: number; id?: string; loopMs?: number }[];
  /** Optional per-pack fixes from tweaks.json: row index -> max half-width (px) kept around the head centre. */
  tweaks: { trimHalfWidth?: Record<string, number>; /** peel a light rim off the character ('remove') or turn it into a dark outline ('dark') */ lightFringe?: 'remove' | 'dark'; fringeCream?: boolean; stabilize?: boolean; /** false keeps the purple rim some packs have (removed by default) */ spill?: boolean };
}

/** Loads a Codex-format pet pack (pet.json + spritesheet) from a directory. */
export async function loadPet(dir: string): Promise<Pet> {
  const root = resolve(dir);
  let meta: { id?: string; displayName?: string; spritesheetPath?: string; layout?: unknown };
  try {
    meta = JSON.parse(await readFile(join(root, 'pet.json'), 'utf8'));
  } catch {
    throw new Error(`Cannot read pet.json in ${root}`);
  }
  const sheet = join(root, meta.spritesheetPath ?? 'spritesheet.webp');
  try { await access(sheet); } catch { throw new Error(`Spritesheet not found: ${meta.spritesheetPath ?? 'spritesheet.webp'} in ${root}`); }
  const size = imageSize(await readFile(sheet).catch(() => Buffer.alloc(0)));
  const frames = size?.h === SHEET_V2_H ? ROW_FRAMES_V2 : ROW_FRAMES;
  let tweaks: Pet['tweaks'] = {};
  try { tweaks = JSON.parse(await readFile(join(root, 'tweaks.json'), 'utf8')); } catch { /* no or broken tweaks: none */ }
  const layout = parseLayout(meta); // throws on a bad layout
  return {
    tweaks,
    id: meta.id ?? 'pet',
    displayName: meta.displayName ?? meta.id ?? 'pet',
    image: sheet,
    cell: layout ? { ...layout.cell } : { ...CELL },
    rows: layout ? layout.rows.map((r) => ({ ...r })) : frames.map((f) => ({ frames: f })),
  };
}
