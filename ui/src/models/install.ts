import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { join, resolve, sep, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MODEL_ID, listModels, type ModelInfo } from './registry.js';
import { readZip, ModelError, type ZipEntry } from './zip.js';
import { imageSize, SHEET } from './images.js';
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
    if (e.name.includes('/')) fail('nested', L(`Вложенные папки не поддерживаются: «${e.name}». Файлы модели должны лежать в корне архива.`, `Nested folders are not supported: “${e.name}”. Model files must sit in the archive root.`));
    const ext = extname(e.name).toLowerCase();
    if (RISKY_EXT.has(ext)) fail('risky', L(`В архиве есть исполняемый или скриптовый файл «${e.name}». Такие архивы не устанавливаются.`, `The archive contains an executable or script file “${e.name}”. Such archives are not installed.`));
    files.set(e.name, e.data);
  }
  const petJson = files.get('pet.json');
  if (!petJson) return fail('no-pet-json', L('В архиве нет файла pet.json: это не модель питомца формата Codex.', 'The archive has no pet.json: this is not a Codex-format pet model.'));
  if (petJson.length > MAX_JSON) fail('too-big', L('pet.json слишком большой.', 'pet.json is too large.'));
  let meta: any;
  try { meta = JSON.parse(petJson.toString('utf8')); } catch { return fail('bad-pet-json', L('pet.json не является корректным JSON.', 'pet.json is not valid JSON.')); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return fail('bad-pet-json', L('pet.json должен быть объектом.', 'pet.json must be an object.'));

  const sheetName = typeof meta.spritesheetPath === 'string' ? meta.spritesheetPath : 'spritesheet.webp';
  if (sheetName.includes('/') || sheetName.includes('\\') || !SPRITE_EXT.has(extname(sheetName).toLowerCase()))
    fail('bad-sheet-path', L(`Лист спрайтов указан неверно: «${sheetName.slice(0, 60)}» (нужен файл .webp или .png в корне архива).`, `The sprite sheet is specified incorrectly: “${sheetName.slice(0, 60)}” (a .webp or .png file in the archive root is required).`));
  const sheet = files.get(sheetName);
  if (!sheet) return fail('no-sheet', L(`В архиве нет листа спрайтов «${sheetName}», указанного в pet.json.`, `The archive has no sprite sheet “${sheetName}” named in pet.json.`));
  if (sheet.length > MAX_SHEET) fail('too-big', L('Лист спрайтов слишком большой.', 'The sprite sheet is too large.'));
  const size = imageSize(sheet);
  if (!size) fail('bad-image', L(`«${sheetName}» не является корректным WebP или PNG.`, `“${sheetName}” is not a valid WebP or PNG.`));
  if (size!.w !== SHEET.w || size!.h !== SHEET.h)
    fail('bad-size', L(`Размер листа ${size!.w}×${size!.h}, а нужен ${SHEET.w}×${SHEET.h} (сетка 8×9 ячеек 192×208, как у паков Codex).`, `The sheet is ${size!.w}×${size!.h}, but ${SHEET.w}×${SHEET.h} is required (an 8×9 grid of 192×208 cells, like Codex packs).`));

  const allowed = new Set(['pet.json', sheetName, 'tweaks.json']);
  for (const [name, data] of files) {
    if (allowed.has(name)) continue;
    if (DOC_FILES.test(name)) { if (data.length > MAX_DOC) fail('too-big', L(`«${name}» слишком большой.`, `“${name}” is too large.`)); continue; }
    fail('unsupported-file', L(`Неподдерживаемый файл в архиве: «${name}». Допустимы pet.json, лист спрайтов, tweaks.json и текстовые README/LICENSE.`, `Unsupported file in the archive: “${name}”. Only pet.json, the sprite sheet, tweaks.json and text README/LICENSE files are allowed.`));
  }
  const tw = files.get('tweaks.json');
  if (tw) { if (tw.length > MAX_JSON) fail('too-big', L('tweaks.json слишком большой.', 'tweaks.json is too large.')); try { JSON.parse(tw.toString('utf8')); } catch { fail('bad-tweaks', L('tweaks.json не является корректным JSON.', 'tweaks.json is not valid JSON.')); } }

  const wanted = typeof meta.id === 'string' ? meta.id.toLowerCase() : '';
  const id = MODEL_ID.test(wanted) ? wanted : slugFromName(fallbackId);
  if (!MODEL_ID.test(id)) fail('bad-id', L('Не удалось определить идентификатор модели: в pet.json нет подходящего id (латиница, цифры, дефис).', 'Could not determine the model id: pet.json has no suitable id (Latin letters, digits, hyphen).'));
  const name = typeof meta.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim().slice(0, 80) : id;
  return { id, name, files };
}

export interface InstallProgress { step: 'read' | 'check' | 'write' | 'done'; percent: number; message: string }
export interface InstallOpts { userDir: string; bundledDir: string; onProgress?: (p: InstallProgress) => void }

/** Writes a validated pack as <userDir>/<id>/ atomically (temp folder + rename). Never overwrites an existing model. */
export function writePack(pack: PackFiles, o: InstallOpts): ModelInfo {
  const prog = o.onProgress ?? (() => {});
  const taken = listModels(o.bundledDir, o.userDir).find((m) => m.id === pack.id);
  if (taken) throw new ModelError('exists', taken.bundled ? L(`Модель «${pack.id}» уже встроена в приложение.`, `The model “${pack.id}” is already built into the app.`) : L(`Модель «${pack.id}» уже установлена. Сначала удалите её, если хотите заменить.`, `The model “${pack.id}” is already installed. Remove it first if you want to replace it.`));
  mkdirSync(o.userDir, { recursive: true });
  const target = join(o.userDir, pack.id);
  if (existsSync(target)) throw new ModelError('exists', L(`Папка модели «${pack.id}» уже существует.`, `The model folder “${pack.id}” already exists.`));
  const tmp = join(o.userDir, `.tmp-${randomBytes(6).toString('hex')}`);
  mkdirSync(tmp);
  try {
    let n = 0;
    for (const [name, data] of pack.files) {
      const dest = resolve(tmp, name);
      if (!dest.startsWith(resolve(tmp) + sep)) throw new ModelError('unsafe-path', L('Небезопасный путь при записи.', 'Unsafe path while writing.')); // defence in depth
      writeFileSync(dest, data, { flag: 'wx' });
      prog({ step: 'write', percent: 60 + Math.round((++n / pack.files.size) * 35), message: L(`Запись: ${name}`, `Writing: ${name}`) });
    }
    renameSync(tmp, target);
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  prog({ step: 'done', percent: 100, message: L('Готово', 'Done') });
  const info = listModels(o.bundledDir, o.userDir).find((m) => m.id === pack.id);
  if (!info) throw new ModelError('corrupt', L('Модель записана, но не читается.', 'The model was written but cannot be read.'));
  return info;
}

const MAX_ZIP = 40 * 1024 * 1024;
export function installModelFromZip(zipPath: string, o: InstallOpts): ModelInfo {
  const prog = o.onProgress ?? (() => {});
  const fail = (code: string, msg: string): never => { throw new ModelError(code, msg); };
  prog({ step: 'read', percent: 5, message: L('Чтение архива', 'Reading the archive') });
  let st; try { st = statSync(zipPath); } catch { return fail('unreadable', L('Не удалось открыть файл.', 'Could not open the file.')); }
  if (!st.isFile()) fail('unreadable', L('Выбран не файл.', 'The selection is not a file.'));
  if (st.size > MAX_ZIP) fail('too-big', L(`Архив слишком большой (${Math.round(st.size / 1048576)} МБ, допустимо ${MAX_ZIP / 1048576} МБ).`, `The archive is too large (${Math.round(st.size / 1048576)} MB, at most ${MAX_ZIP / 1048576} MB).`));
  let buf: Buffer; try { buf = readFileSync(zipPath); } catch { return fail('unreadable', L('Не удалось прочитать файл.', 'Could not read the file.')); }
  prog({ step: 'check', percent: 20, message: L('Проверка содержимого', 'Checking the contents') });
  const pack = validatePack(readZip(buf), basename(zipPath));
  prog({ step: 'check', percent: 55, message: L('Архив корректен', 'The archive is valid') });
  return writePack(pack, o);
}

/** A pack that is already a folder (e.g. what an npm pet installer put in ~/.codex/pets/<id>): same rules, symlinks refused. */
export function installModelFromDir(dir: string, o: InstallOpts): ModelInfo {
  const entries: ZipEntry[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { throw new ModelError('unreadable', L('Не удалось открыть папку модели.', 'Could not open the model folder.')); }
  if (names.length > 32) throw new ModelError('too-many', L('В папке слишком много файлов.', 'The folder has too many files.'));
  for (const n of names) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new ModelError('symlink', L(`Ссылки запрещены: «${n}»`, `Links are not allowed: “${n}”`));
    if (st.isDirectory()) throw new ModelError('nested', L(`Вложенные папки не поддерживаются: «${n}».`, `Nested folders are not supported: “${n}”.`));
    if (st.size > 16 * 1024 * 1024) throw new ModelError('too-big', L(`Файл «${n}» слишком большой.`, `The file “${n}” is too large.`));
    entries.push({ name: n, size: st.size, data: readFileSync(p) });
  }
  return writePack(validatePack(entries, basename(dir)), o);
}

/** Removes a USER model (never a bundled one); the id is checked so nothing outside the user models folder can be touched. */
export function removeModel(id: string, o: { userDir: string; bundledDir: string }): void {
  if (!MODEL_ID.test(id)) throw new ModelError('bad-id', L('Некорректный идентификатор модели.', 'Invalid model id.'));
  if (listModels(o.bundledDir, join(o.userDir, '__none__')).some((m) => m.id === id)) throw new ModelError('bundled', L('Встроенную модель удалить нельзя.', 'A built-in model cannot be removed.'));
  const target = resolve(o.userDir, id);
  if (!target.startsWith(resolve(o.userDir) + sep)) throw new ModelError('unsafe-path', L('Небезопасный путь.', 'Unsafe path.'));
  if (!existsSync(target)) throw new ModelError('missing', L('Такой модели нет.', 'There is no such model.'));
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
