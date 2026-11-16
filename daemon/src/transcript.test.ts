import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, readTranscript, hasInterruptSince, interruptedSince, readOriginalCwd } from './transcript.js';

const L = (o: unknown) => JSON.stringify(o);
const lines = [
  L({ type: 'summary', summary: 'x' }),
  L({ type: 'user', message: { role: 'user', content: 'привет' } }),
  L({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } }),
  L({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
  L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Сейчас посмотрю.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } }),
  L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'files' }] } }),
  L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Готово.' }] } }),
  L({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'спасибо' }] } }),
  '{broken json',
  '',
];

describe('parseTranscript', () => {
  it('keeps user text, assistant text and tool calls; drops meta, commands, tool results, thinking, junk', () => {
    expect(parseTranscript(lines.join('\n'))).toEqual([
      { role: 'user', text: 'привет' },
      { role: 'assistant', text: 'Сейчас посмотрю.' },
      { role: 'tool', text: 'Bash · ls -la' },
      { role: 'assistant', text: 'Готово.' },
      { role: 'user', text: 'спасибо' },
    ]);
  });
  it('limit keeps the last N items', () => {
    expect(parseTranscript(lines.join('\n'), 2).map((x) => x.text)).toEqual(['Готово.', 'спасибо']);
  });
});

describe('readTranscript', () => {
  it('reads a .jsonl file; missing file or wrong extension gives []', async () => {
    const d = mkdtempSync(join(tmpdir(), 'tr-'));
    writeFileSync(join(d, 's.jsonl'), lines.join('\n'));
    expect(await readTranscript(join(d, 's.jsonl'))).toHaveLength(5);
    expect(await readTranscript(join(d, 'nope.jsonl'))).toEqual([]);
    writeFileSync(join(d, 'secret.txt'), lines.join('\n'));
    expect(await readTranscript(join(d, 'secret.txt'))).toEqual([]);
  });
});

describe('interrupt detection', () => {
  const line = (text: string, ts: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts });
  const T = Date.parse('2026-11-16T13:00:10Z');
  it('sees an interrupt entry written after the given time, ignores older ones and normal text', () => {
    expect(hasInterruptSince(line('hi', '2026-11-16T13:00:20Z') + '\n' + line('[Request interrupted by user]', '2026-11-16T13:00:20Z'), T)).toBe(true);
    expect(hasInterruptSince(line('[Request interrupted by user for tool use]', '2026-11-16T13:00:20Z'), T)).toBe(true);
    expect(hasInterruptSince(line('[Request interrupted by user]', '2026-11-16T13:00:05Z'), T)).toBe(false);
    expect(hasInterruptSince(line('please write [Request interrupted by user] in a file', '2026-11-16T13:00:20Z'), T)).toBe(false);
    expect(hasInterruptSince('garbage\n{"half', T)).toBe(false);
  });
  it('reads only the file tail and tolerates missing files', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'tr-')), 's.jsonl');
    writeFileSync(f, 'x'.repeat(200_000) + '\n' + line('[Request interrupted by user]', '2026-11-16T13:00:20Z') + '\n');
    expect(await interruptedSince(f, T)).toBe(true);
    expect(await interruptedSince('/nonexistent/a.jsonl', T)).toBe(false);
  });
});

describe('readOriginalCwd', () => {
  const file = (lines: string[], name = 's.jsonl') => { const f = join(mkdtempSync(join(tmpdir(), 'oc-')), name); writeFileSync(f, lines.join('\n') + '\n'); return f; };
  it('is the FIRST cwd in the transcript, whatever the folder became later', async () => {
    const f = file([
      JSON.stringify({ type: 'mode' }),
      JSON.stringify({ type: 'user', cwd: '/mnt/c/Workspace', message: { role: 'user', content: 'a' } }),
      JSON.stringify({ type: 'user', cwd: '/mnt/c/Workspace/claude-pet', message: { role: 'user', content: 'b' } }),
      JSON.stringify({ type: 'user', cwd: '/mnt/c/Workspace/claude-pet/ui', message: { role: 'user', content: 'c' } }),
    ]);
    expect(await readOriginalCwd(f)).toBe('/mnt/c/Workspace');
  });
  it('skips broken lines and non-absolute values; null when there is none or the file is unusable', async () => {
    expect(await readOriginalCwd(file(['{"cwd":', '{"cwd":"relative/x"}', '{"cwd":"/ok/dir"}']))).toBe('/ok/dir');
    expect(await readOriginalCwd(file(['{"type":"mode"}']))).toBeNull();
    expect(await readOriginalCwd('/nonexistent/x.jsonl')).toBeNull();
    expect(await readOriginalCwd(file(['{"cwd":"/x"}'], 'notes.txt'))).toBeNull();
  });
});
