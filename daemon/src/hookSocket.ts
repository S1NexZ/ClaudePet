import { createServer, connect } from 'node:net';
import { mkdirSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { HookEvent } from '../../shared/src/types.js';

export type HookPayload = HookEvent & { transcript_path?: string; pet_parents?: number[]; pet_pty?: string };
export const defaultSocketPath = () => process.env.CLAUDE_PET_SOCK ?? join(homedir(), '.claude-pet', 'hook.sock');
const MAX = 1_000_000;

const isLive = (path: string) => new Promise<boolean>((resolve) => {
  const c = connect(path);
  c.once('connect', () => { c.destroy(); resolve(true); });
  c.once('error', () => resolve(false));
});

/** Listens on a unix socket for hook events (one JSON document per connection). */
export async function listenHooks(path: string, onEvent: (e: HookPayload) => void): Promise<{ close(): Promise<void> }> {
  if (await isLive(path)) throw new Error(`ccPet bridge is already running (${path})`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true }); // stale socket from a crash
  const server = createServer((conn) => {
    let body = '';
    conn.setEncoding('utf8');
    conn.on('data', (d) => { body += d; if (body.length > MAX) { body = ''; conn.destroy(); } });
    conn.on('error', () => { /* client vanished */ });
    conn.on('end', () => {
      try {
        const e = JSON.parse(body);
        if (e && typeof e.session_id === 'string' && typeof e.hook_event_name === 'string')
          onEvent({ ...e, cwd: typeof e.cwd === 'string' ? e.cwd : '' });
      } catch { /* not JSON: ignore */ }
      conn.end();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return {
    close: () => new Promise<void>((resolve) => server.close(() => { rmSync(path, { force: true }); resolve(); })),
  };
}
