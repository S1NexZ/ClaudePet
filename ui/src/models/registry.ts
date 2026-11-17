import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Model ids are folder names: plain, lowercase, no separators, so an id can never address anything outside the models folders. */
export const MODEL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_MODEL = 'claude-maiden';

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  /** where the pack says it comes from (pet.json "source"), if it does */
  source: string;
  /** shipped with the app (read-only) or installed by the user (can be removed) */
  bundled: boolean;
  dir: string;
}

function readMeta(dir: string): { id?: string; displayName?: string; description?: string; source?: string; spritesheetPath?: string } | null {
  try { const m = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8')); return m && typeof m === 'object' ? m : null; } catch { return null; }
}
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

function scan(root: string, bundled: boolean): ModelInfo[] {
  if (!existsSync(root)) return [];
  const out: ModelInfo[] = [];
  for (const id of readdirSync(root).sort()) {
    if (!MODEL_ID.test(id)) continue; // ".tmp-…" leftovers and anything odd are not models
    const dir = join(root, id);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const m = readMeta(dir);
    if (!m) continue;
    out.push({ id, name: str(m.displayName, 80) || id, description: str(m.description, 300), source: str(m.source, 80), bundled, dir });
  }
  return out;
}

/** Bundled models first, then the user's; a user model never shadows a bundled id. */
export function listModels(bundledDir: string, userDir: string): ModelInfo[] {
  const b = scan(bundledDir, true);
  const taken = new Set(b.map((m) => m.id));
  return [...b, ...scan(userDir, false).filter((m) => !taken.has(m.id))];
}

/** The model to use: the chosen one if it is installed, else the default, else the first available, else null. */
export function pickModel(models: ModelInfo[], chosen: string | null | undefined): ModelInfo | null {
  return models.find((m) => m.id === chosen) ?? models.find((m) => m.id === DEFAULT_MODEL) ?? models[0] ?? null;
}
