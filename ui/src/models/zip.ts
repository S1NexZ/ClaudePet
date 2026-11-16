import { inflateRawSync } from 'node:zlib';
import { L } from '../../../shared/src/i18n.js';

/** Reading a ZIP without extracting anything to disk and without any dependency: everything is checked in memory first. */
export class ModelError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ModelError'; }
}

export interface ZipEntry { name: string; size: number; data: Buffer }
export interface ZipLimits { maxEntries: number; maxFileBytes: number; maxTotalBytes: number }
export const DEFAULT_LIMITS: ZipLimits = { maxEntries: 32, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 };

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/**
 * An entry name is safe only if it stays inside the target folder: no absolute paths, drive letters, backslashes,
 * NUL bytes, empty or ".." segments. Returns the normalized name; throws otherwise.
 */
export function safeEntryName(raw: string): string {
  const bad = () => new ModelError('unsafe-path', L(`Небезопасный путь в архиве: «${raw.replace(/[^\x20-\x7eЀ-ӿ]/g, '?').slice(0, 80)}»`, `Unsafe path in the archive: “${raw.replace(/[^\x20-\x7eЀ-ӿ]/g, '?').slice(0, 80)}”`, `压缩包中的路径不安全：“${raw.replace(/[^\x20-\x7eЀ-ӿ]/g, '?').slice(0, 80)}”`));
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw bad();
  const parts = raw.split('/');
  if (parts.at(-1) === '') parts.pop(); // a directory entry
  if (!parts.length || parts.some((p) => p === '' || p === '.' || p === '..')) throw bad();
  return parts.join('/');
}

/** Parses the archive and returns its files (directories dropped). Throws ModelError with a user-readable message. */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_LIMITS): ZipEntry[] {
  const fail = (code: string, msg: string): never => { throw new ModelError(code, msg); };
  if (buf.length < 22) fail('not-zip', L('Файл не похож на ZIP-архив.', 'The file does not look like a ZIP archive.', '该文件看起来不是 ZIP 压缩包。'));
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('not-zip', L('Файл не похож на ZIP-архив (нет оглавления).', 'The file does not look like a ZIP archive (no directory).', '该文件看起来不是 ZIP 压缩包（没有目录）。'));
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) fail('zip64', L('ZIP64-архивы не поддерживаются.', 'ZIP64 archives are not supported.', '不支持 ZIP64 压缩包。'));
  if (count > limits.maxEntries) fail('too-many', L(`В архиве слишком много файлов (${count}, допустимо ${limits.maxEntries}).`, `The archive has too many files (${count}, at most ${limits.maxEntries}).`, `压缩包文件过多（${count} 个，最多 ${limits.maxEntries} 个）。`));
  if (cdOff + cdSize > buf.length) fail('corrupt', L('Архив повреждён (оглавление выходит за границы файла).', 'The archive is damaged (the directory runs past the end of the file).', '压缩包已损坏（目录超出文件末尾）。'));

  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0, p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('corrupt', L('Архив повреждён (запись оглавления).', 'The archive is damaged (directory entry).', '压缩包已损坏（目录条目）。'));
    const madeBy = buf.readUInt16LE(p + 4), flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38), localOff = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) fail('corrupt', L('Архив повреждён (имя файла).', 'The archive is damaged (file name).', '压缩包已损坏（文件名）。'));
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const name = safeEntryName(rawName);
    if (rawName.endsWith('/')) continue; // directory
    if ((madeBy >> 8) === 3 && ((extAttr >>> 16) & 0xf000) === 0xa000) fail('symlink', L(`Ссылки внутри архива запрещены: «${name}»`, `Links inside the archive are not allowed: “${name}”`, `压缩包内不允许链接：“${name}”`));
    if (flags & 1) fail('encrypted', L('Зашифрованные архивы не поддерживаются.', 'Encrypted archives are not supported.', '不支持加密的压缩包。'));
    if (method !== 0 && method !== 8) fail('method', L(`Неподдерживаемый способ сжатия в «${name}».`, `Unsupported compression method in “${name}”.`, `“${name}”使用了不支持的压缩方法。`));
    if (csize === 0xffffffff || usize === 0xffffffff) fail('zip64', L('ZIP64-архивы не поддерживаются.', 'ZIP64 archives are not supported.', '不支持 ZIP64 压缩包。'));
    if (usize > limits.maxFileBytes) fail('too-big', L(`Файл «${name}» слишком большой (${Math.round(usize / 1048576)} МБ, допустимо ${Math.round(limits.maxFileBytes / 1048576)} МБ).`, `The file “${name}” is too large (${Math.round(usize / 1048576)} MB, at most ${Math.round(limits.maxFileBytes / 1048576)} MB).`, `文件“${name}”太大（${Math.round(usize / 1048576)} MB，最大 ${Math.round(limits.maxFileBytes / 1048576)} MB）。`));
    if (seen.has(name.toLowerCase())) fail('duplicate', L(`В архиве повторяется файл «${name}».`, `The file “${name}” appears twice in the archive.`, `文件“${name}”在压缩包中出现了两次。`));
    seen.add(name.toLowerCase());
    total += usize;
    if (total > limits.maxTotalBytes) fail('too-big', L('Архив слишком большой после распаковки.', 'The archive is too large once unpacked.', '解压后压缩包太大。'));

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) fail('corrupt', L(`Архив повреждён (локальный заголовок «${name}»).`, `The archive is damaged (local header of “${name}”).`, `压缩包已损坏（“${name}”的本地头）。`));
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    if (dataStart + csize > buf.length) fail('corrupt', L(`Архив повреждён (данные «${name}» обрезаны).`, `The archive is damaged (data of “${name}” is truncated).`, `压缩包已损坏（“${name}”的数据被截断）。`));
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data: Buffer;
    try { data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes + 1 }); }
    catch { return fail('corrupt', L(`Не удалось распаковать «${name}» (повреждённые данные или «бомба»).`, `Could not unpack “${name}” (corrupt data or a decompression bomb).`, `无法解压“${name}”（数据损坏或解压炸弹）。`)); }
    if (data.length !== usize) fail('corrupt', L(`Размер «${name}» не совпадает с оглавлением.`, `The size of “${name}” does not match the directory.`, `“${name}”的大小与目录不符。`));
    if (crc32(data) !== crc) fail('corrupt', L(`Контрольная сумма «${name}» не совпадает: архив повреждён.`, `The checksum of “${name}” does not match: the archive is damaged.`, `“${name}”的校验和不匹配：压缩包已损坏。`));
    out.push({ name, size: data.length, data });
  }
  return out;
}
