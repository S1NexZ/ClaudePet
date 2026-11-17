import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planStatusLine, removeStatusLine, statusLineState, runInstallStatusLine } from './installStatusLine.js';

const S = '/opt/pet/hook/pet-statusline.mjs', N = '/usr/bin/node';
const CMD = `"${N}" "${S}" 2>/dev/null || true`;

describe('planStatusLine', () => {
  it('adds only statusLine and keeps everything else (hooks, model, permissions)', () => {
    const cur = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, permissions: { allow: ['Bash(ls)'] } };
    const { next, diff, kind } = planStatusLine(cur, S, N);
    expect(kind).toBe('ours');
    expect(next.statusLine).toEqual({ type: 'command', command: CMD, padding: 0 });
    expect({ ...next, statusLine: undefined }).toEqual({ ...cur, statusLine: undefined });
    expect(diff).toContain('+ ');
    expect(diff).not.toContain('- ');
  });
  it('is idempotent and updates our own entry to a new path', () => {
    const once = planStatusLine({}, S, N).next;
    expect(planStatusLine(once, S, N).diff).toBe('');
    const moved = planStatusLine(once, '/new/pet-statusline.mjs', N);
    expect((moved.next as any).statusLine.command).toContain('/new/pet-statusline.mjs');
    expect(moved.diff).toContain('- ');
  });
  it("wraps someone else's statusLine instead of replacing it, and removing restores it byte for byte", () => {
    const mine = { type: 'command', command: `bash -c 'echo "$HOME $(date) \\"q\\"'`, padding: 2, refreshInterval: 5 };
    const cur = { model: 'opus', statusLine: mine };
    const r = planStatusLine(cur, S, N);
    expect(r.kind).toBe('chained');
    expect((r.next as any).statusLine.command).toContain(' --chain ');
    expect((r.next as any).statusLine.padding).toBe(2);
    expect(statusLineState(r.next)).toBe('chained');
    expect(planStatusLine(r.next, S, N).diff).toBe('');                       // idempotent
    const back = removeStatusLine(r.next);
    expect(back.next).toEqual(cur);
    expect(JSON.stringify(back.next)).toBe(JSON.stringify(cur));
    expect(back.diff).toContain('- ');
  });
  it('removing our plain statusLine deletes it; a foreign one is untouched', () => {
    expect(removeStatusLine(planStatusLine({ model: 'x' }, S, N).next).next).toEqual({ model: 'x' });
    const foreign = { statusLine: { type: 'command', command: 'mine.sh' } };
    expect(removeStatusLine(foreign)).toEqual({ next: foreign, diff: '' });
  });
});

describe('runInstallStatusLine', () => {
  const setup = (content?: string) => {
    const d = mkdtempSync(join(tmpdir(), 'sl-'));
    const settingsPath = join(d, 'settings.json');
    if (content !== undefined) writeFileSync(settingsPath, content);
    const out: string[] = [];
    return { d, settingsPath, out, base: { settingsPath, scriptPath: S, nodePath: N, out: (l: string) => out.push(l), now: () => new Date('2026-11-16T12:34:56Z') } };
  };
  it('dry run shows the diff and writes nothing', async () => {
    const t = setup('{"model":"opus"}');
    expect(await runInstallStatusLine({ ...t.base, yes: false, dryRun: true, ask: async () => 'y' })).toBe(false);
    expect(readFileSync(t.settingsPath, 'utf8')).toBe('{"model":"opus"}');
    expect(t.out.join('\n')).toContain('statusLine');
  });
  it('declining writes nothing; accepting writes a timestamped backup first', async () => {
    const t = setup('{"model":"opus"}');
    expect(await runInstallStatusLine({ ...t.base, yes: false, ask: async () => 'n' })).toBe(false);
    expect(readdirSync(t.d)).toEqual(['settings.json']);
    expect(await runInstallStatusLine({ ...t.base, yes: false, ask: async () => 'y' })).toBe(true);
    expect(readdirSync(t.d).sort()).toEqual(['settings.json', 'settings.json.bak-statusline-20261116123456']);
    expect(readFileSync(join(t.d, 'settings.json.bak-statusline-20261116123456'), 'utf8')).toBe('{"model":"opus"}');
    const now = JSON.parse(readFileSync(t.settingsPath, 'utf8'));
    expect(now.model).toBe('opus');
    expect(now.statusLine.command).toBe(CMD);
  });
  it('invalid JSON is left untouched; a foreign statusLine is wrapped (with a backup), not overwritten', async () => {
    const bad = setup('{oops');
    await expect(runInstallStatusLine({ ...bad.base, yes: true, ask: async () => 'y' })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(bad.settingsPath, 'utf8')).toBe('{oops');
    const foreign = setup('{"statusLine":{"type":"command","command":"x"}}');
    expect(await runInstallStatusLine({ ...foreign.base, yes: true, ask: async () => 'y' })).toBe(true);
    const written = JSON.parse(readFileSync(foreign.settingsPath, 'utf8'));
    expect(written.statusLine.command).toContain(' --chain ');
    expect(readdirSync(foreign.d).some((f) => f.startsWith('settings.json.bak-statusline-'))).toBe(true);
  });
});

describe('Windows statusLine (pet-helper.exe statusline)', () => {
  const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\claude-pet\\resources\\helper\\pet-helper.exe';
  it('points statusLine at the helper (no POSIX redirections: the helper never fails or writes to stderr)', () => {
    const { next, kind } = planStatusLine({}, '', '', { exe: EXE });
    expect(kind).toBe('ours');
    expect(next.statusLine).toEqual({ type: 'command', command: `"${EXE}" statusline`, padding: 0 });
    expect(statusLineState(next)).toBe('ours');
  });
  it("wraps the user's own line and restores it; an updated helper path replaces ours", () => {
    const mine = { type: 'command', command: 'powershell -c "Get-Date"' };
    const r = planStatusLine({ statusLine: mine }, '', '', { exe: EXE });
    expect(r.kind).toBe('chained');
    expect(statusLineState(r.next)).toBe('chained');
    expect(removeStatusLine(r.next).next.statusLine).toEqual(mine);
    const moved = planStatusLine(r.next, '', '', { exe: 'D:\\pet\\pet-helper.exe' });
    expect(moved.next.statusLine.command).toContain('D:\\pet\\pet-helper.exe');
    expect(removeStatusLine(moved.next).next.statusLine).toEqual(mine);
  });
});

