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
  /** where the session runs: 'wsl' (the WSL bridge) or 'windows' (the Windows host); set by the app when it merges hosts */
  host?: 'wsl' | 'windows';
  /** the WSL distro of a session that does not run in the default one (set when several distros are followed) */
  distro?: string;
  /** which Claude Code front end started it, from the transcript's `entrypoint` (cli, claude-desktop, vscode, sdk-cli, ...) */
  source?: string;
  /** a mailbox waiter is armed: a message sent from the pet is delivered even without a PTY */
  mailbox?: boolean;
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
  /** answer Claude Code's PermissionRequest hook through the pet (WSL bridge; the Windows host reads the setting directly) */
  | { type: 'hook-permissions'; on: boolean }
  | { type: 'start'; cwd: string; prompt: string }
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'permission'; id: string; allow: boolean }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'history'; sessionId: string }
  /** apply=false: report the plan; apply=true: write it (after the app got consent); remove: take our entries out; permissions: include the PermissionRequest hook (default: the current setting) */
  | { type: 'hooks'; apply: boolean; permissions?: boolean; remove?: boolean }
  | { type: 'models' }
  | { type: 'setModel'; sessionId: string | null; model: string }
  | { type: 'btw'; sessionId: string; text: string }
  | { type: 'release'; sessionId: string }
  | { type: 'dismiss'; sessionId: string }
  | { type: 'term-mark'; sessionId: string; text: string }
  | { type: 'end'; sessionId: string }
  | { type: 'usage' };

export type BridgeMessage =
  | Snapshot
  | { type: 'termMark'; sessionId: string; ok: boolean }
  | { type: 'chat'; sessionId: string; event: ChatEvent }
  | { type: 'history'; sessionId: string; items: ChatItem[] }
  | { type: 'started'; sessionId: string }
  | { type: 'hooks'; diff: string; applied: boolean; installed: boolean; stale: boolean; events?: boolean; mailbox?: boolean; permissions?: boolean; error?: string }
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
