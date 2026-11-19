//! ccPet desktop app on Tauri (phase 3): replaces ui/src/main.ts. The renderer is ui/dist unchanged; src/pet-host.js gives it the
//! `window.petHost` that ui/src/preload.cjs gives it under Electron.
//! Done: the pet window (click-through, hover, drag, resize, keep on top, off-screen rescue), the default distro's WSL bridge,
//! settings, tray, hotkeys (summon, Ctrl+Alt+1-9), single instance, autostart, notifications, hook install offer, message queue.
//! Not yet (M3/M4): the Windows host, several distros, models, connections panel, desktop app sending, update check.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod windows_host;
mod wsl;

use base64::Engine;
use ccpet_app::{desktop, diagnostics, merge, models, native_terminal, updates, placement, queue::MessageQueue, settings::{self, Settings}, terminal, winshell};
use std::collections::{HashMap, HashSet};
use windows_host::WindowsHost;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/** constant width; the height follows the renderer (panels open downwards from the pet) */
const STAGE_W: f64 = 424.0;
const STAGE_H: f64 = 260.0;
const MAX_H: f64 = 1000.0;
const IDLE_H: f64 = placement::IDLE_H;
/** donations page (ccPet stays free) */
const SUPPORT_URL: &str = "https://boosty.to/cpet";
/** the only addresses the renderer may open (npm pages of the pet installers it documents) */
const OPEN_URLS: [&str; 2] = ["https://www.npmjs.com/package/codex-pets", "https://www.npmjs.com/package/@codex-pets/cli"];
const PLUGIN_INSTALL: &str = "/plugin install ccpet --marketplace S1NexZ/ccPet";
const ANSWER_KEYS: usize = 9;
/** Linux and macOS: one local bridge, no WSL, no Windows host, no desktop-app or PowerShell automation */
const NATIVE: bool = cfg!(not(windows));

/** the user's home folder (USERPROFILE on Windows) */
fn home_dir() -> PathBuf { std::env::var(if NATIVE { "HOME" } else { "USERPROFILE" }).map(PathBuf::from).unwrap_or_default() }

/** where the Electron app kept its data ("Claude Pet" in the platform's app-data folder): settings, models and the log stay there */
fn app_data_root() -> PathBuf {
    if cfg!(windows) { return std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(".")); }
    if cfg!(target_os = "macos") { return home_dir().join("Library").join("Application Support"); }
    std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| home_dir().join(".config"))
}

/** the installed app's resource folder: next to the exe (Windows), Contents/Resources (macOS), ../lib/ccPet (Linux deb / AppImage) */
fn resource_root(exe_dir: &Path) -> PathBuf {
    if cfg!(windows) { exe_dir.to_path_buf() }
    else if cfg!(target_os = "macos") { exe_dir.join("..").join("Resources") }
    else { exe_dir.join("..").join("lib").join("ccPet") }
}

#[derive(Clone, Copy, Deserialize)]
struct Rect { x: f64, y: f64, w: f64, h: f64 }

fn over_any(px: f64, py: f64, rects: &[Rect], pad: f64) -> bool {
    rects.iter().any(|r| px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad)
}

#[derive(Default)]
struct Ui {
    hit: Vec<Rect>,
    hover: Vec<Rect>,
    up: bool,
    /** the default distro's own snapshot, and the merged one the renderer last got */
    wsl_snap: Option<Value>,
    /** the other followed distros' snapshots, by host id `wsl:<distro>` */
    other_snaps: HashMap<String, Value>,
    snapshot: Option<Value>,
    last_move: Option<Instant>,
    last_x: Option<f64>,
    /** a height asked for during a drag: applied when the drag ends (the OS owns the window meanwhile) */
    pending_h: Option<f64>,
    anchor: Option<placement::Anchor>,
    answer_keys_on: bool,
    hooks_manual: bool,
    /** the Windows host's own snapshot and whether its receiver runs */
    win_snap: Option<Value>,
    win_up: bool,
    /** limits as each host reports them (the ring shows the freshest numbers) */
    usage_by: HashMap<String, Value>,
    /** our own set_position/set_size: the Moved event it causes is not a drag */
    own_move_until: Option<Instant>,
    /** a new Windows chat whose first prompt is typed once its session shows up: (cwd, at, prompt, known ids) */
    pending_new_chat: Option<(String, f64, String, Vec<String>)>,
    /** sessions whose SDK-fallback warning the user already accepted */
    warned: HashSet<String>,
    /** a newer release on GitHub (only told, never installed) */
    update: Option<updates::Update>,
}

struct App {
    data_dir: PathBuf,
    models_dirs: Vec<PathBuf>,
    scripts_dir: PathBuf,
    sandbox: bool,
    packaged: bool,
    settings: Mutex<Settings>,
    lang: Mutex<&'static str>,
    ui: Mutex<Ui>,
    queue: Mutex<MessageQueue>,
    wsl: Mutex<Option<Arc<wsl::WslHost>>>,
    /** other running WSL 2 distros: host id `wsl:<name>` -> (its hook port, its bridge) */
    others: Mutex<Vec<(String, u16, Arc<wsl::WslHost>)>>,
    win: Mutex<Option<Arc<WindowsHost>>>,
    /** the stable copy of pet-helper.exe (mailbox waiter, statusLine, PTY wrapper); None without one */
    helper: Option<String>,
    /** the desktop app's session list (re-read at most every 5 s, changed files only) */
    desktop: Mutex<(desktop::DesktopRegistry, Option<Instant>, HashMap<String, desktop::DesktopEntry>)>,
    /** one snapshot / answer-key update at a time (several threads call them) */
    push_lock: Mutex<()>,
    keys_tx: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    /** PowerShell's execution policy (profiles do not run under Restricted / AllSigned) */
    ps_policy: Mutex<Option<String>>,
}

impl App {
    fn log(&self, m: &str) {
        let line = format!("{} [tauri] {m}\n", now_iso());
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(self.data_dir.join("pet.log")) { let _ = f.write_all(line.as_bytes()); }
    }
    /** a UI string in the current language */
    fn l(&self, ru: &str, en: &str, zh: &str) -> String {
        match *self.lang.lock().unwrap() { "ru" => ru, "zh" => zh, _ => en }.to_string()
    }
    fn s(&self) -> Settings { self.settings.lock().unwrap().clone() }
    fn to_bridge(&self, cmd: Value) { if let Some(h) = self.wsl_host() { h.send(&cmd); } }
    fn wsl_host(&self) -> Option<Arc<wsl::WslHost>> { self.wsl.lock().unwrap().clone() }
    fn win_host(&self) -> Option<Arc<WindowsHost>> { self.win.lock().unwrap().clone() }
    fn to_all_bridges(&self, cmd: Value) {
        self.to_bridge(cmd.clone());
        for (_, _, h) in self.others.lock().unwrap().iter() { h.send(&cmd); }
        if let Some(w) = self.win_host() { w.bridge.handle(&cmd); }
    }
    /** the WSL bridge of host id `wsl` / `wsl:<distro>` */
    fn wsl_by_id(&self, id: &str) -> Option<Arc<wsl::WslHost>> {
        if id == "wsl" { return self.wsl_host(); }
        self.others.lock().unwrap().iter().find(|(i, _, _)| i == id).map(|(_, _, h)| h.clone())
    }
    fn desktop_entries(&self) -> HashMap<String, desktop::DesktopEntry> {
        let mut d = self.desktop.lock().unwrap();
        if d.1.map_or(true, |t| t.elapsed() > Duration::from_secs(5)) { d.1 = Some(Instant::now()); d.2 = d.0.by_cli_id(); }
        d.2.clone()
    }
    fn session(&self, id: &str) -> Option<Value> {
        self.ui.lock().unwrap().snapshot.as_ref().and_then(|s| s["sessions"].as_array().and_then(|l| l.iter().find(|x| x["id"] == id).cloned()))
    }
    fn parts(&self) -> Vec<merge::HostPart> {
        let ui = self.ui.lock().unwrap();
        let others = self.others.lock().unwrap();
        // distro names are shown once more than one distro is followed
        let label = |h: &wsl::WslHost| (!others.is_empty()).then(|| h.distro()).filter(|d| !d.is_empty());
        let mut v = vec![merge::HostPart { host: "wsl".into(), snap: ui.wsl_snap.clone(), distro: self.wsl.lock().unwrap().as_deref().and_then(label) }];
        for (id, _, h) in others.iter() { v.push(merge::HostPart { host: id.clone(), snap: ui.other_snaps.get(id).cloned(), distro: label(h).or_else(|| Some(id[4..].to_string())) }); }
        v.push(merge::HostPart { host: "windows".into(), snap: ui.win_snap.clone(), distro: None });
        v
    }
}

/** `2026-11-19T00:12:34.567Z`, like the Electron app's log */
fn now_iso() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

fn resolve_lang(pref: &str) -> &'static str {
    match pref {
        "ru" => "ru", "en" => "en", "zh" => "zh",
        _ => { let loc = sys_locale::get_locale().unwrap_or_default().to_lowercase(); if loc.starts_with("zh") { "zh" } else if loc.starts_with("ru") { "ru" } else { "en" } }
    }
}

/** `<dir>/<id>/pet.json` of the chosen model, else the default one, else any */
fn model_dir(dirs: &[PathBuf], chosen: &str) -> Option<PathBuf> {
    let valid = |id: &str| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    for id in [chosen, settings::DEFAULT_MODEL] {
        if !valid(id) { continue; }
        for d in dirs { let p = d.join(id); if p.join("pet.json").is_file() { return Some(p); } }
    }
    dirs.iter().filter_map(|d| std::fs::read_dir(d).ok()).flatten().flatten().map(|e| e.path()).find(|p| p.join("pet.json").is_file())
}

/** image width/height of a PNG or WebP (ui/src/models/images.ts) */
fn image_size(b: &[u8]) -> Option<(u32, u32)> {
    let be = |i: usize| u32::from_be_bytes(b[i..i + 4].try_into().unwrap());
    let le3 = |i: usize| b[i] as u32 | (b[i + 1] as u32) << 8 | (b[i + 2] as u32) << 16;
    if b.len() >= 24 && b[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] && &b[12..16] == b"IHDR" { return Some((be(16), be(20))); }
    if b.len() >= 30 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        match &b[12..16] {
            b"VP8X" => return Some((1 + le3(24), 1 + le3(27))),
            b"VP8L" if b[20] == 0x2f => { let v = u32::from_le_bytes(b[21..25].try_into().unwrap()); return Some(((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1)); }
            b"VP8 " if b[23] == 0x9d && b[24] == 0x01 && b[25] == 0x2a => return Some((u16::from_le_bytes([b[26], b[27]]) as u32 & 0x3fff, u16::from_le_bytes([b[28], b[29]]) as u32 & 0x3fff)),
            _ => {}
        }
    }
    None
}

/** the renderer's `pet` payload (main.ts petPayload over sprite/loadPet.ts) */
fn pet_payload(dir: &Path) -> Result<Value, String> {
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("pet.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let sheet_name = meta["spritesheetPath"].as_str().unwrap_or("spritesheet.webp");
    let bytes = std::fs::read(dir.join(sheet_name)).map_err(|e| format!("{sheet_name}: {e}"))?;
    const ROW_FRAMES: [u32; 9] = [6, 8, 8, 4, 5, 8, 6, 6, 6];
    const ROW_FRAMES_V2: [u32; 11] = [7, 8, 8, 4, 5, 8, 6, 6, 6, 7, 7];
    let frames: &[u32] = if image_size(&bytes).map(|s| s.1) == Some(2288) { &ROW_FRAMES_V2 } else { &ROW_FRAMES };
    let tweaks: Value = std::fs::read_to_string(dir.join("tweaks.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    let id = meta["id"].as_str().unwrap_or("pet");
    let kind = if sheet_name.to_lowercase().ends_with(".png") { "png" } else { "webp" };
    Ok(json!({
        "id": id, "name": meta["displayName"].as_str().unwrap_or(id),
        "imageUrl": format!("data:image/{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
        "cell": { "w": 192, "h": 208 }, "rows": frames.iter().map(|f| json!({ "frames": f })).collect::<Vec<_>>(), "tweaks": tweaks,
    }))
}

fn main_window(h: &AppHandle) -> Option<WebviewWindow> { h.get_webview_window("main") }

// ---------- settings, tray, hotkeys ----------

fn apply_settings(h: &AppHandle, app: &App) {
    let s = app.s();
    if let Err(e) = settings::save(&app.data_dir.join("settings.json"), &s) { app.log(&format!("settings: {e}")); }
    if app.packaged && !app.sandbox {
        let al = h.autolaunch();
        let r = if s.autostart { al.enable() } else { al.disable() };
        if let Err(e) = r { app.log(&format!("autostart: {e}")); }
    }
    refresh_tray(h);
}

fn update_settings(h: &AppHandle, f: impl FnOnce(&mut Settings)) {
    let app = h.state::<Arc<App>>();
    f(&mut app.settings.lock().unwrap());
    apply_settings(h, &app);
}

/** Bring the pet to the front with the chat open (hotkey, second launch). */
fn summon(h: &AppHandle) {
    if let Some(w) = main_window(h) { let _ = w.show(); let _ = w.set_always_on_top(true); let _ = w.set_focus(); let _ = w.emit("pet:summon", ()); }
    refresh_tray(h);
}

fn toggle_window(h: &AppHandle) {
    if let Some(w) = main_window(h) {
        if w.is_visible().unwrap_or(false) { let _ = w.hide(); } else { let _ = w.show(); let _ = w.set_always_on_top(true); }
    }
    refresh_tray(h);
}

fn register_hotkey(h: &AppHandle) {
    let app = h.state::<Arc<App>>();
    let gs = h.global_shortcut();
    let _ = gs.unregister_all();
    app.ui.lock().unwrap().answer_keys_on = false;
    sync_answer_keys(h);
    let key = app.s().hotkey;
    if key.is_empty() || app.sandbox { return; } // the running pet holds it
    let r = gs.on_shortcut(key.as_str(), |h, _, e| {
        if e.state != ShortcutState::Pressed { return; }
        let shown = main_window(h).map_or(false, |w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
        if shown { if let Some(w) = main_window(h) { let _ = w.hide(); } refresh_tray(h); } else { summon(h); }
    });
    app.log(&format!("hotkey: {key} registered={}", r.is_ok()));
    if let Err(e) = r {
        app.log(&format!("hotkey: {e}"));
        let body = app.l(&format!("Горячая клавиша {key} недоступна (занята другим приложением)"), &format!("The hotkey {key} is unavailable (taken by another app)"), &format!("快捷键 {key} 不可用（已被其他应用占用）"));
        let _ = h.notification().builder().title("ccPet").body(body).show();
    }
}

/** Ctrl+Alt+1-9 press the answer buttons of a question or permission on the pet, from any app; held only while one waits. */
fn sync_answer_keys(h: &AppHandle) {
    if let Some(tx) = h.state::<Arc<App>>().keys_tx.lock().unwrap().as_ref() { let _ = tx.send(()); }
}

/** the answer-key worker: one change at a time, and no caller (hook threads, the UI thread) ever waits for the shortcut calls */
fn answer_keys_worker(h: AppHandle) -> std::sync::mpsc::Sender<()> {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || for () in rx { apply_answer_keys(&h); });
    tx
}

fn apply_answer_keys(h: &AppHandle) {
    let app = h.state::<Arc<App>>();
    let want = !app.sandbox && app.s().answer_keys && {
        let ui = app.ui.lock().unwrap();
        ui.snapshot.as_ref().map_or(false, |s| {
            let att = &s["attention"];
            s["sessions"].as_array().map_or(false, |l| l.iter().any(|x| &x["id"] == att && !x["pendingPermission"].is_null() && x.get("pendingPermission").is_some()))
        })
    };
    {
        let mut ui = app.ui.lock().unwrap();
        if ui.answer_keys_on == want { return; }
        ui.answer_keys_on = want;
    }
    let gs = h.global_shortcut();
    for n in 1..=ANSWER_KEYS {
        let k = format!("Control+Alt+{n}");
        if !want { let _ = gs.unregister(k.as_str()); continue; }
        let _ = gs.on_shortcut(k.as_str(), move |h, _, e| { if e.state == ShortcutState::Pressed { if let Some(w) = main_window(h) { let _ = w.emit("pet:answer-key", n); } } }); // taken by another app: skipped
    }
}

fn build_menu(h: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app = h.state::<Arc<App>>();
    let s = app.s();
    let up = app.ui.lock().unwrap().up;
    let visible = main_window(h).map_or(false, |w| w.is_visible().unwrap_or(false));
    let l = |ru: &str, en: &str, zh: &str| app.l(ru, en, zh);
    let sep = || PredefinedMenuItem::separator(h);
    let sizes: Vec<CheckMenuItem<tauri::Wry>> = [0.75, 1.0, 1.25, 1.5, 1.8].iter()
        .map(|v| CheckMenuItem::with_id(h, format!("size:{v}"), format!("{}%", (v * 100.0f64).round()), true, (s.pet_scale - v).abs() < 0.03, None::<&str>))
        .collect::<tauri::Result<_>>()?;
    let size_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = sizes.iter().map(|x| x as &dyn IsMenuItem<tauri::Wry>).collect();
    let update = app.ui.lock().unwrap().update.clone();
    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = vec![];
    if let Some(u) = &update {
        items.push(Box::new(MenuItem::with_id(h, "update", l(&format!("Доступна версия {}…", u.version), &format!("Version {} is available…", u.version), &format!("{} 版本可用…", u.version)), true, None::<&str>)?));
        items.push(Box::new(sep()?));
    }
    items.extend::<Vec<Box<dyn IsMenuItem<tauri::Wry>>>>(vec![
        Box::new(MenuItem::with_id(h, "toggle", if visible { l("Скрыть питомца", "Hide the pet", "隐藏宠物") } else { l("Показать питомца", "Show the pet", "显示宠物") }, true, None::<&str>)?),
        Box::new(MenuItem::with_id(h, "hotkey", format!("{}: {}", l("Вызов питомца", "Summon the pet", "唤出宠物"), if s.hotkey.is_empty() { l("выключен", "off", "关") } else { s.hotkey.clone() }), false, None::<&str>)?),
        Box::new(sep()?),
        Box::new(MenuItem::with_id(h, "settings", l("Настройки…", "Settings…", "设置…"), true, None::<&str>)?),
        Box::new(MenuItem::with_id(h, "terminal", l("Подключить терминал (WSL)…", "Connect the terminal (WSL)…", "连接终端（WSL）…"), true, None::<&str>)?),
        Box::new(MenuItem::with_id(h, "hooks", l("Подключить хуки Claude Code…", "Connect Claude Code hooks…", "连接 Claude Code 钩子…"), up && !app.sandbox, None::<&str>)?),
        Box::new(MenuItem::with_id(h, "plugin", l("Плагин ccPet для Claude Code…", "ccPet plugin for Claude Code…", "Claude Code 的 ccPet 插件…"), true, None::<&str>)?),
        Box::new(CheckMenuItem::with_id(h, "notify", l("Уведомлять, когда нужно разрешение", "Notify when permission is needed", "需要权限时通知"), true, s.notify, None::<&str>)?),
        Box::new(CheckMenuItem::with_id(h, "answerKeys", l("Отвечать клавишами Ctrl+Alt+1…9", "Answer with Ctrl+Alt+1…9", "用 Ctrl+Alt+1…9 回答"), true, s.answer_keys, None::<&str>)?),
        Box::new(Submenu::with_id_and_items(h, "size", l("Размер питомца", "Pet size", "宠物大小"), true, &size_refs)?),
        Box::new(CheckMenuItem::with_id(h, "autostart", if NATIVE { l("Запускать при входе в систему", "Start at login", "登录时启动") } else { l("Запускать вместе с Windows", "Start with Windows", "随 Windows 启动") }, app.packaged, s.autostart, None::<&str>)?),
        Box::new(CheckMenuItem::with_id(h, "checkUpdates", l("Проверять обновления (раз в день)", "Check for updates (daily)", "检查更新（每天）"), true, s.check_updates, None::<&str>)?),
        Box::new(sep()?),
        Box::new(MenuItem::with_id(h, "support", l("Поддержать проект ❤", "Support the project ❤", "支持项目 ❤"), true, None::<&str>)?),
        Box::new(MenuItem::with_id(h, "quit", l("Выйти", "Quit", "退出"), true, None::<&str>)?),
    ]);
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(h, &refs)
}

fn refresh_tray(h: &AppHandle) {
    if let (Some(t), Ok(m)) = (h.tray_by_id("main"), build_menu(h)) { let _ = t.set_menu(Some(m)); }
}

fn on_menu(h: &AppHandle, id: &str) {
    let app = h.state::<Arc<App>>().inner().clone();
    match id {
        "toggle" => toggle_window(h),
        "settings" => if let Some(w) = main_window(h) { let _ = w.show(); let _ = w.set_always_on_top(true); let _ = w.emit("pet:open-settings", ()); },
        "terminal" => { let h = h.clone(); std::thread::spawn(move || terminal_setup(&h)); }
        "hooks" => { app.ui.lock().unwrap().hooks_manual = true; app.to_bridge(json!({ "type": "hooks", "apply": false })); }
        "plugin" => { let h = h.clone(); std::thread::spawn(move || plugin_info(&h)); }
        "notify" => update_settings(h, |s| s.notify = !s.notify),
        "answerKeys" => {
            update_settings(h, |s| s.answer_keys = !s.answer_keys);
            register_hotkey(h);
            if let Some(w) = main_window(h) { let _ = w.emit("pet:answer-keys", app.s().answer_keys); }
        }
        "autostart" => update_settings(h, |s| s.autostart = !s.autostart),
        "checkUpdates" => {
            update_settings(h, |s| s.check_updates = !s.check_updates);
            if app.s().check_updates { let h = h.clone(); std::thread::spawn(move || check_updates(&h)); }
        }
        "update" => if let Some(u) = app.ui.lock().unwrap().update.clone() { let _ = h.opener().open_url(u.url, None::<&str>); },
        "support" => { let _ = h.opener().open_url(SUPPORT_URL, None::<&str>); }
        "quit" => h.exit(0),
        x if x.starts_with("size:") => if let Ok(v) = x[5..].parse::<f64>() {
            update_settings(h, |s| s.pet_scale = v);
            if let Some(w) = main_window(h) { let _ = w.emit("pet:scale", v); }
        },
        _ => {}
    }
}

// ---------- dialogs (always off the main thread: they block) ----------

/** A question: the safe button first and the default (Enter and Esc never run the action), the action second; true = the action was
 * chosen (ui/src/dialogs.ts). The dialog plugin's TaskDialog makes its first button, the action, the default: not used for questions. */
#[cfg(windows)]
fn confirm(h: &AppHandle, title: &str, detail: &str, action: &str, cancel: &str) -> bool {
    use windows_sys::Win32::UI::Controls::{TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION, TDF_SIZE_TO_CONTENT};
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (title, detail, action, cancel) = (w(title), w(detail), w(action), w(cancel));
    const SAFE: i32 = 100;
    const ACT: i32 = 101;
    let buttons = [TASKDIALOG_BUTTON { nButtonID: SAFE, pszButtonText: cancel.as_ptr() }, TASKDIALOG_BUTTON { nButtonID: ACT, pszButtonText: action.as_ptr() }];
    let parent = main_window(h).and_then(|win| win.hwnd().ok()).map_or(std::ptr::null_mut(), |x| x.0 as _);
    let mut cfg: TASKDIALOGCONFIG = unsafe { std::mem::zeroed() };
    cfg.cbSize = std::mem::size_of::<TASKDIALOGCONFIG>() as u32;
    cfg.hwndParent = parent;
    cfg.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT;
    cfg.pszWindowTitle = title.as_ptr();
    cfg.pszContent = detail.as_ptr();
    cfg.pButtons = buttons.as_ptr();
    cfg.cButtons = buttons.len() as u32;
    cfg.nDefaultButton = SAFE;
    let mut pressed = 0i32;
    let r = unsafe { TaskDialogIndirect(&cfg, &mut pressed, std::ptr::null_mut(), std::ptr::null_mut()) };
    r == 0 && pressed == ACT
}
#[cfg(not(windows))]
fn confirm(h: &AppHandle, title: &str, detail: &str, action: &str, cancel: &str) -> bool {
    h.dialog().message(detail).title(title).kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(action.into(), cancel.into())).blocking_show()
}
fn info(h: &AppHandle, title: &str, detail: &str) {
    h.dialog().message(detail).title(title).kind(MessageDialogKind::Info).buttons(MessageDialogButtons::Ok).blocking_show();
}

/** Guided terminal setup: the one command to run in WSL (it asks before changing ~/.bashrc, backs it up, can be undone). */
fn terminal_setup(h: &AppHandle) {
    let app = h.state::<Arc<App>>();
    let script = wsl::to_wsl_path(&app.scripts_dir.join("install-shell-integration.sh").to_string_lossy());
    let cmd = format!("bash '{}'", script.replace('\'', "'\\''"));
    let detail = app.l("Чтобы обычная команда `claude` запускалась через ccPet (общая сессия с питомцем), выполните в окне WSL-терминала:", "To make the plain `claude` command run through ccPet (one shared session with the pet), run this in a WSL terminal:", "要让普通的 `claude` 命令通过 ccPet 运行（与宠物共用一个会话），请在 WSL 终端中运行：")
        + "\n\n" + &cmd + &app.l("\n\nСкрипт покажет изменение, спросит подтверждение, сохранит копию ~/.bashrc и его можно отменить: добавьте --uninstall. Без этого питомец тоже работает, но писать в терминальную сессию сможет только через запасной путь.", "\n\nThe script shows the change, asks for confirmation, keeps a copy of ~/.bashrc and can be undone with --uninstall. The pet works without it too, but can write into a terminal session only through a fallback path.", "\n\n脚本会显示改动并请求确认，保留 ~/.bashrc 的备份，可用 --uninstall 撤销。没有它宠物也能工作，但只能通过备用途径向终端会话写入。");
    if confirm(h, &app.l("Подключить терминал (WSL)", "Connect the terminal (WSL)", "连接终端（WSL）"), &detail, &app.l("Копировать команду", "Copy command", "复制命令"), &app.l("Закрыть", "Close", "关闭")) {
        let _ = h.clipboard().write_text(cmd);
    }
}

fn plugin_info(h: &AppHandle) {
    let app = h.state::<Arc<App>>();
    let detail = app.l(
        &format!("Плагин работает внутри Claude Code (терминал, вкладка Code приложения Claude, VS Code). С ним сообщения из питомца приходят как ваши собственные, без обёртки терминала и без ввода в окно приложения, а лимиты плана попадают в питомца без отдельных запросов.\n\nВведите в Claude Code:\n{PLUGIN_INSTALL}\n\nЗатем перезапустите сессию (или /reload-plugins). Нужен Claude Code 2.1.287 или новее. Сессии WSL внутри приложения Claude плагины не загружают: для них остаются хуки."),
        &format!("The plugin runs inside Claude Code (terminal, the Code tab of the Claude app, VS Code). With it, messages from the pet arrive as your own, without the terminal wrapper or typing into the app's window, and plan limits reach the pet without extra queries.\n\nType in Claude Code:\n{PLUGIN_INSTALL}\n\nThen restart the session (or run /reload-plugins). Requires Claude Code 2.1.287 or later. WSL sessions inside the Claude app do not load plugins: hooks stay in use for them."),
        &format!("该插件在 Claude Code 内运行（终端、Claude 应用的 Code 标签页、VS Code）。安装后，来自宠物的消息会作为您自己的消息送达，无需终端包装器或向应用窗口输入；套餐额度也无需额外查询即可传给宠物。\n\n在 Claude Code 中输入：\n{PLUGIN_INSTALL}\n\n然后重启会话（或运行 /reload-plugins）。需要 Claude Code 2.1.287 或更高版本。Claude 应用中的 WSL 会话不加载插件，仍使用钩子。"));
    if confirm(h, &app.l("Плагин ccPet для Claude Code", "The ccPet plugin for Claude Code", "Claude Code 的 ccPet 插件"), &detail, &app.l("Копировать команду", "Copy command", "复制命令"), &app.l("Закрыть", "Close", "关闭")) {
        let _ = h.clipboard().write_text(PLUGIN_INSTALL);
    }
}

/** The bridge's answer to a hooks probe (main.ts onHooks): offer installing or upgrading, with the diff; never asked in a sandbox. */
fn on_hooks(h: &AppHandle, m: &Value) {
    let app = h.state::<Arc<App>>();
    if app.sandbox { return; }
    let manual = std::mem::take(&mut app.ui.lock().unwrap().hooks_manual);
    let diff = m["diff"].as_str().unwrap_or("");
    let flag = |k: &str| m[k].as_bool().unwrap_or(false);
    if flag("applied") {
        info(h, &app.l("Хуки подключены", "Hooks connected", "钩子已连接"), &app.l("Новые сессии Claude Code будут видны питомцу. Уже открытые терминалы нужно перезапустить.", "New Claude Code sessions will be visible to the pet. Terminals that are already open need a restart.", "新的 Claude Code 会话将对宠物可见。已打开的终端需要重启。"));
        return;
    }
    if diff.is_empty() { if manual { info(h, &app.l("Хуки уже подключены", "Hooks are already connected", "钩子已经连接"), ""); } return; }
    if !manual && flag("installed") && !flag("stale") && !flag("upgrade") { return; }
    let shown = format!("{}\n…", diff.split('\n').take(14).collect::<Vec<_>>().join("\n"));
    let added = diff.split('\n').filter(|l| l.starts_with("+ ")).count();
    let (title, detail, action) = if flag("upgrade") && flag("installed") && !flag("stale") {
        (app.l("Обновить хуки Claude Code?", "Update the Claude Code hooks?", "更新 Claude Code 钩子？"),
         app.l("Хуки питомца теперь работают без Node.js: каждая сессия Claude Code тратит на них около 1 МБ памяти вместо 65 МБ. Изменятся только команды хуков питомца в ~/.claude/settings.json, копия сохранится в settings.json.bak. Уже открытые сессии подхватят их после перезапуска.", "The pet's hooks now run without Node.js: each Claude Code session spends about 1 MB of memory on them instead of 65 MB. Only the pet's hook commands in ~/.claude/settings.json change; a copy is kept in settings.json.bak. Sessions already open pick them up after a restart.", "宠物的钩子现在无需 Node.js 运行：每个 Claude Code 会话只占用约 1 MB 内存，而不是 65 MB。只会修改 ~/.claude/settings.json 中宠物的钩子命令，备份保存在 settings.json.bak。已打开的会话重启后生效。"),
         app.l("Обновить", "Update", "更新"))
    } else {
        (app.l("Подключить хуки Claude Code?", "Connect Claude Code hooks?", "连接 Claude Code 钩子？"),
         app.l(&format!("Чтобы видеть сессии из терминала, питомец добавит свой хук в ~/.claude/settings.json ({added} строк, копия сохранится в settings.json.bak). Хук только сообщает питомцу о событиях и ничего не блокирует."), &format!("To see terminal sessions, the pet will add its hook to ~/.claude/settings.json ({added} lines, a copy is kept in settings.json.bak). The hook only tells the pet about events and blocks nothing."), &format!("为了显示终端会话，宠物会把它的钩子添加到 ~/.claude/settings.json（{added} 行，备份保存在 settings.json.bak）。该钩子只向宠物通知事件，不会阻止任何操作。")),
         app.l("Подключить", "Connect", "连接"))
    };
    if confirm(h, &title, &format!("{detail}\n\n{shown}"), &action, &app.l("Не сейчас", "Not now", "暂不")) { app.to_bridge(json!({ "type": "hooks", "apply": true })); }
}

// ---------- sessions: snapshot, queue ----------

fn push_snapshot(h: &AppHandle) {
    let app = h.state::<Arc<App>>();
    let one = app.push_lock.lock().unwrap();
    let snap = merge::merge_snapshots(&app.parts());
    let sessions = desktop::decorate_desktop(snap["sessions"].as_array().cloned().unwrap_or_default(), &app.desktop_entries());
    let sessions = app.queue.lock().unwrap().decorate(sessions);
    // a new Windows chat: its first prompt is typed in once the session shows up (through its pet-helper pipe)
    let pending = app.ui.lock().unwrap().pending_new_chat.clone();
    if let Some((cwd, at, prompt, known)) = pending {
        if let Some(id) = terminal::match_new_session(&sessions, &cwd, at, &known) {
            app.ui.lock().unwrap().pending_new_chat = None;
            if let Some(w) = app.win_host() { std::thread::spawn(move || w.bridge.handle(&json!({ "type": "send", "sessionId": id, "text": prompt }))); }
        } else if now_ms() - at > 120_000.0 {
            app.ui.lock().unwrap().pending_new_chat = None;
            app.log("new Windows chat: the session did not appear in time, first prompt dropped");
        }
    }
    let attention = if sessions.iter().any(|s| s["id"] == snap["attention"]) { snap["attention"].clone() } else { merge::pick_attention(&sessions).map_or(Value::Null, |s| s["id"].clone()) };
    let out = json!({ "type": "snapshot", "sessions": sessions, "attention": attention });
    app.ui.lock().unwrap().snapshot = Some(out.clone());
    let _ = h.emit("pet:msg", out);
    drop(one);
    sync_answer_keys(h);
    drain_queue(h);
}

/** queued messages whose time came go out through the normal send path; a session the pet cannot reach without the user is skipped */
fn drain_queue(h: &AppHandle) {
    let app = h.state::<Arc<App>>();
    let sessions = app.ui.lock().unwrap().snapshot.as_ref().and_then(|s| s["sessions"].as_array().cloned()).unwrap_or_default();
    let due = app.queue.lock().unwrap().due(&sessions, now_ms());
    for (sid, m) in due {
        let text = m["text"].as_str().unwrap_or("").to_string();
        let s = sessions.iter().find(|x| x["id"] == sid.as_str());
        let reachable = s.map_or(false, |s| s["owned"] == true || !s["pty"].is_null() && s.get("pty").is_some() || s["mailbox"] == true || s["host"] == "windows");
        if !reachable {
            app.log(&format!("queue: {sid} cannot take a message without the user; dropped"));
            let note = app.l(&format!("Сообщение из очереди не отправлено: у сессии нет связи с питомцем. Текст: {text}"), &format!("A queued message was not sent: the session has no link to the pet. Text: {text}"), &format!("排队消息未发送：会话未连接到宠物。内容：{text}"));
            let _ = h.emit("pet:msg", json!({ "type": "chat", "sessionId": sid, "event": { "kind": "note", "text": note } }));
            continue;
        }
        app.log(&format!("queue: sending a waiting message to {sid}"));
        let h = h.clone();
        std::thread::spawn(move || on_cmd(&h, json!({ "type": "send", "sessionId": sid, "text": text, "queued": true })));
    }
}

fn now_ms() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64) }

/** once a day: a newer release only gets told (tray item + notification), never installed */
fn check_updates(h: &AppHandle) {
    let app = h.state::<Arc<App>>();
    if !app.s().check_updates || !app.packaged || app.sandbox { return; }
    let Some(u) = updates::check_latest(env!("CARGO_PKG_VERSION")) else { return };
    if app.ui.lock().unwrap().update.as_ref().map(|x| &x.version) == Some(&u.version) { return; }
    app.log(&format!("update available: {}", u.version));
    let body = app.l(&format!("Доступна версия {}. Откройте меню в трее, чтобы перейти на страницу релиза.", u.version), &format!("Version {} is available. Open the tray menu to go to the release page.", u.version), &format!("{} 版本已发布。打开托盘菜单进入发布页面。", u.version));
    app.ui.lock().unwrap().update = Some(u);
    let _ = h.notification().builder().title("ccPet").body(body).show();
    refresh_tray(h);
}

fn follow_distros(h: &AppHandle, bridge: &str) {
    let mut c = std::process::Command::new("wsl.exe");
    c.args(["-l", "-v"]);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    let Ok(o) = c.output() else { return };
    let u16s: Vec<u16> = o.stdout.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
    let names = wsl::secondary_distros(&wsl::parse_distro_list(&String::from_utf16_lossy(&u16s)));
    let app = h.state::<Arc<App>>();
    for name in names {
        let id = format!("wsl:{name}");
        if app.wsl_by_id(&id).is_some() { continue; }
        // WSL 2 distros share one network namespace: each bridge gets its own hook port, and no limits poller
        let mut taken: Vec<u16> = vec![47822, windows_host::PORT];
        taken.extend(app.others.lock().unwrap().iter().map(|(_, p, _)| *p));
        let port = wsl::port_for_distro(&name, &taken);
        app.log(&format!("following WSL distro {name}"));
        let exports = vec![("CLAUDE_PET_HOOK_PORT".into(), port.to_string()), ("CLAUDE_PET_LIVE_USAGE".into(), "0".into())];
        let host = wsl::WslHost::start(name.clone(), bridge.to_string(), exports, Arc::new(Events { handle: h.clone(), id: id.clone() }));
        app.others.lock().unwrap().push((id, port, host));
    }
}

/** limits come from every host (the WSL bridge, the Windows status line): the ring shows the freshest numbers */
fn host_usage(h: &AppHandle, host: &str, u: Value) {
    let app = h.state::<Arc<App>>();
    let all: Vec<Value> = { let mut ui = app.ui.lock().unwrap(); ui.usage_by.insert(host.into(), u); ui.usage_by.values().cloned().collect() };
    if let Some(m) = merge::merge_usage(&all) { let _ = h.emit("pet:msg", json!({ "type": "usage", "usage": m })); }
}

/** the Windows host's messages (main.ts: snapshot -> winSnap, the rest as the WSL bridge's) */
fn windows_message(h: &AppHandle, m: Value) {
    let app = h.state::<Arc<App>>();
    match m["type"].as_str() {
        Some("snapshot") => { app.ui.lock().unwrap().win_snap = Some(m); let h = h.clone(); std::thread::spawn(move || push_snapshot(&h)); } // the bridge holds its lock while it reports
        Some("usage") => host_usage(h, "windows", m["usage"].clone()),
        _ => { let _ = h.emit("pet:msg", m); }
    }
}

/** the WSL bridge's messages, as main.ts handles them */
struct Events { handle: AppHandle, id: String }
impl wsl::HostEvents for Events {
    fn ready(&self, claude: &str) {
        let app = self.handle.state::<Arc<App>>();
        let s = app.s();
        let Some(host) = app.wsl_by_id(&self.id) else { return };
        let primary = self.id == "wsl";
        if primary { app.ui.lock().unwrap().hooks_manual = false; }
        host.send(&json!({ "type": "language", "lang": *app.lang.lock().unwrap() }));
        host.send(&json!({ "type": "permission-mode", "mode": s.permissions }));
        host.send(&json!({ "type": "hook-permissions", "on": s.answer_permissions }));
        host.send(&json!({ "type": "sdk-chats", "on": s.sdk_chats }));
        if primary && !app.sandbox { host.send(&json!({ "type": "hooks", "apply": false })); }
        if primary && claude.is_empty() {
            let h = self.handle.clone();
            std::thread::spawn(move || { let app = h.state::<Arc<App>>(); info(&h, &app.l("Claude Code не найден в WSL", "Claude Code not found in WSL", "在 WSL 中未找到 Claude Code"), &app.l("Установи Claude Code в WSL, чтобы питомец мог запускать сессии.", "Install Claude Code in WSL so the pet can start sessions.", "请在 WSL 中安装 Claude Code，宠物才能启动会话。")); });
        }
        push_snapshot(&self.handle);
    }
    fn up(&self, up: bool) {
        let app = self.handle.state::<Arc<App>>();
        let any = {
            let mut ui = app.ui.lock().unwrap();
            if self.id == "wsl" { ui.up = up; if !up { ui.wsl_snap = None; } } else if !up { ui.other_snaps.remove(&self.id); }
            ui.up || ui.win_up
        };
        let _ = self.handle.emit("pet:bridge", any);
        if !up { push_snapshot(&self.handle); }
        refresh_tray(&self.handle);
    }
    fn message(&self, m: Value) {
        let app = self.handle.state::<Arc<App>>();
        match m["type"].as_str() {
            Some("snapshot") => {
                { let mut ui = app.ui.lock().unwrap(); if self.id == "wsl" { ui.wsl_snap = Some(m); } else { ui.other_snaps.insert(self.id.clone(), m); } }
                push_snapshot(&self.handle);
            }
            Some("usage") => host_usage(&self.handle, &self.id, m["usage"].clone()),
            Some("hooks") => { if self.id == "wsl" { let h = self.handle.clone(); std::thread::spawn(move || on_hooks(&h, &m)); } }
            Some("statusline") | Some("termMark") => {} // M3: connections panel, terminal focus
            _ => { let _ = self.handle.emit("pet:msg", m); }
        }
    }
    fn log(&self, line: &str) { self.handle.state::<Arc<App>>().log(line); }
}

// ---------- renderer commands (window.petHost) ----------

type St<'a> = tauri::State<'a, Arc<App>>;

#[tauri::command]
fn config(app: St) -> Result<Value, String> {
    let s = app.s();
    let dir = model_dir(&app.models_dirs, &s.model).ok_or("no pet model found")?;
    let ui = app.ui.lock().unwrap();
    Ok(json!({
        "bridge": ui.up || ui.win_up, "snapshot": ui.snapshot, "expanded": false, "panel": false,
        "appearance": s.appearance, "permissions": s.permissions, "answerKeys": s.answer_keys,
        "lang": *app.lang.lock().unwrap(), "language": s.language, "petScale": s.pet_scale,
        "pet": pet_payload(&dir)?,
    }))
}

#[tauri::command]
fn cmd(h: AppHandle, cmd: Value) { std::thread::spawn(move || on_cmd(&h, cmd)); } // dialogs may block: never on the UI thread

/** a session's commands go to the host that owns it (new chats, models and limits stay with the WSL bridge) */
fn route(h: &AppHandle, cmd: Value) {
    let app = h.state::<Arc<App>>();
    let parts = app.parts();
    let host = if cmd["type"] == "permission" { merge::host_of_permission(cmd["id"].as_str().unwrap_or(""), &parts) } else { cmd["sessionId"].as_str().and_then(|id| merge::host_of(id, &parts)) };
    if host.as_deref() == Some("windows") { if let Some(w) = app.win_host() { w.bridge.handle(&cmd); } return; }
    if let Some(w) = host.as_deref().filter(|h| h.starts_with("wsl:")).and_then(|h| app.wsl_by_id(h)) { w.send(&cmd); return; }
    app.to_bridge(cmd);
}

fn spawn_launch(app: &App, c: &terminal::Launch) -> bool {
    let mut p = std::process::Command::new(&c.file);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // cmd.exe: std would escape the `""` title of `start` into \"\"; its arguments are fixed tokens and base64 (terminal.rs)
        if c.file.eq_ignore_ascii_case("cmd.exe") {
            for a in &c.args { if a.contains(char::is_whitespace) && !a.starts_with('"') { p.raw_arg(format!("\"{a}\"")); } else { p.raw_arg(a); } } // a helper path under a user name with spaces
        } else { p.args(&c.args); }
    }
    #[cfg(not(windows))]
    p.args(&c.args);
    if let Some(d) = &c.cwd { p.current_dir(d); }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; p.creation_flags(0x0000_0008); } // DETACHED_PROCESS: the terminal outlives nothing of ours
    match p.spawn() { Ok(_) => true, Err(e) => { app.log(&format!("terminal ({}) failed: {e}", c.file)); false } }
}
/** Windows Terminal first, the plain console when it is missing */
fn launch(app: &App, make: impl Fn(bool) -> Result<terminal::Launch, String>) {
    for wt in [true, false] {
        match make(wt) { Ok(c) => if spawn_launch(app, &c) { return; }, Err(e) => { app.log(&format!("terminal: {e}")); return; } }
    }
}

fn on_path(bin: &str) -> bool { std::env::var("PATH").unwrap_or_default().split(':').any(|d| !d.is_empty() && Path::new(d).join(bin).exists()) }
const PLATFORM: &str = if cfg!(target_os = "macos") { "darwin" } else { "linux" };

/** Linux / macOS: a terminal emulator running claude (resume or a new chat); false + a dialog when there is none */
fn open_native_terminal(h: &AppHandle, cwd: &str, claude: &str, session_id: Option<&str>, prompt: Option<&str>) -> bool {
    let app = h.state::<Arc<App>>();
    let claude = Some(claude).filter(|c| !c.is_empty());
    let Some(c) = native_terminal::native_terminal_command(PLATFORM, cwd, claude, session_id, prompt, &on_path) else {
        info(h, &app.l("Не найден терминал", "No terminal found", "未找到终端"), &app.l("Установите эмулятор терминала (gnome-terminal, konsole, xterm…), чтобы питомец мог открывать сессии.", "Install a terminal emulator (gnome-terminal, konsole, xterm…) so the pet can open sessions.", "请安装终端模拟器（gnome-terminal、konsole、xterm…），宠物才能打开会话。"));
        return false;
    };
    spawn_launch(&app, &terminal::Launch { file: c.file, args: c.args, cwd: None })
}

/** the pet's command handler (main.ts onCmd) */
fn on_cmd(h: &AppHandle, cmd: Value) {
    let app = h.state::<Arc<App>>().inner().clone();
    let t = cmd["type"].as_str().unwrap_or("").to_string();
    let sid = cmd["sessionId"].as_str().unwrap_or("").to_string();
    // messages for later live in the app (it sees every host's state)
    if t == "queue" {
        if let Some(text) = cmd["text"].as_str().map(str::trim).filter(|x| !x.is_empty()) {
            if !sid.is_empty() { app.queue.lock().unwrap().add(&sid, text, cmd["at"].as_f64().filter(|a| a.is_finite())); push_snapshot(h); }
        }
        return;
    }
    if t == "unqueue" { if !sid.is_empty() { app.queue.lock().unwrap().remove(&sid, cmd["id"].as_str()); push_snapshot(h); } return; }
    let s = app.s();
    if t == "start" && !s.sdk_chats {
        let cwd = cmd["cwd"].as_str().unwrap_or("").to_string();
        let prompt = cmd["prompt"].as_str().unwrap_or("").trim().to_string();
        if s.new_chat_in == "desktop" && !app.sandbox && !NATIVE {
            // a new chat inside the Claude desktop app (needs a Windows folder; the app fills the prompt, the pet presses Send)
            if let Some(link) = (!prompt.is_empty()).then(|| desktop::new_chat_link(&cwd, &prompt)).flatten() {
                let r = winshell::send_to_desktop(&prompt, None, None, Some(&link));
                if r != "ok" {
                    std::thread::spawn(|| { winshell::focus_desktop_app(); });
                    let detail = if r == "needs-trust" { app.l("Приложение Claude спрашивает, доверять ли этой папке. Решить это можете только вы: ответьте в приложении и нажмите «Отправить» (текст уже введён).", "The Claude app asks whether to trust this folder. Only you can decide that: answer in the app and press Send (the text is already filled in).", "Claude 应用正在询问是否信任此文件夹。只有您能决定：请在应用中回答并点击“发送”（文本已填好）。") }
                        else { app.l(&format!("Чат открыт в приложении Claude, но питомец не смог нажать «Отправить» ({r}). Отправьте сообщение там сами."), &format!("The chat is open in the Claude app, but the pet could not press Send ({r}). Send the message there yourself."), &format!("聊天已在 Claude 应用中打开，但宠物无法点击“发送”（{r}）。请在那里自行发送。")) };
                    info(h, &app.l("Сообщение не отправлено", "The message was not sent", "消息未发送"), &detail);
                }
                return;
            }
            if prompt.is_empty() && !cwd.is_empty() {
                let enc: String = cwd.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
                let _ = h.opener().open_url(format!("claude://code/new?folder={enc}"), None::<&str>);
                winshell::focus_desktop_app();
                return;
            }
            app.log("new chat in the desktop app needs a Windows folder; starting it in a terminal instead");
        }
        if NATIVE {
            let claude = app.wsl_host().map(|w| w.claude()).unwrap_or_default();
            open_native_terminal(h, &cwd, &claude, None, Some(&prompt).filter(|p| !p.is_empty()).map(|p| p.as_str()));
            return;
        }
        let wsl_up = app.wsl_host().map_or(false, |w| w.is_up());
        if s.new_chat_in == "windows" || !wsl_up {
            // the first prompt is typed into the new session once it shows up (it needs the wrapper's pipe for that)
            let known: Vec<String> = app.ui.lock().unwrap().snapshot.as_ref().and_then(|x| x["sessions"].as_array().map(|l| l.iter().filter_map(|y| y["id"].as_str().map(String::from)).collect())).unwrap_or_default();
            app.ui.lock().unwrap().pending_new_chat = (!prompt.is_empty() && app.helper.is_some()).then(|| (cwd.clone(), now_ms(), prompt.clone(), known));
            launch(&app, |wt| Ok(terminal::windows_new_session_command(&cwd, app.helper.as_deref(), wt)));
            if !prompt.is_empty() && app.helper.is_none() { // without the wrapper nothing can type it: keep the text for the user instead of losing it
                let _ = h.clipboard().write_text(prompt.clone());
                info(h, &app.l("Первое сообщение не отправлено", "The first message was not sent", "首条消息未发送"), &app.l("Без pet-helper.exe питомец не может ввести его в новую сессию. Текст скопирован в буфер обмена: вставьте его в открывшееся окно.", "Without pet-helper.exe the pet cannot type it into the new session. The text is on the clipboard: paste it into the new window.", "没有 pet-helper.exe，宠物无法把它输入到新会话中。文本已复制到剪贴板：请粘贴到新窗口中。"));
            }
            return;
        }
        let w = app.wsl_host().unwrap();
        let (distro, claude) = (w.distro(), w.claude());
        launch(&app, |wt| terminal::new_session_command(&distro, &cwd, &claude, Some(&prompt).filter(|p| !p.is_empty()).map(|p| p.as_str()), wt));
        return;
    }
    if t == "send" {
        if let Some(x) = app.session(&sid) {
            let text = cmd["text"].as_str().unwrap_or("");
            let has_images = cmd["images"].as_array().map_or(false, |a| !a.is_empty());
            // a queued message never drives the Claude app's window (it would take the focus, e.g. from a fullscreen game): it goes through the hook
            if let (Some(did), false) = (x["desktopId"].as_str(), x["mod"] == true) {
                if s.desktop_send == "real" && !app.sandbox && !NATIVE && cmd["queued"] != true && !text.trim().is_empty() && !has_images {
                    let r = winshell::send_to_desktop(text, x["project"].as_str(), Some(did), None);
                    if r == "ok" { return; }
                    app.log(&format!("desktop send: {r}; delivering through the hook instead"));
                    let note = if r == "busy" { app.l("Чат в приложении занят: сообщение доставлено через хук (в приложении оно выглядит бледной вставкой).", "The chat in the app is busy: the message went through the hook (the app shows it as faint text).", "应用中的聊天正忙：消息已通过钩子发送（在应用中显示为淡色文字）。") }
                        else { app.l(&format!("Не удалось ввести сообщение в приложение ({r}): оно доставлено через хук и выглядит там бледной вставкой."), &format!("Could not type the message into the app ({r}): it went through the hook and looks faint there."), &format!("无法在应用中输入消息（{r}）：已通过钩子发送，在应用中显示为淡色文字。")) };
                    let _ = h.emit("pet:msg", json!({ "type": "chat", "sessionId": sid, "event": { "kind": "note", "text": note } }));
                }
            }
            // the warning is for the SDK fallback only: a session reachable through its mailbox (or on the Windows host) is woken by a hook
            let fallback = x["owned"] != true && x["pty"].is_null() && x["mailbox"] != true && x["host"] != "windows";
            if fallback && !app.ui.lock().unwrap().warned.contains(&sid) {
                let project = x["project"].as_str().unwrap_or("").to_string();
                let ok = confirm(h, &app.l(&format!("«{project}» открыта в терминале"), &format!("“{project}” is open in a terminal"), &format!("“{project}”已在终端中打开")),
                    &app.l("Ответ запишется в тот же диалог, но в уже открытом окне терминала он не появится, пока сессию не откроют заново (кнопка «в терминал» в чате питомца). Писать в обе стороны одновременно не стоит.\n\nСовет: нажми «в терминал» в чате, и питомец продолжит эту сессию в новом окне.", "The reply is written to the same conversation, but it will not appear in the terminal window that is already open until the session is reopened (the “terminal” button in the pet chat). Do not write from both sides at once.\n\nTip: press “terminal” in the chat and the pet will continue this session in a new window.", "回复会写入同一个对话，但在重新打开会话之前，不会显示在已打开的终端窗口中（宠物聊天中的“终端”按钮）。请勿同时从两边写入。\n\n提示：在聊天中点“终端”，宠物会在新窗口中继续此会话。"),
                    &app.l("Отправить", "Send", "发送"), &app.l("Отмена", "Cancel", "取消"));
                if !ok { return; }
                app.ui.lock().unwrap().warned.insert(sid.clone());
            }
        }
    }
    if t == "end" {
        let x = app.session(&sid);
        let project = x.as_ref().and_then(|x| x["project"].as_str().map(String::from)).unwrap_or_else(|| sid.clone());
        let detail = if x.as_ref().map_or(false, |x| x["owned"] == true) {
            app.l("Питомец закроет её процесс Claude Code. Переписка сохранится: её можно продолжить позже в терминале.", "The pet will close its Claude Code process. The conversation is kept: you can continue it later in a terminal.", "宠物将关闭它的 Claude Code 进程。对话会保留：稍后可在终端中继续。")
        } else {
            app.l("Процесс claude этой сессии будет остановлен (окно терминала останется). Если Claude сейчас работает, текущий шаг прервётся.", "The claude process of this session will be stopped (the terminal window stays). If Claude is working right now, the current step is interrupted.", "此会话的 claude 进程将被停止（终端窗口保留）。如果 Claude 正在工作，当前步骤会被中断。")
        };
        if !confirm(h, &app.l(&format!("Завершить сессию «{project}»?"), &format!("End the session “{project}”?"), &format!("结束会话“{project}”？")), &detail, &app.l("Завершить", "End", "结束"), &app.l("Отмена", "Cancel", "取消")) { return; }
    }
    route(h, cmd);
}

#[tauri::command]
fn rects(app: St, rects: Vec<Rect>) {
    if std::env::var("CCPET_DEBUG").is_ok() { app.log(&format!("rects: {}", rects.iter().map(|r| format!("{:.0},{:.0},{:.0},{:.0}", r.x, r.y, r.w, r.h)).collect::<Vec<_>>().join(" | "))); }
    app.ui.lock().unwrap().hit = rects;
}

#[tauri::command]
fn hover_rects(app: St, rects: Vec<Rect>) { app.ui.lock().unwrap().hover = rects; }

#[tauri::command]
fn resize(app: St, win: WebviewWindow, h: f64) {
    let h = h.clamp(120.0, MAX_H).ceil();
    let mut ui = app.ui.lock().unwrap();
    if ui.last_move.is_some() { ui.pending_h = Some(h); return; } // mid-drag: after the drop
    drop(ui);
    let _ = win.set_size(LogicalSize::new(STAGE_W, h)); // the window hangs from the pet's top: growing downwards never moves the pet
}

#[tauri::command]
fn focus(win: WebviewWindow) { let _ = win.set_focus(); }

#[tauri::command]
fn start_drag(win: WebviewWindow) { let _ = win.start_dragging(); }

/** right-click on the pet: the tray menu (Windows' system menu otherwise) */
#[tauri::command]
fn context_menu(h: AppHandle, win: WebviewWindow) { if let Ok(m) = build_menu(&h) { let _ = win.popup_menu(&m); } }

#[tauri::command]
fn set_scale(h: AppHandle, v: Value) { let v = settings::clamp_scale(&v); update_settings(&h, |s| s.pet_scale = v); }

#[tauri::command]
fn set_appearance(h: AppHandle, a: Value) { let a = settings::clean_appearance(&a); update_settings(&h, |s| s.appearance = a); }

#[tauri::command]
fn set_permissions(h: AppHandle, app: St, mode: String) {
    if !settings::PERMISSION_POLICIES.contains(&mode.as_str()) { return; }
    update_settings(&h, |s| s.permissions = mode.clone());
    app.to_bridge(json!({ "type": "permission-mode", "mode": mode }));
}

/** a new language: remembered, applied to the bridge and the tray, the UI reloads itself */
#[tauri::command]
fn set_language(h: AppHandle, app: St, win: WebviewWindow, pref: String) {
    if !settings::LANG_PREFS.contains(&pref.as_str()) { return; }
    *app.lang.lock().unwrap() = resolve_lang(&pref);
    update_settings(&h, |s| s.language = pref.clone());
    app.to_all_bridges(json!({ "type": "language", "lang": *app.lang.lock().unwrap() }));
    let _ = win.eval("location.reload()");
}

#[tauri::command]
fn copy_text(h: AppHandle, text: String) { if text.chars().count() <= 500 { let _ = h.clipboard().write_text(text); } }

#[tauri::command]
fn open_url(h: AppHandle, url: String) { if OPEN_URLS.contains(&url.as_str()) { let _ = h.opener().open_url(url, None::<&str>); } }

#[tauri::command]
fn notify(h: AppHandle, app: St, title: String, body: String) {
    if app.s().notify { let _ = h.notification().builder().title(title).body(body).show(); }
}

#[tauri::command]
async fn pick_folder(h: AppHandle) -> Option<String> {
    let title = h.state::<Arc<App>>().l("Папка для Claude Code", "Folder for Claude Code", "Claude Code 的文件夹");
    tauri::async_runtime::spawn_blocking(move || h.dialog().file().set_title(title).blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
        .await.ok().flatten()
}

// ---------- pet models: list, switch, install from a ZIP / an npm pet folder, remove ----------

fn bundled_models(app: &App) -> PathBuf { app.models_dirs[0].clone() }
fn user_models(app: &App) -> PathBuf { app.models_dirs[1].clone() }
fn codex_dir() -> PathBuf { home_dir().join(".codex").join("pets") }

fn models_for_ui(app: &App) -> Value {
    let all = models::list_models(&bundled_models(app), &user_models(app));
    let active = models::pick_model(&all, Some(&app.s().model)).map(|m| m.id.clone());
    Value::Array(all.iter().map(|m| json!({ "id": m.id, "name": m.name, "description": m.description, "source": m.source, "bundled": m.bundled, "active": Some(&m.id) == active.as_ref() })).collect())
}
fn find_model(app: &App, id: &str) -> Option<models::ModelInfo> {
    models::is_model_id(id).then(|| models::list_models(&bundled_models(app), &user_models(app)).into_iter().find(|m| m.id == id)).flatten()
}
fn fail_text(app: &App, e: &models::Error) -> String {
    match e { models::Error::Model(m) => m.0.clone(), models::Error::Other(x) => { app.log(&format!("models: {x}")); app.l("Не удалось выполнить операцию с моделью. Подробности в журнале приложения.", "The model operation failed. See the app log for details.", "模型操作失败。详情见应用日志。") } }
}
fn install_with(h: &AppHandle, f: impl FnOnce(&models::InstallOpts) -> Result<models::ModelInfo, models::Error>) -> Value {
    let app = h.state::<Arc<App>>();
    let lang = *app.lang.lock().unwrap();
    let (bd, ud) = (bundled_models(&app), user_models(&app));
    let progress = |p: models::InstallProgress| { let _ = h.emit("pet:models:progress", p); };
    let o = models::InstallOpts { user_dir: &ud, bundled_dir: &bd, lang, on_progress: Some(&progress) };
    match f(&o) { Ok(m) => json!({ "ok": true, "model": { "id": m.id, "name": m.name }, "models": models_for_ui(&app) }), Err(e) => json!({ "ok": false, "error": fail_text(&app, &e) }) }
}

#[tauri::command]
fn models_list(app: St) -> Value { models_for_ui(&app) }

#[tauri::command]
fn models_data(app: St, id: String) -> Value { find_model(&app, &id).and_then(|m| pet_payload(&m.dir).ok()).unwrap_or(Value::Null) }

#[tauri::command]
fn models_use(h: AppHandle, app: St, id: String) -> Value {
    let Some(m) = find_model(&app, &id) else { return json!({ "ok": false, "error": app.l("Такой модели нет.", "There is no such model.", "没有这个模型。") }) };
    match pet_payload(&m.dir) {
        Ok(pet) => { update_settings(&h, |s| s.model = m.id.clone()); json!({ "ok": true, "pet": pet, "models": models_for_ui(&app) }) }
        Err(e) => { app.log(&format!("models: {e}")); json!({ "ok": false, "error": app.l("Не удалось выполнить операцию с моделью. Подробности в журнале приложения.", "The model operation failed. See the app log for details.", "模型操作失败。详情见应用日志。") }) }
    }
}

#[tauri::command]
async fn models_install_zip(h: AppHandle, path: Option<String>) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let app = h.state::<Arc<App>>();
        let file = match path.filter(|p| !p.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => {
                let picked = h.dialog().file().set_title(app.l("Установить модель питомца", "Install a pet model", "安装宠物模型"))
                    .add_filter(app.l("Модель питомца (ZIP)", "Pet model (ZIP)", "宠物模型 (ZIP)"), &["zip"]).blocking_pick_file();
                match picked.and_then(|p| p.into_path().ok()) { Some(p) => p, None => return json!({ "ok": false, "canceled": true }) }
            }
        };
        install_with(&h, |o| models::install_model_from_zip(&file, o))
    }).await.unwrap_or(Value::Null)
}

#[tauri::command]
async fn models_remove(h: AppHandle, id: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let app = h.state::<Arc<App>>();
        let m = find_model(&app, &id);
        let Some(m) = m.filter(|m| !m.bundled) else {
            return json!({ "ok": false, "error": if find_model(&app, &id).is_some() { app.l("Встроенную модель удалить нельзя.", "A built-in model cannot be removed.", "内置模型无法删除。") } else { app.l("Такой модели нет.", "There is no such model.", "没有这个模型。") } });
        };
        if !confirm(&h, &app.l(&format!("Удалить модель «{}»?", m.name), &format!("Delete the model “{}”?", m.name), &format!("删除模型“{}”？", m.name)),
            &app.l("Файлы модели будут удалены с компьютера. Встроенные модели и настройки не затрагиваются.", "The model files will be deleted from this computer. Built-in models and settings are not affected.", "模型文件将从此电脑删除。内置模型和设置不受影响。"),
            &app.l("Удалить", "Delete", "删除"), &app.l("Отмена", "Cancel", "取消")) { return json!({ "ok": false, "canceled": true }); }
        let lang = *app.lang.lock().unwrap();
        if let Err(e) = models::remove_model(&m.id, &user_models(&app), &bundled_models(&app), lang) { return json!({ "ok": false, "error": fail_text(&app, &e) }); }
        let mut pet = Value::Null;
        if app.s().model == m.id { // the active one is gone: back to the default
            update_settings(&h, |s| s.model = settings::DEFAULT_MODEL.into());
            if let Some(d) = model_dir(&app.models_dirs, settings::DEFAULT_MODEL) { pet = pet_payload(&d).unwrap_or(Value::Null); }
        }
        json!({ "ok": true, "models": models_for_ui(&app), "pet": pet })
    }).await.unwrap_or(Value::Null)
}

#[tauri::command]
fn models_codex_scan(app: St) -> Value {
    let have: HashSet<String> = models::list_models(&bundled_models(&app), &user_models(&app)).into_iter().map(|m| m.id).collect();
    let dir = codex_dir();
    let found = models::scan_pet_folder(&dir);
    json!({ "dir": dir, "exists": !found.is_empty() || dir.exists(), "found": found.iter().map(|f| json!({ "id": f.id, "name": f.name, "installed": have.contains(&f.id) })).collect::<Vec<_>>() })
}

#[tauri::command]
async fn models_codex_import(h: AppHandle, id: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let app = h.state::<Arc<App>>();
        // only folders that the scan itself found
        let Some(f) = models::scan_pet_folder(&codex_dir()).into_iter().find(|x| x.id == id) else { return json!({ "ok": false, "error": app.l("Папка модели не найдена.", "Model folder not found.", "未找到模型文件夹。") }) };
        install_with(&h, |o| models::install_model_from_dir(&f.dir, o))
    }).await.unwrap_or(Value::Null)
}

#[tauri::command]
fn models_reveal(h: AppHandle, app: St) {
    let d = user_models(&app);
    let _ = std::fs::create_dir_all(&d);
    let _ = h.opener().open_path(d.to_string_lossy(), None::<&str>);
}

// ---------- connections: our hooks in each host's settings.json (always with the diff and the user's consent) ----------

fn confirm_hooks(h: &AppHandle, title: &str, items: &[(String, String)], note: Option<String>) -> bool {
    let app = h.state::<Arc<App>>();
    let body: Vec<String> = items.iter().map(|(f, d)| { let d = if d.chars().count() > 1400 { format!("{}\n…", d.chars().take(1400).collect::<String>()) } else { d.clone() }; format!("{f}\n{d}") }).collect();
    let note = note.unwrap_or_else(|| app.l("Копия файла сохранится рядом (settings.json.bak). Хуки только сообщают питомцу о событиях; свои хуки пользователя не затрагиваются.", "A copy of the file is kept next to it (settings.json.bak). The hooks only tell the pet about events; your own hooks are not touched.", "文件的备份会保存在旁边（settings.json.bak）。钩子只向宠物通知事件，不会改动你自己的钩子。"));
    confirm(h, title, &format!("{}\n\n{note}", body.join("\n\n")), &app.l("Применить", "Apply", "应用"), &app.l("Отмена", "Cancel", "取消"))
}

fn windows_settings_label() -> String { std::env::var("USERPROFILE").map(|u| format!("{u}\\.claude\\settings.json")).unwrap_or_else(|_| "settings.json".into()) }

/** the PowerShell profiles the wrapper goes into: Windows PowerShell always, PowerShell 7 when its profile folder exists */
fn ps_profiles() -> Vec<PathBuf> {
    let docs = std::env::var("USERPROFILE").map(|u| PathBuf::from(u).join("Documents")).unwrap_or_default();
    terminal::profile_paths(&docs).into_iter().enumerate().filter(|(i, p)| *i == 0 || p.parent().map_or(false, |d| d.exists())).map(|(_, p)| p).collect()
}

fn wrapper_state(app: &App) -> Value {
    let Some(helper) = app.helper.as_deref() else { return Value::Null };
    let files = ps_profiles();
    let states: Vec<&str> = files.iter().map(|p| match terminal::read_profile(p) {
        Ok(c) => match terminal::profile_state(&c, helper) { terminal::ProfileState::Ours => "ours", terminal::ProfileState::Stale => "stale", terminal::ProfileState::None => "none" },
        Err(_) => "ansi",
    }).collect();
    let state = if states.contains(&"ansi") { "ansi" } else if states.contains(&"stale") { "stale" } else if states.iter().all(|x| *x == "ours") { "ours" } else if states.contains(&"ours") { "partial" } else { "none" };
    json!({ "state": state, "files": files, "policy": *app.ps_policy.lock().unwrap() })
}

fn last_event_by_host(app: &App) -> std::collections::BTreeMap<String, f64> {
    let sessions = app.ui.lock().unwrap().snapshot.as_ref().and_then(|s| s["sessions"].as_array().cloned()).unwrap_or_default();
    diagnostics::last_event_by_host(&sessions)
}

fn wsl_row(app: &App, id: &str) -> Value {
    let s = app.s();
    let last = last_event_by_host(app);
    let Some(w) = app.wsl_by_id(id) else { return json!({ "id": id, "up": false }) };
    let primary = id == "wsl";
    let port = app.others.lock().unwrap().iter().find(|(i, _, _)| i == id).map(|(_, p, _)| *p);
    let hk = w.request(&json!({ "type": "hooks", "apply": false, "permissions": s.answer_permissions }), "hooks").unwrap_or(Value::Null);
    // the limits ring is fed from the default distro's status line
    let sl = if primary { w.request(&json!({ "type": "statusline" }), "statusline").unwrap_or(Value::Null) } else { Value::Null };
    json!({ "id": id, "port": port, "statusLine": sl["kind"], "statusLineDiff": sl["diff"].as_str().unwrap_or(""), "statusLineError": sl["error"], "up": w.is_up(), "distro": w.distro(),
        "events": hk["events"] == true, "mailbox": hk["mailbox"] == true, "permissions": hk["permissions"] == true, "diff": hk["diff"].as_str().unwrap_or(""), "error": hk["error"], "lastEventAt": last.get(id) })
}

fn connections_state(app: &App) -> Value {
    let s = app.s();
    let ids: Vec<String> = app.others.lock().unwrap().iter().map(|(i, _, _)| i.clone()).collect();
    let others: Vec<Value> = ids.iter().map(|i| wsl_row(app, i)).collect();
    let last = last_event_by_host(app);
    let windows = match app.win_host() {
        Some(w) => {
            let mut st = w.state(s.answer_permissions);
            let sl = w.status_line(false, false);
            st["port"] = json!(w.port()); st["up"] = json!(app.ui.lock().unwrap().win_up);
            st["statusLine"] = sl["kind"].clone(); st["statusLineDiff"] = sl["diff"].clone(); st["statusLineError"] = sl["error"].clone();
            st["lastEventAt"] = json!(last.get("windows"));
            st
        }
        None => json!({ "events": false, "mailbox": false, "permissions": false, "port": 0, "up": false, "settingsPath": "", "diff": "", "statusLine": "none", "statusLineDiff": "" }),
    };
    json!({ "native": false, "answerPermissions": s.answer_permissions, "sdkChats": s.sdk_chats, "newChatIn": s.new_chat_in, "desktopSend": s.desktop_send,
        "helper": app.helper.is_some(), "helperPath": app.helper, "wrapper": wrapper_state(app), "windows": windows, "wsl": wsl_row(app, "wsl"), "others": others })
}

/** Our Windows entries are there but out of date (the app moved, the helper changed, the token is new): offer to update them once per start. */
fn offer_windows_repair(h: &AppHandle) {
    let app = h.state::<Arc<App>>();
    let Some(w) = app.win_host() else { return };
    let perm = app.s().answer_permissions;
    let st = w.state(perm);
    let sl = w.status_line(false, false);
    let mut items = vec![];
    let hooks_diff = st["diff"].as_str().unwrap_or("").to_string();
    if st.get("error").is_none() && (st["events"] == true || st["mailbox"] == true) && !hooks_diff.is_empty() { items.push((windows_settings_label(), hooks_diff.clone())); }
    let sl_diff = sl["diff"].as_str().unwrap_or("").to_string();
    if sl.get("error").is_none() && sl["kind"] != "none" && !sl_diff.is_empty() { items.push((format!("{} (statusLine)", windows_settings_label()), sl_diff.clone())); }
    if items.is_empty() { return; }
    if !confirm_hooks(h, &app.l("Обновить подключение Windows?", "Update the Windows connection?", "更新 Windows 连接？"), &items, None) { return; }
    if items.iter().any(|i| i.1 == hooks_diff) { if let Err(e) = w.apply(perm) { app.log(&format!("windows repair: {e}")); } }
    if !sl_diff.is_empty() && sl["kind"] != "none" { w.status_line(true, false); }
}

#[tauri::command]
async fn connections(h: AppHandle) -> Value {
    tauri::async_runtime::spawn_blocking(move || connections_state(&h.state::<Arc<App>>())).await.unwrap_or(Value::Null)
}

#[tauri::command]
async fn connections_apply(h: AppHandle, host: String, action: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || { connections_apply_now(&h, &host, &action); connections_state(&h.state::<Arc<App>>()) }).await.unwrap_or(Value::Null)
}

fn connections_apply_now(h: &AppHandle, host: &str, action: &str) {
    let app = h.state::<Arc<App>>();
    let perm = app.s().answer_permissions;
    let remove = action == "disconnect";
    let cant_read = || app.l("Не удалось прочитать settings.json", "Could not read settings.json", "无法读取 settings.json");
    let cant_write = || app.l("Не удалось записать настройки", "Could not write the settings", "无法写入设置");
    let sl_title = |off: bool| if off { app.l("Отключить статус-строку от питомца?", "Disconnect the status line from the pet?", "断开状态栏与宠物的连接？") } else { app.l("Подключить статус-строку (лимиты)?", "Connect the status line (limits)?", "连接状态栏（额度）？") };
    if host == "windows" && app.sandbox { return; } // a sandbox shows the real files read-only
    if host == "windows" && (action == "wrapper" || action == "wrapper-off") {
        let Some(helper) = app.helper.clone() else { return };
        let off = action == "wrapper-off";
        let r: Result<(), String> = (|| {
            let mut items = vec![];
            for f in ps_profiles() {
                let cur = terminal::read_profile(&f)?;
                let (next, diff) = if off { terminal::remove_from_profile(&cur) } else { terminal::plan_profile(&cur, &helper) };
                if !diff.is_empty() { items.push((f, next, diff)); }
            }
            let shown: Vec<(String, String)> = items.iter().map(|(f, _, d)| (f.to_string_lossy().into_owned(), d.clone())).collect();
            let title = if off { app.l("Убрать обёртку claude из профиля PowerShell?", "Remove the claude wrapper from the PowerShell profile?", "从 PowerShell 配置文件中移除 claude 包装器？") } else { app.l("Добавить обёртку claude в профиль PowerShell?", "Add the claude wrapper to the PowerShell profile?", "将 claude 包装器添加到 PowerShell 配置文件？") };
            let note = app.l("Копия файла сохранится рядом (.bak). Меняются только строки между метками ccPet. Новые окна PowerShell будут запускать claude через обёртку.", "A copy of the file is kept next to it (.bak). Only the lines between the ccPet markers change. New PowerShell windows will start claude through the wrapper.", "文件的备份会保存在旁边（.bak）。只修改 ccPet 标记之间的行。新的 PowerShell 窗口将通过包装器启动 claude。");
            if !items.is_empty() && confirm_hooks(h, &title, &shown, Some(note)) { for (f, next, _) in &items { terminal::apply_profile(f, next)?; } }
            Ok(())
        })();
        if let Err(e) = r { info(h, &app.l("Не удалось изменить профиль PowerShell", "Could not change the PowerShell profile", "无法修改 PowerShell 配置文件"), &e); }
    } else if host == "windows" && (action == "statusline" || action == "statusline-off") {
        let Some(w) = app.win_host() else { return };
        let off = action == "statusline-off";
        let p = w.status_line(false, off);
        if let Some(e) = p["error"].as_str() { info(h, &cant_read(), e); return; }
        let diff = p["diff"].as_str().unwrap_or("");
        if !diff.is_empty() && confirm_hooks(h, &sl_title(off), &[(windows_settings_label(), diff.into())], None) {
            let r = w.status_line(true, off);
            if let Some(e) = r["error"].as_str() { info(h, &cant_write(), e); } else { w.bridge.push_usage(); }
        }
    } else if host == "windows" {
        let Some(w) = app.win_host() else { return };
        let st = w.state(perm);
        if let Some(e) = st["error"].as_str() { info(h, &cant_read(), e); return; }
        let diff = if remove { w.remove_diff() } else { st["diff"].as_str().unwrap_or("").to_string() };
        let title = if remove { app.l("Отключить Windows от питомца?", "Disconnect Windows from the pet?", "断开 Windows 与宠物的连接？") } else { app.l("Подключить Windows-сессии Claude Code?", "Connect Windows Claude Code sessions?", "连接 Windows 的 Claude Code 会话？") };
        if !diff.is_empty() && confirm_hooks(h, &title, &[(windows_settings_label(), diff)], None) {
            if let Err(e) = if remove { w.remove() } else { w.apply(perm) } { info(h, &cant_write(), &e); }
        }
    } else if host.starts_with("wsl") && !app.sandbox {
        let Some(w) = app.wsl_by_id(host) else { return };
        let label = format!("WSL{}", if w.distro().is_empty() { String::new() } else { format!(": {}", w.distro()) });
        if action == "statusline" || action == "statusline-off" {
            let off = action == "statusline-off";
            let p = w.request(&json!({ "type": "statusline", "remove": off }), "statusline").unwrap_or(Value::Null);
            if let Some(e) = p["error"].as_str() { info(h, &cant_read(), e); return; }
            let diff = p["diff"].as_str().unwrap_or("");
            if !diff.is_empty() && confirm_hooks(h, &sl_title(off), &[(format!("~/.claude/settings.json ({label})"), diff.into())], None) {
                w.request(&json!({ "type": "statusline", "apply": true, "remove": off }), "statusline");
            }
        } else {
            let p = w.request(&json!({ "type": "hooks", "apply": false, "remove": remove, "permissions": perm }), "hooks").unwrap_or(Value::Null);
            if let Some(e) = p["error"].as_str() { info(h, &cant_read(), e); return; }
            let diff = p["diff"].as_str().unwrap_or("");
            let title = if remove { app.l(&format!("Отключить {label} от питомца?"), &format!("Disconnect {label} from the pet?"), &format!("断开 {label} 与宠物的连接？")) } else { app.l(&format!("Подключить сессии Claude Code ({label})?"), &format!("Connect Claude Code sessions ({label})?"), &format!("连接 Claude Code 会话（{label}）？")) };
            if !diff.is_empty() && confirm_hooks(h, &title, &[(format!("~/.claude/settings.json ({label})"), diff.into())], None) {
                w.request(&json!({ "type": "hooks", "apply": true, "remove": remove, "permissions": perm }), "hooks");
            }
        }
    }
}

#[tauri::command]
async fn new_chat_in(h: AppHandle, place: Option<String>) -> Value {
    let w = match place.as_deref() { Some("windows") => "windows", Some("desktop") => "desktop", _ => "wsl" };
    update_settings(&h, |s| s.new_chat_in = w.into());
    tauri::async_runtime::spawn_blocking(move || connections_state(&h.state::<Arc<App>>())).await.unwrap_or(Value::Null)
}

#[tauri::command]
async fn desktop_send(h: AppHandle, how: Option<String>) -> Value {
    let v = if how.as_deref() == Some("hook") { "hook" } else { "real" };
    update_settings(&h, |s| s.desktop_send = v.into());
    tauri::async_runtime::spawn_blocking(move || connections_state(&h.state::<Arc<App>>())).await.unwrap_or(Value::Null)
}

#[tauri::command]
async fn sdk_chats(h: AppHandle, on: bool) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let app = h.state::<Arc<App>>();
        if on && !confirm(&h, &app.l("Разрешить питомцу запускать Claude Code через Agent SDK?", "Let the pet start Claude Code through the Agent SDK?", "允许宠物通过 Agent SDK 启动 Claude Code？"),
            &app.l("Питомец сможет начинать новые чаты и продолжать терминальные сессии, запуская второй процесс claude под вашим входом (как если бы вы набрали команду сами). Важно: по правилам Anthropic (code.claude.com/docs/en/legal-and-compliance) сторонние программы на Agent SDK должны работать с API-ключом, а не через вход по подписке Free/Pro/Max. Включайте, только если Claude Code у вас вошёл по API-ключу или вы принимаете этот риск. Без этого новые чаты открываются в терминале, а общаться с уже запущенными сессиями можно через хуки.", "The pet will be able to start new chats and continue terminal sessions by running a second claude process under your login (as if you typed the command yourself). Important: Anthropic rules (code.claude.com/docs/en/legal-and-compliance) say third-party tools built on the Agent SDK should use an API key, not a Free/Pro/Max subscription login. Turn this on only if your Claude Code signs in with an API key or you accept that risk. Without this, new chats open in a terminal, and running sessions can still be reached through the hooks.", "宠物将能够新建聊天并继续终端会话，方式是在您的登录下运行第二个 claude 进程（就像您自己输入命令）。重要：根据 Anthropic 的规则（code.claude.com/docs/en/legal-and-compliance），基于 Agent SDK 的第三方工具应使用 API 密钥，而不是 Free/Pro/Max 订阅登录。仅当您的 Claude Code 使用 API 密钥登录或您接受该风险时才开启。关闭时，新聊天会在终端中打开，已运行的会话仍可通过钩子联系。"),
            &app.l("Включить", "Turn on", "开启"), &app.l("Отмена", "Cancel", "取消")) {
            return connections_state(&app);
        }
        update_settings(&h, |s| s.sdk_chats = on);
        app.to_all_bridges(json!({ "type": "sdk-chats", "on": on }));
        connections_state(&app)
    }).await.unwrap_or(Value::Null)
}

#[tauri::command]
async fn answer_permissions(h: AppHandle, on: bool) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let app = h.state::<Arc<App>>();
        let mut items: Vec<(String, String)> = vec![];
        let win = if app.sandbox { None } else { app.win_host() };
        let ws = win.as_ref().map(|w| w.state(on)).unwrap_or(Value::Null);
        let win_diff = ws["diff"].as_str().unwrap_or("").to_string();
        if ws["events"] == true && ws.get("error").is_none() && !win_diff.is_empty() { items.push((windows_settings_label(), win_diff.clone())); }
        let mut hosts: Vec<Arc<wsl::WslHost>> = vec![];
        if !app.sandbox { hosts.extend(app.wsl_host()); hosts.extend(app.others.lock().unwrap().iter().map(|(_, _, h)| h.clone())); }
        let mut wsl_apply = vec![];
        for w in hosts {
            let wp = w.request(&json!({ "type": "hooks", "apply": false, "permissions": on }), "hooks").unwrap_or(Value::Null);
            let d = wp["diff"].as_str().unwrap_or("").to_string();
            if wp["events"] == true && wp.get("error").map_or(true, Value::is_null) && !d.is_empty() {
                let label = if w.distro().is_empty() { "WSL".to_string() } else { format!("WSL: {}", w.distro()) };
                items.push((format!("~/.claude/settings.json ({label})"), d));
                wsl_apply.push(w);
            }
        }
        let title = if on { app.l("Отвечать на разрешения в питомце?", "Answer permission questions in the pet?", "在宠物中回答权限请求？") } else { app.l("Больше не отвечать на разрешения в питомце?", "Stop answering permission questions in the pet?", "不再在宠物中回答权限请求？") };
        if !items.is_empty() && !confirm_hooks(&h, &title, &items, None) { return connections_state(&app); }
        if !win_diff.is_empty() && ws["events"] == true { if let Some(w) = &win { if let Err(e) = w.apply(on) { info(&h, &app.l("Не удалось записать настройки", "Could not write the settings", "无法写入设置"), &e); } } }
        for w in wsl_apply { w.request(&json!({ "type": "hooks", "apply": true, "permissions": on }), "hooks"); }
        update_settings(&h, |s| s.answer_permissions = on);
        app.to_all_bridges(json!({ "type": "hook-permissions", "on": on }));
        connections_state(&app)
    }).await.unwrap_or(Value::Null)
}

/** "why don't I see my session": every check in one copyable report (no user name, tokens or e-mail in it) */
#[tauri::command]
async fn diagnostics_report(h: AppHandle) -> String {
    tauri::async_runtime::spawn_blocking(move || {
        let app = h.state::<Arc<App>>();
        let c = connections_state(&app);
        let sessions = app.ui.lock().unwrap().snapshot.as_ref().and_then(|s| s["sessions"].as_array().cloned()).unwrap_or_default();
        let row = |id: &str, x: &Value| {
            let of: Vec<&Value> = sessions.iter().filter(|s| diagnostics::host_id_of(s) == id).collect();
            let mut sources: Vec<String> = of.iter().map(|s| s["source"].as_str().unwrap_or("?").to_string()).collect();
            sources.dedup();
            diagnostics::HostDiag { id: id.into(), distro: x["distro"].as_str().map(String::from), up: x["up"] == true, events: x["events"] == true, mailbox: x["mailbox"] == true, permissions: x["permissions"] == true,
                status_line: x["statusLine"].as_str().map(String::from), last_event_at: x["lastEventAt"].as_f64(), sessions: of.len(), sources, error: x["error"].as_str().map(String::from) }
        };
        let s = app.s();
        let user = std::env::var("USERNAME").unwrap_or_default();
        let desktop_chats = app.desktop_entries().values().map(|e| e.desktop_id.clone()).collect::<HashSet<_>>().len();
        let text = diagnostics::format_diagnostics(&diagnostics::DiagData {
            version: env!("CARGO_PKG_VERSION").into(), os: "win32".into(), now: now_ms(), user,
            hosts: vec![row("windows", &c["windows"]), row("wsl", &c["wsl"])],
            helper: app.helper.is_some(), wrapper: c["wrapper"]["state"].as_str().map(String::from), policy: c["wrapper"]["policy"].as_str().map(String::from),
            desktop_chats, new_chat_in: s.new_chat_in.clone(), sdk_chats: s.sdk_chats,
        });
        let _ = h.clipboard().write_text(text.clone());
        text
    }).await.unwrap_or_default()
}

/** open a session in a real terminal (claude --resume); a pet-owned one is released first so only one client writes */
#[tauri::command]
fn open_terminal(h: AppHandle, session_id: String) {
    std::thread::spawn(move || {
        let app = h.state::<Arc<App>>();
        let Some(s) = app.session(&session_id) else { return };
        let (cwd, project) = (s["cwd"].as_str().unwrap_or("").to_string(), s["project"].as_str().unwrap_or("").to_string());
        if let Some(did) = s["desktopId"].as_str() { // a desktop app session: open that very chat in the app (its own deep link), never a second claude
            if let Some(link) = desktop::chat_link(did) { let _ = h.opener().open_url(link, None::<&str>); if !app.sandbox && !NATIVE { winshell::focus_desktop_app(); } }
            return;
        }
        let mark = format!("{project} - Claude {}", session_id.chars().take(4).collect::<String>());
        if s["host"] == "windows" {
            // a wrapped session (pet-helper pty): raise its own terminal; otherwise (or if that fails) a new terminal resumes it
            let marked = s["pty"].as_str().map_or(false, |pipe| ccpet_core::pty_send::send_title(pipe, &mark).is_ok());
            if marked { std::thread::sleep(Duration::from_millis(350)); if winshell::focus_by_title(&mark) { return; } }
            launch(&app, |wt| terminal::windows_terminal_command(&cwd, &session_id, wt));
            return;
        }
        let Some(w) = app.wsl_by_id(s["hostId"].as_str().unwrap_or("wsl")).or_else(|| app.wsl_host()) else { return };
        let owned = s["owned"] == true;
        // the session's own terminal: title its tab, then raise the window with that title
        let focus = |title: &str| if NATIVE {
            native_terminal::native_focus_command(PLATFORM, title, &on_path).map_or(false, |c| std::process::Command::new(&c.file).args(&c.args).output().map_or(false, |o| o.status.success() && !String::from_utf8_lossy(&o.stdout).contains("none")))
        } else { winshell::focus_by_title(title) };
        if !owned {
            if w.mark_terminal(&session_id, &mark) { std::thread::sleep(Duration::from_millis(350)); if focus(&mark) { return; } }
        } else {
            w.send(&json!({ "type": "release", "sessionId": session_id }));
            std::thread::sleep(Duration::from_millis(500));
        }
        let (distro, claude) = (w.distro(), w.claude());
        if NATIVE { open_native_terminal(&h, &cwd, &claude, Some(&session_id), None); return; }
        launch(&app, |wt| terminal::terminal_command(&distro, &cwd, &claude, &session_id, wt));
    });
}

// ---------- window ----------

fn anchor_file(app: &App) -> PathBuf { app.data_dir.join("window.json") }

/** a monitor's work area in logical px (its own scale factor) */
fn work_area(m: &tauri::Monitor) -> placement::Area {
    let (wa, sf) = (m.work_area(), m.scale_factor());
    placement::Area { x: wa.position.x as f64 / sf, y: wa.position.y as f64 / sf, width: wa.size.width as f64 / sf, height: wa.size.height as f64 / sf }
}
// shortcut: logical coordinates across monitors with different scale factors are approximate; fine for one scale, revisit if pets jump between mixed-DPI screens

fn nearest_area(h: &AppHandle, x: f64, y: f64, fallback: placement::Area) -> placement::Area {
    let monitors = h.available_monitors().unwrap_or_default();
    let areas: Vec<placement::Area> = monitors.iter().map(work_area).collect();
    areas.iter().copied().find(|a| x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height)
        .or_else(|| areas.iter().copied().min_by(|a, b| {
            let d = |a: &placement::Area| { let cx = x.clamp(a.x, a.x + a.width); let cy = y.clamp(a.y, a.y + a.height); (cx - x).powi(2) + (cy - y).powi(2) };
            d(a).partial_cmp(&d(b)).unwrap_or(std::cmp::Ordering::Equal)
        }))
        .unwrap_or(fallback)
}

fn start_anchor(app: &App, h: &AppHandle) -> placement::Anchor {
    let primary = h.primary_monitor().ok().flatten().map(|m| work_area(&m)).unwrap_or(placement::Area { x: 0.0, y: 0.0, width: 1280.0, height: 720.0 });
    // dev: CCPET_AT=x,y puts the window's top-left elsewhere (next to the running pet)
    if let Some((x, y)) = std::env::var("CCPET_AT").ok().and_then(|v| { let (a, b) = v.split_once(',')?; Some((a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?)) }) {
        return placement::Anchor { cx: x + STAGE_W / 2.0, bottom: y + IDLE_H };
    }
    let saved = std::fs::read_to_string(anchor_file(app)).ok().and_then(|t| placement::restore_anchor(&t));
    placement::start_anchor(saved, |x, y| nearest_area(h, x, y, primary), primary)
}

/** cursor polling: click-through except over the pet's own elements, hover for the button dock, end of a drag (main.ts hitTimer) */
fn watch_cursor(win: WebviewWindow, app: Arc<App>) {
    std::thread::spawn(move || {
        let (mut over, mut hovering, mut failed) = (false, false, false);
        let _ = win.set_ignore_cursor_events(true);
        loop {
            std::thread::sleep(Duration::from_millis(40));
            if !win.is_visible().unwrap_or(false) { continue; }
            let (c, p, sf) = (win.cursor_position(), win.outer_position(), win.scale_factor());
            let (c, p, sf) = match (&c, &p, &sf) {
                (Ok(c), Ok(p), Ok(sf)) => (*c, *p, *sf),
                _ => {
                    if !failed { failed = true; app.log(&format!("cursor polling failed: {:?} {:?} {:?}", c.err(), p.err(), sf.err())); }
                    continue;
                }
            };
            let (x, y) = ((c.x - p.x as f64) / sf, (c.y - p.y as f64) / sf);
            let mut ui = app.ui.lock().unwrap();
            let hov = over_any(x, y, &ui.hover, 4.0);
            let hit = over_any(x, y, &ui.hit, 2.0);
            // a drag ended: remember where the pet stands, apply a height asked for meanwhile
            let drag_done = ui.last_move.map_or(false, |t| t.elapsed() > Duration::from_millis(1500));
            let mut pending = None;
            if drag_done {
                ui.last_move = None;
                pending = ui.pending_h.take();
                ui.anchor = Some(placement::Anchor { cx: p.x as f64 / sf + STAGE_W / 2.0, bottom: p.y as f64 / sf + IDLE_H });
            }
            let anchor = ui.anchor;
            drop(ui);
            if drag_done {
                if let Some(hh) = pending { let _ = win.set_size(LogicalSize::new(STAGE_W, hh)); }
                if !app.sandbox { if let Some(a) = anchor { let _ = std::fs::write(anchor_file(&app), json!({ "cx": a.cx, "bottom": a.bottom }).to_string()); } } // a sandbox never moves the real pet's saved spot
            }
            if std::env::var("CCPET_DEBUG").is_ok() && (hit != over || hov != hovering) { app.log(&format!("cursor {x:.0},{y:.0} hit={hit} hover={hov}")); }
            if hov != hovering { hovering = hov; let _ = win.emit("pet:hover", hov); }
            if hit != over { over = hit; let _ = win.set_ignore_cursor_events(!hit); }
        }
    });
}

/** Fullscreen apps and games can push a topmost window down, and Windows drops the flag after sleep or a display change: put the pet back
 * on top every 2 s (no focus taken, nothing moves); a pet left outside every screen (monitor unplugged, scaling changed) comes back. */
fn keep_visible(h: AppHandle, win: WebviewWindow) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let app = h.state::<Arc<App>>();
        if !win.is_visible().unwrap_or(false) || app.ui.lock().unwrap().last_move.is_some() { continue; }
        let _ = win.set_always_on_top(false);
        let _ = win.set_always_on_top(true);
        let (Ok(p), Ok(sf)) = (win.outer_position(), win.scale_factor()) else { continue };
        let (x, y) = (p.x as f64 / sf, p.y as f64 / sf);
        let areas: Vec<placement::Area> = h.available_monitors().unwrap_or_default().iter().map(work_area).collect();
        if areas.is_empty() || placement::on_some_screen(x, y, STAGE_W, &areas) { continue; }
        let anchor = app.ui.lock().unwrap().anchor.unwrap_or(placement::Anchor { cx: x + STAGE_W / 2.0, bottom: y + IDLE_H });
        let wa = nearest_area(&h, anchor.cx, anchor.bottom - 1.0, areas[0]);
        let r = placement::place_stage(anchor, STAGE_W, STAGE_H, wa);
        app.ui.lock().unwrap().own_move_until = Some(Instant::now() + Duration::from_millis(300));
        let _ = win.set_position(LogicalPosition::new(r.x, r.y));
        app.ui.lock().unwrap().anchor = Some(placement::Anchor { cx: r.x + STAGE_W / 2.0, bottom: r.y + IDLE_H });
        app.log(&format!("the pet was off screen: moved back to {},{}", r.x, r.y));
    });
}

fn main() {
    let appdata = app_data_root();
    // the app was called "Claude Pet": settings, models and the log stay in that folder (same as the Electron app)
    let sandbox = std::env::var("CCPET_SANDBOX").is_ok();
    // a sandbox (dev, beside the running pet) keeps its own settings, queue and log
    let data_dir = appdata.join(if sandbox { "ccPet-sandbox" } else { "Claude Pet" });
    let _ = std::fs::create_dir_all(&data_dir);
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    // packaged: next to the exe under resources/; dev: the repo's build/, models/ and scripts/
    let rroot = resource_root(&exe_dir);
    let res = |packaged: &str, dev: PathBuf| { let p = rroot.join("resources").join(packaged); if p.exists() { p } else { dev } };
    let bridge = std::env::var("CCPET_BRIDGE").map(PathBuf::from).unwrap_or_else(|_| res("hook/ccpet-bridge", repo.join("build").join("hook").join("ccpet-bridge")));
    let settings = settings::load(&data_dir.join("settings.json"));
    // hooks, the status line and the PowerShell wrapper use a stable copy of pet-helper.exe (it is busy for as long as sessions live; the install
    // folder must stay replaceable by the next installer); a sandbox uses the installed one as it is
    let installed_helper = res("helper/pet-helper.exe", repo.join("ui").join("helper").join("pet-helper.exe"));
    let helper = if NATIVE || !installed_helper.is_file() { None } else if sandbox { Some(installed_helper.to_string_lossy().into_owned()) } else {
        let dir = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| data_dir.clone()).join("ccPet").join("bin");
        winshell::sync_helper(&installed_helper, &dir).path
    };
    let queue_file = data_dir.join("queue.json");
    let loaded = std::fs::read_to_string(&queue_file).ok().and_then(|t| serde_json::from_str(&t).ok());
    let qf = queue_file.clone();
    let app = Arc::new(App {
        models_dirs: vec![res("models", repo.join("models")), data_dir.join("models")],
        scripts_dir: res("scripts", repo.join("scripts")),
        sandbox,
        // installed by the setup (autostart, update check): a build run from the repo or the cargo target folder is not
        packaged: !cfg!(debug_assertions) && (if cfg!(windows) { exe_dir.join("uninstall.exe").is_file() } else { rroot.join("resources").join("hook").exists() }),
        lang: Mutex::new(resolve_lang(&settings.language)),
        settings: Mutex::new(settings),
        helper,
        desktop: Mutex::new((desktop::DesktopRegistry::new(move || desktop::find_registry_roots(&std::env::var("LOCALAPPDATA").unwrap_or_default(), &std::env::var("APPDATA").unwrap_or_default())), None, HashMap::new())),
        others: Mutex::new(vec![]), push_lock: Mutex::new(()), keys_tx: Mutex::new(None), ps_policy: Mutex::new(None), win: Mutex::new(None),
        queue: Mutex::new(MessageQueue::new(Box::new(move |d| { let _ = std::fs::write(&qf, d.to_string()); }), loaded)),
        data_dir, ui: Mutex::new(Ui::default()), wsl: Mutex::new(None),
    });

    let mut builder = tauri::Builder::default();
    // a second launch only summons the running pet; a sandbox runs next to the installed pet, so it skips the lock
    if !sandbox { builder = builder.plugin(tauri_plugin_single_instance::init(|h, _, _| summon(h))); }
    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app.clone())
        .invoke_handler(tauri::generate_handler![config, cmd, rects, hover_rects, resize, focus, start_drag, context_menu, set_scale, set_appearance, set_permissions, set_language, copy_text, open_url, notify, pick_folder, open_terminal, connections, connections_apply, answer_permissions, sdk_chats, new_chat_in, desktop_send, diagnostics_report, models_list, models_data, models_use, models_install_zip, models_remove, models_codex_scan, models_codex_import, models_reveal])
        .setup(move |tapp| {
            #[cfg(target_os = "macos")]
            tapp.set_activation_policy(tauri::ActivationPolicy::Accessory); // a menu-bar style app: no Dock icon
            let handle = tapp.handle().clone();
            let anchor = start_anchor(&app, &handle);
            app.ui.lock().unwrap().anchor = Some(anchor);
            let wa = nearest_area(&handle, anchor.cx, anchor.bottom - 1.0, placement::Area { x: 0.0, y: 0.0, width: 1280.0, height: 720.0 });
            let r = placement::place_stage(anchor, STAGE_W, STAGE_H, wa);
            let win = WebviewWindowBuilder::new(tapp, "main", WebviewUrl::App("index.html".into()))
                .title("ccPet").inner_size(STAGE_W, STAGE_H).position(r.x, r.y)
                .decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false).shadow(false)
                .maximizable(false).minimizable(false).visible(false).focused(false)
                .initialization_script(include_str!("pet-host.js"))
                .build()?;
            // the pet runs the way it is dragged
            let (app2, w2) = (app.clone(), win.clone());
            win.on_window_event(move |e| if let WindowEvent::Moved(p) = e {
                let sf = w2.scale_factor().unwrap_or(1.0);
                let x = p.x as f64 / sf;
                let mut ui = app2.ui.lock().unwrap();
                if ui.own_move_until.map_or(false, |t| Instant::now() < t) { ui.last_x = Some(x); return; } // our own move, not the user dragging
                let dx = ui.last_x.map_or(0.0, |l| x - l);
                ui.last_x = Some(x);
                ui.last_move = Some(Instant::now());
                drop(ui);
                if dx != 0.0 { let _ = w2.emit("pet:moving", dx); }
            });
            watch_cursor(win.clone(), app.clone());
            keep_visible(handle.clone(), win.clone());
            let _ = win.set_position(LogicalPosition::new(r.x, r.y));
            let _ = win.show();
            TrayIconBuilder::with_id("main")
                .icon(tapp.default_window_icon().cloned().ok_or("no app icon")?)
                .tooltip("ccPet").menu(&build_menu(&handle)?).show_menu_on_left_click(false)
                .on_tray_icon_event(|t, e| if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e { toggle_window(t.app_handle()); })
                .on_menu_event(|h, e| on_menu(h, e.id.as_ref()))
                .build(tapp)?;
            *app.keys_tx.lock().unwrap() = Some(answer_keys_worker(handle.clone()));
            register_hotkey(&handle);
            // sandbox (dev, next to the running pet): its own pet dir and hook port, so the live one is untouched; no hook install offers
            let exports = if app.sandbox {
                vec![("CLAUDE_PET_DIR".into(), "$HOME/.claude-pet-tauri".into()), ("CLAUDE_PET_HOOK_PORT".into(), "47993".into()), ("CLAUDE_PET_LIVE_USAGE".into(), "0".into())]
            } else { vec![] };
            *app.wsl.lock().unwrap() = Some(wsl::WslHost::start(String::new(), bridge.to_string_lossy().into_owned(), exports, Arc::new(Events { handle: handle.clone(), id: "wsl".into() })));
            // the Windows host: Claude Code's HTTP hooks on 127.0.0.1:47821; a sandbox leaves that port to the running pet (CCPET_WIN_PORT
            // gives it its own, with its own token: nothing installed points there, it only adopts sessions from transcripts)
            let win_port = if NATIVE { None } else if app.sandbox { std::env::var("CCPET_WIN_PORT").ok().and_then(|p| p.parse::<u16>().ok()) } else { Some(windows_host::PORT) };
            if let Some(port) = win_port {
                let home = home_dir();
                let h3 = handle.clone();
                let w = WindowsHost::new(&app.data_dir, home.join(".claude"), port, app.helper.clone(), Box::new(move |m| windows_message(&h3, m)));
                w.bridge.handle(&json!({ "type": "language", "lang": *app.lang.lock().unwrap() }));
                w.bridge.handle(&json!({ "type": "hook-permissions", "on": app.s().answer_permissions }));
                *app.win.lock().unwrap() = Some(w.clone());
                let h4 = handle.clone();
                std::thread::spawn(move || {
                    let app = h4.state::<Arc<App>>();
                    match w.start() {
                        Ok(()) => {
                            app.ui.lock().unwrap().win_up = true;
                            let _ = h4.emit("pet:bridge", true);
                            app.log(&format!("windows host listening on 127.0.0.1:{}", w.port()));
                            w.bridge.push_usage();
                            if !app.sandbox {
                                winshell::unhide_desktop(); // a send cut short by a crash must not leave the Claude app's window invisible
                                offer_windows_repair(&h4);
                            }
                        }
                        Err(e) => { app.log(&format!("windows host not started: {e}")); let _ = h4.emit("pet:msg", json!({ "type": "error", "message": e })); }
                    }
                });
                // a chat renamed, archived or deleted in the app shows up within 5 s (the registry is re-read when older)
                let h5 = handle.clone();
                std::thread::spawn(move || loop { std::thread::sleep(Duration::from_secs(5)); push_snapshot(&h5); });
                // PowerShell's execution policy, for the wrapper row of Connections
                let h6 = handle.clone();
                std::thread::spawn(move || {
                    let mut c = std::process::Command::new("powershell.exe");
                    c.args(["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"]);
                    #[cfg(windows)]
                    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
                    if let Ok(o) = c.output() { *h6.state::<Arc<App>>().ps_policy.lock().unwrap() = Some(String::from_utf8_lossy(&o.stdout).trim().to_string()); }
                });
            }
            // other running WSL 2 distros are followed too (a stopped one is never started); checked every 30 s
            if !app.sandbox && !NATIVE {
                let (h7, bridge7) = (handle.clone(), bridge.to_string_lossy().into_owned());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(4));
                    loop {
                        follow_distros(&h7, &bridge7);
                        std::thread::sleep(Duration::from_secs(30));
                    }
                });
            }
            let h8 = handle.clone();
            std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(20)); loop { check_updates(&h8); std::thread::sleep(Duration::from_secs(24 * 3600)); } });
            // timed messages and turns that ended without a fresh snapshot
            let h2 = handle.clone();
            std::thread::spawn(move || loop { std::thread::sleep(Duration::from_secs(2)); drain_queue(&h2); });
            app.log(&format!("started, bridge={}", bridge.display()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app")
        .run(|h, e| if let tauri::RunEvent::Exit = e {
            let app = h.state::<Arc<App>>();
            let primary = app.wsl.lock().unwrap().take();
            if let Some(w) = primary { w.stop(); }
            let others: Vec<_> = app.others.lock().unwrap().drain(..).collect();
            for (_, _, w) in others { w.stop(); }
            let win = app.win.lock().unwrap().take();
            if let Some(w) = win { w.stop(); }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hit_test_and_png_size() {
        let r = [Rect { x: 10.0, y: 10.0, w: 5.0, h: 5.0 }];
        assert!(over_any(16.0, 12.0, &r, 2.0) && !over_any(18.0, 12.0, &r, 2.0));
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        png.extend_from_slice(b"IHDR"); png.extend_from_slice(&1536u32.to_be_bytes()); png.extend_from_slice(&2288u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((1536, 2288)));
    }
    #[test]
    fn iso_time_shape() {
        let t = now_iso();
        assert_eq!(t.len(), 24);
        assert!(t.starts_with("20") && t.ends_with('Z') && &t[10..11] == "T");
    }
}
