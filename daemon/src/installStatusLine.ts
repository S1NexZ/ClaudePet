import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { lineDiff } from './installHooks.js';

const MARKER = 'pet-statusline.mjs';
type Settings = Record<string, any>;

/**
 * Adds Claude Code's `statusLine` pointing at pet-statusline.mjs (feeds the pet's limits indicator).
 * Only the `statusLine` key is touched; another tool's statusLine is never replaced (foreign = true, no change).
 */
export function planStatusLine(current: Settings, scriptPath: string, nodePath: string): { next: Settings; diff: string; foreign: boolean } {
  const existing = current.statusLine;
  if (existing && !String(existing.command ?? '').includes(MARKER)) return { next: current, diff: '', foreign: true };
  const next: Settings = JSON.parse(JSON.stringify(current));
  next.statusLine = { type: 'command', command: `"${nodePath}" "${scriptPath}" 2>/dev/null || true`, padding: 0 };
  if (JSON.stringify(current.statusLine) === JSON.stringify(next.statusLine)) return { next, diff: '', foreign: false };
  const before = current.statusLine === undefined ? [] : JSON.stringify({ statusLine: current.statusLine }, null, 2).split('\n');
  const after = JSON.stringify({ statusLine: next.statusLine }, null, 2).split('\n');
  return { next, diff: lineDiff(before, after), foreign: false };
}

export interface StatusLineOpts {
  settingsPath: string; scriptPath: string; nodePath: string;
  yes: boolean; dryRun?: boolean; ask: (q: string) => Promise<string>; out: (line: string) => void;
  now?: () => Date;
}

/** Shows the diff; writes only after an explicit "y" (or --yes), never in --dry-run. Timestamped backup first. */
export async function runInstallStatusLine(o: StatusLineOpts): Promise<boolean> {
  let raw: string | undefined;
  let current: Settings = {};
  if (existsSync(o.settingsPath)) {
    raw = readFileSync(o.settingsPath, 'utf8');
    try { current = raw.trim() ? JSON.parse(raw) : {}; }
    catch { throw new Error(`Cannot parse settings file ${o.settingsPath}: not valid JSON, left untouched.`); }
  }
  const { next, diff, foreign } = planStatusLine(current, o.scriptPath, o.nodePath);
  if (foreign) { o.out('A different statusLine is already configured; it is left untouched. Nothing to change.'); return false; }
  if (!diff) { o.out('statusLine already set up, nothing to change.'); return false; }
  o.out(`Changes to ${o.settingsPath}:\n${diff}`);
  if (o.dryRun) { o.out('Dry run, nothing written.'); return false; }
  if (!o.yes && (await o.ask('Apply these changes? [y/N] ')).trim().toLowerCase() !== 'y') { o.out('Aborted, nothing written.'); return false; }
  let backup = '';
  if (raw !== undefined) {
    const t = (o.now?.() ?? new Date()).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    backup = `${o.settingsPath}.bak-statusline-${t}`;
    copyFileSync(o.settingsPath, backup);
  } else mkdirSync(dirname(o.settingsPath), { recursive: true });
  writeFileSync(o.settingsPath, JSON.stringify(next, null, 2) + '\n');
  o.out(backup ? `Done. Backup: ${backup}` : 'Done.');
  return true;
}
