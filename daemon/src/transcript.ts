import { open } from 'node:fs/promises';
import { summarize } from './summary.js';
import type { ChatItem, TurnSummary } from '../../shared/src/types.js';

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      : '';

/** A message the pet delivered through the mailbox arrives as a hook-feedback record: this marker precedes the user's own text. */
/** The marker our mailbox messages carry; messages written by older versions ("Claude Pet") are still recognised. */
export const PET_MARKER = '[ccPet message]';
const LEGACY_MARKER = '[Claude Pet message]';
export const petMessageOf = (t: string): string | null => {
  const m = /\[(?:ccPet|Claude Pet) message\]\s*([\s\S]*?)\s*(?:<\/system-reminder>|$)/.exec(t);
  return m && m[1] ? m[1] : null;
};

/** Which Claude Code front end wrote a transcript (`entrypoint` of its first records: cli, claude-desktop, sdk-cli, vscode, ...). */
export async function readEntrypoint(path: string): Promise<string | null> {
  if (!path.endsWith('.jsonl')) return null;
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 40)) {
        const m = /"entrypoint":"([\w-]+)"/.exec(line);
        if (m) return m[1];
      }
    } finally { await fh.close(); }
  } catch { /* unreadable: unknown */ }
  return null;
}

const lineCount = (v: unknown): number => (typeof v === 'string' && v.length ? v.replace(/\n$/, '').split('\n').length : 0);

/** Lines added / removed by one file-editing tool call (Edit, MultiEdit, Write); null for other tools. */
export function editStats(name: string, input: any): { path: string; added: number; removed: number } | null {
  const path = typeof input?.file_path === 'string' ? input.file_path : typeof input?.notebook_path === 'string' ? input.notebook_path : null;
  if (!path) return null;
  if (name === 'Edit') return { path, added: lineCount(input.new_string), removed: lineCount(input.old_string) };
  if (name === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.reduce((a: any, x: any) => ({ path, added: a.added + lineCount(x?.new_string), removed: a.removed + lineCount(x?.old_string) }), { path, added: 0, removed: 0 });
  if (name === 'Write') return { path, added: lineCount(input.content), removed: 0 };
  if (name === 'NotebookEdit') return { path, added: lineCount(input.new_source), removed: 0 };
  return null;
}

/**
 * Extracts the visible conversation (user text, assistant text, tool calls) from Claude Code transcript JSONL. A turn that changed
 * files and has finished is followed by a 'summary' item: files with +/- lines, how long it took, output tokens, tool calls.
 */
export function parseTranscript(jsonl: string, limit = 40): ChatItem[] {
  const out: ChatItem[] = [];
  type Turn = { start: number; end: number; files: Map<string, { path: string; added: number; removed: number }>; tokens: Map<string, number>; tools: number; done: boolean };
  let turn = null as Turn | null; // assigned inside the helpers below: the cast keeps TypeScript from narrowing it to null
  const closeTurn = () => {
    if (turn && turn.files.size) {
      const summary: TurnSummary = { files: [...turn.files.values()], ms: Math.max(0, turn.end - turn.start), tokens: [...turn.tokens.values()].reduce((a, b) => a + b, 0), tools: turn.tools };
      out.push({ role: 'summary', text: '', summary });
    }
    turn = null;
  };
  const prompt = (e: any, text: string) => {
    closeTurn();
    out.push({ role: 'user', text });
    const t = Date.parse(e.timestamp);
    turn = { start: t, end: t, files: new Map(), tokens: new Map(), tools: 0, done: false };
  };
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.isMeta || e?.isSidechain) continue;
    if (e?.type === 'user') {
      const t = textOf(e.message?.content).trim();
      if (t && !t.startsWith('<')) prompt(e, t);
      else if (t.includes(PET_MARKER) || t.includes(LEGACY_MARKER)) { const m = petMessageOf(t); if (m) prompt(e, m); }
    } else if (e?.type === 'assistant') {
      let tooled = false;
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type === 'text' && b.text?.trim()) out.push({ role: 'assistant', text: b.text.trim() });
        else if (b?.type === 'tool_use') {
          tooled = true;
          const s = summarize(b.name, b.input);
          out.push({ role: 'tool', text: s ? `${b.name} · ${s}` : String(b.name) });
          if (turn) {
            turn.tools++;
            const st = editStats(String(b.name), b.input);
            if (st) { const f = turn.files.get(st.path); turn.files.set(st.path, f ? { path: st.path, added: f.added + st.added, removed: f.removed + st.removed } : st); }
          }
        }
      }
      if (turn) {
        const t = Date.parse(e.timestamp);
        if (Number.isFinite(t)) turn.end = t;
        // one API message is written as several records (one per content block) with the same usage: count it once
        const tok = Number(e.message?.usage?.output_tokens);
        if (Number.isFinite(tok)) turn.tokens.set(String(e.message?.id ?? turn.tokens.size), tok);
        // the final answer may span several records (thinking, then text): the card goes after the last of them
        turn.done = e.message?.stop_reason === 'end_turn' && !tooled;
      }
    }
  }
  if (turn?.done) closeTurn();
  const items = out.slice(-limit);
  // a cut-off head may start with the summary of a turn whose prompt fell outside the window: it would hang there alone
  while (items[0]?.role === 'summary') items.shift();
  return items;
}

/**
 * Reads the end of a transcript file; anything unreadable or not a .jsonl gives an empty list. Long sessions grow to tens of MB and only
 * the last `limit` items are shown: the tail is read first (256 KB) and widened only while it holds too few items.
 */
export async function readTranscript(path: string, limit = 40, firstChunk = 256 * 1024): Promise<ChatItem[]> {
  if (!path.endsWith('.jsonl')) return [];
  try {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      for (let len = Math.min(size, firstChunk); ; len = Math.min(size, len * 4)) {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        let text = buf.toString('utf8');
        if (len < size) text = text.slice(text.indexOf('\n') + 1); // the first line of a tail is usually cut
        const items = parseTranscript(text, limit);
        if (items.length >= limit || len >= size) return items;
      }
    } finally { await fh.close(); }
  } catch { return []; }
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
