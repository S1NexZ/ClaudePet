import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';

export interface Running { id: string; cwd: string; source: string | null; path: string; mtime: number }

/** The head of a transcript: where it ran and which Claude Code front end wrote it. */
async function headOf(path: string): Promise<{ cwd: string; source: string | null }> {
  let cwd = '', source: string | null = null;
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(131072);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 60)) {
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        if (!source && typeof e?.entrypoint === 'string') source = e.entrypoint;
        if (!cwd && typeof e?.cwd === 'string') cwd = e.cwd;
        if (cwd && source) break;
      }
    } finally { await fh.close(); }
  } catch { /* unreadable: unknown */ }
  return { cwd, source };
}

/**
 * Sessions that are probably running although no hook told us (the pet started later, or the hooks are not connected there):
 * transcripts written to in the last `maxAgeMs`. Sessions run by SDK clients (`sdk-cli`, e.g. the pet's own runner) are skipped.
 */
export async function findRunning(projectsDir: string, now: number, maxAgeMs: number): Promise<Running[]> {
  const out: Running[] = [];
  let dirs: string[] = [];
  try { dirs = await readdir(projectsDir); } catch { return out; }
  for (const d of dirs) {
    let files: string[] = [];
    try { files = await readdir(join(projectsDir, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(projectsDir, d, f);
      let m = 0;
      try { m = (await stat(path)).mtimeMs; } catch { continue; }
      if (now - m > maxAgeMs) continue;
      const head = await headOf(path);
      if (!head.cwd || head.source === 'sdk-cli') continue;
      out.push({ id: f.slice(0, -'.jsonl'.length), cwd: head.cwd, source: head.source, path, mtime: m });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
