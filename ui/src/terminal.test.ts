import { describe, it, expect } from 'vitest';
import { terminalCommand } from './terminal.js';

const base = { distro: 'Ubuntu', cwd: '/mnt/c/Мой проект', claude: '/home/v/.local/bin/claude', sessionId: 'abc-123' };

describe('terminalCommand', () => {
  it('opens a new Windows Terminal window running claude --resume in the session folder', () => {
    const c = terminalCommand(base);
    expect(c.file).toBe('wt.exe');
    expect(c.args.slice(0, 3)).toEqual(['-w', 'new', '--']);
    expect(c.args).toEqual(expect.arrayContaining(['wsl.exe', '-d', 'Ubuntu', '--cd', '/mnt/c/Мой проект', '--exec', 'bash', '-lc']));
    // `; exit 0`: when the pet ends the session the shell still exits cleanly, so the terminal window closes itself
    expect(c.args.at(-1)).toBe(`'/home/v/.local/bin/claude' --resume 'abc-123'; exit 0`);
  });
  it('without a known distro it uses the default one', () => {
    expect(terminalCommand({ ...base, distro: '' }).args).not.toContain('-d');
  });
  it('quotes apostrophes; falls back to "claude" on PATH', () => {
    expect(terminalCommand({ ...base, claude: '', sessionId: "a'b" }).args.at(-1)).toBe(`claude --resume 'a'\\''b'; exit 0`);
  });
  it('fallback form runs wsl.exe through cmd start (no Windows Terminal)', () => {
    const c = terminalCommand(base, false);
    expect(c.file).toBe('cmd.exe');
    expect(c.args.slice(0, 4)).toEqual(['/c', 'start', '""', 'wsl.exe']);
  });
});
