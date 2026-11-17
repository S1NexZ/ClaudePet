import { describe, it, expect } from 'vitest';
import { redact, formatDiagnostics, lastEventByHost, ago } from './diagnostics.js';

describe('diagnostics report', () => {
  it('redacts the user name from paths (Windows, WSL, UNC) and drops anything token-like', () => {
    expect(redact('C:\\Users\\vasya\\AppData\\x', ['vasya'])).toBe('C:\\Users\\<user>\\AppData\\x');
    expect(redact('/home/vasya/.claude and /mnt/c/Users/vasya/p', ['vasya'])).toBe('/home/<user>/.claude and /mnt/c/Users/<user>/p');
    expect(redact('http://127.0.0.1:47821/hook/7bf3cefbb02c9546d1cde81da9f38555/Stop', [])).toBe('http://127.0.0.1:47821/hook/<token>/Stop');
    expect(redact('mail me at a.b@example.com', [])).toBe('mail me at <email>');
  });
  it('lastEventByHost: newest event per host (WSL distros apart)', () => {
    const s = (host: string, at: number, distro?: string) => ({ host, lastEventAt: at, distro } as any);
    expect(lastEventByHost([s('wsl', 5), s('wsl', 9), s('windows', 3), s('wsl', 7, 'Debian')])).toEqual({ wsl: 9, windows: 3, 'wsl:Debian': 7 });
  });
  it('ago: human time since an event', () => {
    expect(ago(null, 0)).toBe(null);
    expect(ago(1000, 31_000)).toBe('30 s');
    expect(ago(0, 5 * 60_000)).toBe('5 min');
    expect(ago(0, 3 * 3600_000)).toBe('3 h');
  });
  it('the report lists every check in plain lines, without the user name', () => {
    const t = formatDiagnostics({
      version: '0.5.0', os: 'Windows 10.0.26100', now: 10 * 60_000, user: 'vasya',
      hosts: [
        { id: 'windows', up: true, events: true, mailbox: true, permissions: false, statusLine: 'none', lastEventAt: 9 * 60_000, sessions: 2, sources: ['claude-desktop', 'cli'] },
        { id: 'wsl', distro: 'Ubuntu', up: false, events: false, mailbox: false, permissions: false, lastEventAt: null, sessions: 0, sources: [], error: 'cannot read /home/vasya/.claude/settings.json' },
      ],
      helper: true, wrapper: 'none', policy: 'RemoteSigned', desktopChats: 3, newChatIn: 'wsl', sdkChats: false,
    });
    expect(t).toContain('ccPet 0.5.0');
    expect(t).toMatch(/windows: up, events yes, messages yes, permissions no, status line none, last event 1 min ago, sessions 2 \(claude-desktop, cli\)/);
    expect(t).toMatch(/wsl \(Ubuntu\): DOWN/);
    expect(t).toContain('/home/<user>/.claude');
    expect(t).not.toContain('vasya');
    expect(t).toContain('desktop app chats found: 3');
  });
});
