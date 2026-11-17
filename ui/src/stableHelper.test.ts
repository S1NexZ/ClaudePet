import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncHelper } from './stableHelper.js';

const setup = (content = 'v1') => {
  const d = mkdtempSync(join(tmpdir(), 'sh-'));
  const src = join(d, 'install', 'pet-helper.exe');
  mkdirSync(join(d, 'install'));
  writeFileSync(src, content);
  return { d, src, dir: join(d, 'bin') };
};

describe('stable pet-helper copy (hooks never point into the install folder)', () => {
  it('copies the helper on first run and returns the stable path', () => {
    const { src, dir } = setup();
    const r = syncHelper(src, dir);
    expect(r).toEqual({ path: join(dir, 'pet-helper.exe'), updated: true });
    expect(readFileSync(r.path!, 'utf8')).toBe('v1');
  });
  it('same content: nothing is written; a new version replaces the copy', () => {
    const { src, dir } = setup();
    syncHelper(src, dir);
    expect(syncHelper(src, dir).updated).toBe(false);
    writeFileSync(src, 'v2');
    expect(syncHelper(src, dir).updated).toBe(true);
    expect(readFileSync(join(dir, 'pet-helper.exe'), 'utf8')).toBe('v2');
  });
  it('a copy that cannot be replaced (in use by running sessions) is kept, and the stable path is still used', () => {
    const { src, dir } = setup();
    syncHelper(src, dir);
    writeFileSync(src, 'v2');
    const r = syncHelper(src, dir, { replace: () => { const e: any = new Error('busy'); e.code = 'EBUSY'; throw e; } });
    expect(r.path).toBe(join(dir, 'pet-helper.exe'));
    expect(r.updated).toBe(false);
    expect(r.error).toContain('busy');
    expect(readFileSync(r.path!, 'utf8')).toBe('v1');
  });
  it('no stable copy and it cannot be made: falls back to the installed helper', () => {
    const { src, dir } = setup();
    const r = syncHelper(src, dir, { replace: () => { throw new Error('denied'); } });
    expect(r.path).toBe(src);
    expect(existsSync(join(dir, 'pet-helper.exe'))).toBe(false);
  });
  it('no installed helper at all: undefined', () => {
    const d = mkdtempSync(join(tmpdir(), 'sh-'));
    expect(syncHelper(join(d, 'nope.exe'), join(d, 'bin')).path).toBeUndefined();
  });
});
