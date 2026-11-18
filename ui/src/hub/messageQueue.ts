import type { PetState, QueuedMessage, Session } from '../../../shared/src/types.js';

/** A session may take the next message: its turn is over and nothing waits for the user */
const READY: ReadonlySet<PetState> = new Set<PetState>(['idle', 'done', 'error']);

/**
 * Messages the pet types into sessions later: after the current turn ends, or at a set time. Kept in the app (it routes
 * every send, including the Claude app's chats) and saved to disk, so a message set for the night survives a restart.
 */
export class MessageQueue {
  private items = new Map<string, QueuedMessage[]>();
  /** a message just went out: wait for the session to pick it up before the next one (its state changes a moment later) */
  private sentAt = new Map<string, number>();
  private seq = 0;

  constructor(private save: (data: Record<string, QueuedMessage[]>) => void = () => {}, data?: Record<string, QueuedMessage[]>) {
    for (const [id, list] of Object.entries(data ?? {})) if (Array.isArray(list) && list.length) this.items.set(id, list.filter((m) => typeof m?.text === 'string' && typeof m?.id === 'string'));
  }

  add(sessionId: string, text: string, at?: number): QueuedMessage {
    const m: QueuedMessage = { id: `q${Date.now().toString(36)}${++this.seq}`, text, ...(at ? { at } : {}) };
    this.items.set(sessionId, [...(this.items.get(sessionId) ?? []), m]);
    this.persist();
    return m;
  }

  /** one message, or all of a session's */
  remove(sessionId: string, id?: string): void {
    const left = id ? (this.items.get(sessionId) ?? []).filter((m) => m.id !== id) : [];
    if (left.length) this.items.set(sessionId, left); else this.items.delete(sessionId);
    this.persist();
  }

  of(sessionId: string): QueuedMessage[] | undefined { return this.items.get(sessionId); }

  /**
   * The messages to send now, at most one per session: the first untimed one when the session is ready, or a timed one whose
   * time has come (a timed message also waits for the turn to end). The returned messages are taken out of the queue.
   */
  due(sessions: Session[], now: number): { sessionId: string; message: QueuedMessage }[] {
    const out: { sessionId: string; message: QueuedMessage }[] = [];
    for (const s of sessions) {
      const list = this.items.get(s.id);
      if (!list?.length || !READY.has(s.state) || s.pendingPermission) continue;
      if (now - (this.sentAt.get(s.id) ?? 0) < 4000) continue;
      const m = list.find((x) => !x.at || x.at <= now);
      if (!m) continue;
      this.sentAt.set(s.id, now);
      out.push({ sessionId: s.id, message: m });
      this.remove(s.id, m.id);
    }
    return out;
  }

  /** the sessions with their queues attached (for the pet's snapshot) */
  decorate(sessions: Session[]): Session[] {
    return sessions.map((s) => (this.items.get(s.id)?.length ? { ...s, queue: this.items.get(s.id) } : s));
  }

  private persist(): void { try { this.save(Object.fromEntries(this.items)); } catch { /* not fatal: the queue still works until a restart */ } }
}

/**
 * "/at 23:30 text" or "/at reset text" (when the 5-hour limit resets) → the time and the text; null when the line is not like that.
 * A clock time already past today means tomorrow.
 */
export function parseAt(args: string, now: Date, resetAt?: number | null): { at: number; text: string } | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s+([\s\S]+)$/.exec(args);
  if (m) {
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59 || !m[3].trim()) return null;
    const d = new Date(now); d.setHours(h, min, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return { at: d.getTime(), text: m[3].trim() };
  }
  const r = /^\s*(reset|сброс)\s+([\s\S]+)$/i.exec(args);
  if (r && resetAt && resetAt * 1000 > now.getTime() && r[2].trim()) return { at: resetAt * 1000 + 60_000, text: r[2].trim() };
  return null;
}
