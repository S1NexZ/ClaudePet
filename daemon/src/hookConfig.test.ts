import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planHostHooks, removeHostHooks, hooksStatus, readSettingsFile, writeSettingsFile, type HookPlanOpts } from './hookConfig.js';
import { planHooks } from './installHooks.js';

const win: HookPlanOpts = { kind: 'windows', origin: 'http://127.0.0.1:47821', token: 'ab12cd', helperPath: 'C:\\pet\\pet-helper.exe', permissions: false };
const wsl: HookPlanOpts = { kind: 'wsl', origin: 'http://127.0.0.1:47822', token: 'ab12cd', nodePath: '/usr/bin/node', hookPath: '/opt/pet/pet-hook.mjs', permissions: false };
const mine = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk-rewrite' }] }] }, theme: 'dark' };

describe('hookConfig (windows)', () => {
  it('adds http hooks for every event plus the mailbox waiter, next to the user\'s own hook', () => {
    const { next, diff } = planHostHooks(mine, win);
    expect(diff).not.toBe('');
    const pre = next.hooks.PreToolUse;
    expect(pre[0]).toEqual(mine.hooks.PreToolUse[0]);
    expect(pre[1].hooks[0]).toEqual({ type: 'http', url: 'http://127.0.0.1:47821/hook/ab12cd/PreToolUse', timeout: 5 });
    expect(next.hooks.Stop.some((g: any) => g.hooks[0].asyncRewake === true && g.hooks[0].args[0] === 'wait')).toBe(true);
    expect(next.hooks.SessionStart.some((g: any) => g.hooks[0].asyncRewake === true)).toBe(true);
    expect(next.theme).toBe('dark');
    expect(hooksStatus(next, 'windows')).toEqual({ events: true, mailbox: true, permissions: false });
  });
  it('is idempotent and replaces entries of an older token instead of duplicating them', () => {
    const once = planHostHooks(mine, win).next;
    expect(planHostHooks(once, win).diff).toBe('');
    const again = planHostHooks(once, { ...win, token: 'ff00ee' }).next;
    expect(JSON.stringify(again)).not.toContain('ab12cd');
    expect(again.hooks.Stop.filter((g: any) => g.hooks[0].type === 'http')).toHaveLength(1);
  });
  it('adds the PermissionRequest hook only when asked, with a timeout above the pet\'s own', () => {
    const off = planHostHooks({}, win).next;
    expect(off.hooks.PermissionRequest).toEqual([{ matcher: 'AskUserQuestion', hooks: [{ type: 'http', url: 'http://127.0.0.1:47821/hook/ab12cd/PermissionRequest', timeout: 600 }] }]);
    expect(hooksStatus(off, 'windows').permissions).toBe(false); // Claude's questions are not tool permissions
    const { next } = planHostHooks({}, { ...win, permissions: true });
    expect(next.hooks.PermissionRequest[0].hooks[0]).toEqual({ type: 'http', url: 'http://127.0.0.1:47821/hook/ab12cd/PermissionRequest', timeout: 35 });
    expect(hooksStatus(next, 'windows').permissions).toBe(true);
  });
  it('removal takes only our entries and gives back the user\'s settings unchanged', () => {
    const installed = planHostHooks(mine, { ...win, permissions: true }).next;
    expect(removeHostHooks(installed).next).toEqual(mine);
    expect(removeHostHooks(mine).diff).toBe('');
    expect(hooksStatus(removeHostHooks(installed).next, 'windows')).toEqual({ events: false, mailbox: false, permissions: false });
  });
});

describe('hookConfig (wsl)', () => {
  it('adds only the waiter (and permission) and leaves the existing command hook alone', () => {
    const withEvents = planHooks(mine, '/opt/pet/pet-hook.mjs', '/usr/bin/node').next;
    const { next } = planHostHooks(withEvents, { ...wsl, permissions: true });
    expect(hooksStatus(next, 'wsl')).toEqual({ events: true, mailbox: true, permissions: true });
    expect(next.hooks.Stop.filter((g: any) => /pet-hook\.mjs" wait/.test(g.hooks[0].command))).toHaveLength(1);
    // re-running the old events installer must not wipe the waiter
    const reinstalled = planHooks(next, '/opt/pet/pet-hook.mjs', '/usr/bin/node').next;
    expect(hooksStatus(reinstalled, 'wsl').mailbox).toBe(true);
  });
});

describe('settings files', () => {
  it('writes a .bak copy first; a file that is not JSON is never touched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-hc-'));
    const f = join(dir, 'settings.json');
    writeFileSync(f, JSON.stringify(mine));
    const r = readSettingsFile(f);
    writeSettingsFile(f, planHostHooks(r.current, win).next, r.raw !== undefined);
    expect(JSON.parse(readFileSync(f + '.bak', 'utf8'))).toEqual(mine);
    expect(JSON.parse(readFileSync(f, 'utf8')).hooks.PreToolUse).toHaveLength(2);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ // comment\n "a": 1 }');
    expect(() => readSettingsFile(bad)).toThrow(/not valid JSON/);
    expect(readFileSync(bad, 'utf8')).toContain('comment');
    expect(existsSync(bad + '.bak')).toBe(false);
    expect(readSettingsFile(join(dir, 'missing.json')).current).toEqual({});
  });
});
