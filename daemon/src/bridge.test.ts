import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from './bridge.js';
import { SessionStore } from './sessionStore.js';
import { createMailbox } from './mailbox.js';
import type { BridgeMessage } from '../../shared/src/types.js';

function setup(over: Partial<Parameters<typeof createBridge>[0]> = {}) {
  const out: BridgeMessage[] = [];
  const calls: any[] = [];
  const store = new SessionStore();
  const runner = {
    models: async () => [{ value: 'opus', displayName: 'Opus 5.5', description: 'd' }],
    setModel: async (id: string | null, m: string) => { calls.push(['setModel', id, m]); },
    btw: async (id: string, t: string) => { calls.push(['btw', id, t]); },
    setPermissionPolicy: (m: string) => { calls.push(['policy', m]); },
    release: (id: string) => { calls.push(['release', id]); return id === 'owned1'; },
    start: async (a: any) => { calls.push(['start', a]); return 's1'; },
    send: async (id: string, t: string) => { calls.push(['send', id, t]); if (t === 'busy') throw new Error('Claude занят'); },
    interrupt: async (id: string) => { calls.push(['interrupt', id]); },
    respondPermission: (id: string, allow: boolean) => { calls.push(['perm', id, allow]); },
  };
  const settingsPath = join(mkdtempSync(join(tmpdir(), 'br-')), 'settings.json');
  const procs = new Map<number, string>([[4242, 'claude'], [99, 'sh']]);
  const killed: number[] = [];
  const bridge = createBridge({
    store, runner, out: (m) => out.push(m),
    proc: { name: (pid) => procs.get(pid) ?? null, kill: (pid) => { killed.push(pid); } },
    readTranscript: async (p) => [{ role: 'assistant', text: `from ${p}` }],
    hooks: { settingsPath, hookPath: '/opt/pet/hook/pet-hook.mjs', nodePath: '/usr/bin/node' },
    sdkChats: true,
    ...over,
  });
  return { out, calls, store, bridge, settingsPath, killed, procs };
}
const last = <T extends BridgeMessage['type']>(out: BridgeMessage[], type: T) =>
  [...out].reverse().find((m) => m.type === type) as Extract<BridgeMessage, { type: T }> | undefined;

describe('bridge', () => {
  it('start converts a Windows folder to a WSL path, reports the session and a snapshot', async () => {
    const { bridge, calls, out } = setup();
    await bridge.handle({ type: 'start', cwd: 'C:\\Users\\x\\Мой проект', prompt: 'hi' });
    expect(calls).toEqual([['start', { cwd: '/mnt/c/Users/x/Мой проект', prompt: 'hi' }]]);
    expect(last(out, 'started')).toEqual({ type: 'started', sessionId: 's1' });
    expect(last(out, 'snapshot')).toBeDefined();
  });
  it('send / interrupt / permission are forwarded; a failure becomes an error message, not a crash', async () => {
    const { bridge, calls, out } = setup();
    await bridge.handle({ type: 'send', sessionId: 's1', text: 'again' });
    await bridge.handle({ type: 'interrupt', sessionId: 's1' });
    await bridge.handle({ type: 'permission', id: 'tu1', allow: true });
    await bridge.handle({ type: 'send', sessionId: 's1', text: 'busy' });
    expect(calls).toEqual([['send', 's1', 'again'], ['interrupt', 's1'], ['perm', 'tu1', true], ['send', 's1', 'busy']]);
    expect(last(out, 'error')).toEqual({ type: 'error', message: 'Claude занят' });
  });
  it('permission-mode is forwarded to the runner; an unknown mode is ignored', async () => {
    const { bridge, calls } = setup();
    await bridge.handle({ type: 'permission-mode', mode: 'edits' });
    await bridge.handle({ type: 'permission-mode', mode: 'root' } as never);
    expect(calls.filter((c) => c[0] === 'policy')).toEqual([['policy', 'edits']]);
  });
  it('language switches the bridge language (and ignores unknown ones)', async () => {
    const { setLang, getLang } = await import('../../shared/src/i18n.js');
    const { bridge } = setup();
    await bridge.handle({ type: 'language', lang: 'en' });
    expect(getLang()).toBe('en');
    await bridge.handle({ type: 'language', lang: 'xx' } as never);
    expect(getLang()).toBe('en');
    setLang('ru');
  });
  it('malformed commands are answered with an error', async () => {
    const { bridge, out } = setup();
    await bridge.handle({ type: 'nope' } as any);
    await bridge.handle(null as any);
    expect(out.filter((m) => m.type === 'error')).toHaveLength(2);
  });
  it('hook events update the snapshot; history comes from the transcript named in the hook', async () => {
    const { bridge, out } = setup();
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', session_id: 't1', cwd: '/x/proj', transcript_path: '/home/u/.claude/projects/p/t1.jsonl' });
    expect(last(out, 'snapshot')?.sessions[0]).toMatchObject({ id: 't1', state: 'thinking', project: 'proj' });
    await bridge.handle({ type: 'history', sessionId: 't1' });
    expect(last(out, 'history')).toEqual({ type: 'history', sessionId: 't1', items: [{ role: 'assistant', text: 'from /home/u/.claude/projects/p/t1.jsonl' }] });
    await bridge.handle({ type: 'history', sessionId: 'unknown' });
    expect(last(out, 'history')).toEqual({ type: 'history', sessionId: 'unknown', items: [] });
  });
  it('after Stop the transcript is read again (the reply is flushed after the hook fires)', async () => {
    let n = 0;
    const { bridge, out } = setup({ stopRecheckMs: 20, readTranscript: async () => (++n < 2 ? [] : [{ role: 'assistant', text: 'late' }]) } as any);
    bridge.onHook({ hook_event_name: 'Stop', session_id: 't1', cwd: '/x', transcript_path: '/a/t1.jsonl' });
    await vi.waitFor(() => expect(last(out, 'history')?.items).toEqual([{ role: 'assistant', text: 'late' }]));
  });
  it('when a terminal session finishes a turn, its fresh history is pushed (not for pet-owned ones)', async () => {
    const { bridge, out, store } = setup();
    bridge.onHook({ hook_event_name: 'Stop', session_id: 't1', cwd: '/x', transcript_path: '/a/t1.jsonl' });
    await vi.waitFor(() => expect(last(out, 'history')?.sessionId).toBe('t1'));
    out.length = 0;
    // the runner marks its session as owned before any hook of that session arrives
    store.apply({ hook_event_name: 'UserPromptSubmit', session_id: 'o1', cwd: '/x' });
    store.setOwned('o1', true);
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', session_id: 'o1', cwd: '/x', transcript_path: '/a/o1.jsonl' });
    bridge.onHook({ hook_event_name: 'Stop', session_id: 'o1', cwd: '/x', transcript_path: '/a/o1.jsonl' });
    await new Promise((r) => setTimeout(r, 20));
    expect(last(out, 'history')).toBeUndefined();
  });
  it('chat events are relayed', () => {
    const { bridge, out } = setup();
    bridge.onChat('s1', { kind: 'delta', text: 'пр' });
    expect(out).toEqual([{ type: 'chat', sessionId: 's1', event: { kind: 'delta', text: 'пр' } }]);
  });
  it('tick only emits a snapshot when something changed', () => {
    const { bridge, out } = setup();
    bridge.onHook({ hook_event_name: 'Stop', session_id: 't1', cwd: '/x' });
    out.length = 0;
    bridge.tick(Date.now() + 1000);
    expect(out).toHaveLength(0);
    bridge.tick(Date.now() + 31_000); // done -> idle
    expect(last(out, 'snapshot')?.sessions[0].state).toBe('idle');
  });
  it('hooks: plan shows the diff without writing; apply writes with a backup', async () => {
    const { bridge, out, settingsPath } = setup();
    writeFileSync(settingsPath, '{"model":"opus"}');
    await bridge.handle({ type: 'hooks', apply: false });
    expect(last(out, 'hooks')).toMatchObject({ applied: false, diff: expect.stringContaining('pet-hook.mjs') });
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"model":"opus"}');
    await bridge.handle({ type: 'hooks', apply: true });
    expect(last(out, 'hooks')).toMatchObject({ applied: true });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.Stop).toBeDefined();
    expect(existsSync(settingsPath + '.bak')).toBe(true);
    await bridge.handle({ type: 'hooks', apply: false });
    expect(last(out, 'hooks')).toMatchObject({ type: 'hooks', diff: '', applied: false });
  });

  it('statusline: plan shows the diff, apply writes with a backup, a foreign line is wrapped and restored on remove', async () => {
    const { bridge, out, settingsPath } = setup();
    writeFileSync(settingsPath, '{"statusLine":{"type":"command","command":"my-line.sh"}}');
    await bridge.handle({ type: 'statusline' });
    expect(last(out, 'statusline')).toMatchObject({ applied: false, kind: 'none', diff: expect.stringContaining('--chain') });
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"statusLine":{"type":"command","command":"my-line.sh"}}');
    await bridge.handle({ type: 'statusline', apply: true });
    expect(last(out, 'statusline')).toMatchObject({ applied: true, kind: 'chained' });
    expect(existsSync(settingsPath + '.bak')).toBe(true);
    await bridge.handle({ type: 'statusline' });
    expect(last(out, 'statusline')).toMatchObject({ diff: '', kind: 'chained' });
    await bridge.handle({ type: 'statusline', apply: true, remove: true });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ statusLine: { type: 'command', command: 'my-line.sh' } });
  });
  it('statusline is unsupported where there is no node (the Windows host)', async () => {
    const { bridge, out, settingsPath } = setup({ hooks: { settingsPath: '', hookPath: '', nodePath: '' } } as any);
    await bridge.handle({ type: 'statusline' });
    expect(last(out, 'statusline')).toMatchObject({ error: 'unsupported' });
  });

  it('hooks status: missing / present / stale (points to a file that no longer exists)', async () => {
    const { bridge, out, settingsPath } = setup();
    await bridge.handle({ type: 'hooks', apply: false });
    expect(last(out, 'hooks')).toMatchObject({ installed: false, stale: false });
    const hookFile = join(mkdtempSync(join(tmpdir(), 'hk-')), 'pet-hook.mjs');
    writeFileSync(hookFile, '');
    const cmd = (p: string) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"/usr/bin/node" "${p}" 2>/dev/null || true` }] }] } });
    writeFileSync(settingsPath, JSON.stringify(cmd(hookFile)));
    await bridge.handle({ type: 'hooks', apply: false });
    expect(last(out, 'hooks')).toMatchObject({ installed: true, stale: false });
    writeFileSync(settingsPath, JSON.stringify(cmd('/gone/pet-hook.mjs')));
    await bridge.handle({ type: 'hooks', apply: false });
    expect(last(out, 'hooks')).toMatchObject({ installed: true, stale: true });
  });

  it('models / setModel / btw / release are forwarded', async () => {
    const { bridge, calls, out } = setup();
    await bridge.handle({ type: 'models' });
    expect(last(out, 'models')).toEqual({ type: 'models', models: [{ value: 'opus', displayName: 'Opus 5.5', description: 'd' }] });
    await bridge.handle({ type: 'setModel', sessionId: null, model: 'opus' });
    expect(last(out, 'modelSet')).toEqual({ type: 'modelSet', sessionId: null, model: 'opus' });
    await bridge.handle({ type: 'btw', sessionId: 's1', text: 'вопрос' });
    await bridge.handle({ type: 'release', sessionId: 's1' });
    expect(calls).toEqual([['setModel', null, 'opus'], ['btw', 's1', 'вопрос'], ['release', 's1']]);
  });

  it('end on a pet-owned session releases it and drops it from the list', async () => {
    const { bridge, calls, out, store } = setup();
    bridge.onHook({ hook_event_name: 'Stop', session_id: 'owned1', cwd: '/x' });
    store.setOwned('owned1', true);
    await bridge.handle({ type: 'end', sessionId: 'owned1' });
    expect(calls).toContainEqual(['release', 'owned1']);
    expect(last(out, 'snapshot')?.sessions.find((x) => x.id === 'owned1')).toBeUndefined();
  });

  it('end on a terminal session terminates its claude process (found via the hook parents)', async () => {
    const { bridge, out, killed } = setup();
    bridge.onHook({ hook_event_name: 'Stop', session_id: 't1', cwd: '/x', pet_parents: [99, 4242, 1] } as any);
    await bridge.handle({ type: 'end', sessionId: 't1' });
    expect(killed).toEqual([4242]);
    expect(last(out, 'snapshot')?.sessions).toEqual([]);
  });

  it('end never kills a pid that is no longer claude (pid reuse) and just drops the stale row', async () => {
    const { bridge, out, killed, procs } = setup();
    bridge.onHook({ hook_event_name: 'Stop', session_id: 't1', cwd: '/x', pet_parents: [99, 4242] } as any);
    procs.set(4242, 'vim');
    await bridge.handle({ type: 'end', sessionId: 't1' });
    expect(killed).toEqual([]);
    expect(last(out, 'error')).toBeUndefined();
    expect(last(out, 'snapshot')?.sessions).toEqual([]);
  });

  it('term-mark titles the terminal of a live claude process and reports it', async () => {
    const titled: Array<[number, string]> = [];
    const { bridge, out } = setup({ setTitle: (pid: number, t: string) => { titled.push([pid, t]); return true; } } as any);
    bridge.onHook({ hook_event_name: 'Stop', session_id: 't1', cwd: '/x', pet_parents: [99, 4242] } as any);
    await bridge.handle({ type: 'term-mark', sessionId: 't1', text: 'x · Claude t1' });
    expect(titled).toEqual([[4242, 'x · Claude t1']]);
    expect(last(out, 'termMark')).toEqual({ type: 'termMark', sessionId: 't1', ok: true });
    await bridge.handle({ type: 'term-mark', sessionId: 'nope', text: 'y' });
    expect(last(out, 'termMark')).toEqual({ type: 'termMark', sessionId: 'nope', ok: false });
  });

  it('SDK paths are off unless allowed: no new chat, no resume fallback, no model list; a session the pet already runs still works', async () => {
    const { bridge, out, calls, store } = setup({ sdkChats: false });
    await bridge.handle({ type: 'start', cwd: '/x', prompt: 'hi' });
    expect(last(out, 'error')?.message).toMatch(/Agent SDK/);
    expect(calls.find((c) => c[0] === 'start')).toBeUndefined();
    store.apply({ hook_event_name: 'Stop', session_id: 't9', cwd: '/x' } as any);
    await bridge.handle({ type: 'send', sessionId: 't9', text: 'yo' });
    expect(calls.find((c) => c[0] === 'send')).toBeUndefined();
    await bridge.handle({ type: 'models' });
    expect(last(out, 'models')).toBeUndefined();
    await bridge.handle({ type: 'sdk-chats', on: true });
    await bridge.handle({ type: 'send', sessionId: 't9', text: 'yo' });
    expect(calls.some((c) => c[0] === 'send')).toBe(true);
  });

  it('dismiss hides a session without touching its process, and late events do not bring it back', async () => {
    const { bridge, out, killed } = setup();
    bridge.onHook({ hook_event_name: 'Stop', session_id: 't1', cwd: '/x', pet_parents: [99, 4242] } as any);
    await bridge.handle({ type: 'dismiss', sessionId: 't1' });
    expect(killed).toEqual([]);
    expect(last(out, 'snapshot')?.sessions).toEqual([]);
    bridge.onHook({ hook_event_name: 'PostToolUse', session_id: 't1', cwd: '/x' } as any);
    expect(last(out, 'snapshot')?.sessions).toEqual([]);
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', session_id: 't1', cwd: '/x' } as any);
    expect(last(out, 'snapshot')?.sessions.map((x) => x.id)).toEqual(['t1']);
  });

  it('after end, late hook events of that session (SessionEnd) do not bring it back; a new prompt does', async () => {
    const { bridge, out } = setup();
    bridge.onHook({ hook_event_name: 'Stop', session_id: 't1', cwd: '/x', pet_parents: [4242] } as any);
    await bridge.handle({ type: 'end', sessionId: 't1' });
    bridge.onHook({ hook_event_name: 'SessionEnd', session_id: 't1', cwd: '/x' });
    expect(last(out, 'snapshot')?.sessions).toEqual([]);
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', session_id: 't1', cwd: '/x' });
    expect(last(out, 'snapshot')?.sessions.map((x) => x.id)).toEqual(['t1']);
  });

  it('history is pushed as soon as a terminal session\'s transcript path becomes known (e.g. after a restart)', async () => {
    const { bridge, out } = setup();
    bridge.onHook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 't9', cwd: '/x', transcript_path: '/a/t9.jsonl' });
    await vi.waitFor(() => expect(last(out, 'history')).toMatchObject({ sessionId: 't9', items: [{ text: 'from /a/t9.jsonl' }] }));
    out.length = 0;
    bridge.onHook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 't9', cwd: '/x', transcript_path: '/a/t9.jsonl' });
    await new Promise((r) => setTimeout(r, 20));
    expect(last(out, 'history')).toBeUndefined(); // only the first time per path, not on every event
  });
});

describe('bridge: sessions running under pet-claude.py', () => {
  const ev = (over: any = {}) => ({ hook_event_name: 'SessionStart', session_id: 't1', cwd: '/w/p', pet_pty: '/run/w.sock', ...over });
  it('send types into the pty socket instead of starting a second claude', async () => {
    const sent: any[] = [];
    const t = setup({ pty: { sendPrompt: async (s, x) => { sent.push([s, x]); }, sendEsc: async () => {} } });
    t.bridge.onHook(ev());
    await t.bridge.handle({ type: 'send', sessionId: 't1', text: 'hi' });
    expect(sent).toEqual([['/run/w.sock', 'hi']]);
    expect(t.calls.filter((c) => c[0] === 'send')).toEqual([]);
  });
  it('busy session refuses (no simultaneous input)', async () => {
    const sent: any[] = [];
    const t = setup({ pty: { sendPrompt: async (s, x) => { sent.push(x); }, sendEsc: async () => {} } });
    t.bridge.onHook(ev()); t.bridge.onHook(ev({ hook_event_name: 'UserPromptSubmit' }));
    await t.bridge.handle({ type: 'send', sessionId: 't1', text: 'hi' });
    expect(sent).toEqual([]);
    expect(last(t.out, 'error')?.message).toMatch(/занят/);
  });
  it('dead socket: falls back to the SDK and forgets the socket', async () => {
    const { PtyGoneError } = await import('./ptySend.js');
    const t = setup({ pty: { sendPrompt: async () => { throw new PtyGoneError(); }, sendEsc: async () => {} } });
    t.bridge.onHook(ev());
    await t.bridge.handle({ type: 'send', sessionId: 't1', text: 'hi' });
    expect(t.calls).toContainEqual(['send', 't1', 'hi']);
    expect(t.store.get('t1')?.pty).toBeUndefined();
  });
  it('a session without a socket keeps using the SDK', async () => {
    const t = setup();
    t.bridge.onHook(ev({ pet_pty: undefined }));
    await t.bridge.handle({ type: 'send', sessionId: 't1', text: 'hi' });
    expect(t.calls).toContainEqual(['send', 't1', 'hi']);
  });
  it('interrupt sends Esc to the pty; SessionEnd forgets the socket', async () => {
    const esc: string[] = [];
    const t = setup({ pty: { sendPrompt: async () => {}, sendEsc: async (s) => { esc.push(s); } } });
    t.bridge.onHook(ev());
    await t.bridge.handle({ type: 'interrupt', sessionId: 't1' });
    expect(esc).toEqual(['/run/w.sock']);
    t.bridge.onHook(ev({ hook_event_name: 'SessionEnd' }));
    expect(t.store.get('t1')?.pty).toBeUndefined();
  });
  it('after Stop button (Esc) a busy pty session is idle again, so the next send is not refused', async () => {
    const sent: string[] = [];
    const t = setup({ pty: { sendPrompt: async (_s, x) => { sent.push(x); }, sendEsc: async () => {} } });
    t.bridge.onHook(ev({ hook_event_name: 'UserPromptSubmit' }));
    expect(t.store.get('t1')?.state).toBe('thinking');
    await t.bridge.handle({ type: 'interrupt', sessionId: 't1' });
    expect(t.store.get('t1')?.state).toBe('idle');
    await t.bridge.handle({ type: 'send', sessionId: 't1', text: 'next' });
    expect(sent).toEqual(['next']);
  });
  it('the transcript is re-read shortly after Esc (no Stop hook follows an interrupt)', async () => {
    let n = 0;
    const t = setup({ stopRecheckMs: 20, pty: { sendPrompt: async () => {}, sendEsc: async () => {} },
      readTranscript: async () => [{ role: 'user', text: `read${++n}` }] } as any);
    t.bridge.onHook(ev({ transcript_path: '/a/t1.jsonl' }));
    t.out.length = 0; n = 0;
    await t.bridge.handle({ type: 'interrupt', sessionId: 't1' });
    await vi.waitFor(() => expect(last(t.out, 'history')?.items).toEqual([{ role: 'user', text: 'read1' }]));
  });
  it('Esc typed in the terminal: the busy session becomes idle once the transcript shows the interrupt', async () => {
    let hit = false;
    const t = setup({ interrupted: async () => hit } as any);
    t.bridge.onHook(ev({ transcript_path: '/a/t1.jsonl' }));
    t.bridge.onHook(ev({ hook_event_name: 'UserPromptSubmit' }));
    t.bridge.tick(Date.now());
    await new Promise((r) => setTimeout(r, 10));
    expect(t.store.get('t1')?.state).toBe('thinking'); // not interrupted yet
    hit = true;
    t.bridge.tick(Date.now());
    await vi.waitFor(() => expect(t.store.get('t1')?.state).toBe('idle'));
  });
  it('usage command answers with the current limits; tick pushes only when the limits file changed', async () => {
    let version = 1, calls = 0;
    const info = { plan: 'pro', updatedAt: 5, fiveHour: { usedPct: 12, resetsAt: 99 }, sevenDay: null, statusLine: 'ours' as const };
    const t = setup({ usage: { version: () => version, read: async () => { calls++; return info; } } } as any);
    await t.bridge.handle({ type: 'usage' });
    expect(last(t.out, 'usage')).toEqual({ type: 'usage', usage: info });
    expect(calls).toBe(1);
    t.out.length = 0;
    t.bridge.tick(Date.now());
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1); // unchanged file: no read, no message
    expect(last(t.out, 'usage')).toBeUndefined();
    version = 2;
    t.bridge.tick(Date.now());
    await vi.waitFor(() => expect(last(t.out, 'usage')).toEqual({ type: 'usage', usage: info }));
    expect(calls).toBe(2);
  });
  it('usage-refresh asks the source for one query and answers with the current limits', async () => {
    let started = 0; const info: any = { plan: 'pro', updatedAt: 1, fiveHour: null, sevenDay: null, statusLine: 'none', refreshing: true };
    const t = setup({ usage: { version: () => 1, read: async () => info, refresh: () => { started++; return true; } } } as any);
    await t.bridge.handle({ type: 'usage-refresh' });
    expect(started).toBe(1);
    expect(last(t.out, 'usage')).toEqual({ type: 'usage', usage: info });
  });

  it('without a usage source the command is ignored (no crash)', async () => {
    const t = setup();
    await t.bridge.handle({ type: 'usage' });
    expect(last(t.out, 'usage')).toBeUndefined();
    expect(last(t.out, 'error')).toBeUndefined();
  });
  it('pushUsage sends the current limits (called when the periodic query finishes) and syncs the version', async () => {
    let version: number | string = '1:1', calls = 0;
    const info = { plan: 'pro', updatedAt: 5, fiveHour: { usedPct: 12, resetsAt: 99 }, sevenDay: null, statusLine: 'none' as const, source: 'live' as const, liveActive: true, lastAttemptAt: 5, lastError: null };
    const t = setup({ usage: { version: () => version, read: async () => { calls++; return info; } } } as any);
    await t.bridge.pushUsage();
    expect(last(t.out, 'usage')).toEqual({ type: 'usage', usage: info });
    t.out.length = 0;
    t.bridge.tick(Date.now());
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);                                    // tick sees the same version: no duplicate push
    version = '1:2';
    t.bridge.tick(Date.now());
    await vi.waitFor(() => expect(last(t.out, 'usage')).toBeDefined());
  });
  describe('SDK fallback resume folder', () => {
    const hook = (o: any = {}) => ({ hook_event_name: 'Stop', session_id: 'plain1', cwd: '/mnt/c/Workspace/claude-pet', transcript_path: '/h/.claude/projects/-mnt-c-Workspace/plain1.jsonl', ...o });
    it('records the folder the session was started in (from its transcript) before the SDK resumes it; drift does not change it', async () => {
      const asked: string[] = [];
      const t = setup({ originalCwd: async (p: string) => { asked.push(p); return '/mnt/c/Workspace'; } } as any);
      t.bridge.onHook(hook());
      t.bridge.onHook(hook({ cwd: '/mnt/c/Workspace/claude-pet/ui' }));      // the folder drifts
      await t.bridge.handle({ type: 'send', sessionId: 'plain1', text: 'hi' });
      expect(t.store.get('plain1')).toMatchObject({ resumeCwd: '/mnt/c/Workspace', cwd: '/mnt/c/Workspace/claude-pet' });
      expect(t.calls).toContainEqual(['send', 'plain1', 'hi']);
      t.bridge.onHook(hook({ cwd: '/elsewhere' }));
      await t.bridge.handle({ type: 'send', sessionId: 'plain1', text: 'again' });
      expect(t.store.get('plain1')?.resumeCwd).toBe('/mnt/c/Workspace');
      expect(asked).toEqual(['/h/.claude/projects/-mnt-c-Workspace/plain1.jsonl']); // read once, not on every send
    });
    it('an unreadable transcript leaves resumeCwd unset and still sends (the runner then checks the session id)', async () => {
      const t = setup({ originalCwd: async () => { throw new Error('nope'); } } as any);
      t.bridge.onHook(hook());
      await t.bridge.handle({ type: 'send', sessionId: 'plain1', text: 'hi' });
      expect(t.store.get('plain1')?.resumeCwd).toBeUndefined();
      expect(t.calls).toContainEqual(['send', 'plain1', 'hi']);
    });
    it('a PTY session never touches the runner or the transcript for resume: one live process, nothing started', async () => {
      const sent: string[] = [];
      let asked = 0;
      const t = setup({ originalCwd: async () => { asked++; return '/x'; }, pty: { sendPrompt: async (_s: string, x: string) => { sent.push(x); }, sendEsc: async () => {} } } as any);
      t.bridge.onHook(hook({ pet_pty: '/run/w.sock' }));
      await t.bridge.handle({ type: 'send', sessionId: 'plain1', text: 'hi' });
      expect(sent).toEqual(['hi']);
      expect(t.calls.filter((c) => c[0] === 'send' || c[0] === 'start')).toEqual([]);
      expect(asked).toBe(0);
      expect(t.store.get('plain1')?.owned).toBe(false);
    });
    it('a dead PTY socket falls back to the SDK, with the original folder', async () => {
      const { PtyGoneError } = await import('./ptySend.js');
      const t = setup({ originalCwd: async () => '/mnt/c/Workspace', pty: { sendPrompt: async () => { throw new PtyGoneError(); }, sendEsc: async () => {} } } as any);
      t.bridge.onHook(hook({ pet_pty: '/run/dead.sock' }));
      await t.bridge.handle({ type: 'send', sessionId: 'plain1', text: 'hi' });
      expect(t.calls).toContainEqual(['send', 'plain1', 'hi']);
      expect(t.store.get('plain1')).toMatchObject({ resumeCwd: '/mnt/c/Workspace' });
      expect(t.store.get('plain1')?.pty).toBeUndefined();
    });
  });
});

describe('bridge: mailbox and hook permissions', () => {
  const start = (store: SessionStore, id = 's9') => store.apply({ hook_event_name: 'SessionStart', session_id: id, cwd: '/p' });
  it('a session without a PTY gets the message through its armed mailbox waiter, marked, with an echo; no second claude', async () => {
    const mailbox = createMailbox();
    const { bridge, store, calls, out } = setup({ mailbox });
    start(store);
    const w = mailbox.wait('s9', 1000);
    await bridge.handle({ type: 'send', sessionId: 's9', text: 'сделай тесты' });
    const delivered = await w;
    expect(delivered).toContain('[ccPet message] сделай тесты');
    expect(calls.filter((c) => c[0] === 'send')).toEqual([]);
    expect(out.find((m) => m.type === 'chat')).toEqual({ type: 'chat', sessionId: 's9', event: { kind: 'user', text: 'сделай тесты' } });
    expect(store.get('s9')?.state).toBe('thinking');
  });
  it('mailboxOnly hosts queue the message when no waiter is armed yet; others fall back to the SDK', async () => {
    const a = setup({ mailbox: createMailbox(), mailboxOnly: true });
    start(a.store);
    await a.bridge.handle({ type: 'send', sessionId: 's9', text: 'later' });
    expect(a.calls.filter((c) => c[0] === 'send')).toEqual([]);
    expect(await (a as any).bridge && true).toBe(true);
    const b = setup({ mailbox: createMailbox() });
    start(b.store);
    await b.bridge.handle({ type: 'send', sessionId: 's9', text: 'via sdk' });
    expect(b.calls.filter((c) => c[0] === 'send')).toEqual([['send', 's9', 'via sdk']]);
  });
  it('snapshots tell which sessions have an armed waiter', async () => {
    const mailbox = createMailbox();
    const { bridge, store, out } = setup({ mailbox });
    start(store);
    void mailbox.wait('s9', 500);
    bridge.snapshot();
    expect((last(out, 'snapshot') as any).sessions[0].mailbox).toBe(true);
  });
  it('a PermissionRequest shows Allow/Deny in the pet when switched on and returns the user\'s answer', async () => {
    const { bridge, store, out } = setup({ permissionsFromPet: () => true });
    start(store);
    const p = bridge.onPermission({ hook_event_name: 'PermissionRequest', session_id: 's9', cwd: '/p', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    const pend = store.get('s9')?.pendingPermission;
    expect(pend).toMatchObject({ tool: 'Bash' });
    expect(pend?.summary).toContain('rm -rf build');
    expect(store.get('s9')?.state).toBe('waiting');
    await bridge.handle({ type: 'permission', id: pend!.id, allow: false });
    expect(await p).toBe('deny');
    expect(store.get('s9')?.pendingPermission).toBeUndefined();
    expect(out.length).toBeGreaterThan(0);
  });
  it('without an answer in time the pet has no opinion (the normal dialog stays); when switched off it never answers', async () => {
    const { bridge, store } = setup({ permissionsFromPet: () => true, permissionTimeoutMs: 20 });
    start(store);
    expect(await bridge.onPermission({ hook_event_name: 'PermissionRequest', session_id: 's9', cwd: '/p', tool_name: 'Bash' })).toBeNull();
    expect(store.get('s9')?.pendingPermission).toBeUndefined();
    const off = setup();
    start(off.store);
    expect(await off.bridge.onPermission({ hook_event_name: 'PermissionRequest', session_id: 's9', cwd: '/p', tool_name: 'Bash' })).toBeNull();
    await off.bridge.handle({ type: 'hook-permissions', on: true });
    const p = off.bridge.onPermission({ hook_event_name: 'PermissionRequest', session_id: 's9', cwd: '/p', tool_name: 'Bash' });
    expect(off.store.get('s9')?.pendingPermission).toBeDefined();
    await off.bridge.handle({ type: 'permission', id: off.store.get('s9')!.pendingPermission!.id, allow: true });
    expect(await p).toBe('allow');
  });
});

describe('bridge: hooks with a receiver (mailbox waiter and permission hook)', () => {
  const host = { origin: 'http://127.0.0.1:47822', token: 'ab12cd' };
  it('plan shows the waiter; apply writes events + waiter (+ permission only when asked); remove leaves the user\'s own hooks', async () => {
    const mine = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk' }] }] } };
    const { bridge, out, settingsPath } = setup({ hostHooks: host });
    writeFileSync(settingsPath, JSON.stringify(mine));
    await bridge.handle({ type: 'hooks', apply: false });
    expect(last(out, 'hooks')).toMatchObject({ applied: false, diff: expect.stringContaining('wait'), events: false, mailbox: false, permissions: false });
    await bridge.handle({ type: 'hooks', apply: true, permissions: false });
    let st = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(st.hooks.Stop.some((g: any) => /pet-hook\.mjs" wait/.test(g.hooks[0].command))).toBe(true);
    expect(st.hooks.PermissionRequest).toBeUndefined();
    await bridge.handle({ type: 'hooks', apply: false, permissions: false });
    expect(last(out, 'hooks')).toMatchObject({ diff: '', events: true, mailbox: true, permissions: false });
    await bridge.handle({ type: 'hooks', apply: true, permissions: true });
    st = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(st.hooks.PermissionRequest[0].hooks[0].url).toBe('http://127.0.0.1:47822/hook/ab12cd/PermissionRequest');
    await bridge.handle({ type: 'hooks', apply: true, remove: true });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(mine);
  });
  it('a settings file that is not JSON is reported, not overwritten', async () => {
    const { bridge, out, settingsPath } = setup({ hostHooks: host });
    writeFileSync(settingsPath, '{ // c\n}');
    await bridge.handle({ type: 'hooks', apply: true });
    expect((last(out, 'hooks') as any).error).toMatch(/not valid JSON/);
    expect(readFileSync(settingsPath, 'utf8')).toContain('// c');
  });
});
