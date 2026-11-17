import { describe, it, expect } from 'vitest';
import { nativeTerminalCommand, nativeFocusCommand, shellLine } from './nativeTerminal.js';

const only = (...b: string[]) => (x: string) => b.includes(x);

describe('shellLine', () => {
  it('resumes a session', () => expect(shellLine({ cwd: '/p', sessionId: 'abc' })).toBe("claude --resume 'abc'; exit 0"));
  it('starts a new one with a quoted first prompt', () => expect(shellLine({ cwd: '/p', claude: '/o b/claude', prompt: "it's $x" })).toBe("'/o b/claude' 'it'\\''s $x'; exit 0"));
  it('no prompt, no session: plain claude', () => expect(shellLine({ cwd: '/p' })).toBe('claude; exit 0'));
});

describe('nativeTerminalCommand', () => {
  it('Linux: the first installed emulator in order', () => {
    expect(nativeTerminalCommand('linux', { cwd: '/w', sessionId: 's' }, only('konsole', 'xterm'))).toEqual({ file: 'konsole', args: ['--workdir', '/w', '-e', 'bash', '-lc', "claude --resume 's'; exit 0"] });
  });
  it('Linux: emulators without a folder option change folder in the shell line', () => {
    const c = nativeTerminalCommand('linux', { cwd: "/my dir/it's", sessionId: 's' }, only('xterm'))!;
    expect(c.file).toBe('xterm');
    expect(c.args.at(-1)).toBe("cd '/my dir/it'\\''s' && claude --resume 's'; exit 0");
  });
  it('Linux: none installed -> null', () => expect(nativeTerminalCommand('linux', { cwd: '/w' }, () => false)).toBeNull());
  it('macOS: Terminal through osascript, quotes escaped for AppleScript', () => {
    const c = nativeTerminalCommand('darwin', { cwd: '/Users/a b', prompt: 'say "hi"' }, () => false)!;
    expect(c.file).toBe('osascript');
    expect(c.args[1]).toBe(`tell application "Terminal" to do script "cd '/Users/a b' && claude 'say \\"hi\\"'; exit 0"`);
    expect(c.args[3]).toContain('activate');
  });
});

describe('nativeFocusCommand', () => {
  it('Linux prefers wmctrl, then xdotool, else nothing', () => {
    expect(nativeFocusCommand('linux', 'T', only('wmctrl', 'xdotool'))).toEqual({ file: 'wmctrl', args: ['-a', 'T'] });
    expect(nativeFocusCommand('linux', 'T', only('xdotool'))).toEqual({ file: 'xdotool', args: ['search', '--name', 'T', 'windowactivate'] });
    expect(nativeFocusCommand('linux', 'T', () => false)).toBeNull();
  });
  it('macOS searches Terminal windows by title', () => {
    const c = nativeFocusCommand('darwin', 'proj - Claude ab12', () => false)!;
    expect(c.file).toBe('osascript');
    expect(c.args[1]).toContain('(name of w) contains "proj - Claude ab12"');
  });
});
