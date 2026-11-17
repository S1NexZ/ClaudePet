import { describe, it, expect } from 'vitest';
import { createSoftStop } from './softStop.js';

const ev = (name: string, sid = 's1') => ({ hook_event_name: name, session_id: sid, cwd: '' });

describe('soft stop (stop through the next hook answer)', () => {
  it('nothing requested: no answer', () => {
    const s = createSoftStop();
    expect(s.reply(ev('PreToolUse'), 0)).toBeNull();
    expect(s.pending('s1', 10)).toBe(false);
  });
  it('PreToolUse after a request: the tool is denied and Claude stops; the request is used up', () => {
    const s = createSoftStop();
    s.request('s1', 0);
    expect(s.pending('s1', 10)).toBe(true);
    const r = s.reply(ev('PreToolUse'), 10) as any;
    expect(r.continue).toBe(false);
    expect(typeof r.stopReason).toBe('string');
    expect(r.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(s.pending('s1', 10)).toBe(false);
    expect(s.reply(ev('PreToolUse'), 20)).toBeNull();
  });
  it('PostToolUse after a request: Claude stops (no permission decision)', () => {
    const s = createSoftStop();
    s.request('s1', 0);
    const r = s.reply(ev('PostToolUse'), 10) as any;
    expect(r.continue).toBe(false);
    expect(r.hookSpecificOutput).toBeUndefined();
  });
  it('only the requested session is stopped', () => {
    const s = createSoftStop();
    s.request('s1', 0);
    expect(s.reply(ev('PreToolUse', 's2'), 10)).toBeNull();
    expect(s.pending('s1', 10)).toBe(true);
  });
  it('the turn ending (Stop) or a new prompt drops the request, so the next turn is not cut', () => {
    for (const end of ['Stop', 'UserPromptSubmit', 'SessionEnd', 'StopFailure']) {
      const s = createSoftStop();
      s.request('s1', 0);
      expect(s.reply(ev(end), 10)).toBeNull();
      expect(s.pending('s1', 10)).toBe(false);
    }
  });
  it('a request expires', () => {
    const s = createSoftStop(1000);
    s.request('s1', 0);
    expect(s.reply(ev('PreToolUse'), 1001)).toBeNull();
    expect(s.pending('s1', 10)).toBe(false);
  });
  it('reports which session it stopped', () => {
    const stopped: string[] = [];
    const s = createSoftStop(60_000, (id) => stopped.push(id));
    s.request('s1', 0);
    s.reply(ev('PostToolUse'), 1);
    expect(stopped).toEqual(['s1']);
  });
});
