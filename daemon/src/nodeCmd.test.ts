import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeCmd, stableHookDir, stableRuntime } from './nodeCmd.js';
import { planHooks } from './installHooks.js';
import { planStatusLine } from './installStatusLine.js';
import { planHostHooks } from './hookConfig.js';
import { procName, ttyPath } from './procinfo.js';

const electron = process.versions as any;
afterEach(() => { delete electron.electron; delete process.env.APPIMAGE; });

describe('nodeCmd', () => {
  it('plain node: just the quoted path', () => expect(nodeCmd('/usr/bin/node')).toBe('"/usr/bin/node"'));
  it('inside Electron: the same binary runs as Node', () => { electron.electron = '33.0.0'; expect(nodeCmd('/opt/x/ccpet')).toBe('ELECTRON_RUN_AS_NODE=1 "/opt/x/ccpet"'); });
  it('an AppImage uses its own file, not the temporary mount', () => {
    electron.electron = '33.0.0'; process.env.APPIMAGE = '/home/u/ccPet.AppImage';
    expect(stableRuntime()).toBe('/home/u/ccPet.AppImage');
  });
  it('hook, status line and mailbox waiter commands carry the prefix and stay recognisable', () => {
    electron.electron = '33.0.0';
    const h = planHooks({}, '/h/pet-hook.mjs', '/opt/ccpet').next as any;
    expect(JSON.stringify(h)).toContain('ELECTRON_RUN_AS_NODE=1 \\"/opt/ccpet\\" \\"/h/pet-hook.mjs\\"');
    const sl = planStatusLine({}, '/h/pet-statusline.mjs', '/opt/ccpet').next as any;
    expect(sl.statusLine.command).toMatch(/^ELECTRON_RUN_AS_NODE=1 "\/opt\/ccpet" "\/h\/pet-statusline\.mjs"/);
    const w = planHostHooks({}, { kind: 'wsl', origin: 'http://127.0.0.1:1', token: 'a'.repeat(16), nodePath: '/opt/ccpet', hookPath: '/h/pet-hook.mjs', permissions: false }).next as any;
    expect(w.hooks.Stop.some((g: any) => g.hooks.some((x: any) => x.asyncRewake && x.command.startsWith('ELECTRON_RUN_AS_NODE=1')))).toBe(true);
  });
});

describe('stableHookDir', () => {
  it('copies the scripts out of the install/mount folder (Electron only) and refreshes changed ones', () => {
    const a = mkdtempSync(join(tmpdir(), 'src-')), b = join(mkdtempSync(join(tmpdir(), 'dst-')), 'bin');
    writeFileSync(join(a, 'pet-hook.mjs'), 'v1'); writeFileSync(join(a, 'pet-statusline.mjs'), 's1');
    expect(stableHookDir(a, b)).toBe(a); // not inside Electron: untouched
    electron.electron = '33.0.0';
    expect(stableHookDir(a, b)).toBe(b);
    expect(readFileSync(join(b, 'pet-hook.mjs'), 'utf8')).toBe('v1');
    writeFileSync(join(a, 'pet-hook.mjs'), 'v2');
    stableHookDir(a, b);
    expect(readFileSync(join(b, 'pet-hook.mjs'), 'utf8')).toBe('v2');
    expect(existsSync(join(b, 'pet-statusline.mjs'))).toBe(true);
  });
});

describe('procinfo', () => {
  it('knows this process and its parent', () => {
    expect(procName(process.pid)).toMatch(/node|vitest|npm/i);
    expect(procName(999999999)).toBeNull();
    expect(ttyPath(999999999)).toBeNull();
  });
});

describe('the native hook (ccpet-hook)', () => {
  const BIN = '/home/u/.claude-pet/bin/ccpet-hook';
  it('is run directly, not through node; old Node commands and the native ones are both ours', async () => {
    const { hookCmd, isNativeHook, isOurHookCommand } = await import('./nodeCmd.js');
    expect(isNativeHook(BIN)).toBe(true);
    expect(isNativeHook('/x/pet-hook.mjs')).toBe(false);
    expect(hookCmd('/usr/bin/node', BIN)).toBe(`"${BIN}"`);
    expect(hookCmd('/usr/bin/node', '/x/pet-hook.mjs')).toBe('"/usr/bin/node" "/x/pet-hook.mjs"');
    expect(isOurHookCommand(`"${BIN}" wait`) && isOurHookCommand('"/n" "/x/pet-hook.mjs"') && !isOurHookCommand('my-own-hook.sh')).toBe(true);
  });
  it('events, waiter and status line commands use the binary; an old Node install is replaced, not doubled', async () => {
    const old = planHostHooks(planHooks({}, '/x/pet-hook.mjs', '/usr/bin/node').next, { kind: 'wsl', origin: 'http://127.0.0.1:1', token: 't', nodePath: '/usr/bin/node', hookPath: '/x/pet-hook.mjs', permissions: false }).next;
    const next = planHostHooks(planHooks(old, BIN, '/usr/bin/node').next, { kind: 'wsl', origin: 'http://127.0.0.1:1', token: 't', nodePath: '/usr/bin/node', hookPath: BIN, permissions: false }).next;
    const commands = Object.values(next.hooks).flat().flatMap((g: any) => g.hooks).map((h: any) => String(h.command ?? ''));
    expect(commands.some((c) => c.includes('pet-hook.mjs'))).toBe(false);
    const { HOOK_EVENTS } = await import('./installHooks.js');
    expect(commands.filter((c) => c === `"${BIN}" 2>/dev/null || true`).length).toBe(HOOK_EVENTS.length);
    expect(next.hooks.SessionStart.flatMap((g: any) => g.hooks).filter((h: any) => h.command === `"${BIN}" wait`).length).toBe(1);
    expect(planStatusLine({}, BIN, '/usr/bin/node').next.statusLine.command).toBe(`"${BIN}" statusline 2>/dev/null || true`);
  });
  it('pickHook takes the binary only when it runs here, else the Node script', async () => {
    const { pickHook } = await import('./nodeCmd.js');
    const dir = mkdtempSync(join(tmpdir(), 'nh-'));
    expect(pickHook(dir)).toBe(join(dir, 'pet-hook.mjs'));
    writeFileSync(join(dir, 'ccpet-hook'), 'not a program', { mode: 0o755 });
    expect(pickHook(dir)).toBe(join(dir, 'pet-hook.mjs'));
    writeFileSync(join(dir, 'ccpet-hook'), '#!/bin/sh\necho "ccpet-hook 0.7.0"\n', { mode: 0o755 });
    expect(pickHook(dir)).toBe(join(dir, 'ccpet-hook'));
  });
});
