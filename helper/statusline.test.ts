import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// pet-helper.exe statusline (the Windows twin of hook/pet-statusline.mjs). Runs where the exe can run: Windows, or WSL with interop.
const EXE = join(__dirname, '..', 'ui', 'helper', 'pet-helper.exe');
const wsl = process.platform === 'linux' && existsSync('/mnt/c');
const runnable = existsSync(EXE) && (process.platform === 'win32' || wsl);
const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const event = JSON.stringify({ model: { id: 'x' }, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1900000000 }, seven_day: { used_percentage: 77, resets_at: 1900500000 } } });
const tmp = () => { const base = join(__dirname, '..', 'node_modules', '.cache'); mkdirSync(base, { recursive: true }); return mkdtempSync(join(base, 'sl-')); };
const winPath = (p: string) => (wsl ? execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim() : p);
const run = (args: string[], file: string, input = event) => spawnSync(EXE, ['statusline', ...args], {
  input, encoding: 'utf8',
  env: { ...process.env, CLAUDE_PET_USAGE: winPath(file), WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ''}CLAUDE_PET_USAGE` },
});

describe.runIf(runnable)('pet-helper.exe statusline', () => {
  it('stores the limits in the same format as pet-statusline.mjs and prints a short line', () => {
    const file = join(tmp(), 'usage.json');
    const r = run([], file);
    expect(r.status).toBe(0);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    expect(j).toMatchObject({ version: 1, five_hour: { used_percentage: 23.5, resets_at: 1900000000 }, seven_day: { used_percentage: 77, resets_at: 1900500000 } });
    expect(j.updatedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(r.stdout).toContain('24%');
    expect(r.stdout).toContain('77%');
  });
  it('no limits in the input (API key users, first render): writes nothing, prints nothing, exits 0', () => {
    const file = join(tmp(), 'usage.json');
    const r = run([], file, JSON.stringify({ model: { id: 'x' } }));
    expect([r.status, r.stdout]).toEqual([0, '']);
    expect(existsSync(file)).toBe(false);
  });
  it('chained: stores the limits, then prints the user\'s own line instead of its own', () => {
    const file = join(tmp(), 'usage.json');
    const r = run(['--chain', enc({ type: 'command', command: 'echo mine' })], file);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('mine');
    expect(existsSync(file)).toBe(true);
  });
  it('a broken chain or garbage input never fails', () => {
    const file = join(tmp(), 'usage.json');
    for (const arg of ['not-base64!!', enc({})]) expect(run(['--chain', arg], file).status).toBe(0);
    expect(run([], file, '{not json').status).toBe(0);
  });
});
