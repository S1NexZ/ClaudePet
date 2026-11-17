const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * How to open a session in a real terminal: a new Windows Terminal window (or, without it, a plain
 * console via `cmd start`) running `claude --resume <id>` inside WSL, in the session's folder.
 */
/** Opens a Windows-side session (PowerShell / CMD session, desktop app, ...) again in Windows Terminal: `claude --resume <id>` in its folder. */
export function windowsTerminalCommand(o: { cwd: string; sessionId: string }, windowsTerminal = true): { file: string; args: string[] } {
  const run = ['claude', '--resume', o.sessionId];
  return windowsTerminal
    ? { file: 'wt.exe', args: ['-w', 'new', '-d', o.cwd, '--', ...run] }
    : { file: 'cmd.exe', args: ['/c', 'start', '""', '/D', o.cwd, ...run] };
}

export function terminalCommand(
  o: { distro: string; cwd: string; claude: string; sessionId: string },
  windowsTerminal = true,
): { file: string; args: string[] } {
  const wsl = ['wsl.exe', ...(o.distro ? ['-d', o.distro] : []), '--cd', o.cwd, '--exec', 'bash', '-lc',
    `${o.claude ? sq(o.claude) : 'claude'} --resume ${sq(o.sessionId)}; exit 0`];
  return windowsTerminal ? { file: 'wt.exe', args: ['-w', 'new', '--', ...wsl] } : { file: 'cmd.exe', args: ['/c', 'start', '""', ...wsl] };
}

/** A NEW Claude Code session in a real terminal (WSL), in `cwd`, optionally started with a first prompt: what "new chat" does when the Agent SDK paths are off. */
export function newSessionCommand(
  o: { distro: string; cwd: string; claude: string; prompt?: string },
  windowsTerminal = true,
): { file: string; args: string[] } {
  const prompt = (o.prompt ?? '').trim();
  const wsl = ['wsl.exe', ...(o.distro ? ['-d', o.distro] : []), '--cd', o.cwd, '--exec', 'bash', '-lc',
    `${o.claude ? sq(o.claude) : 'claude'}${prompt ? ` ${sq(prompt)}` : ''}; exit 0`];
  return windowsTerminal ? { file: 'wt.exe', args: ['-w', 'new', '--', ...wsl] } : { file: 'cmd.exe', args: ['/c', 'start', '""', ...wsl] };
}

/**
 * A NEW Claude Code session in a Windows terminal, in `cwd`: through the `pet-helper pty` wrapper when there is one (the pet can then type
 * the first prompt into it). The prompt itself never goes on the command line: cmd.exe would interpret & | ^ % in it.
 */
export function windowsNewSessionCommand(o: { cwd: string; helper?: string }, windowsTerminal = true): { file: string; args: string[] } {
  const run = o.helper ? [o.helper, 'pty', 'claude'] : ['claude'];
  return windowsTerminal
    ? { file: 'wt.exe', args: ['-w', 'new', '-d', o.cwd, '--', ...run] }
    : { file: 'cmd.exe', args: ['/c', 'start', '""', '/D', o.cwd, ...run] };
}

const normDir = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** The session a "new chat" on Windows turned into: same folder, appeared after the launch, idle, and typable (has the wrapper's pipe). */
export function matchNewSession(sessions: Array<{ id: string; cwd: string; since: number; pty?: string; state: string; host?: string }>, w: { cwd: string; at: number }): string | null {
  const dir = normDir(w.cwd);
  const hit = sessions.find((s) => s.host === 'windows' && !!s.pty && s.state === 'idle' && s.since >= w.at && normDir(s.cwd) === dir);
  return hit?.id ?? null;
}
