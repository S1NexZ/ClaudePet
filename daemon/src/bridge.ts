import { readFileSync, existsSync } from 'node:fs';
import type { SessionStore } from './sessionStore.js';
import type { HookPayload } from './hookSocket.js';
import { toWslPath } from './paths.js';
import { interruptedSince, readOriginalCwd } from './transcript.js';
import { sendPrompt, sendEsc, PtyGoneError } from './ptySend.js';
import { planHooks, runInstall } from './installHooks.js';
import type { AppCommand, BridgeMessage, ChatEvent, ChatItem, Snapshot, UsageInfo } from '../../shared/src/types.js';
import { L, setLang } from '../../shared/src/i18n.js';

export interface RunnerLike {
  models(): Promise<Array<{ value: string; displayName: string; description: string }>>;
  setPermissionPolicy(p: 'ask' | 'edits' | 'all'): void;
  setModel(sessionId: string | null, model: string): Promise<void>;
  btw(sessionId: string, text: string): Promise<void>;
  release(sessionId: string): boolean;
  start(a: { cwd: string; prompt: string }): Promise<string>;
  send(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respondPermission(id: string, allow: boolean): void;
}

export function snapshotOf(store: SessionStore): Snapshot {
  return { type: 'snapshot', sessions: store.list(), attention: store.attention()?.id ?? null };
}

/** The app-facing core of the WSL bridge: commands in, messages out. Transport-free so it can be tested. */
export function createBridge(o: {
  store: SessionStore;
  runner: RunnerLike;
  out: (m: BridgeMessage) => void;
  readTranscript: (path: string) => Promise<ChatItem[]>;
  hooks: { settingsPath: string; hookPath: string; nodePath: string };
  /** process access (real /proc and kill by default; injectable for tests) */
  proc?: { name(pid: number): string | null; kill(pid: number): void };
  /** typing into a pet-claude.py PTY socket (injectable for tests) */
  pty?: { sendPrompt(sock: string, text: string): Promise<void>; sendEsc(sock: string): Promise<void> };
  /** the folder a session was started in, from its transcript (injectable for tests) */
  originalCwd?: (path: string) => Promise<string | null>;
  /** subscription limits saved by pet-statusline.mjs (injectable for tests) */
  usage?: { version(): number | string; read(): Promise<UsageInfo> };
  /** whether the transcript got an "interrupted by user" entry after a time (injectable for tests) */
  interrupted?: (path: string, sinceMs: number) => Promise<boolean>;
  /** delay of the second transcript read after Stop (Claude writes its reply after the hook fires) */
  stopRecheckMs?: number;
}) {
  const pty = o.pty ?? { sendPrompt, sendEsc };
  const WORKING = new Set(['thinking', 'reading', 'writing', 'running', 'testing', 'waiting', 'subagent']);
  const proc = o.proc ?? {
    name: (pid: number) => { try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; } },
    kill: (pid: number) => { process.kill(pid, 'SIGTERM'); },
  };
  const transcripts = new Map<string, string>();
  /** claude process of each terminal session, from the hook's parent chain */
  const pids = new Map<string, number>();
  /** sessions the user ended: their late hook events (Stop, SessionEnd) must not bring them back */
  const ended = new Set<string>();
  let lastSnap = '';
  const snapshot = (onlyIfChanged = false) => {
    const s = snapshotOf(o.store);
    const key = JSON.stringify(s);
    if (onlyIfChanged && key === lastSnap) return;
    lastSnap = key;
    o.out(s);
  };
  const history = async (sessionId: string) => {
    const p = transcripts.get(sessionId);
    o.out({ type: 'history', sessionId, items: p ? await o.readTranscript(p) : [] });
  };
  /** SDK fallback resumes a session: it must run in the folder the session was started in, or Claude Code copies it */
  const ensureResumeCwd = async (id: string) => {
    const s = o.store.get(id);
    const p = transcripts.get(id);
    if (!s || s.resumeCwd || !p) return;
    const c = await (o.originalCwd ?? readOriginalCwd)(p).catch(() => null);
    if (c) o.store.setResumeCwd(id, c);
  };
  const checking = new Set<string>();
  let usageVersion: number | string = -1;
  const rereadLater = (id: string) => { setTimeout(() => void history(id), o.stopRecheckMs ?? 700).unref?.(); };
  const hooksPlan = () => {
    let current: Record<string, any> = {};
    if (existsSync(o.hooks.settingsPath)) {
      const raw = readFileSync(o.hooks.settingsPath, 'utf8');
      current = raw.trim() ? JSON.parse(raw) : {};
    }
    // our hook files referenced by the user's settings: none = not installed; any missing = stale
    const files = Object.values(current.hooks ?? {}).flat()
      .flatMap((g: any) => (Array.isArray(g?.hooks) ? g.hooks : []))
      .map((h: any) => /"([^"]*pet-hook\.mjs)"/.exec(String(h?.command ?? ''))?.[1])
      .filter((f): f is string => !!f);
    return {
      diff: planHooks(current, o.hooks.hookPath, o.hooks.nodePath).diff,
      installed: files.length > 0,
      stale: files.some((f) => !existsSync(f)),
    };
  };

  return {
    async handle(cmd: AppCommand): Promise<void> {
      try {
        switch (cmd?.type) {
          case 'start': {
            const sessionId = await o.runner.start({ cwd: toWslPath(String(cmd.cwd)), prompt: String(cmd.prompt) });
            o.out({ type: 'started', sessionId });
            break;
          }
          case 'send': {
            const id = String(cmd.sessionId);
            const s = o.store.get(id);
            if (s?.pty && !s.owned) {
              // the session runs under pet-claude.py: type into that very process (no second claude)
              if (WORKING.has(s.state)) throw new Error(L('Claude занят', 'Claude is busy', 'Claude 正忙'));
              try { await pty.sendPrompt(s.pty, String(cmd.text)); break; }
              catch (e) {
                if (!(e instanceof PtyGoneError)) throw e;
                o.store.clearPty(id); // wrapper is gone: fall back to resuming through the SDK
              }
            }
            await ensureResumeCwd(id);
            await o.runner.send(id, String(cmd.text));
            break;
          }
          case 'interrupt': {
            const id = String(cmd.sessionId);
            const s = o.store.get(id);
            if (s?.pty && !s.owned) { try { await pty.sendEsc(s.pty); o.store.markInterrupted(id); rereadLater(id); } catch { o.store.clearPty(id); } break; }
            await o.runner.interrupt(id);
            break;
          }
          case 'language': if (cmd.lang === 'ru' || cmd.lang === 'en' || cmd.lang === 'zh') setLang(cmd.lang); break;
          case 'permission-mode': if (cmd.mode === 'ask' || cmd.mode === 'edits' || cmd.mode === 'all') o.runner.setPermissionPolicy(cmd.mode); break;
          case 'permission': o.runner.respondPermission(String(cmd.id), cmd.allow === true); break;
          case 'history': await history(String(cmd.sessionId)); return;
          case 'usage': if (o.usage) { usageVersion = o.usage.version(); o.out({ type: 'usage', usage: await o.usage.read() }); } return;
          case 'models': o.out({ type: 'models', models: await o.runner.models() }); return;
          case 'setModel': {
            const sid = cmd.sessionId == null ? null : String(cmd.sessionId);
            await o.runner.setModel(sid, String(cmd.model));
            o.out({ type: 'modelSet', sessionId: sid, model: String(cmd.model) });
            return;
          }
          case 'btw': await o.runner.btw(String(cmd.sessionId), String(cmd.text)); return;
          case 'release': o.runner.release(String(cmd.sessionId)); break;
          case 'end': {
            const id = String(cmd.sessionId);
            if (!o.runner.release(id)) {
              const pid = pids.get(id);
              if (!pid || proc.name(pid) !== 'claude') throw new Error(L('Не нашёл процесс этой сессии: возможно, она уже закрыта', 'Could not find this session’s process: it may already be closed', '找不到此会话的进程：可能已关闭'));
              proc.kill(pid);
            }
            o.store.remove(id);
            pids.delete(id);
            ended.add(id);
            break;
          }
          case 'hooks':
            if (cmd.apply === true) {
              await runInstall({ ...o.hooks, yes: true, ask: async () => 'y', out: () => {} });
              o.out({ type: 'hooks', diff: '', applied: true, installed: true, stale: false });
            } else {
              o.out({ type: 'hooks', ...hooksPlan(), applied: false });
            }
            return;
          default: throw new Error(L('Неизвестная команда', 'Unknown command', '未知命令'));
        }
        snapshot();
      } catch (e) {
        o.out({ type: 'error', message: (e as Error).message });
      }
    },
    onHook(e: HookPayload): void {
      if (ended.has(e.session_id)) {
        if (e.hook_event_name !== 'UserPromptSubmit' && e.hook_event_name !== 'SessionStart') return;
        ended.delete(e.session_id); // resumed by the user
      }
      let newPath = false;
      if (typeof e.transcript_path === 'string') {
        newPath = transcripts.get(e.session_id) !== e.transcript_path;
        transcripts.set(e.session_id, e.transcript_path);
      }
      const claudePid = (e.pet_parents ?? []).find((p) => Number.isInteger(p) && proc.name(p) === 'claude');
      if (claudePid) pids.set(e.session_id, claudePid);
      o.store.apply(e);
      snapshot();
      const sess = o.store.get(e.session_id);
      if ((e.hook_event_name === 'Stop' || newPath || (e.hook_event_name === 'UserPromptSubmit' && sess?.pty)) && !sess?.owned) void history(e.session_id);
      // the hook fires before Claude flushes the new lines to the transcript: read again shortly after
      if ((e.hook_event_name === 'Stop' || (e.hook_event_name === 'UserPromptSubmit' && sess?.pty)) && !sess?.owned) rereadLater(e.session_id);
    },
    onChat(sessionId: string, event: ChatEvent): void {
      o.out({ type: 'chat', sessionId, event });
    },
    tick(now: number): void {
      o.store.tick(now);
      snapshot(true);
      // the limits file changes only when a Claude Code session gets an API response: compare its mtime, no content polling
      if (o.usage) {
        const v = o.usage.version();
        if (usageVersion !== -1 && v !== usageVersion) { usageVersion = v; void o.usage.read().then((usage) => o.out({ type: 'usage', usage })).catch(() => {}); }
      }
      // Esc / Ctrl+C typed in the terminal end a turn without any hook: the transcript is the only witness
      for (const s of o.store.list()) {
        const p = transcripts.get(s.id);
        if (!p || s.owned || !WORKING.has(s.state) || checking.has(s.id)) continue;
        checking.add(s.id);
        const since = s.since;
        void (o.interrupted ?? interruptedSince)(p, since).then((hit) => {
          const cur = o.store.get(s.id);
          if (hit && cur && cur.since === since && WORKING.has(cur.state)) { o.store.markInterrupted(s.id); snapshot(true); rereadLater(s.id); }
        }).finally(() => checking.delete(s.id));
      }
    },
    /** sends the current limits to the app (called when the periodic usage query finished) */
    async pushUsage(): Promise<void> {
      if (!o.usage) return;
      try { usageVersion = o.usage.version(); o.out({ type: 'usage', usage: await o.usage.read() }); } catch { /* the next tick retries */ }
    },
    snapshot,
  };
}
