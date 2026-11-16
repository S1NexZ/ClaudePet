import { describe, it, expect } from 'vitest';
import { readZip, safeEntryName, ModelError, crc32 } from './zip.js';
import { imageSize } from './images.js';
import { makeZip, fakeWebp, fakePng } from './testZip.js';

const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as ModelError).code; } return 'NO ERROR'; };

describe('safeEntryName (path traversal)', () => {
  it('accepts plain relative names', () => { expect(safeEntryName('pet.json')).toBe('pet.json'); expect(safeEntryName('dir/a.txt')).toBe('dir/a.txt'); expect(safeEntryName('dir/')).toBe('dir'); });
  it('rejects every way out of the target folder', () => {
    for (const bad of ['../evil.txt', 'a/../../evil', '/etc/passwd', '\\windows\\x', 'a\\b', 'C:/x', 'c:evil', '..', '.', 'a//b', 'a/./b', 'a\0b', '', './x', '../'])
      expect(() => safeEntryName(bad), bad).toThrow(ModelError);
  });
});

describe('readZip', () => {
  it('reads stored and deflated entries and verifies size and CRC', () => {
    const z = readZip(makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'world'.repeat(100), deflate: true }]));
    expect(z.map((e) => [e.name, e.size])).toEqual([['a.txt', 5], ['b.txt', 500]]);
    expect(z[0].data.toString()).toBe('hello');
    expect(z[1].data.toString()).toBe('world'.repeat(100));
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
  it('rejects hostile archives with a specific error code', () => {
    expect(code(() => readZip(makeZip([{ name: '../evil.js', data: 'x' }])))).toBe('unsafe-path');
    expect(code(() => readZip(makeZip([{ name: 'a/../../evil', data: 'x' }])))).toBe('unsafe-path');
    expect(code(() => readZip(makeZip([{ name: '/abs.txt', data: 'x' }])))).toBe('unsafe-path');
    expect(code(() => readZip(makeZip([{ name: 'C:/win.txt', data: 'x' }])))).toBe('unsafe-path');
    expect(code(() => readZip(makeZip([{ name: 'link', data: '/etc/passwd', unixMode: 0o120777 }])))).toBe('symlink');
    expect(code(() => readZip(makeZip([{ name: 'a.txt', data: 'x', flags: 1 }])))).toBe('encrypted');
    expect(code(() => readZip(makeZip([{ name: 'a.txt', data: 'x' }, { name: 'A.TXT', data: 'y' }])))).toBe('duplicate');
    expect(code(() => readZip(makeZip([{ name: 'a.txt', data: 'abc', crc: 1 }])))).toBe('corrupt');
    expect(code(() => readZip(makeZip([{ name: 'a.txt', data: 'abc', usize: 99 }])))).toBe('corrupt');
    expect(code(() => readZip(Buffer.from('not a zip at all, really not')))).toBe('not-zip');
    expect(code(() => readZip(Buffer.alloc(5)))).toBe('not-zip');
  });
  it('enforces limits: entry count, per-file size, total size, decompression bombs', () => {
    expect(code(() => readZip(makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: 'x' }))), { maxEntries: 4, maxFileBytes: 1e6, maxTotalBytes: 1e6 }))).toBe('too-many');
    expect(code(() => readZip(makeZip([{ name: 'big', data: Buffer.alloc(2000) }]), { maxEntries: 9, maxFileBytes: 1000, maxTotalBytes: 1e6 }))).toBe('too-big');
    expect(code(() => readZip(makeZip([{ name: 'a', data: Buffer.alloc(800) }, { name: 'b', data: Buffer.alloc(800) }]), { maxEntries: 9, maxFileBytes: 1000, maxTotalBytes: 1200 }))).toBe('too-big');
    // a "bomb": tiny deflated data that claims to be small but inflates far beyond the limit
    const bomb = makeZip([{ name: 'z', data: Buffer.alloc(5_000_000), deflate: true, usize: 10 }]);
    expect(code(() => readZip(bomb, { maxEntries: 9, maxFileBytes: 100_000, maxTotalBytes: 1e6 }))).toBe('corrupt');
  });
  it('a truncated or tampered central directory is an error, not a crash', () => {
    const z = makeZip([{ name: 'a.txt', data: 'hello' }]);
    expect(code(() => readZip(z.subarray(0, z.length - 30)))).not.toBe('NO ERROR');
    const t = Buffer.from(z); t.writeUInt32LE(0xfffffff0, t.length - 6); // central directory offset out of range
    expect(code(() => readZip(t))).toBe('corrupt');
  });
});

describe('imageSize', () => {
  it('reads WebP (lossless) and PNG headers; nothing else', () => {
    expect(imageSize(fakeWebp(1536, 1872))).toEqual({ w: 1536, h: 1872, format: 'webp' });
    expect(imageSize(fakePng(1536, 1872))).toEqual({ w: 1536, h: 1872, format: 'png' });
    expect(imageSize(Buffer.from('GIF89a......................................'))).toBeNull();
    expect(imageSize(Buffer.alloc(10))).toBeNull();
  });
});
