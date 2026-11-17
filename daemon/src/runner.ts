import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SessionStore } from './sessionStore.js';
import { summarize } from './summary.js';
import type { ChatEvent, HookEvent } from '../../shared/src/types.js';
import { L } from '../../shared/src/i18n.js';

export type QueryFn = (a: { prompt: AsyncIterable<any> | string; options: Record<string, any> }) =>
  AsyncIterable<any> & {
    interrupt?: () => Promise<unknown>;
    setModel?: (model?: string) => Promise<void>;
    supportedModels?: () => Promise<Array<{ value: string; displayName: string; description: string }>>;
  };

export interface ModelChoice { value: string; displayName: string; description: string }

export class SessionBusyError extends Error {
  constructor() { super(L('Claude занят', 'Claude is busy', 'Claude 正忙')); this.name = 'SessionBusyError'; }
}

interface Pending { sid: string; input: Record<string, unknown>; resolve: (r: any) => void }

/** Unbounded async queue: the SDK reads user messages from it for as long as the session lives. */
function makeQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(x: T) { items.push(x); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        if (items.length) { yield items.shift()!; continue; }
        if (closed) return;
        await new Promise<void>((r) => { wake = r; });
        wake = null;
      }
    },
  };
}

interface Live {
  sid?: string;
  cwd: string;
  queue: ReturnType<typeof makeQueue<any>>;
  q?: { interrupt?: () => Promise<unknown>; setModel?: (model?: string) => Promise<void> };
  idleTimer?: ReturnType<typeof setTimeout>;
  /** the user pressed stop: the turn's error result is an expected end */
  interrupted?: boolean;
  /** a resume that Claude answered with another session id: this process was closed and is to be ignored */
  aborted?: boolean;
}

const userMsg = (text: string, sid = '') =>
  ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sid });

/**
 * Runs Claude Code sessions owned by the pet through the Agent SDK. Each session is one
 * long-lived process fed by a queue, so follow-ups don't pay a process start; replies are
 * streamed out as chat events and permission prompts are relayed.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export class SessionRunner {
  private pending = new Map<string, Pending>();
  private live = new Map<string, Live>();
  private queryFn: QueryFn;
  private idleCloseMs: number;
  /** model for new chats (null = Claude Code's default) and per-session choices for when they are resumed */
  private defaultModel: string | null = null;
  /** what to do with tool permission requests: 'ask' shows the prompt, 'edits' auto-allows file edits, 'all' allows everything */
  private policy: 'ask' | 'edits' | 'all' = 'ask';
  private sessionModel = new Map<string, string>();
  private modelsCache: Promise<ModelChoice[]> | null = null;

  constructor(private o: {
    store: SessionStore; queryFn?: QueryFn; claudePath?: string; idleCloseMs?: number;
    onChange?: () => void; onChat?: (sessionId: string, e: ChatEvent) => void;
  }) {
    this.queryFn = o.queryFn ?? ((a) => sdkQuery(a as any) as any);
    this.idleCloseMs = o.idleCloseMs ?? 20 * 60_000;
  }

  async start(a: { cwd: string; prompt: string }): Promise<string> {
    let ok = false;
    try { ok = (await stat(a.cwd)).isDirectory(); } catch { /* falls through */ }
    if (!ok) throw new Error(L(`Папка не существует: ${a.cwd}`, `The folder does not exist: ${a.cwd}`, `文件夹不存在：${a.cwd}`));
    return this.open(a.cwd, a.prompt);
  }

  async send(sessionId: string, text: string): Promise<void> {
    const s = this.o.store.get(sessionId);
    if (!s) throw new Error(L(`Неизвестная сессия: ${sessionId}`, `Unknown session: ${sessionId}`, `未知会话：${sessionId}`));
    // Collision rule: never write into a session that is mid-work or waiting on the user.
    if (s.state !== 'idle' && s.state !== 'done' && s.state !== 'sleeping' && s.state !== 'error') throw new SessionBusyError();
    const live = this.live.get(sessionId);
    if (!live) { await this.open(s.resumeCwd ?? s.cwd, text, sessionId); return; }
    clearTimeout(live.idleTimer);
    this.beginTurn(sessionId, text);
    live.queue.push(userMsg(text, sessionId));
  }

  async interrupt(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.interrupted = true;
    await live.q?.interrupt?.();
  }

  /** Models Claude Code offers (asked once from a short-lived probe session, then cached). */
  models(): Promise<ModelChoice[]> {
    this.modelsCache ??= (async () => {
      const queue = makeQueue<any>();
      const options: Record<string, any> = { cwd: process.cwd() };
      if (this.o.claudePath) options.pathToClaudeCodeExecutable = this.o.claudePath;
      const q = this.queryFn({ prompt: queue, options });
      try {
        const list = (await q.supportedModels?.()) ?? [];
        return list.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }));
      } finally {
        queue.close();
      }
    })().catch((e) => { this.modelsCache = null; throw e; });
    return this.modelsCache;
  }

  /** Switch the model: a live session at once, an idle one when it is next resumed; null = default for new chats. */
  async setModel(sessionId: string | null, model: string): Promise<void> {
    if (!sessionId) { this.defaultModel = model; return; }
    this.sessionModel.set(sessionId, model);
    await this.live.get(sessionId)?.q?.setModel?.(model);
  }

  /** /btw: a side question answered in a throwaway fork of the session; works while it is busy. */
  async btw(sessionId: string, question: string): Promise<void> {
    const s = this.o.store.get(sessionId);
    if (!s) throw new Error(L(`Неизвестная сессия: ${sessionId}`, `Unknown session: ${sessionId}`, `未知会话：${sessionId}`));
    this.o.onChat?.(sessionId, { kind: 'user', text: `/btw ${question}` });
    const options: Record<string, any> = {
      cwd: s.cwd, resume: sessionId, forkSession: true, permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: L('В /btw инструменты не используются', 'Tools are not used in /btw', '/btw 中不使用工具') }),
    };
    const model = this.sessionModel.get(sessionId) ?? this.defaultModel;
    if (model) options.model = model;
    if (this.o.claudePath) options.pathToClaudeCodeExecutable = this.o.claudePath;
    let answer = '';
    try {
      for await (const m of this.queryFn({ prompt: `${L('[Побочный вопрос /btw: ответь коротко и только текстом, не используй инструменты и не продолжай основную задачу]', '[Side question /btw: answer briefly and in plain text only, do not use tools and do not continue the main task]', '[旁白提问 /btw：请只用简短的纯文本回答，不要使用工具，也不要继续主任务]')}\n${question}`, options })) {
        if (m.type === 'assistant' && m.parent_tool_use_id == null)
          answer += (m.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      }
    } catch (e) {
      answer ||= `⚠ ${(e as Error).message}`;
    }
    this.o.onChat?.(sessionId, { kind: 'note', text: answer.trim() || L('(пустой ответ)', '(empty answer)', '（空回答）') });
  }

  /** Lets go of a pet-owned session (its process ends) so another client, e.g. a terminal, can resume it. */
  release(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    if (!live) return false;
    clearTimeout(live.idleTimer);
    this.live.delete(sessionId);
    const st = this.o.store.get(sessionId)?.state;
    if (st && st !== 'idle' && st !== 'done') void live.q?.interrupt?.(); // stop a running turn too
    live.queue.close();
    for (const [id, p] of this.pending) if (p.sid === sessionId) this.respondPermission(id, false);
    this.o.store.setOwned(sessionId, false);
    this.o.onChange?.();
    return true;
  }

  setPermissionPolicy(p: 'ask' | 'edits' | 'all'): void { this.policy = p; }

  respondPermission(id: string, allow: boolean): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.o.store.setPending(p.sid, undefined);
    this.emit(p.sid, 'PostToolUse', { tool_response: {} });
    p.resolve(allow
      ? { behavior: 'allow', updatedInput: p.input }
      : { behavior: 'deny', message: L('Отклонено в ccPet', 'Denied in ccPet', '已在 ccPet 中拒绝') });
    this.o.onChange?.();
  }

  /** Ends every live process (app is quitting). */
  closeAll(): void {
    for (const l of this.live.values()) { clearTimeout(l.idleTimer); l.queue.close(); }
    this.live.clear();
  }

  private cwdOf = new Map<string, string>();
  private emit(sid: string, name: string, extra: Partial<HookEvent> = {}): void {
    this.o.store.apply({ hook_event_name: name, session_id: sid, cwd: this.cwdOf.get(sid) ?? '', ...extra });
  }

  private beginTurn(sid: string, text: string): void {
    this.emit(sid, 'UserPromptSubmit');
    this.o.store.setOwned(sid, true);
    this.o.onChat?.(sid, { kind: 'user', text });
    this.o.onChange?.();
  }

  /** Starts a live process (new session, or resuming `resume`) and feeds it the first prompt. */
  private open(cwd: string, prompt: string, resume?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const live: Live = { cwd, queue: makeQueue<any>() };
      let settled = false;
      // what a resume changes before Claude has confirmed it, so that a refused resume can put it back
      const before = resume ? this.o.store.get(resume) : undefined;
      const prev = before ? { state: before.state, since: before.since, owned: before.owned } : undefined;
      const bind = (id: string) => {
        live.sid = id;
        this.live.set(id, live);
        this.cwdOf.set(id, cwd);
        this.beginTurn(id, prompt);
        if (!settled) { settled = true; resolve(id); }
      };
      if (resume) bind(resume);

      /**
       * Claude Code answered a resume with a DIFFERENT session id: it made a copy (resume from another folder).
       * Never bind that id to the original session, never talk on in the copy: close the process, undo, say so.
       */
      const abortCopy = (newId: string) => {
        live.aborted = true;
        clearTimeout(live.idleTimer);
        if (resume && this.live.get(resume) === live) this.live.delete(resume);
        live.queue.close();
        try { void (live.q as any)?.interrupt?.(); } catch { /* already gone */ }
        try { (live.q as any)?.close?.(); } catch { /* not supported */ }
        if (resume && prev) this.o.store.restore(resume, prev);
        if (resume) this.o.onChat?.(resume, { kind: 'end', error: L(`Claude Code создал копию сессии (новый ID ${newId.slice(0, 8)}…) вместо продолжения: отправка отменена, процесс закрыт. Исходная сессия не тронута.`, `Claude Code created a copy of the session (new ID ${newId.slice(0, 8)}…) instead of continuing it: the send was cancelled and the process closed. The original session is untouched.`, `Claude Code 创建了该会话的副本（新 ID ${newId.slice(0, 8)}…），而没有继续原会话：发送已取消，进程已关闭。原会话未受影响。`) });
        this.o.onChange?.();
      };

      const options: Record<string, any> = {
        cwd, resume, permissionMode: 'default', includePartialMessages: true,
        canUseTool: (tool: string, input: Record<string, unknown>, opt: { signal?: AbortSignal; toolUseID?: string }) =>
          new Promise((res) => {
            if (this.policy === 'all' || (this.policy === 'edits' && EDIT_TOOLS.has(tool))) { res({ behavior: 'allow', updatedInput: input }); return; }
            const sid = live.sid!;
            const id = opt.toolUseID ?? randomUUID();
            this.pending.set(id, { sid, input, resolve: res });
            this.o.store.setPending(sid, { id, tool, summary: summarize(tool, input) });
            this.emit(sid, 'Notification', { message: `Claude needs your permission to use ${tool}` });
            opt.signal?.addEventListener('abort', () => this.respondPermission(id, false));
            this.o.onChange?.();
          }),
      };
      const model = (resume ? this.sessionModel.get(resume) : undefined) ?? this.defaultModel;
      if (model) options.model = model;
      if (this.o.claudePath) options.pathToClaudeCodeExecutable = this.o.claudePath;

      const q = this.queryFn({ prompt: live.queue, options });
      live.q = q;
      live.queue.push(userMsg(prompt, resume));

      (async () => {
        try {
          for await (const m of q) {
            if (live.aborted) continue;
            if (m.type === 'system' && m.subtype === 'init') {
              if (resume && m.session_id !== resume) { abortCopy(String(m.session_id)); continue; }
              if (!live.sid) bind(m.session_id);
              continue;
            }
            const sid = live.sid;
            if (!sid) continue;
            this.onMessage(sid, live, m);
            this.o.onChange?.();
          }
        } catch (e) {
          const msg = (e as Error).message;
          if (live.aborted) { /* we closed it ourselves after a refused resume: already reported */ }
          else if (live.sid) {
            this.emit(live.sid, 'PostToolUse', { tool_response: { is_error: true } });
            this.o.onChat?.(live.sid, { kind: 'end', error: msg });
            this.o.onChange?.();
          } else if (!settled) { settled = true; reject(e); }
        } finally {
          clearTimeout(live.idleTimer);
          if (live.sid && this.live.get(live.sid) === live) this.live.delete(live.sid);
          if (!settled) { settled = true; reject(new Error(L('Claude Code завершился, не начав сессию', 'Claude Code exited without starting a session', 'Claude Code 退出，未能启动会话'))); }
        }
      })();
    });
  }

  private onMessage(sid: string, live: Live, m: any): void {
    const top = m.parent_tool_use_id == null; // sub-agent chatter stays out of the chat
    if (m.type === 'stream_event') {
      const d = m.event?.type === 'content_block_delta' ? m.event.delta : null;
      if (top && d?.type === 'text_delta' && d.text) this.o.onChat?.(sid, { kind: 'delta', text: d.text });
    } else if (m.type === 'assistant') {
      const blocks: any[] = m.message?.content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (top && text) this.o.onChat?.(sid, { kind: 'assistant', text });
      for (const b of blocks) if (b.type === 'tool_use') {
        this.emit(sid, 'PreToolUse', { tool_name: b.name, tool_input: b.input });
        if (top) this.o.onChat?.(sid, { kind: 'tool', name: b.name, summary: summarize(b.name, b.input) });
      }
    } else if (m.type === 'user') {
      const failed = (Array.isArray(m.message?.content) ? m.message.content : []).some((b: any) => b.type === 'tool_result' && b.is_error);
      this.emit(sid, 'PostToolUse', { tool_response: { is_error: failed } });
    } else if (m.type === 'result') {
      if (m.subtype === 'success' || live.interrupted) {
        this.emit(sid, 'Stop');
        this.o.onChat?.(sid, { kind: 'end' });
      } else {
        this.emit(sid, 'PostToolUse', { tool_response: { is_error: true } });
        this.o.onChat?.(sid, { kind: 'end', error: L(`Claude остановился: ${m.subtype}`, `Claude stopped: ${m.subtype}`, `Claude 已停止：${m.subtype}`) });
      }
      live.interrupted = false;
      // an idle live process is closed after a while; the session can still be resumed later
      clearTimeout(live.idleTimer);
      live.idleTimer = setTimeout(() => live.queue.close(), this.idleCloseMs);
      live.idleTimer.unref?.();
    }
  }
}
