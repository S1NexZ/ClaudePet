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

describe('windowsNewSessionCommand', () => {
  it('starts claude through the wrapper in the folder; the first prompt is never put on the command line (cmd.exe would parse it)', async () => {
    const { windowsNewSessionCommand } = await import('./terminal.js');
    const c = windowsNewSessionCommand({ cwd: 'C:\\Users\\u\\p', helper: 'C:\\pet\\pet-helper.exe' });
    expect(c).toEqual({ file: 'wt.exe', args: ['-w', 'new', '-d', 'C:\\Users\\u\\p', '--', 'C:\\pet\\pet-helper.exe', 'pty', 'claude'] });
    expect(windowsNewSessionCommand({ cwd: 'C:\\p' }, false)).toEqual({ file: 'cmd.exe', args: ['/c', 'start', '""', '/D', 'C:\\p', 'claude'] });
  });
});

describe('matchNewSession (the first prompt waits for the new Windows session to appear)', () => {
  it('a typable session in the same folder (case and slashes do not matter) that started after the launch', async () => {
    const { matchNewSession } = await import('./terminal.js');
    const s = (id: string, cwd: string, at: number, pty = '\\\\.\\pipe\\claude-pet-1', state = 'idle') => ({ id, cwd, lastEventAt: at, since: at, pty, state, host: 'windows' });
    const w = { cwd: 'C:\\Users\\U\\proj\\', at: 1000, known: ['old', 'busyold'] };
    expect(matchNewSession([s('old', 'C:\\Users\\u\\proj', 500), s('new', 'c:/users/u/proj', 1500)], w)).toBe('new');
    expect(matchNewSession([s('np', 'C:\\Users\\u\\proj', 1500, '')], w)).toBeNull();
    expect(matchNewSession([s('other', 'C:\\x', 1500)], w)).toBeNull();
    expect(matchNewSession([s('busy', 'C:\\Users\\u\\proj', 1500, 'p', 'thinking')], w)).toBeNull();
  });
  it('a session that already existed at launch never takes the prompt, even when it turns idle afterwards', async () => {
    const { matchNewSession } = await import('./terminal.js');
    const s = (id: string, since: number) => ({ id, cwd: 'C:\\p', lastEventAt: since, since, pty: 'x', state: 'idle', host: 'windows' });
    expect(matchNewSession([s('busyold', 2000)], { cwd: 'C:\\p', at: 1000, known: ['busyold'] })).toBeNull();
    expect(matchNewSession([s('busyold', 2000), s('fresh', 2500)], { cwd: 'C:\\p', at: 1000, known: ['busyold'] })).toBe('fresh');
  });
});

