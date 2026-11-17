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

import { wrapperLine } from './psLine.js';
export { wrapperLine };
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

type Enc = 'utf8' | 'utf16le';

/** How a profile is encoded: by BOM; BOM-less valid UTF-8 counts as UTF-8; anything else is ANSI (null), which we do not edit. */
function encodingOf(raw: Buffer): Enc | null {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return 'utf16le';
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return 'utf8';
  try { new TextDecoder('utf-8', { fatal: true }).decode(raw); return 'utf8'; } catch { return null; }
}

const ANSI = 'The PowerShell profile is in an ANSI code page: ccPet does not edit it. Add the line yourself (see Settings → Connections).';

/** The profile's text ('' when there is none). Throws for an ANSI profile (editing it would garble its non-ASCII text). */
export function readProfile(path: string): string {
  if (!existsSync(path)) return '';
  const raw = readFileSync(path);
  const enc = encodingOf(raw);
  if (!enc) throw new Error(ANSI);
  if (enc === 'utf16le') return raw.subarray(2).toString('utf16le');
  return raw.toString('utf8').replace(/^\uFEFF/, '');
}

/**
 * Writes the profile (copying an existing one to `.bak` first). UTF-16 profiles stay UTF-16; everything else is written as UTF-8 with a BOM,
 * the one encoding both Windows PowerShell 5.1 (BOM-less = ANSI there) and PowerShell 7 read the same way.
 */
export function applyProfile(path: string, next: string): void {
  let enc: Enc = 'utf8';
  if (existsSync(path)) {
    const e = encodingOf(readFileSync(path));
    if (!e) throw new Error(ANSI);
    enc = e;
    copyFileSync(path, `${path}.bak`);
  } else mkdirSync(dirname(path), { recursive: true });
  const body = next.replace(/^\uFEFF/, '');
  writeFileSync(path, enc === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]) : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]));
}
