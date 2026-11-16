import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { LiveError, parseLiveUsage, createUsagePoller, makeLiveFetch, type LiveUsage } from './usageLive.js';

const sample = (o: any = {}) => ({
  subscription_type: 'pro', rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 64, resets_at: '2026-11-16T17:39:59.663509+00:00' }, seven_day: { utilization: 60, resets_at: '2026-11-17T14:00:00.138667+00:00' } },
  session: { total_cost_usd: 0 }, behaviors: null, ...o,
});
const good = (n: number): LiveUsage => ({ plan: 'pro', fiveHour: { usedPct: n, resetsAt: 1 }, sevenDay: null });

describe('parseLiveUsage', () => {
  it('reads both windows; reset ISO times become epoch seconds (rounded)', () => {
    expect(parseLiveUsage(sample())).toEqual({
      plan: 'pro',
      fiveHour: { usedPct: 64, resetsAt: Math.round(Date.parse('2026-11-16T17:39:59.663509+00:00') / 1000) },
      sevenDay: { usedPct: 60, resetsAt: Math.round(Date.parse('2026-11-17T14:00:00.138667+00:00') / 1000) },
    });
    expect(parseLiveUsage(sample()).fiveHour!.resetsAt).toBe(Date.parse('2026-11-16T17:40:00Z') / 1000);
  });
  it('clamps 0..100, tolerates one window missing or null utilization', () => {
    const r = parseLiveUsage(sample({ rate_limits: { five_hour: { utilization: 150, resets_at: '2026-11-16T17:40:00Z' }, seven_day: { utilization: null, resets_at: null } } }));
    expect(r.fiveHour!.usedPct).toBe(100);
    expect(r.sevenDay).toBeNull();
  });
  it('rejects anything unusable instead of guessing', () => {
    for (const bad of [null, 'x', {}, sample({ rate_limits: null }), sample({ rate_limits: {} }),
      sample({ rate_limits: { five_hour: { utilization: 'x', resets_at: 'nope' } } })])
      expect(() => parseLiveUsage(bad)).toThrow(LiveError);
    try { parseLiveUsage(sample({ rate_limits_available: false, rate_limits: null })); } catch (e) { expect((e as LiveError).code).toBe('unavailable'); }
    try { parseLiveUsage({}); } catch (e) { expect((e as LiveError).code).toBe('invalid'); }
  });
  it('plan is sanitised', () => {
    expect(parseLiveUsage(sample({ subscription_type: 'MAX' })).plan).toBe('max');
    expect(parseLiveUsage(sample({ subscription_type: '<x>' })).plan).toBeNull();
    expect(parseLiveUsage(sample({ subscription_type: null })).plan).toBeNull();
  });
});

describe('poller schedule', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('asks at once, then exactly once per 60 s, only while started', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => good(1));
    const p = createUsagePoller({ fetch });
    expect(fetch).not.toHaveBeenCalled(); // nothing before start()
    p.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetch).toHaveBeenCalledTimes(1);            // never closer than 60 s
    await vi.advanceTimersByTimeAsync(1_100);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    await p.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(4);            // stopped: no more requests
  });

  it('start() twice or after stop() does not add schedules', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => good(1));
    const p = createUsagePoller({ fetch });
    p.start(); p.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await p.stop(); p.start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never overlaps: a cycle that finds the previous request still running is skipped', async () => {
    vi.useFakeTimers();
    let active = 0, maxActive = 0, release: (() => void)[] = [];
    const fetch = vi.fn(() => { active++; maxActive = Math.max(maxActive, active); return new Promise<LiveUsage>((res) => release.push(() => { active--; res(good(5)); })); });
    const p = createUsagePoller({ fetch, timeoutMs: 10 * 60_000 }); // a very patient timeout, so the request really is still running
    p.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(185_000);       // three more cycles come due while the first request hangs
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(p.stats().skipped).toBeGreaterThanOrEqual(2);
    release[0]();
    await vi.advanceTimersByTimeAsync(1);
    expect(p.state().data?.fiveHour?.usedPct).toBe(5);
    await vi.advanceTimersByTimeAsync(61_000);        // the next cycle may run once it has finished
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    release[1]?.();
    await p.stop();
  });

  it('a request that hangs is aborted after the timeout and recorded as such', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const fetch = vi.fn((signal: AbortSignal) => { seen = signal; return new Promise<LiveUsage>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))); });
    const p = createUsagePoller({ fetch, timeoutMs: 25_000 });
    p.start();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(p.state().running).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seen!.aborted).toBe(true);
    expect(p.state()).toMatchObject({ running: false, lastError: 'timeout', data: null });
    await p.stop();
  });
});

describe('poller data handling', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('failures and malformed answers keep the last good data; the error is recorded; success clears it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
    const answers: Array<() => Promise<LiveUsage>> = [
      async () => good(10),
      async () => { throw new LiveError('spawn'); },
      async () => { throw new LiveError('invalid'); },
      async () => { throw new Error('boom'); },
      async () => good(20),
    ];
    let i = 0; const changes = vi.fn();
    const p = createUsagePoller({ fetch: () => answers[i++](), onChange: changes });
    p.start();
    await vi.advanceTimersByTimeAsync(1);
    const t1 = Date.parse('2026-11-16T12:00:00Z');
    expect(p.state()).toMatchObject({ lastError: null, data: { fiveHour: { usedPct: 10 }, updatedAt: t1 } });
    for (const err of ['spawn', 'invalid', 'error']) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(p.state().lastError).toBe(err);
      expect(p.state().data).toMatchObject({ fiveHour: { usedPct: 10 }, updatedAt: t1 }); // the last SUCCESS, untouched
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.state()).toMatchObject({ lastError: null, data: { fiveHour: { usedPct: 20 } } });
    expect(changes).toHaveBeenCalledTimes(5);          // the app is told after every attempt (so "stale" shows up at once)
    expect(p.revision()).toBe(5);
    await p.stop();
  });
});

describe('stop = app closing', () => {
  it('aborts a running request (child must die), records nothing, cancels the schedule', async () => {
    vi.useFakeTimers();
    let sig: AbortSignal | undefined;
    const fetch = vi.fn((s: AbortSignal) => { sig = s; return new Promise<LiveUsage>((_, rej) => s.addEventListener('abort', () => rej(new Error('x')))); });
    const p = createUsagePoller({ fetch });
    p.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(p.state().running).toBe(true);
    await p.stop();
    expect(sig!.aborted).toBe(true);
    expect(sig!.reason).toBe('stop');
    expect(p.state()).toMatchObject({ running: false, lastError: null, data: null });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('makeLiveFetch (the real request, with a fake SDK)', () => {
  const fakeQuery = (resp: any, opts: { noMethod?: boolean; hang?: boolean } = {}) => {
    const calls: any = { options: null, prompts: 0, closed: 0, usageArgs: null };
    const queryFn = (a: any) => {
      calls.options = a.options;
      void (async () => { for await (const _ of a.prompt) calls.prompts++; })(); // would count any message sent to the model
      const q: any = {
        async *[Symbol.asyncIterator]() { await new Promise((r) => a.options.abortController.signal.addEventListener('abort', r)); },
        close() { calls.closed++; },
      };
      if (!opts.noMethod) q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async (x: any) => { calls.usageArgs = x; if (opts.hang) await new Promise(() => {}); return resp; };
      return q;
    };
    return { calls, queryFn };
  };

  it('sends no prompt, persists nothing, loads no settings/hooks, passes no session env, asks without behaviors, then closes', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'leak'; process.env.ANTHROPIC_API_KEY = 'leak';
    const f = fakeQuery(sample());
    const r = await makeLiveFetch({ claudePath: '/x/claude', cwd: '/tmp', queryFn: f.queryFn as any })(new AbortController().signal);
    delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.ANTHROPIC_API_KEY;
    expect(r.plan).toBe('pro');
    expect(f.calls.prompts).toBe(0);
    expect(f.calls.options).toMatchObject({ pathToClaudeCodeExecutable: '/x/claude', persistSession: false, settingSources: [], cwd: '/tmp' });
    expect(Object.keys(f.calls.options.env).some((k) => /^(CLAUDE|ANTHROPIC)/.test(k))).toBe(false);
    expect(f.calls.usageArgs).toEqual({ skipBehaviors: true });
    expect(f.calls.closed).toBe(1);
  });
  it('reports why it failed: no executable, SDK without the method, malformed answer, unavailable plan, abort', async () => {
    const run = (o: any, q?: any) => makeLiveFetch({ cwd: '/tmp', ...o, queryFn: q as any })(new AbortController().signal).catch((e) => e);
    expect((await run({})).code).toBe('spawn');
    const nm = fakeQuery(null, { noMethod: true });
    expect((await run({ claudePath: '/x' }, nm.queryFn)).code).toBe('unsupported');
    expect(nm.calls.closed).toBe(1);
    expect((await run({ claudePath: '/x' }, fakeQuery({ junk: 1 }).queryFn)).code).toBe('invalid');
    expect((await run({ claudePath: '/x' }, fakeQuery({ rate_limits_available: false, rate_limits: null }).queryFn)).code).toBe('unavailable');
    const h = fakeQuery(null, { hang: true });
    const ac = new AbortController();
    const p = makeLiveFetch({ claudePath: '/x', cwd: '/tmp', queryFn: h.queryFn as any })(ac.signal).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20)); ac.abort('timeout');
    expect((await p).code).toBe('timeout');
    expect(h.calls.closed).toBe(1);
  });
  it('a real child process is killed when the poller stops (the app closes mid-request)', async () => {
    let pid = 0;
    const queryFn = (a: any) => {
      const child = spawn('sleep', ['30']); pid = child.pid!;
      return {
        async *[Symbol.asyncIterator]() { await new Promise((r) => a.options.abortController.signal.addEventListener('abort', r)); },
        close() { child.kill('SIGKILL'); },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}),
      };
    };
    const p = createUsagePoller({ fetch: makeLiveFetch({ claudePath: '/x', cwd: '/tmp', queryFn: queryFn as any }), timeoutMs: 60_000 });
    p.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();   // alive while the request runs
    await p.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();       // gone after stop
  });
});
