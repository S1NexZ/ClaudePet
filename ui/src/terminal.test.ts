import { describe, it, expect } from 'vitest';
import { terminalCommand, newSessionCommand, windowsTerminalCommand, windowsNewSessionCommand, encodedBash } from './terminal.js';

/** the bash script hidden in the encoded `bash -lc` argument */
const script = (args: string[]) => {
  const m = /^source <\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)$/.exec(args.at(-1)!);
  expect(m).not.toBeNull();
  return Buffer.from(m![1], 'base64').toString('utf8');
};
/** what wt.exe and cmd.exe would choke on: wt splits at every ';', cmd runs & | < > ^ and toggles on '"' */
const RISKY = /[;&^"%]/;

describe('terminalCommand (WSL session in a real terminal)', () => {
  const base = { distro: 'Ubuntu', cwd: '/home/u/my proj', claude: '/home/u/.local/bin/claude', sessionId: 'abc-123' };
  it('Windows Terminal: wsl in the distro, the script resumes the session in its folder', () => {
    const c = terminalCommand(base);
    expect(c.file).toBe('wt.exe');
    expect(c.args.slice(0, 7)).toEqual(['-w', 'new', '--', 'wsl.exe', '-d', 'Ubuntu', '--exec']);
    expect(script(c.args)).toBe(`cd -- '/home/u/my proj' && '/home/u/.local/bin/claude' --resume 'abc-123'\nexit 0\n`);
    expect(c.cwd).toBeUndefined();
  });
  it('no command-line character reaches wt.exe or cmd.exe, whatever the folder or prompt holds', () => {
    const nasty = { ...base, cwd: "/home/u/x; new-tab calc & \"q\" 'it''s' ^%PATH%", sessionId: "a'b" };
    for (const wt of [true, false]) {
      const c = terminalCommand(nasty, wt);
      expect(c.args.filter((a) => a !== '""').join(' ')).not.toMatch(RISKY); // '""' is cmd start's empty window title
      expect(script(c.args)).toContain(`cd -- '/home/u/x; new-tab calc & "q" '\\''it'\\'''\\''s'\\'' ^%PATH%'`);
      const n = newSessionCommand({ distro: '', cwd: '/p', claude: '', prompt: 'fix tests; then commit & push "now"' }, wt);
      expect(n.args.filter((a) => a !== '""').join(' ')).not.toMatch(RISKY);
      expect(script(n.args)).toBe(`cd -- '/p' && claude 'fix tests; then commit & push "now"'\nexit 0\n`);
    }
  });
  it('without Windows Terminal: a plain console through cmd start', () => {
    expect(terminalCommand(base, false).args.slice(0, 4)).toEqual(['/c', 'start', '""', 'wsl.exe']);
    expect(terminalCommand({ ...base, distro: '' }).args).not.toContain('-d');
  });
  it('refuses a distro name that is not a plain token', () => {
    expect(() => terminalCommand({ ...base, distro: 'x;calc' })).toThrow(/unsafe distro/);
  });
});

describe('Windows sessions', () => {
  it('the folder is the process working directory, never an argument (a ; or & in it is harmless)', () => {
    const cwd = 'C:\\Users\\u\\a;b&c';
    expect(windowsTerminalCommand({ cwd, sessionId: 'local_1-2' })).toEqual({ file: 'wt.exe', args: ['-w', 'new', '-d', '.', '--', 'claude', '--resume', 'local_1-2'], cwd });
    expect(windowsNewSessionCommand({ cwd, helper: 'C:\\pet\\pet-helper.exe' })).toEqual({ file: 'wt.exe', args: ['-w', 'new', '-d', '.', '--', 'C:\\pet\\pet-helper.exe', 'pty', 'claude'], cwd });
    expect(windowsNewSessionCommand({ cwd: 'C:\\p' }, false)).toEqual({ file: 'cmd.exe', args: ['/c', 'start', '""', '/D', '.', 'claude'], cwd: 'C:\\p' });
  });
  it('a session id that is not a plain token is refused', () => {
    expect(() => windowsTerminalCommand({ cwd: 'C:\\p', sessionId: 'x&calc' })).toThrow(/unsafe session id/);
  });
  it('encodedBash keeps only base64 characters in the argument', () => {
    expect(encodedBash('a; b & c "d"').at(-1)).toMatch(/^source <\(echo [A-Za-z0-9+/=]+ \| base64 -d\)$/);
  });
});
