import { describe, it, expect } from 'vitest';
import { pinSnapshot, focusSnapshot } from './view.js';
import type { Session, Snapshot } from '../../../shared/src/types.js';

const s = (id: string, state: Session['state'] = 'idle'): Session =>
  ({ id, cwd: `/x/${id}`, project: id, state, since: 0, lastEventAt: 0, owned: false });
const snap = (attention: string | null, ...sessions: Session[]): Snapshot => ({ type: 'snapshot', sessions, attention });

describe('pinSnapshot', () => {
  it('no pin or no snapshot: unchanged', () => {
    const x = snap('a', s('a'), s('b'));
    expect(pinSnapshot(x, null)).toBe(x);
    expect(pinSnapshot(null, 'a')).toBeNull();
  });
  it('a pinned session overrides the daemon attention', () => {
    expect(pinSnapshot(snap('a', s('a', 'thinking'), s('b')), 'b')?.attention).toBe('b');
  });
  it('a pin on a vanished session is ignored', () => {
    expect(pinSnapshot(snap('a', s('a')), 'gone')?.attention).toBe('a');
  });
  it('another session waiting for permission breaks through the pin', () => {
    expect(pinSnapshot(snap('c', s('a'), s('c', 'waiting')), 'a')?.attention).toBe('c');
  });
  it('the pinned session itself waiting stays pinned', () => {
    expect(pinSnapshot(snap('a', s('a', 'waiting'), s('b')), 'a')?.attention).toBe('a');
  });
});

describe('focusSnapshot (the session an open chat is about)', () => {
  it('points attention at the chat session, ignoring busier or waiting sessions', () => {
    expect(focusSnapshot(snap('b', s('a'), s('b', 'thinking'), s('c', 'waiting')), 'a')?.attention).toBe('a');
  });
  it('no chat session, or it is gone: attention is null (a new chat)', () => {
    expect(focusSnapshot(snap('b', s('a'), s('b')), null)?.attention).toBeNull();
    expect(focusSnapshot(snap('b', s('a'), s('b')), 'gone')?.attention).toBeNull();
    expect(focusSnapshot(null, 'a')).toBeNull();
  });
});
