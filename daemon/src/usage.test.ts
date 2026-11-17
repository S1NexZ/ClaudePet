import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseUsage, planFromAuthStatus, statusLineKind, usageVersion, createUsageSource } from './usage.js';

const dir = () => mkdtempSync(join(tmpdir(), 'usage-'));

describe('parseUsage', () => {
  it('reads both windows', () => {
    const u = parseUsage(JSON.stringify({ version: 1, updatedAt: 1000, five_hour: { used_percentage: 23.5, resets_at: 5 }, seven_day: { used_percentage: 41, resets_at: 9 } }));
    expect(u).toEqual({ updatedAt: 1000, fiveHour: { usedPct: 23.5, resetsAt: 5 }, sevenDay: { usedPct: 41, resetsAt: 9 } });
  });
  it('clamps to 0..100 and drops malformed windows instead of guessing', () => {
    const u = parseUsage(JSON.stringify({ updatedAt: 1, five_hour: { used_percentage: 130, resets_at: 5 }, seven_day: { used_percentage: 'x', resets_at: 9 } }));
    expect(u.fiveHour?.usedPct).toBe(100);
    expect(u.sevenDay).toBeNull();
  });
  it('garbage or empty gives no data', () => {
    expect(parseUsage('not json')).toEqual({ updatedAt: null, fiveHour: null, sevenDay: null });
    expect(parseUsage('{}')).toEqual({ updatedAt: null, fiveHour: null, sevenDay: null });
  });
});

describe('planFromAuthStatus', () => {
  it('takes only subscriptionType', () => {
    expect(planFromAuthStatus('{"loggedIn":true,"email":"a@b.c","subscriptionType":"pro","planTier":"pro"}')).toBe('pro');
    expect(planFromAuthStatus('{"subscriptionType":"Max"}')).toBe('max');
  });
  it('unknown when absent, malformed or suspicious', () => {
    expect(planFromAuthStatus('{"loggedIn":false}')).toBeNull();
    expect(planFromAuthStatus('')).toBeNull();
    expect(planFromAuthStatus('{"subscriptionType":"<script>"}')).toBeNull();
    expect(planFromAuthStatus('junk "subscriptionType": "pro" junk')).toBe('pro');
  });
});

describe('statusLineKind', () => {
  it('ours / other / none', () => {
    expect(statusLineKind('{"statusLine":{"type":"command","command":"node /x/pet-statusline.mjs"}}')).toBe('ours');
    expect(statusLineKind('{"statusLine":{"type":"command","command":"my-line.sh"}}')).toBe('other');
    expect(statusLineKind('{"model":"opus"}')).toBe('none');
    expect(statusLineKind('broken')).toBe('none');
  });
});

describe('usage source', () => {
  it('version follows the file; read returns data + statusLine kind; plan stays unknown without claude', async () => {
    const d = dir();
    const path = join(d, 'usage.json'), settings = join(d, 'settings.json');
    expect(usageVersion(path)).toBe(0);
    writeFileSync(settings, '{}');
    const src = createUsageSource({ path, settingsPath: settings });
    expect(await src.read()).toEqual({ plan: null, updatedAt: null, fiveHour: null, sevenDay: null, statusLine: 'none', source: null, liveActive: false, lastAttemptAt: null, lastError: null });
    writeFileSync(path, JSON.stringify({ updatedAt: 7, five_hour: { used_percentage: 10, resets_at: 99 }, seven_day: null }));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(src.version()).toBeGreaterThan(0);
    expect(await src.read()).toMatchObject({ updatedAt: 7, fiveHour: { usedPct: 10, resetsAt: 99 }, sevenDay: null });
  });
  it('reads the plan from a (fake) claude auth status, caches it, and survives failures', async () => {
    const d = dir();
    const fake = join(d, 'claude');
    writeFileSync(fake, '#!/bin/sh\necho \'{"email":"x@y.z","subscriptionType":"pro"}\'\n', { mode: 0o755 });
    const bad = join(d, 'badclaude');
    writeFileSync(bad, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const ok = createUsageSource({ path: join(d, 'u.json'), settingsPath: join(d, 's.json'), claudePath: fake });
    expect((await ok.read()).plan).toBe('pro');
    const failing = createUsageSource({ path: join(d, 'u.json'), settingsPath: join(d, 's.json'), claudePath: bad });
    expect((await failing.read()).plan).toBeNull();
  });
});

describe('pet-statusline.mjs', () => {
  const script = new URL('../../hook/pet-statusline.mjs', import.meta.url).pathname;
  const run = (input: string, file: string) => spawnSync(process.execPath, [script], { input, env: { ...process.env, CLAUDE_PET_USAGE: file }, encoding: 'utf8' });
  it('saves real limits, prints a short line, writes nothing when absent, never fails', () => {
    const file = join(dir(), 'sub', 'usage.json');
    const r = run(JSON.stringify({ model: {}, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 100 }, seven_day: { used_percentage: 41.2, resets_at: 200 } } }), file);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('5ч 24% · нед 41%');
    const u = parseUsage(require('node:fs').readFileSync(file, 'utf8'));
    expect(u.fiveHour).toEqual({ usedPct: 23.5, resetsAt: 100 });
    expect(u.sevenDay).toEqual({ usedPct: 41.2, resetsAt: 200 });
    expect(u.updatedAt).toBeGreaterThan(Date.now() - 10_000);
    const file2 = join(dir(), 'usage.json');
    expect(run(JSON.stringify({ model: {} }), file2).status).toBe(0);
    expect(usageVersion(file2)).toBe(0);
    expect(run('garbage', file2).status).toBe(0);
    expect(usageVersion(file2)).toBe(0);
    const partial = join(dir(), 'usage.json');
    run(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 5, resets_at: 9 } } }), partial);
    expect(parseUsage(require('node:fs').readFileSync(partial, 'utf8'))).toMatchObject({ fiveHour: null, sevenDay: { usedPct: 5 } });
  });
});

describe('usage source with the periodic query', () => {
  const mk = (live: any, fileUsage?: any) => {
    const d = dir();
    const path = join(d, 'usage.json'), settings = join(d, 'settings.json');
    writeFileSync(settings, '{}');
    if (fileUsage) writeFileSync(path, JSON.stringify(fileUsage));
    return createUsageSource({ path, settingsPath: settings, live });
  };
  const liveState = (o: any = {}) => ({ data: { plan: 'pro', fiveHour: { usedPct: 64, resetsAt: 9 }, sevenDay: { usedPct: 60, resetsAt: 99 }, updatedAt: 5000 }, lastAttemptAt: 5000, lastError: null, running: false, ...o });
  it('live data is used, with its plan (no `claude auth status` needed) and bookkeeping', async () => {
    const src = mk({ state: () => liveState(), revision: () => 3 });
    expect(await src.read()).toEqual({ plan: 'pro', updatedAt: 5000, fiveHour: { usedPct: 64, resetsAt: 9 }, sevenDay: { usedPct: 60, resetsAt: 99 }, statusLine: 'none', source: 'live', liveActive: true, lastAttemptAt: 5000, lastError: null });
  });
  it('without a timer the query is on demand: liveActive false, refreshing only while one runs, refresh() is passed on', async () => {
    const refresh = vi.fn(() => true);
    const src = mk({ state: () => liveState({ running: true }), revision: () => 1, periodic: false, refresh });
    expect(await src.read()).toMatchObject({ liveActive: false, refreshing: true });
    expect(src.refresh()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    const idle = await mk({ state: () => liveState(), revision: () => 1, periodic: false, refresh }).read();
    expect('refreshing' in idle).toBe(false);
  });
  it('the newer of live and statusLine wins, one source wholesale', async () => {
    const file = { updatedAt: 9000, five_hour: { used_percentage: 70, resets_at: 8 }, seven_day: null };
    expect(await mk({ state: () => liveState(), revision: () => 1 }, file).read()).toMatchObject({ source: 'statusline', updatedAt: 9000, fiveHour: { usedPct: 70 }, sevenDay: null });
    expect(await mk({ state: () => liveState({ data: { ...liveState().data, updatedAt: 9500 } }), revision: () => 1 }, file).read()).toMatchObject({ source: 'live', fiveHour: { usedPct: 64 } });
  });
  it('a failed query keeps the last good live data and reports the error', async () => {
    const r = await mk({ state: () => liveState({ lastError: 'timeout', lastAttemptAt: 8000 }), revision: () => 4 }).read();
    expect(r).toMatchObject({ source: 'live', updatedAt: 5000, fiveHour: { usedPct: 64 }, lastError: 'timeout', lastAttemptAt: 8000 });
  });
  it('no data yet: nothing is invented', async () => {
    const r = await mk({ state: () => ({ data: null, lastAttemptAt: null, lastError: null, running: true }), revision: () => 0 }).read();
    expect(r).toMatchObject({ updatedAt: null, fiveHour: null, sevenDay: null, source: null, liveActive: true });
  });
  it('version changes with every attempt (even a failed one) so the app learns about staleness', () => {
    let rev = 0;
    const src = mk({ state: () => liveState(), revision: () => rev });
    const v0 = src.version();
    rev++;
    expect(src.version()).not.toBe(v0);
  });
});
