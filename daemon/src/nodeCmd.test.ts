import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeCmd, stableHookDir, stableRuntime } from './nodeCmd.js';
import { planHooks } from './installHooks.js';
import { planStatusLine } from './installStatusLine.js';
import { planHostHooks } from './hookConfig.js';
import { procName, parentPid, ttyPath } from './procinfo.js';

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
    expect(parentPid(process.pid)).toBe(process.ppid);
    expect(procName(999999999)).toBeNull();
    expect(parentPid(999999999)).toBe(0);
    expect(ttyPath(999999999)).toBeNull();
  });
});
