import { describe, it, expect, beforeAll } from 'vitest';
import { setLang } from '../../../shared/src/i18n.js';
import { duration, tokens, summaryHead, summaryRows } from './summaryCard.js';

beforeAll(() => setLang('ru'));

describe('summary card', () => {
  it('formats time and tokens', () => {
    expect(duration(42_000)).toBe('42 с');
    expect(duration(75_000)).toBe('1 мин 15 с');
    expect(duration(120_000)).toBe('2 мин');
    expect(duration(3_900_000)).toBe('1 ч 5 мин');
    expect(tokens(950)).toBe('950');
    expect(tokens(3400)).toBe('3,4 тыс.');
    expect(tokens(21_122)).toBe('21 тыс.');
  });
  it('head line and file rows', () => {
    const s = { files: [{ path: '/p/src/a.ts', added: 3, removed: 2 }, { path: 'C:\\p\\b.ts', added: 2, removed: 0 }], ms: 30_000, tokens: 127, tools: 2 };
    expect(summaryHead(s)).toBe('2 файла · +5 −2 · 30 с · 127 токенов');
    expect(summaryRows(s)).toEqual([{ name: 'a.ts', path: '/p/src/a.ts', stat: '+3 −2' }, { name: 'b.ts', path: 'C:\\p\\b.ts', stat: '+2 −0' }]);
    const many = { ...s, files: Array.from({ length: 7 }, (_, i) => ({ path: `/f${i}`, added: 1, removed: 0 })) };
    expect(summaryHead(many).startsWith('7 файлов')).toBe(true);
    expect(summaryRows(many).at(-1)!.name).toBe('и ещё 2');
  });
});
