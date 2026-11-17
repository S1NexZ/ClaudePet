import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planProfile, removeFromProfile, profileState, wrapperLine, profilePaths, applyProfile, readProfile } from './psProfile.js';

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
  it('encodings: UTF-8 is written with a BOM (Windows PowerShell 5.1 reads BOM-less files as ANSI), UTF-16 stays UTF-16, ANSI is not touched', () => {
    const d = mkdtempSync(join(tmpdir(), 'pse-'));
    const cyr = 'C:\\Users\\Иван\\pet-helper.exe';
    // new file
    const f1 = join(d, 'a.ps1');
    applyProfile(f1, planProfile(readProfile(f1), cyr).next);
    const b1 = readFileSync(f1);
    expect([...b1.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(readProfile(f1)).toContain(wrapperLine(cyr));
    // UTF-16LE profile (what `>` makes in PowerShell 5)
    const f2 = join(d, 'b.ps1');
    writeFileSync(f2, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Set-Alias ll ls\r\n', 'utf16le')]));
    expect(readProfile(f2)).toBe('Set-Alias ll ls\r\n');
    applyProfile(f2, planProfile(readProfile(f2), cyr).next);
    const b2 = readFileSync(f2);
    expect([...b2.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(b2.subarray(2).toString('utf16le')).toContain(wrapperLine(cyr));
    // ANSI (cp1251) text that is not valid UTF-8: refused, file unchanged
    const f3 = join(d, 'c.ps1');
    const ansi = Buffer.from([0x23, 0x20, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a]);
    writeFileSync(f3, ansi);
    expect(() => readProfile(f3)).toThrow(/ANSI/);
    expect(readFileSync(f3).equals(ansi)).toBe(true);
  });
});

