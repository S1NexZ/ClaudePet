import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planHooks, runInstall, HOOK_EVENTS } from './installHooks.js';

const HOOK = '/opt/pet/hook/pet-hook.mjs';
const NODE = '/usr/bin/node';
const CMD = `"${NODE}" "${HOOK}" 2>/dev/null || true`;
const cmds = (o: any, ev: string) =>
  (o.hooks?.[ev] ?? []).flatMap((g: any) => g.hooks.map((h: any) => h.command as string));

describe('planHooks', () => {
  it('adds an entry for each of the 8 events, using the absolute node path', () => {
    const { next } = planHooks({}, HOOK, NODE);
    expect(HOOK_EVENTS).toHaveLength(8);
    for (const ev of HOOK_EVENTS) expect(cmds(next, ev)).toEqual([CMD]);
  });
  it('tool events get matcher "*"', () => {
    const { next } = planHooks({}, HOOK, NODE) as any;
    expect(next.hooks.PreToolUse[0].matcher).toBe('*');
    expect(next.hooks.Stop[0].matcher).toBeUndefined();
  });
  it('preserves existing user hooks and unrelated settings', () => {
    const cur = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
    const { next } = planHooks(cur, HOOK, NODE) as any;
    expect(next.model).toBe('opus');
    expect(cmds(next, 'Stop')).toContain('echo mine');
    expect(cmds(next, 'Stop')).toContain(CMD);
  });
  it('is idempotent: second run changes nothing and diff is empty', () => {
    const once = planHooks({}, HOOK, NODE);
    const twice = planHooks(once.next, HOOK, NODE);
    expect(twice.next).toEqual(once.next);
    expect(twice.diff).toBe('');
    expect(cmds(twice.next, 'Stop')).toHaveLength(1);
  });
  it('the hook command never fails Claude Code, even if the app was uninstalled', () => {
    expect(CMD.endsWith('|| true')).toBe(true);
  });
  it('an old entry (older command format) is replaced, not duplicated', () => {
    const old = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${NODE}" "/old/place/pet-hook.mjs"` }] }] } };
    expect(cmds(planHooks(old, HOOK, NODE).next, 'Stop')).toEqual([CMD]);
  });
  it('the diff covers only the hooks section (no noise from unrelated keys)', () => {
    const d = planHooks({ model: 'opus', theme: 'dark' }, HOOK, NODE).diff;
    expect(d).not.toMatch(/model|theme/);
    expect(d).toContain('pet-hook.mjs');
  });
  it('diff marks additions with "+ "', () => {
    expect(planHooks({}, HOOK, NODE).diff).toMatch(/^\+ /m);
  });
});

describe('runInstall', () => {
  const setup = (content?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-'));
    const settingsPath = join(dir, 'settings.json');
    if (content !== undefined) writeFileSync(settingsPath, content);
    return { settingsPath };
  };
  const base = { hookPath: HOOK, nodePath: NODE, out: () => {} };

  it('writes (with .bak) only after "y"', async () => {
    const { settingsPath } = setup('{"model":"opus"}');
    await runInstall({ ...base, settingsPath, yes: false, ask: async () => 'y' });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.Stop).toBeDefined();
    expect(readFileSync(settingsPath + '.bak', 'utf8')).toBe('{"model":"opus"}');
  });
  it.each(['n', '', 'yes please', 'Y '])('refuses to write on answer %j', async (a) => {
    const { settingsPath } = setup('{"model":"opus"}');
    const wrote = await runInstall({ ...base, settingsPath, yes: false, ask: async () => a });
    // exactly "y"/"Y" (trimmed) writes; everything else must not
    expect(wrote).toBe(a.trim().toLowerCase() === 'y');
    if (!wrote) expect(readFileSync(settingsPath, 'utf8')).toBe('{"model":"opus"}');
  });
  it('--yes skips the question; missing settings file is created', async () => {
    const { settingsPath } = setup();
    await runInstall({ ...base, settingsPath, yes: true, ask: async () => { throw new Error('asked'); } });
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(settingsPath + '.bak')).toBe(false);
  });
  it('invalid JSON in settings aborts without touching the file', async () => {
    const { settingsPath } = setup('{oops');
    await expect(runInstall({ ...base, settingsPath, yes: true, ask: async () => 'y' })).rejects.toThrow(/settings/i);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{oops');
  });
});
