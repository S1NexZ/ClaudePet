import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRunning } from './adopt.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ad-'));
  const mk = (proj: string, id: string, lines: object[], ageMs: number) => {
    mkdirSync(join(root, proj), { recursive: true });
    const f = join(root, proj, `${id}.jsonl`);
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'));
    const t = (Date.now() - ageMs) / 1000; utimesSync(f, t, t);
  };
  return { root, mk };
}

describe('findRunning', () => {
  it('finds recently written transcripts with their folder and front end; skips old ones and SDK-run sessions', async () => {
    const { root, mk } = fixture();
    mk('C--Users-x-proj', 'a1', [{ type: 'mode' }, { type: 'user', entrypoint: 'claude-desktop', cwd: 'C:\\Users\\x\\proj' }], 60_000);
    mk('-home-x-p', 'b2', [{ type: 'user', entrypoint: 'cli', cwd: '/home/x/p' }], 30_000);
    mk('-tmp', 'c3', [{ type: 'user', entrypoint: 'sdk-cli', cwd: '/tmp' }], 10_000);
    mk('-old', 'd4', [{ type: 'user', entrypoint: 'cli', cwd: '/old' }], 3 * 3600_000);
    mk('-nocwd', 'e5', [{ type: 'mode' }], 1000);
    const r = await findRunning(root, Date.now(), 10 * 60_000);
    expect(r.map((x) => [x.id, x.cwd, x.source])).toEqual([['b2', '/home/x/p', 'cli'], ['a1', 'C:\\Users\\x\\proj', 'claude-desktop']]);
  });
  it('a missing folder gives an empty list', async () => {
    expect(await findRunning('/definitely/not/here', Date.now(), 1000)).toEqual([]);
  });
});
