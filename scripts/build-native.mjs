// Builds the native hook and bridge (native/ccpet-hook, native/ccpet-bridge, Rust) into build/hook/, the folder the app ships as resources/hook.
//   Windows / WSL: a static Linux binary for the WSL bridge (x86_64-unknown-linux-musl), built with Windows' cargo (no C toolchain in WSL needed).
//   Linux:         the same static binary.
//   macOS:         a universal binary (arm64 + x64).
// No cargo: skips quietly; the bridge then keeps using the Node hook (pet-hook.mjs).
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = join(root, 'native');
const outDir = join(root, 'build', 'hook');
const BINS = ['ccpet-hook', 'ccpet-bridge'];
mkdirSync(outDir, { recursive: true });
const wsl = process.platform === 'linux' && !!process.env.WSL_DISTRO_NAME;
const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: 'inherit', ...opts });

function cargoBuild(target) {
  if (wsl) {
    // Windows' cargo (MSVC host) links the Linux build scripts' host part itself; WSL has no C compiler of its own
    const winCargo = '%USERPROFILE%\\.cargo\\bin\\cargo.exe';
    const nativeWin = execFileSync('wslpath', ['-w', native], { encoding: 'utf8' }).trim();
    run('cmd.exe', ['/c', `cd /d ${nativeWin} && set CARGO_TARGET_DIR=%LOCALAPPDATA%\\ccpet-target&& ${winCargo} build --release -p ccpet-hook -p ccpet-bridge --target ${target}`]);
    const localAppData = execFileSync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { encoding: 'utf8' }).trim();
    return join(execFileSync('wslpath', [localAppData], { encoding: 'utf8' }).trim(), 'ccpet-target', target, 'release');
  }
  const cargo = process.platform === 'win32' ? 'cargo.exe' : existsSync(join(homedir(), '.cargo/bin/cargo')) ? join(homedir(), '.cargo/bin/cargo') : 'cargo';
  run(cargo, ['build', '--release', '-p', 'ccpet-hook', '-p', 'ccpet-bridge', '--target', target], { cwd: native });
  return join(native, 'target', target, 'release');
}

try {
  for (const b of BINS) rmSync(join(outDir, b), { force: true });
  if (process.platform === 'darwin') {
    const dirs = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map(cargoBuild);
    for (const b of BINS) run('lipo', ['-create', '-output', join(outDir, b), ...dirs.map((d) => join(d, b))]);
  } else {
    const d = cargoBuild('x86_64-unknown-linux-musl');
    for (const b of BINS) copyFileSync(join(d, b), join(outDir, b));
  }
  for (const b of BINS) chmodSync(join(outDir, b), 0o755);
  console.log('native hook and bridge built ->', outDir);
} catch (e) {
  for (const b of BINS) rmSync(join(outDir, b), { force: true });
  console.log(`native hook and bridge not built (${e.message.split('\n')[0]}): the Node hook and bridge are used`);
}
