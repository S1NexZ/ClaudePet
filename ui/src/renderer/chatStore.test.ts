import { describe, it, expect } from 'vitest';
import { applyChat, mergeHistory } from './chatStore.js';
import type { ChatEvent, ChatItem } from '../../../shared/src/types.js';

const run = (events: ChatEvent[], start: ChatItem[] = []) => events.reduce(applyChat, start);

describe('applyChat', () => {
  it('builds a streamed turn: user, growing assistant text, final text replaces the stream', () => {
    const a = run([{ kind: 'user', text: 'привет' }, { kind: 'delta', text: 'При' }, { kind: 'delta', text: 'вет!' }]);
    expect(a).toEqual([{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'Привет!', streaming: true }]);
    expect(run([{ kind: 'assistant', text: 'Привет!' }], a)[1]).toEqual({ role: 'assistant', text: 'Привет!' });
  });
  it('a final assistant text without deltas is added as its own message', () => {
    expect(run([{ kind: 'assistant', text: 'ок' }])).toEqual([{ role: 'assistant', text: 'ок' }]);
  });
  it('tool calls close the running stream and show as chips; text after a tool is a new message', () => {
    const a = run([{ kind: 'delta', text: 'Смотрю' }, { kind: 'tool', name: 'Bash', summary: 'ls' }, { kind: 'tool', name: 'TodoWrite', summary: '' }, { kind: 'delta', text: 'Готово' }]);
    expect(a).toEqual([
      { role: 'assistant', text: 'Смотрю' }, { role: 'tool', text: 'Bash · ls' }, { role: 'tool', text: 'TodoWrite' },
      { role: 'assistant', text: 'Готово', streaming: true },
    ]);
  });
  it('end closes the stream; an error is shown as a notice line', () => {
    expect(run([{ kind: 'delta', text: 'а' }, { kind: 'end' }])).toEqual([{ role: 'assistant', text: 'а' }]);
    expect(run([{ kind: 'end', error: 'boom' }])).toEqual([{ role: 'tool', text: '⚠ boom' }]);
  });
  it('a /btw note is added as its own line and does not disturb a running stream', () => {
    const a = run([{ kind: 'delta', text: 'идёт' }, { kind: 'note', text: 'ответ сбоку' }, { kind: 'delta', text: ' работа' }]);
    expect(a.filter((x) => x.role === 'note')).toEqual([{ role: 'note', text: 'ответ сбоку' }]);
    expect(a.find((x) => x.role === 'assistant')).toEqual({ role: 'assistant', text: 'идёт работа', streaming: true });
  });
  it('does not mutate its input', () => {
    const a: ChatItem[] = [{ role: 'assistant', text: 'x', streaming: true }];
    applyChat(a, { kind: 'delta', text: 'y' });
    expect(a).toEqual([{ role: 'assistant', text: 'x', streaming: true }]);
  });
});

describe('mergeHistory', () => {
  const h: ChatItem[] = [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }];
  it('no current chat: history as is', () => expect(mergeHistory(undefined, h)).toEqual(h));
  it('history replaces earlier messages, and keeps /btw questions with their notes after it', () => {
    const cur: ChatItem[] = [{ role: 'user', text: 'старое' }, { role: 'user', text: '/btw вопрос?' }, { role: 'note', text: 'ответ' }];
    expect(mergeHistory(cur, h)).toEqual([...h, { role: 'user', text: '/btw вопрос?' }, { role: 'note', text: 'ответ' }]);
  });
  it('a chat made only of a /btw exchange gets the history in front (the "empty chat" case)', () => {
    const cur: ChatItem[] = [{ role: 'user', text: '/btw привет' }, { role: 'note', text: 'ответ' }];
    expect(mergeHistory(cur, h).map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'note']);
  });
  it('a reply that is streaming right now is left alone', () => {
    const live: ChatItem[] = [{ role: 'assistant', text: 'пишу', streaming: true }];
    expect(mergeHistory(live, h)).toBe(live);
  });
});
