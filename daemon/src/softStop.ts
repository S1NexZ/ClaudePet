import type { HookPayload } from './hookSocket.js';
import { L } from '../../shared/src/i18n.js';

/** Hook output that makes Claude Code stop (documented `continue: false`; PreToolUse also denies the pending tool). */
export type HookReply = Record<string, unknown>;

export interface SoftStop {
  /** the user pressed Stop: answer this session's next tool hook with "stop" */
  request(sessionId: string, now: number): void;
  pending(sessionId: string, now?: number): boolean;
  /** the answer to send back for this hook event, or null (no opinion) */
  reply(e: HookPayload, now: number): HookReply | null;
}

/** Events after which a pending stop is pointless (the turn is over) or wrong (a new turn started). */
const TURN_OVER = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd']);

/**
 * Stop for sessions the pet cannot press Esc in (the desktop app, IDEs, plain Windows terminals): Claude Code's own hooks may answer
 * `{"continue": false}`, which ends the turn after the current step. So Stop takes effect at the next tool call, not mid-sentence.
 */
export function createSoftStop(ttlMs = 10 * 60_000, onStopped?: (sessionId: string) => void): SoftStop {
  const asked = new Map<string, number>();
  const live = (id: string, now: number) => {
    const at = asked.get(id);
    if (at === undefined) return false;
    if (now - at > ttlMs) { asked.delete(id); return false; }
    return true;
  };
  return {
    request(id, now) { asked.set(id, now); },
    pending(id, now = Date.now()) { return live(id, now); },
    reply(e, now) {
      const id = e.session_id;
      if (TURN_OVER.has(e.hook_event_name)) { asked.delete(id); return null; }
      if (e.hook_event_name !== 'PreToolUse' && e.hook_event_name !== 'PostToolUse') return null;
      if (!live(id, now)) return null;
      asked.delete(id);
      const reason = L('Остановлено из ccPet', 'Stopped from ccPet', '已从 ccPet 停止');
      onStopped?.(id);
      if (e.hook_event_name === 'PreToolUse') {
        return { continue: false, stopReason: reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
      }
      return { continue: false, stopReason: reason };
    },
  };
}
