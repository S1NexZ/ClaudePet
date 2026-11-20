import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { join, resolve, sep, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MODEL_ID, listModels, type ModelInfo } from './registry.js';
import { readZip, ModelError, type ZipEntry } from './zip.js';
import { imageSize, SHEET, SHEET_V2_H, sheetSizeOk, parseLayout, layoutSheetSize } from './images.js';
import { L } from '../../../shared/src/i18n.js';

export { ModelError };

/** Files a model pack may contain. Nothing else is accepted, and nothing in a pack is ever executed or interpreted as code. */
const DOC_FILES = /^(readme|license|licence|notice|credits|attribution)(\.(md|txt))?$/i;
const SPRITE_EXT = new Set(['.webp', '.png']);
const MAX_JSON = 64 * 1024, MAX_DOC = 64 * 1024, MAX_SHEET = 16 * 1024 * 1024;
const RISKY_EXT = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.js', '.mjs', '.cjs', '.jar', '.sh', '.msi', '.lnk', '.scr', '.com', '.py', '.node', '.html', '.htm', '.svg']);

export interface PackFiles { id: string; name: string; files: Map<string, Buffer> }

/** `foo.codex-pet.zip` / `My Pet.zip` -> `foo` / `my-pet` (used only when pet.json has no usable id). */
export const slugFromName = (n: string): string =>
  n.replace(/\.codex-pet\.zip$/i, '').replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Drops a single wrapper folder ("pet/pet.json" -> "pet.json") when every file lives in it. */
function unwrap(entries: ZipEntry[]): ZipEntry[] {
  if (!entries.length) return entries;
  const first = entries[0].name.split('/')[0];
  if (entries.every((e) => e.name.includes('/') && e.name.split('/')[0] === first)) return entries.map((e) => ({ ...e, name: e.name.slice(first.length + 1) }));
  return entries;
}

/**
 * Validates a set of files as a pet pack and returns it normalized. Rules: only pet.json, tweaks.json, one spritesheet
 * (.webp/.png, exactly 1536x1872 so the animator's 8x9 grid of 192x208 cells fits) and plain text docs; no subfolders,
 * no scripts or other file types. Throws ModelError with a message the user can act on.
 */
export function validatePack(raw: ZipEntry[], fallbackId = ''): PackFiles {
  const entries = unwrap(raw);
  const fail = (code: string, msg: string): never => { throw new ModelError(code, msg); };
  const files = new Map<string, Buffer>();
  for (const e of entries) {
    if (e.name.includes('/')) fail('nested', L(`Вложенные папки не поддерживаются: «${e.name}». Файлы модели должны лежать в корне архива.`, `Nested folders are not supported: “${e.name}”. Model files must sit in the archive root.`, `不支持嵌套文件夹：“${e.name}”。模型文件必须位于压缩包根目录。`));
    const ext = extname(e.name).toLowerCase();
    if (RISKY_EXT.has(ext)) fail('risky', L(`В архиве есть исполняемый или скриптовый файл «${e.name}». Такие архивы не устанавливаются.`, `The archive contains an executable or script file “${e.name}”. Such archives are not installed.`, `压缩包含有可执行文件或脚本文件“${e.name}”。此类压缩包不会被安装。`));
    files.set(e.name, e.data);
  }
  const petJson = files.get('pet.json');
  if (!petJson) return fail('no-pet-json', L('В архиве нет файла pet.json: это не модель питомца формата Codex.', 'The archive has no pet.json: this is not a Codex-format pet model.', '压缩包中没有 pet.json：这不是 Codex 格式的宠物模型。'));
  if (petJson.length > MAX_JSON) fail('too-big', L('pet.json слишком большой.', 'pet.json is too large.', 'pet.json 太大。'));
  let meta: any;
  try { meta = JSON.parse(petJson.toString('utf8')); } catch { return fail('bad-pet-json', L('pet.json не является корректным JSON.', 'pet.json is not valid JSON.', 'pet.json 不是有效的 JSON。')); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return fail('bad-pet-json', L('pet.json должен быть объектом.', 'pet.json must be an object.', 'pet.json 必须是一个对象。'));

  const sheetName = typeof meta.spritesheetPath === 'string' ? meta.spritesheetPath : 'spritesheet.webp';
  if (sheetName.includes('/') || sheetName.includes('\\') || !SPRITE_EXT.has(extname(sheetName).toLowerCase()))
    fail('bad-sheet-path', L(`Лист спрайтов указан неверно: «${sheetName.slice(0, 60)}» (нужен файл .webp или .png в корне архива).`, `The sprite sheet is specified incorrectly: “${sheetName.slice(0, 60)}” (a .webp or .png file in the archive root is required).`, `雪碧图指定有误：“${sheetName.slice(0, 60)}”（需要压缩包根目录中的 .webp 或 .png 文件）。`));
  const sheet = files.get(sheetName);
  if (!sheet) return fail('no-sheet', L(`В архиве нет листа спрайтов «${sheetName}», указанного в pet.json.`, `The archive has no sprite sheet “${sheetName}” named in pet.json.`, `压缩包中没有 pet.json 指定的雪碧图“${sheetName}”。`));
  if (sheet.length > MAX_SHEET) fail('too-big', L('Лист спрайтов слишком большой.', 'The sprite sheet is too large.', '雪碧图太大。'));
  const size = imageSize(sheet);
  if (!size) fail('bad-image', L(`«${sheetName}» не является корректным WebP или PNG.`, `“${sheetName}” is not a valid WebP or PNG.`, `“${sheetName}”不是有效的 WebP 或 PNG。`));
  let layout: ReturnType<typeof parseLayout> = null;
  try { layout = parseLayout(meta); } catch (e) { fail('bad-layout', L(`Неверный раздел layout в pet.json (${(e as Error).message}).`, `Invalid "layout" in pet.json (${(e as Error).message}).`, `pet.json 中的 layout 无效（${(e as Error).message}）。`)); }
  const want = layout ? layoutSheetSize(layout) : null;
  if (layout && !want) fail('bad-layout', L('Лист по layout больше 6144 px по стороне.', 'The layout sheet exceeds 6144 px per side.', '按 layout 计算的图片边长超过 6144 px。'));
  if (want) { if (size!.w !== want.w || size!.h !== want.h) fail('bad-size', L(`Размер листа ${size!.w}×${size!.h}, а layout требует ${want.w}×${want.h}.`, `The sheet is ${size!.w}×${size!.h}, but the layout requires ${want.w}×${want.h}.`, `图片尺寸为 ${size!.w}×${size!.h}，但 layout 需要 ${want.w}×${want.h}。`)); }
  else if (!sheetSizeOk(size!))
    fail('bad-size', L(`Размер листа ${size!.w}×${size!.h}, а нужен ${SHEET.w}×${SHEET.h} или ${SHEET.w}×${SHEET_V2_H} (сетка 8 столбцов × 9 или 11 строк ячеек 192×208, как у паков Codex).`, `The sheet is ${size!.w}×${size!.h}, but ${SHEET.w}×${SHEET.h} or ${SHEET.w}×${SHEET_V2_H} is required (8 columns × 9 or 11 rows of 192×208 cells, like Codex packs).`, `图片尺寸为 ${size!.w}×${size!.h}，但需要 ${SHEET.w}×${SHEET.h} 或 ${SHEET.w}×${SHEET_V2_H}（8 列 × 9 或 11 行，每格 192×208，与 Codex 宠物包相同）。`));

  const allowed = new Set(['pet.json', sheetName, 'tweaks.json']);
  for (const [name, data] of files) {
    if (allowed.has(name)) continue;
    if (DOC_FILES.test(name)) { if (data.length > MAX_DOC) fail('too-big', L(`«${name}» слишком большой.`, `“${name}” is too large.`, `“${name}”太大。`)); continue; }
    fail('unsupported-file', L(`Неподдерживаемый файл в архиве: «${name}». Допустимы pet.json, лист спрайтов, tweaks.json и текстовые README/LICENSE.`, `Unsupported file in the archive: “${name}”. Only pet.json, the sprite sheet, tweaks.json and text README/LICENSE files are allowed.`, `压缩包中有不支持的文件：“${name}”。只允许 pet.json、雪碧图、tweaks.json 以及文本 README/LICENSE 文件。`));
  }
  const tw = files.get('tweaks.json');
  if (tw) { if (tw.length > MAX_JSON) fail('too-big', L('tweaks.json слишком большой.', 'tweaks.json is too large.', 'tweaks.json 太大。')); try { JSON.parse(tw.toString('utf8')); } catch { fail('bad-tweaks', L('tweaks.json не является корректным JSON.', 'tweaks.json is not valid JSON.', 'tweaks.json 不是有效的 JSON。')); } }

  const wanted = typeof meta.id === 'string' ? meta.id.toLowerCase() : '';
  const id = MODEL_ID.test(wanted) ? wanted : slugFromName(fallbackId);
  if (!MODEL_ID.test(id)) fail('bad-id', L('Не удалось определить идентификатор модели: в pet.json нет подходящего id (латиница, цифры, дефис).', 'Could not determine the model id: pet.json has no suitable id (Latin letters, digits, hyphen).', '无法确定模型 id：pet.json 中没有合适的 id（拉丁字母、数字、连字符）。'));
  const name = typeof meta.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim().slice(0, 80) : id;
  return { id, name, files };
}

export interface InstallProgress { step: 'read' | 'check' | 'write' | 'done'; percent: number; message: string }
export interface InstallOpts { userDir: string; bundledDir: string; onProgress?: (p: InstallProgress) => void }

/** Writes a validated pack as <userDir>/<id>/ atomically (temp folder + rename). Never overwrites an existing model. */
export function writePack(pack: PackFiles, o: InstallOpts): ModelInfo {
  const prog = o.onProgress ?? (() => {});
  const taken = listModels(o.bundledDir, o.userDir).find((m) => m.id === pack.id);
  if (taken) throw new ModelError('exists', taken.bundled ? L(`Модель «${pack.id}» уже встроена в приложение.`, `The model “${pack.id}” is already built into the app.`, `模型“${pack.id}”已内置于应用中。`) : L(`Модель «${pack.id}» уже установлена. Сначала удалите её, если хотите заменить.`, `The model “${pack.id}” is already installed. Remove it first if you want to replace it.`, `模型“${pack.id}”已安装。如需替换，请先将其移除。`));
  mkdirSync(o.userDir, { recursive: true });
  const target = join(o.userDir, pack.id);
  if (existsSync(target)) throw new ModelError('exists', L(`Папка модели «${pack.id}» уже существует.`, `The model folder “${pack.id}” already exists.`, `模型文件夹“${pack.id}”已存在。`));
  const tmp = join(o.userDir, `.tmp-${randomBytes(6).toString('hex')}`);
  mkdirSync(tmp);
  try {
    let n = 0;
    for (const [name, data] of pack.files) {
      const dest = resolve(tmp, name);
      if (!dest.startsWith(resolve(tmp) + sep)) throw new ModelError('unsafe-path', L('Небезопасный путь при записи.', 'Unsafe path while writing.', '写入时路径不安全。')); // defence in depth
      writeFileSync(dest, data, { flag: 'wx' });
      prog({ step: 'write', percent: 60 + Math.round((++n / pack.files.size) * 35), message: L(`Запись: ${name}`, `Writing: ${name}`, `正在写入：${name}`) });
    }
    renameSync(tmp, target);
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  prog({ step: 'done', percent: 100, message: L('Готово', 'Done', '完成') });
  const info = listModels(o.bundledDir, o.userDir).find((m) => m.id === pack.id);
  if (!info) throw new ModelError('corrupt', L('Модель записана, но не читается.', 'The model was written but cannot be read.', '模型已写入但无法读取。'));
  return info;
}

const MAX_ZIP = 40 * 1024 * 1024;
export function installModelFromZip(zipPath: string, o: InstallOpts): ModelInfo {
  const prog = o.onProgress ?? (() => {});
  const fail = (code: string, msg: string): never => { throw new ModelError(code, msg); };
  prog({ step: 'read', percent: 5, message: L('Чтение архива', 'Reading the archive', '正在读取压缩包') });
  let st; try { st = statSync(zipPath); } catch { return fail('unreadable', L('Не удалось открыть файл.', 'Could not open the file.', '无法打开文件。')); }
  if (!st.isFile()) fail('unreadable', L('Выбран не файл.', 'The selection is not a file.', '所选内容不是文件。'));
  if (st.size > MAX_ZIP) fail('too-big', L(`Архив слишком большой (${Math.round(st.size / 1048576)} МБ, допустимо ${MAX_ZIP / 1048576} МБ).`, `The archive is too large (${Math.round(st.size / 1048576)} MB, at most ${MAX_ZIP / 1048576} MB).`, `压缩包太大（${Math.round(st.size / 1048576)} MB，最大 ${MAX_ZIP / 1048576} MB）。`));
  let buf: Buffer; try { buf = readFileSync(zipPath); } catch { return fail('unreadable', L('Не удалось прочитать файл.', 'Could not read the file.', '无法读取文件。')); }
  prog({ step: 'check', percent: 20, message: L('Проверка содержимого', 'Checking the contents', '正在检查内容') });
  const pack = validatePack(readZip(buf), basename(zipPath));
  prog({ step: 'check', percent: 55, message: L('Архив корректен', 'The archive is valid', '压缩包有效') });
  return writePack(pack, o);
}

/** A pack that is already a folder (e.g. what an npm pet installer put in ~/.codex/pets/<id>): same rules, symlinks refused. */
export function installModelFromDir(dir: string, o: InstallOpts): ModelInfo {
  const entries: ZipEntry[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { throw new ModelError('unreadable', L('Не удалось открыть папку модели.', 'Could not open the model folder.', '无法打开模型文件夹。')); }
  if (names.length > 32) throw new ModelError('too-many', L('В папке слишком много файлов.', 'The folder has too many files.', '文件夹中的文件过多。'));
  for (const n of names) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new ModelError('symlink', L(`Ссылки запрещены: «${n}»`, `Links are not allowed: “${n}”`, `不允许链接：“${n}”`));
    if (st.isDirectory()) throw new ModelError('nested', L(`Вложенные папки не поддерживаются: «${n}».`, `Nested folders are not supported: “${n}”.`, `不支持嵌套文件夹：“${n}”。`));
    if (st.size > 16 * 1024 * 1024) throw new ModelError('too-big', L(`Файл «${n}» слишком большой.`, `The file “${n}” is too large.`, `文件“${n}”太大。`));
    entries.push({ name: n, size: st.size, data: readFileSync(p) });
  }
  return writePack(validatePack(entries, basename(dir)), o);
}

/** Removes a USER model (never a bundled one); the id is checked so nothing outside the user models folder can be touched. */
export function removeModel(id: string, o: { userDir: string; bundledDir: string }): void {
  if (!MODEL_ID.test(id)) throw new ModelError('bad-id', L('Некорректный идентификатор модели.', 'Invalid model id.', '模型 id 无效。'));
  if (listModels(o.bundledDir, join(o.userDir, '__none__')).some((m) => m.id === id)) throw new ModelError('bundled', L('Встроенную модель удалить нельзя.', 'A built-in model cannot be removed.', '内置模型无法删除。'));
  const target = resolve(o.userDir, id);
  if (!target.startsWith(resolve(o.userDir) + sep)) throw new ModelError('unsafe-path', L('Небезопасный путь.', 'Unsafe path.', '路径不安全。'));
  if (!existsSync(target)) throw new ModelError('missing', L('Такой модели нет.', 'There is no such model.', '没有这个模型。'));
  rmSync(target, { recursive: true, force: true });
}

export interface FoundPet { id: string; name: string; dir: string }
/** Pet folders an npm pet installer left in <dir> (~/.codex/pets): looked at only, nothing is run or changed. */
export function scanPetFolder(dir: string): FoundPet[] {
  if (!existsSync(dir)) return [];
  const out: FoundPet[] = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    try {
      if (!lstatSync(p).isDirectory()) continue;
      const m = JSON.parse(readFileSync(join(p, 'pet.json'), 'utf8'));
      out.push({ id: MODEL_ID.test(String(m.id ?? '').toLowerCase()) ? String(m.id).toLowerCase() : slugFromName(n), name: typeof m.displayName === 'string' ? m.displayName.slice(0, 80) : n, dir: p });
    } catch { /* not a pet folder */ }
  }
  return out;
}
