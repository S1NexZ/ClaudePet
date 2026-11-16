// Bundles the WSL bridge into build/bridge/bridge.cjs (+ build/hook) — the tree the app ships as resources.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(join(root, 'build/bridge'), { recursive: true });
mkdirSync(join(root, 'build/hook'), { recursive: true });
await build({
  entryPoints: [join(root, 'daemon/src/bridgeMain.ts')], outfile: join(root, 'build/bridge/bridge.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'error',
  // the bundled SDK reads import.meta.url, which a CJS bundle doesn't have
  define: { 'import.meta.url': '__bridgeUrl' },
  banner: { js: "const __bridgeUrl = require('node:url').pathToFileURL(__filename).href;" },
});
copyFileSync(join(root, 'hook/pet-hook.mjs'), join(root, 'build/hook/pet-hook.mjs'));
copyFileSync(join(root, 'hook/pet-statusline.mjs'), join(root, 'build/hook/pet-statusline.mjs'));
console.log('bridge built -> build/bridge/bridge.cjs');
