# ccPet — developer notes (also read by Claude Code sessions working on this repo)

ccPet is a Windows (Electron) desktop pet for Claude Code sessions running in WSL: it shows what the sessions do, has a chat, shares one live
session with the terminal through a PTY wrapper, and shows subscription usage limits. User-facing docs are in `README.md` (Russian); this file is for developers.
Chat language with the project owner: Russian (code and comments may be English). The source of truth is the code, not these notes.

## Working rules
- Keep outputs short; do not re-read whole files (`git log --oneline | head`, `docs/design.md`, targeted reads/grep).
- Real interactive `claude` runs cost the user's limit: only when asked, with short prompts (`Reply with exactly: …`).
- Never change the user's configuration (`~/.claude/settings.json`, `~/.bashrc`, `~/.profile`, `~/.claude.json`) without explicit consent (show a diff, back up first).
- Never touch or kill the user's running Claude Code sessions; end only processes you started, by exact PID (no `pkill -f` with a pattern that matches your own command).
- Do not add background processes, do not expose tokens/credentials/personal data (for `~/.claude.json` inspect structure only, never values).
- Do not delete temporary files or test artifacts without permission. Do not weaken existing features (UI, animations, hotkey, PTY, SDK fallback).
- Never claim something was tested when it was not; keep verified behaviour and assumptions apart.
- Commits end with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` line naming the model that wrote them. Do not push or publish without the owner's approval.

## Environment
- Develop in WSL; Node: `export PATH=$HOME/.local/node/bin:$PATH` (per command). Root is an npm workspace (`shared`, `daemon`, `hook`); `ui/` is a separate package.
  Install `ui/` dependencies from a **Windows** terminal (`cd ui && npm install`) when you need to build the installer, so electron-builder gets Windows shims.
- No gcc/make in WSL (native modules cannot be built).
- Inside a Claude Code session the env has `CLAUDECODE`/`CLAUDE_CODE_*`: the `claude` shell function then bypasses the wrapper and a child `claude` does not save transcripts;
  simulate a user terminal with `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION …`.

## Architecture
Windows Electron (`ui/`) starts the bridge in WSL through `wsl.exe` (JSON lines on stdio). Bridge: `daemon/src/bridgeMain.ts` → `build/bridge/bridge.cjs`. Claude Code hooks (`hook/pet-hook.mjs`) send events to the unix socket `~/.claude-pet/hook.sock`.
Closing the pet never kills Claude Code (the bridge exits on stdin EOF).
- `daemon/src/`: `bridge.ts` (commands, sending, interrupt), `sessionStore.ts`, `mapEvent.ts`, `hookSocket.ts`, `ptySend.ts`, `runner.ts` (SDK fallback), `transcript.ts`, `usage.ts`, `usageLive.ts`, `installHooks.ts`, `installStatusLine.ts`, `cli.ts`.
- `shared/src/types.ts`: bridge command/message types.
- `ui/src/`: `main.ts` (window, tray, hotkey, IPC, dialogs), `settings.ts`, `appearance.ts`, `dialogs.ts`, `models/` (registry, zip, install, images), `sprite/` (loader, animator, cell cleanup, `fringe.ts`), `renderer/` (`app.ts`, `settingsPanel.ts`, `modelsTab.ts`, `usage.ts`, `compose.ts`, `chatStore.ts`, …).
- `scripts/`: `pet-claude.py` (PTY wrapper), `install-shell-integration.sh` (guided `~/.bashrc` block), `start.sh`, `pet.sh`, `anim-test.sh`, tests `test-pet-claude.py`, `test-shell-integration.py`.
- `models/claude-maiden/`: the bundled default pet (third-party asset, see `THIRD_PARTY_NOTICES.md`). Clawd was removed in 0.5.0 (Anthropic's mascot); a saved `clawd` choice falls back to the default. User models live in `%APPDATA%\ccPet\models`.

### Claude Code integration
- 0.5.0 Windows/desktop: `ui/src/hub/desktopRegistry.ts` (desktop app session registry: id/title/archive only; `claude://code/continue?session=local_…`), `daemon/src/softStop.ts` (Stop via `continue:false` hook answers for sessions without a PTY), `pet-helper.exe statusline` / `wait` (reports `cwd`, `CLAUDE_CODE_ENTRYPOINT`, retries while the pet is down, skips one-shot `claude -p`), `ui/src/psProfile.ts` (PowerShell profile wrapper block), `ui/src/diagnostics.ts` (redacted connection report).
- **PTY wrapper** `scripts/pet-claude.py` runs `claude` as one process on a PTY; the terminal and clients of `~/.claude-pet/pty/<wrapper pid>.sock` (dir 0700, socket 0600) share one PTY. The hook adds `pet_pty` (from `PET_PTY_SOCK`) to events; `SessionEnd` clears it. If `claude` is not on PATH it falls back to `~/.local/bin/claude`.
- **Sending** (`bridge.ts`): a session with `pty` that is not `owned` gets the text typed into the same process (300 ms before Enter, bracketed paste for multi-line, control characters stripped); refused while Claude is busy; a dead socket falls back to the SDK.
  Fallback = SDK `resume` (`runner.ts`): a second process, the user gets a warning dialog first. It resumes in `resumeCwd` (the folder the session was started in, read once from the transcript) because resuming from another folder makes Claude Code copy the session; a different session id in `system:init` aborts the attempt.
- **Interrupt**: the Stop button types Esc into the PTY and marks the session idle. Esc/Ctrl+C typed in the terminal produce no hook: the bridge tick (1.5 s) looks for `[Request interrupted by user` in the transcript tail. History is re-read 700 ms after Stop / prompt / Esc.
- **Confirmation dialogs** (`ui/src/dialogs.ts`): safe button first and default, `noLink: true` (measured: with command links and `defaultId === cancelId`, Enter picked the action).

### Universal integration (Windows host, mailbox)
Windows terminals and the Claude desktop app are served by a **Windows host** inside Electron main (`ui/src/hub/windowsHost.ts`: the same transport-free `createBridge` with `mailboxOnly`, fed by Claude Code `http` hooks on `127.0.0.1:47821`; the WSL bridge has its own receiver on `47822`, port/token in `~/.claude-pet/hub.json`). `ui/src/hub/merge.ts` merges the host snapshots (sessions carry `host`, `source`, `mailbox`) and routes commands by session id. Hook entries live next to the user's own ones in `settings.json` and are recognised by URL / command, never by extra keys (`daemon/src/hookConfig.ts`); install/remove always shows the diff and keeps a `.bak` (Settings → Connections).
**Mailbox** (`daemon/src/mailbox.ts`, `hookHttp.ts`): a background `asyncRewake` command hook (`pet-helper.exe wait` on Windows, `pet-hook.mjs wait` in WSL) long-polls `/mailbox/<token>/<session>`; a message makes it exit 2 and Claude Code wakes even an idle session with the stderr text (marker `[ccPet message]`, shown as the user's message by `transcript.ts`). One-shot: re-armed on `Stop`; a second waiter gets 409. `PermissionRequest` answers (opt-in) go through the same receiver.
`pet-helper.exe` is built from `helper/PetHelper.cs` by `scripts/build-helper.mjs` (.NET Framework `csc.exe`, run by `npm run dist`).

**Several WSL distros** (`ui/src/hub/wslHost.ts`): one bridge process per followed distro (`createWslHost`), host ids `wsl` (default distro, owns usage/models/new chats) and `wsl:<name>`; WSL 2 distros share one network namespace, so a secondary bridge gets its own `CLAUDE_PET_HOOK_PORT` (47900-47999, `portForDistro`) and no usage poller. Discovery: `wsl.exe -l -v` every 30 s, only *running* distros (we never start one).
**Windows PTY wrapper**: `pet-helper.exe pty <cmd>` runs the command on a ConPTY and serves `\\.\pipe\claude-pet-<pid>` (duplex, ACL = current user; exported as `PET_PTY_SOCK`). Its mailbox waiter adds `?pty=<pipe>` to the long-poll; `hookHttp` validates the name (`PIPE_NAME`) and `windowsHost` sets `session.pty`, after which the bridge's existing PTY path (`ptySend.ts`: typed text, Esc) works over the pipe.
**Open in terminal** (`ui/src/focusWindow.ts`): `term-mark` makes the bridge write an OSC title to the claude process's tty, then PowerShell finds the window (or the Windows Terminal tab, via UI Automation) with that title and raises it; no live terminal = `claude --resume` in a new window.

### Usage limits
`daemon/src/usageLive.ts`: experimental SDK method `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (`get_usage`), one short-lived `claude` process per request (no prompt, `persistSession:false`, `settingSources:[]`, `skipBehaviors:true`, env without `CLAUDE_*`/`ANTHROPIC_*`, cwd `~/.claude-pet/usage-query`). **No timer**: the poller is never `start()`ed; `refresh()` (bridge command `usage-refresh`, sent when the user opens the panel by clicking the ring) runs one query, never overlapping, at most one per 60 s, 25 s timeout, last good data kept on failure (`CLAUDE_PET_LIVE_USAGE=0` removes it).
Background source: Claude Code's `statusLine` → `hook/pet-statusline.mjs` → `~/.claude-pet/usage.json` (the bridge compares its mtime). Installed from Settings → Connections (bridge command `statusline`, `installStatusLine.ts`: diff + `.bak`; a foreign statusLine is wrapped with `--chain <base64>` and restored on removal).
Display logic: `ui/src/renderer/usage.ts` (stale after a failed request or 15 min).

### Models and settings
Models are Codex-format packs (`pet.json` + 1536×1872 sheet, 8×9 cells of 192×208). `ui/src/models/zip.ts` reads ZIPs in memory with strict checks; `install.ts` validates, installs atomically and never overwrites. Settings (`ui/src/settings.ts`): autostart, notify, hotkey, active model, appearance colors (`#rrggbb`).
The renderer can switch models without a restart (`loadSprite` in `app.ts`).

## Build and test (verified)
```
export PATH=$HOME/.local/node/bin:$PATH
npm install && (cd ui && npm install)
npm run build          # bridge + UI bundles
npm test               # Vitest
npm run test:py        # PTY wrapper + shell integration checks
npx tsc --noEmit -p .  # 2 known errors in ui/src/sprite/loadPet.test.ts (import.meta in a test), harmless
npm run dist           # build + installer: ui/release/ccPet-Setup-<version>.exe (run from WSL; uses cmd.exe)
```
Run the installer normally (one-click NSIS, per-user, installs to `%LOCALAPPDATA%\Programs\claude-pet` and starts the app); `/S` hung in earlier tests.
To test the real UI: start `ccPet.exe --remote-debugging-port=9333` (listens on Windows localhost only; drive it with Windows `node.exe`); `--user-data-dir=<dir>` gives a clean profile.

## Decisions (do not revisit without a reason)
- The Agent SDK cannot attach to a running `claude`; tmux/reptyr do not work (ptrace_scope=1); `messagingSocketPath` in `~/.claude/sessions` is undocumented and not a user-input channel.
- A stdlib-Python PTY wrapper was chosen (node-pty needs a compiler).
- Usage limits: no private endpoints, no reading OAuth tokens, no scraping; the Admin/Usage API needs an organization key and has no Pro plan windows.
- Character packs that are not ours are third-party assets: Miku and Clawd are never tracked in this repository (Clawd is Anthropic's mascot); Claude-maiden ships with attribution.

## Known limitations
Esc typed in the first seconds of a turn (while `UserPromptSubmit` hooks run) may be ignored by Claude Code; `get_usage` is experimental; tray menu is not automatically tested.
