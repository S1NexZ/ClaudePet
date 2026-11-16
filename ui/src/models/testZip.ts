// Test helpers: build ZIP archives (including hostile ones) and fake sprite sheets. Not used by the app.
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zip.js';

export interface ZEntry { name: string; data: Buffer | string; deflate?: boolean; flags?: number; unixMode?: number; crc?: number; usize?: number }

export function makeZip(entries: ZEntry[], opts: { eocdCount?: number } = {}): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = e.deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const crc = e.crc ?? crc32(data), usize = e.usize ?? data.length;
    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    name.copy(lh, 30);
    const ch = Buffer.alloc(46 + name.length);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.flags ?? 0, 8); ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    if (e.unixMode !== undefined) ch.writeUInt32LE((e.unixMode << 16) >>> 0, 38);
    ch.writeUInt32LE(off, 42);
    name.copy(ch, 46);
    locals.push(lh, comp); central.push(ch);
    off += lh.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(opts.eocdCount ?? entries.length, 8); eocd.writeUInt16LE(opts.eocdCount ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** A buffer that parses as a lossless WebP of the given size (enough for header checks; not a decodable image). */
export function fakeWebp(w: number, h: number, pad = 64): Buffer {
  const b = Buffer.alloc(30 + pad);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(b.length - 8, 4); b.write('WEBPVP8L', 8, 'ascii'); b.writeUInt32LE(b.length - 20, 16);
  b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
}
export function fakePng(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
export const goodPack = (over: Partial<Record<string, Buffer | string>> = {}, id = 'my-pet'): ZEntry[] => [
  { name: 'pet.json', data: (over['pet.json'] as string) ?? JSON.stringify({ id, displayName: 'My Pet', description: 'd', spritesheetPath: 'spritesheet.webp', source: 'test' }) },
  { name: 'spritesheet.webp', data: (over['spritesheet.webp'] as Buffer) ?? fakeWebp(1536, 1872) },
];
