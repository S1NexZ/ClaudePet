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
  /** set on events fired inside a subagent (session_id is the parent's) */
  agent_id?: string;
}

/** One question of Claude's AskUserQuestion tool, as Claude Code sends it */
export interface AskQuestion { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }

/** A tool call waiting for the user: Allow / Deny, or (questions set) Claude's question with its options */
export interface PendingPermission { id: string; tool: string; summary: string; questions?: AskQuestion[] }

/** A message waiting to be typed into a session: after the current turn, or at a time (ms epoch) */
export interface QueuedMessage { id: string; text: string; at?: number }

/** What changed in one turn (from the transcript): shown as a card when Claude finishes */
export interface TurnSummary { files: { path: string; added: number; removed: number }[]; ms: number; tokens: number; tools: number }

/** A short one-off animation of the pet for something that just happened in a session */
export type Reaction = 'happy' | 'sad';

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
  /** exact id of the host that owns it ('windows', 'wsl' = default distro, 'wsl:<distro>'); set by the app when it merges hosts */
  hostId?: string;
  /** the WSL distro of a session that does not run in the default one (set when several distros are followed) */
  distro?: string;
  /** which Claude Code front end started it, from the transcript's `entrypoint` (cli, claude-desktop, vscode, sdk-cli, ...) */
  source?: string;
  /** Stop works through this session's hooks (answered with continue:false at the next tool call); set by hosts with HTTP hooks */
  softStop?: boolean;
  /** subagents of this session running right now (only when there are any) */
  subagents?: number;
  /** the Claude desktop app's id of this session (`local_…`): it is opened in the app with `claude://code/continue?session=<id>` */
  desktopId?: string;
  /** a mailbox waiter is armed: a message sent from the pet is delivered even without a PTY */
  mailbox?: boolean;
  /** the ccPet plugin runs inside this session: messages from the pet go in as the user's own words (no wrapper, no typing into the app) */
  mod?: boolean;
  /** messages the pet will type into this session later (after the turn, or at a time) */
  queue?: QueuedMessage[];
}

export interface Snapshot {
  type: 'snapshot';
  sessions: Session[];
  attention: string | null;
}

// ---- revision 2: bridge protocol (JSON lines over stdio) ----
export interface ChatItem { role: 'user' | 'assistant' | 'tool' | 'note' | 'summary'; text: string; streaming?: boolean; summary?: TurnSummary }

export type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  /** a side answer (/btw) that is not part of the session */
  | { kind: 'note'; text: string }
  /** what the finished turn changed */
  | { kind: 'summary'; summary: TurnSummary }
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
  /** answers: Claude's questions answered (question text -> chosen label(s), several joined with ", ") */
  | { type: 'permission'; id: string; allow: boolean; answers?: Record<string, string> }
  /** queue a message for a session: typed in when the current turn ends, or at `at` (ms epoch) */
  | { type: 'queue'; sessionId: string; text: string; at?: number }
  | { type: 'unqueue'; sessionId: string; id?: string }
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
  | { type: 'usage-refresh' }
  | { type: 'sdk-chats'; on: boolean }
  | { type: 'statusline'; apply?: boolean; remove?: boolean }
  | { type: 'end'; sessionId: string }
  | { type: 'usage' };

export type BridgeMessage =
  | Snapshot
  | { type: 'termMark'; sessionId: string; ok: boolean }
  | { type: 'statusline'; diff: string; applied: boolean; kind: 'none' | 'ours' | 'chained'; error?: string }
  | { type: 'chat'; sessionId: string; event: ChatEvent }
  | { type: 'history'; sessionId: string; items: ChatItem[] }
  | { type: 'started'; sessionId: string }
  | { type: 'hooks'; diff: string; applied: boolean; installed: boolean; stale: boolean; /** installed through Node while the faster native hook is available */ upgrade?: boolean; events?: boolean; mailbox?: boolean; permissions?: boolean; error?: string }
  | { type: 'models'; models: Array<{ value: string; displayName: string; description: string }> }
  | { type: 'modelSet'; sessionId: string | null; model: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'react'; sessionId: string; reaction: Reaction }
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
  /** a manual query (the user clicked the ring) is running right now */
  refreshing?: boolean;
  /** when the last periodic query finished (ms), successful or not */
  lastAttemptAt?: number | null;
  /** why the last periodic query failed; null when it succeeded */
  lastError?: 'timeout' | 'spawn' | 'unsupported' | 'unavailable' | 'invalid' | 'error' | null;
}
