import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lineDiff } from '../../daemon/src/installHooks.js';

/**
 * The `claude` wrapper in the user's PowerShell profile: `claude` then starts through `pet-helper pty`, so the pet can press Esc and type
 * in that terminal. Our lines live between two markers; nothing else in the profile is touched.
 */
const START = '# >>> ccPet >>>';
const END = '# <<< ccPet <<<';
const BLOCK = /# >>> ccPet >>>[\s\S]*?# <<< ccPet <<<\r?\n?/;

export const wrapperLine = (helper: string) => `function claude { & '${helper.replace(/'/g, "''")}' pty claude @args }`;
const block = (helper: string, nl: string) => [START, '# claude runs through the ccPet wrapper (Esc, Stop and typing from the pet); remove this block to undo', wrapperLine(helper), END].join(nl) + nl;

export type ProfileState = 'none' | 'ours' | 'stale';

export function profileState(content: string, helper: string): ProfileState {
  const m = BLOCK.exec(content);
  if (!m) return 'none';
  return m[0].includes(wrapperLine(helper)) ? 'ours' : 'stale';
}

const diffOf = (a: string, b: string) => (a === b ? '' : lineDiff(a.split(/\r?\n/), b.split(/\r?\n/)));

/** The profile with our block added (or updated in place). */
export function planProfile(content: string, helper: string): { next: string; diff: string } {
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  const b = block(helper, nl);
  const next = BLOCK.test(content)
    ? content.replace(BLOCK, b)
    : content === '' ? b : `${content}${/\r?\n$/.test(content) ? '' : nl}${b}`;
  return { next, diff: diffOf(content, next) };
}

export function removeFromProfile(content: string): { next: string; diff: string } {
  const next = content.replace(BLOCK, '');
  return { next, diff: diffOf(content, next) };
}

/** Windows PowerShell 5 and PowerShell 7 profiles (both read `claude` from their own file). */
export function profilePaths(documents: string): string[] {
  return [join(documents, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'), join(documents, 'PowerShell', 'Microsoft.PowerShell_profile.ps1')];
}

export const readProfile = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** Writes the profile (copying an existing one to `.bak` first). */
export function applyProfile(path: string, next: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`); else mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
}
