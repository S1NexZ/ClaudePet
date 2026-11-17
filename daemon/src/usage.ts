import { readFileSync, statSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageInfo, UsageWindow } from '../../shared/src/types.js';
import type { LiveState } from './usageLive.js';

export const defaultUsagePath = () => process.env.CLAUDE_PET_USAGE ?? join(homedir(), '.claude-pet', 'usage.json');

const win = (w: any): UsageWindow | null => {
  const p = Number(w?.used_percentage), r = Number(w?.resets_at);
  return w && Number.isFinite(p) && Number.isFinite(r) ? { usedPct: Math.min(100, Math.max(0, p)), resetsAt: r } : null;
};

/** Parses usage.json written by pet-statusline.mjs; anything malformed gives "no data" (never a made-up value). */
export function parseUsage(raw: string): { updatedAt: number | null; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null } {
  try {
    const j = JSON.parse(raw);
    const t = Number(j?.updatedAt);
    return { updatedAt: Number.isFinite(t) && t > 0 ? t : null, fiveHour: win(j?.five_hour), sevenDay: win(j?.seven_day) };
  } catch { return { updatedAt: null, fiveHour: null, sevenDay: null }; }
}

/** Only the plan out of `claude auth status` output: nothing else of it (email, org, ids) is read or kept. */
export function planFromAuthStatus(out: string): string | null {
  let v: unknown;
  try { v = JSON.parse(out)?.subscriptionType; }
  catch { v = /"subscriptionType"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(out)?.[1]; }
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v) ? v.toLowerCase() : null;
}

/** Is Claude Code's statusLine ours (feeds the pet), someone else's (left alone) or absent. */
export function statusLineKind(settingsJson: string): UsageInfo['statusLine'] {
  try {
    const sl = JSON.parse(settingsJson)?.statusLine;
    if (!sl) return 'none';
    return String(sl.command ?? '').includes('pet-statusline.mjs') ? 'ours' : 'other';
  } catch { return 'none'; }
}

/** mtime of the usage file (0 when missing): the bridge compares it on its tick instead of polling the content. */
export function usageVersion(path = defaultUsagePath()): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

export function createUsageSource(o: {
  path?: string; settingsPath: string; claudePath?: string; now?: () => number;
  /** the periodic Claude Code usage query (optional): its last good data wins over an older statusLine file */
  live?: { state(): LiveState; revision(): number; periodic?: boolean; refresh?(minGapMs?: number): boolean };
}) {
  const path = o.path ?? defaultUsagePath();
  const now = o.now ?? Date.now;
  let plan: string | null = null, planAt = 0, planTried = 0, planBusy = false;
  const PLAN_TTL = 6 * 3600_000, PLAN_RETRY = 10 * 60_000;

  const refreshPlan = (): Promise<void> => {
    if (planBusy || !o.claudePath) return Promise.resolve();
    if (plan && now() - planAt < PLAN_TTL) return Promise.resolve();
    if (!plan && planTried && now() - planTried < PLAN_RETRY) return Promise.resolve();
    planBusy = true; planTried = now();
    return new Promise((resolve) => {
      execFile(o.claudePath!, ['auth', 'status'], { timeout: 10_000, maxBuffer: 1 << 16 }, (err, stdout) => {
        const p = err ? null : planFromAuthStatus(String(stdout));
        if (p) { plan = p; planAt = now(); }
        planBusy = false; resolve();
      });
    });
  };

  return {
    /** changes whenever the file or the periodic query produced something new (also a failed attempt: staleness must show) */
    /** starts one query for a user's click (false: too soon, one is running, or no live source) */
    refresh: (): boolean => o.live?.refresh?.() ?? false,
    version: (): number | string => (o.live ? `${usageVersion(path)}:${o.live.revision()}` : usageVersion(path)),
    async read(): Promise<UsageInfo> {
      const ls = o.live?.state() ?? null;
      // with the periodic query running the plan comes with its answer; `claude auth status` is only the fallback
      if (!o.live || (!ls?.data?.plan && ls?.lastError)) await refreshPlan();
      const f = existsSync(path) ? parseUsage(readFileSync(path, 'utf8')) : { updatedAt: null, fiveHour: null, sevenDay: null };
      let statusLine: UsageInfo['statusLine'] = 'none';
      try { statusLine = statusLineKind(readFileSync(o.settingsPath, 'utf8')); } catch { /* no settings file */ }
      const fileOk = f.updatedAt != null && (f.fiveHour || f.sevenDay);
      const live = ls?.data ?? null;
      // one source wholesale (never mix windows of two): the one obtained later
      const useLive = !!live && (!fileOk || live.updatedAt >= (f.updatedAt as number));
      const chosen = useLive ? { updatedAt: live!.updatedAt, fiveHour: live!.fiveHour, sevenDay: live!.sevenDay } : fileOk ? f : { updatedAt: null, fiveHour: null, sevenDay: null };
      return {
        plan: live?.plan ?? plan, ...chosen, statusLine,
        source: useLive ? 'live' : fileOk ? 'statusline' : null,
        liveActive: !!o.live && o.live.periodic !== false, ...(ls?.running ? { refreshing: true } : {}), lastAttemptAt: ls?.lastAttemptAt ?? null, lastError: ls?.lastError ?? null,
      };
    },
  };
}
