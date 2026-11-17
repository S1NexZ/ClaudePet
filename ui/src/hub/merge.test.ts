import { describe, it, expect } from 'vitest';
import { mergeSnapshots, hostOf, hostOfPermission, mergeUsage, type HostPart } from './merge.js';
import type { Session, UsageInfo } from '../../../shared/src/types.js';

const s = (id: string, state: Session['state'], at: number, extra: Partial<Session> = {}): Session => ({ id, cwd: '/', project: id, state, since: at, lastEventAt: at, owned: false, ...extra });
const parts: HostPart[] = [
  { host: 'wsl', snap: { type: 'snapshot', sessions: [s('a', 'thinking', 100)], attention: 'a' } },
  { host: 'windows', snap: { type: 'snapshot', sessions: [s('b', 'waiting', 50, { pendingPermission: { id: 'hw-1', tool: 'Bash', summary: 'ls' } }), s('c', 'idle', 10)], attention: 'b' } },
];

describe('hub merge', () => {
  it('tags sessions with their host and picks the attention across hosts (waiting beats a newer busy one)', () => {
    const m = mergeSnapshots(parts);
    expect(m.sessions.map((x) => [x.id, x.host])).toEqual([['a', 'wsl'], ['b', 'windows'], ['c', 'windows']]);
    expect(m.attention).toBe('b');
  });
  it('works when a host is down (null snapshot) or both are empty', () => {
    expect(mergeSnapshots([{ host: 'wsl', snap: null }, parts[1]]).sessions).toHaveLength(2);
    expect(mergeSnapshots([{ host: 'wsl', snap: null }, { host: 'windows', snap: null }])).toEqual({ type: 'snapshot', sessions: [], attention: null });
  });
  it('routes a session id or a permission id to the owning host', () => {
    expect(hostOf('a', parts)).toBe('wsl');
    expect(hostOf('c', parts)).toBe('windows');
    expect(hostOf('zzz', parts)).toBeNull();
    expect(hostOfPermission('hw-1', parts)).toBe('windows');
    expect(hostOfPermission('hl-1', parts)).toBeNull();
  });
});

describe('several WSL distros', () => {
  const snap = (id: string): any => ({ type: 'snapshot', sessions: [{ id, project: id, state: 'running', since: 0, lastEventAt: 1, cwd: '/x', owned: false }], attention: id });
  it('tags every WSL session as wsl, adds the distro name, and routes by host id', () => {
    const parts = [{ host: 'wsl', snap: snap('a'), distro: 'Ubuntu' }, { host: 'wsl:Debian', snap: snap('b'), distro: 'Debian' }, { host: 'windows', snap: snap('c') }];
    const m = mergeSnapshots(parts);
    expect(m.sessions.map((s) => [s.id, s.host, s.distro])).toEqual([['a', 'wsl', 'Ubuntu'], ['b', 'wsl', 'Debian'], ['c', 'windows', undefined]]);
    expect(hostOf('b', parts)).toBe('wsl:Debian');
    expect(hostOf('c', parts)).toBe('windows');
  });
});

describe('mergeUsage (limits from the WSL and the Windows side)', () => {
  const u = (o: Partial<UsageInfo>): UsageInfo => ({ plan: null, updatedAt: null, fiveHour: null, sevenDay: null, statusLine: 'none', ...o });
  it('the numbers come wholesale from the side that got them last; plan and the status line state from any side', () => {
    const wsl = u({ plan: 'pro', updatedAt: 100, fiveHour: { usedPct: 10, resetsAt: 1 }, source: 'live', liveActive: true, lastAttemptAt: 100, lastError: null });
    const win = u({ updatedAt: 200, fiveHour: { usedPct: 40, resetsAt: 2 }, sevenDay: { usedPct: 5, resetsAt: 3 }, statusLine: 'ours', source: 'statusline' });
    expect(mergeUsage([wsl, win])).toMatchObject({ plan: 'pro', updatedAt: 200, fiveHour: { usedPct: 40 }, sevenDay: { usedPct: 5 }, statusLine: 'ours', source: 'statusline', liveActive: true, lastAttemptAt: 100 });
  });
  it('one side only, or a side without data, gives the other one', () => {
    const wsl = u({ plan: 'max', updatedAt: 100, fiveHour: { usedPct: 10, resetsAt: 1 }, statusLine: 'other' });
    expect(mergeUsage([wsl])).toEqual(wsl);
    expect(mergeUsage([u({}), wsl])).toMatchObject({ updatedAt: 100, plan: 'max', statusLine: 'other' });
    expect(mergeUsage([])).toBeNull();
  });
  it('a click refresh running on any side shows as refreshing', () => {
    expect(mergeUsage([u({ refreshing: true }), u({ updatedAt: 5 })])!.refreshing).toBe(true);
  });
});

