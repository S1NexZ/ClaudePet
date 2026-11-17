#!/usr/bin/env node
// Claude Code statusLine command: saves the account's real rate limits for ccPet and prints a short line.
// Claude Code passes them (documented: rate_limits.five_hour / seven_day, used_percentage + resets_at) on stdin for
// Pro/Max/Ultra subscribers, after the first API response of a session. Nothing is invented: if a window is absent, it is not written.
// Must never fail or slow Claude Code down: always exits 0.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const file = process.env.CLAUDE_PET_USAGE ?? join(homedir(), '.claude-pet', 'usage.json');
const win = (w) => (w && Number.isFinite(Number(w.used_percentage)) && Number.isFinite(Number(w.resets_at))
  ? { used_percentage: Number(w.used_percentage), resets_at: Number(w.resets_at) } : null);

// `--chain <base64 JSON>`: the user's own statusLine, wrapped by the pet. We store the limits, then run it with the same input and print ITS output.
const chainAt = process.argv.indexOf('--chain');
let chained = null;
if (chainAt > 0) { try { chained = JSON.parse(Buffer.from(String(process.argv[chainAt + 1] ?? ''), 'base64url').toString('utf8')); } catch { chained = {}; } }

let input = '';
try { input = readFileSync(0, 'utf8'); } catch { /* no input */ }
try {
  const event = JSON.parse(input);
  const rl = event?.rate_limits;
  const five = win(rl?.five_hour), seven = win(rl?.seven_day);
  if (five || seven) {
    // other sessions re-render their line with the numbers of their last API response: within one window (same reset time) usage only
    // grows, so a lower value is stale and the saved one stays; a later reset time is a new window
    let saved = null;
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
    const keep = (n, o) => { o = win(o); if (!n) return o; if (!o) return n; if (o.resets_at !== n.resets_at) return o.resets_at > n.resets_at ? o : n; return o.used_percentage > n.used_percentage ? o : n; };
    const five2 = keep(five, saved?.five_hour), seven2 = keep(seven, saved?.seven_day);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), five_hour: five2, seven_day: seven2 }), { mode: 0o600 });
    renameSync(tmp, file); // atomic: the bridge never reads a half-written file
    const p = (w) => `${Math.round(w.used_percentage)}%`;
    if (!chainAt || chainAt < 0) process.stdout.write([five2 && `5h ${p(five2)}`, seven2 && `7d ${p(seven2)}`].filter(Boolean).join(' · ') + '\n');
  }
} catch { /* ignore: a status line must never break the session */ }
if (chained) {
  try {
    const cmd = typeof chained.command === 'string' ? chained.command : '';
    if (cmd) { const r = spawnSync(cmd, { shell: true, input, encoding: 'utf8', timeout: 4000 }); if (r.stdout) process.stdout.write(r.stdout); }
  } catch { /* the user's own line failed: show nothing rather than break the session */ }
}
process.exit(0);
