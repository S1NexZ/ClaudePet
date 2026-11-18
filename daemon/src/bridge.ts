import { isNativeHook } from './nodeCmd.js';
import { join, dirname } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import type { SessionStore } from './sessionStore.js';
import type { HookPayload } from './hookSocket.js';
import { toWslPath } from './paths.js';
import { procName, ttyPath } from './procinfo.js';
import { interruptedSince, readOriginalCwd, readEntrypoint, PET_MARKER } from './transcript.js';
import type { Mailbox } from './mailbox.js';
import { summarize } from './summary.js';
import { sendPrompt, sendEsc, PtyGoneError } from './ptySend.js';
import { createSoftStop } from './softStop.js';
import { planHooks, removeHooks, lineDiff } from './installHooks.js';
import { planStatusLine, removeStatusLine, statusLineState } from './installStatusLine.js';
import { planHostHooks, removeHostHooks, hooksStatus, readSettingsFile, writeSettingsFile } from './hookConfig.js';
import type { AppCommand, AskQuestion, BridgeMessage, ChatEvent, ChatItem, Snapshot, UsageInfo } from '../../shared/src/types.js';
import { isTestCommand } from './mapEvent.js';
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

/** What the pet answers to a PermissionRequest hook: allow / deny, or allow with a changed input (Claude's questions answered) */
export type PermissionAnswer = 'allow' | 'deny' | { updatedInput: Record<string, unknown> };

/** The questions of an AskUserQuestion call, or null when the input is not shaped as expected */
export function askQuestions(input: unknown): AskQuestion[] | null {
  const qs = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(qs) || !qs.length) return null;
  const ok = qs.every((q) => typeof q?.question === 'string' && Array.isArray(q.options) && q.options.length > 0 && q.options.every((x: any) => typeof x?.label === 'string'));
  return ok ? qs.map((q) => ({ question: q.question, header: typeof q.header === 'string' ? q.header : undefined, multiSelect: q.multiSelect === true, options: q.options.map((x: any) => ({ label: x.label, description: typeof x.description === 'string' ? x.description : undefined })) })) : null;
}

/** A finished Bash call worth a reaction: tests passed or failed, a commit went in */
export function reactionFor(event: string, tool: string, input: Record<string, unknown> | undefined): 'happy' | 'sad' | null {
  if (tool !== 'Bash') return null;
  const cmd = String(input?.command ?? '');
  const failed = event === 'PostToolUseFailure';
  if (event !== 'PostToolUse' && !failed) return null;
  if (isTestCommand(cmd)) return failed ? 'sad' : 'happy';
  if (!failed && /\bgit\b[^|;&\n]*\scommit\b/.test(cmd)) return 'happy';
  return null;
}

/** hook events that can only come after a pending permission question was settled */
const SETTLES_ASK = new Set(['PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd']);

export function snapshotOf(store: SessionStore): Snapshot {
  return { type: 'snapshot', sessions: store.list(), attention: store.attention()?.id ?? null };
}

/** The app-facing core of the WSL bridge: commands in, messages out. Transport-free so it can be tested. */
/** Writes a title-setting escape sequence to the terminal (pty) a process is attached to. */
export function setTtyTitle(pid: number, text: string): boolean {
  try {
    const tty = ttyPath(pid);
    if (!tty) return false;
    writeFileSync(tty, `\x1b]0;${text.replace(/[\x00-\x1f\x7f]/g, ' ')}\x07`);
    return true;
  } catch { return false; }
}

export function createBridge(o: {
  store: SessionStore;
  runner: RunnerLike;
  out: (m: BridgeMessage) => void;
  readTranscript: (path: string) => Promise<ChatItem[]>;
  hooks: { settingsPath: string; hookPath: string; nodePath: string };
  /** allow the Agent SDK paths (default false) */
  sdkChats?: boolean;
  /** process access (real /proc and kill by default; injectable for tests) */
  proc?: { name(pid: number): string | null; kill(pid: number): void };
  /** sets the title of the terminal a process runs in (an OSC sequence written to its tty); false when it has no terminal */
  setTitle?: (pid: number, text: string) => boolean;
  /** typing into a pet-claude.py PTY socket (injectable for tests) */
  pty?: { sendPrompt(sock: string, text: string): Promise<void>; sendEsc(sock: string): Promise<void> };
  /** the folder a session was started in, from its transcript (injectable for tests) */
  originalCwd?: (path: string) => Promise<string | null>;
  /** subscription limits saved by pet-statusline.mjs (injectable for tests) */
  usage?: { version(): number | string; read(): Promise<UsageInfo>; refresh?(): boolean };
  /** whether the transcript got an "interrupted by user" entry after a time (injectable for tests) */
  interrupted?: (path: string, sinceMs: number) => Promise<boolean>;
  /** the pet's mailbox: delivers messages to sessions without a PTY through their armed waiter */
  mailbox?: Mailbox;
  /** no SDK fallback on this host: a message for a session without a PTY always goes to the mailbox (queued until a waiter arrives) */
  mailboxOnly?: boolean;
  /** answer PermissionRequest hooks through the pet (off by default); the Windows host reads the app setting here */
  permissionsFromPet?: () => boolean;
  permissionTimeoutMs?: number;
  /** how long a question of Claude waits for an answer in the pet (the hook's own timeout is a bit longer) */
  questionTimeoutMs?: number;
  /** this host's hook receiver: lets the bridge install the mailbox waiter and the PermissionRequest hook next to the events hook */
  hostHooks?: { origin: string; token: string };
  /** prefix of permission ids (two hosts must not hand out the same id) */
  permissionIdPrefix?: string;
  /** delay of the second transcript read after Stop (Claude writes its reply after the hook fires) */
  stopRecheckMs?: number;
  /** this host's hooks can answer (HTTP hooks): Stop without a PTY ends the turn at the next tool call through `hookReply` */
  softStop?: boolean;
}) {
  const pty = o.pty ?? { sendPrompt, sendEsc };
  /** the Agent SDK paths (new chats, resume fallback, /btw, model list) start a second Claude Code process under the user's login: opt-in, off by default */
  let sdkOn = o.sdkChats === true;
  const needSdk = () => { if (!sdkOn) throw new Error(L('Запуск Claude Code через Agent SDK выключен. Включите его в «Настройки → Подключения» или работайте через терминал.', 'Starting Claude Code through the Agent SDK is off. Turn it on in Settings → Connections, or work in a terminal.', '通过 Agent SDK 启动 Claude Code 已关闭。请在“设置 → 连接”中开启，或在终端中使用。')); };
  const WORKING = new Set(['thinking', 'reading', 'writing', 'running', 'testing', 'waiting', 'subagent']);
  const proc = o.proc ?? {
    name: procName,
    kill: (pid: number) => { process.kill(pid, 'SIGTERM'); },
  };
  const transcripts = new Map<string, string>();
  /** claude process of each terminal session, from the hook's parent chain */
  const pids = new Map<string, number>();
  /** sessions the user ended: their late hook events (Stop, SessionEnd) must not bring them back */
  const ended = new Set<string>();
  let permOn = false;
  const permissionsOn = () => (o.permissionsFromPet ? o.permissionsFromPet() : permOn);
  const asks = new Map<string, { sessionId: string; tool: string; resolve: (d: PermissionAnswer | null) => void; timer: ReturnType<typeof setTimeout>; input?: Record<string, unknown> }>();
  /** tool name + input: a PostToolUse of this very call (tools can run in parallel, another tool finishing settles nothing) */
  // (a question's input gains the answers once it is answered: only the questions identify it)
  const toolKey = (e: HookPayload) => `${String(e.tool_name ?? '')}\u0000${JSON.stringify(e.tool_name === 'AskUserQuestion' ? (e.tool_input as any)?.questions ?? null : e.tool_input ?? null)}`;
  let askSeq = 0;
  let lastSnap = '';
  const snapshot = (onlyIfChanged = false) => {
    const s = snapshotOf(o.store);
    if (o.mailbox) s.sessions = s.sessions.map((x) => ({ ...x, mailbox: o.mailbox!.hasWaiter(x.id) || o.mailbox!.isMod(x.id), ...(o.mailbox!.isMod(x.id) ? { mod: true } : {}) }));
    if (soft) s.sessions = s.sessions.map((x) => (hooked.has(x.id) && !x.owned && !x.pty ? { ...x, softStop: true } : x));
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
  /** sessions that sent real hook events (not just a transcript-adopted start): only their hooks can carry a soft stop */
  const hooked = new Set<string>();
  const soft = o.softStop ? createSoftStop(undefined, (id) => { o.store.markInterrupted(id); snapshot(true); rereadLater(id); }) : null;
  /** What the hooks section of settings.json would become (events hook, plus mailbox waiter and permission hook when this bridge has a receiver) and what is installed now. */
  const hooksPlan = (wantPerm: boolean, remove = false) => {
    const { current, raw } = readSettingsFile(o.hooks.settingsPath);
    // our hook files referenced by the user's settings: none = not installed; any missing = stale
    const files = Object.values(current.hooks ?? {}).flat()
      .flatMap((g: any) => (Array.isArray(g?.hooks) ? g.hooks : []))
      .map((h: any) => /"([^"]*(?:pet-hook\.mjs|ccpet-hook))"/.exec(String(h?.command ?? ''))?.[1])
      .filter((f): f is string => !!f);
    let next: Record<string, any>;
    if (remove) next = removeHostHooks(removeHooks(current).next).next;
    else {
      next = planHooks(current, o.hooks.hookPath, o.hooks.nodePath).next;
      if (o.hostHooks) next = planHostHooks(next, { kind: 'wsl', origin: o.hostHooks.origin, token: o.hostHooks.token, nodePath: o.hooks.nodePath, hookPath: o.hooks.hookPath, permissions: wantPerm }).next;
    }
    const same = JSON.stringify(current) === JSON.stringify(next);
    const diff = same ? '' : lineDiff(JSON.stringify({ hooks: current.hooks ?? {} }, null, 2).split('\n'), JSON.stringify({ hooks: next.hooks ?? {} }, null, 2).split('\n'));
    const st = hooksStatus(current, 'wsl');
    // installed through Node (0.6) while this bridge has the native hook: the same hooks, each a ~1 MB process instead of a Node one
    const upgrade = !!diff && isNativeHook(o.hooks.hookPath) && files.some((f) => f.endsWith('pet-hook.mjs'));
    return { current, raw, next, diff, installed: files.length > 0, stale: files.some((f) => !existsSync(f)), upgrade, ...st };
  };

  return {
    async handle(cmd: AppCommand): Promise<void> {
      try {
        switch (cmd?.type) {
          case 'start': {
            needSdk();
            const sessionId = await o.runner.start({ cwd: toWslPath(String(cmd.cwd)), prompt: String(cmd.prompt) });
            o.out({ type: 'started', sessionId });
            break;
          }
          case 'send': {
            const id = String(cmd.sessionId);
            const s = o.store.get(id);
            if (s?.pty && !s.owned) {
              // the session runs under pet-claude.py: type into that very process (no second claude)
              if (WORKING.has(s.state) && !/^\s*\/btw\b/.test(String(cmd.text))) throw new Error(L('Claude занят', 'Claude is busy', 'Claude 正忙')); // /btw is the one command made for a busy session
              try { await pty.sendPrompt(s.pty, String(cmd.text)); break; }
              catch (e) {
                if (!(e instanceof PtyGoneError)) throw e;
                o.store.clearPty(id); // wrapper is gone: fall back to resuming through the SDK
              }
            }
            // (the plugin re-polls every few seconds: a message for it waits in the mailbox until then)
            if (o.mailbox && s && !s.owned && (o.mailboxOnly || o.mailbox.hasWaiter(id) || o.mailbox.isMod(id))) {
              // no PTY: wake the session through its mailbox waiter (the text goes out as a hook-feedback reminder)
              const text = String(cmd.text);
              const r = o.mailbox.send(id, `${L('Пользователь написал это через ccPet. Считай это его сообщением и ответь на него.', 'The user wrote this through ccPet. Treat it as their message and answer it.', '用户通过 ccPet 写了这条消息。请把它当作用户的消息并回答。')}\n${PET_MARKER} ${text}`);
              o.out({ type: 'chat', sessionId: id, event: { kind: 'user', text } });
              if (r === 'delivered') o.store.apply({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd: s.cwd });
              break;
            }
            if (!s?.owned) needSdk(); // a session the pet already runs may keep going; resuming a terminal one needs the SDK
            await ensureResumeCwd(id);
            await o.runner.send(id, String(cmd.text));
            break;
          }
          case 'interrupt': {
            const id = String(cmd.sessionId);
            const s = o.store.get(id);
            if (s?.pty && !s.owned) { try { await pty.sendEsc(s.pty); o.store.markInterrupted(id); rereadLater(id); } catch { o.store.clearPty(id); } break; }
            if (soft && s && !s.owned && hooked.has(id)) {
              soft.request(id, Date.now());
              o.out({ type: 'chat', sessionId: id, event: { kind: 'note', text: L('Остановлю после текущего шага…', 'Stopping after the current step…', '将在当前步骤后停止…') } });
              break;
            }
            await o.runner.interrupt(id);
            break;
          }
          case 'language': if (cmd.lang === 'ru' || cmd.lang === 'en' || cmd.lang === 'zh') setLang(cmd.lang); break;
          case 'permission-mode': if (cmd.mode === 'ask' || cmd.mode === 'edits' || cmd.mode === 'all') o.runner.setPermissionPolicy(cmd.mode); break;
          case 'hook-permissions': permOn = cmd.on === true; return;
          case 'permission': {
            const ask = asks.get(String(cmd.id));
            if (ask) { clearTimeout(ask.timer); asks.delete(String(cmd.id)); o.store.setPending(ask.sessionId, undefined); o.store.apply({ hook_event_name: 'UserPromptSubmit', session_id: ask.sessionId, cwd: o.store.get(ask.sessionId)?.cwd ?? '' }); // a question answered in the pet goes back as its input plus the answers; dismissed, the terminal's own question stays
              if (ask.input) ask.resolve(cmd.allow === true && cmd.answers && typeof cmd.answers === 'object' ? { updatedInput: { ...ask.input, answers: cmd.answers } } : null);
              else ask.resolve(cmd.allow === true ? 'allow' : 'deny');
              break; }
            o.runner.respondPermission(String(cmd.id), cmd.allow === true);
            break;
          }
          case 'history': await history(String(cmd.sessionId)); return;
          case 'statusline': { // Claude Code's statusLine feeds the limits ring (always with the diff in the app's dialog and a backup)
            if (!o.hooks.nodePath) { o.out({ type: 'statusline', diff: '', applied: false, kind: 'none', error: 'unsupported' }); return; }
            try {
              const { current, raw } = readSettingsFile(o.hooks.settingsPath);
              const script = isNativeHook(o.hooks.hookPath) ? o.hooks.hookPath : join(dirname(o.hooks.hookPath), 'pet-statusline.mjs');
              const r = cmd.remove === true ? removeStatusLine(current) : planStatusLine(current, script, o.hooks.nodePath);
              if (cmd.apply === true && r.diff) writeSettingsFile(o.hooks.settingsPath, r.next, raw !== undefined);
              o.out({ type: 'statusline', diff: cmd.apply === true ? '' : r.diff, applied: cmd.apply === true && !!r.diff, kind: statusLineState(cmd.apply === true || !r.diff ? r.next : current) });
            } catch (e) { o.out({ type: 'statusline', diff: '', applied: false, kind: 'none', error: (e as Error).message }); }
            return;
          }
          case 'usage-refresh': { // the user clicked the limits ring: one live query (throttled by the source); its start and end push the numbers
            // only on the user's own click (never on a timer or at start): the live query runs through the Agent SDK under the user's login
            if (o.usage) { o.usage.refresh?.(); usageVersion = o.usage.version(); o.out({ type: 'usage', usage: await o.usage.read() }); }
            return;
          }
          case 'usage': if (o.usage) { usageVersion = o.usage.version(); o.out({ type: 'usage', usage: await o.usage.read() }); } return;
          case 'sdk-chats': sdkOn = cmd.on === true; return;
          case 'models': needSdk(); o.out({ type: 'models', models: await o.runner.models() }); return;
          case 'setModel': {
            const sid = cmd.sessionId == null ? null : String(cmd.sessionId);
            needSdk();
            await o.runner.setModel(sid, String(cmd.model));
            o.out({ type: 'modelSet', sessionId: sid, model: String(cmd.model) });
            return;
          }
          case 'btw': if (!o.store.get(String(cmd.sessionId))?.owned) needSdk(); await o.runner.btw(String(cmd.sessionId), String(cmd.text)); return;
          case 'release': o.runner.release(String(cmd.sessionId)); break;
          case 'end': {
            const id = String(cmd.sessionId);
            if (!o.runner.release(id)) {
              const pid = pids.get(id);
              if (pid && proc.name(pid) === 'claude') proc.kill(pid); // no process found = already closed: the stale row is simply dropped
            }
            o.store.remove(id);
            pids.delete(id);
            ended.add(id);
            break;
          }
          case 'term-mark': { // the pet is about to look for this session's terminal window: give its tab a recognisable title
            const id = String(cmd.sessionId); const pid = pids.get(id);
            const set = o.setTitle ?? setTtyTitle;
            const ok = !!pid && proc.name(pid) === 'claude' && set(pid, String(cmd.text));
            if (ok && pid) { // Claude Code rewrites the title all the time (spinner): keep the marker up while the pet looks for the window
              let n = 0; const t = setInterval(() => { if (++n > 14 || !set(pid, String(cmd.text))) clearInterval(t); }, 200); t.unref?.();
            }
            o.out({ type: 'termMark', sessionId: id, ok });
            return;
          }
          case 'dismiss': { // hide a session from the list without touching its process (a live one reappears on its next prompt)
            const id = String(cmd.sessionId);
            o.store.remove(id); pids.delete(id); ended.add(id);
            break;
          }
          case 'hooks': {
            const wantPerm = typeof cmd.permissions === 'boolean' ? cmd.permissions : permissionsOn();
            let p;
            try { p = hooksPlan(wantPerm, cmd.remove === true); }
            catch (e) { o.out({ type: 'hooks', diff: '', applied: false, installed: false, stale: false, error: (e as Error).message }); return; }
            if (cmd.apply === true) {
              if (p.diff) writeSettingsFile(o.hooks.settingsPath, p.next, p.raw !== undefined);
              o.out({ type: 'hooks', diff: '', applied: !!p.diff, installed: cmd.remove !== true, stale: false, events: cmd.remove !== true, mailbox: cmd.remove !== true && !!o.hostHooks, permissions: cmd.remove !== true && wantPerm && !!o.hostHooks });
            } else {
              o.out({ type: 'hooks', diff: p.diff, applied: false, installed: p.installed, stale: p.stale, upgrade: p.upgrade, events: p.events, mailbox: p.mailbox, permissions: p.permissions });
            }
            return;
          }
          default: throw new Error(L('Неизвестная команда', 'Unknown command', '未知命令'));
        }
        snapshot();
      } catch (e) {
        o.out({ type: 'error', message: (e as Error).message });
      }
    },
    /** synthetic SessionStart (transcript adoption, mailbox waiter): never revives a session the user closed */
    adopt(e: HookPayload): void {
      if (!ended.has(e.session_id)) this.onHook(e);
    },
    onHook(e: HookPayload): void {
      if (e.hook_event_name !== 'SessionStart') hooked.add(e.session_id);
      // the question was answered somewhere else (in the terminal or the app): the tool ran, the turn moved on or ended. Drop the pet's
      // Allow / Deny at once instead of showing it until the 30 s timeout
      if (SETTLES_ASK.has(e.hook_event_name)) {
        const post = e.hook_event_name === 'PostToolUse' || e.hook_event_name === 'PostToolUseFailure';
        for (const [id, a] of asks) if (a.sessionId === e.session_id && (!post || a.tool === toolKey(e))) { clearTimeout(a.timer); asks.delete(id); o.store.setPending(a.sessionId, undefined); a.resolve(null); }
      }
      const reaction = reactionFor(e.hook_event_name, String(e.tool_name ?? ''), e.tool_input as Record<string, unknown> | undefined);
      if (reaction && !o.store.get(e.session_id)?.owned) o.out({ type: 'react', sessionId: e.session_id, reaction });
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
      if (newPath && typeof e.transcript_path === 'string' && !o.store.get(e.session_id)?.source) {
        void readEntrypoint(e.transcript_path).then((src) => { if (src) { o.store.setSource(e.session_id, src); snapshot(true); } });
      }
      snapshot();
      const sess = o.store.get(e.session_id);
      if ((e.hook_event_name === 'Stop' || newPath || (e.hook_event_name === 'UserPromptSubmit' && sess?.pty)) && !sess?.owned) void history(e.session_id);
      // the hook fires before Claude flushes the new lines to the transcript: read again shortly after
      if ((e.hook_event_name === 'Stop' || (e.hook_event_name === 'UserPromptSubmit' && sess?.pty)) && !sess?.owned) rereadLater(e.session_id);
    },
    /** A PermissionRequest hook: shown in the pet as Allow / Deny when the user switched that on; null = no opinion (the normal dialog stays). */
    onPermission(e: HookPayload, gone?: AbortSignal): Promise<PermissionAnswer | null> {
      // Claude's questions (AskUserQuestion) are answered in the pet always; other tools only when the user switched that on
      const questions = e.tool_name === 'AskUserQuestion' ? askQuestions(e.tool_input) : null;
      if ((!questions && !permissionsOn()) || o.store.get(e.session_id)?.owned) return Promise.resolve(null);
      // with permissions on, two hook groups fire for one question: the first one shows it, the other has no opinion
      if (questions && [...asks.values()].some((a) => a.sessionId === e.session_id && a.tool === toolKey(e))) return Promise.resolve(null);
      o.store.apply({ hook_event_name: 'Notification', session_id: e.session_id, cwd: e.cwd, message: 'permission' });
      const id = `${o.permissionIdPrefix ?? 'hp-'}${++askSeq}`;
      const summary = questions ? questions[0].question : summarize(String(e.tool_name ?? ''), (e.tool_input ?? {}) as Record<string, unknown>);
      o.store.setPending(e.session_id, { id, tool: String(e.tool_name ?? ''), summary, ...(questions ? { questions } : {}) });
      snapshot();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { asks.delete(id); o.store.setPending(e.session_id, undefined); snapshot(); resolve(null); }, questions ? o.questionTimeoutMs ?? 590_000 : o.permissionTimeoutMs ?? 30_000);
        timer.unref?.();
        asks.set(id, { sessionId: e.session_id, tool: toolKey(e), resolve, timer, ...(questions ? { input: (e.tool_input ?? {}) as Record<string, unknown> } : {}) });
        // Claude Code dropped the request (the session was closed, its hook timed out): nobody is waiting for this answer any more
        gone?.addEventListener('abort', () => { if (!asks.has(id)) return; clearTimeout(timer); asks.delete(id); o.store.setPending(e.session_id, undefined); snapshot(); resolve(null); });
      });
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
    /** the answer for a hook event (soft stop), or null */
    hookReply: (e: HookPayload) => soft?.reply(e, Date.now()) ?? null,
  };
}
