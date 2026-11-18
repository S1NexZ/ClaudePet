import { readFileSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Process facts the bridge needs, portable between Linux (/proc) and macOS (`ps`). Every call returns null/0 when the process is gone. */
const ps = (pid: number, field: string): string | null => {
  try { return execFileSync('ps', ['-o', `${field}=`, '-p', String(Math.trunc(pid))], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
};
const hasProc = process.platform === 'linux';

/** Short name of the process (`claude`, `node`, ...). */
export function procName(pid: number): string | null {
  if (hasProc) { try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; } }
  const c = ps(pid, 'comm');
  return c ? c.split('/').pop()! : null;
}

/** Terminal device the process is attached to (`/dev/pts/3`, `/dev/ttys004`), null if none. */
export function ttyPath(pid: number): string | null {
  if (hasProc) { try { const t = readlinkSync(`/proc/${pid}/fd/0`); return t.startsWith('/dev/pts/') ? t : null; } catch { return null; } }
  const t = ps(pid, 'tty');
  return t && t !== '??' && t !== '?' ? (t.startsWith('/dev/') ? t : `/dev/${t}`) : null;
}
