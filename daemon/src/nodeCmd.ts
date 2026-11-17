import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shell form of "run this with the bridge's own runtime". A packaged pet on Linux/macOS has no separate Node: the bridge itself runs inside
 * Electron with ELECTRON_RUN_AS_NODE, so hook commands call the same binary the same way (a plain `node` is used when it is one).
 */
export function nodeCmd(nodePath: string): string {
  return process.versions.electron ? `ELECTRON_RUN_AS_NODE=1 "${nodePath}"` : `"${nodePath}"`;
}

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
    for (const f of ['pet-hook.mjs', 'pet-statusline.mjs']) {
      const src = join(from, f), dst = join(to, f);
      if (!existsSync(src)) continue;
      if (!existsSync(dst) || statSync(dst).size !== statSync(src).size || readFileSync(dst, 'utf8') !== readFileSync(src, 'utf8')) copyFileSync(src, dst);
    }
    return to;
  } catch { return from; }
}
