import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowsHost } from './windowsHost.js';
import type { BridgeMessage } from '../../../shared/src/types.js';

const hosts: Array<ReturnType<typeof createWindowsHost>> = [];
afterEach(async () => { for (const h of hosts) await h.stop(); hosts.length = 0; });

function boot(over: { permissions?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wh-'));
  const out: BridgeMessage[] = [];
  const claudeHome = join(dir, '.claude');
  const host = createWindowsHost({ dataDir: join(dir, 'data'), claudeHome, port: 0, helperPath: 'C:\\pet\\pet-helper.exe', out: (m) => out.push(m), permissionsFromPet: () => over.permissions ?? false });
  hosts.push(host);
  return { host, out, claudeHome };
}
const send = (host: ReturnType<typeof createWindowsHost>, ev: string, body: object) =>
  fetch(`http://127.0.0.1:${host.port}/hook/${host.token}/${ev}`, { method: 'POST', body: JSON.stringify({ hook_event_name: ev, session_id: 'w1', cwd: 'C:\\Users\\x\\proj', ...body }) });

describe('windows host', () => {
  it('turns hook events from a Windows terminal into sessions with the right project name', async () => {
    const { host, out } = boot();
    expect(await host.start()).toBe(true);
    await send(host, 'UserPromptSubmit', {});
    const snap = [...out].reverse().find((m) => m.type === 'snapshot') as any;
    expect(snap.sessions[0]).toMatchObject({ id: 'w1', project: 'proj', state: 'thinking' });
  });
  it('keeps the same token between runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const mk = () => createWindowsHost({ dataDir: dir, claudeHome: join(dir, '.claude'), port: 0, out: () => {}, permissionsFromPet: () => false });
    expect(mk().token).toBe(mk().token);
  });
  it('a message to a session without a PTY is delivered through the mailbox long-poll', async () => {
    const { host } = boot();
    await host.start();
    await send(host, 'SessionStart', {});
    const poll = fetch(`http://127.0.0.1:${host.port}/mailbox/${host.token}/w1`);
    await new Promise((r) => setTimeout(r, 50));
    await host.handle({ type: 'send', sessionId: 'w1', text: 'привет' });
    const r = await poll;
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('[ccPet message] привет');
  });
  it('answers a PermissionRequest from the pet only when the setting is on', async () => {
    const { host } = boot({ permissions: true });
    await host.start();
    await send(host, 'SessionStart', {});
    const pending = send(host, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    await new Promise((r) => setTimeout(r, 50));
    host.snapshot();
    await host.handle({ type: 'permission', id: 'hp-1', allow: true });
    const r = await pending;
    expect(await r.json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });
  it('installs and removes its hooks in the Windows settings.json, leaving the user\'s own', async () => {
    const { host, claudeHome } = boot();
    await host.start();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(claudeHome, { recursive: true });
    const mine = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk' }] }] }, theme: 'dark' };
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify(mine));
    const st = host.state(false);
    expect(st).toMatchObject({ events: false, mailbox: false });
    expect(st.diff).toContain('/hook/');
    expect(host.apply(false).applied).toBe(true);
    expect(host.state(false)).toMatchObject({ events: true, mailbox: true, permissions: false, diff: '' });
    expect(JSON.parse(readFileSync(join(claudeHome, 'settings.json.bak'), 'utf8'))).toEqual(mine);
    expect(host.remove().applied).toBe(true);
    expect(JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8'))).toEqual(mine);
  });
  it('reports a busy port instead of failing silently', async () => {
    const a = boot(); await a.host.start();
    const out: BridgeMessage[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const b = createWindowsHost({ dataDir: dir, claudeHome: join(dir, '.claude'), port: a.host.port, out: (m) => out.push(m), permissionsFromPet: () => false });
    expect(await b.start()).toBe(false);
    expect(out[0]).toMatchObject({ type: 'error' });
  });
  it('refuses to touch a settings.json that is not valid JSON', async () => {
    const { host, claudeHome } = boot();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, 'settings.json'), '{ // comment\n}');
    expect(host.state(false).error).toMatch(/not valid JSON/);
    expect(() => host.apply(false)).toThrow(/not valid JSON/);
  });
});

describe('windows host: adoption', () => {
  it('adopts a recently written transcript as an idle session of the right front end (no hook needed)', async () => {
    const { host, claudeHome, out } = boot();
    await host.start();
    const { mkdirSync } = await import('node:fs');
    const dir = join(claudeHome, 'projects', 'C--Users-x-app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'abc-123.jsonl'), JSON.stringify({ type: 'user', entrypoint: 'claude-desktop', cwd: 'C:\\Users\\x\\app' }) + '\n');
    host.tick(Date.now());
    await new Promise((r) => setTimeout(r, 300));
    host.tick(Date.now() + 2000);
    const snap = [...out].reverse().find((m) => m.type === 'snapshot') as any;
    expect(snap.sessions[0]).toMatchObject({ id: 'abc-123', project: 'app', state: 'idle', source: 'claude-desktop' });
  });
});
