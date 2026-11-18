//! The on-demand plan-limits query: one short-lived `claude` process, no prompt, nothing persisted, no user settings loaded, asked for
//! the data behind `/usage` (control request `get_usage`, experimental) and closed (usageLive.ts). Claude Code does the authentication;
//! this code never sees a token. No timer: `refresh()` runs one query for a user's click, never overlapping, at most one per 60 s.

use crate::claude_proc::{ClaudeProc, Handlers, Spawn};
use crate::transcript::parse_ts;
use crate::types::UsageWindow;
use crate::usage::{now_ms, LiveData, LiveErrorCode, LiveSource, LiveState};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

fn win(w: Option<&Value>) -> Option<UsageWindow> {
    let w = w?;
    let p = w.get("utilization")?.as_f64()?;
    let t = parse_ts(w.get("resets_at")?.as_str()?)?;
    Some(UsageWindow { used_pct: p.clamp(0.0, 100.0), resets_at: (t as f64 / 1000.0).round() })
}

/** Validates the answer of `get_usage`. Anything not clearly usable is an error, so it can never replace good data. */
pub fn parse_live_usage(r: &Value) -> Result<(Option<String>, Option<UsageWindow>, Option<UsageWindow>), LiveErrorCode> {
    if !r.is_object() { return Err(LiveErrorCode::Invalid); }
    if r.get("rate_limits_available") == Some(&Value::Bool(false)) { return Err(LiveErrorCode::Unavailable); } // API key, 3P provider
    let (five, seven) = (win(r.pointer("/rate_limits/five_hour")), win(r.pointer("/rate_limits/seven_day")));
    if five.is_none() && seven.is_none() { return Err(LiveErrorCode::Invalid); }
    let plan = r.get("subscription_type").and_then(Value::as_str).filter(|p| (1..=32).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).map(str::to_lowercase);
    Ok((plan, five, seven))
}

pub type Fetch = Arc<dyn Fn() -> Result<(Option<String>, Option<UsageWindow>, Option<UsageWindow>), LiveErrorCode> + Send + Sync>;

/** The real query against a `claude` binary. */
pub fn claude_fetch(claude: PathBuf, cwd: PathBuf, timeout: Duration) -> Fetch {
    Arc::new(move || {
        let deadline = Instant::now() + timeout;
        let _ = std::fs::create_dir_all(&cwd);
        // no inherited session markers or keys
        let env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| !k.starts_with("CLAUDE") && !k.starts_with("ANTHROPIC") && k != "PET_PTY_SOCK").collect();
        let h = Handlers {
            on_message: Box::new(|_, _| {}), // only housekeeping messages arrive
            on_request: Box::new(|p, id, _| p.respond(&id, Err("not supported".into()))),
            on_cancel: Box::new(|_, _| {}),
            on_exit: Box::new(|_, _| {}),
        };
        let args = ["--output-format=stream-json", "--verbose", "--input-format=stream-json", "--no-session-persistence", "--setting-sources="].map(String::from).to_vec();
        let p = ClaudeProc::spawn(Spawn { claude: claude.clone(), args, cwd: cwd.clone(), env: Some(env) }, h).map_err(|_| LiveErrorCode::Spawn)?;
        let left = || deadline.saturating_duration_since(Instant::now());
        let r = (|| {
            p.request(json!({ "subtype": "initialize" }), left()).map_err(|e| if e == "timeout" { LiveErrorCode::Timeout } else { LiveErrorCode::Error })?;
            let resp = p.request(json!({ "subtype": "get_usage", "skip_behaviors": true }), left()).map_err(|e| match e.as_str() { "timeout" => LiveErrorCode::Timeout, e if e.contains("nknown") || e.contains("nsupported") => LiveErrorCode::Unsupported, _ => LiveErrorCode::Error })?;
            parse_live_usage(&resp)
        })();
        p.kill(); // the child process must not outlive the request
        r
    })
}

pub struct LivePoller {
    fetch: Fetch,
    st: Mutex<LiveState>,
    revision: AtomicU64,
    last_start: Mutex<Option<Instant>>,
    min_gap: Duration,
    notify: OnceLock<Box<dyn Fn() + Send + Sync>>,
}

impl LivePoller {
    pub fn new(fetch: Fetch, min_gap: Duration) -> Arc<LivePoller> {
        Arc::new(LivePoller { fetch, st: Mutex::new(LiveState::default()), revision: AtomicU64::new(0), last_start: Mutex::new(None), min_gap, notify: OnceLock::new() })
    }
    /** called when a query starts and when it ends (so the UI can show "updating…" and the new numbers) */
    pub fn set_notify(&self, f: impl Fn() + Send + Sync + 'static) { let _ = self.notify.set(Box::new(f)); }
    fn ping(&self) { if let Some(f) = self.notify.get() { f(); } }
}

impl LiveSource for Arc<LivePoller> {
    fn state(&self) -> LiveState { self.st.lock().unwrap().clone() }
    fn revision(&self) -> u64 { self.revision.load(Ordering::Relaxed) }
    fn periodic(&self) -> bool { false }
    /** One query now: never while one runs, never closer than the gap to the last one. Returns whether it started. */
    fn refresh(&self) -> bool {
        {
            let mut st = self.st.lock().unwrap();
            let mut last = self.last_start.lock().unwrap();
            if st.running || last.map_or(false, |t| t.elapsed() < self.min_gap) { return false; }
            st.running = true;
            *last = Some(Instant::now());
        }
        let p = self.clone();
        std::thread::spawn(move || {
            p.ping();
            let r = (p.fetch)();
            {
                let mut st = p.st.lock().unwrap();
                match r {
                    Ok((plan, five_hour, seven_day)) => { st.data = Some(LiveData { plan, five_hour, seven_day, updated_at: now_ms() }); st.last_error = None; }
                    Err(e) => st.last_error = Some(e), // the last good data stays
                }
                st.running = false;
                st.last_attempt_at = Some(now_ms());
            }
            p.revision.fetch_add(1, Ordering::Relaxed);
            p.ping();
        });
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_the_answer() {
        let ok = json!({ "subscription_type": "Pro", "rate_limits": { "five_hour": { "utilization": 64.5, "resets_at": "2026-01-01T10:00:00.5Z" }, "seven_day": { "utilization": null, "resets_at": "x" } } });
        let (plan, five, seven) = parse_live_usage(&ok).unwrap();
        assert_eq!((plan.as_deref(), five, seven), (Some("pro"), Some(UsageWindow { used_pct: 64.5, resets_at: 1767261601.0 }), None));
        assert_eq!(parse_live_usage(&json!({ "rate_limits_available": false })), Err(LiveErrorCode::Unavailable));
        assert_eq!(parse_live_usage(&json!({ "rate_limits": {} })), Err(LiveErrorCode::Invalid));
        assert_eq!(parse_live_usage(&json!("x")), Err(LiveErrorCode::Invalid));
    }

    #[test]
    fn poller_never_overlaps_keeps_good_data_and_throttles() {
        let calls = Arc::new(AtomicU64::new(0));
        let c = calls.clone();
        let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let f = fail.clone();
        let fetch: Fetch = Arc::new(move || {
            c.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(100));
            if f.load(Ordering::SeqCst) { Err(LiveErrorCode::Timeout) } else { Ok((Some("pro".into()), Some(UsageWindow { used_pct: 10.0, resets_at: 9.0 }), None)) }
        });
        let p = LivePoller::new(fetch, Duration::from_millis(300));
        let wait = |p: &Arc<LivePoller>| while p.state().running { std::thread::sleep(Duration::from_millis(10)); };
        assert!(p.refresh());
        assert!(!p.refresh(), "one at a time");
        wait(&p);
        let st = p.state();
        assert_eq!((st.data.as_ref().map(|d| d.plan.clone()), st.last_error, p.revision()), (Some(Some("pro".into())), None, 1));
        assert!(!p.refresh(), "too soon after the last one");
        std::thread::sleep(Duration::from_millis(350));
        fail.store(true, Ordering::SeqCst);
        assert!(p.refresh());
        wait(&p);
        let st = p.state();
        assert_eq!((st.data.is_some(), st.last_error, calls.load(Ordering::SeqCst)), (true, Some(LiveErrorCode::Timeout), 2));
    }

    /** A stand-in for `claude` that speaks just enough of the protocol (python3 is in every test environment of this project). */
    fn fake_claude(name: &str, usage: &str) -> Option<PathBuf> {
        if std::process::Command::new("python3").arg("--version").output().is_err() { return None; }
        let d = std::env::temp_dir().join(format!("ccpet-fake-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("claude");
        std::fs::write(&f, format!("#!/usr/bin/env python3\nimport sys,json\nfor l in sys.stdin:\n    m=json.loads(l)\n    if m.get('type')!='control_request': continue\n    sub=m['request']['subtype']\n    r={{}} if sub=='initialize' else json.loads({usage:?})\n    print(json.dumps({{'type':'control_response','response':{{'subtype':'success','request_id':m['request_id'],'response':r}}}}),flush=True)\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        Some(f)
    }

    #[test]
    fn real_query_against_a_fake_claude() {
        let ok = r#"{"subscription_type":"max","rate_limits":{"five_hour":{"utilization":12,"resets_at":"2026-01-01T10:00:00Z"}}}"#;
        let Some(c) = fake_claude("ok", ok) else { return };
        let r = claude_fetch(c, std::env::temp_dir().join("ccpet-fake-cwd"), Duration::from_secs(10))().unwrap();
        assert_eq!((r.0.as_deref(), r.1.map(|w| w.used_pct), r.2), (Some("max"), Some(12.0), None));
        let c = fake_claude("na", r#"{"rate_limits_available":false}"#).unwrap();
        assert_eq!(claude_fetch(c, std::env::temp_dir().join("ccpet-fake-cwd"), Duration::from_secs(10))(), Err(LiveErrorCode::Unavailable));
        assert_eq!(claude_fetch(PathBuf::from("/nonexistent/claude"), std::env::temp_dir(), Duration::from_secs(1))(), Err(LiveErrorCode::Spawn));
    }
}
