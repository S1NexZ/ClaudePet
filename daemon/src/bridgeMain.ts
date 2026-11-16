// Entry point of the WSL bridge: JSON lines on stdin/stdout to the Electron app, unix socket for hooks.
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './sessionStore.js';
import { SessionRunner } from './runner.js';
import { createBridge } from './bridge.js';
import { listenHooks, defaultSocketPath } from './hookSocket.js';
import { readTranscript } from './transcript.js';
import { createUsageSource } from './usage.js';
import { createUsagePoller, makeLiveFetch } from './usageLive.js';
import type { AppCommand, BridgeMessage } from '../../shared/src/types.js';

const send = (m: BridgeMessage | { type: 'ready'; claude: string | null; distro: string }) => process.stdout.write(JSON.stringify(m) + '\n');

function findClaude(): string | undefined {
  const candidates = [process.env.CLAUDE_PET_CLAUDE_BIN, join(homedir(), '.local/bin/claude'), join(homedir(), '.claude/local/claude')];
  for (const c of candidates) if (c && existsSync(c)) return c;
  try { return execFileSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}

const here = dirname(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url));
const hookPath = process.env.CLAUDE_PET_HOOK ?? join(here, '../hook/pet-hook.mjs');
const claude = findClaude();
const store = new SessionStore();
let bridge: ReturnType<typeof createBridge>;
const runner = new SessionRunner({
  store, claudePath: claude,
  onChange: () => bridge.snapshot(true),
  onChat: (sid, e) => bridge.onChat(sid, e),
});
// periodic limits query (CLAUDE_PET_LIVE_USAGE=0 turns it off); starts once the bridge is listening, stops with it
const poller = process.env.CLAUDE_PET_LIVE_USAGE === '0' ? null
  : createUsagePoller({ fetch: makeLiveFetch({ claudePath: claude }), onChange: () => { void bridge.pushUsage(); } });
bridge = createBridge({
  store, runner, out: send, readTranscript,
  usage: createUsageSource({ settingsPath: join(homedir(), '.claude', 'settings.json'), claudePath: claude, live: poller ?? undefined }),
  hooks: { settingsPath: join(homedir(), '.claude', 'settings.json'), hookPath, nodePath: process.execPath },
});

listenHooks(defaultSocketPath(), (e) => bridge.onHook(e))
  .then((hooks) => {
    send({ type: 'ready', claude: claude ?? null, distro: process.env.WSL_DISTRO_NAME ?? '' });
    bridge.snapshot();
    poller?.start();
    const timer = setInterval(() => bridge.tick(Date.now()), 1500);
    const quit = () => { clearInterval(timer); runner.closeAll(); void Promise.all([poller?.stop(), hooks.close()]).then(() => process.exit(0)); };
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
