import { pickAttention } from '../../../daemon/src/sessionStore.js';
import type { Session, Snapshot } from '../../../shared/src/types.js';

export type HostId = 'wsl' | 'windows';
export interface HostPart { host: HostId; snap: Snapshot | null }

/** One session list from every host's snapshot (each session tagged with its host); the pet's attention is picked across all of them. */
export function mergeSnapshots(parts: HostPart[]): Snapshot {
  const sessions: Session[] = parts.flatMap((p) => (p.snap?.sessions ?? []).map((s) => ({ ...s, host: p.host })));
  return { type: 'snapshot', sessions, attention: pickAttention(sessions)?.id ?? null };
}

/** The host that owns a session id (ids are unique per Claude Code session, so the first match is the one). */
export function hostOf(sessionId: string, parts: HostPart[]): HostId | null {
  for (const p of parts) if (p.snap?.sessions.some((s) => s.id === sessionId)) return p.host;
  return null;
}

/** The host that has this pending permission id (ids are prefixed per host, so they do not collide). */
export function hostOfPermission(id: string, parts: HostPart[]): HostId | null {
  for (const p of parts) if (p.snap?.sessions.some((s) => s.pendingPermission?.id === id)) return p.host;
  return null;
}
