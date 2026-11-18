import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nodeCmd } from './nodeCmd.js';

export const HOOK_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd',
] as const;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const MARKER = 'pet-hook.mjs';

type Settings = Record<string, any>;

export function lineDiff(a: string[], b: string[]): string {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) out.push('+ ' + b[j++]);
    else out.push('- ' + a[i++]);
  }
  return out.join('\n');
}

/** Returns settings with our hook added for every event (idempotent) and a +/- line diff ('' if unchanged). */
export function planHooks(current: Settings, hookPath: string, nodePath: string): { next: Settings; diff: string } {
  // `|| true`: if the app is ever removed, a missing hook file must not surface as hook errors in Claude Code
  const command = `${nodeCmd(nodePath)} "${hookPath}" 2>/dev/null || true`;
  const next: Settings = JSON.parse(JSON.stringify(current));
  next.hooks ??= {};
  for (const ev of HOOK_EVENTS) {
    const groups: any[] = (next.hooks[ev] ??= []);
    // the mailbox waiter (`pet-hook.mjs wait`) belongs to hookConfig.ts: leave it alone here
    for (const g of groups) g.hooks = (g.hooks ?? []).filter((h: any) => !(String(h.command ?? '').includes(MARKER) && !/\swait\b/.test(String(h.command))));
    const kept = groups.filter((g) => g.hooks.length > 0);
    const group: Settings = TOOL_EVENTS.has(ev) ? { matcher: '*' } : {};
    group.hooks = [{ type: 'command', command }];
    next.hooks[ev] = [...kept, group];
  }
  if (JSON.stringify(current) === JSON.stringify(next)) return { next, diff: '' };
  // only the hooks section changes, so only it is shown
  const before = JSON.stringify({ hooks: current.hooks ?? {} }, null, 2).split('\n');
  const after = JSON.stringify({ hooks: next.hooks }, null, 2).split('\n');
  return { next, diff: lineDiff(before, after) };
}

/** Settings without our events hook (entries whose command mentions pet-hook.mjs, the waiter included); the user's own hooks stay. */
export function removeHooks(current: Settings): { next: Settings } {
  const next: Settings = JSON.parse(JSON.stringify(current));
  for (const ev of Object.keys(next.hooks ?? {})) {
    const groups: any[] = Array.isArray(next.hooks[ev]) ? next.hooks[ev] : [];
    for (const g of groups) if (Array.isArray(g?.hooks)) g.hooks = g.hooks.filter((h: any) => !String(h?.command ?? '').includes(MARKER));
    const kept = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (kept.length) next.hooks[ev] = kept; else delete next.hooks[ev];
  }
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { next };
}

export interface InstallOpts {
  settingsPath: string; hookPath: string; nodePath: string;
  yes: boolean; ask: (question: string) => Promise<string>; out: (line: string) => void;
}

/** Shows the diff, writes only after an explicit "y" (or --yes). Returns whether it wrote. */
export async function runInstall(o: InstallOpts): Promise<boolean> {
  let raw: string | undefined;
  let current: Settings = {};
  if (existsSync(o.settingsPath)) {
    raw = readFileSync(o.settingsPath, 'utf8');
    try { current = raw.trim() ? JSON.parse(raw) : {}; }
    catch { throw new Error(`Cannot parse settings file ${o.settingsPath}: not valid JSON, left untouched.`); }
  }
  const { next, diff } = planHooks(current, o.hookPath, o.nodePath);
  if (!diff) { o.out('Hooks already installed, nothing to change.'); return false; }
  o.out(`Changes to ${o.settingsPath}:\n${diff}`);
  if (!o.yes && (await o.ask('Apply these changes? [y/N] ')).trim().toLowerCase() !== 'y') {
    o.out('Aborted, nothing written.');
    return false;
  }
  if (raw !== undefined) copyFileSync(o.settingsPath, o.settingsPath + '.bak');
  else mkdirSync(dirname(o.settingsPath), { recursive: true });
  writeFileSync(o.settingsPath, JSON.stringify(next, null, 2) + '\n');
  o.out(raw !== undefined ? `Done. Backup: ${o.settingsPath}.bak` : 'Done.');
  return true;
}
