/**
 * The pet's "mailbox" for sessions it cannot type into (no PTY: desktop app, IDE, a terminal not started through the wrapper).
 * A waiter is a long-poll from a background `asyncRewake` hook of that session; delivering a message answers the poll, the hook exits
 * with code 2 and Claude Code wakes the session with the text. A message sent while no waiter is armed (between a delivery and the
 * next re-arm on `Stop`) is kept for a few minutes and goes out with the next waiter.
 */
export interface Mailbox {
  /** 'delivered': a waiter took it now; 'queued': it will go out when the next waiter arrives */
  send(sessionId: string, text: string): 'delivered' | 'queued';
  /** resolves with the message, null on timeout, or 'busy' when another waiter already waits for this session */
  wait(sessionId: string, ms: number, mod?: boolean): Promise<string | null | 'busy'>;
  hasWaiter(sessionId: string): boolean;
  /** the waiter went away (its hook process was killed): free the slot so a later message is queued instead of lost */
  cancel(sessionId: string): void;
  /** messages not yet delivered */
  pending(sessionId: string): number;
  /** the ccPet plugin (a Claude Code mod inside the session) polled for this session: it takes the messages, as the user's own words */
  markMod(sessionId: string): void;
  /** the plugin polled for this session recently (it re-polls every ~20 s) */
  isMod(sessionId: string): boolean;
  /** whether the waiter that waits now is the plugin's */
  waiterIsMod(sessionId: string): boolean;
}

export function createMailbox(o: { ttlMs?: number; now?: () => number } = {}): Mailbox {
  const ttl = o.ttlMs ?? 5 * 60_000;
  const now = o.now ?? Date.now;
  const queues = new Map<string, Array<{ text: string; at: number }>>();
  const waiters = new Map<string, { resolve: (m: string | null) => void; timer: ReturnType<typeof setTimeout>; mod?: boolean }>();
  const modSeen = new Map<string, number>();
  const MOD_TTL = 90_000;
  const fresh = (sid: string) => {
    const q = (queues.get(sid) ?? []).filter((m) => now() - m.at < ttl);
    if (q.length) queues.set(sid, q); else queues.delete(sid);
    return q;
  };
  return {
    send(sid, text) {
      const w = waiters.get(sid);
      if (w) { clearTimeout(w.timer); waiters.delete(sid); w.resolve(text); return 'delivered'; }
      queues.set(sid, [...fresh(sid), { text, at: now() }]);
      return 'queued';
    },
    wait(sid, ms, mod = false) {
      if (waiters.has(sid)) return Promise.resolve('busy');
      const q = fresh(sid);
      if (q.length) { queues.delete(sid); return Promise.resolve(q.map((m) => m.text).join('\n\n')); }
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(sid); resolve(null); }, ms);
        timer.unref?.();
        waiters.set(sid, { resolve, timer, ...(mod ? { mod: true } : {}) });
      });
    },
    hasWaiter: (sid) => waiters.has(sid),
    cancel(sid) { const w = waiters.get(sid); if (w) { clearTimeout(w.timer); waiters.delete(sid); w.resolve(null); } },
    pending: (sid) => fresh(sid).length,
    markMod: (sid) => { modSeen.set(sid, now()); },
    isMod: (sid) => now() - (modSeen.get(sid) ?? -Infinity) < MOD_TTL,
    waiterIsMod: (sid) => waiters.get(sid)?.mod === true,
  };
}
