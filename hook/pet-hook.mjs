#!/usr/bin/env node
// Claude Code hook: forwards the event JSON to the ccPet bridge over a unix socket.
// Must never block or fail Claude Code: always exits 0, prints nothing, gives up after 150 ms.
import { connect } from 'node:net';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// `pet-hook.mjs wait`: the mailbox waiter (an `asyncRewake` hook). It long-polls the pet; a message is printed to stderr and the exit code 2 wakes
// the Claude Code session with it. No pet / unknown session / claude gone: exits 0 quietly.
/** A one-shot `claude -p` (print mode with a prompt, not a stream-json session like the desktop app's) in the hook's parent chain. */
function isOneShot(args) {
  const print = args.some((a) => a === '-p' || a === '--print' || a.startsWith('--print='));
  const streamIn = args.some((a, i) => a === '--input-format=stream-json' || (a === '--input-format' && args[i + 1] === 'stream-json'));
  return print && !streamIn;
}
function oneShot(pid) {
  for (let i = 0; i < 3 && pid > 1; i++) {
    try {
      if (isOneShot(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'))) return true;
      const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) || 0;
    } catch { return false; }
  }
  return false;
}

if (process.argv[2] === 'wait') {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  const stop = () => process.exit(0);
  process.stdin.on('error', stop);
  process.stdin.on('end', () => {
    let sid = '';
    try { sid = JSON.parse(raw).session_id; } catch { return stop(); }
    const readHub = () => { try { return JSON.parse(readFileSync(join(homedir(), '.claude-pet', 'hub.json'), 'utf8')); } catch { return null; } };
    if (!sid || !/^[\w-]{1,100}$/.test(sid) || !readHub()?.port) return stop();
    const parent = process.ppid;
    if (oneShot(parent)) return stop(); // `claude -p "…"` waits for its async hooks before exiting: a waiter there would hang it
    const alive = () => { try { process.kill(parent, 0); return true; } catch { return false; } };
    // no answer (the pet is not running or restarting): try again later while claude lives, so the session stays reachable
    const later = () => setTimeout(poll, Number(process.env.CLAUDE_PET_WAIT_RETRY_MS) || 10000);
    const poll = () => {
      if (!alive()) return stop();
      const hub = readHub();
      if (!hub?.port || !hub?.token) return later();
      const req = request({ host: '127.0.0.1', port: hub.port, path: `/mailbox/${hub.token}/${sid}`, method: 'GET', timeout: 70000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode === 200 && body) { process.stderr.write(body); process.exit(2); }
          if (res.statusCode === 204) return poll();
          stop(); // 409 (another waiter) or anything unexpected
        });
      });
      req.on('timeout', () => { req.destroy(); poll(); });
      req.on('error', later);
      req.end();
    };
    poll();
  });
} else {
const path = process.env.CLAUDE_PET_SOCK ?? join(homedir(), '.claude-pet', 'hook.sock');
const done = () => process.exit(0);
setTimeout(done, 150).unref?.();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('error', done);
/** Parent pid from /proc (0 if unknown). */
const parentOf = (pid) => {
  try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) || 0; }
  catch { return 0; }
};

process.stdin.on('end', () => {
  let event;
  try { event = JSON.parse(input); } catch { return done(); }
  // the chain claude -> sh -> node: lets the pet find (and on request end) the claude process of this session
  const parents = [process.ppid];
  for (let i = 0; i < 3 && parents.at(-1) > 1; i++) parents.push(parentOf(parents.at(-1)));
  // set when claude was started through scripts/pet-claude.py: the pet can type into this very process
  if (process.env.PET_PTY_SOCK) event.pet_pty = process.env.PET_PTY_SOCK;
  event.pet_parents = parents.filter((p) => p > 1);
  const c = connect(path, () => c.end(JSON.stringify(event)));
  c.on('error', done);
  c.on('close', done);
});
}
