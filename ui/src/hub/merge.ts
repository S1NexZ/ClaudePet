import { pickAttention } from '../../../daemon/src/sessionStore.js';
import type { Session, Snapshot, UsageInfo } from '../../../shared/src/types.js';

/** 'windows', 'wsl' (the default distro) or 'wsl:<distro>' */
export type HostId = string;
export interface HostPart { host: HostId; snap: Snapshot | null; distro?: string }

/** One session list from every host's snapshot (each session tagged with its host); the pet's attention is picked across all of them. */
export function mergeSnapshots(parts: HostPart[]): Snapshot {
  const sessions: Session[] = parts.flatMap((p) => (p.snap?.sessions ?? []).map((s) => ({ ...s, host: (p.host === 'windows' ? 'windows' : 'wsl') as 'wsl' | 'windows', ...(p.distro ? { distro: p.distro } : {}) })));
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

/**
 * Limits as the WSL bridge and the Windows host each know them: the numbers are taken wholesale from the side that obtained them last
 * (windows of two sources are never mixed); the plan, the status line state and the query state come from whichever side has them.
 */
export function mergeUsage(parts: UsageInfo[]): UsageInfo | null {
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  const withData = parts.filter((p) => p.updatedAt != null && (p.fiveHour || p.sevenDay));
  const base = withData.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number))[0] ?? parts[0];
  const rank = { ours: 2, other: 1, none: 0 } as Record<string, number>;
  const statusLine = parts.map((p) => p.statusLine).sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0];
  const live = parts.find((p) => p.liveActive) ?? parts.find((p) => p.lastAttemptAt != null);
  return {
    ...base,
    plan: base.plan ?? parts.find((p) => p.plan)?.plan ?? null,
    statusLine,
    liveActive: parts.some((p) => p.liveActive),
    ...(parts.some((p) => p.refreshing) ? { refreshing: true } : {}),
    lastAttemptAt: live?.lastAttemptAt ?? base.lastAttemptAt ?? null,
    lastError: live?.lastError ?? base.lastError ?? null,
  };
}
