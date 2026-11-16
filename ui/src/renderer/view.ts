import type { Snapshot } from '../../../shared/src/types.js';

/** Applies the user's pinned session on top of the daemon's choice; a blocked (waiting) session still breaks through. */
export function pinSnapshot(snap: Snapshot | null, pinnedId: string | null): Snapshot | null {
  if (!snap || !pinnedId || !snap.sessions.some((s) => s.id === pinnedId)) return snap;
  const blocked = snap.sessions.find((s) => s.id !== pinnedId && s.state === 'waiting');
  return { ...snap, attention: blocked ? blocked.id : pinnedId };
}

/** The open chat is about one session, chosen by the user; it must not follow whatever is busiest. */
export function focusSnapshot(snap: Snapshot | null, chatId: string | null): Snapshot | null {
  if (!snap) return null;
  return { ...snap, attention: chatId && snap.sessions.some((x) => x.id === chatId) ? chatId : null };
}
