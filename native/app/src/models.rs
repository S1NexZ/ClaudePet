//! Pet models: an in-memory ZIP reader with strict limits, pack validation, the registry of installed models and atomic installation.
//! A port of ui/src/models/{zip,images,registry,install}.ts. Nothing in a pack is ever executed; the archive is fully checked in memory
//! before anything is written, and an install goes into a temp folder first and is renamed into place (never overwriting).
//! User-facing texts come in ru/en/zh like the TS `L(...)`: every public function takes `lang` ("ru" | "en" | "zh"; anything else = ru).

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// A problem the user can act on: `.0` is the text for the UI, `.1` a stable code (as in the TS `ModelError.code`).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelError(pub String, pub &'static str);

/// `Model` carries user-facing text; `Other` is an unexpected failure (I/O) whose text is for logs.
#[derive(Debug, Clone, PartialEq)]
pub enum Error { Model(ModelError), Other(String) }
impl From<ModelError> for Error { fn from(e: ModelError) -> Self { Error::Model(e) } }
impl std::fmt::Display for ModelError { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) } }
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { match self { Error::Model(e) => e.fmt(f), Error::Other(s) => f.write_str(s) } }
}
impl std::error::Error for ModelError {}
impl std::error::Error for Error {}

/// L("ru", "en", "zh") for a language code.
macro_rules! t {
    ($lang:expr, $ru:expr, $en:expr, $zh:expr) => {
        match $lang { "en" => ($en).to_string(), "zh" => ($zh).to_string(), _ => ($ru).to_string() }
    };
}
macro_rules! err {
    ($lang:expr, $code:expr, $ru:expr, $en:expr, $zh:expr) => { ModelError(t!($lang, $ru, $en, $zh), $code) };
}

// ---------------------------------------------------------------- images

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageSize { pub w: u32, pub h: u32, pub format: &'static str }

fn be32(b: &[u8], i: usize) -> u32 { u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) }
fn le32(b: &[u8], i: usize) -> u32 { u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) }
fn le16(b: &[u8], i: usize) -> u32 { u16::from_le_bytes([b[i], b[i + 1]]) as u32 }
fn le24(b: &[u8], i: usize) -> u32 { b[i] as u32 | (b[i + 1] as u32) << 8 | (b[i + 2] as u32) << 16 }

/// Pixel size of a WebP (VP8 / VP8L / VP8X) or PNG, read from the header only; None for anything else.
pub fn image_size(b: &[u8]) -> Option<ImageSize> {
    if b.len() >= 24 && be32(b, 0) == 0x89504e47 && be32(b, 4) == 0x0d0a1a0a && &b[12..16] == b"IHDR" {
        return Some(ImageSize { w: be32(b, 16), h: be32(b, 20), format: "png" });
    }
    if b.len() >= 30 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        match &b[12..16] {
            b"VP8X" => return Some(ImageSize { w: 1 + le24(b, 24), h: 1 + le24(b, 27), format: "webp" }),
            b"VP8L" if b[20] == 0x2f => { let v = le32(b, 21); return Some(ImageSize { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1, format: "webp" }); }
            b"VP8 " if b[23] == 0x9d && b[24] == 0x01 && b[25] == 0x2a => return Some(ImageSize { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff, format: "webp" }),
            _ => {}
        }
    }
    None
}
/// The atlas the pet's animator is built for: 8 columns of 192x208 cells and 9 rows (1536x1872) or, for v2 packs, 11 rows (1536x2288).
pub const SHEET: (u32, u32) = (1536, 1872);
pub const SHEET_V2_H: u32 = 2288;
pub fn sheet_size_ok(s: &ImageSize) -> bool { s.w == SHEET.0 && (s.h == SHEET.1 || s.h == SHEET_V2_H) }

// ---------------------------------------------------------------- zip

#[derive(Debug, Clone, PartialEq)]
pub struct ZipEntry { pub name: String, pub size: usize, pub data: Vec<u8> }
#[derive(Debug, Clone, Copy)]
pub struct ZipLimits { pub max_entries: usize, pub max_file_bytes: usize, pub max_total_bytes: usize }
pub const DEFAULT_LIMITS: ZipLimits = ZipLimits { max_entries: 32, max_file_bytes: 16 * 1024 * 1024, max_total_bytes: 32 * 1024 * 1024 };

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 { c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 }; k += 1; }
        t[n] = c;
        n += 1;
    }
    t
}
static CRC: [u32; 256] = crc_table();
pub fn crc32(b: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &x in b { c = CRC[((c ^ x as u32) & 255) as usize] ^ (c >> 8); }
    c ^ 0xffff_ffff
}

/// An entry name is safe only if it stays inside the target folder: no absolute paths, drive letters, backslashes,
/// NUL bytes, empty or ".." segments. Returns the normalized name.
pub fn safe_entry_name(raw: &str, lang: &str) -> Result<String, ModelError> {
    let bad = || {
        let shown: String = raw.chars().map(|c| if (' '..='~').contains(&c) || ('\u{400}'..='\u{4ff}').contains(&c) { c } else { '?' }).take(80).collect();
        err!(lang, "unsafe-path", format!("Небезопасный путь в архиве: «{shown}»"), format!("Unsafe path in the archive: “{shown}”"), format!("压缩包中的路径不安全：“{shown}”"))
    };
    let b = raw.as_bytes();
    if raw.is_empty() || raw.contains('\0') || raw.contains('\\') || raw.starts_with('/') || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') { return Err(bad()); }
    let mut parts: Vec<&str> = raw.split('/').collect();
    if parts.last() == Some(&"") { parts.pop(); } // a directory entry
    if parts.is_empty() || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") { return Err(bad()); }
    Ok(parts.join("/"))
}

fn mb(n: usize) -> u64 { (n as f64 / 1048576.0).round() as u64 }

/// Parses the archive and returns its files (directories dropped). Every failure is a ModelError with a user-readable message.
pub fn read_zip(buf: &[u8], limits: &ZipLimits, lang: &str) -> Result<Vec<ZipEntry>, ModelError> {
    let zip64 = || err!(lang, "zip64", "ZIP64-архивы не поддерживаются.", "ZIP64 archives are not supported.", "不支持 ZIP64 压缩包。");
    if buf.len() < 22 { return Err(err!(lang, "not-zip", "Файл не похож на ZIP-архив.", "The file does not look like a ZIP archive.", "该文件看起来不是 ZIP 压缩包。")); }
    let lo = (buf.len() - 22).saturating_sub(65535);
    let eocd = (lo..=buf.len() - 22).rev().find(|&i| le32(buf, i) == 0x06054b50)
        .ok_or_else(|| err!(lang, "not-zip", "Файл не похож на ZIP-архив (нет оглавления).", "The file does not look like a ZIP archive (no directory).", "该文件看起来不是 ZIP 压缩包（没有目录）。"))?;
    let count = le16(buf, eocd + 10) as usize;
    let (cd_size, cd_off) = (le32(buf, eocd + 12), le32(buf, eocd + 16));
    if count == 0xffff || cd_size == 0xffff_ffff || cd_off == 0xffff_ffff { return Err(zip64()); }
    if count > limits.max_entries {
        return Err(err!(lang, "too-many", format!("В архиве слишком много файлов ({count}, допустимо {}).", limits.max_entries), format!("The archive has too many files ({count}, at most {}).", limits.max_entries), format!("压缩包文件过多（{count} 个，最多 {} 个）。", limits.max_entries)));
    }
    if cd_off as u64 + cd_size as u64 > buf.len() as u64 {
        return Err(err!(lang, "corrupt", "Архив повреждён (оглавление выходит за границы файла).", "The archive is damaged (the directory runs past the end of the file).", "压缩包已损坏（目录超出文件末尾）。"));
    }

    let mut out: Vec<ZipEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let (mut total, mut p) = (0usize, cd_off as usize);
    for _ in 0..count {
        if p + 46 > buf.len() || le32(buf, p) != 0x02014b50 { return Err(err!(lang, "corrupt", "Архив повреждён (запись оглавления).", "The archive is damaged (directory entry).", "压缩包已损坏（目录条目）。")); }
        let (made_by, flags, method) = (le16(buf, p + 4), le16(buf, p + 8), le16(buf, p + 10));
        let (crc, csize, usize_) = (le32(buf, p + 16), le32(buf, p + 20), le32(buf, p + 24));
        let (name_len, extra_len, comment_len) = (le16(buf, p + 28) as usize, le16(buf, p + 30) as usize, le16(buf, p + 32) as usize);
        let (ext_attr, local_off) = (le32(buf, p + 38), le32(buf, p + 42) as usize);
        if p + 46 + name_len > buf.len() { return Err(err!(lang, "corrupt", "Архив повреждён (имя файла).", "The archive is damaged (file name).", "压缩包已损坏（文件名）。")); }
        let raw_name = String::from_utf8_lossy(&buf[p + 46..p + 46 + name_len]).into_owned();
        p += 46 + name_len + extra_len + comment_len;

        let name = safe_entry_name(&raw_name, lang)?;
        if raw_name.ends_with('/') { continue; } // directory
        if (made_by >> 8) == 3 && ((ext_attr >> 16) & 0xf000) == 0xa000 {
            return Err(err!(lang, "symlink", format!("Ссылки внутри архива запрещены: «{name}»"), format!("Links inside the archive are not allowed: “{name}”"), format!("压缩包内不允许链接：“{name}”")));
        }
        if flags & 1 != 0 { return Err(err!(lang, "encrypted", "Зашифрованные архивы не поддерживаются.", "Encrypted archives are not supported.", "不支持加密的压缩包。")); }
        if method != 0 && method != 8 {
            return Err(err!(lang, "method", format!("Неподдерживаемый способ сжатия в «{name}»."), format!("Unsupported compression method in “{name}”."), format!("“{name}”使用了不支持的压缩方法。")));
        }
        if csize == 0xffff_ffff || usize_ == 0xffff_ffff { return Err(zip64()); }
        let usize_ = usize_ as usize;
        if usize_ > limits.max_file_bytes {
            let (m, mx) = (mb(usize_), mb(limits.max_file_bytes));
            return Err(err!(lang, "too-big", format!("Файл «{name}» слишком большой ({m} МБ, допустимо {mx} МБ)."), format!("The file “{name}” is too large ({m} MB, at most {mx} MB)."), format!("文件“{name}”太大（{m} MB，最大 {mx} MB）。")));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(err!(lang, "duplicate", format!("В архиве повторяется файл «{name}»."), format!("The file “{name}” appears twice in the archive."), format!("文件“{name}”在压缩包中出现了两次。")));
        }
        total += usize_;
        if total > limits.max_total_bytes { return Err(err!(lang, "too-big", "Архив слишком большой после распаковки.", "The archive is too large once unpacked.", "解压后压缩包太大。")); }

        if local_off + 30 > buf.len() || le32(buf, local_off) != 0x04034b50 {
            return Err(err!(lang, "corrupt", format!("Архив повреждён (локальный заголовок «{name}»)."), format!("The archive is damaged (local header of “{name}”)."), format!("压缩包已损坏（“{name}”的本地头）。")));
        }
        let data_start = local_off + 30 + le16(buf, local_off + 26) as usize + le16(buf, local_off + 28) as usize;
        if data_start + csize as usize > buf.len() {
            return Err(err!(lang, "corrupt", format!("Архив повреждён (данные «{name}» обрезаны)."), format!("The archive is damaged (data of “{name}” is truncated)."), format!("压缩包已损坏（“{name}”的数据被截断）。")));
        }
        let raw = &buf[data_start..data_start + csize as usize];
        let data = if method == 0 { raw.to_vec() } else {
            miniz_oxide::inflate::decompress_to_vec_with_limit(raw, limits.max_file_bytes + 1).map_err(|_| {
                err!(lang, "corrupt", format!("Не удалось распаковать «{name}» (повреждённые данные или «бомба»)."), format!("Could not unpack “{name}” (corrupt data or a decompression bomb)."), format!("无法解压“{name}”（数据损坏或解压炸弹）。"))
            })?
        };
        if data.len() != usize_ {
            return Err(err!(lang, "corrupt", format!("Размер «{name}» не совпадает с оглавлением."), format!("The size of “{name}” does not match the directory."), format!("“{name}”的大小与目录不符。")));
        }
        if crc32(&data) != crc {
            return Err(err!(lang, "corrupt", format!("Контрольная сумма «{name}» не совпадает: архив повреждён."), format!("The checksum of “{name}” does not match: the archive is damaged."), format!("“{name}”的校验和不匹配：压缩包已损坏。")));
        }
        out.push(ZipEntry { name, size: data.len(), data });
    }
    Ok(out)
}

// ---------------------------------------------------------------- registry

/// Model ids are folder names: plain, lowercase, no separators, so an id can never address anything outside the models folders.
pub fn is_model_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 40 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}
pub const DEFAULT_MODEL: &str = "claude-maiden";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// where the pack says it comes from (pet.json "source"), if it does
    pub source: String,
    /// shipped with the app (read-only) or installed by the user (can be removed)
    pub bundled: bool,
    pub dir: PathBuf,
}

/// The default pack calls itself "Claude娘": the app shows it as "cPet" (trademark guidelines); the id stays so settings still point at it.
fn bundled_name(id: &str) -> Option<(&'static str, &'static str)> {
    (id == "claude-maiden").then_some(("cPet", "An orange-haired, amber-eyed girl with a book: the default ccPet."))
}

fn read_meta(dir: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    match serde_json::from_str::<serde_json::Value>(&fs::read_to_string(dir.join("pet.json")).ok()?).ok()? { serde_json::Value::Object(m) => Some(m), _ => None }
}
fn jstr(m: &serde_json::Map<String, serde_json::Value>, k: &str, max: usize) -> String {
    m.get(k).and_then(|v| v.as_str()).map(|s| s.chars().take(max).collect()).unwrap_or_default()
}

fn scan(root: &Path, bundled: bool) -> Vec<ModelInfo> {
    let Ok(rd) = fs::read_dir(root) else { return vec![] };
    let mut ids: Vec<String> = rd.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
    ids.sort();
    let mut out = vec![];
    for id in ids {
        if !is_model_id(&id) { continue; } // ".tmp-…" leftovers and anything odd are not models
        let dir = root.join(&id);
        if !fs::metadata(&dir).map(|m| m.is_dir()).unwrap_or(false) { continue; }
        let Some(m) = read_meta(&dir) else { continue };
        let own = if bundled { bundled_name(&id) } else { None };
        let dn = jstr(&m, "displayName", 80);
        out.push(ModelInfo {
            name: own.map(|o| o.0.to_string()).unwrap_or(if dn.is_empty() { id.clone() } else { dn }),
            description: own.map(|o| o.1.to_string()).unwrap_or_else(|| jstr(&m, "description", 300)),
            source: jstr(&m, "source", 80), bundled, dir, id,
        });
    }
    out
}

/// Bundled models first, then the user's; a user model never shadows a bundled id.
pub fn list_models(bundled_dir: &Path, user_dir: &Path) -> Vec<ModelInfo> {
    let mut b = scan(bundled_dir, true);
    let taken: HashSet<String> = b.iter().map(|m| m.id.clone()).collect();
    b.extend(scan(user_dir, false).into_iter().filter(|m| !taken.contains(&m.id)));
    b
}

/// The model to use: the chosen one if it is installed, else the default, else the first available, else None.
pub fn pick_model<'a>(models: &'a [ModelInfo], chosen: Option<&str>) -> Option<&'a ModelInfo> {
    chosen.and_then(|c| models.iter().find(|m| m.id == c)).or_else(|| models.iter().find(|m| m.id == DEFAULT_MODEL)).or(models.first())
}

// ---------------------------------------------------------------- install

const MAX_JSON: usize = 64 * 1024;
const MAX_DOC: usize = 64 * 1024;
const MAX_SHEET: usize = 16 * 1024 * 1024;
const MAX_ZIP: u64 = 40 * 1024 * 1024;
const RISKY_EXT: &[&str] = &[".exe", ".dll", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".js", ".mjs", ".cjs", ".jar", ".sh", ".msi", ".lnk", ".scr", ".com", ".py", ".node", ".html", ".htm", ".svg"];

/// A validated pack: `files` keeps archive order, every name is a plain file name.
#[derive(Debug)]
pub struct PackFiles { pub id: String, pub name: String, pub files: Vec<(String, Vec<u8>)> }

/// node's path.extname for a plain name: from the last dot, none for ".hidden" or no dot; lowercased.
fn extname(n: &str) -> String {
    match n.rfind('.') { Some(i) if i > 0 => n[i..].to_lowercase(), _ => String::new() }
}

/// Doc files: readme / license / licence / notice / credits / attribution, optionally .md or .txt (case-insensitive).
fn is_doc_file(n: &str) -> bool {
    let l = n.to_lowercase();
    let stem = l.strip_suffix(".md").or_else(|| l.strip_suffix(".txt")).unwrap_or(&l);
    ["readme", "license", "licence", "notice", "credits", "attribution"].contains(&stem)
}

/// `foo.codex-pet.zip` / `My Pet.zip` -> `foo` / `my-pet` (used only when pet.json has no usable id).
pub fn slug_from_name(n: &str) -> String {
    let l = n.to_lowercase();
    let l = l.strip_suffix(".codex-pet.zip").or_else(|| l.strip_suffix(".zip")).unwrap_or(&l);
    let mut s = String::new();
    for c in l.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() { s.push(c); } else if !s.ends_with('-') { s.push('-'); }
    }
    s.trim_matches('-').chars().take(40).collect()
}

/// Drops a single wrapper folder ("pet/pet.json" -> "pet.json") when every file lives in it.
fn unwrap_dir(entries: Vec<ZipEntry>) -> Vec<ZipEntry> {
    let Some(first) = entries.first().map(|e| e.name.split('/').next().unwrap_or("").to_string()) else { return entries };
    if entries.iter().all(|e| e.name.contains('/') && e.name.split('/').next() == Some(first.as_str())) {
        return entries.into_iter().map(|e| ZipEntry { name: e.name[first.len() + 1..].to_string(), ..e }).collect();
    }
    entries
}

/// Validates a set of files as a pet pack: only pet.json, tweaks.json, one spritesheet (.webp/.png, 1536x1872 or 1536x2288),
/// and plain text docs; no subfolders, no scripts or other file types.
pub fn validate_pack(raw: Vec<ZipEntry>, fallback_id: &str, lang: &str) -> Result<PackFiles, ModelError> {
    let entries = unwrap_dir(raw);
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for e in entries {
        if e.name.contains('/') {
            return Err(err!(lang, "nested", format!("Вложенные папки не поддерживаются: «{}». Файлы модели должны лежать в корне архива.", e.name), format!("Nested folders are not supported: “{}”. Model files must sit in the archive root.", e.name), format!("不支持嵌套文件夹：“{}”。模型文件必须位于压缩包根目录。", e.name)));
        }
        if RISKY_EXT.contains(&extname(&e.name).as_str()) {
            return Err(err!(lang, "risky", format!("В архиве есть исполняемый или скриптовый файл «{}». Такие архивы не устанавливаются.", e.name), format!("The archive contains an executable or script file “{}”. Such archives are not installed.", e.name), format!("压缩包含有可执行文件或脚本文件“{}”。此类压缩包不会被安装。", e.name)));
        }
        files.retain(|(n, _)| *n != e.name); // a Map keeps the last value for a name
        files.push((e.name, e.data));
    }
    let get = |n: &str| files.iter().find(|(k, _)| k == n).map(|(_, v)| v);
    let Some(pet_json) = get("pet.json") else {
        return Err(err!(lang, "no-pet-json", "В архиве нет файла pet.json: это не модель питомца формата Codex.", "The archive has no pet.json: this is not a Codex-format pet model.", "压缩包中没有 pet.json：这不是 Codex 格式的宠物模型。"));
    };
    if pet_json.len() > MAX_JSON { return Err(err!(lang, "too-big", "pet.json слишком большой.", "pet.json is too large.", "pet.json 太大。")); }
    let meta = match serde_json::from_slice::<serde_json::Value>(pet_json) {
        Ok(serde_json::Value::Object(m)) => m,
        Ok(_) => return Err(err!(lang, "bad-pet-json", "pet.json должен быть объектом.", "pet.json must be an object.", "pet.json 必须是一个对象。")),
        Err(_) => return Err(err!(lang, "bad-pet-json", "pet.json не является корректным JSON.", "pet.json is not valid JSON.", "pet.json 不是有效的 JSON。")),
    };

    let sheet_name = meta.get("spritesheetPath").and_then(|v| v.as_str()).unwrap_or("spritesheet.webp").to_string();
    if sheet_name.contains('/') || sheet_name.contains('\\') || ![".webp", ".png"].contains(&extname(&sheet_name).as_str()) {
        let s: String = sheet_name.chars().take(60).collect();
        return Err(err!(lang, "bad-sheet-path", format!("Лист спрайтов указан неверно: «{s}» (нужен файл .webp или .png в корне архива)."), format!("The sprite sheet is specified incorrectly: “{s}” (a .webp or .png file in the archive root is required)."), format!("雪碧图指定有误：“{s}”（需要压缩包根目录中的 .webp 或 .png 文件）。")));
    }
    let Some(sheet) = get(&sheet_name) else {
        return Err(err!(lang, "no-sheet", format!("В архиве нет листа спрайтов «{sheet_name}», указанного в pet.json."), format!("The archive has no sprite sheet “{sheet_name}” named in pet.json."), format!("压缩包中没有 pet.json 指定的雪碧图“{sheet_name}”。")));
    };
    if sheet.len() > MAX_SHEET { return Err(err!(lang, "too-big", "Лист спрайтов слишком большой.", "The sprite sheet is too large.", "雪碧图太大。")); }
    let Some(size) = image_size(sheet) else {
        return Err(err!(lang, "bad-image", format!("«{sheet_name}» не является корректным WebP или PNG."), format!("“{sheet_name}” is not a valid WebP or PNG."), format!("“{sheet_name}”不是有效的 WebP 或 PNG。")));
    };
    if !sheet_size_ok(&size) {
        let (w, h, v2) = (size.w, size.h, SHEET_V2_H);
        return Err(err!(lang, "bad-size", format!("Размер листа {w}×{h}, а нужен {}×{} или {}×{v2} (сетка 8 столбцов × 9 или 11 строк ячеек 192×208, как у паков Codex).", SHEET.0, SHEET.1, SHEET.0), format!("The sheet is {w}×{h}, but {}×{} or {}×{v2} is required (8 columns × 9 or 11 rows of 192×208 cells, like Codex packs).", SHEET.0, SHEET.1, SHEET.0), format!("图片尺寸为 {w}×{h}，但需要 {}×{} 或 {}×{v2}（8 列 × 9 或 11 行，每格 192×208，与 Codex 宠物包相同）。", SHEET.0, SHEET.1, SHEET.0)));
    }

    for (name, data) in &files {
        if name == "pet.json" || *name == sheet_name || name == "tweaks.json" { continue; }
        if is_doc_file(name) {
            if data.len() > MAX_DOC { return Err(err!(lang, "too-big", format!("«{name}» слишком большой."), format!("“{name}” is too large."), format!("“{name}”太大。"))); }
            continue;
        }
        return Err(err!(lang, "unsupported-file", format!("Неподдерживаемый файл в архиве: «{name}». Допустимы pet.json, лист спрайтов, tweaks.json и текстовые README/LICENSE."), format!("Unsupported file in the archive: “{name}”. Only pet.json, the sprite sheet, tweaks.json and text README/LICENSE files are allowed."), format!("压缩包中有不支持的文件：“{name}”。只允许 pet.json、雪碧图、tweaks.json 以及文本 README/LICENSE 文件。")));
    }
    if let Some(tw) = get("tweaks.json") {
        if tw.len() > MAX_JSON { return Err(err!(lang, "too-big", "tweaks.json слишком большой.", "tweaks.json is too large.", "tweaks.json 太大。")); }
        if serde_json::from_slice::<serde_json::Value>(tw).is_err() { return Err(err!(lang, "bad-tweaks", "tweaks.json не является корректным JSON.", "tweaks.json is not valid JSON.", "tweaks.json 不是有效的 JSON。")); }
    }

    let wanted = meta.get("id").and_then(|v| v.as_str()).map(|s| s.to_lowercase()).unwrap_or_default();
    let id = if is_model_id(&wanted) { wanted } else { slug_from_name(fallback_id) };
    if !is_model_id(&id) {
        return Err(err!(lang, "bad-id", "Не удалось определить идентификатор модели: в pet.json нет подходящего id (латиница, цифры, дефис).", "Could not determine the model id: pet.json has no suitable id (Latin letters, digits, hyphen).", "无法确定模型 id：pet.json 中没有合适的 id（拉丁字母、数字、连字符）。"));
    }
    let dn = meta.get("displayName").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());
    let name = dn.map(|s| s.chars().take(80).collect()).unwrap_or_else(|| id.clone());
    Ok(PackFiles { id, name, files })
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress { pub step: &'static str, pub percent: u32, pub message: String }

pub struct InstallOpts<'a> {
    pub user_dir: &'a Path,
    pub bundled_dir: &'a Path,
    /// "ru" | "en" | "zh"
    pub lang: &'a str,
    pub on_progress: Option<&'a dyn Fn(InstallProgress)>,
}
impl InstallOpts<'_> {
    fn prog(&self, step: &'static str, percent: u32, message: String) { if let Some(f) = self.on_progress { f(InstallProgress { step, percent, message }); } }
}

fn unique_tmp(user_dir: &Path) -> Result<PathBuf, Error> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    for _ in 0..20 {
        let p = user_dir.join(format!(".tmp-{:x}{:x}{:x}", std::process::id(), nanos as u64 ^ ((nanos >> 64) as u64), N.fetch_add(1, Ordering::Relaxed)));
        match fs::create_dir(&p) { Ok(()) => return Ok(p), Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue, Err(e) => return Err(Error::Other(format!("create temp folder: {e}"))) }
    }
    Err(Error::Other("could not create a temp folder".into()))
}

/// Writes a validated pack as <user_dir>/<id>/ atomically (temp folder + rename). Never overwrites an existing model.
pub fn write_pack(pack: &PackFiles, o: &InstallOpts) -> Result<ModelInfo, Error> {
    let lang = o.lang;
    if let Some(taken) = list_models(o.bundled_dir, o.user_dir).into_iter().find(|m| m.id == pack.id) {
        let id = &pack.id;
        return Err(if taken.bundled { err!(lang, "exists", format!("Модель «{id}» уже встроена в приложение."), format!("The model “{id}” is already built into the app."), format!("模型“{id}”已内置于应用中。")) }
        else { err!(lang, "exists", format!("Модель «{id}» уже установлена. Сначала удалите её, если хотите заменить."), format!("The model “{id}” is already installed. Remove it first if you want to replace it."), format!("模型“{id}”已安装。如需替换，请先将其移除。")) }.into());
    }
    fs::create_dir_all(o.user_dir).map_err(|e| Error::Other(format!("create models folder: {e}")))?;
    let target = o.user_dir.join(&pack.id);
    if target.exists() {
        let id = &pack.id;
        return Err(err!(lang, "exists", format!("Папка модели «{id}» уже существует."), format!("The model folder “{id}” already exists."), format!("模型文件夹“{id}”已存在。")).into());
    }
    let tmp = unique_tmp(o.user_dir)?;
    let written: Result<(), Error> = (|| {
        for (n, (name, data)) in pack.files.iter().enumerate() {
            // defence in depth: validate_pack only yields plain names
            if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0', ':']) { return Err(err!(lang, "unsafe-path", "Небезопасный путь при записи.", "Unsafe path while writing.", "写入时路径不安全。").into()); }
            let mut f = fs::OpenOptions::new().write(true).create_new(true).open(tmp.join(name)).map_err(|e| Error::Other(format!("write {name}: {e}")))?;
            f.write_all(data).map_err(|e| Error::Other(format!("write {name}: {e}")))?;
            o.prog("write", 60 + (((n + 1) as f64 / pack.files.len() as f64) * 35.0).round() as u32, t!(lang, format!("Запись: {name}"), format!("Writing: {name}"), format!("正在写入：{name}")));
        }
        fs::rename(&tmp, &target).map_err(|e| Error::Other(format!("rename: {e}")))
    })();
    if let Err(e) = written { let _ = fs::remove_dir_all(&tmp); return Err(e); }
    o.prog("done", 100, t!(lang, "Готово", "Done", "完成"));
    list_models(o.bundled_dir, o.user_dir).into_iter().find(|m| m.id == pack.id)
        .ok_or_else(|| err!(lang, "corrupt", "Модель записана, но не читается.", "The model was written but cannot be read.", "模型已写入但无法读取。").into())
}

/// Installs a .zip file: size-checked, read and validated in memory first, then written atomically.
pub fn install_model_from_zip(zip_path: &Path, o: &InstallOpts) -> Result<ModelInfo, Error> {
    let lang = o.lang;
    o.prog("read", 5, t!(lang, "Чтение архива", "Reading the archive", "正在读取压缩包"));
    let st = fs::metadata(zip_path).map_err(|_| err!(lang, "unreadable", "Не удалось открыть файл.", "Could not open the file.", "无法打开文件。"))?;
    if !st.is_file() { return Err(err!(lang, "unreadable", "Выбран не файл.", "The selection is not a file.", "所选内容不是文件。").into()); }
    if st.len() > MAX_ZIP {
        let (m, mx) = (mb(st.len() as usize), MAX_ZIP / 1048576);
        return Err(err!(lang, "too-big", format!("Архив слишком большой ({m} МБ, допустимо {mx} МБ)."), format!("The archive is too large ({m} MB, at most {mx} MB)."), format!("压缩包太大（{m} MB，最大 {mx} MB）。")).into());
    }
    let buf = fs::read(zip_path).map_err(|_| err!(lang, "unreadable", "Не удалось прочитать файл.", "Could not read the file.", "无法读取文件。"))?;
    o.prog("check", 20, t!(lang, "Проверка содержимого", "Checking the contents", "正在检查内容"));
    let base = zip_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let pack = validate_pack(read_zip(&buf, &DEFAULT_LIMITS, lang)?, &base, lang)?;
    o.prog("check", 55, t!(lang, "Архив корректен", "The archive is valid", "压缩包有效"));
    write_pack(&pack, o)
}

/// A pack that is already a folder (e.g. what an npm pet installer put in ~/.codex/pets/<id>): same rules, symlinks refused.
pub fn install_model_from_dir(dir: &Path, o: &InstallOpts) -> Result<ModelInfo, Error> {
    let lang = o.lang;
    let mut names: Vec<String> = fs::read_dir(dir)
        .map_err(|_| err!(lang, "unreadable", "Не удалось открыть папку модели.", "Could not open the model folder.", "无法打开模型文件夹。"))?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned())).collect();
    names.sort();
    if names.len() > 32 { return Err(err!(lang, "too-many", "В папке слишком много файлов.", "The folder has too many files.", "文件夹中的文件过多。").into()); }
    let mut entries = Vec::new();
    for n in names {
        let p = dir.join(&n);
        let st = fs::symlink_metadata(&p).map_err(|e| Error::Other(format!("stat {n}: {e}")))?;
        if st.file_type().is_symlink() { return Err(err!(lang, "symlink", format!("Ссылки запрещены: «{n}»"), format!("Links are not allowed: “{n}”"), format!("不允许链接：“{n}”")).into()); }
        if st.is_dir() { return Err(err!(lang, "nested", format!("Вложенные папки не поддерживаются: «{n}»."), format!("Nested folders are not supported: “{n}”."), format!("不支持嵌套文件夹：“{n}”。")).into()); }
        if st.len() > 16 * 1024 * 1024 { return Err(err!(lang, "too-big", format!("Файл «{n}» слишком большой."), format!("The file “{n}” is too large."), format!("文件“{n}”太大。")).into()); }
        let data = fs::read(&p).map_err(|e| Error::Other(format!("read {n}: {e}")))?;
        entries.push(ZipEntry { name: n, size: data.len(), data });
    }
    let base = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    write_pack(&validate_pack(entries, &base, lang)?, o)
}

/// Removes a USER model (never a bundled one); the id is checked so nothing outside the user models folder can be touched.
pub fn remove_model(id: &str, user_dir: &Path, bundled_dir: &Path, lang: &str) -> Result<(), Error> {
    if !is_model_id(id) { return Err(err!(lang, "bad-id", "Некорректный идентификатор модели.", "Invalid model id.", "模型 id 无效。").into()); }
    if list_models(bundled_dir, &user_dir.join("__none__")).iter().any(|m| m.id == id) { return Err(err!(lang, "bundled", "Встроенную модель удалить нельзя.", "A built-in model cannot be removed.", "内置模型无法删除。").into()); }
    let target = user_dir.join(id);
    if !target.exists() { return Err(err!(lang, "missing", "Такой модели нет.", "There is no such model.", "没有这个模型。").into()); }
    fs::remove_dir_all(&target).map_err(|e| Error::Other(format!("remove {id}: {e}")))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FoundPet { pub id: String, pub name: String, pub dir: PathBuf }

/// Pet folders an npm pet installer left in <dir> (~/.codex/pets): looked at only, nothing is run or changed.
pub fn scan_pet_folder(dir: &Path) -> Vec<FoundPet> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    let mut names: Vec<String> = rd.filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned())).collect();
    names.sort();
    let mut out = vec![];
    for n in names {
        let p = dir.join(&n);
        if !fs::symlink_metadata(&p).map(|m| m.is_dir()).unwrap_or(false) { continue; }
        let Some(m) = read_meta(&p) else { continue };
        let id = match m.get("id") { Some(serde_json::Value::String(s)) => s.to_lowercase(), Some(serde_json::Value::Number(x)) => x.to_string(), _ => String::new() };
        let dn = m.get("displayName").and_then(|v| v.as_str()).map(|s| s.chars().take(80).collect::<String>());
        out.push(FoundPet { id: if is_model_id(&id) { id } else { slug_from_name(&n) }, name: dn.unwrap_or_else(|| n.clone()), dir: p });
    }
    out
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn tmp() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!("ccpet-models-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[derive(Default, Clone)]
    struct ZEntryT { name: String, data: Vec<u8>, deflate: bool, flags: u16, unix_mode: Option<u32>, crc: Option<u32>, usize_: Option<u32> }
    fn ze(name: &str, data: impl AsRef<[u8]>) -> ZEntryT { ZEntryT { name: name.into(), data: data.as_ref().to_vec(), ..Default::default() } }

    fn make_zip(entries: &[ZEntryT]) -> Vec<u8> {
        let (mut locals, mut central, mut off) = (Vec::new(), Vec::new(), 0u32);
        for e in entries {
            let comp = if e.deflate { miniz_oxide::deflate::compress_to_vec(&e.data, 6) } else { e.data.clone() };
            let name = e.name.as_bytes();
            let (crc, usz) = (e.crc.unwrap_or_else(|| crc32(&e.data)), e.usize_.unwrap_or(e.data.len() as u32));
            let method: u16 = if e.deflate { 8 } else { 0 };
            let mut lh = vec![0u8; 30];
            lh[0..4].copy_from_slice(&0x04034b50u32.to_le_bytes()); lh[4..6].copy_from_slice(&20u16.to_le_bytes());
            lh[6..8].copy_from_slice(&e.flags.to_le_bytes()); lh[8..10].copy_from_slice(&method.to_le_bytes());
            lh[14..18].copy_from_slice(&crc.to_le_bytes()); lh[18..22].copy_from_slice(&(comp.len() as u32).to_le_bytes());
            lh[22..26].copy_from_slice(&usz.to_le_bytes()); lh[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
            lh.extend_from_slice(name);
            let mut ch = vec![0u8; 46];
            ch[0..4].copy_from_slice(&0x02014b50u32.to_le_bytes());
            ch[4..6].copy_from_slice(&(if e.unix_mode.is_some() { (3u16 << 8) | 20 } else { 20 }).to_le_bytes()); ch[6..8].copy_from_slice(&20u16.to_le_bytes());
            ch[8..10].copy_from_slice(&e.flags.to_le_bytes()); ch[10..12].copy_from_slice(&method.to_le_bytes());
            ch[16..20].copy_from_slice(&crc.to_le_bytes()); ch[20..24].copy_from_slice(&(comp.len() as u32).to_le_bytes());
            ch[24..28].copy_from_slice(&usz.to_le_bytes()); ch[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
            if let Some(m) = e.unix_mode { ch[38..42].copy_from_slice(&(m << 16).to_le_bytes()); }
            ch[42..46].copy_from_slice(&off.to_le_bytes());
            ch.extend_from_slice(name);
            off += (lh.len() + comp.len()) as u32;
            locals.extend_from_slice(&lh); locals.extend_from_slice(&comp); central.extend_from_slice(&ch);
        }
        let mut eocd = vec![0u8; 22];
        eocd[0..4].copy_from_slice(&0x06054b50u32.to_le_bytes());
        eocd[8..10].copy_from_slice(&(entries.len() as u16).to_le_bytes()); eocd[10..12].copy_from_slice(&(entries.len() as u16).to_le_bytes());
        eocd[12..16].copy_from_slice(&(central.len() as u32).to_le_bytes()); eocd[16..20].copy_from_slice(&off.to_le_bytes());
        [locals, central, eocd].concat()
    }

    fn fake_webp(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0u8; 94];
        b[0..4].copy_from_slice(b"RIFF"); let l = (b.len() - 8) as u32; b[4..8].copy_from_slice(&l.to_le_bytes());
        b[8..16].copy_from_slice(b"WEBPVP8L"); let l = (b.len() - 20) as u32; b[16..20].copy_from_slice(&l.to_le_bytes());
        b[20] = 0x2f; b[21..25].copy_from_slice(&(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)).to_le_bytes());
        b
    }
    fn fake_png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0u8; 33];
        b[0..8].copy_from_slice(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); b[8..12].copy_from_slice(&13u32.to_be_bytes());
        b[12..16].copy_from_slice(b"IHDR"); b[16..20].copy_from_slice(&w.to_be_bytes()); b[20..24].copy_from_slice(&h.to_be_bytes());
        b
    }
    fn good_pack_json(json: &str, sheet: Vec<u8>) -> Vec<ZEntryT> { vec![ze("pet.json", json), ze("spritesheet.webp", sheet)] }
    fn good_pack() -> Vec<ZEntryT> { good_pack_id("my-pet") }
    fn good_pack_id(id: &str) -> Vec<ZEntryT> {
        good_pack_json(&format!(r#"{{"id":"{id}","displayName":"My Pet","description":"d","spritesheetPath":"spritesheet.webp","source":"test"}}"#), fake_webp(1536, 1872))
    }
    fn with(mut p: Vec<ZEntryT>, e: ZEntryT) -> Vec<ZEntryT> { p.push(e); p }

    fn zcode(entries: &[ZEntryT]) -> &'static str { match read_zip(&make_zip(entries), &DEFAULT_LIMITS, "en") { Ok(_) => "NO ERROR", Err(e) => e.1 } }
    fn ecode<T>(r: Result<T, impl Into<Error>>) -> &'static str { match r.map_err(Into::into) { Ok(_) => "NO ERROR", Err(Error::Model(e)) => e.1, Err(Error::Other(_)) => "other" } }
    fn validate(entries: &[ZEntryT], name: &str) -> Result<PackFiles, ModelError> { validate_pack(read_zip(&make_zip(entries), &DEFAULT_LIMITS, "en")?, name, "en") }
    fn zip_file(entries: &[ZEntryT]) -> PathBuf { let f = tmp().join("pack.codex-pet.zip"); fs::write(&f, make_zip(entries)).unwrap(); f }
    fn dirs() -> (PathBuf, PathBuf) { (tmp().join("user"), tmp()) }
    fn opts<'a>(d: &'a (PathBuf, PathBuf)) -> InstallOpts<'a> { InstallOpts { user_dir: &d.0, bundled_dir: &d.1, lang: "en", on_progress: None } }
    fn listing(p: &Path) -> Vec<String> { let mut v: Vec<String> = fs::read_dir(p).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect(); v.sort(); v }
    fn model_dir(base: &Path, id: &str, meta: &str) { fs::create_dir_all(base.join(id)).unwrap(); fs::write(base.join(id).join("pet.json"), meta).unwrap(); }
    fn model(base: &Path, id: &str) { model_dir(base, id, &format!(r#"{{"id":"{id}","displayName":"{}"}}"#, id.to_uppercase())); }

    #[test]
    fn safe_entry_name_cases() {
        assert_eq!(safe_entry_name("pet.json", "en").unwrap(), "pet.json");
        assert_eq!(safe_entry_name("dir/a.txt", "en").unwrap(), "dir/a.txt");
        assert_eq!(safe_entry_name("dir/", "en").unwrap(), "dir");
        for bad in ["../evil.txt", "a/../../evil", "/etc/passwd", "\\windows\\x", "a\\b", "C:/x", "c:evil", "..", ".", "a//b", "a/./b", "a\0b", "", "./x", "../"] {
            assert!(safe_entry_name(bad, "en").is_err(), "{bad:?}");
        }
    }

    #[test]
    fn read_zip_stored_and_deflated() {
        let z = read_zip(&make_zip(&[ze("a.txt", "hello"), ZEntryT { deflate: true, ..ze("b.txt", "world".repeat(100)) }]), &DEFAULT_LIMITS, "en").unwrap();
        assert_eq!(z.iter().map(|e| (e.name.as_str(), e.size)).collect::<Vec<_>>(), vec![("a.txt", 5), ("b.txt", 500)]);
        assert_eq!(z[0].data, b"hello");
        assert_eq!(z[1].data, "world".repeat(100).as_bytes());
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
    }

    #[test]
    fn read_zip_rejects_hostile_archives() {
        assert_eq!(zcode(&[ze("../evil.js", "x")]), "unsafe-path");
        assert_eq!(zcode(&[ze("a/../../evil", "x")]), "unsafe-path");
        assert_eq!(zcode(&[ze("/abs.txt", "x")]), "unsafe-path");
        assert_eq!(zcode(&[ze("C:/win.txt", "x")]), "unsafe-path");
        assert_eq!(zcode(&[ZEntryT { unix_mode: Some(0o120777), ..ze("link", "/etc/passwd") }]), "symlink");
        assert_eq!(zcode(&[ZEntryT { flags: 1, ..ze("a.txt", "x") }]), "encrypted");
        assert_eq!(zcode(&[ze("a.txt", "x"), ze("A.TXT", "y")]), "duplicate");
        assert_eq!(zcode(&[ZEntryT { crc: Some(1), ..ze("a.txt", "abc") }]), "corrupt");
        assert_eq!(zcode(&[ZEntryT { usize_: Some(99), ..ze("a.txt", "abc") }]), "corrupt");
        assert_eq!(read_zip(b"not a zip at all, really not", &DEFAULT_LIMITS, "en").unwrap_err().1, "not-zip");
        assert_eq!(read_zip(&[0u8; 5], &DEFAULT_LIMITS, "en").unwrap_err().1, "not-zip");
    }

    #[test]
    fn read_zip_limits_and_bombs() {
        let lim = |e, f, t| ZipLimits { max_entries: e, max_file_bytes: f, max_total_bytes: t };
        let code = |z: Vec<u8>, l: ZipLimits| read_zip(&z, &l, "en").unwrap_err().1;
        assert_eq!(code(make_zip(&(0..5).map(|i| ze(&format!("f{i}"), "x")).collect::<Vec<_>>()), lim(4, 1_000_000, 1_000_000)), "too-many");
        assert_eq!(code(make_zip(&[ze("big", vec![0u8; 2000])]), lim(9, 1000, 1_000_000)), "too-big");
        assert_eq!(code(make_zip(&[ze("a", vec![0u8; 800]), ze("b", vec![0u8; 800])]), lim(9, 1000, 1200)), "too-big");
        // tiny deflated data that claims to be small but inflates far beyond the limit
        let bomb = make_zip(&[ZEntryT { deflate: true, usize_: Some(10), ..ze("z", vec![0u8; 5_000_000]) }]);
        assert_eq!(code(bomb, lim(9, 100_000, 1_000_000)), "corrupt");
    }

    #[test]
    fn read_zip_truncated_or_tampered_directory() {
        let z = make_zip(&[ze("a.txt", "hello")]);
        assert!(read_zip(&z[..z.len() - 30], &DEFAULT_LIMITS, "en").is_err());
        let mut t = z.clone(); let n = t.len();
        t[n - 6..n - 2].copy_from_slice(&0xfffffff0u32.to_le_bytes());
        assert_eq!(read_zip(&t, &DEFAULT_LIMITS, "en").unwrap_err().1, "corrupt");
        // a directory entry pointing past the end must not panic
        let mut t = z.clone(); let n = t.len();
        let cd = le32(&t, n - 6) as usize; t[cd + 42..cd + 46].copy_from_slice(&0xffff_fff0u32.to_le_bytes());
        assert_eq!(read_zip(&t, &DEFAULT_LIMITS, "en").unwrap_err().1, "corrupt");
    }

    #[test]
    fn messages_follow_the_language() {
        let z = make_zip(&[ze("a.txt", "x")]);
        let m = |l| read_zip(&z[..10], &DEFAULT_LIMITS, l).unwrap_err().0;
        assert_eq!((m("ru"), m("en"), m("zh")), ("Файл не похож на ZIP-архив.".into(), "The file does not look like a ZIP archive.".into(), "该文件看起来不是 ZIP 压缩包。".to_string()));
        assert_eq!(m("xx"), m("ru"));
    }

    #[test]
    fn image_size_headers() {
        assert_eq!(image_size(&fake_webp(1536, 1872)), Some(ImageSize { w: 1536, h: 1872, format: "webp" }));
        assert_eq!(image_size(&fake_png(1536, 1872)), Some(ImageSize { w: 1536, h: 1872, format: "png" }));
        assert_eq!(image_size(b"GIF89a......................................"), None);
        assert_eq!(image_size(&[0u8; 10]), None);
        assert!(sheet_size_ok(&ImageSize { w: 1536, h: 2288, format: "png" }));
        assert!(!sheet_size_ok(&ImageSize { w: 1536, h: 2000, format: "png" }));
    }

    #[test]
    fn validate_accepts_good_pack() {
        let p = validate(&good_pack(), "x.zip").unwrap();
        let mut names: Vec<_> = p.files.iter().map(|f| f.0.clone()).collect(); names.sort();
        assert_eq!((p.id.as_str(), p.name.as_str(), names), ("my-pet", "My Pet", vec!["pet.json".to_string(), "spritesheet.webp".to_string()]));
    }

    #[test]
    fn validate_png_tweaks_docs_and_wrapper_folder() {
        let ok = validate(&[
            ze("pet/pet.json", r#"{"id":"p1","spritesheetPath":"sheet.png"}"#), ze("pet/sheet.png", fake_png(1536, 1872)),
            ze("pet/tweaks.json", r#"{"lightFringe":"remove"}"#), ze("pet/LICENSE.txt", "MIT"), ze("pet/README.md", "# hi"),
        ], "x.zip").unwrap();
        assert_eq!(ok.id, "p1");
        assert!(ok.files.iter().any(|f| f.0 == "tweaks.json"));
    }

    #[test]
    fn validate_rejects_scripts_and_unknown_files() {
        for bad in ["run.exe", "x.dll", "setup.bat", "a.ps1", "x.js", "x.sh", "evil.html", "logo.svg", "x.lnk"] {
            assert_eq!(ecode(validate(&with(good_pack(), ze(bad, "x")), "x.zip")), "risky", "{bad}");
        }
        assert_eq!(ecode(validate(&with(good_pack(), ze("notes.docx", "x")), "x.zip")), "unsupported-file");
        assert_eq!(ecode(validate(&with(good_pack(), ze("sub/inner.txt", "x")), "x.zip")), "nested");
    }

    #[test]
    fn validate_explains_structural_problems() {
        let v = |json: &str, sheet: Vec<u8>| ecode(validate(&good_pack_json(json, sheet), "x.zip"));
        let w = || fake_webp(1536, 1872);
        assert_eq!(ecode(validate(&[ze("spritesheet.webp", w())], "x.zip")), "no-pet-json");
        assert_eq!(v("{nope", w()), "bad-pet-json");
        assert_eq!(v("[1]", w()), "bad-pet-json");
        assert_eq!(v(r#"{"id":"x","spritesheetPath":"other.webp"}"#, w()), "no-sheet");
        assert_eq!(v(r#"{"id":"x","spritesheetPath":"../s.webp"}"#, w()), "bad-sheet-path");
        assert_eq!(v(r#"{"id":"x","spritesheetPath":"run.exe"}"#, w()), "bad-sheet-path");
        assert_eq!(v("{}", b"not an image at all, just text".to_vec()), "bad-image");
        assert_eq!(v("{}", fake_webp(100, 100)), "bad-size");
        assert_eq!(ecode(validate(&with(good_pack(), ze("tweaks.json", "{broken")), "x.zip")), "bad-tweaks");
    }

    #[test]
    fn validate_id_rules() {
        let id = |json: &str, name: &str| validate(&good_pack_json(json, fake_webp(1536, 1872)), name).map(|p| p.id);
        assert_eq!(id(r#"{"id":"Shy-Miku"}"#, "x.zip").unwrap(), "shy-miku");
        assert_eq!(id(r#"{"id":"../etc"}"#, "Cool Pet.codex-pet.zip").unwrap(), "cool-pet");
        assert_eq!(ecode(id(r#"{"id":"../etc"}"#, "###.zip")), "bad-id");
        assert_eq!(slug_from_name("clawd.codex-pet.zip"), "clawd");
    }

    #[test]
    fn install_from_zip_registers_reports_progress_and_leaves_no_temp() {
        let d = dirs();
        let steps = std::cell::RefCell::new(Vec::<InstallProgress>::new());
        let cb = |p: InstallProgress| steps.borrow_mut().push(p);
        let info = install_model_from_zip(&zip_file(&good_pack()), &InstallOpts { on_progress: Some(&cb), ..opts(&d) }).unwrap();
        assert_eq!((info.id.as_str(), info.name.as_str(), info.bundled), ("my-pet", "My Pet", false));
        assert_eq!(listing(&d.0.join("my-pet")), ["pet.json", "spritesheet.webp"]);
        assert_eq!(listing(&d.0), ["my-pet"]);
        assert_eq!(list_models(&d.1, &d.0).iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["my-pet"]);
        let s = steps.borrow();
        assert_eq!((s.last().unwrap().step, s.last().unwrap().percent), ("done", 100));
        assert!(s.windows(2).all(|w| w[0].percent <= w[1].percent));
    }

    #[test]
    fn install_never_overwrites_and_failures_leave_nothing() {
        let d = dirs();
        install_model_from_zip(&zip_file(&good_pack()), &opts(&d)).unwrap();
        assert_eq!(ecode(install_model_from_zip(&zip_file(&good_pack()), &opts(&d))), "exists");
        model_dir(&d.1, "clawd", "{}");
        assert_eq!(ecode(install_model_from_zip(&zip_file(&good_pack_id("clawd")), &opts(&d))), "exists");
        assert_eq!(listing(&d.0), ["my-pet"]);
        assert_ne!(ecode(install_model_from_zip(&zip_file(&[ze("pet.json", "{}")]), &opts(&d))), "NO ERROR");
        assert_eq!(listing(&d.0), ["my-pet"]);
    }

    #[test]
    fn hostile_archives_install_nothing() {
        let d = dirs();
        for entries in [
            with(good_pack(), ze("../../victim.txt", "pwned")), with(good_pack(), ze("/tmp/abs.txt", "pwned")),
            with(good_pack(), ze("run.exe", "MZ")), with(good_pack(), ZEntryT { unix_mode: Some(0o120777), ..ze("link", "/etc/passwd") }),
        ] { assert_ne!(ecode(install_model_from_zip(&zip_file(&entries), &opts(&d))), "NO ERROR"); }
        assert!(!d.0.exists() || listing(&d.0).is_empty());
    }

    #[test]
    fn install_reports_unreadable_and_not_zip() {
        let d = dirs();
        assert_eq!(ecode(install_model_from_zip(Path::new("/nonexistent/x.zip"), &opts(&d))), "unreadable");
        assert_eq!(ecode(install_model_from_zip(&tmp(), &opts(&d))), "unreadable");
        let f = tmp().join("junk.zip"); fs::write(&f, "junk junk junk junk junk junk").unwrap();
        assert_eq!(ecode(install_model_from_zip(&f, &opts(&d))), "not-zip");
    }

    #[test]
    fn remove_only_user_models() {
        let d = dirs();
        install_model_from_zip(&zip_file(&good_pack()), &opts(&d)).unwrap();
        model_dir(&d.1, "clawd", "{}");
        let rm = |id: &str| ecode(remove_model(id, &d.0, &d.1, "en"));
        assert_eq!(rm("clawd"), "bundled");
        for bad in ["../x", "..", "a/b", "", "A"] { assert_eq!(rm(bad), "bad-id", "{bad}"); }
        assert_eq!(rm("nothing"), "missing");
        remove_model("my-pet", &d.0, &d.1, "en").unwrap();
        assert!(!d.0.join("my-pet").exists());
        assert!(d.1.join("clawd/pet.json").exists());
    }

    fn pet_folder(root: &Path, id: &str, extra: &[(&str, &str)]) -> PathBuf {
        let p = root.join(id); fs::create_dir_all(&p).unwrap();
        fs::write(p.join("pet.json"), format!(r#"{{"id":"{id}","displayName":"{}"}}"#, id.to_uppercase())).unwrap();
        fs::write(p.join("spritesheet.webp"), fake_webp(1536, 1872)).unwrap();
        for (n, c) in extra { fs::write(p.join(n), c).unwrap(); }
        p
    }

    #[test]
    fn pet_folders_listed_and_installed() {
        let (root, d) = (tmp(), dirs());
        pet_folder(&root, "cat", &[]); fs::create_dir(root.join("junk")).unwrap(); fs::write(root.join("file.txt"), "x").unwrap();
        assert_eq!(scan_pet_folder(&root).iter().map(|f| (f.id.as_str(), f.name.as_str())).collect::<Vec<_>>(), [("cat", "CAT")]);
        assert!(scan_pet_folder(Path::new("/nonexistent/pets")).is_empty());
        assert_eq!(install_model_from_dir(&root.join("cat"), &opts(&d)).unwrap().id, "cat");
        assert_eq!(ecode(install_model_from_dir(&pet_folder(&root, "bad", &[("run.exe", "MZ")]), &opts(&d))), "risky");
        assert_eq!(ecode(install_model_from_dir(&root.join("cat"), &opts(&d))), "exists");
    }

    #[test]
    fn pet_folder_refuses_symlinks_and_subfolders() {
        let (root, d) = (tmp(), dirs());
        let p = pet_folder(&root, "sneaky", &[]);
        let link = p.join("README.txt");
        #[cfg(unix)] let linked = std::os::unix::fs::symlink("/etc/hostname", &link).is_ok();
        #[cfg(windows)] let linked = std::os::windows::fs::symlink_file(&p.join("pet.json"), &link).is_ok(); // needs a privilege: skipped without it
        if linked { assert_eq!(ecode(install_model_from_dir(&p, &opts(&d))), "symlink"); }
        let q = pet_folder(&root, "deep", &[]); fs::create_dir(q.join("sub")).unwrap();
        assert_eq!(ecode(install_model_from_dir(&q, &opts(&d))), "nested");
    }

    #[test]
    fn registry_lists_bundled_then_user() {
        let (b, u) = (tmp(), tmp());
        model_dir(&b, "clawd", r#"{"id":"clawd","displayName":"Clawd","description":"d","source":"codex-pets.net"}"#);
        model_dir(&u, "mine", r#"{"displayName":"Mine"}"#);
        let l = list_models(&b, &u);
        assert_eq!(l.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.bundled, m.source.as_str())).collect::<Vec<_>>(), [("clawd", "Clawd", true, "codex-pets.net"), ("mine", "Mine", false, "")]);
    }

    #[test]
    fn registry_ignores_junk_and_never_shadows_bundled() {
        let (b, u) = (tmp(), tmp());
        model(&b, "clawd");
        model_dir(&u, "clawd", r#"{"displayName":"Impostor"}"#);
        model(&u, ".tmp-123"); model(&u, "Bad Name"); model_dir(&u, "broken", "{nope");
        fs::write(u.join("stray.txt"), "x").unwrap();
        let l = list_models(&b, &u);
        assert_eq!(l.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["clawd"]);
        assert_eq!(l[0].name, "CLAWD");
        assert!(list_models(Path::new("/nonexistent/a"), Path::new("/nonexistent/b")).is_empty());
    }

    #[test]
    fn pick_default_and_fallbacks() {
        let b = tmp(); model(&b, "claude-maiden"); model(&b, "other");
        let l = list_models(&b, &tmp());
        assert_eq!(DEFAULT_MODEL, "claude-maiden");
        assert_eq!(pick_model(&l, None).unwrap().id, "claude-maiden");
        assert_eq!(pick_model(&l, Some("other")).unwrap().id, "other");
        assert_eq!(pick_model(&l, Some("clawd")).unwrap().id, "claude-maiden");
        assert!(pick_model(&[], Some("x")).is_none());
    }

    #[test]
    fn model_ids_are_plain_folder_names() {
        for ok in ["clawd", "a", "shy-miku", "0abc"] { assert!(is_model_id(ok), "{ok}"); }
        for bad in ["", "-x", "A", "a b", "../x", "a/b", "a\\b", "a.b", ".tmp", "a\n"] { assert!(!is_model_id(bad), "{bad:?}"); }
        assert!(!is_model_id(&"x".repeat(41)));
    }

    #[test]
    fn bundled_default_is_shown_as_cpet() {
        let (b, u) = (tmp(), tmp());
        model(&b, "claude-maiden"); model(&u, "mine");
        let l = list_models(&b, &u);
        assert_eq!(l.iter().find(|m| m.id == "claude-maiden").unwrap().name, "cPet");
        assert_ne!(l.iter().find(|m| m.id == "mine").unwrap().name, "cPet");
    }
}
