import { connect } from 'node:net';
import { L } from '../../shared/src/i18n.js';

/** Keys as the Claude Code TUI receives them from a terminal. */
export const KEY = { enter: '\r', esc: '\x1b' } as const;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Drops control characters that could act as keystrokes (Esc, Ctrl+C, ...); keeps newlines and tabs. */
export function sanitize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** What to write to the PTY to type `text` and submit it. Multi-line text goes in as a bracketed paste. */
export function typedInput(text: string): { body: string; submit: string } {
  const t = sanitize(text).trim();
  return { body: t.includes('\n') ? PASTE_START + t + PASTE_END : t, submit: KEY.enter };
}

export class PtyGoneError extends Error {
  constructor() { super(L('Сокет терминальной сессии недоступен: окно закрыто или Claude завершился', 'The terminal session socket is unavailable: the window was closed or Claude exited', '终端会话套接字不可用：窗口已关闭或 Claude 已退出')); this.name = 'PtyGoneError'; }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Writes chunks to a pet-claude.py socket, pausing between them (the TUI treats a lone Enter after the text as "submit"). */
export async function writePty(sock: string, chunks: string[], gapMs = 300): Promise<void> {
  const c = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const s = connect(sock);
    s.once('connect', () => resolve(s));
    s.once('error', () => reject(new PtyGoneError()));
  });
  c.on('error', () => {});
  c.on('data', () => {}); // the wrapper streams output to every client; we only write
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (i) await wait(gapMs);
      await new Promise<void>((res, rej) => c.write(chunks[i], 'utf8', (e) => (e ? rej(new PtyGoneError()) : res())));
    }
  } finally { c.destroy(); }
}

export const sendPrompt = (sock: string, text: string, gapMs?: number) => {
  const { body, submit } = typedInput(text);
  if (!body) return Promise.resolve();
  return writePty(sock, [body, submit], gapMs);
};
export const sendEsc = (sock: string) => writePty(sock, [KEY.esc]);
