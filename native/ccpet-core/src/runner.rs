//! Claude Code sessions the pet runs itself through the `claude` CLI (stream-json): new chats, the resume fallback for terminal
//! sessions, `/btw`, the model list (runner.ts, with the Agent SDK replaced by `claude_proc`). Each owned session is one long-lived
//! process fed by user messages, so follow-ups don't pay a process start; replies stream out as chat events and permission
//! prompts are relayed to the pet.

use crate::bridge::Runner;
use crate::claude_proc::{ClaudeProc, Handlers, Spawn};
use crate::i18n::l;
use crate::summary::summarize;
use crate::types::{HookEvent, PendingPermission, PetState, Session};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/** What the runner needs from the bridge (its session store and its output). */
pub trait RunnerHost: Send + Sync {
    fn session(&self, id: &str) -> Option<Session>;
    fn apply(&self, ev: HookEvent);
    fn set_owned(&self, id: &str, owned: bool);
    fn set_pending(&self, id: &str, p: Option<PendingPermission>);
    fn restore(&self, id: &str, state: PetState, since: i64, owned: bool);
    fn chat(&self, id: &str, event: Value);
    fn changed(&self);
}

const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const BASE_ARGS: [&str; 3] = ["--output-format=stream-json", "--verbose", "--input-format=stream-json"];

struct Live {
    cwd: String,
    /** the prompt that opened the process: the first turn */
    prompt: String,
    proc: OnceLock<Arc<ClaudeProc>>,
    sid: Mutex<Option<String>>,
    /** the user pressed stop: the turn's error result is an expected end */
    interrupted: AtomicBool,
    /** a resume that Claude answered with another session id: this process was closed and is to be ignored */
    aborted: AtomicBool,
    idle_gen: AtomicU64,
    settle: Mutex<Option<Sender<Result<String, String>>>>,
}

struct Pending { sid: String, input: Value, proc: Arc<ClaudeProc>, request_id: String }

#[derive(Default)]
struct State {
    pending: HashMap<String, Pending>,
    live: HashMap<String, Arc<Live>>,
    policy: String,
    default_model: Option<String>,
    session_model: HashMap<String, String>,
    models: Option<Vec<Value>>,
    cwd_of: HashMap<String, String>,
}

pub struct SessionRunner { host: Arc<dyn RunnerHost>, claude: Option<PathBuf>, idle_close: Duration, st: Arc<Mutex<State>> }

fn busy() -> String { l("Claude занят", "Claude is busy", "Claude 正忙") }
fn unknown(id: &str) -> String { l(&format!("Неизвестная сессия: {id}"), &format!("Unknown session: {id}"), &format!("未知会话：{id}")) }

fn child_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| k != "NODE_OPTIONS" && k != "DEBUG").collect();
    if !env.iter().any(|(k, _)| k == "CLAUDE_CODE_ENTRYPOINT") { env.push(("CLAUDE_CODE_ENTRYPOINT".into(), "sdk-ts".into())); }
    env
}

impl SessionRunner {
    pub fn new(host: Arc<dyn RunnerHost>, claude: Option<PathBuf>) -> Arc<SessionRunner> {
        Arc::new(SessionRunner { host, claude, idle_close: Duration::from_secs(20 * 60), st: Arc::new(Mutex::new(State { policy: "ask".into(), ..Default::default() })) })
    }
    pub fn with_idle_close(self: Arc<Self>, d: Duration) -> Arc<SessionRunner> {
        Arc::new(SessionRunner { host: self.host.clone(), claude: self.claude.clone(), idle_close: d, st: self.st.clone() })
    }

    fn claude(&self) -> Result<PathBuf, String> { self.claude.clone().ok_or_else(|| l("Claude Code не найден", "Claude Code was not found", "未找到 Claude Code")) }

    fn emit(&self, sid: &str, name: &str, f: impl FnOnce(&mut HookEvent)) {
        let cwd = self.st.lock().unwrap().cwd_of.get(sid).cloned().unwrap_or_default();
        let mut e = HookEvent::new(name, sid, &cwd);
        f(&mut e);
        self.host.apply(e);
    }

    fn begin_turn(&self, sid: &str, text: &str) {
        self.emit(sid, "UserPromptSubmit", |_| {});
        self.host.set_owned(sid, true);
        self.host.chat(sid, json!({ "kind": "user", "text": text }));
        self.host.changed();
    }

    fn args(&self, resume: Option<&str>, model: Option<&str>, extra: &[&str]) -> Vec<String> {
        let mut a: Vec<String> = BASE_ARGS.iter().chain(extra).map(|s| s.to_string()).collect();
        if let Some(r) = resume { a.push(format!("--resume={r}")); }
        if let Some(m) = model { a.push(format!("--model={m}")); }
        a
    }

    /** Starts a live process (new session, or resuming `resume`) and feeds it the first prompt. Returns the session id. */
    fn open(self: &Arc<Self>, cwd: &str, prompt: &str, resume: Option<&str>) -> Result<String, String> {
        let claude = self.claude()?;
        let (tx, rx) = channel();
        let live = Arc::new(Live { cwd: cwd.into(), prompt: prompt.into(), proc: OnceLock::new(), sid: Mutex::new(None), interrupted: AtomicBool::new(false), aborted: AtomicBool::new(false), idle_gen: AtomicU64::new(0), settle: Mutex::new(Some(tx)) });
        // what a resume changes before Claude has confirmed it, so that a refused resume can put it back
        let prev = resume.and_then(|r| self.host.session(r)).map(|s| (s.state, s.since, s.owned));
        let model = { let g = self.st.lock().unwrap(); resume.and_then(|r| g.session_model.get(r).cloned()).or(g.default_model.clone()) };
        let args = self.args(resume, model.as_deref(), &["--include-partial-messages", "--permission-prompt-tool=stdio", "--permission-mode=default"]);
        let resume_s = resume.map(String::from);

        let (r1, l1) = (self.clone(), live.clone());
        let (r2, l2) = (self.clone(), live.clone());
        let r3 = self.clone();
        let (r4, l4) = (self.clone(), live.clone());
        let rs = resume_s.clone();
        let handlers = Handlers {
            on_message: Box::new(move |_, m| {
                if l1.aborted.load(Ordering::Relaxed) { return; }
                if m["type"] == "system" && m["subtype"] == "init" {
                    let id = m["session_id"].as_str().unwrap_or("").to_string();
                    // Claude Code answered a resume with ANOTHER id: it made a copy. Never bind it to the original, never talk on in it.
                    if let Some(res) = rs.as_deref().filter(|r| *r != id) { r1.abort_copy(&l1, res, &id, prev); }
                    else if l1.sid.lock().unwrap().is_none() { r1.bind(&l1, &id); }
                    return;
                }
                let Some(sid) = l1.sid.lock().unwrap().clone() else { return };
                r1.on_message(&sid, &l1, &m);
                r1.host.changed();
            }),
            on_request: Box::new(move |p, id, req| r2.on_request(&l2, p, id, req)),
            on_cancel: Box::new(move |_, rid| r3.cancel_request(rid)),
            on_exit: Box::new(move |_, err| r4.on_exit(&l4, err)),
        };
        let proc = ClaudeProc::spawn(Spawn { claude, args, cwd: PathBuf::from(cwd), env: Some(child_env()) }, handlers)?;
        let _ = live.proc.set(proc.clone());
        let _ = proc.send_user(prompt, resume.unwrap_or(""));
        if let Some(r) = &resume_s { self.bind(&live, r); }
        rx.recv_timeout(Duration::from_secs(60)).unwrap_or_else(|_| Err(l("Claude Code не ответил", "Claude Code did not answer", "Claude Code 没有响应")))
    }

    fn bind(&self, live: &Arc<Live>, id: &str) {
        *live.sid.lock().unwrap() = Some(id.to_string());
        { let mut g = self.st.lock().unwrap(); g.live.insert(id.to_string(), live.clone()); g.cwd_of.insert(id.to_string(), live.cwd.clone()); }
        self.begin_turn(id, &live.prompt);
        if let Some(tx) = live.settle.lock().unwrap().take() { let _ = tx.send(Ok(id.to_string())); }
    }

    fn abort_copy(&self, live: &Arc<Live>, resume: &str, new_id: &str, prev: Option<(PetState, i64, bool)>) {
        live.aborted.store(true, Ordering::Relaxed);
        live.idle_gen.fetch_add(1, Ordering::Relaxed);
        { let mut g = self.st.lock().unwrap(); if g.live.get(resume).map_or(false, |x| Arc::ptr_eq(x, live)) { g.live.remove(resume); } }
        if let Some(p) = live.proc.get() { p.kill(); }
        if let Some((state, since, owned)) = prev { self.host.restore(resume, state, since, owned); }
        let short: String = new_id.chars().take(8).collect();
        self.host.chat(resume, json!({ "kind": "end", "error": l(
            &format!("Claude Code создал копию сессии (новый ID {short}…) вместо продолжения: отправка отменена, процесс закрыт. Исходная сессия не тронута."),
            &format!("Claude Code created a copy of the session (new ID {short}…) instead of continuing it: the send was cancelled and the process closed. The original session is untouched."),
            &format!("Claude Code 创建了该会话的副本（新 ID {short}…），而没有继续原会话：发送已取消，进程已关闭。原会话未受影响。")) }));
        self.host.changed();
        if let Some(tx) = live.settle.lock().unwrap().take() { let _ = tx.send(Err("copy".into())); }
    }

    fn on_request(&self, live: &Arc<Live>, p: &Arc<ClaudeProc>, request_id: String, req: Value) {
        if req["subtype"] != "can_use_tool" { return p.respond(&request_id, Err("not supported".into())); }
        let tool = req["tool_name"].as_str().unwrap_or("").to_string();
        let input = req.get("input").cloned().unwrap_or_else(|| json!({}));
        let policy = self.st.lock().unwrap().policy.clone();
        if policy == "all" || (policy == "edits" && EDIT_TOOLS.contains(&tool.as_str())) {
            return p.respond(&request_id, Ok(json!({ "behavior": "allow", "updatedInput": input })));
        }
        let Some(sid) = live.sid.lock().unwrap().clone() else { return p.respond(&request_id, Err("no session".into())) };
        let id = req["tool_use_id"].as_str().map(String::from).unwrap_or_else(|| request_id.clone());
        self.st.lock().unwrap().pending.insert(id.clone(), Pending { sid: sid.clone(), input: input.clone(), proc: p.clone(), request_id });
        self.host.set_pending(&sid, Some(PendingPermission { id, tool: tool.clone(), summary: summarize(&tool, &input), questions: None }));
        self.emit(&sid, "Notification", |e| e.message = Some(format!("Claude needs your permission to use {tool}")));
        self.host.changed();
    }

    /** Claude Code dropped a permission request (the session ended, the tool was cancelled): the pet stops asking. */
    fn cancel_request(&self, request_id: &str) {
        let id = self.st.lock().unwrap().pending.iter().find(|(_, p)| p.request_id == request_id).map(|(i, _)| i.clone());
        if let Some(id) = id { self.answer(&id, false); }
    }

    fn on_exit(&self, live: &Arc<Live>, err: Option<String>) {
        live.idle_gen.fetch_add(1, Ordering::Relaxed);
        if live.aborted.load(Ordering::Relaxed) { return; } // we closed it ourselves after a refused resume: already reported
        let sid = live.sid.lock().unwrap().clone();
        if let Some(sid) = &sid {
            let mut g = self.st.lock().unwrap();
            if g.live.get(sid).map_or(false, |x| Arc::ptr_eq(x, live)) { g.live.remove(sid); }
            g.pending.retain(|_, p| &p.sid != sid || !live.proc.get().map_or(false, |lp| Arc::ptr_eq(lp, &p.proc)));
            drop(g);
            if let Some(e) = &err {
                self.emit(sid, "PostToolUse", |ev| ev.tool_response = Some(json!({ "is_error": true })));
                self.host.chat(sid, json!({ "kind": "end", "error": e }));
                self.host.changed();
            }
        }
        if let Some(tx) = live.settle.lock().unwrap().take() {
            let _ = tx.send(Err(err.unwrap_or_else(|| l("Claude Code завершился, не начав сессию", "Claude Code exited without starting a session", "Claude Code 退出，未能启动会话"))));
        }
    }

    fn on_message(&self, sid: &str, live: &Arc<Live>, m: &Value) {
        let top = m.get("parent_tool_use_id").map_or(true, Value::is_null); // sub-agent chatter stays out of the chat
        match m["type"].as_str().unwrap_or("") {
            "stream_event" => {
                let d = &m["event"]["delta"];
                if top && m["event"]["type"] == "content_block_delta" && d["type"] == "text_delta" {
                    if let Some(t) = d["text"].as_str().filter(|t| !t.is_empty()) { self.host.chat(sid, json!({ "kind": "delta", "text": t })); }
                }
            }
            "assistant" => {
                let blocks = m["message"]["content"].as_array().cloned().unwrap_or_default();
                let text = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n").trim().to_string();
                if top && !text.is_empty() { self.host.chat(sid, json!({ "kind": "assistant", "text": text })); }
                for b in blocks.iter().filter(|b| b["type"] == "tool_use") {
                    let name = b["name"].as_str().unwrap_or("").to_string();
                    let input = b.get("input").cloned().unwrap_or(Value::Null);
                    self.emit(sid, "PreToolUse", |e| { e.tool_name = Some(name.clone()); e.tool_input = Some(input.clone()); });
                    if top { self.host.chat(sid, json!({ "kind": "tool", "name": name, "summary": summarize(&name, &input) })); }
                }
            }
            "user" => {
                let failed = m["message"]["content"].as_array().map_or(false, |a| a.iter().any(|b| b["type"] == "tool_result" && b["is_error"] == true));
                self.emit(sid, "PostToolUse", |e| e.tool_response = Some(json!({ "is_error": failed })));
            }
            "result" => {
                let sub = m["subtype"].as_str().unwrap_or("");
                if sub == "success" || live.interrupted.load(Ordering::Relaxed) {
                    self.emit(sid, "Stop", |_| {});
                    self.host.chat(sid, json!({ "kind": "end" }));
                } else {
                    self.emit(sid, "PostToolUse", |e| e.tool_response = Some(json!({ "is_error": true })));
                    self.host.chat(sid, json!({ "kind": "end", "error": l(&format!("Claude остановился: {sub}"), &format!("Claude stopped: {sub}"), &format!("Claude 已停止：{sub}")) }));
                }
                live.interrupted.store(false, Ordering::Relaxed);
                // an idle live process is closed after a while; the session can still be resumed later
                let gen = live.idle_gen.fetch_add(1, Ordering::Relaxed) + 1;
                let (live, after) = (live.clone(), self.idle_close);
                std::thread::spawn(move || {
                    std::thread::sleep(after);
                    if live.idle_gen.load(Ordering::Relaxed) == gen { if let Some(p) = live.proc.get() { p.kill(); } }
                });
            }
            _ => {}
        }
    }

    /** The user's (or Claude Code's) answer to a pending permission prompt. */
    fn answer(&self, id: &str, allow: bool) {
        let Some(p) = self.st.lock().unwrap().pending.remove(id) else { return };
        self.host.set_pending(&p.sid, None);
        self.emit(&p.sid, "PostToolUse", |e| e.tool_response = Some(json!({})));
        p.proc.respond(&p.request_id, Ok(if allow { json!({ "behavior": "allow", "updatedInput": p.input }) } else { json!({ "behavior": "deny", "message": l("Отклонено в ccPet", "Denied in ccPet", "已在 ccPet 中拒绝") }) }));
        self.host.changed();
    }

    fn probe(&self, extra: &[&str], resume: Option<&str>, cwd: &str, handlers: Handlers) -> Result<Arc<ClaudeProc>, String> {
        ClaudeProc::spawn(Spawn { claude: self.claude()?, args: self.args(resume, None, extra), cwd: PathBuf::from(cwd), env: Some(child_env()) }, handlers)
    }
}

fn idle_state(s: PetState) -> bool { matches!(s, PetState::Idle | PetState::Done | PetState::Sleeping | PetState::Error) }

/** The Runner trait works on `Arc<SessionRunner>` (the callbacks of its processes hold it). */
impl Runner for Arc<SessionRunner> {
    fn models(&self) -> Result<Vec<Value>, String> {
        if let Some(m) = self.st.lock().unwrap().models.clone() { return Ok(m); }
        let h = Handlers { on_message: Box::new(|_, _| {}), on_request: Box::new(|p, id, _| p.respond(&id, Err("no tools".into()))), on_cancel: Box::new(|_, _| {}), on_exit: Box::new(|_, _| {}) };
        let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_else(|_| "/".into());
        let p = self.probe(&[], None, &cwd, h)?;
        let r = p.request(json!({ "subtype": "initialize" }), Duration::from_secs(20));
        p.kill();
        let list: Vec<Value> = r?["models"].as_array().cloned().unwrap_or_default().iter()
            .map(|m| json!({ "value": m["value"], "displayName": m["displayName"], "description": m["description"] })).collect();
        self.st.lock().unwrap().models = Some(list.clone());
        Ok(list)
    }

    fn set_permission_policy(&self, policy: &str) { self.st.lock().unwrap().policy = policy.to_string(); }

    /** A live session at once, an idle one when it is next resumed; None = default for new chats. */
    fn set_model(&self, session: Option<&str>, model: &str) -> Result<(), String> {
        let Some(sid) = session else { self.st.lock().unwrap().default_model = Some(model.into()); return Ok(()) };
        let live = { let mut g = self.st.lock().unwrap(); g.session_model.insert(sid.into(), model.into()); g.live.get(sid).cloned() };
        if let Some(p) = live.and_then(|l| l.proc.get().cloned()) { p.request(json!({ "subtype": "set_model", "model": model }), Duration::from_secs(10))?; }
        Ok(())
    }

    /** /btw: a side question answered in a throwaway fork of the session; works while it is busy. The answer arrives as a note. */
    fn btw(&self, session: &str, question: &str) -> Result<(), String> {
        let s = self.host.session(session).ok_or_else(|| unknown(session))?;
        self.host.chat(session, json!({ "kind": "user", "text": format!("/btw {question}") }));
        let me = self.clone();
        let (sid, q) = (session.to_string(), question.to_string());
        std::thread::spawn(move || {
            let answer = Arc::new(Mutex::new(String::new()));
            let (done_tx, done_rx) = channel::<Option<String>>();
            let (a, tx1, tx2) = (answer.clone(), done_tx.clone(), done_tx);
            let h = Handlers {
                on_message: Box::new(move |_, m| {
                    if m["type"] == "assistant" && m.get("parent_tool_use_id").map_or(true, Value::is_null) {
                        let t = m["message"]["content"].as_array().map(|b| b.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                        a.lock().unwrap().push_str(&t);
                    } else if m["type"] == "result" { let _ = tx1.send(None); }
                }),
                on_request: Box::new(|p, id, _| p.respond(&id, Ok(json!({ "behavior": "deny", "message": l("В /btw инструменты не используются", "Tools are not used in /btw", "/btw 中不使用工具") })))),
                on_cancel: Box::new(|_, _| {}),
                on_exit: Box::new(move |_, e| { let _ = tx2.send(e); }),
            };
            let model = { let g = me.st.lock().unwrap(); g.session_model.get(&sid).cloned().or(g.default_model.clone()) };
            let mut args = me.args(Some(&sid), model.as_deref(), &["--fork-session", "--permission-prompt-tool=stdio", "--permission-mode=default"]);
            args.retain(|x| !x.is_empty());
            let side = l("[Побочный вопрос /btw: ответь коротко и только текстом, не используй инструменты и не продолжай основную задачу]", "[Side question /btw: answer briefly and in plain text only, do not use tools and do not continue the main task]", "[旁白提问 /btw：请只用简短的纯文本回答，不要使用工具，也不要继续主任务]");
            let res = me.claude().and_then(|c| ClaudeProc::spawn(Spawn { claude: c, args, cwd: PathBuf::from(&s.cwd), env: Some(child_env()) }, h));
            let err = match res {
                Ok(p) => { let _ = p.send_user(&format!("{side}\n{q}"), ""); let r = done_rx.recv_timeout(Duration::from_secs(300)).unwrap_or(Some("timeout".into())); p.kill(); r }
                Err(e) => Some(e),
            };
            let mut text = answer.lock().unwrap().trim().to_string();
            if text.is_empty() { if let Some(e) = err { text = format!("⚠ {e}"); } }
            me.host.chat(&sid, json!({ "kind": "note", "text": if text.is_empty() { l("(пустой ответ)", "(empty answer)", "（空回答）") } else { text } }));
        });
        Ok(())
    }

    /** Lets go of a pet-owned session (its process ends) so another client, e.g. a terminal, can resume it. */
    fn release(&self, session: &str) -> bool {
        let (live, pend) = {
            let mut g = self.st.lock().unwrap();
            let Some(live) = g.live.remove(session) else { return false };
            let ids: Vec<String> = g.pending.iter().filter(|(_, p)| p.sid == session).map(|(i, _)| i.clone()).collect();
            (live, ids)
        };
        live.idle_gen.fetch_add(1, Ordering::Relaxed);
        for id in pend { self.answer(&id, false); }
        if let Some(p) = live.proc.get() { p.kill(); } // a running turn ends with it
        self.host.set_owned(session, false);
        self.host.changed();
        true
    }

    fn start(&self, cwd: &str, prompt: &str) -> Result<String, String> {
        if !std::path::Path::new(cwd).is_dir() { return Err(l(&format!("Папка не существует: {cwd}"), &format!("The folder does not exist: {cwd}"), &format!("文件夹不存在：{cwd}"))); }
        self.open(cwd, prompt, None)
    }

    fn send(&self, session: &str, text: &str) -> Result<(), String> {
        let s = self.host.session(session).ok_or_else(|| unknown(session))?;
        // never write into a session that is mid-work or waiting on the user
        if !idle_state(s.state) { return Err(busy()); }
        let live = self.st.lock().unwrap().live.get(session).cloned();
        let Some(live) = live else { self.open(s.resume_cwd.as_deref().unwrap_or(&s.cwd), text, Some(session))?; return Ok(()) };
        live.idle_gen.fetch_add(1, Ordering::Relaxed);
        self.begin_turn(session, text);
        live.proc.get().ok_or("not started")?.send_user(text, session)
    }

    fn interrupt(&self, session: &str) -> Result<(), String> {
        let Some(live) = self.st.lock().unwrap().live.get(session).cloned() else { return Ok(()) };
        live.interrupted.store(true, Ordering::Relaxed);
        if let Some(p) = live.proc.get().cloned() { std::thread::spawn(move || { let _ = p.request(json!({ "subtype": "interrupt" }), Duration::from_secs(10)); }); }
        Ok(())
    }

    fn respond_permission(&self, id: &str, allow: bool) { self.answer(id, allow); }

    /** Ends every live process (the app is quitting). */
    fn close_all(&self) {
        let live: Vec<_> = self.st.lock().unwrap().live.drain().map(|(_, l)| l).collect();
        for l in live { l.idle_gen.fetch_add(1, Ordering::Relaxed); if let Some(p) = l.proc.get() { p.kill(); } }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{Bridge, BridgeOpts};

    /** A stand-in for `claude` that speaks the stream-json protocol; `mode` picks the behaviour. */
    fn fake(name: &str, mode: &str) -> Option<PathBuf> {
        if std::process::Command::new("python3").arg("--version").output().is_err() { return None; }
        let d = std::env::temp_dir().join(format!("ccpet-run-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("claude");
        std::fs::write(&f, format!(r#"#!/usr/bin/env python3
import sys, json
mode = {mode:?}
resume = [a.split('=', 1)[1] for a in sys.argv if a.startswith('--resume=')]
sid = resume[0] if resume else 'sess-new'
if mode == 'copy' and resume: sid = 'copy-id-1234567890'
def out(o): print(json.dumps(o), flush=True)
for l in sys.stdin:
    m = json.loads(l)
    if m.get('type') == 'user':
        out({{'type': 'system', 'subtype': 'init', 'session_id': sid}})
        if mode == 'perm':
            out({{'type': 'control_request', 'request_id': 'r1', 'request': {{'subtype': 'can_use_tool', 'tool_name': 'Bash', 'input': {{'command': 'ls'}}, 'tool_use_id': 'tu1'}}}})
            continue
        out({{'type': 'assistant', 'message': {{'content': [{{'type': 'text', 'text': 'hello ' + m['message']['content']}}, {{'type': 'tool_use', 'name': 'Read', 'input': {{'file_path': '/a'}}}}]}}}})
        out({{'type': 'result', 'subtype': 'success'}})
    elif m.get('type') == 'control_response' and mode == 'perm':
        out({{'type': 'assistant', 'message': {{'content': [{{'type': 'text', 'text': 'got ' + m['response']['response']['behavior']}}]}}}})
        out({{'type': 'result', 'subtype': 'success'}})
    elif m.get('type') == 'control_request':
        sub = m['request']['subtype']
        out({{'type': 'control_response', 'response': {{'subtype': 'success', 'request_id': m['request_id'], 'response': {{'models': [{{'value': 'm1', 'displayName': 'M1', 'description': 'd'}}]}} if sub == 'initialize' else {{}}}}}})
"#)).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        Some(f)
    }

    type Log = Arc<Mutex<Vec<Value>>>;
    fn rig(claude: PathBuf) -> (Bridge, Log, Arc<SessionRunner>) {
        let log: Log = Arc::new(Mutex::new(vec![]));
        let l = log.clone();
        let dir = std::env::temp_dir().join(format!("ccpet-rig-{}-{}", std::process::id(), claude.parent().unwrap().file_name().unwrap().to_string_lossy()));
        std::fs::create_dir_all(&dir).unwrap();
        let b = Bridge::new(BridgeOpts::new(Box::new(move |v| l.lock().unwrap().push(v)), dir.join("settings.json"), "/x/ccpet-hook"));
        let r = SessionRunner::new(Arc::new(b.clone()), Some(claude));
        b.set_runner(Arc::new(r.clone()));
        b.handle(&json!({ "type": "sdk-chats", "on": true }));
        (b, log, r)
    }
    fn of(log: &Log, t: &str) -> Vec<Value> { log.lock().unwrap().iter().filter(|m| m["type"] == t).cloned().collect() }
    fn chats(log: &Log) -> Vec<String> { of(log, "chat").iter().map(|c| format!("{}:{}", c["event"]["kind"].as_str().unwrap(), c["event"]["text"].as_str().unwrap_or(""))).collect() }
    fn until(what: &str, f: impl Fn() -> bool) { for _ in 0..400 { if f() { return; } std::thread::sleep(Duration::from_millis(25)); } panic!("timed out waiting for {what}"); }

    #[test]
    fn a_new_chat_runs_streams_and_continues() {
        let Some(c) = fake("chat", "chat") else { return };
        let (b, log, r) = rig(c);
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        b.handle(&json!({ "type": "start", "cwd": cwd, "prompt": "hi" }));
        assert_eq!(of(&log, "started")[0]["sessionId"], "sess-new");
        until("the turn", || chats(&log).contains(&"end:".to_string()));
        assert_eq!(chats(&log), vec!["user:hi", "assistant:hello hi", "tool:", "end:"]);
        assert_eq!(of(&log, "chat")[2]["event"]["summary"], "/a");
        until("idle", || b.session_state("sess-new") == Some(PetState::Done));
        // a follow-up goes into the same process
        b.handle(&json!({ "type": "send", "sessionId": "sess-new", "text": "again" }));
        until("the second turn", || chats(&log).contains(&"assistant:hello again".to_string()));
        let snap = of(&log, "snapshot").pop().unwrap();
        assert_eq!(snap["sessions"][0]["owned"], true);
        // releasing hands the session back
        b.handle(&json!({ "type": "release", "sessionId": "sess-new" }));
        assert_eq!(of(&log, "snapshot").pop().unwrap()["sessions"][0]["owned"], false);
        r.close_all();
    }

    #[test]
    fn permission_prompts_are_relayed_and_policy_can_skip_them() {
        let Some(c) = fake("perm", "perm") else { return };
        let (b, log, r) = rig(c);
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        b.handle(&json!({ "type": "start", "cwd": cwd, "prompt": "go" }));
        until("the prompt", || of(&log, "snapshot").iter().any(|s| s["sessions"][0]["pendingPermission"]["id"] == "tu1"));
        assert_eq!(of(&log, "snapshot").iter().rev().find_map(|s| s["sessions"][0]["pendingPermission"]["summary"].as_str().map(String::from)).as_deref(), Some("ls"));
        b.handle(&json!({ "type": "permission", "id": "tu1", "allow": false }));
        until("the answer", || chats(&log).contains(&"assistant:got deny".to_string()));
        assert!(of(&log, "snapshot").pop().unwrap()["sessions"][0]["pendingPermission"].is_null());
        r.close_all();
        // "all" never asks
        let (b, log, r) = rig(fake("perm2", "perm").unwrap());
        b.handle(&json!({ "type": "permission-mode", "mode": "all" }));
        b.handle(&json!({ "type": "start", "cwd": cwd, "prompt": "go" }));
        until("auto allow", || chats(&log).contains(&"assistant:got allow".to_string()));
        r.close_all();
    }

    #[test]
    fn a_resume_answered_with_another_id_is_refused_and_undone() {
        let Some(c) = fake("copy", "copy") else { return };
        let (b, log, r) = rig(c);
        let mut e = crate::types::HookEvent::new("SessionStart", "orig", &std::env::temp_dir().to_string_lossy());
        e.transcript_path = None;
        b.on_hook(e);
        b.handle(&json!({ "type": "send", "sessionId": "orig", "text": "continue" }));
        until("the refusal", || of(&log, "chat").iter().any(|c| c["event"]["kind"] == "end" && c["event"]["error"].as_str().map_or(false, |e| e.contains("copy-id-") || e.contains("copy-id"))));
        let snap = of(&log, "snapshot").pop().unwrap();
        assert_eq!((snap["sessions"][0]["id"].as_str(), snap["sessions"][0]["owned"].clone()), (Some("orig"), json!(false)));
        assert_eq!(snap["sessions"].as_array().unwrap().len(), 1, "no copy was adopted");
        r.close_all();
    }

    #[test]
    fn models_are_listed_once_and_btw_answers_as_a_note() {
        let Some(c) = fake("models", "chat") else { return };
        let (b, log, r) = rig(c);
        b.handle(&json!({ "type": "models" }));
        assert_eq!(of(&log, "models")[0]["models"][0]["value"], "m1");
        b.handle(&json!({ "type": "setModel", "sessionId": null, "model": "m1" }));
        assert_eq!(of(&log, "modelSet")[0]["model"], "m1");
        b.on_hook(crate::types::HookEvent::new("SessionStart", "s9", &std::env::temp_dir().to_string_lossy()));
        b.handle(&json!({ "type": "btw", "sessionId": "s9", "text": "why" }));
        until("the note", || chats(&log).iter().any(|c| c.starts_with("note:hello ")));
        assert!(chats(&log)[0].starts_with("user:/btw why"));
        r.close_all();
    }
}
