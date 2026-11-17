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

describe('newSessionCommand', () => {
  it('starts claude in the folder with an optional first prompt (quoted), in a new Windows Terminal window', async () => {
    const { newSessionCommand } = await import('./terminal.js');
    const c = newSessionCommand({ distro: 'Ubuntu', cwd: '/home/u/p', claude: '/home/u/.local/bin/claude', prompt: "fix it's bug" });
    expect(c.file).toBe('wt.exe');
    expect(c.args.slice(0, 4)).toEqual(['-w', 'new', '--', 'wsl.exe']);
    expect(c.args).toContain('/home/u/p');
    expect(c.args[c.args.length - 1]).toBe(`'/home/u/.local/bin/claude' 'fix it'\\''s bug'; exit 0`);
    expect(newSessionCommand({ distro: '', cwd: '/x', claude: '' }).args.join(' ')).toContain("claude; exit 0");
  });
});
