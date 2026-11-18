//! ccPet desktop app on Tauri (phase 3, milestone 1): the pet window, click-through, dragging, the default WSL distro's bridge.
//! The renderer is ui/dist unchanged; src/pet-host.js gives it the `window.petHost` that ui/src/preload.cjs gives it under Electron.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod wsl;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/** constant width; the height follows the renderer (panels open downwards from the pet) */
const STAGE_W: f64 = 424.0;
const STAGE_H: f64 = 260.0;
const MAX_H: f64 = 1000.0;
/** placement.ts IDLE_H: the anchor (the pet's feet) is this far below the window's top */
const IDLE_H: f64 = 238.0;

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
    snapshot: Option<Value>,
    last_move: Option<Instant>,
    last_x: Option<f64>,
}

struct App {
    data_dir: PathBuf,
    models_dirs: Vec<PathBuf>,
    ui: Mutex<Ui>,
    wsl: Mutex<Option<Arc<wsl::WslHost>>>,
}

impl App {
    fn log(&self, m: &str) {
        let line = format!("{} [tauri] {m}\n", now_iso());
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(self.data_dir.join("pet.log")) { let _ = f.write_all(line.as_bytes()); }
    }
    fn settings(&self) -> Value {
        std::fs::read_to_string(self.data_dir.join("settings.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}))
    }
}

fn now_iso() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("@{ms}") // shortcut: epoch ms instead of an ISO date, until the log is shared with more code
}

/** `<dir>/<id>/pet.json` of the chosen model, else the default one, else any */
fn model_dir(dirs: &[PathBuf], chosen: &str) -> Option<PathBuf> {
    let valid = |id: &str| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    for id in [chosen, "claude-maiden"] {
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

fn lang(pref: &str) -> &'static str {
    match pref { "ru" => "ru", "en" => "en", "zh" => "zh", _ => {
        let loc = std::env::var("CCPET_LOCALE").unwrap_or_default(); // shortcut: no system-locale lookup yet (M2); Russian is the owner's default
        if loc.starts_with("zh") { "zh" } else if loc.starts_with("en") { "en" } else { "ru" }
    } }
}

#[tauri::command]
fn config(app: tauri::State<Arc<App>>) -> Result<Value, String> {
    let s = app.settings();
    let dir = model_dir(&app.models_dirs, s["model"].as_str().unwrap_or("")).ok_or("no pet model found")?;
    let ui = app.ui.lock().unwrap();
    Ok(json!({
        "bridge": ui.up, "snapshot": ui.snapshot, "expanded": false, "panel": false,
        "appearance": s.get("appearance").cloned().unwrap_or(json!({ "primary": null, "accent": null })),
        "permissions": s["permissions"].as_str().unwrap_or("ask"), "answerKeys": s["answerKeys"].as_bool().unwrap_or(true),
        "lang": lang(s["language"].as_str().unwrap_or("auto")), "language": s["language"].as_str().unwrap_or("auto"),
        "petScale": s["petScale"].as_f64().unwrap_or(1.0).clamp(0.6, 1.8),
        "pet": pet_payload(&dir)?,
    }))
}

#[tauri::command]
fn cmd(app: tauri::State<Arc<App>>, cmd: Value) {
    if let Some(h) = app.wsl.lock().unwrap().as_ref() { h.send(&cmd); }
}

#[tauri::command]
fn rects(app: tauri::State<Arc<App>>, rects: Vec<Rect>) { app.ui.lock().unwrap().hit = rects; }

#[tauri::command]
fn hover_rects(app: tauri::State<Arc<App>>, rects: Vec<Rect>) { app.ui.lock().unwrap().hover = rects; }

#[tauri::command]
fn resize(win: WebviewWindow, h: f64) {
    let h = h.clamp(120.0, MAX_H).ceil();
    let _ = win.set_size(LogicalSize::new(STAGE_W, h)); // the window hangs from the pet's top: growing downwards never moves the pet
}

#[tauri::command]
fn focus(win: WebviewWindow) { let _ = win.set_focus(); }

#[tauri::command]
fn start_drag(win: WebviewWindow) { let _ = win.start_dragging(); }

/** the WSL bridge's messages, as main.ts forwards them to the renderer (sessions tagged with their host) */
struct Events { app: Arc<App>, handle: tauri::AppHandle }
impl wsl::HostEvents for Events {
    fn up(&self, up: bool) {
        let mut ui = self.app.ui.lock().unwrap();
        ui.up = up;
        if !up { ui.snapshot = None; }
        drop(ui);
        let _ = self.handle.emit("pet:bridge", up);
    }
    fn message(&self, mut m: Value) {
        match m["type"].as_str() {
            Some("snapshot") => {
                if let Some(list) = m["sessions"].as_array_mut() {
                    for s in list { s["host"] = json!("wsl"); s["hostId"] = json!("wsl"); }
                }
                self.app.ui.lock().unwrap().snapshot = Some(m.clone());
            }
            Some("hooks") | Some("statusline") | Some("termMark") => return, // M2/M3: dialogs and the terminal focus
            _ => {}
        }
        let _ = self.handle.emit("pet:msg", m);
    }
    fn log(&self, line: &str) { self.app.log(line); }
}

fn anchor_file(app: &App) -> PathBuf { app.data_dir.join("window.json") }

/** where the pet stood last time (window.json, shared with the Electron app), else the primary screen's bottom right */
fn start_position(app: &App, handle: &tauri::AppHandle) -> (f64, f64) {
    let saved = std::fs::read_to_string(anchor_file(app)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    if let Some(a) = saved.filter(|a| a["cx"].is_number() && a["bottom"].is_number()) {
        return (a["cx"].as_f64().unwrap() - STAGE_W / 2.0, a["bottom"].as_f64().unwrap() - IDLE_H);
    }
    if let Ok(Some(m)) = handle.primary_monitor() {
        let sf = m.scale_factor();
        let (w, h) = (m.size().width as f64 / sf, m.size().height as f64 / sf);
        return (w - 160.0 - STAGE_W / 2.0, (h - 440.0).max(260.0) - IDLE_H);
    }
    (100.0, 100.0)
}

/** cursor polling: click-through except over the pet's own elements, hover for the button dock, end of a drag (main.ts hitTimer) */
fn watch_cursor(win: WebviewWindow, app: Arc<App>) {
    std::thread::spawn(move || {
        let (mut over, mut hovering) = (false, false);
        let _ = win.set_ignore_cursor_events(true);
        loop {
            std::thread::sleep(Duration::from_millis(40));
            let (Ok(c), Ok(p), Ok(sf)) = (win.cursor_position(), win.outer_position(), win.scale_factor()) else { continue };
            let (x, y) = ((c.x - p.x as f64) / sf, (c.y - p.y as f64) / sf);
            let mut ui = app.ui.lock().unwrap();
            let hov = over_any(x, y, &ui.hover, 4.0);
            let hit = over_any(x, y, &ui.hit, 2.0);
            // a drag ended: remember where the pet stands
            let drag_done = ui.last_move.map_or(false, |t| t.elapsed() > Duration::from_millis(600));
            if drag_done { ui.last_move = None; }
            drop(ui);
            if drag_done {
                let a = json!({ "cx": p.x as f64 / sf + STAGE_W / 2.0, "bottom": p.y as f64 / sf + IDLE_H });
                let _ = std::fs::write(anchor_file(&app), a.to_string());
            }
            if hov != hovering { hovering = hov; let _ = win.emit("pet:hover", hov); }
            if hit != over { over = hit; let _ = win.set_ignore_cursor_events(!hit); }
        }
    });
}

fn main() {
    let appdata = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    // the app was called "Claude Pet": settings, models and the log stay in that folder (same as the Electron app)
    let data_dir = appdata.join("Claude Pet");
    let _ = std::fs::create_dir_all(&data_dir);
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    // packaged: next to the exe under resources/; dev: the repo's build/ and models/
    let res = |packaged: &str, dev: PathBuf| { let p = exe_dir.join("resources").join(packaged); if p.exists() { p } else { dev } };
    let bridge = std::env::var("CCPET_BRIDGE").map(PathBuf::from).unwrap_or_else(|_| res("hook/ccpet-bridge", repo.join("build").join("hook").join("ccpet-bridge")));
    let app = Arc::new(App {
        models_dirs: vec![res("models", repo.join("models")), data_dir.join("models")],
        data_dir, ui: Mutex::new(Ui::default()), wsl: Mutex::new(None),
    });

    tauri::Builder::default()
        .manage(app.clone())
        .invoke_handler(tauri::generate_handler![config, cmd, rects, hover_rects, resize, focus, start_drag])
        .setup(move |tapp| {
            let handle = tapp.handle().clone();
            let (x, y) = start_position(&app, &handle);
            let win = WebviewWindowBuilder::new(tapp, "main", WebviewUrl::App("index.html".into()))
                .title("ccPet").inner_size(STAGE_W, STAGE_H).position(x, y)
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
            let _ = win.set_position(LogicalPosition::new(x, y));
            let _ = win.show();
            // sandbox (dev, next to the running Electron pet): its own pet dir, socket and hook port, so the live one is untouched
            let exports = if std::env::var("CCPET_SANDBOX").is_ok() {
                vec![("CLAUDE_PET_DIR".into(), "$HOME/.claude-pet-tauri".into()), ("CLAUDE_PET_HOOK_PORT".into(), "47993".into()), ("CLAUDE_PET_LIVE_USAGE".into(), "0".into())]
            } else { vec![] };
            let ev = Arc::new(Events { app: app.clone(), handle: handle.clone() });
            *app.wsl.lock().unwrap() = Some(wsl::WslHost::start(bridge.to_string_lossy().into_owned(), exports, ev));
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
}
