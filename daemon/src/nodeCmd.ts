import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Shell form of "run this with the bridge's own runtime". A packaged pet on Linux/macOS has no separate Node: the bridge itself runs inside
 * Electron with ELECTRON_RUN_AS_NODE, so hook commands call the same binary the same way (a plain `node` is used when it is one).
 */
export function nodeCmd(nodePath: string): string {
  return process.versions.electron ? `ELECTRON_RUN_AS_NODE=1 "${nodePath}"` : `"${nodePath}"`;
}

/** The native hook (ccpet-hook, Rust): a binary run directly; anything else is a Node script run by the bridge's runtime. */
export const isNativeHook = (path: string): boolean => /(^|[\\/])ccpet-hook(\.exe)?$/.test(path);

/** Shell form of running our hook at `path`: the native binary as is, a .mjs script through nodeCmd. */
export function hookCmd(nodePath: string, path: string): string {
  return isNativeHook(path) ? `"${path}"` : `${nodeCmd(nodePath)} "${path}"`;
}

/** A hook command that is ours (events, waiter or status line): the Node scripts of 0.6 or the native hook of 0.7. */
export const isOurHookCommand = (command: string): boolean => /pet-hook\.mjs|ccpet-hook/.test(command);

/** The runtime path that survives a restart: an AppImage's own file, not its temporary mount. */
export const stableRuntime = (): string => (process.versions.electron && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath);

/**
 * Copies the hook scripts to a folder that outlives the app's install/mount path (an AppImage mounts somewhere new on every start, and Claude Code
 * keeps calling the path it was given). Returns the folder, or `from` unchanged when copying is not needed or fails.
 */
export function stableHookDir(from: string, to: string): string {
  if (!process.versions.electron) return from;
  try {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const f of ['pet-hook.mjs', 'pet-statusline.mjs', 'ccpet-hook']) {
      const src = join(from, f), dst = join(to, f);
      if (!existsSync(src)) continue;
      if (!existsSync(dst) || statSync(dst).size !== statSync(src).size || !readFileSync(dst).equals(readFileSync(src))) {
        // a running waiter keeps the old binary busy: write beside it and rename over (the old file lives on until it exits)
        const tmp = `${dst}.${process.pid}.tmp`;
        copyFileSync(src, tmp);
        chmodSync(tmp, 0o755);
        renameSync(tmp, dst);
      }
    }
    return to;
  } catch { return from; }
}

/**
 * The hook Claude Code should run from `dir`: the native ccpet-hook when it is there and runs on this machine (a build for another system or
 * processor fails its `--version`), else the Node script pet-hook.mjs.
 */
export function pickHook(dir: string): string {
  const bin = join(dir, 'ccpet-hook');
  try {
    if (existsSync(bin) && /^ccpet-hook /.test(execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }))) return bin;
  } catch { /* not runnable here */ }
  return join(dir, 'pet-hook.mjs');
}
