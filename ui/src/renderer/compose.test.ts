import { describe, it, expect } from 'vitest';
import { decideSend, placeholderFor, parseSlash, canStop } from './compose.js';
import type { Snapshot, Session } from '../../../shared/src/types.js';

const sess = (o: Partial<Session> = {}): Session =>
  ({ id: 'a', cwd: '/x/proj', project: 'proj', state: 'idle', since: 0, lastEventAt: 0, owned: false, ...o });
const snap = (...sessions: Session[]): Snapshot => ({ type: 'snapshot', sessions, attention: sessions[0]?.id ?? null });

describe('decideSend', () => {
  it('empty or whitespace text does nothing', () => {
    expect(decideSend('  ', snap(sess()), null, 'reply')).toEqual({ kind: 'empty' });
  });
  it('reply mode with an idle attention session sends into it', () => {
    expect(decideSend(' привет ', snap(sess({ state: 'done' })), null, 'reply')).toEqual({ kind: 'send', sessionId: 'a', text: 'привет' });
  });
  it('new mode with a folder starts a session', () => {
    expect(decideSend('сделай', snap(sess()), 'C:\\work\\p', 'new')).toEqual({ kind: 'start', cwd: 'C:\\work\\p', prompt: 'сделай' });
  });
  it('new mode without a folder asks for one', () => {
    expect(decideSend('сделай', null, null, 'new')).toEqual({ kind: 'needFolder' });
  });
  it('reply mode with a busy session queues the message for when the turn ends', () => {
    const s = sess({ state: 'thinking' });
    expect(decideSend(' x ', snap(s), 'C:\\p', 'reply')).toEqual({ kind: 'queue', sessionId: s.id, text: 'x' });
    expect(decideSend('x', snap(sess({ state: 'waiting' })), null, 'reply')).toMatchObject({ kind: 'queue' });
  });
  it('reply mode with no session falls back to new-chat rules; a sleeping/errored chat still gets the reply', () => {
    expect(decideSend('x', snap(), null, 'reply')).toEqual({ kind: 'needFolder' });
    expect(decideSend('x', snap(sess({ state: 'sleeping' })), 'C:\\p', 'reply')).toEqual({ kind: 'send', sessionId: 'a', text: 'x' });
    expect(decideSend('x', snap(sess({ state: 'error' })), 'C:\\p', 'reply')).toEqual({ kind: 'send', sessionId: 'a', text: 'x' });
  });
});

describe('placeholderFor', () => {
  it('busy reply target', () => expect(placeholderFor(snap(sess({ state: 'thinking' })), null, 'reply')).toBe('Claude работает: сообщение встанет в очередь…'));
  it('reply mode names the project', () => expect(placeholderFor(snap(sess({ state: 'idle' })), null, 'reply')).toBe('Ответить в proj…'));
  it('new mode with folder shows its name', () => expect(placeholderFor(null, 'C:\\work\\мой пет', 'new')).toBe('Новая задача в «мой пет»…'));
  it('default', () => expect(placeholderFor(null, null, 'new')).toBe('Начать новый чат'));
});

describe('parseSlash', () => {
  it.each([
    ['/model', { name: 'model', args: '' }],
    ['  /model   sonnet ', { name: 'model', args: 'sonnet' }],
    ['/btw что такое X?', { name: 'btw', args: 'что такое X?' }],
    ['/superpowers:brainstorming', { name: 'superpowers:brainstorming', args: '' }],
  ])('%j', (input, out) => expect(parseSlash(input)).toEqual(out));
  it.each(['привет', '/', ' / x', 'a/b', ''])('not a command: %j', (input) => expect(parseSlash(input)).toBeNull());
});

describe('canStop', () => {
  it('Stop is offered for pet-owned sessions and for terminal sessions with a pet-claude.py socket only', () => {
    expect(canStop({ owned: true })).toBe(true);
    expect(canStop({ owned: false, pty: '/x.sock' })).toBe(true);
    expect(canStop({ owned: false })).toBe(false);
    expect(canStop({ owned: false, softStop: true })).toBe(true); // desktop / IDE: stop through the hooks
    expect(canStop(undefined)).toBe(false);
  });
});
