import { describe, it, expect } from 'vitest';
import { SessionStore, pickAttention } from './sessionStore.js';
import type { HookEvent } from '../../shared/src/types.js';

const ev = (session_id: string, hook_event_name: string, extra: Partial<HookEvent> = {}): HookEvent =>
  ({ session_id, cwd: '/home/u/proj', hook_event_name, ...extra });

describe('SessionStore', () => {
  it('keeps two interleaved sessions separate', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'UserPromptSubmit', { cwd: '/x/alpha' }), 1000);
    s.apply(ev('b', 'PreToolUse', { cwd: '/x/beta', tool_name: 'Edit' }), 1100);
    s.apply(ev('a', 'PreToolUse', { cwd: '/x/alpha', tool_name: 'Read' }), 1200);
    const byId = Object.fromEntries(s.list().map((x) => [x.id, x]));
    expect(byId.a.state).toBe('reading');
    expect(byId.b.state).toBe('writing');
    expect(byId.a.project).toBe('alpha');
  });

  it('project is the basename of cwd, incl. Cyrillic, spaces, trailing slash', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'SessionStart', { cwd: '/mnt/c/Мои проекты/пет/' }), 1);
    expect(s.list()[0].project).toBe('пет');
  });

  it('records since only when state changes, lastEventAt always', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'UserPromptSubmit'), 1000);
    s.apply(ev('a', 'SubagentStop'), 2000); // null mapping: no state change
    const x = s.list()[0];
    expect(x.state).toBe('thinking');
    expect(x.since).toBe(1000);
    expect(x.lastEventAt).toBe(2000);
  });

  it('attention prefers waiting, then error, then newest active', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'PreToolUse', { tool_name: 'Edit' }), 1000);
    s.apply(ev('b', 'PreToolUse', { tool_name: 'Read' }), 2000);
    expect(s.attention()?.id).toBe('b');
    s.apply(ev('c', 'PostToolUse', { tool_response: { is_error: true } }), 1500);
    expect(s.attention()?.id).toBe('c');
    s.apply(ev('a', 'Notification', { message: 'Claude needs your permission to use Edit' }), 3000);
    expect(s.attention()?.id).toBe('a');
  });

  it('attention is null with no sessions, else falls back to newest session', () => {
    const s = new SessionStore();
    expect(s.attention()).toBeNull();
    s.apply(ev('a', 'SessionStart'), 1000);
    s.apply(ev('b', 'SessionStart'), 2000);
    expect(s.attention()?.id).toBe('b');
  });

  it('tick: a running tool (no PostToolUse yet) is not lost after 120s, only after 30 min', () => {
    const s = new SessionStore();
    s.apply({ hook_event_name: 'PreToolUse', session_id: 'a', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'gh run watch 1' } }, 0);
    s.tick(5 * 60_000);
    expect(s.list()[0].state).toBe('running');
    s.tick(30 * 60_000);
    expect(s.list()[0].state).toBe('sleeping');
  });

  it('tick: a busy session with no events for 120s decays to sleeping', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'UserPromptSubmit'), 0);
    s.tick(119_000);
    expect(s.list()[0].state).toBe('thinking');
    s.tick(120_000);
    expect(s.list()[0].state).toBe('sleeping');
  });

  it('tick: waiting is exempt from the 120s decay but decays after 30 min', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'Notification', { message: 'needs your permission' }), 0);
    s.tick(10 * 60_000);
    expect(s.list()[0].state).toBe('waiting');
    s.tick(30 * 60_000);
    expect(s.list()[0].state).toBe('sleeping');
  });

  it('tick: done becomes idle after 30s', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'Stop'), 0);
    s.tick(29_000);
    expect(s.list()[0].state).toBe('done');
    s.tick(30_000);
    expect(s.list()[0].state).toBe('idle');
  });

  it('tick: sessions sleeping for over 1h are dropped', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'SessionEnd'), 0);
    s.tick(60 * 60_000 + 1);
    expect(s.list()).toHaveLength(0);
  });

  it('new event wakes a sleeping session', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'UserPromptSubmit'), 0);
    s.tick(200_000);
    s.apply(ev('a', 'PreToolUse', { tool_name: 'Edit' }), 210_000);
    expect(s.list()[0].state).toBe('writing');
  });

  it('SessionEnd right after Stop keeps "done" visible, then the ended session goes to sleeping', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'Stop'), 0);
    s.apply(ev('a', 'SessionEnd'), 100);
    expect(s.list()[0].state).toBe('done');
    s.tick(29_000);
    expect(s.list()[0].state).toBe('done');
    s.tick(30_000);
    expect(s.list()[0].state).toBe('sleeping');
  });

  it('SessionEnd on a pet-owned session is ignored: it stays resumable (done -> idle)', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'Stop'), 0);
    s.setOwned('a', true);
    s.apply(ev('a', 'SessionEnd'), 100);
    s.tick(30_000);
    expect(s.list()[0].state).toBe('idle');
    s.apply(ev('a', 'PreToolUse', { tool_name: 'Edit' }), 40_000);
    s.apply(ev('a', 'SessionEnd'), 41_000);
    expect(s.list()[0].state).toBe('writing');
  });

  it('SessionEnd while not done still sleeps at once; a later event clears the ended mark', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'UserPromptSubmit'), 0);
    s.apply(ev('a', 'SessionEnd'), 100);
    expect(s.list()[0].state).toBe('sleeping');
    s.apply(ev('b', 'Stop'), 0);
    s.apply(ev('b', 'SessionEnd'), 10);
    s.apply(ev('b', 'UserPromptSubmit'), 20);   // resumed
    s.apply(ev('b', 'Stop'), 1000);
    s.tick(31_000);
    expect(s.list().find((x) => x.id === 'b')?.state).toBe('idle');
  });

  it('a closed session (SessionEnd) is dropped 30 s later; a later event forgets the close; owned is kept', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'UserPromptSubmit'), 0);
    s.apply(ev('a', 'SessionEnd'), 1000);
    s.tick(30_999);
    expect(s.list()).toHaveLength(1);
    s.tick(31_000);
    expect(s.list()).toHaveLength(0);
    s.apply(ev('b', 'UserPromptSubmit'), 0);
    s.apply(ev('b', 'SessionEnd'), 1000);
    s.apply(ev('b', 'UserPromptSubmit'), 2000);
    s.tick(60_000);
    expect(s.list()).toHaveLength(1);
    s.apply(ev('c', 'Stop'), 0);
    s.setOwned('c', true);
    s.apply(ev('c', 'SessionEnd'), 1000);
    s.tick(100_000);
    expect(s.list().some((x) => x.id === 'c')).toBe(true);
  });

  it('remove drops a session', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'Stop'), 0);
    s.remove('a');
    expect(s.list()).toEqual([]);
    expect(() => s.remove('missing')).not.toThrow();
  });

  it('resumeCwd is written once and later working-folder changes never alter it (or the shown cwd)', () => {
    const st = new SessionStore();
    st.apply(ev('a', 'SessionStart', { cwd: '/mnt/c/Workspace/claude-pet' }));
    st.setResumeCwd('a', '/mnt/c/Workspace');
    st.apply(ev('a', 'Stop', { cwd: '/mnt/c/Workspace/claude-pet/ui' }));
    st.setResumeCwd('a', '/somewhere/else');
    expect(st.get('a')).toMatchObject({ cwd: '/mnt/c/Workspace/claude-pet', project: 'claude-pet', resumeCwd: '/mnt/c/Workspace' });
    st.setResumeCwd('unknown', '/x'); // no such session: ignored
    expect(st.get('unknown')).toBeUndefined();
  });
  it('restore puts back state, since and owned of an aborted attempt', () => {
    const st = new SessionStore();
    st.apply(ev('a', 'Stop'), 1000);
    const b = st.get('a')!;
    const prev = { state: b.state, since: b.since, owned: b.owned };
    st.apply(ev('a', 'UserPromptSubmit'), 2000); st.setOwned('a', true);
    st.restore('a', prev);
    expect(st.get('a')).toMatchObject({ state: 'done', since: 1000, owned: false });
  });

  it('tick: an idle session silent for 3h goes to sleep and is dropped an hour later; a new event brings it back', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'SessionStart'), 0);
    s.tick(3 * 3600_000 - 1);
    expect(s.get('a')?.state).toBe('idle');
    s.tick(3 * 3600_000);
    expect(s.get('a')?.state).toBe('sleeping');
    s.tick(4 * 3600_000 + 1);
    expect(s.get('a')).toBeUndefined();
    s.apply(ev('a', 'UserPromptSubmit'), 4 * 3600_000 + 2);
    expect(s.get('a')?.state).toBe('thinking');
  });

  it('tick: owned (pet-resumed) idle sessions are not put to sleep by silence', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'SessionStart'), 0);
    s.setOwned('a', true);
    s.tick(10 * 3600_000);
    expect(s.get('a')?.state).toBe('idle');
  });

  it('tick: the list is capped; the longest-quiet idle sessions go first, busy and waiting ones stay', () => {
    const s = new SessionStore();
    for (let i = 0; i < 20; i++) s.apply(ev(`s${i}`, 'SessionStart', { cwd: `/x/p${i}` }), 1000 + i);
    s.apply(ev('busy', 'PreToolUse', { tool_name: 'Edit' }), 500);
    s.tick(2000);
    expect(s.list().length).toBe(15);
    expect(s.get('busy')).toBeDefined();
    expect(s.get('s0')).toBeUndefined();
    expect(s.get('s19')).toBeDefined();
  });
});

describe('Windows hosts', () => {
  it('names a session after the last folder of a Windows cwd', () => {
    const s = new SessionStore();
    s.apply({ hook_event_name: 'SessionStart', session_id: 'w1', cwd: 'C:\\Users\\x\\my-proj' });
    s.apply({ hook_event_name: 'SessionStart', session_id: 'w2', cwd: 'C:\\Users\\x\\other\\' });
    expect(s.get('w1')?.project).toBe('my-proj');
    expect(s.get('w2')?.project).toBe('other');
  });
  it('pickAttention works across a merged list: waiting beats a newer busy session', () => {
    const mk = (id: string, state: any, at: number) => ({ id, cwd: '/', project: id, state, since: at, lastEventAt: at, owned: false });
    const list = [mk('a', 'thinking', 100), mk('b', 'waiting', 50), mk('c', 'idle', 200)];
    expect(pickAttention(list)?.id).toBe('b');
    expect(pickAttention([])).toBeNull();
  });
  it('a session first seen without a folder takes it from a later event', () => {
    const st = new SessionStore();
    st.apply({ hook_event_name: 'SessionStart', session_id: 'x', cwd: '' }, 1);
    st.apply({ hook_event_name: 'UserPromptSubmit', session_id: 'x', cwd: '/home/u/proj' }, 2);
    expect(st.get('x')).toMatchObject({ cwd: '/home/u/proj', project: 'proj' });
    st.apply({ hook_event_name: 'Stop', session_id: 'x', cwd: '/elsewhere' }, 3);
    expect(st.get('x')?.cwd).toBe('/home/u/proj'); // a known folder is not replaced
  });
});

describe('subagent tracking', () => {
  const ag = (name: string, id = 'g1', extra: Partial<HookEvent> = {}) => ev('a', name, { agent_id: id, ...extra });

  it('subagent tool events keep the parent in subagent, no extra session', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'UserPromptSubmit'), 1000);
    s.apply(ag('PreToolUse', 'g1', { tool_name: 'Read' }), 1100);
    expect(s.list()).toHaveLength(1);
    expect(s.get('a')?.state).toBe('subagent');
  });

  it('parent Stop while an agent runs stays subagent, SubagentStop then gives done', () => {
    const s = new SessionStore();
    s.apply(ag('PreToolUse', 'g1', { tool_name: 'Read' }), 1000);
    s.apply(ev('a', 'Stop'), 1100);
    expect(s.get('a')?.state).toBe('subagent');
    s.apply(ag('SubagentStop'), 1200);
    expect(s.get('a')?.state).toBe('done');
  });

  it('SubagentStop mid-turn gives thinking', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'UserPromptSubmit'), 1000);
    s.apply(ag('PreToolUse', 'g1', { tool_name: 'Read' }), 1100);
    s.apply(ag('SubagentStop'), 1200);
    expect(s.get('a')?.state).toBe('thinking');
  });

  it('a stale agent is dropped after 10 minutes', () => {
    const s = new SessionStore();
    s.apply(ev('a', 'Stop'), 1000);
    s.apply(ag('PreToolUse', 'g1', { tool_name: 'Read' }), 1100);
    s.tick(1100 + 10 * 60_000 + 1);
    expect(s.get('a')?.state).toBe('done');
    s.apply(ev('b', 'UserPromptSubmit'), 0);
    s.apply(ev('b', 'PreToolUse', { agent_id: 'x', tool_name: 'Read' }), 0);
    s.tick(10 * 60_000);
    expect(s.get('b')?.state).toBe('idle');
  });

  it('no busy decay to sleeping while an agent is tracked', () => {
    const s = new SessionStore();
    s.apply(ag('PreToolUse', 'g1', { tool_name: 'Read' }), 1000);
    s.tick(1000 + 5 * 60_000);
    expect(s.get('a')?.state).toBe('subagent');
  });

  it('SessionEnd clears agents', () => {
    const s = new SessionStore();
    s.apply(ag('PreToolUse', 'g1', { tool_name: 'Read' }), 1000);
    s.apply(ev('a', 'SessionEnd'), 1100);
    s.apply(ev('a', 'Stop'), 1200);
    expect(s.get('a')?.state).toBe('done');
  });
});
