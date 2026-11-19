// Builds the Tauri app's Windows installer (phase 3): pet-helper.exe, the WSL hook and bridge, the renderer, then the NSIS bundle
// (Windows' cargo and the Tauri CLI from npm, run through cmd.exe from WSL). Output: ui/release/ccPet-<version>_x64-setup.exe.
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: 'inherit', cwd: root, ...opts });
for (const s of ['scripts/build-helper.mjs', 'scripts/build-native.mjs', 'ui/build.mjs']) run(process.execPath, [s]);
const appWin = execFileSync('wslpath', ['-w', join(root, 'native', 'app')], { encoding: 'utf8' }).trim();
run('cmd.exe', ['/c', `cd /d ${appWin} && set CARGO_TARGET_DIR=%LOCALAPPDATA%\\ccpet-target&& npx -y @tauri-apps/cli@2 build --bundles nsis`]);
const version = JSON.parse(readFileSync(join(root, 'native', 'app', 'tauri.conf.json'), 'utf8')).version;
const localAppData = execFileSync('wslpath', [execFileSync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { encoding: 'utf8' }).trim()], { encoding: 'utf8' }).trim();
const out = join(localAppData, 'ccpet-target', 'release', 'bundle', 'nsis', `ccPet_${version}_x64-setup.exe`);
const dest = join(root, 'ui', 'release', `ccPet-${version}_x64-setup.exe`);
copyFileSync(out, dest);
console.log(`installer -> ${dest}`);
