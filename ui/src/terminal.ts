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
