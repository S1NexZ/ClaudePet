//! Sessions that are probably running although no hook told us: recently written transcripts (adopt.ts).

use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq)]
pub struct Running { pub id: String, pub cwd: String, pub source: Option<String>, pub path: PathBuf, pub mtime: i64 }

/** The head of a transcript: where it ran and which Claude Code front end wrote it. */
fn head_of(path: &std::path::Path) -> (String, Option<String>) {
    let (mut cwd, mut source) = (String::new(), None);
    let mut buf = Vec::new();
    if std::fs::File::open(path).and_then(|f| f.take(131072).read_to_end(&mut buf)).is_err() { return (cwd, source); }
    for line in String::from_utf8_lossy(&buf).split('\n').take(60) {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        if source.is_none() { source = e.get("entrypoint").and_then(Value::as_str).map(String::from); }
        if cwd.is_empty() { if let Some(c) = e.get("cwd").and_then(Value::as_str) { cwd = c.to_string(); } }
        if !cwd.is_empty() && source.is_some() { break; }
    }
    (cwd, source)
}

/** how far back the reload button looks for a session that went quiet (the automatic scan only takes the last 10 minutes) */
pub const RESCAN_MS: i64 = 6 * 60 * 60_000;

/** Claude Code keeps one file per session process in `~/.claude/sessions/<pid>.json` and does not always remove it: only those whose process
 * is alive (`alive`) count. None when there is no such folder or nothing readable in it (an older Claude Code): the caller falls back to transcripts alone.
 * shortcut: a reused pid can keep a dead session "alive" until the file is replaced; fine for a list the user can dismiss. */
pub fn live_ids(sessions_dir: &std::path::Path, alive: &dyn Fn(u32) -> bool) -> Option<std::collections::HashSet<String>> {
    let (mut any, mut live) = (false, std::collections::HashSet::new());
    for f in std::fs::read_dir(sessions_dir).ok()?.flatten() {
        let path = f.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        let Some(v) = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { continue };
        let (Some(pid), Some(id)) = (v.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()), v.get("sessionId").and_then(Value::as_str)) else { continue };
        any = true;
        if v.get("entrypoint").and_then(Value::as_str).map_or(false, |e| e.starts_with("sdk")) { continue; } // SDK clients are not the user's sessions
        if alive(pid) { live.insert(id.to_string()); }
    }
    any.then_some(live)
}

/** Transcripts written to in the last `max_age_ms`, newest first; sessions run by SDK clients (`sdk-cli`) are skipped.
 * With `live` (see `live_ids`) only those sessions are taken, however long ago they wrote: a running one that is quiet is still running. */
pub fn find_running(projects_dir: &std::path::Path, now_ms: i64, max_age_ms: i64, live: Option<&std::collections::HashSet<String>>) -> Vec<Running> {
    let mut out = vec![];
    let Ok(dirs) = std::fs::read_dir(projects_dir) else { return out };
    for d in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")).map(String::from) else { continue };
            let Some(m) = f.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64) else { continue };
            match live { Some(l) => if !l.contains(&name) { continue; }, None => if now_ms - m > max_age_ms { continue; } }
            let (cwd, source) = head_of(&path);
            if cwd.is_empty() || source.as_deref() == Some("sdk-cli") { continue; }
            out.push(Running { id: name, cwd, source, path, mtime: m });
        }
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_recent_non_sdk_sessions() {
        let d = std::env::temp_dir().join(format!("ccpet-adopt-{}", std::process::id()));
        let p = d.join("-proj");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("a.jsonl"), "{\"type\":\"mode\"}\n{\"cwd\":\"/w/a\",\"entrypoint\":\"cli\"}\n").unwrap();
        std::fs::write(p.join("b.jsonl"), "{\"cwd\":\"/w/b\",\"entrypoint\":\"sdk-cli\"}\n").unwrap();
        std::fs::write(p.join("c.jsonl"), "{\"type\":\"mode\"}\n").unwrap();
        std::fs::write(p.join("d.txt"), "{\"cwd\":\"/w/d\"}\n").unwrap();
        let now = crate::usage::now_ms();
        let r = find_running(&d, now, 60_000, None);
        assert_eq!(r.iter().map(|x| (x.id.as_str(), x.cwd.as_str(), x.source.as_deref())).collect::<Vec<_>>(), vec![("a", "/w/a", Some("cli"))]);
        assert!(find_running(&d, now + 3_600_000, 60_000, None).is_empty(), "too old");
        assert!(find_running(&d.join("missing"), now, 60_000, None).is_empty());
    }

    #[test]
    fn only_sessions_with_a_live_process_are_taken() {
        let d = std::env::temp_dir().join(format!("ccpet-live-{}", std::process::id()));
        let (p, s) = (d.join("projects").join("-proj"), d.join("sessions"));
        std::fs::create_dir_all(&p).unwrap();
        std::fs::create_dir_all(&s).unwrap();
        for id in ["live", "dead", "sdk"] { std::fs::write(p.join(format!("{id}.jsonl")), format!("{{\"cwd\":\"/w/{id}\",\"entrypoint\":\"cli\"}}\n")).unwrap(); }
        std::fs::write(s.join("10.json"), r#"{"pid":10,"sessionId":"live","entrypoint":"cli"}"#).unwrap();
        std::fs::write(s.join("11.json"), r#"{"pid":11,"sessionId":"dead","entrypoint":"cli"}"#).unwrap();
        std::fs::write(s.join("12.json"), r#"{"pid":12,"sessionId":"sdk","entrypoint":"sdk-cli"}"#).unwrap();
        std::fs::write(s.join("junk.json"), "not json").unwrap();
        let live = live_ids(&s, &|pid| pid != 11).unwrap();
        assert_eq!(live, ["live".to_string()].into_iter().collect());
        let now = crate::usage::now_ms();
        // a quiet but running session is found whatever the age of its transcript
        let r = find_running(&d.join("projects"), now + 86_400_000, 60_000, Some(&live));
        assert_eq!(r.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["live"]);
        assert!(live_ids(&d.join("missing"), &|_| true).is_none());
    }
}
