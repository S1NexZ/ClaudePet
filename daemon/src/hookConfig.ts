import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nodeCmd } from './nodeCmd.js';
import { HOOK_EVENTS, lineDiff } from './installHooks.js';

/**
 * Our entries in a host's `~/.claude/settings.json`, merged next to the user's own hooks and recognised by what they do, never by extra keys:
 *  - an `http` handler whose URL is `http://127.0.0.1:<port>/hook/<hex token>/<Event>` (Windows host: all events; both hosts: PermissionRequest);
 *  - the mailbox waiter: a background command with `asyncRewake` (Windows: `pet-helper.exe wait <url>`; WSL: `node pet-hook.mjs wait`).
 */
export type HostKind = 'windows' | 'wsl';
type Settings = Record<string, any>;

export interface HookPlanOpts {
  kind: HostKind;
  /** `http://127.0.0.1:<port>` of this host's receiver */
  origin: string;
  token: string;
  /** windows: full path of pet-helper.exe */
  helperPath?: string;
  /** wsl: the node binary and pet-hook.mjs */
  nodePath?: string;
  hookPath?: string;
  /** also answer PermissionRequest through the pet (off by default) */
  permissions: boolean;
}

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const HTTP_HOOK_URL = /^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f]+\/(\w+)$/;
const isWaiter = (h: any) => h?.type === 'command' && (
  (/pet-helper(\.exe)?["']?$/i.test(String(h.command ?? '')) && Array.isArray(h.args) && h.args[0] === 'wait') ||
  (/pet-hook\.mjs/.test(String(h.command ?? '')) && /\swait\b/.test(String(h.command))));
const isOurHttp = (h: any) => h?.type === 'http' && HTTP_HOOK_URL.test(String(h.url ?? ''));
const isOurs = (h: any) => isWaiter(h) || isOurHttp(h);

function strip(next: Settings): void {
  for (const ev of Object.keys(next.hooks ?? {})) {
    const groups: any[] = Array.isArray(next.hooks[ev]) ? next.hooks[ev] : [];
    for (const g of groups) if (Array.isArray(g?.hooks)) g.hooks = g.hooks.filter((h: any) => !isOurs(h));
    const kept = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (kept.length) next.hooks[ev] = kept; else delete next.hooks[ev];
  }
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
}

const withDiff = (current: Settings, next: Settings) => {
  if (JSON.stringify(current) === JSON.stringify(next)) return { next, diff: '' };
  const before = JSON.stringify({ hooks: current.hooks ?? {} }, null, 2).split('\n');
  const after = JSON.stringify({ hooks: next.hooks ?? {} }, null, 2).split('\n');
  return { next, diff: lineDiff(before, after) };
};

const add = (next: Settings, ev: string, handler: Settings, matcher?: string) => {
  next.hooks ??= {};
  const group: Settings = matcher ? { matcher } : TOOL_EVENTS.has(ev) || ev === 'PermissionRequest' ? { matcher: '*' } : {};
  group.hooks = [handler];
  next.hooks[ev] = [...(next.hooks[ev] ?? []), group];
};

/** Settings with our entries (re)installed, and a +/- diff of the hooks section ('' when nothing changes). Idempotent. */
export function planHostHooks(current: Settings, o: HookPlanOpts): { next: Settings; diff: string } {
  const next: Settings = JSON.parse(JSON.stringify(current));
  strip(next);
  if (o.kind === 'windows') {
    for (const ev of HOOK_EVENTS) add(next, ev, { type: 'http', url: `${o.origin}/hook/${o.token}/${ev}`, timeout: 5 });
    if (o.helperPath) {
      const waiter = { type: 'command', command: o.helperPath, args: ['wait', `${o.origin}/mailbox/${o.token}`], asyncRewake: true };
      for (const ev of ['SessionStart', 'Stop']) add(next, ev, { ...waiter });
    }
  } else if (o.nodePath && o.hookPath) {
    const waiter = { type: 'command', command: `${nodeCmd(o.nodePath)} "${o.hookPath}" wait`, asyncRewake: true };
    for (const ev of ['SessionStart', 'Stop']) add(next, ev, { ...waiter });
  }
  if (o.permissions) add(next, 'PermissionRequest', { type: 'http', url: `${o.origin}/hook/${o.token}/PermissionRequest`, timeout: 35 });
  // Claude's questions (AskUserQuestion) are answered in the pet: the user may take a while, the terminal shows the question meanwhile
  add(next, 'PermissionRequest', { type: 'http', url: `${o.origin}/hook/${o.token}/PermissionRequest`, timeout: 600 }, 'AskUserQuestion');
  return withDiff(current, next);
}

/** Settings without any of our entries (the user's own hooks stay). */
export function removeHostHooks(current: Settings): { next: Settings; diff: string } {
  const next: Settings = JSON.parse(JSON.stringify(current));
  strip(next);
  return withDiff(current, next);
}

export interface HooksStatus { events: boolean; mailbox: boolean; permissions: boolean }

export function hooksStatus(current: Settings, kind: HostKind): HooksStatus {
  const handlers = (ev: string): any[] => (Array.isArray(current.hooks?.[ev]) ? current.hooks[ev] : []).flatMap((g: any) => (Array.isArray(g?.hooks) ? g.hooks : []));
  const eventsHttp = HOOK_EVENTS.every((ev) => handlers(ev).some((h) => isOurHttp(h)));
  const eventsCmd = HOOK_EVENTS.every((ev) => handlers(ev).some((h) => h?.type === 'command' && /pet-hook\.mjs/.test(String(h.command ?? '')) && !/\swait\b/.test(String(h.command))));
  return {
    events: kind === 'windows' ? eventsHttp : eventsCmd,
    mailbox: ['SessionStart', 'Stop'].every((ev) => handlers(ev).some(isWaiter)),
    // the questions-only group (matcher AskUserQuestion) is always there: tool permissions are the catch-all one
    permissions: (Array.isArray(current.hooks?.PermissionRequest) ? current.hooks.PermissionRequest : []).some((g: any) => g?.matcher !== 'AskUserQuestion' && Array.isArray(g?.hooks) && g.hooks.some(isOurHttp)),
  };
}

/** Reads a settings file; a file that is not plain JSON is never touched (the error says so). */
export function readSettingsFile(path: string): { current: Settings; raw?: string } {
  if (!existsSync(path)) return { current: {} };
  const raw = readFileSync(path, 'utf8');
  try { return { current: raw.trim() ? JSON.parse(raw) : {}, raw }; }
  catch { throw new Error(`Cannot parse settings file ${path}: not valid JSON, left untouched.`); }
}

/** Writes the new settings after copying the old file to `<path>.bak`. */
export function writeSettingsFile(path: string, next: Settings, hadFile: boolean): void {
  if (hadFile) copyFileSync(path, path + '.bak'); else mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
}
