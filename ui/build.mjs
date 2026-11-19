import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
await build({ entryPoints: [join(root, 'src/renderer/app.ts')], outfile: join(dist, 'renderer.js'),
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome120' });
copyFileSync(join(root, 'assets/icon.png'), join(dist, 'icon.png'));
for (const f of ['index.html', 'styles.css']) copyFileSync(join(root, 'src/renderer', f), join(dist, f));
console.log('ui built ->', dist);
