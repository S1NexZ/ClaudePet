import { readFile, open } from 'node:fs/promises';
import { summarize } from './summary.js';
import type { ChatItem } from '../../shared/src/types.js';

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      : '';

/** Extracts the visible conversation (user text, assistant text, tool calls) from Claude Code transcript JSONL. */
export function parseTranscript(jsonl: string, limit = 40): ChatItem[] {
  const out: ChatItem[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.isMeta || e?.isSidechain) continue;
    if (e?.type === 'user') {
      const t = textOf(e.message?.content).trim();
      if (t && !t.startsWith('<')) out.push({ role: 'user', text: t });
    } else if (e?.type === 'assistant') {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type === 'text' && b.text?.trim()) out.push({ role: 'assistant', text: b.text.trim() });
        else if (b?.type === 'tool_use') {
          const s = summarize(b.name, b.input);
          out.push({ role: 'tool', text: s ? `${b.name} · ${s}` : String(b.name) });
        }
      }
    }
  }
  return out.slice(-limit);
}

/** Reads a transcript file; anything unreadable or not a .jsonl gives an empty list. */
export async function readTranscript(path: string, limit = 40): Promise<ChatItem[]> {
  if (!path.endsWith('.jsonl')) return [];
  try { return parseTranscript(await readFile(path, 'utf8'), limit); } catch { return []; }
}

/** True if the transcript text has an "[Request interrupted by user...]" entry written at or after `sinceMs` (Esc/Ctrl+C leave no hook, only this line). */
export function hasInterruptSince(text: string, sinceMs: number): boolean {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('[Request interrupted by user')) continue;
    let e: any;
    try { e = JSON.parse(lines[i]); } catch { continue; } // the first line of a tail may be cut
    if (e?.type !== 'user') continue;
    if (!textOf(e.message?.content).startsWith('[Request interrupted by user')) continue;
    const t = Date.parse(e.timestamp);
    return Number.isFinite(t) && t >= sinceMs;
  }
  return false;
}

/** Reads the last 64 KB of a transcript and tells whether the turn was interrupted after `sinceMs`. */
export async function interruptedSince(path: string, sinceMs: number): Promise<boolean> {
  if (!path.endsWith('.jsonl')) return false;
  try {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 65536);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return hasInterruptSince(buf.toString('utf8'), sinceMs);
    } finally { await fh.close(); }
  } catch { return false; }
}

/**
 * The folder a session was started in: the first `cwd` recorded in its transcript (hooks report the CURRENT folder,
 * which changes with every `cd`). Looks only at the first 128 KB; null when there is none.
 */
export async function readOriginalCwd(path: string): Promise<string | null> {
  if (!path.endsWith('.jsonl')) return null;
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(131072);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
        if (!line.includes('"cwd"')) continue;
        try { const c = JSON.parse(line)?.cwd; if (typeof c === 'string' && c.startsWith('/')) return c; } catch { /* a cut or broken line */ }
      }
      return null;
    } finally { await fh.close(); }
  } catch { return null; }
}
