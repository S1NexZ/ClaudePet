import { describe, it, expect } from 'vitest';
import { MessageQueue, parseAt } from './messageQueue.js';
import type { Session } from '../../../shared/src/types.js';

const sess = (id: string, state: Session['state'], extra: Partial<Session> = {}): Session => ({ id, cwd: '/p', project: 'p', state, since: 0, lastEventAt: 0, owned: false, ...extra });

describe('MessageQueue', () => {
  it('sends the next message only once the turn is over, one at a time, in order', () => {
    const q = new MessageQueue();
    q.add('s1', 'first'); q.add('s1', 'second');
    expect(q.due([sess('s1', 'thinking')], 1e6)).toEqual([]);
    expect(q.due([sess('s1', 'done')], 1e6).map((x) => x.message.text)).toEqual(['first']);
    expect(q.due([sess('s1', 'done')], 1e6 + 1000)).toEqual([]); // the session has not picked it up yet
    expect(q.due([sess('s1', 'idle')], 1e6 + 5000).map((x) => x.message.text)).toEqual(['second']);
    expect(q.of('s1')).toBeUndefined();
  });
  it('a waiting permission or question holds the queue', () => {
    const q = new MessageQueue();
    q.add('s1', 'x');
    expect(q.due([sess('s1', 'idle', { pendingPermission: { id: 'a', tool: 'Bash', summary: '' } })], 1e6)).toEqual([]);
  });
  it('a timed message waits for its time; an untimed one behind it is not blocked', () => {
    const q = new MessageQueue();
    q.add('s1', 'night', 5e6); q.add('s1', 'now');
    expect(q.due([sess('s1', 'idle')], 1e6).map((x) => x.message.text)).toEqual(['now']);
    expect(q.due([sess('s1', 'idle')], 2e6)).toEqual([]);
    expect(q.due([sess('s1', 'idle')], 5e6).map((x) => x.message.text)).toEqual(['night']);
  });
  it('is saved on every change and restored', () => {
    let saved: any = null;
    const q = new MessageQueue((d) => { saved = d; });
    const m = q.add('s1', 'a', 123);
    expect(saved).toEqual({ s1: [m] });
    const back = new MessageQueue(undefined, saved);
    expect(back.of('s1')).toEqual([m]);
    back.remove('s1', m.id);
    expect(back.of('s1')).toBeUndefined();
    expect(back.decorate([sess('s1', 'idle')])[0].queue).toBeUndefined();
    expect(q.decorate([sess('s1', 'idle')])[0].queue).toEqual([m]);
  });
});

describe('parseAt', () => {
  const now = new Date(2026, 10, 18, 22, 0, 0);
  it('a clock time today, or tomorrow when already past', () => {
    expect(parseAt('23:30 run the tests', now)).toEqual({ at: new Date(2026, 10, 18, 23, 30).getTime(), text: 'run the tests' });
    expect(parseAt('3:00 review', now)!.at).toBe(new Date(2026, 10, 19, 3, 0).getTime());
  });
  it('the limit reset (a minute after it), only when known and ahead', () => {
    const reset = now.getTime() / 1000 + 3600;
    expect(parseAt('reset go on', now, reset)).toEqual({ at: reset * 1000 + 60_000, text: 'go on' });
    expect(parseAt('сброс дальше', now, reset)!.text).toBe('дальше');
    expect(parseAt('reset go on', now, null)).toBeNull();
  });
  it('anything else is not a schedule', () => {
    expect(parseAt('25:00 x', now)).toBeNull();
    expect(parseAt('23:30', now)).toBeNull();
    expect(parseAt('tomorrow x', now)).toBeNull();
  });
});
