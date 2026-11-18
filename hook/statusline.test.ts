import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, 'pet-statusline.mjs');
const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const event = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 23, resets_at: 1900000000 }, seven_day: { used_percentage: 77, resets_at: 1900500000 } } });
/** PET_HOOK_BIN: run the native ccpet-hook instead of the Node script (same behaviour expected) */
const BIN = process.env.PET_HOOK_BIN;
const run = (args: string[], file: string, input = event) => spawnSync(BIN ?? process.execPath, BIN ? ['statusline', ...args] : [SCRIPT, ...args], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PET_USAGE: file } });

describe('pet-statusline.mjs', () => {
  it('stores the limits and prints its own short line when it is not chained', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sl-')), 'usage.json');
    const r = run([], file);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ five_hour: { used_percentage: 23 }, seven_day: { used_percentage: 77 } });
    expect(r.stdout).toContain('23%');
  });
  it('chained: still stores the limits, then prints the original command output (same stdin), not its own line', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sl-')), 'usage.json');
    const orig = { type: 'command', command: `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('mine '+JSON.parse(d).rate_limits.five_hour.used_percentage))"` };
    const r = run(['--chain', enc(orig)], file);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('mine 23');
    expect(existsSync(file)).toBe(true);
  });
  it('chained with a broken or missing original: exits 0, prints nothing, still stores the limits', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sl-')), 'usage.json');
    for (const arg of [enc({ command: 'definitely-not-a-command-xyz' }), 'not-base64!!', enc({})]) {
      const r = run(['--chain', arg], file);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    }
    expect(existsSync(file)).toBe(true);
  });
  it('a stale report from an idle session (same window, lower usage) does not roll the saved numbers back; a new window replaces them', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sl-')), 'usage.json');
    const ev = (five: number, week: number, reset = 1900000000) => JSON.stringify({ rate_limits: { five_hour: { used_percentage: five, resets_at: reset }, seven_day: { used_percentage: week, resets_at: 1900500000 } } });
    run([], file, ev(43, 97));
    run([], file, ev(14, 94)); // the idle session re-renders with its old numbers
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ five_hour: { used_percentage: 43 }, seven_day: { used_percentage: 97 } });
    run([], file, ev(2, 98, 1900020000)); // the 5 h window reset: a later reset time
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ five_hour: { used_percentage: 2, resets_at: 1900020000 }, seven_day: { used_percentage: 98 } });
  });
});

