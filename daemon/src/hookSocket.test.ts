import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenHooks } from './hookSocket.js';

const HOOK = fileURLToPath(new URL('../../hook/pet-hook.mjs', import.meta.url));
const sock = () => join(mkdtempSync(join(tmpdir(), 'hs-')), 'hook.sock');
const closers: Array<() => unknown> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

function runHook(path: string, input: string) {
  return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [HOOK], { env: { ...process.env, CLAUDE_PET_SOCK: path } });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('close', (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
    p.stdin.end(input);
  });
}
const EVENT = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'h1', cwd: '/p', transcript_path: '/t.jsonl' });

describe('hook socket', () => {
  it('the hook script delivers its event to the bridge socket', async () => {
    const path = sock(); const got: any[] = [];
    const srv = await listenHooks(path, (e) => got.push(e)); closers.push(srv.close);
    const r = await runHook(path, EVENT);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(got).toEqual([{ ...JSON.parse(EVENT), pet_parents: expect.any(Array) }]);
  });
  it('app not running (no socket): hook exits 0 fast and silently', async () => {
    const r = await runHook(sock(), EVENT);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(600);
  });
  it('garbage and oversized input never reach the handler; server keeps working', async () => {
    const path = sock(); const got: any[] = [];
    const srv = await listenHooks(path, (e) => got.push(e)); closers.push(srv.close);
    await new Promise<void>((res) => { const c = connect(path, () => c.end('{nope')); c.on('close', () => res()); });
    await new Promise<void>((res) => { const c = connect(path, () => c.end('x'.repeat(2_000_000))); c.on('close', () => res()); c.on('error', () => res()); });
    await new Promise<void>((res) => { const c = connect(path, () => c.end(JSON.stringify({ session_id: 1 }))); c.on('close', () => res()); });
    expect((await runHook(path, EVENT)).code).toBe(0);
    expect(got).toHaveLength(1);
  });
  it('a stale socket file left by a crash is replaced; a live one is refused', async () => {
    const path = sock();
    writeFileSync(path, '');
    const a = await listenHooks(path, () => {}); closers.push(a.close);
    await expect(listenHooks(path, () => {})).rejects.toThrow(/already running/i);
    await a.close();
    expect(existsSync(path)).toBe(false);
  });

  it('the hook adds its parent process chain (to find the claude process later)', async () => {
    const path = sock(); const got: any[] = [];
    const srv = await listenHooks(path, (e) => got.push(e)); closers.push(srv.close);
    await runHook(path, EVENT);
    expect(Array.isArray(got[0].pet_parents)).toBe(true);
    expect(got[0].pet_parents[0]).toBe(process.pid); // the test spawned the hook directly
    expect(got[0].pet_parents.every((p: unknown) => Number.isInteger(p))).toBe(true);
  });
});
