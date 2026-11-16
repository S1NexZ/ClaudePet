import { describe, it, expect } from 'vitest';
import { sessionRows, nextChatId } from './switcher.js';
import type { Session } from '../../../shared/src/types.js';

const s = (id: string, o: Partial<Session> = {}): Session =>
  ({ id, cwd: `/x/${id}`, project: id, state: 'idle', since: 0, lastEventAt: 0, owned: false, ...o });

describe('sessionRows', () => {
  it('newest activity first; marks the open chat; Russian state label and elapsed time', () => {
    const rows = sessionRows([s('a', { lastEventAt: 1 }), s('b', { lastEventAt: 5, state: 'testing', since: 1000 })], 'a', 135_000);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows[0]).toMatchObject({ title: 'b', meta: 'Тестирует · 2:14', current: false, tone: 'busy' });
    expect(rows[1]).toMatchObject({ current: true, tone: 'quiet' });
  });
  it('tones: waiting/error are alert, idle/sleeping quiet, the rest busy', () => {
    const t = (state: Session['state']) => sessionRows([s('a', { state })], null, 0)[0].tone;
    expect(t('waiting')).toBe('alert'); expect(t('error')).toBe('alert');
    expect(t('idle')).toBe('quiet'); expect(t('sleeping')).toBe('quiet'); expect(t('done')).toBe('busy');
    expect(t('thinking')).toBe('busy');
  });
  it('same-named projects stay distinguishable (short id suffix); a lone name has none', () => {
    const rows = sessionRows([s('aaaa1111', { project: 'proj', cwd: '/a/proj' }), s('bbbb2222', { project: 'proj', cwd: '/b/proj' }), s('c', { project: 'solo' })], null, 0);
    const by = Object.fromEntries(rows.map((r) => [r.id, r.title]));
    expect(by.aaaa1111).toBe('proj · aaaa');
    expect(by.bbbb2222).toBe('proj · bbbb');
    expect(by.c).toBe('solo');
  });
  it('empty list', () => expect(sessionRows([], null, 0)).toEqual([]));
});

describe('nextChatId (Ctrl+Tab style cycling)', () => {
  const ids = ['a', 'b', 'c'];
  it('moves forward and backward, wrapping', () => {
    expect(nextChatId(ids, 'a', 1)).toBe('b');
    expect(nextChatId(ids, 'c', 1)).toBe('a');
    expect(nextChatId(ids, 'a', -1)).toBe('c');
  });
  it('unknown current starts from the first/last; empty gives null', () => {
    expect(nextChatId(ids, null, 1)).toBe('a');
    expect(nextChatId(ids, 'zzz', -1)).toBe('c');
    expect(nextChatId([], 'a', 1)).toBeNull();
  });
});
