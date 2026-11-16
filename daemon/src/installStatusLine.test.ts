import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planStatusLine, runInstallStatusLine } from './installStatusLine.js';

const S = '/opt/pet/hook/pet-statusline.mjs', N = '/usr/bin/node';
const CMD = `"${N}" "${S}" 2>/dev/null || true`;

describe('planStatusLine', () => {
  it('adds only statusLine and keeps everything else (hooks, model, permissions)', () => {
    const cur = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, permissions: { allow: ['Bash(ls)'] } };
    const { next, diff, foreign } = planStatusLine(cur, S, N) as any;
    expect(foreign).toBe(false);
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
  it("never replaces someone else's statusLine", () => {
    const cur = { statusLine: { type: 'command', command: 'my-line.sh' } };
    const r = planStatusLine(cur, S, N);
    expect(r.foreign).toBe(true);
    expect(r.next).toEqual(cur);
    expect(r.diff).toBe('');
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
  it('invalid JSON and foreign statusLine are left untouched', async () => {
    const bad = setup('{oops');
    await expect(runInstallStatusLine({ ...bad.base, yes: true, ask: async () => 'y' })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(bad.settingsPath, 'utf8')).toBe('{oops');
    const foreign = setup('{"statusLine":{"type":"command","command":"x"}}');
    expect(await runInstallStatusLine({ ...foreign.base, yes: true, ask: async () => 'y' })).toBe(false);
    expect(readFileSync(foreign.settingsPath, 'utf8')).toBe('{"statusLine":{"type":"command","command":"x"}}');
  });
});
