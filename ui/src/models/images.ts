/** Pixel size of a WebP (VP8 / VP8L / VP8X) or PNG, read from the header only; null for anything else. */
export function imageSize(b: Buffer): { w: number; h: number; format: 'webp' | 'png' } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('ascii', 12, 16) === 'IHDR')
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), format: 'png' };
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const k = b.toString('ascii', 12, 16);
    if (k === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), format: 'webp' };
    if (k === 'VP8L' && b[20] === 0x2f) { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1, format: 'webp' }; }
    if (k === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, format: 'webp' };
  }
  return null;
}
/** The atlas layout the pet's animator is built for: 8 columns x 9 rows of 192x208 cells. */
export const SHEET = { w: 1536, h: 1872 } as const;
