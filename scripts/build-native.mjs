// Builds the native hook (native/ccpet-hook, Rust) into build/hook/ccpet-hook, the folder the app ships as resources/hook.
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
const out = join(root, 'build', 'hook', 'ccpet-hook');
mkdirSync(dirname(out), { recursive: true });
const wsl = process.platform === 'linux' && !!process.env.WSL_DISTRO_NAME;
const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: 'inherit', ...opts });

function cargoBuild(target) {
  if (wsl) {
    // Windows' cargo (MSVC host) links the Linux build scripts' host part itself; WSL has no C compiler of its own
    const winCargo = '%USERPROFILE%\\.cargo\\bin\\cargo.exe';
    const nativeWin = execFileSync('wslpath', ['-w', native], { encoding: 'utf8' }).trim();
    run('cmd.exe', ['/c', `cd /d ${nativeWin} && set CARGO_TARGET_DIR=%LOCALAPPDATA%\\ccpet-target&& ${winCargo} build --release -p ccpet-hook --target ${target}`]);
    const localAppData = execFileSync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { encoding: 'utf8' }).trim();
    return join(execFileSync('wslpath', [localAppData], { encoding: 'utf8' }).trim(), 'ccpet-target', target, 'release', 'ccpet-hook');
  }
  const cargo = process.platform === 'win32' ? 'cargo.exe' : existsSync(join(homedir(), '.cargo/bin/cargo')) ? join(homedir(), '.cargo/bin/cargo') : 'cargo';
  run(cargo, ['build', '--release', '-p', 'ccpet-hook', '--target', target], { cwd: native });
  return join(native, 'target', target, 'release', 'ccpet-hook');
}

try {
  rmSync(out, { force: true });
  if (process.platform === 'darwin') {
    const parts = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map(cargoBuild);
    run('lipo', ['-create', '-output', out, ...parts]);
  } else {
    copyFileSync(cargoBuild('x86_64-unknown-linux-musl'), out);
  }
  chmodSync(out, 0o755);
  console.log('native hook built ->', out);
} catch (e) {
  rmSync(out, { force: true });
  console.log(`native hook not built (${e.message.split('\n')[0]}): the bridge uses the Node hook`);
}
