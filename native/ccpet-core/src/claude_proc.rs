//! One `claude` process speaking Claude Code's stream-json protocol over stdio (what the Agent SDK does for the TypeScript bridge):
//! user messages and control requests go in as JSON lines; messages, control responses and permission requests come out.
//! A control request is `{type:"control_request", request_id, request:{subtype,...}}`, answered by
//! `{type:"control_response", response:{subtype:"success"|"error", request_id, response|error}}`; the CLI asks us with the same shape
//! (`can_use_tool`) and we answer the same way.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct Spawn {
    pub claude: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /** None: inherit the environment; Some: exactly these variables */
    pub env: Option<Vec<(String, String)>>,
}

pub type Reply = Sender<Result<Value, String>>;

pub struct Handlers {
    /** every message that is not a control frame (system, assistant, user, stream_event, result, ...) */
    pub on_message: Box<dyn Fn(&Arc<ClaudeProc>, Value) + Send + Sync>,
    /** the CLI asks something (`can_use_tool`): answer with `respond` (may be later, from another thread) */
    pub on_request: Box<dyn Fn(&Arc<ClaudeProc>, String, Value) + Send + Sync>,
    /** the CLI withdrew a request it made */
    pub on_cancel: Box<dyn Fn(&Arc<ClaudeProc>, &str) + Send + Sync>,
    /** stdout closed: None for a clean exit, else why (exit status and the end of stderr) */
    pub on_exit: Box<dyn Fn(&Arc<ClaudeProc>, Option<String>) + Send + Sync>,
}

pub struct ClaudeProc {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Reply>>,
    seq: AtomicU64,
    killed: std::sync::atomic::AtomicBool,
}

impl ClaudeProc {
    pub fn spawn(s: Spawn, h: Handlers) -> Result<Arc<ClaudeProc>, String> {
        let mut cmd = Command::new(&s.claude);
        cmd.args(&s.args).current_dir(&s.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(env) = &s.env { cmd.env_clear().envs(env.iter().map(|(k, v)| (k, v))); }
        let mut child = cmd.spawn().map_err(|e| format!("cannot start {}: {e}", s.claude.display()))?;
        let (stdin, stdout, mut stderr) = (child.stdin.take(), child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let p = Arc::new(ClaudeProc { child: Mutex::new(child), stdin: Mutex::new(stdin), pending: Mutex::new(HashMap::new()), seq: AtomicU64::new(0), killed: Default::default() });
        let tail = Arc::new(Mutex::new(String::new()));
        let t = tail.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            while let Ok(n) = stderr.read(&mut buf) { if n == 0 { break; } let mut g = t.lock().unwrap(); g.push_str(&String::from_utf8_lossy(&buf[..n])); let len = g.len(); if len > 2000 { let cut = g.ceil_char_boundary(len - 2000); g.drain(..cut); } }
        });
        let pr = p.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { pr.kill(); break }; // a line we cannot read: stop the process instead of leaving it running unattended
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                match v.get("type").and_then(Value::as_str) {
                    Some("control_response") => {
                        let r = &v["response"];
                        let id = r.get("request_id").and_then(Value::as_str).unwrap_or("");
                        if let Some(tx) = pr.pending.lock().unwrap().remove(id) {
                            let _ = tx.send(if r.get("subtype").and_then(Value::as_str) == Some("success") { Ok(r.get("response").cloned().unwrap_or(Value::Null)) }
                                else { Err(r.get("error").and_then(Value::as_str).unwrap_or("control request failed").to_string()) });
                        }
                    }
                    Some("control_request") => (h.on_request)(&pr, v.get("request_id").and_then(Value::as_str).unwrap_or("").to_string(), v.get("request").cloned().unwrap_or(Value::Null)),
                    Some("keep_alive") => {}
                    Some("control_cancel_request") => (h.on_cancel)(&pr, v.get("request_id").and_then(Value::as_str).unwrap_or("")),
                    _ => (h.on_message)(&pr, v),
                }
            }
            // stdout closed: the process is exiting (or was killed)
            pr.stdin.lock().unwrap().take();
            for (_, tx) in pr.pending.lock().unwrap().drain() { let _ = tx.send(Err("claude exited".into())); }
            let status = loop {
                match pr.child.lock().unwrap().try_wait() { Ok(Some(s)) => break Some(s), Ok(None) => {} Err(_) => break None }
                std::thread::sleep(Duration::from_millis(20));
            };
            let err = match status { Some(s) if s.success() => None, Some(s) => Some(format!("Claude Code process exited with {s}{}", { let t = tail.lock().unwrap().trim().to_string(); if t.is_empty() { t } else { format!(": {t}") } })), None => Some("Claude Code process lost".into()) };
            (h.on_exit)(&pr, if pr.killed.load(Ordering::Relaxed) { None } else { err });
        });
        Ok(p)
    }

    fn write(&self, v: &Value) -> Result<(), String> {
        let mut g = self.stdin.lock().unwrap();
        let Some(w) = g.as_mut() else { return Err("claude is not running".into()) };
        w.write_all(format!("{v}\n").as_bytes()).and_then(|_| w.flush()).map_err(|e| e.to_string())
    }

    /** A control request; blocks until the answer, the timeout or the process exit. */
    pub fn request(&self, body: Value, timeout: Duration) -> Result<Value, String> {
        let id = format!("{:x}{}", crate::usage::now_ms(), self.seq.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        if let Err(e) = self.write(&json!({ "type": "control_request", "request_id": id, "request": body })) { self.pending.lock().unwrap().remove(&id); return Err(e); }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => { self.pending.lock().unwrap().remove(&id); Err("timeout".into()) }
        }
    }

    /** The answer to a request the CLI made. */
    pub fn respond(&self, request_id: &str, r: Result<Value, String>) {
        let response = match r {
            Ok(v) => json!({ "subtype": "success", "request_id": request_id, "response": v }),
            Err(e) => json!({ "subtype": "error", "request_id": request_id, "error": e }),
        };
        let _ = self.write(&json!({ "type": "control_response", "response": response }));
    }

    pub fn send_user(&self, text: &str, session_id: &str) -> Result<(), String> {
        self.write(&json!({ "type": "user", "message": { "role": "user", "content": text }, "parent_tool_use_id": null, "session_id": session_id }))
    }

    /** Hard kill. */
    pub fn kill(&self) {
        self.killed.store(true, Ordering::Relaxed);
        self.stdin.lock().unwrap().take();
        let _ = self.child.lock().unwrap().kill();
    }

    fn exited_within(&self, ms: u64) -> bool {
        for _ in 0..ms / 20 {
            if !matches!(self.child.lock().unwrap().try_wait(), Ok(None)) { return true; }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /** The SDK's graceful end: close stdin (EOF), SIGTERM after 5 s, SIGKILL after 5 s more, so SessionEnd hooks run. */
    pub fn close(self: &Arc<Self>) {
        self.killed.store(true, Ordering::Relaxed);
        self.stdin.lock().unwrap().take();
        let p = self.clone();
        std::thread::spawn(move || {
            if p.exited_within(5000) { return; }
            let pid = p.child.lock().unwrap().id();
            let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
            if p.exited_within(5000) { return; }
            let _ = p.child.lock().unwrap().kill();
        });
    }
}
