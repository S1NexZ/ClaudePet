# ccPet — design

Date: 2026-11-15 · Status: awaiting approval

## Intent and why
The user works with Claude Code in a WSL terminal on Windows and is tired of Alt+Tab to see whether Claude has answered. They want a desktop companion ("Codex pet, but maxed out") that:
1. shows, at a glance, what Claude Code is doing right now (thinking, reading, writing, running tests, waiting for permission, done, error…);
2. lets them reply, start a new task, pick a folder and launch Claude Code there, without returning to the terminal.

## Goals
- Always-on-top, frameless, transparent window: animated sprite above a dark rounded pill bar (look of the two reference screenshots).
- Live status for ALL Claude Code sessions, including ones started by hand in a terminal.
- Chat/task input; start sessions in any folder; continue an idle session; approve/deny permission requests from the pet.
- Sprite is swappable: the user supplies their own art, no code changes.

## Non-goals / anti-goals
- Not a terminal replacement; no keystroke injection into a live interactive TUI.
- No model selection or hosting: Claude Code does that itself.
- No cloud, no accounts, nothing leaves localhost.
- Must NOT copy OpenAI's Codex pet character or assets.
- Anti-goal: if status lags or lies (shows "thinking" when Claude finished), the app has failed, even if everything else works.

## Constraints
- Windows 11 + WSL2 (Linux 6.18, bash). Claude Code runs inside WSL.
- Directory: the project folder (any location; releases are built from a normal checkout).
- Must not modify ~/.claude/settings.json without showing the change and getting consent.

## Approaches considered
- A. Hooks only (observer): accurate status, zero reply ability. Rejected as the end state, kept as step 1.
- B. Pet owns all sessions (SDK / stream-json): full control, but loses the user's terminal workflow and can't see manual sessions.
- **C. Hybrid (chosen by the user):** hooks for status of every session + pet-owned sessions for chat/launch + `--resume` to continue an idle session. Collision rule: the pet only sends into a session that is idle.

## Design (decided parts)
**Look (user-decided, from screenshots):** collapsed = sprite + pill with two icons (new task, activity). Expanded = pill with "+" button, text field (placeholder "Начать новый чат" / "Ответить в <project>…"), round send button. Draggable, remembers position.
**Look (updated 2026-11-15, user asked to reconcile Miku with Claude style):** Codex-like dark translucent glass pill. Primary accent = Miku teal (~#39C5BB, sampled from the sprite) for send button, focus ring, progress. Claude terracotta (~#D97757) is reserved for "needs attention" only: permission-wait badge, error, unread-done dot, plus a small Claude mark. Serif font for the status line. Light theme later.

**Architecture (my calls):**
- `daemon` (Node, runs in WSL): HTTP endpoint for hooks, WebSocket for the UI, session manager, state machine. Core logic lives here because hooks and `claude` are native to WSL.
- `ui` (Electron, runs on Windows): thin client connecting to `ws://localhost:<port>` (WSL2 forwards localhost to Windows).
- `hook script` (tiny shell/node): posts the hook event JSON to the daemon, exits fast, never blocks Claude Code, silent if the daemon is down.
- `pet install-hooks`: prints the exact `settings.json` diff and applies it only after confirmation.

**Status model:** events UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, SessionStart/End map to states: idle, thinking, reading/exploring, writing/editing, running command, testing (Bash matching test runners), waiting for permission, subagent working, done, error, sleeping. Each session is tracked by session id + folder; the pet shows the most "attention-worthy" one and lets the user switch.

**Pet-owned sessions:** launched via the Claude Agent SDK (fallback: `claude -p --output-format stream-json`) in a chosen folder; permission requests surface as Allow/Deny buttons; continuing uses the session id.

**Sprites (updated 2026-11-15, user-decided):** the pet is "Shy Miku", supplied by the user as `shy-miku.codex-pet.zip` (a Codex pet pack: `pet.json` + `spritesheet.webp`), copied to `sprites/shy-miku/`. The app reads the Codex pet format natively, so any other Codex pet pack also works. Format: lossless WebP atlas 1536×1872 = 8 columns × 9 rows of 192×208 cells, transparent. Rows (frames): 0 idle (6), 1 run-right (8), 2 run-left (8), 3 wave (4), 4 jump (5), 5 failed (8), 6 waiting (6), 7 working (6), 8 review (6).
State → row mapping (my guess from the pictures, editable in one config; the user should eyeball it):
- idle, sleeping → row 0 (sleeping: last frames of row 5 curled up, or idle slowed)
- thinking, writing/editing, running command → row 7
- reading/exploring, testing, review → row 8
- waiting for permission / needs input → row 6
- done → row 3 (wave) then row 4 (jump) on success
- error → row 5
- subagent working, window being dragged → rows 1/2 (run right/left)
Missing frames fall back to idle. Miku is Crypton's character and the pack is the user's own fan asset: kept local for personal use, not for redistribution. No placeholder needed anymore.

## Build order
1. Daemon + hook script + status-only UI (Approach A value).
2. Pill input, new session in a folder, chat with permission buttons.
3. Resume idle sessions, multi-session switcher, polish, themes.

## Left to the builder
Exact ports, SDK vs stream-json choice after checking the current SDK, animation timing, tray icon, autostart, test-runner detection patterns.

## Revision 2 (2026-11-16): direct client, real chat, installer — user-decided
The user wants no "local site": the pet must talk to them and to Claude Code directly, and be a real Windows app.
- **No TCP/HTTP/WebSocket at all.** The Electron main process spawns one `bridge` process inside WSL (`wsl.exe … node bridge.cjs`) and talks to it over stdin/stdout JSON lines. Renderer ↔ main uses Electron IPC.
- **Hooks** reach the bridge through a unix socket (`~/.claude-pet/hook.sock`); when the app is closed the hook silently does nothing.
- **Chat:** pet-owned sessions are persistent SDK sessions (streaming input), so follow-ups answer without a process start; replies stream into a chat panel; tool calls show as chips; Stop interrupts. Terminal sessions show their last messages from the transcript file named in the hook payload.
- **App:** NSIS installer via electron-builder; bridge, hook script and sprites ship as resources; hooks are installed from the tray menu with a confirmation dialog.
- Removed: daemon HTTP/WS server, ws client, origin checks (no network surface left).
