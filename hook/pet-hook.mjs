#!/usr/bin/env node
// Claude Code hook: forwards the event JSON to the Claude Pet bridge over a unix socket.
// Must never block or fail Claude Code: always exits 0, prints nothing, gives up after 150 ms.
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
