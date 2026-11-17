import { existsSync, mkdirSync, readFileSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * pet-helper.exe runs for as long as a Claude Code session lives (the mailbox waiter, the `pty` wrapper, the status line), so the file is
 * often in use. Hooks, the status line and the PowerShell wrapper therefore point at a stable copy outside the install folder
 * (%LOCALAPPDATA%\ccPet\bin): the installer can always replace its own files, and the copy is refreshed whenever it is free.
 */
export interface HelperSync { path: string | undefined; updated: boolean; error?: string }

const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

const defaultReplace = (src: string, dst: string) => {
  const tmp = `${dst}.new`;
  copyFileSync(src, tmp);
  try { renameSync(tmp, dst); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
};

export function syncHelper(src: string, dir: string, o: { replace?: (src: string, dst: string) => void } = {}): HelperSync {
  if (!existsSync(src)) return { path: undefined, updated: false };
  const dst = join(dir, 'pet-helper.exe');
  const have = existsSync(dst);
  try {
    if (have && hash(dst) === hash(src)) return { path: dst, updated: false };
    mkdirSync(dir, { recursive: true });
    (o.replace ?? defaultReplace)(src, dst);
    return { path: dst, updated: true };
  } catch (e) {
    // in use by running sessions: keep the old copy (still a working helper) and try again later; no copy at all: use the installed one
    return { path: have ? dst : src, updated: false, error: (e as Error).message };
  }
}
