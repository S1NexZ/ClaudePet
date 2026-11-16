import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
await build({ entryPoints: [join(root, 'src/main.ts')], outfile: join(dist, 'main.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['electron'] });
await build({ entryPoints: [join(root, 'src/renderer/app.ts')], outfile: join(dist, 'renderer.js'),
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome120' });
for (const f of ['preload.cjs']) copyFileSync(join(root, 'src', f), join(dist, f));
copyFileSync(join(root, 'assets/icon.png'), join(dist, 'icon.png'));
for (const f of ['index.html', 'styles.css']) copyFileSync(join(root, 'src/renderer', f), join(dist, f));
console.log('ui built ->', dist);
