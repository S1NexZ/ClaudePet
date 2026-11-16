import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageWindow } from '../../shared/src/types.js';

export type LiveErrorCode = 'timeout' | 'spawn' | 'unsupported' | 'unavailable' | 'invalid' | 'error';
export class LiveError extends Error {
  constructor(readonly code: LiveErrorCode, message?: string) { super(message ?? code); this.name = 'LiveError'; }
}

export interface LiveUsage { plan: string | null; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null }
export interface LiveState {
  /** last SUCCESSFUL result (never replaced by a failure or a malformed answer) */
  data: (LiveUsage & { updatedAt: number }) | null;
  lastAttemptAt: number | null;
  lastError: LiveErrorCode | null;
  running: boolean;
}

const win = (w: any): UsageWindow | null => {
  const p = Number(w?.utilization), t = Date.parse(String(w?.resets_at ?? ''));
  return w && w.utilization !== null && Number.isFinite(p) && Number.isFinite(t) ? { usedPct: Math.min(100, Math.max(0, p)), resetsAt: Math.round(t / 1000) } : null;
};

/**
 * Validates the answer of the SDK's get_usage. Anything that is not clearly usable throws, so it can never replace good data:
 * 'unavailable' = plan limits do not apply (API key, 3P provider), 'invalid' = unusable shape.
 */
export function parseLiveUsage(r: any): LiveUsage {
  if (!r || typeof r !== 'object') throw new LiveError('invalid');
  if (r.rate_limits_available === false) throw new LiveError('unavailable');
  const five = win(r.rate_limits?.five_hour), seven = win(r.rate_limits?.seven_day);
  if (!five && !seven) throw new LiveError('invalid');
  const plan = typeof r.subscription_type === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(r.subscription_type) ? r.subscription_type.toLowerCase() : null;
  return { plan, fiveHour: five, sevenDay: seven };
}

export interface PollerOpts {
  /** one short-lived query; must stop its work (kill the child process) when `signal` aborts */
  fetch: (signal: AbortSignal) => Promise<LiveUsage>;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  onChange?: () => void;
}

/**
 * Periodic usage query: one request every `intervalMs` (default 60 s) for as long as it is started.
 *  - never two requests at once: a tick that finds one running is skipped;
 *  - never closer than `intervalMs` apart: a timer that fires early re-arms for the remainder;
 *  - a failure keeps the last good data and only records the error;
 *  - stop() cancels the timer and aborts a running request (which kills its child process).
 */
export function createUsagePoller(o: PollerOpts) {
  const interval = o.intervalMs ?? 60_000, timeout = o.timeoutMs ?? 25_000, now = o.now ?? Date.now;
  const st: LiveState = { data: null, lastAttemptAt: null, lastError: null, running: false };
  let timer: ReturnType<typeof setTimeout> | null = null, started = false, stopped = false, revision = 0;
  let lastStart: number | null = null, skipped = 0, requests = 0;
  let current: { ac: AbortController; done: Promise<void> } | null = null;

  const arm = (ms: number) => { if (!stopped) { timer = setTimeout(tick, Math.max(0, ms)); (timer as any).unref?.(); } };

  const run = (): Promise<void> => {
    st.running = true; lastStart = now(); requests++;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort('timeout'), timeout);
    const done = (async () => {
      try {
        const data = await o.fetch(ac.signal);
        if (ac.signal.aborted && ac.signal.reason === 'stop') return; // the app is closing: nothing to record
        st.data = { ...data, updatedAt: now() }; st.lastError = null;
      } catch (e) {
        if (ac.signal.aborted && ac.signal.reason === 'stop') return;
        st.lastError = ac.signal.aborted ? 'timeout' : e instanceof LiveError ? e.code : 'error';
      } finally {
        clearTimeout(to); st.running = false; st.lastAttemptAt = now(); revision++; current = null;
        try { o.onChange?.(); } catch { /* a listener must not break the schedule */ }
      }
    })();
    current = { ac, done };
    return done;
  };

  function tick() {
    timer = null;
    if (stopped) return;
    if (st.running) { skipped++; arm(interval); return; }                     // never overlap
    if (lastStart !== null) { const wait = lastStart + interval - now(); if (wait > 0) { arm(wait); return; } } // never closer than the interval
    void run();
    arm(interval);
  }

  return {
    start() { if (started || stopped) return; started = true; tick(); },
    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const c = current;
      if (c) { c.ac.abort('stop'); await Promise.race([c.done, new Promise((r) => setTimeout(r, 2000).unref?.())]); }
    },
    state: (): LiveState => ({ ...st }),
    revision: () => revision,
    stats: () => ({ requests, skipped }),
  };
}

type QueryFn = (a: { prompt: AsyncIterable<any>; options: Record<string, any> }) => any;

/**
 * The real query: a short-lived Claude Code process started through the Agent SDK with NO prompt (so no model call),
 * nothing persisted, no user settings or hooks loaded, asked for the data behind `/usage`, then closed.
 * Authentication is handled entirely by Claude Code; this code never sees a token.
 */
export function makeLiveFetch(o: { claudePath?: string; cwd?: string; queryFn?: QueryFn }) {
  const queryFn = (o.queryFn ?? (sdkQuery as unknown as QueryFn));
  const cwd = o.cwd ?? join(homedir(), '.claude-pet', 'usage-query');
  return async (signal: AbortSignal): Promise<LiveUsage> => {
    if (!o.claudePath) throw new LiveError('spawn', 'claude executable not found');
    try { mkdirSync(cwd, { recursive: true, mode: 0o700 }); } catch { /* the query will report it */ }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v; // no inherited session markers or keys
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    async function* noPrompts() { await hold; } // never yields: no user message is ever sent
    let q: any;
    try {
      q = queryFn({ prompt: noPrompts(), options: {
        pathToClaudeCodeExecutable: o.claudePath, cwd, env, abortController: ac,
        persistSession: false, settingSources: [],
      } });
      void (async () => { try { for await (const _ of q) { /* only housekeeping messages arrive */ } } catch { /* closed / aborted */ } })();
      const method = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof method !== 'function') throw new LiveError('unsupported');
      const aborted = new Promise<never>((_, rej) => { ac.signal.addEventListener('abort', () => rej(new LiveError('timeout')), { once: true }); });
      const resp = await Promise.race([method.call(q, { skipBehaviors: true }), aborted]);
      return parseLiveUsage(resp);
    } catch (e) {
      if (e instanceof LiveError) throw e;
      throw new LiveError('error', String((e as Error)?.message ?? e).slice(0, 80));
    } finally {
      signal.removeEventListener('abort', onAbort);
      release();
      try { q?.close?.(); } catch { /* already gone */ }
      ac.abort(); // belt and braces: the child process must not outlive the request
    }
  };
}
