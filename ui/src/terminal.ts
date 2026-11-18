const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * How the pet opens terminals on Windows. Two parsers stand between us and the shell, and both read our arguments their own way:
 *  - Windows Terminal (wt.exe) splits its command line at EVERY ';', even inside quotes (checked live: `-- cmd /c "echo A; B"` runs
 *    `echo A` and treats `B` as a new wt command), so a ';' in a folder or a prompt broke the command or ran something else;
 *  - cmd.exe (the fallback without wt) runs & | < > ^ in any argument Node leaves unquoted (one without spaces: `C:\x&calc`).
 * So no folder, prompt or path ever goes on those command lines: a Windows folder is the spawned process's working directory
 * (`-d .` / `/D .`), and the whole bash script for WSL travels base64-encoded (letters, digits, + / = only).
 */
export interface TerminalLaunch { file: string; args: string[]; /** working directory for the spawned wt.exe / cmd.exe */ cwd?: string }

const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,128}$/;
const safe = (what: string, v: string) => { if (!SAFE_TOKEN.test(v)) throw new Error(`unsafe ${what}: ${JSON.stringify(v)}`); return v; };
/** `bash -lc` that runs `script` without exposing any of its characters to wt.exe or cmd.exe (no quotes, no ';') */
export const encodedBash = (script: string): string[] => ['bash', '-lc', `source <(echo ${Buffer.from(script, 'utf8').toString('base64')} | base64 -d)`];
const wsl = (distro: string, script: string) => ['wsl.exe', ...(distro ? ['-d', safe('distro', distro)] : []), '--exec', ...encodedBash(script)];
const launch = (windowsTerminal: boolean, run: string[], cwd?: string): TerminalLaunch => (windowsTerminal
  ? { file: 'wt.exe', args: ['-w', 'new', ...(cwd ? ['-d', '.'] : []), '--', ...run], ...(cwd ? { cwd } : {}) }
  : { file: 'cmd.exe', args: ['/c', 'start', '""', ...(cwd ? ['/D', '.'] : []), ...run], ...(cwd ? { cwd } : {}) });

/** Opens a Windows-side session (PowerShell / CMD session, desktop app, ...) again in Windows Terminal: `claude --resume <id>` in its folder. */
export function windowsTerminalCommand(o: { cwd: string; sessionId: string }, windowsTerminal = true): TerminalLaunch {
  return launch(windowsTerminal, ['claude', '--resume', safe('session id', o.sessionId)], o.cwd);
}

/** Opens a WSL session in a real terminal: `claude --resume <id>` inside WSL, in the session's folder. */
export function terminalCommand(o: { distro: string; cwd: string; claude: string; sessionId: string }, windowsTerminal = true): TerminalLaunch {
  return launch(windowsTerminal, wsl(o.distro, `cd -- ${sq(o.cwd)} && ${o.claude ? sq(o.claude) : 'claude'} --resume ${sq(o.sessionId)}\nexit 0\n`));
}

/** A NEW Claude Code session in a real terminal (WSL), in `cwd`, optionally started with a first prompt: what "new chat" does when the Agent SDK paths are off. */
export function newSessionCommand(o: { distro: string; cwd: string; claude: string; prompt?: string }, windowsTerminal = true): TerminalLaunch {
  const prompt = (o.prompt ?? '').trim();
  return launch(windowsTerminal, wsl(o.distro, `cd -- ${sq(o.cwd)} && ${o.claude ? sq(o.claude) : 'claude'}${prompt ? ` ${sq(prompt)}` : ''}\nexit 0\n`));
}

/**
 * A NEW Claude Code session in a Windows terminal, in `cwd`: through the `pet-helper pty` wrapper when there is one (the pet can then type
 * the first prompt into it). The prompt itself never goes on the command line.
 */
export function windowsNewSessionCommand(o: { cwd: string; helper?: string }, windowsTerminal = true): TerminalLaunch {
  return launch(windowsTerminal, o.helper ? [o.helper, 'pty', 'claude'] : ['claude'], o.cwd);
}

const normDir = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** The session a "new chat" on Windows turned into: same folder, appeared after the launch, idle, and typable (has the wrapper's pipe). */
export function matchNewSession(sessions: Array<{ id: string; cwd: string; since: number; pty?: string; state: string; host?: string }>, w: { cwd: string; at: number; known: string[] }): string | null {
  const dir = normDir(w.cwd);
  // `since` is the last state change, not the start: sessions that existed at launch are excluded by id
  const hit = sessions.find((s) => s.host === 'windows' && !!s.pty && s.state === 'idle' && s.since >= w.at && !w.known.includes(s.id) && normDir(s.cwd) === dir);
  return hit?.id ?? null;
}
