import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SessionStore } from '../../../daemon/src/sessionStore.js';
import { createBridge } from '../../../daemon/src/bridge.js';
import { createMailbox } from '../../../daemon/src/mailbox.js';
import { startHookServer } from '../../../daemon/src/hookHttp.js';
import { readTranscript } from '../../../daemon/src/transcript.js';
import { findRunning } from '../../../daemon/src/adopt.js';
import { createUsageSource } from '../../../daemon/src/usage.js';
import { sendTitle } from '../../../daemon/src/ptySend.js';
import { planStatusLine, removeStatusLine, statusLineState, type StatusLineKind } from '../../../daemon/src/installStatusLine.js';
import { planHostHooks, removeHostHooks, hooksStatus, readSettingsFile, writeSettingsFile, type HooksStatus } from '../../../daemon/src/hookConfig.js';
import type { AppCommand, BridgeMessage } from '../../../shared/src/types.js';
import { L } from '../../../shared/src/i18n.js';

export const WINDOWS_HOST_PORT = 47821;

export interface WindowsHostOpts {
  /** the app's data folder (the hook token is kept there) */
  dataDir: string;
  /** `C:\Users\<user>\.claude` */
  claudeHome: string;
  /** 0 = any free port (tests) */
  port: number;
  /** pet-helper.exe (the mailbox waiter); without it the host still works but cannot deliver messages */
  helperPath?: string;
  out: (m: BridgeMessage) => void;
  permissionsFromPet: () => boolean;
}

export interface HostHooksState extends HooksStatus { settingsPath: string; diff: string; error?: string }

/**
 * The Windows side of the pet: the same transport-free bridge the WSL process runs, inside Electron's main process, fed by Claude Code's
 * HTTP hooks (PowerShell / CMD / Windows Terminal / VS Code terminal / the desktop app all read C:\Users\<user>\.claude\settings.json).
 * Messages to its sessions go through the mailbox; there is no SDK fallback here.
 */
/** The status line command must not contain spaces (it runs in Git Bash or PowerShell unquoted): a path with spaces becomes its short 8.3 form. */
function shellSafePath(p: string): string {
  if (!/\s/.test(p) || process.platform !== 'win32') return p;
  try { return execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim() || p; } catch { return p; }
}

export function createWindowsHost(o: WindowsHostOpts) {
  const settingsPath = join(o.claudeHome, 'settings.json');
  const tokenFile = join(o.dataDir, 'hub.json');
  const token = (() => {
    try { const t = JSON.parse(readFileSync(tokenFile, 'utf8'))?.token; if (typeof t === 'string' && /^[0-9a-f]{16,}$/.test(t)) return t; } catch { /* first run */ }
    const t = randomBytes(16).toString('hex');
    mkdirSync(o.dataDir, { recursive: true });
    writeFileSync(tokenFile, JSON.stringify({ token: t }));
    return t;
  })();
  const store = new SessionStore();
  const mailbox = createMailbox();
  const no = (ru: string, en: string, zh: string) => async () => { throw new Error(L(ru, en, zh)); };
  const bridge = createBridge({
    store, out: o.out, readTranscript, mailbox, mailboxOnly: true, permissionsFromPet: o.permissionsFromPet, softStop: true,
    // limits saved by `pet-helper.exe statusline` (%USERPROFILE%\.claude-pet\usage.json), read when the file changes
    usage: createUsageSource({ path: join(dirname(o.claudeHome), '.claude-pet', 'usage.json'), settingsPath }),
    runner: {
      models: async () => [], setPermissionPolicy: () => {}, release: () => false, respondPermission: () => {},
      setModel: no('Сменить модель можно в самой сессии', 'Change the model inside the session', '请在会话内切换模型'),
      btw: no('/btw доступен только для сессий в WSL', '/btw works only for sessions in WSL', '/btw 仅适用于 WSL 中的会话'),
      start: no('Новые чаты запускаются в WSL', 'New chats start in WSL', '新聊天在 WSL 中启动'),
      send: no('Эту сессию нельзя разбудить: в ней не подключены хуки ccPet', 'This session cannot be reached: ccPet hooks are not connected in it', '无法连接此会话：其中未连接 ccPet 钩子'),
      interrupt: no('Эту сессию нельзя остановить из питомца: в ней не подключены хуки ccPet', 'This session cannot be stopped from the pet: ccPet hooks are not connected in it', '无法从宠物停止此会话：其中未连接 ccPet 钩子'),
    },
    proc: { name: () => null, kill: () => {} },
    hooks: { settingsPath, hookPath: '', nodePath: '' },
  });
  let server: { port: number; close(): Promise<void> } | null = null;
  const adopted = new Set<string>();
  let lastAdopt = 0;
  /** `pet-helper pty` wrappers announced by their waiters before their session was known: session id -> pipe, applied once it is */
  const pendingPtys = new Map<string, string>();
  const attachPty = (sid: string, pipe: string) => { if (store.get(sid)) { if (store.setPty(sid, pipe)) bridge.snapshot(); } else pendingPtys.set(sid, pipe); };
  const flushPtys = () => { for (const [sid, pipe] of pendingPtys) if (store.get(sid)) { pendingPtys.delete(sid); if (store.setPty(sid, pipe)) bridge.snapshot(); } };
  /** sessions seen only in transcripts (the pet started later, or hooks are not connected there): shown as idle until a hook arrives */
  const adopt = async (now: number) => {
    for (const r of await findRunning(join(o.claudeHome, 'projects'), now, 10 * 60_000)) {
      if (adopted.has(r.id) || store.get(r.id)) continue;
      adopted.add(r.id);
      bridge.onHook({ hook_event_name: 'SessionStart', session_id: r.id, cwd: r.cwd, transcript_path: r.path });
    }
  };
  const origin = () => `http://127.0.0.1:${server?.port ?? o.port}`;
  const plan = (permissions: boolean) => {
    const { current, raw } = readSettingsFile(settingsPath);
    const r = planHostHooks(current, { kind: 'windows', origin: origin(), token, helperPath: o.helperPath, permissions });
    return { current, raw, ...r };
  };

  return {
    token,
    get port() { return server?.port ?? 0; },
    /** starts the receiver; resolves false (and reports why) when the port is taken */
    async start(): Promise<boolean> {
      try {
        server = await startHookServer({ port: o.port, token, mailbox, onWaiter: (sid, cwd, src) => {
          if (!store.get(sid)) bridge.onHook({ hook_event_name: 'SessionStart', session_id: sid, cwd });
          if (src && !store.get(sid)?.source) { store.setSource(sid, src); bridge.snapshot(); }
        }, onPty: attachPty, onEvent: (e) => bridge.onHook(e), onReply: (e) => bridge.hookReply(e), onPermission: (e) => bridge.onPermission(e) });
        bridge.snapshot();
        return true;
      } catch (e) {
        o.out({ type: 'error', message: L(`Порт ${o.port} занят: хуки Windows не подключены (${(e as Error).message})`, `Port ${o.port} is busy: Windows hooks are not connected (${(e as Error).message})`, `端口 ${o.port} 被占用：未连接 Windows 钩子（${(e as Error).message}）`) });
        return false;
      }
    },
    async stop(): Promise<void> { await server?.close(); server = null; },
    handle: (cmd: AppCommand) => bridge.handle(cmd),
    tick: (now: number) => { bridge.tick(now); flushPtys(); if (now - lastAdopt > 15_000) { lastAdopt = now; void adopt(now).catch(() => {}); } },
    snapshot: () => bridge.snapshot(),
    /** what is installed in the Windows settings.json now, and what installing / updating would change */
    state(permissions: boolean = o.permissionsFromPet()): HostHooksState {
      try {
        const p = plan(permissions);
        return { ...hooksStatus(p.current, 'windows'), settingsPath, diff: p.diff };
      } catch (e) {
        return { events: false, mailbox: false, permissions: false, settingsPath, diff: '', error: (e as Error).message };
      }
    },
    /** writes our hooks after the caller got the user's consent (a .bak copy is kept) */
    apply(permissions: boolean): { applied: boolean; diff: string } {
      const p = plan(permissions);
      if (!p.diff) return { applied: false, diff: '' };
      writeSettingsFile(settingsPath, p.next, p.raw !== undefined);
      return { applied: true, diff: p.diff };
    },
    /** what removing our entries would change (shown before the user agrees) */
    removeDiff(): string {
      try { return removeHostHooks(readSettingsFile(settingsPath).current).diff; } catch { return ''; }
    },
    /** removes only our entries */
    remove(): { applied: boolean; diff: string } {
      const { current, raw } = readSettingsFile(settingsPath);
      const r = removeHostHooks(current);
      if (!r.diff) return { applied: false, diff: '' };
      writeSettingsFile(settingsPath, r.next, raw !== undefined);
      return { applied: true, diff: r.diff };
    },
    /** the Windows statusLine (`pet-helper.exe statusline`, wrapping the user's own line): the plan, or the write after the user agreed */
    statusLine(c: { apply?: boolean; remove?: boolean }): { diff: string; applied: boolean; kind: StatusLineKind; error?: string } {
      if (!o.helperPath) return { diff: '', applied: false, kind: 'none', error: 'unsupported' };
      try {
        const { current, raw } = readSettingsFile(settingsPath);
        const r = c.remove ? removeStatusLine(current) : planStatusLine(current, '', '', { exe: shellSafePath(o.helperPath) });
        if (c.apply && r.diff) writeSettingsFile(settingsPath, r.next, raw !== undefined);
        return { diff: c.apply ? '' : r.diff, applied: !!c.apply && !!r.diff, kind: statusLineState(c.apply || !r.diff ? r.next : current) };
      } catch (e) { return { diff: '', applied: false, kind: 'none', error: (e as Error).message }; }
    },
    pushUsage: () => bridge.pushUsage(),
    /** a session in the `pet-helper pty` wrapper: title its terminal (false: no wrapper, or it is gone) */
    async markTerminal(sessionId: string, mark: string): Promise<boolean> {
      const pipe = store.get(sessionId)?.pty;
      if (!pipe) return false;
      try { await sendTitle(pipe, mark); return true; } catch { store.clearPty(sessionId); return false; }
    },
    settingsPath,
    hasSettings: () => existsSync(settingsPath),
  };
}
