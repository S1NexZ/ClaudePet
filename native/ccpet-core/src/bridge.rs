//! The app-facing core of the bridge: commands in, messages out (bridge.ts). Transport-free so it can be tested:
//! messages leave through `out`, hooks come in through `on_hook` / `on_permission`, `tick` runs every 1.5 s.
//! The `claude` process paths (new chats, resume fallback, /btw, model list) sit behind the `Runner` trait.

use crate::hook_http::Decision;
use crate::i18n::{l, set_lang};
use crate::install::*;
use crate::mailbox::{Mailbox, Sent};
use crate::map_event::is_test_command;
use crate::procinfo::{proc_name, tty_path};
use crate::pty_send::{send_esc, send_prompt, send_title, PtyGone};
use crate::soft_stop::SoftStop;
use crate::store::Store;
use crate::summary::summarize;
use crate::transcript::{interrupted_since, read_entrypoint, read_original_cwd, read_transcript, PET_MARKER};
use crate::types::{AskOption, AskQuestion, HookEvent, PendingPermission, PetState};
use crate::usage::{compact_utc, now_ms, UsageSource};
use regex_lite::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

/** The paths that start a `claude` process under the user's login (opt-in). */
pub trait Runner: Send + Sync {
    fn models(&self) -> Result<Vec<Value>, String>;
    fn set_permission_policy(&self, policy: &str);
    fn set_model(&self, session: Option<&str>, model: &str) -> Result<(), String>;
    fn btw(&self, session: &str, text: &str) -> Result<(), String>;
    fn release(&self, session: &str) -> bool;
    fn start(&self, cwd: &str, prompt: &str) -> Result<String, String>;
    fn send(&self, session: &str, text: &str) -> Result<(), String>;
    fn interrupt(&self, session: &str) -> Result<(), String>;
    fn respond_permission(&self, id: &str, allow: bool);
    /** the app is quitting: end every process this runner started */
    fn close_all(&self) {}
}

/** No claude client: every path that would need one says so. */
pub struct NoRunner;
fn unsupported<T>() -> Result<T, String> { Err(l("Эта функция пока недоступна в мосту на Rust", "This is not available in the Rust bridge yet", "Rust 桥暂不支持此功能")) }
impl Runner for NoRunner {
    fn models(&self) -> Result<Vec<Value>, String> { unsupported() }
    fn set_permission_policy(&self, _: &str) {}
    fn set_model(&self, _: Option<&str>, _: &str) -> Result<(), String> { unsupported() }
    fn btw(&self, _: &str, _: &str) -> Result<(), String> { unsupported() }
    fn release(&self, _: &str) -> bool { false }
    fn start(&self, _: &str, _: &str) -> Result<String, String> { unsupported() }
    fn send(&self, _: &str, _: &str) -> Result<(), String> { unsupported() }
    fn interrupt(&self, _: &str) -> Result<(), String> { unsupported() }
    fn respond_permission(&self, _: &str, _: bool) {}
}

pub struct BridgeOpts {
    pub out: Box<dyn Fn(Value) + Send + Sync>,
    pub mailbox: Arc<Mailbox>,
    pub usage: Option<UsageSource>,
    pub settings_path: PathBuf,
    pub hook_path: String,
    /** this host's hook receiver: lets the bridge install the mailbox waiter and the PermissionRequest hook next to the events hook */
    pub host_hooks: Option<(String, String)>,
    pub permission_id_prefix: String,
    /** delay of the second transcript read after Stop (Claude writes its reply after the hook fires) */
    pub stop_recheck_ms: u64,
    pub permission_timeout_ms: u64,
    pub question_timeout_ms: u64,
    /** Windows host: every session without a PTY is reached through its mailbox (the waiter may be between polls) */
    pub mailbox_only: bool,
    /** Windows host: Stop for sessions without a PTY answers their next tool hook with `continue: false` (soft_stop.rs) */
    pub soft_stop: bool,
}

impl BridgeOpts {
    pub fn new(out: Box<dyn Fn(Value) + Send + Sync>, settings_path: PathBuf, hook_path: &str) -> Self {
        BridgeOpts { out, mailbox: Arc::new(Mailbox::new()), usage: None, settings_path, hook_path: hook_path.into(), host_hooks: None,
            permission_id_prefix: "hl-".into(), stop_recheck_ms: 700, permission_timeout_ms: 30_000, question_timeout_ms: 590_000, mailbox_only: false, soft_stop: false }
    }
}

struct HooksPlan { had: bool, next: Value, diff: String, installed: bool, stale: bool, upgrade: bool, st: HooksStatus }

struct Ask { session_id: String, tool: String, tx: Sender<Option<Decision>>, input: Option<Value> }

#[derive(Default)]
struct State {
    store: Store,
    transcripts: HashMap<String, String>,
    /** claude process of each terminal session, from the hook's parent chain */
    pids: HashMap<String, u32>,
    /** sessions the user ended: their late hook events (Stop, SessionEnd) must not bring them back */
    ended: HashSet<String>,
    perm_on: bool,
    sdk_on: bool,
    asks: HashMap<String, Ask>,
    ask_seq: u64,
    last_snap: String,
    usage_version: Option<String>,
    checking: HashSet<String>,
    soft: SoftStop,
    /** sessions that sent a hook event other than SessionStart (soft stop needs their tool hooks) */
    hooked: HashSet<String>,
    /** a PTY pipe reported (by a waiter) before its session was known */
    pending_ptys: HashMap<String, String>,
    /** the user asked to look for sessions again (reload button): the adoption loop scans at once, further back */
    rescan: bool,
}

struct Inner { o: BridgeOpts, st: Mutex<State>, usage: Mutex<Option<UsageSource>>, runner: OnceLock<Arc<dyn Runner>> }

#[derive(Clone)]
pub struct Bridge(Arc<Inner>);

/** hook events that can only come after a pending permission question was settled */
const SETTLES_ASK: [&str; 6] = ["PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "UserPromptSubmit", "SessionEnd"];

/** The questions of an AskUserQuestion call, or None when the input is not shaped as expected. */
pub fn ask_questions(input: Option<&Value>) -> Option<Vec<AskQuestion>> {
    let qs = input?.get("questions")?.as_array().filter(|q| !q.is_empty())?;
    qs.iter().map(|q| {
        let opts = q.get("options")?.as_array().filter(|o| !o.is_empty())?;
        Some(AskQuestion {
            question: q.get("question")?.as_str()?.to_string(),
            header: q.get("header").and_then(Value::as_str).map(String::from),
            multi_select: q.get("multiSelect") == Some(&Value::Bool(true)),
            options: opts.iter().map(|x| Some(AskOption { label: x.get("label")?.as_str()?.to_string(), description: x.get("description").and_then(Value::as_str).map(String::from) })).collect::<Option<Vec<_>>>()?,
        })
    }).collect()
}

/** A finished Bash call worth a reaction: tests passed or failed, a commit went in. */
pub fn reaction_for(event: &str, tool: &str, input: Option<&Value>) -> Option<&'static str> {
    if tool != "Bash" { return None; }
    let failed = event == "PostToolUseFailure";
    if event != "PostToolUse" && !failed { return None; }
    let cmd = input.and_then(|i| i.get("command")).map(crate::map_event::js_string).unwrap_or_default();
    if is_test_command(&cmd) { return Some(if failed { "sad" } else { "happy" }); }
    static COMMIT: OnceLock<Regex> = OnceLock::new();
    let re = COMMIT.get_or_init(|| Regex::new(r"\bgit\b[^|;&\n]*\scommit\b").unwrap());
    (!failed && re.is_match(&cmd)).then_some("happy")
}

fn tool_key(e: &HookEvent) -> String {
    let inp = if e.tool() == "AskUserQuestion" { e.tool_input.as_ref().and_then(|i| i.get("questions")).cloned().unwrap_or(Value::Null) } else { e.tool_input.clone().unwrap_or(Value::Null) };
    format!("{}\u{0}{}", e.tool(), inp)
}

/** Writes a title-setting escape sequence to the terminal a process is attached to. */
pub fn set_tty_title(pid: u32, text: &str) -> bool {
    let Some(tty) = tty_path(pid) else { return false };
    let t: String = text.chars().map(|c| if (c as u32) < 0x20 || c == '\x7f' { ' ' } else { c }).collect();
    std::fs::OpenOptions::new().write(true).open(tty).and_then(|mut f| std::io::Write::write_all(&mut f, format!("\x1b]0;{t}\x07").as_bytes())).is_ok()
}

fn s<'a>(cmd: &'a Value, k: &str) -> String { cmd.get(k).map(crate::map_event::js_string).unwrap_or_default() }

impl Bridge {
    pub fn new(mut o: BridgeOpts) -> Bridge {
        let usage = o.usage.take();
        Bridge(Arc::new(Inner { o, st: Mutex::new(State::default()), usage: Mutex::new(usage), runner: OnceLock::new() }))
    }

    /** The claude client (set once, after the bridge exists: the runner works on the bridge's store). Until then every claude path says "not available". */
    pub fn set_runner(&self, r: Arc<dyn Runner>) { let _ = self.0.runner.set(r); }
    fn runner(&self) -> &dyn Runner { self.0.runner.get().map_or(&NoRunner as &dyn Runner, |r| r.as_ref()) }
    pub fn close_runner(&self) { self.runner().close_all(); }

    fn lock(&self) -> MutexGuard<'_, State> { self.0.st.lock().unwrap_or_else(|e| e.into_inner()) }
    fn out(&self, v: Value) { (self.0.o.out)(v) }

    fn snap(&self, g: &mut State, only_if_changed: bool) {
        let mb = &self.0.o.mailbox;
        let mut sessions = g.store.list();
        for x in sessions.iter_mut() {
            let is_mod = mb.is_mod(&x.id);
            x.mailbox = Some(mb.has_waiter(&x.id) || is_mod);
            if is_mod { x.is_mod = Some(true); }
            if self.0.o.soft_stop && g.hooked.contains(&x.id) && !x.owned && x.pty.is_none() { x.soft_stop = Some(true); }
        }
        let m = json!({ "type": "snapshot", "sessions": sessions, "attention": g.store.attention() });
        let key = m.to_string();
        if only_if_changed && key == g.last_snap { return; }
        g.last_snap = key;
        self.out(m);
    }
    pub fn snapshot(&self, only_if_changed: bool) { let mut g = self.lock(); self.snap(&mut g, only_if_changed); }

    fn history_now(&self, id: &str) {
        let p = self.lock().transcripts.get(id).cloned();
        let items = p.map(|p| read_transcript(&p, 40, 256 * 1024)).unwrap_or_default();
        self.out(json!({ "type": "history", "sessionId": id, "items": items }));
    }
    fn history_async(&self, id: &str) { let (b, id) = (self.clone(), id.to_string()); std::thread::spawn(move || b.history_now(&id)); }
    fn reread_later(&self, id: &str) {
        let (b, id) = (self.clone(), id.to_string());
        std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(b.0.o.stop_recheck_ms)); b.history_now(&id); });
    }

    fn need_sdk(&self, g: &State) -> Result<(), String> {
        if g.sdk_on { Ok(()) } else { Err(l("Запуск Claude Code через claude выключен. Включите его в «Настройки → Подключения» или работайте через терминал.",
            "Starting Claude Code from the pet is off. Turn it on in Settings → Connections, or work in a terminal.",
            "从宠物启动 Claude Code 已关闭。请在“设置 → 连接”中开启，或在终端中使用。")) }
    }

    /** SDK fallback resumes a session: it must run in the folder the session was started in, or Claude Code copies it */
    fn ensure_resume_cwd(&self, id: &str) {
        let p = { let g = self.lock(); match (g.store.get(id), g.transcripts.get(id)) { (Some(s), Some(p)) if s.resume_cwd.is_none() => p.clone(), _ => return } };
        if let Some(c) = read_original_cwd(&p) { self.lock().store.set_resume_cwd(id, &c); }
    }

    /** What the hooks section of settings.json would become (events hook, plus waiter and permission hook when this bridge has a receiver) and what is installed now. */
    fn hooks_plan(&self, want_perm: bool, remove: bool) -> Result<HooksPlan, String> {
        let o = &self.0.o;
        let (current, had) = read_settings(&o.settings_path)?;
        // our hook files referenced by the user's settings: none = not installed; any missing = stale
        let files = referenced_hook_files(&current);
        let (next, diff) = if remove { remove_hooks(&current) } else {
            let (mut next, _) = plan_hooks(&current, &o.hook_path);
            if let Some((origin, token)) = &o.host_hooks { next = plan_host_hooks(&next, &HostHooks { origin, token, hook_path: &o.hook_path, permissions: want_perm }).0; }
            let diff = if next == current { String::new() } else { hooks_section_diff(&current, &next) };
            (next, diff)
        };
        // installed through Node (0.6): the same hooks, each a ~1 MB process instead of a Node one
        let upgrade = !diff.is_empty() && files.iter().any(|f| f.ends_with("pet-hook.mjs"));
        Ok(HooksPlan { installed: !files.is_empty(), stale: files.iter().any(|f| !std::path::Path::new(f).exists()), upgrade, st: hooks_status(&current), had, next, diff })
    }

    fn hooks(&self, cmd: &Value) {
        let o = &self.0.o;
        let remove = cmd.get("remove") == Some(&Value::Bool(true));
        let want_perm = cmd.get("permissions").and_then(Value::as_bool).unwrap_or_else(|| self.lock().perm_on);
        let p = match self.hooks_plan(want_perm, remove) { Ok(p) => p, Err(e) => return self.out(json!({ "type": "hooks", "diff": "", "applied": false, "installed": false, "stale": false, "error": e })) };
        if cmd.get("apply") == Some(&Value::Bool(true)) {
            if !p.diff.is_empty() {
                if let Err(e) = write_settings(&o.settings_path, &p.next, p.had, None) { return self.out(json!({ "type": "hooks", "diff": "", "applied": false, "installed": false, "stale": false, "error": e.to_string() })); }
            }
            let host = o.host_hooks.is_some();
            self.out(json!({ "type": "hooks", "diff": "", "applied": !p.diff.is_empty(), "installed": !remove, "stale": false, "events": !remove, "mailbox": !remove && host, "permissions": !remove && want_perm && host }));
        } else {
            self.out(json!({ "type": "hooks", "diff": p.diff, "applied": false, "installed": p.installed, "stale": p.stale, "upgrade": p.upgrade, "events": p.st.events, "mailbox": p.st.mailbox, "permissions": p.st.permissions }));
        }
    }

    pub fn handle(&self, cmd: &Value) {
        match self.run(cmd) {
            Ok(true) => self.snapshot(false),
            Ok(false) => {}
            Err(e) => self.out(json!({ "type": "error", "message": e })),
        }
    }

    /** Paths that wait for a `claude` process (its start, its model list): off the command thread, so Stop and answers are never queued behind them. */
    fn in_background(&self, f: impl FnOnce(&Bridge) -> Result<(), String> + Send + 'static) {
        let b = self.clone();
        std::thread::spawn(move || { match f(&b) { Ok(()) => b.snapshot(true), Err(e) => b.out(json!({ "type": "error", "message": e })) } });
    }

    /** Ok(true): send a snapshot afterwards. */
    fn run(&self, cmd: &Value) -> Result<bool, String> {
        let kind = cmd.get("type").and_then(Value::as_str).unwrap_or("");
        let on = cmd.get("on") == Some(&Value::Bool(true));
        match kind {
            "start" => {
                self.need_sdk(&self.lock())?;
                let (cwd, prompt) = (crate::paths::to_wsl_path(&s(cmd, "cwd")), s(cmd, "prompt"));
                self.in_background(move |b| { let sid = b.runner().start(&cwd, &prompt)?; b.out(json!({ "type": "started", "sessionId": sid })); Ok(()) });
                return Ok(false);
            }
            "send" => return self.send(&s(cmd, "sessionId"), &s(cmd, "text")),
            "interrupt" => {
                let id = s(cmd, "sessionId");
                let sess = self.lock().store.get(&id).cloned();
                if let Some(pty) = sess.as_ref().filter(|x| !x.owned).and_then(|x| x.pty.clone()) {
                    match send_esc(&pty) { Ok(()) => { self.lock().store.mark_interrupted(&id, now_ms()); self.reread_later(&id); } Err(PtyGone) => self.lock().store.clear_pty(&id) }
                } else if self.0.o.soft_stop && sess.as_ref().map_or(false, |x| !x.owned) && self.lock().hooked.contains(&id) {
                    self.lock().soft.request(&id, now_ms());
                    self.out(json!({ "type": "chat", "sessionId": id, "event": { "kind": "note", "text": l("Остановлю после текущего шага…", "Stopping after the current step…", "将在当前步骤后停止…") } }));
                } else { self.runner().interrupt(&id)?; }
            }
            "language" => { if let Some(l) = cmd.get("lang").and_then(Value::as_str) { set_lang(l); } return Ok(true); }
            "permission-mode" => { if let Some(m) = cmd.get("mode").and_then(Value::as_str).filter(|m| ["ask", "edits", "all"].contains(m)) { self.runner().set_permission_policy(m); } }
            "hook-permissions" => { self.lock().perm_on = on; return Ok(false); }
            "permission" => {
                let id = s(cmd, "id");
                let ask = { let mut g = self.lock(); g.asks.remove(&id).map(|a| { g.store.set_pending(&a.session_id, None); let cwd = g.store.get(&a.session_id).map(|x| x.cwd.clone()).unwrap_or_default(); g.store.apply(&HookEvent::new("UserPromptSubmit", &a.session_id, &cwd), now_ms()); a }) };
                match ask {
                    Some(a) => {
                        let allow = cmd.get("allow") == Some(&Value::Bool(true));
                        // a question answered in the pet goes back as its input plus the answers; dismissed, the terminal's own question stays
                        let d = match a.input {
                            Some(mut inp) => match cmd.get("answers").filter(|x| x.is_object()) { Some(ans) if allow => { inp["answers"] = ans.clone(); Some(Decision::Updated(inp)) } _ => None },
                            None => Some(if allow { Decision::Allow } else { Decision::Deny }),
                        };
                        let _ = a.tx.send(d);
                    }
                    None => self.runner().respond_permission(&id, cmd.get("allow") == Some(&Value::Bool(true))),
                }
            }
            "history" => { self.history_now(&s(cmd, "sessionId")); return Ok(false); }
            "statusline" => { self.statusline(cmd); return Ok(false); }
            // closed-by-the-user marks are forgotten too: the user asked for everything that still runs
            "rescan" => { let mut g = self.lock(); g.ended.clear(); g.rescan = true; return Ok(false); }
            "usage-refresh" | "usage" => {
                // only on the user's own click (never on a timer or at start): the live query runs under the user's login
                if kind == "usage-refresh" { if let Some(u) = self.0.usage.lock().unwrap().as_ref() { u.refresh(); } }
                self.push_usage();
                return Ok(false);
            }
            "sdk-chats" => { self.lock().sdk_on = on; return Ok(false); }
            "models" => { self.need_sdk(&self.lock())?; self.in_background(|b| { let m = b.runner().models()?; b.out(json!({ "type": "models", "models": m })); Ok(()) }); return Ok(false); }
            "setModel" => {
                let sid = cmd.get("sessionId").filter(|v| !v.is_null()).map(crate::map_event::js_string);
                self.need_sdk(&self.lock())?;
                let model = s(cmd, "model");
                self.in_background(move |b| { b.runner().set_model(sid.as_deref(), &model)?; b.out(json!({ "type": "modelSet", "sessionId": sid, "model": model })); Ok(()) });
                return Ok(false);
            }
            "btw" => {
                let id = s(cmd, "sessionId");
                { let g = self.lock(); if !g.store.get(&id).map_or(false, |x| x.owned) { self.need_sdk(&g)?; } }
                self.runner().btw(&id, &s(cmd, "text"))?;
                return Ok(false);
            }
            "release" => { self.runner().release(&s(cmd, "sessionId")); }
            "end" => {
                let id = s(cmd, "sessionId");
                if !self.runner().release(&id) {
                    let pid = self.lock().pids.get(&id).copied();
                    // no process found = already closed: the stale row is simply dropped
                    if let Some(pid) = pid.filter(|p| proc_name(*p).as_deref() == Some("claude")) { let _ = std::process::Command::new("kill").arg(pid.to_string()).status(); }
                }
                let mut g = self.lock();
                g.store.remove(&id); g.pids.remove(&id); g.ended.insert(id);
            }
            "term-mark" => { // the pet is about to look for this session's terminal window: give its tab a recognisable title
                let id = s(cmd, "sessionId");
                let text = s(cmd, "text");
                // a Windows session in `pet-helper pty`: the title goes through its pipe (the helper sets the console title)
                if let Some(pipe) = self.lock().store.get(&id).and_then(|x| x.pty.clone()).filter(|p| p.starts_with(r"\\.\pipe\")) {
                    let ok = send_title(&pipe, &text).is_ok();
                    self.out(json!({ "type": "termMark", "sessionId": id, "ok": ok }));
                    return Ok(false);
                }
                let pid = self.lock().pids.get(&id).copied();
                let ok = pid.map_or(false, |p| proc_name(p).as_deref() == Some("claude") && set_tty_title(p, &text));
                if let (true, Some(p)) = (ok, pid) { // Claude Code rewrites the title all the time (spinner): keep the marker up while the pet looks for the window
                    std::thread::spawn(move || for _ in 0..14 { std::thread::sleep(Duration::from_millis(200)); if !set_tty_title(p, &text) { break; } });
                }
                self.out(json!({ "type": "termMark", "sessionId": id, "ok": ok }));
                return Ok(false);
            }
            "dismiss" => { // hide a session from the list without touching its process (a live one reappears on its next prompt)
                let id = s(cmd, "sessionId");
                let mut g = self.lock();
                g.store.remove(&id); g.pids.remove(&id); g.ended.insert(id);
            }
            "hooks" => { self.hooks(cmd); return Ok(false); }
            _ => return Err(l("Неизвестная команда", "Unknown command", "未知命令")),
        }
        Ok(true)
    }

    fn send(&self, id: &str, text: &str) -> Result<bool, String> {
        let o = &self.0.o;
        let sess = self.lock().store.get(id).cloned();
        if let Some(pty) = sess.as_ref().filter(|x| !x.owned).and_then(|x| x.pty.clone()) {
            // the session runs under pet-claude.py: type into that very process (no second claude)
            if sess.as_ref().map_or(false, |x| x.state.working()) && !text.trim_start().starts_with("/btw") { // /btw is the one command made for a busy session
                return Err(l("Claude занят", "Claude is busy", "Claude 正忙"));
            }
            match send_prompt(&pty, text, 300) { Ok(()) => return Ok(true), Err(PtyGone) => self.lock().store.clear_pty(id) } // wrapper is gone: fall back to resuming
        }
        let sess = self.lock().store.get(id).cloned();
        // no PTY: wake the session through its mailbox waiter (the text goes out as a hook-feedback reminder)
        if let Some(x) = sess.as_ref().filter(|x| !x.owned && (o.mailbox_only || o.mailbox.has_waiter(id) || o.mailbox.is_mod(id))) {
            let msg = format!("{}\n{PET_MARKER} {text}", l("Пользователь написал это через ccPet. Считай это его сообщением и ответь на него.", "The user wrote this through ccPet. Treat it as their message and answer it.", "用户通过 ccPet 写了这条消息。请把它当作用户的消息并回答。"));
            let r = o.mailbox.send(id, &msg);
            self.out(json!({ "type": "chat", "sessionId": id, "event": { "kind": "user", "text": text } }));
            if r == Sent::Delivered { self.lock().store.apply(&HookEvent::new("UserPromptSubmit", id, &x.cwd), now_ms()); }
            return Ok(true);
        }
        if !sess.as_ref().map_or(false, |x| x.owned) { self.need_sdk(&self.lock())?; } // a session the pet already runs may keep going; resuming a terminal one needs a second claude
        self.ensure_resume_cwd(id);
        self.runner().send(id, text)?;
        Ok(true)
    }

    fn statusline(&self, cmd: &Value) {
        let o = &self.0.o;
        let apply = cmd.get("apply") == Some(&Value::Bool(true));
        let fail = |e: String| self.out(json!({ "type": "statusline", "diff": "", "applied": false, "kind": "none", "error": e }));
        let (current, had) = match read_settings(&o.settings_path) { Ok(x) => x, Err(e) => return fail(e) };
        let (next, diff) = if cmd.get("remove") == Some(&Value::Bool(true)) { remove_status_line(&current) } else { let (n, d, _) = plan_status_line(&current, &o.hook_path); (n, d) };
        let kind = |v: &Value| match status_line_state(v) { Chain::None => "none", Chain::Ours => "ours", Chain::Chained => "chained" };
        if apply && !diff.is_empty() {
            // timestamped backup first: the statusLine has its own, so it never overwrites the hooks' `.bak`
            let t = compact_utc(now_ms());
            let mut b = o.settings_path.as_os_str().to_owned(); b.push(format!(".bak-statusline-{t}"));
            if let Err(e) = write_settings(&o.settings_path, &next, had, Some(&PathBuf::from(b))) { return fail(e.to_string()); }
        }
        let shown = if apply || diff.is_empty() { &next } else { &current };
        self.out(json!({ "type": "statusline", "diff": if apply { "" } else { diff.as_str() }, "applied": apply && !diff.is_empty(), "kind": kind(shown) }));
    }

    pub fn push_usage(&self) {
        let mut u = self.0.usage.lock().unwrap();
        let Some(u) = u.as_mut() else { return };
        self.lock().usage_version = Some(u.version());
        let info = u.read();
        self.out(json!({ "type": "usage", "usage": info }));
    }

    pub fn on_chat(&self, session_id: &str, event: Value) { self.out(json!({ "type": "chat", "sessionId": session_id, "event": event })); }

    /** a synthetic SessionStart (transcript adoption, a bare waiter): never revives a session the user closed */
    pub fn adopt(&self, e: HookEvent) {
        if self.lock().ended.contains(&e.session_id) { return; }
        self.on_hook(e);
    }

    /** The answer a host-hook (HTTP) gets back: a pending soft stop turns the session's next tool hook into "stop". */
    pub fn hook_reply(&self, e: &HookEvent) -> Option<Value> {
        if !self.0.o.soft_stop { return None; }
        let r = self.lock().soft.reply(e, now_ms());
        if r.is_some() {
            let mut g = self.lock();
            g.store.mark_interrupted(&e.session_id, now_ms());
            self.snap(&mut g, true);
            drop(g);
            self.reread_later(&e.session_id);
        }
        r
    }

    /** A Windows session's PTY pipe (`pet-helper pty`), reported by its mailbox waiter; kept until the session is known. */
    pub fn set_pty(&self, id: &str, pipe: &str) {
        let mut g = self.lock();
        if g.store.get(id).is_some() { if g.store.set_pty(id, pipe) { self.snap(&mut g, true); } } else { g.pending_ptys.insert(id.into(), pipe.into()); }
    }

    pub fn on_hook(&self, e: HookEvent) {
        let sid = e.session_id.clone();
        let name = e.hook_event_name.as_str();
        let mut g = self.lock();
        if name != "SessionStart" { g.hooked.insert(sid.clone()); }
        // the question was answered somewhere else (in the terminal or the app): drop the pet's Allow / Deny at once instead of showing it until the timeout
        if SETTLES_ASK.contains(&name) {
            let post = name == "PostToolUse" || name == "PostToolUseFailure";
            let key = tool_key(&e);
            let ids: Vec<String> = g.asks.iter().filter(|(_, a)| a.session_id == sid && (!post || a.tool == key)).map(|(i, _)| i.clone()).collect();
            for i in ids { if let Some(a) = g.asks.remove(&i) { g.store.set_pending(&sid, None); let _ = a.tx.send(None); } }
        }
        let owned = g.store.get(&sid).map_or(false, |x| x.owned);
        if let Some(r) = reaction_for(name, e.tool(), e.tool_input.as_ref()).filter(|_| !owned) { self.out(json!({ "type": "react", "sessionId": sid, "reaction": r })); }
        if g.ended.contains(&sid) {
            if name != "UserPromptSubmit" && name != "SessionStart" { return; }
            g.ended.remove(&sid); // resumed by the user
        }
        let mut new_path = false;
        // a subagent's event must not swap the parent's transcript
        if let Some(p) = e.transcript_path.as_ref().filter(|_| e.agent_id.is_none()) { new_path = g.transcripts.get(&sid) != Some(p); g.transcripts.insert(sid.clone(), p.clone()); }
        if let Some(pid) = e.pet_parents.iter().flatten().filter_map(|p| u32::try_from(*p).ok()).find(|p| proc_name(*p).as_deref() == Some("claude")) { g.pids.insert(sid.clone(), pid); }
        g.store.apply(&e, now_ms());
        if new_path && g.store.get(&sid).map_or(false, |x| x.source.is_none()) {
            if let Some(p) = e.transcript_path.clone() {
                let (b, sid) = (self.clone(), sid.clone());
                std::thread::spawn(move || if let Some(src) = read_entrypoint(&p) { let mut g = b.lock(); g.store.set_source(&sid, &src); b.snap(&mut g, true); });
            }
        }
        self.snap(&mut g, false);
        let sess = g.store.get(&sid).cloned();
        drop(g);
        let pty_prompt = name == "UserPromptSubmit" && sess.as_ref().map_or(false, |x| x.pty.is_some());
        if (name == "Stop" || new_path || pty_prompt) && !sess.as_ref().map_or(false, |x| x.owned) { self.history_async(&sid); }
        // the hook fires before Claude flushes the new lines to the transcript: read again shortly after
        if (name == "Stop" || pty_prompt) && !sess.as_ref().map_or(false, |x| x.owned) { self.reread_later(&sid); }
    }

    /** A PermissionRequest hook: shown in the pet as Allow / Deny when the user switched that on (Claude's questions always); None = no opinion. Blocks the calling thread. */
    pub fn on_permission(&self, e: &HookEvent, gone: &dyn Fn() -> bool) -> Option<Decision> {
        let o = &self.0.o;
        let questions = if e.tool() == "AskUserQuestion" { ask_questions(e.tool_input.as_ref()) } else { None };
        let key = tool_key(e);
        let (id, rx) = {
            let mut g = self.lock();
            if (questions.is_none() && !g.perm_on) || g.store.get(&e.session_id).map_or(false, |x| x.owned) { return None; }
            // with permissions on, two hook groups fire for one question: the first one shows it, the other has no opinion
            if questions.is_some() && g.asks.values().any(|a| a.session_id == e.session_id && a.tool == key) { return None; }
            let mut ev = HookEvent::new("Notification", &e.session_id, &e.cwd);
            ev.message = Some("permission".into());
            g.store.apply(&ev, now_ms());
            g.ask_seq += 1;
            let id = format!("{}{}", o.permission_id_prefix, g.ask_seq);
            let summary = match &questions { Some(q) => q[0].question.clone(), None => summarize(e.tool(), e.tool_input.as_ref().unwrap_or(&json!({}))) };
            g.store.set_pending(&e.session_id, Some(PendingPermission { id: id.clone(), tool: e.tool().to_string(), summary, questions: questions.clone() }));
            let (tx, rx) = channel();
            g.asks.insert(id.clone(), Ask { session_id: e.session_id.clone(), tool: key, tx, input: questions.as_ref().map(|_| e.tool_input.clone().unwrap_or_else(|| json!({}))) });
            self.snap(&mut g, false);
            (id, rx)
        };
        let deadline = std::time::Instant::now() + Duration::from_millis(if questions.is_some() { o.question_timeout_ms } else { o.permission_timeout_ms });
        loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(d) => return d,
                Err(RecvTimeoutError::Disconnected) => return None,
                // timed out, or Claude Code dropped the request (the session was closed, its hook timed out): nobody is waiting for this answer any more
                Err(RecvTimeoutError::Timeout) if std::time::Instant::now() >= deadline || gone() => {
                    let mut g = self.lock();
                    if g.asks.remove(&id).is_some() { g.store.set_pending(&e.session_id, None); self.snap(&mut g, false); }
                    return None;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }

    pub fn tick(&self, now: i64) {
        let mut g = self.lock();
        g.store.tick(now);
        let ready: Vec<(String, String)> = g.pending_ptys.iter().filter(|(id, _)| g.store.get(id).is_some()).map(|(a, b)| (a.clone(), b.clone())).collect();
        for (id, pipe) in ready { g.pending_ptys.remove(&id); g.store.set_pty(&id, &pipe); }
        self.snap(&mut g, true);
        let working: Vec<(String, String, i64)> = g.store.list().into_iter()
            .filter(|x| !x.owned && x.state.working() && !g.checking.contains(&x.id))
            .filter_map(|x| g.transcripts.get(&x.id).map(|p| (x.id.clone(), p.clone(), x.since))).collect();
        for (id, _, _) in &working { g.checking.insert(id.clone()); }
        drop(g);
        // the limits file changes only when a Claude Code session gets an API response: compare its mtime, no content polling
        let changed = { let u = self.0.usage.lock().unwrap(); let v = u.as_ref().map(|u| u.version()); let g = self.lock(); match (&g.usage_version, v) { (Some(old), Some(v)) if *old != v => true, _ => false } };
        if changed { let b = self.clone(); std::thread::spawn(move || b.push_usage()); }
        // Esc / Ctrl+C typed in the terminal end a turn without any hook: the transcript is the only witness
        for (id, path, since) in working {
            let b = self.clone();
            std::thread::spawn(move || {
                if interrupted_since(&path, since) {
                    let mut g = b.lock();
                    if g.store.get(&id).map_or(false, |c| c.since == since && c.state.working()) { g.store.mark_interrupted(&id, now_ms()); b.snap(&mut g, true); drop(g); b.reread_later(&id); }
                }
                b.lock().checking.remove(&id);
            });
        }
    }

    /** the front end the waiter reported (terminal, desktop app, ...) */
    pub fn set_source(&self, id: &str, source: &str) { let mut g = self.lock(); g.store.set_source(id, source); self.snap(&mut g, true); }
    pub fn mailbox(&self) -> Arc<Mailbox> { self.0.o.mailbox.clone() }
    /** true once after a `rescan` command: the adoption loop then scans at once and forgets what it adopted before */
    pub fn take_rescan(&self) -> bool { std::mem::take(&mut self.lock().rescan) }
    pub fn has_session(&self, id: &str) -> bool { self.lock().store.get(id).is_some() }

    /** For tests and the bridge main: the current state of a session. */
    pub fn session_state(&self, id: &str) -> Option<PetState> { self.lock().store.get(id).map(|x| x.state) }
}

impl crate::runner::RunnerHost for Bridge {
    fn session(&self, id: &str) -> Option<crate::types::Session> { self.lock().store.get(id).cloned() }
    fn apply(&self, ev: HookEvent) { self.lock().store.apply(&ev, now_ms()); }
    fn set_owned(&self, id: &str, owned: bool) { self.lock().store.set_owned(id, owned); }
    fn set_pending(&self, id: &str, p: Option<PendingPermission>) { self.lock().store.set_pending(id, p); }
    fn restore(&self, id: &str, state: PetState, since: i64, owned: bool) { self.lock().store.restore(id, state, since, owned); }
    fn chat(&self, id: &str, event: Value) { self.on_chat(id, event); }
    fn changed(&self) { self.snapshot(true); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    type Log = Arc<Mutex<Vec<Value>>>;
    fn make(name: &str) -> (Bridge, Log, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ccpet-br-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log: Log = Arc::new(Mutex::new(vec![]));
        let l = log.clone();
        let settings = dir.join("settings.json");
        let mut o = BridgeOpts::new(Box::new(move |v| l.lock().unwrap().push(v)), settings.clone(), "/x/ccpet-hook");
        o.host_hooks = Some(("http://127.0.0.1:47822".into(), "abc123".into()));
        o.stop_recheck_ms = 10;
        (Bridge::new(o), log, settings)
    }
    fn of(log: &Log, t: &str) -> Vec<Value> { log.lock().unwrap().iter().filter(|m| m["type"] == t).cloned().collect() }
    fn ev(name: &str, sid: &str) -> HookEvent { HookEvent::new(name, sid, "/w/proj") }

    #[test]
    fn hooks_drive_the_snapshot() {
        let (b, log, _) = make("snap");
        let mut e = ev("PreToolUse", "s1");
        e.tool_name = Some("Bash".into());
        e.tool_input = Some(json!({ "command": "ls" }));
        b.on_hook(e);
        let snap = of(&log, "snapshot").pop().unwrap();
        assert_eq!((snap["sessions"][0]["state"].as_str(), snap["sessions"][0]["project"].as_str(), snap["attention"].as_str()), (Some("running"), Some("proj"), Some("s1")));
        assert_eq!(snap["sessions"][0]["mailbox"], false);
        let n = of(&log, "snapshot").len();
        b.snapshot(true);
        assert_eq!(of(&log, "snapshot").len(), n, "unchanged snapshots are not repeated");
        // a passing test run reacts
        let mut t = ev("PostToolUse", "s1");
        t.tool_name = Some("Bash".into());
        t.tool_input = Some(json!({ "command": "npm test" }));
        b.on_hook(t);
        assert_eq!(of(&log, "react")[0]["reaction"], "happy");
    }

    #[test]
    fn windows_host_mailbox_soft_stop_and_pipes() {
        let dir = std::env::temp_dir().join(format!("ccpet-br-{}-win", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let log: Log = Arc::new(Mutex::new(vec![]));
        let l = log.clone();
        let mut o = BridgeOpts::new(Box::new(move |v| l.lock().unwrap().push(v)), dir.join("settings.json"), "");
        o.mailbox_only = true;
        o.soft_stop = true;
        o.stop_recheck_ms = 10;
        let b = Bridge::new(o);
        // a pipe reported before the session exists waits for it
        b.set_pty("w1", r"\\.\pipe\claude-pet-42");
        b.on_hook(ev("UserPromptSubmit", "w1"));
        b.tick(now_ms());
        assert_eq!(b.lock().store.get("w1").unwrap().pty.as_deref(), Some(r"\\.\pipe\claude-pet-42"));
        b.lock().store.clear_pty("w1");
        // no waiter right now: still queued for the mailbox, never "SDK is off"
        b.handle(&json!({ "type": "send", "sessionId": "w1", "text": "hi" }));
        assert!(of(&log, "error").is_empty());
        assert_eq!(of(&log, "chat")[0]["event"]["text"], "hi");
        // Stop without a PTY: the next tool hook is answered "stop", and the session shows the flag
        assert_eq!(sessions(&log)[0]["softStop"], true);
        b.handle(&json!({ "type": "interrupt", "sessionId": "w1" }));
        assert!(b.hook_reply(&ev("Notification", "w1")).is_none());
        assert_eq!(b.hook_reply(&ev("PreToolUse", "w1")).unwrap()["continue"], false);
        assert!(!b.lock().store.get("w1").unwrap().state.working());
    }

    fn sessions(log: &Log) -> Vec<Value> { of(log, "snapshot").pop().map_or(vec![], |s| s["sessions"].as_array().unwrap().clone()) }

    #[test]
    fn dismiss_and_end_hide_a_session_until_the_next_prompt() {
        for kind in ["dismiss", "end"] {
            let (b, log, _) = make(kind);
            let mut e = ev("Stop", "t1");
            e.pet_parents = Some(vec![std::process::id() as i64]); // not a claude process: never killed or remembered
            b.on_hook(e);
            assert_eq!(sessions(&log).len(), 1);
            b.handle(&json!({ "type": kind, "sessionId": "t1" }));
            assert!(sessions(&log).is_empty());
            b.on_hook(ev("Stop", "t1"));
            assert!(sessions(&log).is_empty(), "{kind}: a late Stop must not bring it back");
            b.on_hook(ev("UserPromptSubmit", "t1"));
            assert_eq!(sessions(&log)[0]["id"], "t1");
        }
    }

    #[test]
    fn rescan_forgets_dismissals_and_asks_for_one_scan() {
        let (b, _log, _) = make("rescan");
        b.adopt(ev("SessionStart", "t1"));
        b.handle(&json!({ "type": "dismiss", "sessionId": "t1" }));
        b.adopt(ev("SessionStart", "t1"));
        assert!(!b.has_session("t1"));
        assert!(!b.take_rescan());
        b.handle(&json!({ "type": "rescan" }));
        assert!(b.take_rescan() && !b.take_rescan());
        b.adopt(ev("SessionStart", "t1"));
        assert!(b.has_session("t1"));
    }

    #[test]
    fn adopt_does_not_revive_a_dismissed_session() {
        let (b, log, _) = make("adopt");
        b.on_hook(ev("Stop", "t1"));
        b.handle(&json!({ "type": "dismiss", "sessionId": "t1" }));
        b.adopt(ev("SessionStart", "t1"));
        assert!(sessions(&log).is_empty());
        b.on_hook(ev("UserPromptSubmit", "t1"));
        assert_eq!(sessions(&log)[0]["id"], "t1");
    }

    #[test]
    fn term_mark_without_a_known_pid_fails() {
        let (b, log, _) = make("tm");
        b.on_hook(ev("Stop", "t1"));
        b.handle(&json!({ "type": "term-mark", "sessionId": "t1", "text": "x" }));
        assert_eq!(of(&log, "termMark")[0], json!({ "type": "termMark", "sessionId": "t1", "ok": false }));
    }

    #[test]
    fn stop_rereads_the_history_and_set_source_reaches_the_snapshot() {
        let (b, log, settings) = make("hist");
        let tp = settings.with_file_name("t.jsonl");
        std::fs::write(&tp, "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n").unwrap();
        let mut e = ev("Stop", "t1");
        e.transcript_path = Some(tp.to_string_lossy().into_owned());
        b.on_hook(e);
        for _ in 0..40 { if of(&log, "history").len() >= 2 { break; } std::thread::sleep(Duration::from_millis(50)); }
        assert!(of(&log, "history").len() >= 2, "immediate read plus the re-read");
        assert!(sessions(&log)[0].get("source").is_none());
        b.set_source("t1", "claude-desktop");
        assert_eq!(sessions(&log)[0]["source"], "claude-desktop");
    }

    #[test]
    fn unknown_commands_and_the_sdk_switch() {
        let (b, log, _) = make("cmd");
        b.handle(&json!({ "type": "nope" }));
        b.handle(&json!({ "type": "start", "cwd": "C:\\x", "prompt": "hi" }));
        let errs = of(&log, "error");
        assert_eq!(errs.len(), 2);
        assert!(errs[1]["message"].as_str().unwrap().contains("выключен"), "off by default: {}", errs[1]);
    }

    #[test]
    fn typing_into_a_pty_and_refusing_while_busy() {
        let (b, log, _) = make("pty");
        let sock = std::env::temp_dir().join(format!("ccpet-br-pty-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let ls = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let t = std::thread::spawn(move || { let (mut s, _) = ls.accept().unwrap(); let mut x = String::new(); s.read_to_string(&mut x).unwrap(); x });
        let mut e = ev("SessionStart", "s1");
        e.pet_pty = Some(sock.to_string_lossy().into_owned());
        b.on_hook(e);
        b.handle(&json!({ "type": "send", "sessionId": "s1", "text": "hello" }));
        assert_eq!(t.join().unwrap(), "hello\r");
        assert!(of(&log, "error").is_empty());
        b.on_hook(ev("UserPromptSubmit", "s1"));
        b.handle(&json!({ "type": "send", "sessionId": "s1", "text": "again" }));
        assert!(of(&log, "error")[0]["message"].as_str().unwrap().contains("занят"));
    }

    #[test]
    fn mailbox_delivery_to_an_armed_waiter() {
        let (b, log, _) = make("mb");
        b.on_hook(ev("SessionStart", "s1"));
        let mb = b.0.o.mailbox.clone();
        let m2 = mb.clone();
        let t = std::thread::spawn(move || m2.wait("s1", Duration::from_secs(5), false, &|| false));
        while !mb.has_waiter("s1") { std::thread::sleep(Duration::from_millis(5)); }
        b.handle(&json!({ "type": "send", "sessionId": "s1", "text": "do it" }));
        match t.join().unwrap() { crate::mailbox::Waited::Message(m) => assert!(m.contains("[ccPet message] do it")), _ => panic!("no message") }
        assert_eq!(of(&log, "chat")[0]["event"]["text"], "do it");
        assert_eq!(b.session_state("s1"), Some(PetState::Thinking));
    }

    #[test]
    fn permissions_and_questions() {
        let (b, log, _) = make("perm");
        let ask = |b: &Bridge, tool: &str, input: Value| { let b = b.clone(); let mut e = ev("PermissionRequest", "s1"); e.tool_name = Some(tool.into()); e.tool_input = Some(input); std::thread::spawn(move || b.on_permission(&e, &|| false)) };
        // off by default: no opinion
        assert!(ask(&b, "Bash", json!({ "command": "rm x" })).join().unwrap().is_none());
        b.handle(&json!({ "type": "hook-permissions", "on": true }));
        let t = ask(&b, "Bash", json!({ "command": "rm x" }));
        let pending = loop { if let Some(p) = of(&log, "snapshot").iter().rev().find_map(|s| s["sessions"][0]["pendingPermission"].as_object().cloned()) { break p; } std::thread::sleep(Duration::from_millis(5)); };
        assert_eq!(pending["summary"], "rm x");
        b.handle(&json!({ "type": "permission", "id": pending["id"], "allow": true }));
        assert!(matches!(t.join().unwrap(), Some(Decision::Allow)));
        // a question is always shown; its answers go back as the tool input
        let q = json!({ "questions": [{ "question": "Which?", "options": [{ "label": "A" }, { "label": "B" }] }] });
        let t = ask(&b, "AskUserQuestion", q.clone());
        let id = loop { if let Some(p) = of(&log, "snapshot").iter().rev().find_map(|s| s["sessions"][0]["pendingPermission"]["id"].as_str().map(String::from)) { if p != pending["id"].as_str().unwrap() { break p; } } std::thread::sleep(Duration::from_millis(5)); };
        b.handle(&json!({ "type": "permission", "id": id, "allow": true, "answers": { "Which?": "A" } }));
        match t.join().unwrap() { Some(Decision::Updated(v)) => assert_eq!((v["answers"]["Which?"].as_str(), v["questions"].is_array()), (Some("A"), true)), _ => panic!("no update") }
        // the question settled elsewhere: its Allow / Deny goes away without an answer
        let t = ask(&b, "AskUserQuestion", q);
        while !of(&log, "snapshot").iter().rev().any(|s| s["sessions"][0]["pendingPermission"]["id"].as_str().map_or(false, |i| i != pending["id"] && i != id)) { std::thread::sleep(Duration::from_millis(5)); }
        b.on_hook(ev("Stop", "s1"));
        assert!(t.join().unwrap().is_none());
    }

    #[test]
    fn hooks_and_statusline_install_with_backups() {
        let (b, log, settings) = make("inst");
        std::fs::write(&settings, r#"{"model":"opus","statusLine":{"type":"command","command":"my-line.sh"}}"#).unwrap();
        b.handle(&json!({ "type": "hooks", "apply": false }));
        let plan = of(&log, "hooks").pop().unwrap();
        assert_eq!((plan["installed"].clone(), plan["applied"].clone(), plan["diff"].as_str().unwrap().contains("ccpet-hook")), (json!(false), json!(false), true));
        b.handle(&json!({ "type": "hooks", "apply": true, "permissions": true }));
        let done = of(&log, "hooks").pop().unwrap();
        assert_eq!((done["applied"].clone(), done["mailbox"].clone(), done["permissions"].clone()), (json!(true), json!(true), json!(true)));
        let now: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(hooks_status(&now).events && hooks_status(&now).mailbox && hooks_status(&now).permissions);
        assert!(settings.with_extension("json.bak").exists());
        b.handle(&json!({ "type": "hooks", "apply": false, "permissions": true }));
        assert_eq!(of(&log, "hooks").pop().unwrap()["diff"], "", "nothing left to change");
        // statusLine: the foreign one is wrapped, then restored
        b.handle(&json!({ "type": "statusline", "apply": true }));
        assert_eq!(of(&log, "statusline").pop().unwrap()["kind"], "chained");
        b.handle(&json!({ "type": "statusline", "apply": true, "remove": true }));
        let st = of(&log, "statusline").pop().unwrap();
        assert_eq!((st["applied"].clone(), st["kind"].clone()), (json!(true), json!("none")));
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(back["statusLine"]["command"], "my-line.sh");
        // removal takes every entry of ours out and leaves the user's
        b.handle(&json!({ "type": "hooks", "apply": true, "remove": true }));
        let gone: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(gone, json!({ "model": "opus", "statusLine": { "type": "command", "command": "my-line.sh" } }));
        std::fs::write(&settings, "{ nope").unwrap();
        b.handle(&json!({ "type": "hooks", "apply": true }));
        assert!(of(&log, "hooks").pop().unwrap()["error"].as_str().unwrap().contains("left untouched"));
    }
}
