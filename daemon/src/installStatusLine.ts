import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { isNativeHook, nodeCmd } from './nodeCmd.js';
import { dirname } from 'node:path';
import { lineDiff } from './installHooks.js';

const MARKER = 'pet-statusline.mjs';
type Settings = Record<string, any>;

const CHAIN = ' --chain ';
const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const dec = (b: string): any => { try { return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch { return null; } };
/** pet-statusline.mjs (WSL / Linux, run by node) or `pet-helper.exe statusline` (Windows) */
export const isPetStatusLine = (command: string): boolean => command.includes(MARKER) || /(pet-helper\.exe|ccpet-hook)"?\s+statusline\b/i.test(command);
const isOurs = (sl: any) => !!sl && isPetStatusLine(String(sl.command ?? ''));
/** The statusLine Claude Code had before we wrapped it (null: ours is not a wrapper, or the wrapper is unreadable). */
export function chainedOriginal(sl: any): any | null {
  if (!isOurs(sl)) return null;
  const i = String(sl.command).lastIndexOf(CHAIN);
  return i < 0 ? null : dec(String(sl.command).slice(i + CHAIN.length).trim().split(/\s/)[0]);
}

export type StatusLineKind = 'none' | 'ours' | 'chained';

/**
 * Points Claude Code's `statusLine` at pet-statusline.mjs (feeds the pet's limits ring). Only the `statusLine` key is touched.
 * Someone else's statusLine is not replaced but wrapped: our script runs it with the same input and prints its output, and the
 * original object is kept (base64) so removeStatusLine restores it exactly.
 */
export function planStatusLine(current: Settings, scriptPath: string, nodePath: string, opts: { exe?: string } = {}): { next: Settings; diff: string; kind: StatusLineKind } {
  const existing = current.statusLine;
  // Windows: the helper exe; it always exits 0 and prints nothing to stderr, so no POSIX `2>/dev/null || true` (Claude Code may run it with cmd)
  // Windows: Claude Code runs the line with Git Bash, or PowerShell when there is none. An unquoted forward-slash path runs in both
  // (a quoted path followed by an argument is a syntax error in PowerShell); paths with spaces must come in their short 8.3 form.
  if (opts.exe && /\s/.test(opts.exe)) throw new Error('statusLine helper path must not contain spaces (use the short 8.3 path)');
  const base = opts.exe ? `${opts.exe.replace(/\\/g, '/')} statusline` : isNativeHook(scriptPath) ? `"${scriptPath}" statusline` : `${nodeCmd(nodePath)} "${scriptPath}"`;
  const tail = opts.exe ? '' : ' 2>/dev/null || true';
  const orig = isOurs(existing) ? chainedOriginal(existing) : existing ?? null;
  const next: Settings = JSON.parse(JSON.stringify(current));
  next.statusLine = orig
    ? { ...orig, type: 'command', command: `${base}${CHAIN}${enc(orig)}${tail}` }
    : { type: 'command', command: `${base}${tail}`, padding: 0 };
  const kind: StatusLineKind = orig ? 'chained' : 'ours';
  if (JSON.stringify(current.statusLine) === JSON.stringify(next.statusLine)) return { next, diff: '', kind };
  const before = current.statusLine === undefined ? [] : JSON.stringify({ statusLine: current.statusLine }, null, 2).split('\n');
  const after = JSON.stringify({ statusLine: next.statusLine }, null, 2).split('\n');
  return { next, diff: lineDiff(before, after), kind };
}

/** Takes our statusLine out again: a wrapped one is restored to the user's original, a plain one is removed. Anything else is left alone. */
export function removeStatusLine(current: Settings): { next: Settings; diff: string } {
  const sl = current.statusLine;
  if (!isOurs(sl)) return { next: current, diff: '' };
  const next: Settings = JSON.parse(JSON.stringify(current));
  const orig = chainedOriginal(sl);
  if (orig) next.statusLine = orig; else delete next.statusLine;
  const before = JSON.stringify({ statusLine: sl }, null, 2).split('\n');
  const after = orig ? JSON.stringify({ statusLine: orig }, null, 2).split('\n') : [];
  return { next, diff: lineDiff(before, after) };
}

/** Which of the three states the statusLine is in (ours = plain, chained = wrapping the user's own, none = something else or nothing). */
export function statusLineState(current: Settings): StatusLineKind {
  const sl = current.statusLine;
  return isOurs(sl) ? (chainedOriginal(sl) ? 'chained' : 'ours') : 'none';
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
  const { next, diff, kind } = planStatusLine(current, o.scriptPath, o.nodePath);
  if (kind === 'chained' && diff) o.out('Another statusLine is already configured: it is kept and run through the pet\'s script (Disconnect restores it).');
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
