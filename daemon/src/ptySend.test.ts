import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitize, typedInput, sendPrompt, sendEsc, PtyGoneError } from './ptySend.js';

describe('typedInput', () => {
  it('single line: text then Enter', () => expect(typedInput('hi')).toEqual({ body: 'hi', submit: '\r' }));
  it('multi-line goes in as a bracketed paste', () => expect(typedInput('a\nb').body).toBe('\x1b[200~a\nb\x1b[201~'));
  it('strips control characters (Esc, Ctrl+C) but keeps text', () => expect(sanitize('a\x03b\x1bc\td')).toBe('abc\td'));
  it('empty text is nothing to send', async () => { await sendPrompt('/nonexistent.sock', '   \n'); });
});

const hasPython = spawnSync('python3', ['--version']).status === 0;
describe.skipIf(!hasPython)('sendPrompt against the real pet-claude.py wrapper', () => {
  it('types into the one child process; child sees the line + Enter and Esc', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptysend-'));
    const sock = join(dir, 'w.sock'), log = join(dir, 'child.log');
    const child = `import sys,os\nf=open(${JSON.stringify(log)},'w',buffering=1)\nf.write('pid '+str(os.getpid())+'\\n')\nwhile True:\n  b=os.read(0,1024)\n  f.write(repr(b)+'\\n')`;
    const w = spawn('python3', [join(__dirname, '../../scripts/pet-claude.py'), '--sock', sock, '--', 'python3', '-c', child], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 50 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
      await sendPrompt(sock, 'hello pet', 100);
      await sendEsc(sock);
      await new Promise((r) => setTimeout(r, 600));
      const lines = readFileSync(log, 'utf8');
      expect(lines).toContain("hello pet");
      expect(lines).toContain("hello pet\\n"); // cooked-mode PTY turns Enter (\\r) into \\n
      expect(lines.match(/^pid /gm)).toHaveLength(1); // one process
      await sendPrompt(sock, 'second', 100); // reconnect after the first client left: child still alive
      await new Promise((r) => setTimeout(r, 400));
      // cooked-mode child holds the earlier Esc in its line buffer until Enter, so it arrives in front of the next line
      expect(readFileSync(log, 'utf8')).toContain('\\x1bsecond');
    } finally { w.kill('SIGTERM'); }
    await new Promise((r) => w.once('exit', r));
    await expect(sendPrompt(sock, 'x')).rejects.toBeInstanceOf(PtyGoneError); // wrapper gone: socket removed
  }, 20000);
});
