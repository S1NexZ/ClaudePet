// Entry point of the WSL bridge: JSON lines on stdin/stdout to the Electron app, unix socket for hooks.
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableHookDir, stableRuntime } from './nodeCmd.js';
import { SessionStore } from './sessionStore.js';
import { SessionRunner } from './runner.js';
import { createBridge } from './bridge.js';
import { listenHooks, defaultSocketPath } from './hookSocket.js';
import { startHookServer } from './hookHttp.js';
import { createMailbox } from './mailbox.js';
import { findRunning } from './adopt.js';
import { readTranscript } from './transcript.js';
import { createUsageSource } from './usage.js';
import { createUsagePoller, makeLiveFetch } from './usageLive.js';
import type { AppCommand, BridgeMessage } from '../../shared/src/types.js';

const send = (m: BridgeMessage | { type: 'ready'; claude: string | null; distro: string }) => process.stdout.write(JSON.stringify(m) + '\n');

function findClaude(): string | undefined {
  const candidates = [process.env.CLAUDE_PET_CLAUDE_BIN, join(homedir(), '.local/bin/claude'), join(homedir(), '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(homedir(), '.npm-global/bin/claude'), join(homedir(), '.bun/bin/claude')];
  for (const c of candidates) if (c && existsSync(c)) return c;
  try { return execFileSync(process.env.SHELL && /\/(ba|z|da)?sh$/.test(process.env.SHELL) ? process.env.SHELL : 'bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}

const here = dirname(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url));
const hookPath = process.env.CLAUDE_PET_HOOK ?? join(stableHookDir(join(here, '../hook'), join(homedir(), '.claude-pet', 'bin')), 'pet-hook.mjs');
const claude = findClaude();
const store = new SessionStore();
let bridge: ReturnType<typeof createBridge>;
// HTTP receiver of this WSL host (mailbox long-poll, PermissionRequest answers); its port and token are shared with `pet-hook.mjs wait` through ~/.claude-pet/hub.json
const hubFile = join(homedir(), '.claude-pet', 'hub.json');
const hubPort = Number(process.env.CLAUDE_PET_HOOK_PORT) || 47822;
const hubToken = (() => {
  try { const t = JSON.parse(readFileSync(hubFile, 'utf8'))?.token; if (typeof t === 'string' && /^[0-9a-f]{16,}$/.test(t)) return t; } catch { /* first run */ }
  return randomBytes(16).toString('hex');
})();
const mailbox = createMailbox();
const runner = new SessionRunner({
  store, claudePath: claude,
  onChange: () => bridge.snapshot(true),
  onChat: (sid, e) => bridge.onChat(sid, e),
});
// the limits query runs only when the user clicks the ring (refresh()), never on a timer; CLAUDE_PET_LIVE_USAGE=0 removes it entirely
const poller = process.env.CLAUDE_PET_LIVE_USAGE === '0' ? null
  : createUsagePoller({ fetch: makeLiveFetch({ claudePath: claude }), onChange: () => { void bridge.pushUsage(); }, onStart: () => { void bridge.pushUsage(); } });
bridge = createBridge({
  store, runner, out: send, readTranscript,
  usage: createUsageSource({ settingsPath: join(homedir(), '.claude', 'settings.json'), claudePath: claude, live: poller ?? undefined }),
  hooks: { settingsPath: join(homedir(), '.claude', 'settings.json'), hookPath, nodePath: stableRuntime() },
  mailbox, permissionIdPrefix: 'hl-',
  hostHooks: { origin: `http://127.0.0.1:${hubPort}`, token: hubToken },
});

const httpHooks = startHookServer({ port: hubPort, token: hubToken, mailbox, onEvent: (e) => bridge.onHook(e), onPermission: (e) => bridge.onPermission(e) })
  .then((srv) => {
    mkdirSync(dirname(hubFile), { recursive: true, mode: 0o700 });
    writeFileSync(hubFile, JSON.stringify({ port: srv.port, token: hubToken }), { mode: 0o600 });
    return srv;
  })
  .catch((e: Error) => { process.stderr.write(`hook http receiver unavailable: ${e.message}\n`); return null; });
listenHooks(defaultSocketPath(), (e) => bridge.onHook(e))
  .then(async (hooks) => {
    const http = await httpHooks;
    send({ type: 'ready', claude: claude ?? null, distro: process.env.WSL_DISTRO_NAME ?? '' });
    bridge.snapshot();
    poller?.refresh(); // one query when the pet starts (the numbers on disk may be hours old); after that only the user's click or the status line
    const adopted = new Set<string>();
    let lastAdopt = 0;
    const adoptRecent = async (now: number) => {
      for (const r of await findRunning(join(homedir(), '.claude', 'projects'), now, 10 * 60_000)) {
        if (adopted.has(r.id) || store.get(r.id)) continue;
        adopted.add(r.id);
        bridge.onHook({ hook_event_name: 'SessionStart', session_id: r.id, cwd: r.cwd, transcript_path: r.path });
      }
    };
    const timer = setInterval(() => { const now = Date.now(); bridge.tick(now); if (now - lastAdopt > 15_000) { lastAdopt = now; void adoptRecent(now).catch(() => {}); } }, 1500);
    const quit = () => { clearInterval(timer); runner.closeAll(); void Promise.all([poller?.stop(), hooks.close(), http?.close()]).then(() => process.exit(0)); };
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let cmd: AppCommand;
      try { cmd = JSON.parse(line); } catch { return; }
      void bridge.handle(cmd);
    });
    rl.on('close', quit); // the app went away
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
  })
  .catch((e: Error) => { send({ type: 'error', message: e.message }); process.exit(1); });
