import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopRegistry, findRegistryRoots, parseEntry, decorateDesktop } from './desktopRegistry.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'dreg-'));
const entry = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 'local_ab-1', cliSessionId: 'c1', title: 'Тест', isArchived: false, lastActivityAt: 5, cwd: 'C:\\secret', postTurnSummary: 'private text', ...o });

describe('desktop app session registry', () => {
  it('keeps only the id, the CLI session ids, the title and the archive flag', () => {
    const e = parseEntry(entry({ lastAssistantCliSessionId: 'c2' }));
    expect(e).toEqual({ desktopId: 'local_ab-1', cliIds: ['c1', 'c2'], title: 'Тест', archived: false });
    expect(JSON.stringify(e)).not.toContain('private');
  });
  it('rejects broken or foreign entries (bad JSON, an id the deep link would not accept, no CLI id)', () => {
    expect(parseEntry('{nope')).toBeNull();
    expect(parseEntry(entry({ sessionId: 'local_../../x' }))).toBeNull();
    expect(parseEntry(entry({ sessionId: 'cse_1' }))).toBeNull();
    expect(parseEntry(entry({ cliSessionId: undefined }))).toBeNull();
  });
  it('a long or odd title is trimmed to one line', () => {
    expect(parseEntry(entry({ title: 'a\nb' + 'x'.repeat(300) }))!.title).toBe(('a b' + 'x'.repeat(300)).slice(0, 120));
  });
  it('finds the registry folders of the Store and the classic install', () => {
    const local = tmp(), roaming = tmp();
    mkdirSync(join(local, 'Claude-Data', 'claude_pzs8', 'claude-code-sessions'), { recursive: true });
    mkdirSync(join(roaming, 'Claude', 'claude-code-sessions'), { recursive: true });
    expect(findRegistryRoots(local, roaming)).toEqual([join(local, 'Claude-Data', 'claude_pzs8', 'claude-code-sessions'), join(roaming, 'Claude', 'claude-code-sessions')]);
    expect(findRegistryRoots(tmp(), tmp())).toEqual([]);
  });
  it('reads the entries two folders deep, by CLI session id; re-reads a file only when it changed', () => {
    const root = tmp();
    const dir = join(root, 'acct', 'org');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'local_ab-1.json');
    writeFileSync(f, entry({}));
    writeFileSync(join(dir, 'other.json'), entry({ sessionId: 'local_zz', cliSessionId: 'zz' }));
    let reads = 0;
    const reg = createDesktopRegistry(() => [root], { onRead: () => { reads++; } });
    expect(reg.byCliId().get('c1')?.title).toBe('Тест');
    expect(reg.byCliId().has('zz')).toBe(false);
    reg.byCliId();
    expect(reads).toBe(1);
    writeFileSync(f, entry({ title: 'Новое имя' }));
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(reg.byCliId().get('c1')?.title).toBe('Новое имя');
    expect(reads).toBe(2);
  });
  it('desktop sessions get their chat title and the desktop id; archived ones are hidden; others are untouched', () => {
    const map = new Map([
      ['c1', { desktopId: 'local_1', cliIds: ['c1'], title: 'Кто ты?', archived: false }],
      ['c2', { desktopId: 'local_2', cliIds: ['c2'], title: 'Старый', archived: true }],
    ]);
    const s = (id: string): { id: string; project: string; desktopId?: string } => ({ id, project: 'scratch-2026' });
    const out = decorateDesktop([s('c1'), s('c2'), s('t1')], map);
    expect(out.map((x) => [x.id, x.project, x.desktopId])).toEqual([['c1', 'Кто ты?', 'local_1'], ['t1', 'scratch-2026', undefined]]);
  });
});
