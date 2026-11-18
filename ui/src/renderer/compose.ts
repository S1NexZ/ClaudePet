import type { Session, Snapshot } from '../../../shared/src/types.js';
import { L } from '../../../shared/src/i18n.js';

export type Mode = 'reply' | 'new';
export type Decision =
  | { kind: 'empty' }
  | { kind: 'needFolder' }
  | { kind: 'busy' }
  /** the session is working: the message waits and goes in when the turn ends */
  | { kind: 'queue'; sessionId: string; text: string }
  | { kind: 'start'; cwd: string; prompt: string }
  | { kind: 'send'; sessionId: string; text: string };

const attentionOf = (snap: Snapshot | null): Session | null =>
  snap?.sessions.find((x) => x.id === snap.attention) ?? null;

export function replyTarget(snap: Snapshot | null): Session | null {
  const s = attentionOf(snap);
  return s && !isWorking(s.state) ? s : null;
}

/** Reply mode while the attention session is mid-work: input must be disabled. */
export function isBusyReply(snap: Snapshot | null, mode: Mode): boolean {
  const s = attentionOf(snap);
  return mode === 'reply' && !!s && isWorking(s.state);
}

/** Stop works for sessions the pet owns and for terminal sessions it can type into (pet-claude.py socket). */
export const canStop = (s: Pick<Session, 'owned' | 'pty' | 'softStop'> | undefined | null): boolean => !!s && (s.owned || !!s.pty || !!s.softStop);

const WORKING = new Set(['thinking', 'reading', 'writing', 'running', 'testing', 'waiting', 'subagent']);
const isWorking = (st: string) => WORKING.has(st);

const folderName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export function decideSend(text: string, snap: Snapshot | null, folder: string | null, mode: Mode): Decision {
  const t = text.trim();
  if (!t) return { kind: 'empty' };
  if (isBusyReply(snap, mode)) return { kind: 'queue', sessionId: attentionOf(snap)!.id, text: t };
  const target = mode === 'reply' ? replyTarget(snap) : null;
  if (target) return { kind: 'send', sessionId: target.id, text: t };
  if (!folder) return { kind: 'needFolder' };
  return { kind: 'start', cwd: folder, prompt: t };
}

export function placeholderFor(snap: Snapshot | null, folder: string | null, mode: Mode): string {
  if (isBusyReply(snap, mode)) return L('Claude работает: сообщение встанет в очередь…', 'Claude is working: the message will wait its turn…', 'Claude 正在工作：消息将排队…');
  const target = mode === 'reply' ? replyTarget(snap) : null;
  if (target) return L(`Ответить в ${target.project}…`, `Reply in ${target.project}…`, `在 ${target.project} 中回复…`);
  if (folder) return L(`Новая задача в «${folderName(folder)}»…`, `New task in “${folderName(folder)}”…`, `在“${folderName(folder)}”中新建任务…`);
  return L('Начать новый чат', 'Start a new chat', '开始新聊天');
}

/** "/name args" -> {name, args}; anything else (plain text, a lone "/") -> null. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\s*\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1], args: (m[2] ?? '').trim() } : null;
}
