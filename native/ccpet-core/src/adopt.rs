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

/** Transcripts written to in the last `max_age_ms`, newest first; sessions run by SDK clients (`sdk-cli`) are skipped. */
pub fn find_running(projects_dir: &std::path::Path, now_ms: i64, max_age_ms: i64) -> Vec<Running> {
    let mut out = vec![];
    let Ok(dirs) = std::fs::read_dir(projects_dir) else { return out };
    for d in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")).map(String::from) else { continue };
            let Some(m) = f.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64) else { continue };
            if now_ms - m > max_age_ms { continue; }
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
        let r = find_running(&d, now, 60_000);
        assert_eq!(r.iter().map(|x| (x.id.as_str(), x.cwd.as_str(), x.source.as_deref())).collect::<Vec<_>>(), vec![("a", "/w/a", Some("cli"))]);
        assert!(find_running(&d, now + 3_600_000, 60_000).is_empty(), "too old");
        assert!(find_running(&d.join("missing"), now, 60_000).is_empty());
    }
}
