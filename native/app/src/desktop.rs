//! The Claude desktop app's local session registry (port of ui/src/hub/desktopRegistry.ts) and the pure link helpers of
//! ui/src/desktopSend.ts. The app keeps one JSON file per Code session (`claude-code-sessions/<account>/<org>/local_<id>.json`);
//! only the desktop id, the CLI session ids, the chat title and the archive flag are read, everything else is dropped at once.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopEntry {
    pub desktop_id: String,
    pub cli_ids: Vec<String>,
    pub title: String,
    pub archived: bool,
}

fn id_ok(s: &str, max: usize, extra: &[char]) -> bool {
    (1..=max).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

/// what the app's deep link accepts as a session id: `local_[A-Za-z0-9-]{1,64}`
fn desktop_id_ok(s: &str) -> bool {
    s.strip_prefix("local_").is_some_and(|r| id_ok(r, 64, &['-']))
}

fn cli_id_ok(s: &str) -> bool {
    id_ok(s, 100, &['_', '-'])
}

pub fn parse_entry(text: &str) -> Option<DesktopEntry> {
    let j: Value = serde_json::from_str(text).ok()?;
    let desktop_id = j.get("sessionId")?.as_str().filter(|s| desktop_id_ok(s))?.to_string();
    let mut cli_ids: Vec<String> = Vec::new();
    for k in ["cliSessionId", "lastAssistantCliSessionId"] {
        if let Some(s) = j.get(k).and_then(Value::as_str) {
            if cli_id_ok(s) && !cli_ids.iter().any(|x| x == s) {
                cli_ids.push(s.to_string());
            }
        }
    }
    if cli_ids.is_empty() {
        return None;
    }
    let title = j
        .get("title")
        .and_then(Value::as_str)
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect())
        .unwrap_or_default();
    Some(DesktopEntry { desktop_id, cli_ids, title, archived: j.get("isArchived") == Some(&Value::Bool(true)) })
}

/// Registry folders: the Store (MSIX) app keeps its data in %LOCALAPPDATA%\Claude-Data\claude_<publisher>, the classic install in %APPDATA%\Claude.
pub fn find_registry_roots(local_app_data: &str, app_data: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(Path::new(local_app_data).join("Claude-Data")) {
        let mut names: Vec<String> = rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.starts_with("claude_")).collect();
        names.sort();
        for n in names {
            let r = Path::new(local_app_data).join("Claude-Data").join(n).join("claude-code-sessions");
            if r.exists() {
                out.push(r);
            }
        }
    }
    let classic = Path::new(app_data).join("Claude").join("claude-code-sessions");
    if classic.exists() {
        out.push(classic);
    }
    out
}

fn subdirs(p: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(p).map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect()).unwrap_or_default();
    v.sort();
    v
}

fn entry_file_name(f: &str) -> bool {
    f.strip_prefix("local_").and_then(|r| r.strip_suffix(".json")).is_some_and(|r| id_ok(r, 64, &['-']))
}

type Roots = Box<dyn Fn() -> Vec<PathBuf> + Send + Sync>;
type OnRead = Box<dyn Fn(&Path) + Send + Sync>;

/// Reads the registry; each file is parsed again only when its mtime or size changed.
pub struct DesktopRegistry {
    roots: Roots,
    on_read: Option<OnRead>,
    cache: HashMap<PathBuf, (String, Option<DesktopEntry>)>,
}

impl DesktopRegistry {
    pub fn new(roots: impl Fn() -> Vec<PathBuf> + Send + Sync + 'static) -> Self {
        Self { roots: Box::new(roots), on_read: None, cache: HashMap::new() }
    }

    /// test hook (TS `onRead`): called before each file is read
    pub fn with_on_read(mut self, f: impl Fn(&Path) + Send + Sync + 'static) -> Self {
        self.on_read = Some(Box::new(f));
        self
    }

    pub fn by_cli_id(&mut self) -> HashMap<String, DesktopEntry> {
        let mut map = HashMap::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        for root in (self.roots)() {
            for acct in subdirs(&root) {
                for org in subdirs(&acct) {
                    let Ok(rd) = fs::read_dir(&org) else { continue };
                    let mut files: Vec<String> = rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|f| entry_file_name(f)).collect();
                    files.sort();
                    for f in files {
                        let file = org.join(&f);
                        seen.insert(file.clone());
                        let Ok(md) = fs::metadata(&file) else { continue };
                        let nanos = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
                        let key = format!("{nanos}:{}", md.len());
                        if self.cache.get(&file).map(|c| c.0 != key).unwrap_or(true) {
                            if let Some(cb) = &self.on_read {
                                cb(&file);
                            }
                            // a file being written reads as None: the cache key still changes with the next write
                            let entry = fs::read_to_string(&file).ok().and_then(|t| parse_entry(&t));
                            self.cache.insert(file.clone(), (key, entry));
                        }
                        if let Some(e) = &self.cache[&file].1 {
                            for id in &e.cli_ids {
                                map.insert(id.clone(), e.clone());
                            }
                        }
                    }
                }
            }
        }
        self.cache.retain(|k, _| seen.contains(k));
        map
    }
}

/// Desktop sessions show their chat title and remember the desktop id; sessions archived in the app are left out.
pub fn decorate_desktop(sessions: Vec<Value>, by_cli: &HashMap<String, DesktopEntry>) -> Vec<Value> {
    let mut out = Vec::with_capacity(sessions.len());
    for mut s in sessions {
        let Some(e) = s.get("id").and_then(Value::as_str).and_then(|id| by_cli.get(id)) else {
            out.push(s);
            continue;
        };
        if e.archived {
            continue;
        }
        let project = if e.title.is_empty() { s.get("project").cloned().unwrap_or(Value::Null) } else { json!(e.title) };
        if let Some(o) = s.as_object_mut() {
            if !project.is_null() || o.contains_key("project") {
                o.insert("project".into(), project);
            }
            o.insert("desktopId".into(), json!(e.desktop_id));
        }
        out.push(s);
    }
    out
}

/// JS `encodeURIComponent`
fn encode_uri_component(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// claude://code/new with the text and the folder: the app opens a new chat with the prompt filled in (it does not send it).
pub fn new_chat_link(folder: &str, text: &str) -> Option<String> {
    let b = folder.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\')
        .then(|| format!("claude://code/new?q={}&folder={}", encode_uri_component(text), encode_uri_component(folder)))
}

/// Only a claude:// link of the chat itself is ever opened.
pub fn chat_link(desktop_id: &str) -> Option<String> {
    let ok = desktop_id.strip_prefix("local_").is_some_and(|r| (8..=64).contains(&r.len()) && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    ok.then(|| format!("claude://code/continue?session={}", encode_uri_component(desktop_id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    fn tmp() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("dreg-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn entry(o: Value) -> String {
        let mut b = json!({"sessionId": "local_ab-1", "cliSessionId": "c1", "title": "Тест", "isArchived": false, "lastActivityAt": 5, "cwd": "C:\\secret", "postTurnSummary": "private text"});
        for (k, v) in o.as_object().unwrap() {
            if v.is_null() { b.as_object_mut().unwrap().remove(k); } else { b[k] = v.clone(); }
        }
        b.to_string()
    }

    #[test]
    fn keeps_only_the_wanted_fields() {
        let e = parse_entry(&entry(json!({"lastAssistantCliSessionId": "c2"}))).unwrap();
        assert_eq!(e, DesktopEntry { desktop_id: "local_ab-1".into(), cli_ids: vec!["c1".into(), "c2".into()], title: "Тест".into(), archived: false });
        assert!(!format!("{e:?}").contains("private"));
    }

    #[test]
    fn rejects_broken_or_foreign_entries() {
        assert!(parse_entry("{nope").is_none());
        assert!(parse_entry(&entry(json!({"sessionId": "local_../../x"}))).is_none());
        assert!(parse_entry(&entry(json!({"sessionId": "cse_1"}))).is_none());
        assert!(parse_entry(&entry(json!({"cliSessionId": null}))).is_none());
    }

    #[test]
    fn long_title_is_one_line() {
        let t = format!("a\nb{}", "x".repeat(300));
        let want: String = format!("a b{}", "x".repeat(300)).chars().take(120).collect();
        assert_eq!(parse_entry(&entry(json!({"title": t}))).unwrap().title, want);
    }

    #[test]
    fn finds_store_and_classic_roots() {
        let (local, roaming) = (tmp(), tmp());
        let a = local.join("Claude-Data").join("claude_pzs8").join("claude-code-sessions");
        let b = roaming.join("Claude").join("claude-code-sessions");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        assert_eq!(find_registry_roots(local.to_str().unwrap(), roaming.to_str().unwrap()), vec![a, b]);
        assert!(find_registry_roots(tmp().to_str().unwrap(), tmp().to_str().unwrap()).is_empty());
    }

    #[test]
    fn reads_two_levels_deep_and_rereads_only_changed_files() {
        let root = tmp();
        let dir = root.join("acct").join("org");
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("local_ab-1.json");
        fs::write(&f, entry(json!({}))).unwrap();
        fs::write(dir.join("other.json"), entry(json!({"sessionId": "local_zz", "cliSessionId": "zz"}))).unwrap();
        let reads = Arc::new(AtomicUsize::new(0));
        let r2 = reads.clone();
        let r = root.clone();
        let mut reg = DesktopRegistry::new(move || vec![r.clone()]).with_on_read(move |_| { r2.fetch_add(1, Ordering::SeqCst); });
        assert_eq!(reg.by_cli_id()["c1"].title, "Тест");
        assert!(!reg.by_cli_id().contains_key("zz"));
        reg.by_cli_id();
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        fs::write(&f, entry(json!({"title": "Новое имя"}))).unwrap();
        fs::File::options().write(true).open(&f).unwrap().set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
        assert_eq!(reg.by_cli_id()["c1"].title, "Новое имя");
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn decorates_titles_hides_archived_leaves_others() {
        let mut map = HashMap::new();
        map.insert("c1".to_string(), DesktopEntry { desktop_id: "local_1".into(), cli_ids: vec!["c1".into()], title: "Кто ты?".into(), archived: false });
        map.insert("c2".to_string(), DesktopEntry { desktop_id: "local_2".into(), cli_ids: vec!["c2".into()], title: "Старый".into(), archived: true });
        let s = |id: &str| json!({"id": id, "project": "scratch-2026"});
        let out = decorate_desktop(vec![s("c1"), s("c2"), s("t1")], &map);
        assert_eq!(out, vec![json!({"id": "c1", "project": "Кто ты?", "desktopId": "local_1"}), s("t1")]);
    }

    #[test]
    fn links() {
        assert_eq!(chat_link("local_ab12cd34-ef56").as_deref(), Some("claude://code/continue?session=local_ab12cd34-ef56"));
        assert_eq!(chat_link("local_x&evil=1"), None);
        assert_eq!(chat_link("../etc"), None);
        assert_eq!(
            new_chat_link("C:\\Proj\\a b", "привет & пока").as_deref(),
            Some("claude://code/new?q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82%20%26%20%D0%BF%D0%BE%D0%BA%D0%B0&folder=C%3A%5CProj%5Ca%20b")
        );
        assert_eq!(new_chat_link("/home/me/proj", "hi"), None);
    }
}
