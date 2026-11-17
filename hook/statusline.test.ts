import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, 'pet-statusline.mjs');
const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const event = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 23, resets_at: 1900000000 }, seven_day: { used_percentage: 77, resets_at: 1900500000 } } });
const run = (args: string[], file: string, input = event) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PET_USAGE: file } });

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
});
