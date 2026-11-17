import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../../../shared/src/types.js';

/**
 * The Claude desktop app keeps one JSON file per Code session (`claude-code-sessions/<account>/<org>/local_<id>.json`). The pet reads only
 * four fields from it: the desktop id (to open the session with `claude://code/continue?session=<id>`), the CLI session ids (to match the
 * session the hooks report), the chat title and the archive flag. Everything else in the file (prompts, summaries, settings) is dropped at once.
 */
export interface DesktopEntry { desktopId: string; cliIds: string[]; title: string; archived: boolean }

/** what the app's deep link accepts as a session id */
const DESKTOP_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const CLI_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function parseEntry(text: string): DesktopEntry | null {
  let j: any;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || typeof j.sessionId !== 'string' || !DESKTOP_ID.test(j.sessionId)) return null;
  const cliIds = [j.cliSessionId, j.lastAssistantCliSessionId].filter((x): x is string => typeof x === 'string' && CLI_ID.test(x));
  if (!cliIds.length) return null;
  const title = typeof j.title === 'string' ? j.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return { desktopId: j.sessionId, cliIds: [...new Set(cliIds)], title, archived: j.isArchived === true };
}

/** Registry folders: the Store (MSIX) app keeps its data in %LOCALAPPDATA%\Claude-Data\claude_<publisher>, the classic install in %APPDATA%\Claude. */
export function findRegistryRoots(localAppData: string, appData: string): string[] {
  const out: string[] = [];
  const base = join(localAppData, 'Claude-Data');
  try { for (const d of readdirSync(base).sort()) if (/^claude_/.test(d)) { const r = join(base, d, 'claude-code-sessions'); if (existsSync(r)) out.push(r); } } catch { /* no Store app */ }
  const classic = join(appData, 'Claude', 'claude-code-sessions');
  if (existsSync(classic)) out.push(classic);
  return out;
}

const subdirs = (p: string) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(p, d.name)); } catch { return []; } };

/** Reads the registry; each file is parsed again only when its mtime or size changed. */
export function createDesktopRegistry(roots: () => string[], o: { onRead?: (file: string) => void } = {}) {
  const cache = new Map<string, { key: string; entry: DesktopEntry | null }>();
  return {
    byCliId(): Map<string, DesktopEntry> {
      const map = new Map<string, DesktopEntry>();
      const seen = new Set<string>();
      for (const root of roots()) for (const acct of subdirs(root)) for (const org of subdirs(acct)) {
        let files: string[] = [];
        try { files = readdirSync(org).filter((f) => /^local_[A-Za-z0-9-]{1,64}\.json$/.test(f)); } catch { continue; }
        for (const f of files) {
          const file = join(org, f);
          seen.add(file);
          let st;
          try { st = statSync(file); } catch { continue; }
          const key = `${st.mtimeMs}:${st.size}`;
          let c = cache.get(file);
          if (!c || c.key !== key) {
            let entry: DesktopEntry | null = null;
            try { o.onRead?.(file); entry = parseEntry(readFileSync(file, 'utf8')); } catch { /* being written: next time */ }
            c = { key, entry };
            cache.set(file, c);
          }
          if (c.entry) for (const id of c.entry.cliIds) map.set(id, c.entry);
        }
      }
      for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
      return map;
    },
  };
}

/** Desktop sessions show their chat title and remember the desktop id; sessions archived in the app are left out. */
export function decorateDesktop<T extends Pick<Session, 'id' | 'project'> & { desktopId?: string }>(sessions: T[], byCli: Map<string, DesktopEntry>): T[] {
  const out: T[] = [];
  for (const s of sessions) {
    const e = byCli.get(s.id);
    if (!e) { out.push(s); continue; }
    if (e.archived) continue;
    out.push({ ...s, project: e.title || s.project, desktopId: e.desktopId });
  }
  return out;
}
