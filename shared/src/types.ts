export type PetState =
  | 'idle' | 'thinking' | 'reading' | 'writing' | 'running' | 'testing'
  | 'waiting' | 'subagent' | 'done' | 'error' | 'sleeping';

export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { is_error?: boolean; [k: string]: unknown };
  message?: string;
}

export interface PendingPermission { id: string; tool: string; summary: string }

export interface Session {
  id: string;
  cwd: string;
  project: string;
  state: PetState;
  since: number;
  lastEventAt: number;
  owned: boolean;
  /** unix socket of the pet-claude.py wrapper this terminal session runs under (the pet can type into it) */
  pty?: string;
  /** folder the session was STARTED in (from its transcript): resuming from any other folder makes Claude Code copy the session. Set once. */
  resumeCwd?: string;
  pendingPermission?: PendingPermission;
}

export interface Snapshot {
  type: 'snapshot';
  sessions: Session[];
  attention: string | null;
}

// ---- revision 2: bridge protocol (JSON lines over stdio) ----
export interface ChatItem { role: 'user' | 'assistant' | 'tool' | 'note'; text: string; streaming?: boolean }

export type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  /** a side answer (/btw) that is not part of the session */
  | { kind: 'note'; text: string }
  | { kind: 'end'; error?: string };

/** How the pet's own chat answers Claude Code's tool permission requests: ask every time / allow file edits / allow everything. */
export type PermissionPolicy = 'ask' | 'edits' | 'all';
export const PERMISSION_POLICIES: readonly PermissionPolicy[] = ['ask', 'edits', 'all'];

export type AppCommand =
  | { type: 'language'; lang: 'ru' | 'en' | 'zh' }
  | { type: 'permission-mode'; mode: PermissionPolicy }
  | { type: 'start'; cwd: string; prompt: string }
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'permission'; id: string; allow: boolean }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'history'; sessionId: string }
  | { type: 'hooks'; apply: boolean }
  | { type: 'models' }
  | { type: 'setModel'; sessionId: string | null; model: string }
  | { type: 'btw'; sessionId: string; text: string }
  | { type: 'release'; sessionId: string }
  | { type: 'end'; sessionId: string }
  | { type: 'usage' };

export type BridgeMessage =
  | Snapshot
  | { type: 'chat'; sessionId: string; event: ChatEvent }
  | { type: 'history'; sessionId: string; items: ChatItem[] }
  | { type: 'started'; sessionId: string }
  | { type: 'hooks'; diff: string; applied: boolean; installed: boolean; stale: boolean }
  | { type: 'models'; models: Array<{ value: string; displayName: string; description: string }> }
  | { type: 'modelSet'; sessionId: string | null; model: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'error'; message: string };

/** One rate-limit window as Claude Code reports it (resetsAt in Unix epoch seconds). */
export interface UsageWindow { usedPct: number; resetsAt: number }
/**
 * Claude subscription limits as last saved by pet-statusline.mjs. Raw data only: staleness / expiry is judged by whoever
 * shows it (it depends on the clock). statusLine: whether Claude Code is set up to feed us.
 */
export interface UsageInfo {
  plan: string | null;
  /** when the shown numbers were last obtained successfully (ms) */
  updatedAt: number | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  statusLine: 'ours' | 'other' | 'none';
  /** where the shown numbers come from: the periodic Claude Code usage query or the statusLine file */
  source?: 'live' | 'statusline' | null;
  /** the periodic query is running (so data older than a few cycles is stale) */
  liveActive?: boolean;
  /** when the last periodic query finished (ms), successful or not */
  lastAttemptAt?: number | null;
  /** why the last periodic query failed; null when it succeeded */
  lastError?: 'timeout' | 'spawn' | 'unsupported' | 'unavailable' | 'invalid' | 'error' | null;
}
