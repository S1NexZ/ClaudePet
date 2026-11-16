import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRunner, SessionBusyError, type QueryFn } from './runner.js';
import { SessionStore } from './sessionStore.js';
import type { ChatEvent } from '../../shared/src/types.js';

type Ctl = { options: any; prompts: AsyncIterator<any>; interrupt: ReturnType<typeof vi.fn>; setModel: ReturnType<typeof vi.fn>; prompt: any };
/** Fake SDK query(): `script` drives the message stream, reads prompts, may await canUseTool. */
function fakeQuery(script: (c: Ctl) => AsyncGenerator<any>, calls: Ctl[] = []): QueryFn {
  return ({ prompt, options }) => {
    const c: Ctl = {
      options, prompt, interrupt: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined),
      prompts: typeof prompt === 'string' ? (async function* () { yield { message: { content: prompt } }; })() : prompt[Symbol.asyncIterator](),
    };
    calls.push(c);
    return Object.assign(script(c), {
      interrupt: c.interrupt, setModel: c.setModel,
      supportedModels: async () => [{ value: 'opus', displayName: 'Opus 5.5', description: 'smart' }, { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'fast' }],
    });
  };
}
const text = async (c: Ctl) => (await c.prompts.next()).value?.message.content as string | undefined;
const init = (id = 'sess-1') => ({ type: 'system', subtype: 'init', session_id: id });
const ok = (id = 'sess-1') => ({ type: 'result', subtype: 'success', session_id: id });
const dir = (name = 'proj') => { const d = join(mkdtempSync(join(tmpdir(), 'run-')), name); mkdirSync(d); return d; };
/** One turn per prompt, forever (a live session). */
const echoLoop = (id = 'sess-1', seen: string[] = []) => async function* (c: Ctl) {
  yield init(id);
  for (let t = await text(c); t !== undefined; t = await text(c)) { seen.push(t); yield ok(id); }
};
function setup(script: (c: Ctl) => AsyncGenerator<any>) {
  const store = new SessionStore(); const calls: Ctl[] = []; const chat: Array<[string, ChatEvent]> = [];
  const r = new SessionRunner({ store, queryFn: fakeQuery(script, calls), onChat: (sid, e) => chat.push([sid, e]) });
  return { store, calls, chat, r };
}

describe('SessionRunner', () => {
  it('start returns the session id; the session is owned and ends the turn as done', async () => {
    const { store, r, chat } = setup(echoLoop());
    expect(await r.start({ cwd: dir(), prompt: 'hi' })).toBe('sess-1');
    expect(store.get('sess-1')).toMatchObject({ owned: true });
    await vi.waitFor(() => expect(store.get('sess-1')?.state).toBe('done'));
    expect(chat).toEqual([['sess-1', { kind: 'user', text: 'hi' }], ['sess-1', { kind: 'end' }]]);
  });

  it('streams text deltas, the final assistant text and tool calls as chat events', async () => {
    const delta = (t: string, parent: string | null = null) =>
      ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
    const { r, chat, store } = setup(async function* (c) {
      yield init(); await text(c);
      yield delta('При'); yield delta('вет'); yield delta('шум субагента', 'tu9');
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Привет' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } };
      yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', content: 'x' }] } };
      yield ok();
    });
    await r.start({ cwd: dir(), prompt: 'q' });
    await vi.waitFor(() => expect(store.get('sess-1')?.state).toBe('done'));
    expect(chat.map(([, e]) => e)).toEqual([
      { kind: 'user', text: 'q' }, { kind: 'delta', text: 'При' }, { kind: 'delta', text: 'вет' },
      { kind: 'assistant', text: 'Привет' }, { kind: 'tool', name: 'Bash', summary: 'ls' }, { kind: 'end' },
    ]);
  });

  it('a permission request stays pending and blocks until answered (allow / deny)', async () => {
    const verdicts: any[] = [];
    const { r, store } = setup(async function* (c) {
      yield init(); await text(c);
      verdicts.push(await c.options.canUseTool('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, toolUseID: 'tu1' }));
      verdicts.push(await c.options.canUseTool('Edit', { file_path: '/a/b.ts' }, { signal: new AbortController().signal, toolUseID: 'tu2' }));
      yield ok();
    });
    await r.start({ cwd: dir(), prompt: 'go' });
    await vi.waitFor(() => expect(store.get('sess-1')?.pendingPermission).toEqual({ id: 'tu1', tool: 'Bash', summary: 'rm -rf build' }));
    expect(store.get('sess-1')?.state).toBe('waiting');
    expect(verdicts).toHaveLength(0);
    expect(() => r.respondPermission('nope', true)).not.toThrow();
    r.respondPermission('tu1', true);
    await vi.waitFor(() => expect(store.get('sess-1')?.pendingPermission?.id).toBe('tu2'));
    r.respondPermission('tu2', false);
    await vi.waitFor(() => expect(verdicts).toHaveLength(2));
    expect(verdicts[0]).toMatchObject({ behavior: 'allow', updatedInput: { command: 'rm -rf build' } });
    expect(verdicts[1].behavior).toBe('deny');
    expect(store.get('sess-1')?.pendingPermission).toBeUndefined();
  });

  it('permission policy: "edits" auto-allows file edits but still asks for Bash; "all" allows everything; default asks', async () => {
    const run = async (policy: 'ask' | 'edits' | 'all') => {
      const verdicts: any[] = [];
      const { r, store } = setup(async function* (c) {
        yield init(); await text(c);
        const sig = { signal: new AbortController().signal };
        verdicts.push(await c.options.canUseTool('Edit', { file_path: '/a' }, { ...sig, toolUseID: 'e1' }));
        verdicts.push(await Promise.race([c.options.canUseTool('Bash', { command: 'ls' }, { ...sig, toolUseID: 'b1' }), new Promise((res) => setTimeout(() => res('asked'), 150))]));
        yield ok();
      });
      r.setPermissionPolicy(policy);
      await r.start({ cwd: dir(), prompt: 'go' });
      if (policy === 'ask') {
        await vi.waitFor(() => expect(store.get('sess-1')?.pendingPermission?.id).toBe('e1'));
        return { verdicts, pending: store.get('sess-1')?.pendingPermission?.id };
      }
      await vi.waitFor(() => expect(verdicts).toHaveLength(2));
      return { verdicts, pending: store.get('sess-1')?.pendingPermission?.id };
    };
    expect((await run('ask')).pending).toBe('e1');
    const edits = await run('edits');
    expect(edits.verdicts[0]).toMatchObject({ behavior: 'allow' });
    expect(edits.verdicts[1]).toBe('asked');
    const all = await run('all');
    expect(all.verdicts.map((v) => v.behavior)).toEqual(['allow', 'allow']);
    expect(all.pending).toBeUndefined();
  });

  it('passes a cwd with spaces and Cyrillic intact, asks for partial messages; rejects a missing folder', async () => {
    const { r, calls } = setup(echoLoop());
    const cwd = dir('Мои проекты пет');
    await r.start({ cwd, prompt: 'x' });
    expect(calls[0].options).toMatchObject({ cwd, includePartialMessages: true });
    await expect(r.start({ cwd: join(cwd, 'nope'), prompt: 'x' })).rejects.toThrow(/не существует/);
  });

  it('a follow-up goes into the same live process (no new query)', async () => {
    const seen: string[] = [];
    const { r, calls, store, chat } = setup(echoLoop('sess-1', seen));
    await r.start({ cwd: dir(), prompt: 'first' });
    await vi.waitFor(() => expect(store.get('sess-1')?.state).toBe('done'));
    await r.send('sess-1', 'second');
    await vi.waitFor(() => expect(seen).toEqual(['first', 'second']));
    expect(calls).toHaveLength(1);
    expect(chat.filter(([, e]) => e.kind === 'user').map(([, e]) => (e as any).text)).toEqual(['first', 'second']);
  });

  it('send to an idle terminal session resumes it in its cwd and marks it owned', async () => {
    const { r, calls, store } = setup(echoLoop('manual1'));
    const cwd = dir('Мой проект');
    store.apply({ hook_event_name: 'Stop', session_id: 'manual1', cwd });
    await r.send('manual1', 'продолжай');
    expect(calls[0].options).toMatchObject({ resume: 'manual1', cwd });
    expect(store.get('manual1')?.owned).toBe(true);
  });

  it('send to a busy session throws SessionBusyError and starts nothing', async () => {
    const { r, calls, store } = setup(echoLoop());
    store.apply({ hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'busy1', cwd: dir() });
    await expect(r.send('busy1', 'hey')).rejects.toBeInstanceOf(SessionBusyError);
    await expect(r.send('busy1', 'hey')).rejects.toThrow('Claude занят');
    expect(calls).toHaveLength(0);
    await expect(r.send('unknown', 'x')).rejects.toThrow(/Неизвестная сессия/);
  });

  it('an error result or a crashed stream puts the session into error and ends the chat turn with it', async () => {
    const a = setup(async function* (c) { yield init('e1'); await text(c); yield { type: 'result', subtype: 'error_during_execution', session_id: 'e1' }; });
    await a.r.start({ cwd: dir(), prompt: 'x' });
    await vi.waitFor(() => expect(a.store.get('e1')?.state).toBe('error'));
    expect(a.chat.at(-1)?.[1]).toMatchObject({ kind: 'end', error: expect.any(String) });

    const b = setup(async function* (c) { yield init('e2'); await text(c); throw new Error('boom'); });
    await b.r.start({ cwd: dir(), prompt: 'x' });
    await vi.waitFor(() => expect(b.store.get('e2')?.state).toBe('error'));
    expect(b.chat.at(-1)?.[1]).toEqual({ kind: 'end', error: 'boom' });
  });

  it('interrupt reaches the live query; unknown ids are ignored', async () => {
    const { r, calls } = setup(async function* (c) { yield init(); await text(c); await new Promise(() => {}); });
    await r.start({ cwd: dir(), prompt: 'long' });
    await r.interrupt('sess-1');
    expect(calls[0].interrupt).toHaveBeenCalledTimes(1);
    await expect(r.interrupt('nope')).resolves.toBeUndefined();
  });

  it('after the process has exited, the next send starts a new one with resume', async () => {
    const { r, calls, store } = setup(async function* (c) { yield init(); await text(c); yield ok(); /* then exits */ });
    await r.start({ cwd: dir(), prompt: 'one' });
    await vi.waitFor(() => expect(store.get('sess-1')?.state).toBe('done'));
    await new Promise((res) => setTimeout(res, 20));
    await r.send('sess-1', 'two');
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe('sess-1');
  });

  it('a turn stopped by the user ends as done without an error line', async () => {
    let release!: () => void;
    const { r, store, chat } = setup(async function* (c) {
      yield init(); await text(c);
      await new Promise<void>((res) => { release = res; });
      yield { type: 'result', subtype: 'error_during_execution', session_id: 'sess-1' };
    });
    await r.start({ cwd: dir(), prompt: 'long' });
    await r.interrupt('sess-1');
    release();
    await vi.waitFor(() => expect(store.get('sess-1')?.state).toBe('done'));
    expect(chat.at(-1)?.[1]).toEqual({ kind: 'end' });
  });

  it('models() lists the models via a probe query and caches them', async () => {
    const { r, calls } = setup(echoLoop());
    const m = await r.models();
    expect(m).toEqual([{ value: 'opus', displayName: 'Opus 5.5', description: 'smart' }, { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'fast' }]);
    await r.models();
    expect(calls).toHaveLength(1);
  });

  it('setModel switches a live session at once; with no session it becomes the default for new chats', async () => {
    const { r, calls } = setup(echoLoop());
    await r.setModel(null, 'sonnet');
    await r.start({ cwd: dir(), prompt: 'hi' });
    expect(calls[0].options.model).toBe('sonnet');
    await r.setModel('sess-1', 'opus');
    expect(calls[0].setModel).toHaveBeenCalledWith('opus');
  });

  it('a model chosen for an idle (not live) session is used when it is resumed', async () => {
    const { r, calls, store } = setup(echoLoop('manual1'));
    store.apply({ hook_event_name: 'Stop', session_id: 'manual1', cwd: dir() });
    await r.setModel('manual1', 'opus');
    await r.send('manual1', 'go');
    expect(calls[0].options).toMatchObject({ resume: 'manual1', model: 'opus' });
  });

  it('btw asks in a fork of the session (even while busy), answers as a note and leaves the session alone', async () => {
    const { r, calls, store, chat } = setup(async function* (c) {
      if (typeof c.prompt === 'string') { yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Ответ сбоку' }] } }; yield ok('fork-1'); return; }
      yield init(); await text(c); await new Promise(() => {}); // main session stays busy
    });
    await r.start({ cwd: dir(), prompt: 'долгая задача' });
    await r.btw('sess-1', 'что такое X?');
    expect(calls[1].options).toMatchObject({ resume: 'sess-1', forkSession: true });
    expect(calls[1].prompt).toContain('что такое X?');
    expect(calls[1].prompt).toMatch(/побочн|btw/i); // told it is a side question: short, text only
    expect(chat.slice(-2).map(([, e]) => e)).toEqual([{ kind: 'user', text: '/btw что такое X?' }, { kind: 'note', text: 'Ответ сбоку' }]);
    expect(store.get('sess-1')?.state).toBe('thinking');
    await expect(r.btw('nope', 'x')).rejects.toThrow(/Неизвестная сессия/);
  });

  it('release ends the live process and hands the session back (not owned), so a terminal can take it', async () => {
    const { r, store } = setup(echoLoop());
    await r.start({ cwd: dir(), prompt: 'hi' });
    await vi.waitFor(() => expect(store.get('sess-1')?.state).toBe('done'));
    expect(r.release('sess-1')).toBe(true);
    expect(store.get('sess-1')?.owned).toBe(false);
    expect(r.release('sess-1')).toBe(false);
  });

  describe('resume safety (no silent copy of a session)', () => {
    it('resumes in the folder the session was STARTED in (resumeCwd), not the one it was seen in', async () => {
      const { r, calls, store } = setup(echoLoop('manual1'));
      const seen = dir('claude-pet'), started = dir('Workspace');
      store.apply({ hook_event_name: 'Stop', session_id: 'manual1', cwd: seen });
      store.setResumeCwd('manual1', started);
      await r.send('manual1', 'go');
      expect(calls[0].options).toMatchObject({ resume: 'manual1', cwd: started });
      expect(store.get('manual1')?.cwd).toBe(seen);            // the shown folder is untouched
    });
    it('without resumeCwd the old behaviour stays (the folder it was seen in)', async () => {
      const { r, calls, store } = setup(echoLoop('manual2'));
      const seen = dir('p');
      store.apply({ hook_event_name: 'Stop', session_id: 'manual2', cwd: seen });
      await r.send('manual2', 'go');
      expect(calls[0].options).toMatchObject({ resume: 'manual2', cwd: seen });
    });
    it('another session id in system:init = a copy: not bound, process closed, state restored, error shown, nothing else processed', async () => {
      let closed = 0;
      const calls: Ctl[] = [];
      const queryFn: QueryFn = (a) => {
        const c: Ctl = { options: a.options, prompt: a.prompt, interrupt: vi.fn(async () => undefined), setModel: vi.fn(), prompts: (a.prompt as any)[Symbol.asyncIterator]() };
        calls.push(c);
        const gen = (async function* () {
          yield init('COPY-ID');                                          // Claude made a copy
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'reply from the copy' }] } };
          yield ok('COPY-ID');
        })();
        return Object.assign(gen, { interrupt: c.interrupt, close: () => { closed++; } });
      };
      const store = new SessionStore(); const chat: Array<[string, ChatEvent]> = [];
      const r = new SessionRunner({ store, queryFn, onChat: (sid, e) => chat.push([sid, e]) });
      store.apply({ hook_event_name: 'Stop', session_id: 'orig', cwd: dir() }, 1000);
      await r.send('orig', 'hello');
      await vi.waitFor(() => expect(chat.some(([, e]) => e.kind === 'end' && !!(e as any).error)).toBe(true));
      expect(store.get('COPY-ID')).toBeUndefined();                       // the copy's id is never bound to anything
      expect(store.get('orig')).toMatchObject({ state: 'done', since: 1000, owned: false }); // original untouched
      expect(chat.filter(([, e]) => e.kind === 'assistant' || e.kind === 'delta')).toEqual([]); // nothing from the copy reaches the chat
      expect(chat.every(([sid]) => sid === 'orig')).toBe(true);
      const err = chat.find(([, e]) => e.kind === 'end' && (e as any).error)![1] as any;
      expect(err.error).toMatch(/копию сессии/);
      expect(err.error).toMatch(/отправка отменена/);
      expect(closed).toBe(1);
      expect(calls[0].interrupt).toHaveBeenCalled();
      // and it is not left in the live map: the next send starts a fresh resume attempt instead of queueing into the dead process
      await r.send('orig', 'again');
      expect(calls).toHaveLength(2);
    });
    it('a matching session id is the normal path: bound, replies flow, no error', async () => {
      const { r, store, chat } = setup(async function* (c) { yield init('same'); await text(c); yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }; yield ok('same'); });
      store.apply({ hook_event_name: 'Stop', session_id: 'same', cwd: dir() });
      await r.send('same', 'hello');
      await vi.waitFor(() => expect(store.get('same')?.state).toBe('done'));
      expect(chat.some(([, e]) => e.kind === 'assistant')).toBe(true);
      expect(chat.some(([, e]) => e.kind === 'end' && !!(e as any).error)).toBe(false);
    });
    it('a brand-new session (no resume) still takes its id from init', async () => {
      const { r, store } = setup(echoLoop('fresh-1'));
      expect(await r.start({ cwd: dir(), prompt: 'x' })).toBe('fresh-1');
      expect(store.get('fresh-1')?.owned).toBe(true);
    });
  });
});
