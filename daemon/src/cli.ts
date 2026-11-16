import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall } from './installHooks.js';
import { runInstallStatusLine } from './installStatusLine.js';

const [cmd, ...flags] = process.argv.slice(2);
if (cmd !== 'install-hooks' && cmd !== 'install-statusline') {
  console.error('usage: claude-pet install-hooks [--yes] | install-statusline [--dry-run] [--yes]');
  process.exit(2);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const settingsPath = process.env.CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json');
const run = cmd === 'install-statusline'
  ? runInstallStatusLine({
    settingsPath, scriptPath: process.env.CLAUDE_PET_STATUSLINE ?? resolve(fileURLToPath(new URL('../../hook/pet-statusline.mjs', import.meta.url))),
    nodePath: process.execPath, yes: flags.includes('--yes'), dryRun: flags.includes('--dry-run'),
    ask: (q) => rl.question(q), out: (l) => console.log(l),
  })
  : runInstall({
  settingsPath,
  hookPath: resolve(fileURLToPath(new URL('../../hook/pet-hook.mjs', import.meta.url))),
  nodePath: process.execPath,
  yes: flags.includes('--yes'),
  ask: (q) => rl.question(q),
  out: (l) => console.log(l),
});
run.catch((e: Error) => { console.error(e.message); process.exitCode = 1; }).finally(() => rl.close());
