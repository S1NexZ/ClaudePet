import { describe, it, expect, afterEach } from 'vitest';
import { startHookServer } from './hookHttp.js';
import { createMailbox } from './mailbox.js';

let closeAll: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of closeAll) await c(); closeAll = []; });

async function boot(extra: Partial<Parameters<typeof startHookServer>[0]> = {}) {
  const events: any[] = [];
  const mailbox = createMailbox();
  const srv = await startHookServer({ port: 0, token: 'tok', onEvent: (e) => events.push(e), mailbox, waitMs: 400, ...extra });
  closeAll.push(srv.close);
  return { base: `http://127.0.0.1:${srv.port}`, events, mailbox };
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) });

describe('hook http receiver', () => {
  it('passes a hook event to onEvent, taking the name from the body', async () => {
    const { base, events } = await boot();
    const r = await post(`${base}/hook/tok/Stop`, { hook_event_name: 'Stop', session_id: 's1', cwd: 'C:\\x\\p' });
    expect(r.status).toBe(200);
    expect(events).toEqual([{ hook_event_name: 'Stop', session_id: 's1', cwd: 'C:\\x\\p' }]);
  });
  it('takes the event name from the path when the body has none', async () => {
    const { base, events } = await boot();
    await post(`${base}/hook/tok/SessionStart`, { session_id: 's1' });
    expect(events[0].hook_event_name).toBe('SessionStart');
  });
  it('rejects a wrong token, bad JSON and a missing session id', async () => {
    const { base, events } = await boot();
    expect((await post(`${base}/hook/nope/Stop`, { session_id: 's' })).status).toBe(404);
    expect((await fetch(`${base}/hook/tok/Stop`, { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await post(`${base}/hook/tok/Stop`, { x: 1 })).status).toBe(400);
    expect(events).toHaveLength(0);
  });
  it('a hook answer (soft stop) goes back as JSON; the event still reaches onEvent', async () => {
    const { base, events } = await boot({ onReply: (e) => (e.hook_event_name === 'PostToolUse' ? { continue: false, stopReason: 'x' } : null) });
    const r = await post(`${base}/hook/tok/PostToolUse`, { hook_event_name: 'PostToolUse', session_id: 's1' });
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({ continue: false, stopReason: 'x' });
    const r2 = await post(`${base}/hook/tok/Stop`, { hook_event_name: 'Stop', session_id: 's1' });
    expect(await r2.text()).toBe('');
    expect(events.map((e) => e.hook_event_name)).toEqual(['PostToolUse', 'Stop']);
  });
  it('the event is recorded before the answer is made (a stop answer must be the last word on the session state)', async () => {
    const order: string[] = [];
    const { base } = await boot({ onEvent: () => order.push('event'), onReply: () => { order.push('reply'); return null; } });
    await post(`${base}/hook/tok/PostToolUse`, { hook_event_name: 'PostToolUse', session_id: 's1' });
    expect(order).toEqual(['event', 'reply']);
  });
  it('answers a PermissionRequest with the pet\'s decision in the format Claude Code expects', async () => {
    const { base } = await boot({ onPermission: async () => 'deny' });
    const r = await post(`${base}/hook/tok/PermissionRequest`, { session_id: 's1', tool_name: 'Bash' });
    expect(await r.json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } });
  });
  it('has no opinion (empty 200, normal dialog) when the pet answers null or has no handler', async () => {
    const a = await boot({ onPermission: async () => null });
    const r1 = await post(`${a.base}/hook/tok/PermissionRequest`, { session_id: 's1' });
    expect([r1.status, await r1.text()]).toEqual([200, '']);
    const b = await boot();
    const r2 = await post(`${b.base}/hook/tok/PermissionRequest`, { session_id: 's1' });
    expect([r2.status, await r2.text()]).toEqual([200, '']);
  });
  it('passes the pty pipe of a wrapped session on, but only a well-formed pipe of ours', async () => {
    const seen: Array<[string, string]> = [];
    const { base } = await boot({ onPty: (sid: string, pipe: string) => seen.push([sid, pipe]) });
    await fetch(`${base}/mailbox/tok/s1?pty=${encodeURIComponent('\\\\.\\pipe\\claude-pet-4242')}`);
    await fetch(`${base}/mailbox/tok/s2?pty=${encodeURIComponent('\\\\.\\pipe\\evil')}`);
    await fetch(`${base}/mailbox/tok/s3?pty=${encodeURIComponent('/tmp/x.sock')}`);
    expect(seen).toEqual([['s1', '\\\\.\\pipe\\claude-pet-4242']]);
  });
  it('mailbox long-poll: gets a message sent while waiting; 204 on timeout; 409 for a second waiter', async () => {
    const { base, mailbox } = await boot();
    const first = fetch(`${base}/mailbox/tok/s1`);
    await new Promise((r) => setTimeout(r, 50));
    const second = await fetch(`${base}/mailbox/tok/s1`);
    expect(second.status).toBe(409);
    mailbox.send('s1', 'hi from the pet');
    const r = await first;
    expect([r.status, await r.text()]).toEqual([200, 'hi from the pet']);
    expect((await fetch(`${base}/mailbox/tok/s2`)).status).toBe(204);
  });
  it('a waiter that disconnects does not swallow the next message', async () => {
    const { base, mailbox } = await boot({ waitMs: 5000 });
    const ac = new AbortController();
    const p = fetch(`${base}/mailbox/tok/s1`, { signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(); await p;
    await new Promise((r) => setTimeout(r, 50));
    expect(mailbox.send('s1', 'later')).toBe('queued');
  });
  it('rejects unsafe session ids in the mailbox path', async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/mailbox/tok/..%2Fx%20y`)).status).toBe(400);
  });
});
