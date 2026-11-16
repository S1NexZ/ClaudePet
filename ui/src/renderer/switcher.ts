import { STATE_LABEL, formatElapsed } from './labels.js';
import type { Session } from '../../../shared/src/types.js';

export interface SessionRow {
  id: string;
  title: string;
  meta: string;
  tone: 'alert' | 'quiet' | 'busy';
  current: boolean;
  cwd: string;
}

/** Rows for the session lists (chat header dropdown and the wave panel): newest activity first. */
export function sessionRows(sessions: Session[], currentId: string | null, now: number): SessionRow[] {
  const count = new Map<string, number>();
  for (const x of sessions) count.set(x.project, (count.get(x.project) ?? 0) + 1);
  return [...sessions]
    .sort((a, b) => b.lastEventAt - a.lastEventAt)
    .map((x) => ({
      id: x.id,
      title: (count.get(x.project) ?? 0) > 1 ? `${x.project} · ${x.id.slice(0, 4)}` : x.project,
      meta: `${STATE_LABEL[x.state]} · ${formatElapsed(now - x.since)}`,
      tone: x.state === 'waiting' || x.state === 'error' ? 'alert' : x.state === 'idle' || x.state === 'sleeping' ? 'quiet' : 'busy',
      current: x.id === currentId,
      cwd: x.cwd,
    }));
}

/** The chat after/before `current` in `ids` (wrapping); an unknown current starts from the first (or last when going back). */
export function nextChatId(ids: string[], current: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i < 0) return dir === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(i + dir + ids.length) % ids.length];
}
