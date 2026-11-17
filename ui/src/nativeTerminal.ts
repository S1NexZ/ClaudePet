/** Opening and raising terminals on Linux and macOS (the Windows paths live in terminal.ts / focusWindow.ts). Pure: every choice is a function of its inputs. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const asq = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // AppleScript string literal

export interface NativeLaunch { cwd: string; claude?: string; sessionId?: string; prompt?: string }
export type Cmd = { file: string; args: string[] };

/** The shell line a new terminal runs: resume a session, or start a new one with an optional first prompt. */
export function shellLine(o: NativeLaunch): string {
  const bin = o.claude ? sq(o.claude) : 'claude';
  const prompt = (o.prompt ?? '').trim();
  return `${bin}${o.sessionId ? ` --resume ${sq(o.sessionId)}` : prompt ? ` ${sq(prompt)}` : ''}; exit 0`;
}

/** Terminal emulators in the order we try them (the first one installed wins). */
const LINUX_TERMS: Array<{ bin: string; build: (cwd: string, line: string) => string[] }> = [
  { bin: 'x-terminal-emulator', build: (_c, l) => ['-e', 'bash', '-lc', l] },
  { bin: 'gnome-terminal', build: (c, l) => [`--working-directory=${c}`, '--', 'bash', '-lc', l] },
  { bin: 'konsole', build: (c, l) => ['--workdir', c, '-e', 'bash', '-lc', l] },
  { bin: 'xfce4-terminal', build: (c, l) => [`--working-directory=${c}`, '-x', 'bash', '-lc', l] },
  { bin: 'kitty', build: (c, l) => ['--directory', c, 'bash', '-lc', l] },
  { bin: 'alacritty', build: (c, l) => ['--working-directory', c, '-e', 'bash', '-lc', l] },
  { bin: 'xterm', build: (_c, l) => ['-e', 'bash', '-lc', l] },
];

/** The command that opens a terminal running `claude` as described; null when no terminal emulator is installed (Linux). */
export function nativeTerminalCommand(platform: NodeJS.Platform, o: NativeLaunch, has: (bin: string) => boolean): Cmd | null {
  const line = shellLine(o);
  if (platform === 'darwin') {
    const script = `cd ${sq(o.cwd)} && ${line}`;
    return { file: 'osascript', args: ['-e', `tell application "Terminal" to do script ${asq(script)}`, '-e', 'tell application "Terminal" to activate'] };
  }
  for (const t of LINUX_TERMS) {
    if (!has(t.bin)) continue;
    // x-terminal-emulator and xterm take no working-directory option: change folder inside the line
    const inner = t.bin === 'x-terminal-emulator' || t.bin === 'xterm' ? `cd ${sq(o.cwd)} && ${line}` : line;
    return { file: t.bin, args: t.build(o.cwd, inner) };
  }
  return null;
}

/** Raises the terminal window whose title contains `title` (the pet sets it first with an OSC sequence). Best effort: null = nothing to try. */
export function nativeFocusCommand(platform: NodeJS.Platform, title: string, has: (bin: string) => boolean): Cmd | null {
  if (platform === 'darwin') {
    const t = asq(title);
    const script = `tell application "System Events" to set procs to name of every process whose name is "Terminal" or name is "iTerm2"\n` +
      `set found to false\n` +
      `if procs contains "Terminal" then tell application "Terminal"\n` +
      `repeat with w in windows\nif (name of w) contains ${t} then\nset index of w to 1\nactivate\nset found to true\nexit repeat\nend if\nend repeat\nend tell\n` +
      `if found then return "ok"\nreturn "none"`;
    return { file: 'osascript', args: ['-e', script] };
  }
  if (has('wmctrl')) return { file: 'wmctrl', args: ['-a', title] };
  if (has('xdotool')) return { file: 'xdotool', args: ['search', '--name', title, 'windowactivate'] };
  return null;
}
