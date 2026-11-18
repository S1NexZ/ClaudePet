import type { ChatEvent, ChatItem } from '../../../shared/src/types.js';

const closeStream = (items: ChatItem[]): ChatItem[] => {
  const last = items.at(-1);
  return last?.streaming ? [...items.slice(0, -1), { role: last.role, text: last.text }] : items;
};

/** Pure reducer: applies one bridge chat event to a session's message list. */
export function applyChat(items: ChatItem[], e: ChatEvent): ChatItem[] {
  const last = items.at(-1);
  const streaming = last?.role === 'assistant' && last.streaming;
  switch (e.kind) {
    case 'user': return [...closeStream(items), { role: 'user', text: e.text }];
    case 'delta':
      return streaming
        ? [...items.slice(0, -1), { ...last!, text: last!.text + e.text }]
        : [...items, { role: 'assistant', text: e.text, streaming: true }];
    case 'assistant':
      return streaming ? [...items.slice(0, -1), { role: 'assistant', text: e.text }] : [...items, { role: 'assistant', text: e.text }];
    case 'tool': return [...closeStream(items), { role: 'tool', text: e.summary ? `${e.name} · ${e.summary}` : e.name }];
    // a side answer goes just before a reply that is still streaming, so that reply keeps growing in place
    case 'note': return streaming ? [...items.slice(0, -1), { role: 'note', text: e.text }, last!] : [...items, { role: 'note', text: e.text }];
    case 'summary': return [...closeStream(items), { role: 'summary', text: '', summary: e.summary }];
    case 'end': {
      const closed = closeStream(items);
      return e.error ? [...closed, { role: 'tool', text: `⚠ ${e.error}` }] : closed;
    }
  }
}

/**
 * Transcript history is authoritative for the conversation itself; what only the pet knows (a /btw question
 * and its note: they live in a throwaway fork, not in the transcript) is kept after it. A reply that is
 * streaming right now is left alone.
 */
export function mergeHistory(current: ChatItem[] | undefined, history: ChatItem[]): ChatItem[] {
  if (current?.at(-1)?.streaming) return current;
  const kept = (current ?? []).filter((x) => x.role === 'note' || (x.role === 'user' && x.text.startsWith('/btw ')));
  return [...history, ...kept];
}
