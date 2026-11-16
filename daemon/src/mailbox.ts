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
  wait(sessionId: string, ms: number): Promise<string | null | 'busy'>;
  hasWaiter(sessionId: string): boolean;
  /** the waiter went away (its hook process was killed): free the slot so a later message is queued instead of lost */
  cancel(sessionId: string): void;
  /** messages not yet delivered */
  pending(sessionId: string): number;
}

export function createMailbox(o: { ttlMs?: number; now?: () => number } = {}): Mailbox {
  const ttl = o.ttlMs ?? 5 * 60_000;
  const now = o.now ?? Date.now;
  const queues = new Map<string, Array<{ text: string; at: number }>>();
  const waiters = new Map<string, { resolve: (m: string | null) => void; timer: ReturnType<typeof setTimeout> }>();
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
    wait(sid, ms) {
      if (waiters.has(sid)) return Promise.resolve('busy');
      const q = fresh(sid);
      if (q.length) { queues.delete(sid); return Promise.resolve(q.map((m) => m.text).join('\n\n')); }
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(sid); resolve(null); }, ms);
        timer.unref?.();
        waiters.set(sid, { resolve, timer });
      });
    },
    hasWaiter: (sid) => waiters.has(sid),
    cancel(sid) { const w = waiters.get(sid); if (w) { clearTimeout(w.timer); waiters.delete(sid); w.resolve(null); } },
    pending: (sid) => fresh(sid).length,
  };
}
