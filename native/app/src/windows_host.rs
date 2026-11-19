//! The Windows side of the pet (ui/src/hub/windowsHost.ts): the same transport-free bridge the WSL process runs, inside the app,
//! fed by Claude Code's HTTP hooks (PowerShell / CMD / Windows Terminal / VS Code / the desktop app all read %USERPROFILE%\.claude\settings.json).
//! Messages to its sessions go through the mailbox; there is no second `claude` process here.

use ccpet_core::adopt;
use ccpet_core::bridge::{Bridge, BridgeOpts, Runner};
use ccpet_core::hook_http::{HookServer, HookServerOpts};
use ccpet_core::i18n::l;
use ccpet_core::install::{self, Chain};
use ccpet_core::mailbox::Mailbox;
use ccpet_core::types::HookEvent;
use ccpet_core::usage::{now_ms, UsageSource};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const PORT: u16 = 47821;

/** every claude path says why it is not here (windowsHost.ts runner stubs) */
struct WinRunner;
fn no<T>(ru: &str, en: &str, zh: &str) -> Result<T, String> { Err(l(ru, en, zh)) }
impl Runner for WinRunner {
    fn models(&self) -> Result<Vec<Value>, String> { Ok(vec![]) }
    fn set_permission_policy(&self, _: &str) {}
    fn set_model(&self, _: Option<&str>, _: &str) -> Result<(), String> { no("Сменить модель можно в самой сессии", "Change the model inside the session", "请在会话内切换模型") }
    fn btw(&self, _: &str, _: &str) -> Result<(), String> { no("/btw доступен только для сессий в WSL", "/btw works only for sessions in WSL", "/btw 仅适用于 WSL 中的会话") }
    fn release(&self, _: &str) -> bool { false }
    fn start(&self, _: &str, _: &str) -> Result<String, String> { no("Новые чаты запускаются в WSL", "New chats start in WSL", "新聊天在 WSL 中启动") }
    fn send(&self, _: &str, _: &str) -> Result<(), String> { no("Эту сессию нельзя разбудить: в ней не подключены хуки ccPet", "This session cannot be reached: ccPet hooks are not connected in it", "无法连接此会话：其中未连接 ccPet 钩子") }
    fn interrupt(&self, _: &str) -> Result<(), String> { no("Эту сессию нельзя остановить из питомца: в ней не подключены хуки ccPet", "This session cannot be stopped from the pet: ccPet hooks are not connected in it", "无法从宠物停止此会话：其中未连接 ccPet 钩子") }
    fn respond_permission(&self, _: &str, _: bool) {}
}

/** 32 hex chars from the OS's per-process random keys (std's RandomState) */
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    (0..2).map(|i| { let mut h = std::collections::hash_map::RandomState::new().build_hasher(); h.write_u64(now_ms() as u64 ^ i); format!("{:016x}", h.finish()) }).collect()
}

/** the token Claude Code's hook URLs carry; kept in the app's data folder (the same file the Electron app used) */
fn token(data_dir: &Path, port: u16) -> String {
    let file = data_dir.join("hub.json");
    let saved = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|j| j["token"].as_str().map(String::from))
        .filter(|t| t.len() >= 16 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    saved.unwrap_or_else(|| {
        let t = random_token();
        let _ = std::fs::create_dir_all(data_dir);
        let _ = std::fs::write(&file, json!({ "token": t, "port": port }).to_string());
        t
    })
}

/** The status line command must not contain spaces (it runs unquoted): a path with spaces becomes its short 8.3 form. */
fn shell_safe_path(p: &str) -> String {
    if !p.contains(char::is_whitespace) { return p.into(); }
    #[allow(unused_mut)]
    let mut c = std::process::Command::new("cmd.exe");
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000).raw_arg(format!("/d /s /c \"for %I in (\"{p}\") do @echo %~sI\"")); }
    c.output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| p.into())
}

pub struct WindowsHost {
    pub bridge: Bridge,
    pub token: String,
    pub settings_path: PathBuf,
    helper: Option<String>,
    claude_home: PathBuf,
    port: u16,
    server: Mutex<Option<HookServer>>,
}

pub fn chain_kind(c: Chain) -> &'static str { match c { Chain::None => "none", Chain::Ours => "ours", Chain::Chained => "chained" } }

impl WindowsHost {
    pub fn new(data_dir: &Path, claude_home: PathBuf, port: u16, helper: Option<String>, out: Box<dyn Fn(Value) + Send + Sync>) -> Arc<WindowsHost> {
        let settings_path = claude_home.join("settings.json");
        let mut o = BridgeOpts::new(out, settings_path.clone(), "");
        o.mailbox = Arc::new(Mailbox::new());
        o.mailbox_only = true;
        o.soft_stop = true;
        o.permission_id_prefix = "win-".into();
        // limits saved by `pet-helper.exe statusline` (%USERPROFILE%\.claude-pet\usage.json), read when the file changes
        let usage_file = claude_home.parent().unwrap_or(&claude_home).join(".claude-pet").join("usage.json");
        o.usage = Some(UsageSource::new(usage_file, settings_path.clone(), None, None, install::is_pet_status_line));
        let bridge = Bridge::new(o);
        bridge.set_runner(Arc::new(WinRunner));
        Arc::new(WindowsHost { bridge, token: token(data_dir, port), settings_path, helper, claude_home, port, server: Mutex::new(None) })
    }

    pub fn port(&self) -> u16 { self.server.lock().unwrap().as_ref().map_or(0, |s| s.port) }
    fn origin(&self) -> String { format!("http://127.0.0.1:{}", if self.port() != 0 { self.port() } else { self.port }) }

    /** starts the receiver and the tick; Err(text for the user) when the port is taken */
    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        let (b1, b2, b3, b4, b5, b6) = (self.bridge.clone(), self.bridge.clone(), self.bridge.clone(), self.bridge.clone(), self.bridge.clone(), self.bridge.clone());
        let mailbox = self.bridge_mailbox();
        let r = HookServer::start(HookServerOpts {
            port: self.port, token: self.token.clone(), mailbox, wait_ms: 50_000,
            on_event: Box::new(move |e| b1.on_hook(e)),
            on_waiter: Some(Box::new(move |sid, cwd, src| {
                if !b2.has_session(sid) { b2.adopt(HookEvent::new("SessionStart", sid, cwd)); }
                if let Some(src) = src { b2.set_source(sid, src); }
            })),
            on_pty: Some(Box::new(move |sid, pipe| b3.set_pty(sid, pipe))),
            on_permission: Some(Box::new(move |e, gone| b4.on_permission(e, gone))),
            on_reply: Some(Box::new(move |e| b5.hook_reply(e))),
            on_command: Some(Box::new(move |_| b6.handle(&json!({ "type": "rescan" })))),
        });
        match r {
            Ok(s) => { *self.server.lock().unwrap() = Some(s); }
            Err(e) => return Err(l(&format!("Порт {} занят: хуки Windows не подключены ({e})", self.port), &format!("Port {} is busy: Windows hooks are not connected ({e})", self.port), &format!("端口 {} 被占用：未连接 Windows 钩子（{e}）", self.port))),
        }
        self.bridge.snapshot(false);
        // tick every 1.5 s; sessions seen only in transcripts (the pet started later, or hooks are not connected there) every 15 s
        let me = self.clone();
        std::thread::spawn(move || {
            let projects = me.claude_home.join("projects");
            let (mut adopted, mut last) = (HashSet::new(), 0);
            loop {
                std::thread::sleep(Duration::from_millis(1500));
                if me.server.lock().unwrap().is_none() { break; }
                let now = now_ms();
                me.bridge.tick(now);
                let force = me.bridge.take_rescan();
                if force || now - last > 15_000 {
                    last = now;
                    if force { adopted.clear(); }
                    for r in adopt::find_running(&projects, now, if force { adopt::RESCAN_MS } else { 10 * 60_000 }) {
                        if adopted.contains(&r.id) || me.bridge.has_session(&r.id) { continue; }
                        adopted.insert(r.id.clone());
                        let mut e = HookEvent::new("SessionStart", &r.id, &r.cwd);
                        e.transcript_path = Some(r.path.to_string_lossy().into_owned());
                        me.bridge.adopt(e);
                    }
                }
            }
        });
        Ok(())
    }

    fn bridge_mailbox(&self) -> Arc<Mailbox> { self.bridge.mailbox() }

    pub fn stop(&self) { if let Some(s) = self.server.lock().unwrap().take() { s.close(); } }

    /** what is installed in the Windows settings.json now, and what installing / updating would change */
    pub fn state(&self, permissions: bool) -> Value {
        let sp = self.settings_path.to_string_lossy();
        match install::read_settings(&self.settings_path) {
            Ok((cur, _)) => {
                let st = install::windows_hooks_status(&cur);
                let (_, diff) = install::plan_windows_hooks(&cur, &self.origin(), &self.token, self.helper.as_deref(), permissions);
                json!({ "events": st.events, "mailbox": st.mailbox, "permissions": st.permissions, "settingsPath": sp, "diff": diff })
            }
            Err(e) => json!({ "events": false, "mailbox": false, "permissions": false, "settingsPath": sp, "diff": "", "error": e }),
        }
    }

    /** writes our hooks after the caller got the user's consent (a .bak copy is kept) */
    pub fn apply(&self, permissions: bool) -> Result<bool, String> {
        let (cur, had) = install::read_settings(&self.settings_path)?;
        let (next, diff) = install::plan_windows_hooks(&cur, &self.origin(), &self.token, self.helper.as_deref(), permissions);
        if diff.is_empty() { return Ok(false); }
        install::write_settings(&self.settings_path, &next, had, None).map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn remove_diff(&self) -> String {
        install::read_settings(&self.settings_path).map(|(c, _)| install::remove_windows_hooks(&c).1).unwrap_or_default()
    }

    pub fn remove(&self) -> Result<bool, String> {
        let (cur, had) = install::read_settings(&self.settings_path)?;
        let (next, diff) = install::remove_windows_hooks(&cur);
        if diff.is_empty() { return Ok(false); }
        install::write_settings(&self.settings_path, &next, had, None).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /** the Windows statusLine (`pet-helper.exe statusline`, wrapping the user's own line): the plan, or the write after the user agreed */
    pub fn status_line(&self, apply: bool, remove: bool) -> Value {
        let Some(helper) = self.helper.as_deref() else { return json!({ "diff": "", "applied": false, "kind": "none", "error": "unsupported" }) };
        let r = (|| -> Result<Value, String> {
            let (cur, had) = install::read_settings(&self.settings_path)?;
            let (next, diff) = if remove { install::remove_status_line(&cur) } else { let (n, d, _) = install::plan_windows_status_line(&cur, &shell_safe_path(helper))?; (n, d) };
            if apply && !diff.is_empty() { install::write_settings(&self.settings_path, &next, had, None).map_err(|e| e.to_string())?; }
            let kind = install::status_line_state(if apply || diff.is_empty() { &next } else { &cur });
            Ok(json!({ "diff": if apply { "" } else { diff.as_str() }, "applied": apply && !diff.is_empty(), "kind": chain_kind(kind) }))
        })();
        r.unwrap_or_else(|e| json!({ "diff": "", "applied": false, "kind": "none", "error": e }))
    }

}
