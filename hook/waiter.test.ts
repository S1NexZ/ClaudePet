import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHookServer } from '../daemon/src/hookHttp.js';
import { createMailbox } from '../daemon/src/mailbox.js';

const script = fileURLToPath(new URL('./pet-hook.mjs', import.meta.url));
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of closers) await c(); closers.length = 0; });

function waiter(home: string, sid = 's1') {
  const p = spawn(process.execPath, [script, 'wait'], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(JSON.stringify({ session_id: sid }));
  const done = new Promise<{ code: number | null; err: string }>((res) => p.on('close', (code) => res({ code, err })));
  return { p, done };
}
async function hub(waitMs = 300) {
  const home = mkdtempSync(join(tmpdir(), 'wt-'));
  const mailbox = createMailbox();
  const srv = await startHookServer({ port: 0, token: 'abcdef0123456789', onEvent: () => {}, mailbox, waitMs });
  closers.push(srv.close);
  mkdirSync(join(home, '.claude-pet'), { recursive: true });
  writeFileSync(join(home, '.claude-pet', 'hub.json'), JSON.stringify({ port: srv.port, token: 'abcdef0123456789' }));
  return { home, mailbox };
}

describe('pet-hook.mjs wait (the mailbox waiter)', () => {
  it('exits 2 with the message on stderr when the pet sends one (keeps polling across timeouts)', async () => {
    const { home, mailbox } = await hub();
    const w = waiter(home);
    await new Promise((r) => setTimeout(r, 800)); // several 204 round trips
    mailbox.send('s1', 'wake up: do the thing');
    const r = await w.done;
    expect(r.code).toBe(2);
    expect(r.err).toBe('wake up: do the thing');
  });
  it('exits 0 quietly when there is no pet (no hub.json) and when another waiter already waits (409)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'wt-'));
    const a = await waiter(empty).done;
    expect([a.code, a.err]).toEqual([0, '']);
    const { home, mailbox } = await hub(2000);
    const first = waiter(home);
    await new Promise((r) => setTimeout(r, 300));
    const second = await waiter(home).done;
    expect(second.code).toBe(0);
    mailbox.send('s1', 'x');
    expect((await first.done).code).toBe(2);
  });
  /** runs the waiter under a parent process whose command line ends with `extra` (like `claude -p "hi"`) */
  const underParent = (home: string, extra: string[]) => spawn(process.execPath, ['-e', `const c=require('child_process').spawn(process.execPath,[${JSON.stringify(script)},'wait'],{env:{...process.env,HOME:${JSON.stringify(home)}},stdio:['pipe','inherit','inherit']});c.stdin.end(JSON.stringify({session_id:'s1'}));c.on('close',(k)=>process.exit(k??9))`, '--', ...extra], { stdio: 'ignore' });
  const exitOf = (p: ReturnType<typeof spawn>) => new Promise<number | null>((r) => p.on('close', r));
  it('a one-shot `claude -p` parent: exits 0 at once instead of holding the run open', async () => {
    const { home } = await hub(2000);
    for (const args of [['claude', '-p', 'hi'], ['/home/u/.local/bin/claude', '--print', 'hi']]) {
      const t0 = Date.now();
      expect(await exitOf(underParent(home, args))).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1500);
    }
  });
  it('a stream-json session (the desktop app runs claude like that) keeps its waiter', async () => {
    const { home, mailbox } = await hub(2000);
    const p = underParent(home, ['claude', '--output-format', 'stream-json', '--input-format', 'stream-json', '-p']);
    await new Promise((r) => setTimeout(r, 500));
    mailbox.send('s1', 'wake');
    expect(await exitOf(p)).toBe(2);
  });
  it('"-p" inside a prompt, or on a process that is not claude, is not a one-shot run', async () => {
    for (const extra of [['claude', 'explain the -p flag'], ['some-tool', '-p', '8080']]) {
      const { home, mailbox } = await hub(2000);
      const p = underParent(home, extra);
      await new Promise((r) => setTimeout(r, 500));
      mailbox.send('s1', 'wake');
      expect(await exitOf(p)).toBe(2);
    }
  });
  it('the pet is down (restarting): the waiter keeps trying while claude lives, and gets the message once the pet is back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wt-'));
    const probe = await startHookServer({ port: 0, token: 'abcdef0123456789', onEvent: () => {}, mailbox: createMailbox(), waitMs: 300 });
    const port = probe.port; await probe.close();
    mkdirSync(join(home, '.claude-pet'), { recursive: true });
    writeFileSync(join(home, '.claude-pet', 'hub.json'), JSON.stringify({ port, token: 'abcdef0123456789' }));
    const p = spawn(process.execPath, [script, 'wait'], { env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PET_WAIT_RETRY_MS: '200' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.stdin.end(JSON.stringify({ session_id: 's1' }));
    const done = new Promise<number | null>((r) => p.on('close', r));
    await new Promise((r) => setTimeout(r, 600));
    expect(p.exitCode).toBeNull(); // still waiting, not gone
    const mailbox = createMailbox();
    const srv = await startHookServer({ port, token: 'abcdef0123456789', onEvent: () => {}, mailbox, waitMs: 300 });
    closers.push(srv.close);
    await new Promise((r) => setTimeout(r, 500));
    mailbox.send('s1', 'back again');
    expect(await done).toBe(2);
    expect(err).toBe('back again');
  });
  it('gives up after the pet has been away for a while (waiters must not pile up)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wt-'));
    const probe = await startHookServer({ port: 0, token: 'abcdef0123456789', onEvent: () => {}, mailbox: createMailbox(), waitMs: 300 });
    const port = probe.port; await probe.close();
    mkdirSync(join(home, '.claude-pet'), { recursive: true });
    writeFileSync(join(home, '.claude-pet', 'hub.json'), JSON.stringify({ port, token: 'abcdef0123456789' }));
    const p = spawn(process.execPath, [script, 'wait'], { env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PET_WAIT_RETRY_MS: '100', CLAUDE_PET_WAIT_DOWN_MS: '500' }, stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.end(JSON.stringify({ session_id: 's1' }));
    const t0 = Date.now();
    expect(await new Promise((r) => p.on('close', r))).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

