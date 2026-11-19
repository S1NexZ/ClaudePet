//! ccPet desktop app on Tauri (phase 3): replaces ui/src/main.ts. The renderer is ui/dist unchanged; src/pet-host.js gives it the
//! `window.petHost` that ui/src/preload.cjs gives it under Electron.
//! Done: the pet window (click-through, hover, drag, resize, keep on top, off-screen rescue), the default distro's WSL bridge,
//! settings, tray, hotkeys (summon, Ctrl+Alt+1-9), single instance, autostart, notifications, hook install offer, message queue.
//! Not yet (M3/M4): the Windows host, several distros, models, connections panel, desktop app sending, update check.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod wsl;

use base64::Engine;
use ccpet_app::{merge, placement, queue::MessageQueue, settings::{self, Settings}};
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
    snapshot: Option<Value>,
    last_move: Option<Instant>,
    last_x: Option<f64>,
    /** a height asked for during a drag: applied when the drag ends (the OS owns the window meanwhile) */
    pending_h: Option<f64>,
    anchor: Option<placement::Anchor>,
    answer_keys_on: bool,
    hooks_manual: bool,
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
    fn to_bridge(&self, cmd: Value) { if let Some(h) = self.wsl.lock().unwrap().as_ref() { h.send(&cmd); } }
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
    if app.packaged {
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
    let app = h.state::<Arc<App>>();
    let want = app.s().answer_keys && {
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
    let items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = vec![
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
        Box::new(CheckMenuItem::with_id(h, "autostart", l("Запускать вместе с Windows", "Start with Windows", "随 Windows 启动"), app.packaged, s.autostart, None::<&str>)?),
        Box::new(sep()?),
        Box::new(MenuItem::with_id(h, "support", l("Поддержать проект ❤", "Support the project ❤", "支持项目 ❤"), true, None::<&str>)?),
        Box::new(MenuItem::with_id(h, "quit", l("Выйти", "Quit", "退出"), true, None::<&str>)?),
    ];
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

/** a question with the safe answer as the cancel button; true = the action was chosen */
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
    let snap = {
        let ui = app.ui.lock().unwrap();
        merge::merge_snapshots(&[merge::HostPart { host: "wsl".into(), snap: ui.wsl_snap.clone(), distro: None }])
    };
    let sessions = app.queue.lock().unwrap().decorate(snap["sessions"].as_array().cloned().unwrap_or_default());
    let attention = if sessions.iter().any(|s| s["id"] == snap["attention"]) { snap["attention"].clone() } else { merge::pick_attention(&sessions).map_or(Value::Null, |s| s["id"].clone()) };
    let out = json!({ "type": "snapshot", "sessions": sessions, "attention": attention });
    app.ui.lock().unwrap().snapshot = Some(out.clone());
    let _ = h.emit("pet:msg", out);
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
        let reachable = s.map_or(false, |s| s["owned"] == true || !s["pty"].is_null() && s.get("pty").is_some() || s["mailbox"] == true);
        if !reachable {
            app.log(&format!("queue: {sid} cannot take a message without the user; dropped"));
            let note = app.l(&format!("Сообщение из очереди не отправлено: у сессии нет связи с питомцем. Текст: {text}"), &format!("A queued message was not sent: the session has no link to the pet. Text: {text}"), &format!("排队消息未发送：会话未连接到宠物。内容：{text}"));
            let _ = h.emit("pet:msg", json!({ "type": "chat", "sessionId": sid, "event": { "kind": "note", "text": note } }));
            continue;
        }
        app.log(&format!("queue: sending a waiting message to {sid}"));
        app.to_bridge(json!({ "type": "send", "sessionId": sid, "text": text, "queued": true }));
    }
}

fn now_ms() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64) }

/** the WSL bridge's messages, as main.ts handles them */
struct Events { handle: AppHandle }
impl wsl::HostEvents for Events {
    fn ready(&self, claude: &str) {
        let app = self.handle.state::<Arc<App>>();
        let s = app.s();
        app.to_bridge(json!({ "type": "language", "lang": *app.lang.lock().unwrap() }));
        app.to_bridge(json!({ "type": "permission-mode", "mode": s.permissions }));
        app.to_bridge(json!({ "type": "hook-permissions", "on": s.answer_permissions }));
        app.to_bridge(json!({ "type": "sdk-chats", "on": s.sdk_chats }));
        if !app.sandbox { app.to_bridge(json!({ "type": "hooks", "apply": false })); }
        if claude.is_empty() {
            let h = self.handle.clone();
            std::thread::spawn(move || { let app = h.state::<Arc<App>>(); info(&h, &app.l("Claude Code не найден в WSL", "Claude Code not found in WSL", "在 WSL 中未找到 Claude Code"), &app.l("Установи Claude Code в WSL, чтобы питомец мог запускать сессии.", "Install Claude Code in WSL so the pet can start sessions.", "请在 WSL 中安装 Claude Code，宠物才能启动会话。")); });
        }
        push_snapshot(&self.handle);
    }
    fn up(&self, up: bool) {
        let app = self.handle.state::<Arc<App>>();
        { let mut ui = app.ui.lock().unwrap(); ui.up = up; if !up { ui.wsl_snap = None; } }
        let _ = self.handle.emit("pet:bridge", up);
        if !up { push_snapshot(&self.handle); }
        refresh_tray(&self.handle);
    }
    fn message(&self, m: Value) {
        let app = self.handle.state::<Arc<App>>();
        match m["type"].as_str() {
            Some("snapshot") => { app.ui.lock().unwrap().wsl_snap = Some(m); push_snapshot(&self.handle); }
            Some("usage") => { let u = merge::merge_usage(&[m["usage"].clone()]); let _ = self.handle.emit("pet:msg", json!({ "type": "usage", "usage": u })); }
            Some("hooks") => { let h = self.handle.clone(); std::thread::spawn(move || on_hooks(&h, &m)); }
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
        "bridge": ui.up, "snapshot": ui.snapshot, "expanded": false, "panel": false,
        "appearance": s.appearance, "permissions": s.permissions, "answerKeys": s.answer_keys,
        "lang": *app.lang.lock().unwrap(), "language": s.language, "petScale": s.pet_scale,
        "pet": pet_payload(&dir)?,
    }))
}

#[tauri::command]
fn cmd(h: AppHandle, app: St, cmd: Value) {
    let t = cmd["type"].as_str().unwrap_or("");
    // messages for later live in the app (it sees every host's state)
    if t == "queue" {
        if let (Some(sid), Some(text)) = (cmd["sessionId"].as_str(), cmd["text"].as_str().map(str::trim).filter(|x| !x.is_empty())) {
            app.queue.lock().unwrap().add(sid, text, cmd["at"].as_f64().filter(|a| a.is_finite()));
            push_snapshot(&h);
        }
        return;
    }
    if t == "unqueue" {
        if let Some(sid) = cmd["sessionId"].as_str() { app.queue.lock().unwrap().remove(sid, cmd["id"].as_str()); push_snapshot(&h); }
        return;
    }
    app.to_bridge(cmd);
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
    app.to_bridge(json!({ "type": "language", "lang": *app.lang.lock().unwrap() }));
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
            let drag_done = ui.last_move.map_or(false, |t| t.elapsed() > Duration::from_millis(600));
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
        let _ = win.set_position(LogicalPosition::new(r.x, r.y));
        app.ui.lock().unwrap().anchor = Some(placement::Anchor { cx: r.x + STAGE_W / 2.0, bottom: r.y + IDLE_H });
        app.log(&format!("the pet was off screen: moved back to {},{}", r.x, r.y));
    });
}

fn main() {
    let appdata = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    // the app was called "Claude Pet": settings, models and the log stay in that folder (same as the Electron app)
    let sandbox = std::env::var("CCPET_SANDBOX").is_ok();
    // a sandbox (dev, beside the running pet) keeps its own settings, queue and log
    let data_dir = appdata.join(if sandbox { "ccPet-sandbox" } else { "Claude Pet" });
    let _ = std::fs::create_dir_all(&data_dir);
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    // packaged: next to the exe under resources/; dev: the repo's build/, models/ and scripts/
    let res = |packaged: &str, dev: PathBuf| { let p = exe_dir.join("resources").join(packaged); if p.exists() { p } else { dev } };
    let bridge = std::env::var("CCPET_BRIDGE").map(PathBuf::from).unwrap_or_else(|_| res("hook/ccpet-bridge", repo.join("build").join("hook").join("ccpet-bridge")));
    let settings = settings::load(&data_dir.join("settings.json"));
    let queue_file = data_dir.join("queue.json");
    let loaded = std::fs::read_to_string(&queue_file).ok().and_then(|t| serde_json::from_str(&t).ok());
    let qf = queue_file.clone();
    let app = Arc::new(App {
        models_dirs: vec![res("models", repo.join("models")), data_dir.join("models")],
        scripts_dir: res("scripts", repo.join("scripts")),
        sandbox,
        packaged: !cfg!(debug_assertions),
        lang: Mutex::new(resolve_lang(&settings.language)),
        settings: Mutex::new(settings),
        queue: Mutex::new(MessageQueue::new(Box::new(move |d| { let _ = std::fs::write(&qf, d.to_string()); }), loaded)),
        data_dir, ui: Mutex::new(Ui::default()), wsl: Mutex::new(None),
    });

    tauri::Builder::default()
        // a second launch only summons the running pet
        .plugin(tauri_plugin_single_instance::init(|h, _, _| summon(h)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app.clone())
        .invoke_handler(tauri::generate_handler![config, cmd, rects, hover_rects, resize, focus, start_drag, context_menu, set_scale, set_appearance, set_permissions, set_language, copy_text, open_url, notify, pick_folder])
        .setup(move |tapp| {
            let handle = tapp.handle().clone();
            let anchor = start_anchor(&app, &handle);
            app.ui.lock().unwrap().anchor = Some(anchor);
            let wa = nearest_area(&handle, anchor.cx, anchor.bottom - 1.0, placement::Area { x: 0.0, y: 0.0, width: 1280.0, height: 720.0 });
            let r = placement::place_stage(anchor, STAGE_W, STAGE_H, wa);
            let win = WebviewWindowBuilder::new(tapp, "main", WebviewUrl::App("index.html".into()))
                .title("ccPet").inner_size(STAGE_W, STAGE_H).position(r.x, r.y)
                .decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false).shadow(false)
                .maximizable(false).minimizable(false).visible(false)
                .initialization_script(include_str!("pet-host.js"))
                .build()?;
            // the pet runs the way it is dragged
            let (app2, w2) = (app.clone(), win.clone());
            win.on_window_event(move |e| if let WindowEvent::Moved(p) = e {
                let sf = w2.scale_factor().unwrap_or(1.0);
                let x = p.x as f64 / sf;
                let mut ui = app2.ui.lock().unwrap();
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
            register_hotkey(&handle);
            // sandbox (dev, next to the running pet): its own pet dir and hook port, so the live one is untouched; no hook install offers
            let exports = if app.sandbox {
                vec![("CLAUDE_PET_DIR".into(), "$HOME/.claude-pet-tauri".into()), ("CLAUDE_PET_HOOK_PORT".into(), "47993".into()), ("CLAUDE_PET_LIVE_USAGE".into(), "0".into())]
            } else { vec![] };
            *app.wsl.lock().unwrap() = Some(wsl::WslHost::start(bridge.to_string_lossy().into_owned(), exports, Arc::new(Events { handle: handle.clone() })));
            // timed messages and turns that ended without a fresh snapshot
            let h2 = handle.clone();
            std::thread::spawn(move || loop { std::thread::sleep(Duration::from_secs(2)); drain_queue(&h2); });
            app.log(&format!("started, bridge={}", bridge.display()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app")
        .run(|h, e| if let tauri::RunEvent::Exit = e {
            if let Some(w) = h.state::<Arc<App>>().wsl.lock().unwrap().take() { w.stop(); }
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
