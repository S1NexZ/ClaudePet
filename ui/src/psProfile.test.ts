import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planProfile, removeFromProfile, profileState, wrapperLine, profilePaths, applyProfile } from './psProfile.js';

const H = 'C:\\Users\\u\\AppData\\Local\\Programs\\claude-pet\\resources\\helper\\pet-helper.exe';

describe('PowerShell profile wrapper', () => {
  it('the line runs claude through the helper and quotes the path for PowerShell', () => {
    expect(wrapperLine(H)).toBe(`function claude { & '${H}' pty claude @args }`);
    expect(wrapperLine("C:\\it's\\pet-helper.exe")).toContain("'C:\\it''s\\pet-helper.exe'");
  });
  it('adds a marked block to an empty or existing profile and keeps the user\'s lines', () => {
    const r = planProfile('Set-Alias ll ls\r\n', H);
    expect(r.next).toContain('Set-Alias ll ls');
    expect(r.next).toContain('# >>> ccPet >>>');
    expect(r.next).toContain(wrapperLine(H));
    expect(r.next).toContain('# <<< ccPet <<<');
    expect(r.diff).toContain('+ ');
    expect(planProfile('', H).next.startsWith('# >>> ccPet >>>')).toBe(true);
  });
  it('is idempotent; a moved helper replaces our block in place', () => {
    const once = planProfile('a\n', H).next;
    expect(planProfile(once, H).diff).toBe('');
    const moved = planProfile(once, 'D:\\pet\\pet-helper.exe');
    expect(moved.next.match(/>>> ccPet >>>/g)).toHaveLength(1);
    expect(moved.next).toContain("'D:\\pet\\pet-helper.exe'");
    expect(moved.next.startsWith('a\n')).toBe(true);
  });
  it('removing takes out only our block', () => {
    const withIt = planProfile('a\nb\n', H).next;
    expect(removeFromProfile(withIt).next).toBe('a\nb\n');
    expect(removeFromProfile('a\n').diff).toBe('');
  });
  it('state: none, ours (current helper) or stale (another path)', () => {
    expect(profileState('x', H)).toBe('none');
    expect(profileState(planProfile('', H).next, H)).toBe('ours');
    expect(profileState(planProfile('', 'D:\\old\\pet-helper.exe').next, H)).toBe('stale');
  });
  it('profile files: Windows PowerShell and PowerShell 7 under Documents', () => {
    expect(profilePaths('C:\\Users\\u\\Documents')).toEqual([
      join('C:\\Users\\u\\Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      join('C:\\Users\\u\\Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    ]);
  });
  it('apply writes with a .bak of an existing file; creates a missing one with its folder', () => {
    const d = mkdtempSync(join(tmpdir(), 'psp-'));
    const f = join(d, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
    applyProfile(f, planProfile('', H).next);
    expect(readFileSync(f, 'utf8')).toContain(wrapperLine(H));
    expect(existsSync(f + '.bak')).toBe(false);
    applyProfile(f, 'changed\n');
    expect(readFileSync(f + '.bak', 'utf8')).toContain(wrapperLine(H));
    writeFileSync(f, 'x');
  });
});
