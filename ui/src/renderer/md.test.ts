import { describe, it, expect } from 'vitest';
import { mdBlocks, mdInline } from './md.js';

describe('mdBlocks', () => {
  it('splits fenced code from text', () => {
    expect(mdBlocks('Вот:\n```ts\nconst a = 1;\n```\nвсё')).toEqual([
      { type: 'p', text: 'Вот:' }, { type: 'code', text: 'const a = 1;', lang: 'ts' }, { type: 'p', text: 'всё' },
    ]);
  });
  it('an unclosed fence (still streaming) is treated as code to the end', () => {
    expect(mdBlocks('a\n```\nx = 1')).toEqual([{ type: 'p', text: 'a' }, { type: 'code', text: 'x = 1', lang: '' }]);
  });
  it('plain text is one paragraph block; empty text gives nothing', () => {
    expect(mdBlocks('просто текст\nвторая строка')).toEqual([{ type: 'p', text: 'просто текст\nвторая строка' }]);
    expect(mdBlocks('')).toEqual([]);
  });
});

describe('mdBlocks: headings and tables (command output like /context)', () => {
  it('a "## " line is a heading; table rows form one monospace block', () => {
    expect(mdBlocks('## Context Usage\n**Model:** x\n\n| A | B |\n|---|---|\n| 1 | 2 |\nконец')).toEqual([
      { type: 'h', text: 'Context Usage' },
      { type: 'p', text: '**Model:** x' },
      { type: 'code', text: '| A | B |\n|---|---|\n| 1 | 2 |', lang: 'table' },
      { type: 'p', text: 'конец' },
    ]);
  });
});

describe('mdInline', () => {
  it('finds inline code and bold', () => {
    expect(mdInline('запусти `npm test` и **проверь** вывод')).toEqual([
      { t: 'text', v: 'запусти ' }, { t: 'code', v: 'npm test' }, { t: 'text', v: ' и ' }, { t: 'bold', v: 'проверь' }, { t: 'text', v: ' вывод' },
    ]);
  });
  it('unpaired markers stay as text; markup inside code is not parsed', () => {
    expect(mdInline('a ` b ** c')).toEqual([{ t: 'text', v: 'a ` b ** c' }]);
    expect(mdInline('`**x**`')).toEqual([{ t: 'code', v: '**x**' }]);
  });
});
