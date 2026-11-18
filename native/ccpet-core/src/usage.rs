//! Plan limits shown by the ring: the statusLine file, the on-demand live query and the plan name (usage.ts).

use crate::types::{freshest_window, UsageWindow};
use regex_lite::Regex;
use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub fn default_usage_path() -> PathBuf {
    std::env::var_os("CLAUDE_PET_USAGE").map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::pet_dir().join("usage.json"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveErrorCode { Timeout, Spawn, Unsupported, Unavailable, Invalid, Error }

#[derive(Clone, Debug, PartialEq)]
pub struct LiveData { pub plan: Option<String>, pub five_hour: Option<UsageWindow>, pub seven_day: Option<UsageWindow>, pub updated_at: i64 }

/** The live query's state: `data` is the last SUCCESSFUL answer (never replaced by a failure). */
#[derive(Clone, Debug, Default)]
pub struct LiveState { pub data: Option<LiveData>, pub last_attempt_at: Option<i64>, pub last_error: Option<LiveErrorCode>, pub running: bool }

pub trait LiveSource: Send + Sync {
    fn state(&self) -> LiveState;
    fn revision(&self) -> u64;
    /** false: no timer, queries only on a click */
    fn periodic(&self) -> bool { true }
    fn refresh(&self) -> bool { false }
}

#[derive(Debug, PartialEq, Default)]
pub struct FileUsage { pub updated_at: Option<i64>, pub five_hour: Option<UsageWindow>, pub seven_day: Option<UsageWindow> }

fn win(w: Option<&Value>) -> Option<UsageWindow> {
    let w = w?;
    let (p, r) = (w.get("used_percentage")?.as_f64()?, w.get("resets_at")?.as_f64()?);
    Some(UsageWindow { used_pct: p.clamp(0.0, 100.0), resets_at: r })
}

/** Parses usage.json written by the status line hook; anything malformed gives "no data" (never a made-up value). */
pub fn parse_usage(raw: &str) -> FileUsage {
    let Ok(j) = serde_json::from_str::<Value>(raw) else { return FileUsage::default() };
    let t = j.get("updatedAt").and_then(Value::as_f64).filter(|t| *t > 0.0).map(|t| t as i64);
    FileUsage { updated_at: t, five_hour: win(j.get("five_hour")), seven_day: win(j.get("seven_day")) }
}

fn plan_ok(s: &str) -> bool { (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') }

/** Only the plan out of `claude auth status` output: nothing else of it (email, org, ids) is read or kept. */
pub fn plan_from_auth_status(out: &str) -> Option<String> {
    let v = match serde_json::from_str::<Value>(out) {
        Ok(j) => j.get("subscriptionType").and_then(Value::as_str).map(String::from),
        Err(_) => Regex::new(r#""subscriptionType"\s*:\s*"([A-Za-z0-9_-]+)""#).ok()?.captures(out).map(|c| c[1].to_string()),
    }?;
    plan_ok(&v).then(|| v.to_lowercase())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusLineKind { Ours, Other, None }

/** Is Claude Code's statusLine ours (feeds the pet), someone else's (left alone) or absent. */
pub fn status_line_kind(settings_json: &str, is_pet: impl Fn(&str) -> bool) -> StatusLineKind {
    let Ok(j) = serde_json::from_str::<Value>(settings_json) else { return StatusLineKind::None };
    match j.get("statusLine") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => StatusLineKind::None,
        Some(sl) => if is_pet(sl.get("command").and_then(Value::as_str).unwrap_or("")) { StatusLineKind::Ours } else { StatusLineKind::Other },
    }
}

/** mtime of the usage file in ms (0 when missing): the bridge compares it on its tick instead of polling the content. */
pub fn usage_version(path: &std::path::Path) -> u128 {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    pub plan: Option<String>,
    pub updated_at: Option<i64>,
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub status_line: StatusLineKind,
    pub source: Option<&'static str>,
    pub live_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refreshing: Option<bool>,
    pub last_attempt_at: Option<i64>,
    pub last_error: Option<LiveErrorCode>,
}

pub struct UsageSource {
    pub path: PathBuf,
    pub settings_path: PathBuf,
    pub claude_path: Option<PathBuf>,
    pub live: Option<Box<dyn LiveSource + Send>>,
    pub is_pet_status_line: fn(&str) -> bool,
    plan: Option<String>,
    plan_at: Option<Instant>,
    plan_tried: Option<Instant>,
}

const PLAN_TTL: Duration = Duration::from_secs(6 * 3600);
const PLAN_RETRY: Duration = Duration::from_secs(10 * 60);

impl UsageSource {
    pub fn new(path: PathBuf, settings_path: PathBuf, claude_path: Option<PathBuf>, live: Option<Box<dyn LiveSource + Send>>, is_pet_status_line: fn(&str) -> bool) -> Self {
        UsageSource { path, settings_path, claude_path, live, is_pet_status_line, plan: None, plan_at: None, plan_tried: None }
    }

    /** starts one query for a user's click (false: too soon, one is running, or no live source) */
    pub fn refresh(&self) -> bool { self.live.as_ref().map_or(false, |l| l.refresh()) }

    /** changes whenever the file or the live query produced something new (also a failed attempt: staleness must show) */
    pub fn version(&self) -> String {
        let v = usage_version(&self.path);
        match &self.live { Some(l) => format!("{v}:{}", l.revision()), None => v.to_string() }
    }

    fn refresh_plan(&mut self) {
        let Some(claude) = self.claude_path.clone() else { return };
        if self.plan.is_some() && self.plan_at.map_or(false, |t| t.elapsed() < PLAN_TTL) { return; }
        if self.plan.is_none() && self.plan_tried.map_or(false, |t| t.elapsed() < PLAN_RETRY) { return; }
        self.plan_tried = Some(Instant::now());
        let Ok(mut child) = Command::new(claude).args(["auth", "status"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return };
        let mut out = child.stdout.take();
        let reader = std::thread::spawn(move || { let mut s = String::new(); if let Some(o) = out.as_mut() { let _ = o.take(1 << 16).read_to_string(&mut s); } s });
        let deadline = Instant::now() + Duration::from_secs(10);
        let ok = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st.success(),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                _ => { let _ = child.kill(); let _ = child.wait(); break false; }
            }
        };
        let text = reader.join().unwrap_or_default();
        if ok { if let Some(p) = plan_from_auth_status(&text) { self.plan = Some(p); self.plan_at = Some(Instant::now()); } }
    }

    pub fn read(&mut self) -> UsageInfo {
        let ls = self.live.as_ref().map(|l| l.state());
        // with the live query the plan comes with its answer; `claude auth status` is only the fallback
        if self.live.is_none() || (ls.as_ref().map_or(true, |s| s.data.as_ref().map_or(true, |d| d.plan.is_none()) && s.last_error.is_some())) { self.refresh_plan(); }
        let f = std::fs::read_to_string(&self.path).map(|s| parse_usage(&s)).unwrap_or_default();
        let status_line = std::fs::read_to_string(&self.settings_path).map_or(StatusLineKind::None, |s| status_line_kind(&s, self.is_pet_status_line));
        let file_ok = f.updated_at.is_some() && (f.five_hour.is_some() || f.seven_day.is_some());
        let live = ls.as_ref().and_then(|s| s.data.as_ref());
        // one source wholesale (never mix windows of two): the one obtained later
        let use_live = live.map_or(false, |l| !file_ok || l.updated_at >= f.updated_at.unwrap_or(0));
        // per window: a stale report (same reset time, lower usage) never replaces a current one, whichever source it came from
        let (updated_at, five_hour, seven_day) = if live.is_some() || file_ok {
            (Some(live.map_or(0, |l| l.updated_at).max(if file_ok { f.updated_at.unwrap_or(0) } else { 0 })),
             freshest_window(live.and_then(|l| l.five_hour), if file_ok { f.five_hour } else { None }),
             freshest_window(live.and_then(|l| l.seven_day), if file_ok { f.seven_day } else { None }))
        } else { (None, None, None) };
        UsageInfo {
            plan: live.and_then(|l| l.plan.clone()).or_else(|| self.plan.clone()),
            updated_at, five_hour, seven_day, status_line,
            source: if use_live { Some("live") } else if file_ok { Some("statusline") } else { None },
            live_active: self.live.as_ref().map_or(false, |l| l.periodic()),
            refreshing: ls.as_ref().filter(|s| s.running).map(|_| true),
            last_attempt_at: ls.as_ref().and_then(|s| s.last_attempt_at),
            last_error: ls.as_ref().and_then(|s| s.last_error),
        }
    }
}

/** `YYYYMMDDHHMMSS` (UTC) of a time in ms: for backup file names. */
pub fn compact_utc(ms: i64) -> String {
    let (days, secs) = (ms.div_euclid(86_400_000), ms.div_euclid(1000).rem_euclid(86_400));
    // civil date from days since 1970-01-01 (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}{m:02}{d:02}{:02}{:02}{:02}", secs / 3600, secs % 3600 / 60, secs % 60)
}

pub fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
    use std::sync::Arc;

    fn dir(n: &str) -> PathBuf { let d = std::env::temp_dir().join(format!("ccpet-us-{}-{n}", std::process::id())); std::fs::create_dir_all(&d).unwrap(); d }
    fn pet(c: &str) -> bool { c.contains("pet-statusline.mjs") || c.contains("ccpet-hook") }
    fn w(p: f64, r: f64) -> Option<UsageWindow> { Some(UsageWindow { used_pct: p, resets_at: r }) }

    #[test]
    fn compact_time() { assert_eq!(compact_utc(1767261630500), "20260101100030"); assert_eq!(compact_utc(0), "19700101000000"); }

    #[test]
    fn parses_clamps_and_rejects() {
        let u = parse_usage(r#"{"updatedAt":1000,"five_hour":{"used_percentage":23.5,"resets_at":5},"seven_day":{"used_percentage":130,"resets_at":9}}"#);
        assert_eq!(u, FileUsage { updated_at: Some(1000), five_hour: w(23.5, 5.0), seven_day: w(100.0, 9.0) });
        assert_eq!(parse_usage(r#"{"updatedAt":1,"seven_day":{"used_percentage":"x","resets_at":9}}"#).seven_day, None);
        assert_eq!(parse_usage("not json"), FileUsage::default());
        assert_eq!(parse_usage("{}"), FileUsage::default());
    }

    #[test]
    fn plan_and_status_line() {
        assert_eq!(plan_from_auth_status(r#"{"email":"a@b.c","subscriptionType":"pro"}"#).as_deref(), Some("pro"));
        assert_eq!(plan_from_auth_status(r#"{"subscriptionType":"Max"}"#).as_deref(), Some("max"));
        assert_eq!(plan_from_auth_status(r#"{"subscriptionType":"<script>"}"#), None);
        assert_eq!(plan_from_auth_status(""), None);
        assert_eq!(plan_from_auth_status(r#"junk "subscriptionType": "pro" junk"#).as_deref(), Some("pro"));
        assert_eq!(status_line_kind(r#"{"statusLine":{"command":"node /x/pet-statusline.mjs"}}"#, pet), StatusLineKind::Ours);
        assert_eq!(status_line_kind(r#"{"statusLine":{"command":"my-line.sh"}}"#, pet), StatusLineKind::Other);
        assert_eq!(status_line_kind(r#"{"model":"opus"}"#, pet), StatusLineKind::None);
        assert_eq!(status_line_kind("broken", pet), StatusLineKind::None);
    }

    struct Fake { st: LiveState, rev: Arc<AtomicU64>, periodic: bool }
    impl LiveSource for Fake {
        fn state(&self) -> LiveState { self.st.clone() }
        fn revision(&self) -> u64 { self.rev.load(SeqCst) }
        fn periodic(&self) -> bool { self.periodic }
        fn refresh(&self) -> bool { true }
    }
    fn live(over: impl FnOnce(&mut LiveState)) -> LiveState {
        let mut s = LiveState { data: Some(LiveData { plan: Some("pro".into()), five_hour: w(64.0, 9.0), seven_day: w(60.0, 99.0), updated_at: 5000 }), last_attempt_at: Some(5000), ..Default::default() };
        over(&mut s); s
    }
    fn src(n: &str, st: Option<LiveState>, file: Option<&str>) -> UsageSource {
        let d = dir(n);
        let (p, s) = (d.join("usage.json"), d.join("settings.json"));
        let _ = std::fs::remove_file(&p);
        std::fs::write(&s, "{}").unwrap();
        if let Some(f) = file { std::fs::write(&p, f).unwrap(); }
        let l = st.map(|st| Box::new(Fake { st, rev: Arc::new(AtomicU64::new(3)), periodic: true }) as Box<dyn LiveSource + Send>);
        UsageSource::new(p, s, None, l, pet)
    }

    #[test]
    fn file_only_and_empty() {
        let mut s = src("a", None, None);
        let r = s.read();
        assert_eq!((r.updated_at, r.source, r.live_active, r.plan), (None, None, false, None));
        std::fs::write(&s.path, r#"{"updatedAt":7,"five_hour":{"used_percentage":10,"resets_at":99}}"#).unwrap();
        assert!(usage_version(&s.path) > 0);
        let r = s.read();
        assert_eq!((r.updated_at, r.five_hour, r.seven_day, r.source), (Some(7), w(10.0, 99.0), None, Some("statusline")));
    }

    #[test]
    fn live_data_and_per_window_freshness() {
        let r = src("b", Some(live(|_| {})), None).read();
        assert_eq!((r.plan.as_deref(), r.source, r.live_active, r.five_hour), (Some("pro"), Some("live"), true, w(64.0, 9.0)));
        // same window, higher usage in the file wins; the week only the live query knows
        let same = r#"{"updatedAt":4000,"five_hour":{"used_percentage":70,"resets_at":9}}"#;
        let r = src("c", Some(live(|_| {})), Some(same)).read();
        assert_eq!((r.updated_at, r.five_hour, r.seven_day), (Some(5000), w(70.0, 9.0), w(60.0, 99.0)));
        // a newer file with stale (lower) numbers never rolls the live ones back
        let stale = r#"{"updatedAt":9000,"five_hour":{"used_percentage":20,"resets_at":9},"seven_day":{"used_percentage":50,"resets_at":99}}"#;
        let r = src("d", Some(live(|_| {})), Some(stale)).read();
        assert_eq!((r.updated_at, r.five_hour, r.seven_day), (Some(9000), w(64.0, 9.0), w(60.0, 99.0)));
        // an earlier window in the file loses to the live one
        let old = r#"{"updatedAt":9000,"five_hour":{"used_percentage":90,"resets_at":8}}"#;
        assert_eq!(src("e", Some(live(|_| {})), Some(old)).read().five_hour, w(64.0, 9.0));
    }

    #[test]
    fn failures_and_bookkeeping() {
        let r = src("f", Some(live(|s| { s.last_error = Some(LiveErrorCode::Timeout); s.last_attempt_at = Some(8000); })), None).read();
        assert_eq!((r.source, r.updated_at, r.last_error, r.last_attempt_at), (Some("live"), Some(5000), Some(LiveErrorCode::Timeout), Some(8000)));
        let r = src("g", Some(LiveState { running: true, ..Default::default() }), None).read();
        assert_eq!((r.updated_at, r.source, r.live_active, r.refreshing), (None, None, true, Some(true)));
        let v = src("h", Some(live(|_| {})), None);
        assert!(v.version().ends_with(":3"));
        let json = serde_json::to_string(&src("i", None, None).read()).unwrap();
        assert!(json.contains(r#""statusLine":"none""#) && json.contains(r#""lastError":null"#) && !json.contains("refreshing"), "{json}");
    }
}
