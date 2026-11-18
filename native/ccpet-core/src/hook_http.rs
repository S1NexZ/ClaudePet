//! Loopback HTTP receiver for Claude Code `http` hooks and the mailbox long-poll (hookHttp.ts). A deliberately tiny HTTP/1.1 server:
//! one thread per connection, `Connection: close`, no dependencies.
//!   POST /hook/<token>/<Event>      body: the hook's JSON          -> 200 (PermissionRequest: the decision JSON, or empty)
//!   GET  /mailbox/<token>/<session> long-poll                      -> 200 text (a message) | 204 (none yet) | 409 (already waiting)

use crate::mailbox::{Mailbox, Waited};
use crate::types::HookEvent;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MAX_BODY: usize = 1_000_000;

pub enum Decision { Allow, Deny, Updated(Value) }

pub struct HookServerOpts {
    /** 0 picks a free port (tests) */
    pub port: u16,
    /** random per install; part of every URL path, so another local program cannot feed the pet */
    pub token: String,
    pub on_event: Box<dyn Fn(HookEvent) + Send + Sync>,
    pub mailbox: Arc<Mailbox>,
    /** a waiter told the session's folder (`?cwd=`) and front end (`?src=`) */
    pub on_waiter: Option<Box<dyn Fn(&str, &str, Option<&str>) + Send + Sync>>,
    /** answers a PermissionRequest; None = no opinion (Claude Code shows its normal dialog). The closure tells whether Claude Code dropped the request. */
    pub on_permission: Option<Box<dyn Fn(&HookEvent, &dyn Fn() -> bool) -> Option<Decision> + Send + Sync>>,
    /** an answer for an ordinary event (soft stop: `{"continue": false}`) */
    pub on_reply: Option<Box<dyn Fn(&HookEvent) -> Option<Value> + Send + Sync>>,
    /** how long one mailbox long-poll may last (the hook re-polls) */
    pub wait_ms: u64,
}

pub struct HookServer { pub port: u16, stop: Arc<AtomicBool> }

fn same_token(a: &str, b: &str) -> bool {
    // constant-time compare: nothing is lost by not leaking timing
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/** Percent-decoding; None for a malformed escape or invalid UTF-8 (must never panic in a handler). `plus`: query strings treat + as a space. */
fn decode(s: &str, plus: bool) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => { out.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?); i += 3; }
            b'+' if plus => { out.push(b' '); i += 1; }
            c => { out.push(c); i += 1; }
        }
    }
    String::from_utf8(out).ok()
}

fn query<'a>(q: &'a str, key: &str) -> Option<String> {
    q.split('&').filter_map(|p| p.split_once('=')).find(|(k, _)| *k == key).and_then(|(_, v)| decode(v, true))
}

fn safe_id(s: &str) -> bool { (1..=100).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') }

fn respond(c: &mut TcpStream, status: u16, ctype: Option<&str>, body: &str) {
    let reason = match status { 200 => "OK", 204 => "No Content", 400 => "Bad Request", 404 => "Not Found", 409 => "Conflict", _ => "Error" };
    let ct = ctype.map(|t| format!("Content-Type: {t}\r\n")).unwrap_or_default();
    let _ = write!(c, "HTTP/1.1 {status} {reason}\r\n{ct}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = c.flush();
    let _ = c.shutdown(Shutdown::Write);
}

/** Has the client closed its end? (peek returns 0 only on EOF.) */
fn client_gone(c: &TcpStream) -> bool {
    if c.set_nonblocking(true).is_err() { return false; }
    let mut b = [0u8; 1];
    let gone = matches!(c.peek(&mut b), Ok(0));
    let _ = c.set_nonblocking(false);
    gone
}

fn handle(mut c: TcpStream, o: &HookServerOpts) {
    let _ = c.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(rc) = c.try_clone() else { return };
    let mut r = BufReader::new(rc);
    let mut line = String::new();
    if r.read_line(&mut line).is_err() { return; }
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("/").to_string());
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() { break; }
        if let Some((k, v)) = h.split_once(':') { if k.eq_ignore_ascii_case("content-length") { len = v.trim().parse().unwrap_or(0); } }
    }
    let (path, q) = target.split_once('?').unwrap_or((&target, ""));
    let mut seg = path.split('/').skip(1);
    let (kind, token, rest) = (seg.next().unwrap_or(""), seg.next().unwrap_or(""), seg.next().unwrap_or(""));
    if !same_token(token, &o.token) || !matches!(kind, "hook" | "mailbox") || rest.is_empty() { return respond(&mut c, 404, None, ""); }

    if kind == "mailbox" && method == "GET" {
        let Some(sid) = decode(rest, false).filter(|s| safe_id(s)) else { return respond(&mut c, 400, None, "") };
        let (cwd, src) = (query(q, "cwd"), query(q, "src"));
        if let (Some(cwd), Some(f)) = (cwd.as_deref().filter(|c| !c.is_empty() && c.len() <= 1024 && !c.chars().any(|ch| (ch as u32) < 0x20)), o.on_waiter.as_ref()) {
            f(&sid, cwd, src.as_deref().filter(|s| (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')));
        }
        // the ccPet plugin submits messages as the user's own words: it wins over the older asyncRewake waiter (whose delivery shows as hook feedback)
        let is_mod = query(q, "via").as_deref() == Some("mod");
        let mb = &o.mailbox;
        if is_mod {
            mb.mark_mod(&sid);
            if mb.has_waiter(&sid) && !mb.waiter_is_mod(&sid) { mb.cancel(&sid); } // that waiter gets 204 and re-polls into a 409
        } else if mb.is_mod(&sid) { return respond(&mut c, 409, None, ""); }
        if mb.has_waiter(&sid) { return respond(&mut c, 409, None, ""); }
        let mod_wait = query(q, "wait").and_then(|w| w.parse::<f64>().ok()).filter(|w| *w != 0.0).unwrap_or(20.0).clamp(1.0, 25.0);
        let wait = if is_mod { Duration::from_secs_f64(mod_wait) } else { Duration::from_millis(o.wait_ms) };
        match mb.wait(&sid, wait, is_mod, &|| client_gone(&c)) {
            Waited::Busy => respond(&mut c, 409, None, ""),
            Waited::Timeout => respond(&mut c, 204, None, ""),
            Waited::Message(m) => respond(&mut c, 200, Some("text/plain; charset=utf-8"), &m),
        }
        return;
    }

    if kind == "hook" && method == "POST" {
        if len > MAX_BODY { return respond(&mut c, 400, None, ""); }
        let mut body = vec![0u8; len];
        if r.read_exact(&mut body).is_err() { return respond(&mut c, 400, None, ""); }
        let ev = serde_json::from_slice::<Value>(&body).ok().and_then(|v| HookEvent::from_value(v, decode(rest, false).as_deref().or(Some(""))));
        let Some(ev) = ev else { return respond(&mut c, 400, None, "") };
        if ev.hook_event_name == "PermissionRequest" {
            let d = o.on_permission.as_ref().and_then(|f| f(&ev, &|| client_gone(&c)));
            let Some(d) = d else { return respond(&mut c, 200, None, "") };
            let decision = match d { Decision::Allow => json!({ "behavior": "allow" }), Decision::Deny => json!({ "behavior": "deny" }), Decision::Updated(u) => json!({ "behavior": "allow", "updatedInput": u }) };
            let out = json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } });
            return respond(&mut c, 200, Some("application/json"), &out.to_string());
        }
        // never fail Claude Code because of the pet
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (o.on_event)(ev.clone())));
        // after the event: a stop answer marks the session idle, and no Stop hook follows `continue: false`
        let reply = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.on_reply.as_ref().and_then(|f| f(&ev)))).ok().flatten();
        return match reply { Some(r) => respond(&mut c, 200, Some("application/json"), &r.to_string()), None => respond(&mut c, 200, None, "") };
    }
    respond(&mut c, 404, None, "");
}

impl HookServer {
    pub fn start(o: HookServerOpts) -> std::io::Result<HookServer> {
        let ls = TcpListener::bind(("127.0.0.1", o.port))?;
        let port = ls.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let (st, o) = (stop.clone(), Arc::new(o));
        std::thread::spawn(move || {
            for conn in ls.incoming() {
                if st.load(Ordering::Relaxed) { break; }
                let Ok(c) = conn else { continue };
                let o = o.clone();
                std::thread::spawn(move || handle(c, &o));
            }
        });
        Ok(HookServer { port, stop })
    }
    pub fn close(self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", self.port)); // wakes the accept loop
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn req(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(c, "{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        let mut s = String::new();
        c.read_to_string(&mut s).unwrap();
        let status = s.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, s.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
    }

    fn server(wait_ms: u64) -> (HookServer, Arc<Mailbox>, Arc<Mutex<Vec<String>>>) {
        let mb = Arc::new(Mailbox::new());
        let got = Arc::new(Mutex::new(vec![]));
        let g = got.clone();
        let s = HookServer::start(HookServerOpts {
            port: 0, token: "abc123".into(), mailbox: mb.clone(), wait_ms,
            on_event: Box::new(move |e| g.lock().unwrap().push(format!("{}:{}", e.hook_event_name, e.session_id))),
            on_waiter: None,
            on_permission: Some(Box::new(|e, _| match e.tool() { "Bash" => Some(Decision::Allow), "Edit" => Some(Decision::Deny), "Ask" => Some(Decision::Updated(json!({ "a": 1 }))), _ => None })),
            on_reply: Some(Box::new(|e| (e.session_id == "stop-me").then(|| json!({ "continue": false })))),
        }).unwrap();
        (s, mb, got)
    }

    #[test]
    fn routes_and_events() {
        let (s, _, got) = server(100);
        assert_eq!(req(s.port, "POST", "/hook/wrong/Stop", "{}").0, 404);
        assert_eq!(req(s.port, "GET", "/nothing", "").0, 404);
        assert_eq!(req(s.port, "POST", "/hook/abc123/Stop", "not json").0, 400);
        assert_eq!(req(s.port, "POST", "/hook/abc123/Stop", r#"{"cwd":"/x"}"#).0, 400);
        // the event name comes from the URL when the body has none; a malformed escape is no crash
        assert_eq!(req(s.port, "POST", "/hook/abc123/Stop", r#"{"session_id":"s1"}"#), (200, String::new()));
        assert_eq!(req(s.port, "POST", "/hook/abc123/%zz", r#"{"session_id":"s2"}"#).0, 200);
        assert_eq!(req(s.port, "POST", "/hook/abc123/Stop", r#"{"session_id":"stop-me"}"#), (200, r#"{"continue":false}"#.to_string()));
        assert_eq!(got.lock().unwrap()[0], "Stop:s1");
        s.close();
    }

    #[test]
    fn permission_answers() {
        let (s, _, got) = server(100);
        let ask = |tool: &str| req(s.port, "POST", "/hook/abc123/PermissionRequest", &format!(r#"{{"session_id":"s","tool_name":"{tool}"}}"#));
        assert_eq!(ask("Bash").1, r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#);
        assert!(ask("Edit").1.contains(r#""behavior":"deny""#));
        assert!(ask("Ask").1.contains(r#""updatedInput":{"a":1}"#));
        assert_eq!(ask("Other"), (200, String::new()));
        assert!(got.lock().unwrap().is_empty(), "permission requests are not events");
        s.close();
    }

    #[test]
    fn mailbox_long_poll() {
        let (s, mb, _) = server(300);
        assert_eq!(req(s.port, "GET", "/mailbox/abc123/bad%20id", "").0, 400);
        assert_eq!(req(s.port, "GET", "/mailbox/abc123/s1", "").0, 204, "timeout");
        mb.send("s1", "queued text");
        assert_eq!(req(s.port, "GET", "/mailbox/abc123/s1", ""), (200, "queued text".to_string()));
        // a waiter gets a message sent while it waits; a second waiter is refused
        let port = s.port;
        let t = std::thread::spawn(move || req(port, "GET", "/mailbox/abc123/s2", ""));
        while !mb.has_waiter("s2") { std::thread::sleep(Duration::from_millis(5)); }
        assert_eq!(req(s.port, "GET", "/mailbox/abc123/s2", "").0, 409);
        mb.send("s2", "hello");
        assert_eq!(t.join().unwrap(), (200, "hello".to_string()));
        // the plugin wins: once it polled, the older waiter style is refused
        assert_eq!(req(s.port, "GET", "/mailbox/abc123/s3?via=mod&wait=1", "").0, 204);
        assert_eq!(req(s.port, "GET", "/mailbox/abc123/s3", "").0, 409);
        s.close();
    }
}
