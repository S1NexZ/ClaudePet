//! "Why don't I see my session?": a plain-text connection report (port of ui/src/diagnostics.ts).
//! It never contains the user name (paths are masked), hook tokens or e-mail addresses.
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostDiag {
    pub id: String,
    pub distro: Option<String>,
    pub up: bool,
    pub events: bool,
    pub mailbox: bool,
    pub permissions: bool,
    pub status_line: Option<String>,
    pub last_event_at: Option<f64>,
    pub sessions: usize,
    pub sources: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiagData {
    pub version: String,
    pub os: String,
    /// Unix ms.
    pub now: f64,
    pub user: String,
    pub hosts: Vec<HostDiag>,
    pub helper: bool,
    pub wrapper: Option<String>,
    pub policy: Option<String>,
    pub desktop_chats: usize,
    pub new_chat_in: String,
    pub sdk_chats: bool,
}

fn is_word(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' }
fn eq_ci(a: char, b: char) -> bool { a == b || a.to_lowercase().eq(b.to_lowercase()) }
fn is_sep(c: char) -> bool { c == '/' || c == '\\' }

/// Matches `lit` (case-insensitive) at `i`; returns the index after it.
fn lit_at(t: &[char], i: usize, lit: &str) -> Option<usize> {
    let mut j = i;
    for c in lit.chars() {
        if j >= t.len() || !eq_ci(t[j], c) { return None; }
        j += 1;
    }
    Some(j)
}

/// `/<prefix>/<hex{16,}>` -> `/<prefix>/<token>`; `need_slash` = the hex run must end with `/` (kept).
fn mask_tokens(s: &str, prefix: &str, need_slash: bool) -> String {
    let t: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < t.len() {
        if let Some(mut j) = lit_at(&t, i, prefix) {
            let st = j;
            while j < t.len() && t[j].is_ascii_hexdigit() { j += 1; }
            if j - st >= 16 && (!need_slash || t.get(j) == Some(&'/')) {
                out.push_str(prefix);
                out.push_str("<token>");
                i = j;
                continue;
            }
        }
        out.push(t[i]);
        i += 1;
    }
    out
}

/// `[\w.+-]+@[\w-]+\.[\w.-]+` -> `<email>`
fn mask_emails(s: &str) -> String {
    let t: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < t.len() {
        let Some(a) = (i..t.len()).find(|&k| t[k] == '@') else { break };
        let mut l = a;
        while l > i && (is_word(t[l - 1]) || matches!(t[l - 1], '.' | '+' | '-')) { l -= 1; }
        let mut j = a + 1;
        while j < t.len() && (is_word(t[j]) || t[j] == '-') { j += 1; }
        let ok = l < a && j > a + 1 && t.get(j) == Some(&'.') && {
            let mut k = j + 1;
            while k < t.len() && (is_word(t[k]) || t[k] == '.' || t[k] == '-') { k += 1; }
            if k > j + 1 { j = k; true } else { false }
        };
        if ok {
            out.extend(&t[i..l]);
            out.push_str("<email>");
            i = j;
        } else {
            out.extend(&t[i..=a]);
            i = a + 1;
        }
    }
    out.extend(&t[i.min(t.len())..]);
    out
}

pub fn redact(text: &str, names: &[String]) -> String {
    let mut s = mask_emails(&mask_tokens(&mask_tokens(text, "/hook/", true), "/mailbox/", false));
    for n in names.iter().filter(|n| n.encode_utf16().count() > 1) {
        let t: Vec<char> = s.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < t.len() {
            if is_sep(t[i]) {
                let m = lit_at(&t, i + 1, "users").or_else(|| lit_at(&t, i + 1, "home"))
                    .filter(|&j| t.get(j).is_some_and(|&c| is_sep(c)))
                    .and_then(|j| lit_at(&t, j + 1, n).map(|e| (j, e)))
                    .filter(|&(_, e)| e == t.len() || is_sep(t[e]));
                if let Some((j, e)) = m {
                    out.extend(&t[i..=j]);
                    out.push_str("<user>");
                    i = e;
                    continue;
                }
            }
            out.push(t[i]);
            i += 1;
        }
        s = out;
    }
    s
}

/// 'windows' | 'wsl' | 'wsl:<distro>' (a session's `hostId`, else derived from `host`).
pub fn host_id_of(s: &Value) -> String {
    match s.get("hostId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None if s.get("host").and_then(Value::as_str) == Some("windows") => "windows".into(),
        None => "wsl".into(),
    }
}

/// Newest hook-driven activity per host id.
pub fn last_event_by_host(sessions: &[Value]) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for s in sessions {
        let at = s.get("lastEventAt").and_then(Value::as_f64).unwrap_or(0.0);
        let e = out.entry(host_id_of(s)).or_insert(0.0_f64);
        *e = e.max(at);
    }
    out
}

pub fn ago(at: Option<f64>, now: f64) -> Option<String> {
    let at = at?;
    let s = ((now - at) / 1000.0 + 0.5).floor().max(0.0); // JS Math.round: half up
    Some(if s < 60.0 {
        format!("{} s", s as i64)
    } else if s < 3600.0 {
        format!("{} min", (s / 60.0 + 0.5).floor() as i64)
    } else {
        format!("{} h", (s / 3600.0 + 0.5).floor() as i64)
    })
}

fn yn(b: bool) -> &'static str { if b { "yes" } else { "no" } }

pub fn format_diagnostics(d: &DiagData) -> String {
    let mut lines: Vec<String> = vec![format!("ccPet {} · {}", d.version, d.os), String::new(), "Connections:".into()];
    for h in &d.hosts {
        let name = match h.distro.as_deref() { Some(x) if !x.is_empty() => format!("{} ({})", h.id, x), _ => h.id.clone() };
        let err = h.error.as_deref().filter(|e| !e.is_empty());
        if !h.up {
            lines.push(format!("- {}: DOWN{}", name, err.map(|e| format!(" ({e})")).unwrap_or_default()));
            continue;
        }
        let sl = h.status_line.as_deref().filter(|x| !x.is_empty()).map(|x| format!(", status line {x}")).unwrap_or_default();
        let last = ago(h.last_event_at, d.now).map(|x| format!("last event {x} ago")).unwrap_or_else(|| "no events yet".into());
        let src = if h.sources.is_empty() { String::new() } else { format!(" ({})", h.sources.join(", ")) };
        lines.push(format!(
            "- {}: up, events {}, messages {}, permissions {}{}, {}, sessions {}{}{}",
            name, yn(h.events), yn(h.mailbox), yn(h.permissions), sl, last, h.sessions, src,
            err.map(|e| format!(", error: {e}")).unwrap_or_default()
        ));
    }
    lines.push(String::new());
    lines.push("Windows:".into());
    lines.push(format!("- pet-helper.exe: {}", if d.helper { "found" } else { "MISSING (no messages, Stop or typing for Windows sessions)" }));
    let pol = d.policy.as_deref().filter(|x| !x.is_empty()).map(|x| format!(", execution policy {x}")).unwrap_or_default();
    lines.push(format!("- PowerShell wrapper: {}{}", d.wrapper.as_deref().unwrap_or("n/a"), pol));
    lines.push(format!("- desktop app chats found: {}", d.desktop_chats));
    lines.push(format!("- new chats start in: {}; Agent SDK: {}", d.new_chat_in, if d.sdk_chats { "on" } else { "off" }));
    lines.push(String::new());
    lines.push("Hints:".into());
    let mut hints: Vec<String> = vec![];
    for h in &d.hosts {
        if !h.up {
            hints.push(format!("{}: the pet cannot reach it (WSL not running, or the port is busy).", h.id));
        } else if !h.events {
            hints.push(format!("{}: hooks are not connected — Settings → Connections → Connect, then restart open Claude Code terminals.", h.id));
        } else if h.last_event_at.is_none() {
            hints.push(format!("{}: hooks are connected but no session has reported yet — start or restart a Claude Code session there.", h.id));
        }
    }
    if hints.is_empty() {
        hints.push("Everything looks connected. A session started before the hooks were connected shows up after its next message.".into());
    }
    lines.extend(hints.into_iter().map(|x| format!("- {x}")));
    redact(&lines.join("\n"), &[d.user.clone()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn r(t: &str, n: &[&str]) -> String { redact(t, &n.iter().map(|s| s.to_string()).collect::<Vec<_>>()) }

    #[test]
    fn redacts_user_and_tokens() {
        assert_eq!(r("C:\\Users\\vasya\\AppData\\x", &["vasya"]), "C:\\Users\\<user>\\AppData\\x");
        assert_eq!(r("/home/vasya/.claude and /mnt/c/Users/vasya/p", &["vasya"]), "/home/<user>/.claude and /mnt/c/Users/<user>/p");
        assert_eq!(r("http://127.0.0.1:47821/hook/7bf3cefbb02c9546d1cde81da9f38555/Stop", &[]), "http://127.0.0.1:47821/hook/<token>/Stop");
        assert_eq!(r("http://x/mailbox/7bf3cefbb02c9546d1cde81da9f38555?pty=1", &[]), "http://x/mailbox/<token>?pty=1");
        assert_eq!(r("mail me at a.b@example.com", &[]), "mail me at <email>");
        assert_eq!(r("x@y and /home/vasyaz/q /home/VASYA", &["vasya"]), "x@y and /home/vasyaz/q /home/<user>");
    }

    #[test]
    fn last_event_per_host() {
        let s = |h: &str, at: u64| json!({"host": if h == "windows" { "windows" } else { "wsl" }, "hostId": h, "lastEventAt": at});
        let m = last_event_by_host(&[s("wsl", 5), s("wsl", 9), s("windows", 3), s("wsl:Debian", 7)]);
        assert_eq!(m, BTreeMap::from([("wsl".to_string(), 9.0), ("windows".to_string(), 3.0), ("wsl:Debian".to_string(), 7.0)]));
        assert_eq!(host_id_of(&json!({"host": "windows"})), "windows");
        assert_eq!(host_id_of(&json!({})), "wsl");
    }

    #[test]
    fn ago_human() {
        assert_eq!(ago(None, 0.0), None);
        assert_eq!(ago(Some(1000.0), 31_000.0).unwrap(), "30 s");
        assert_eq!(ago(Some(0.0), 300_000.0).unwrap(), "5 min");
        assert_eq!(ago(Some(0.0), 3.0 * 3_600_000.0).unwrap(), "3 h");
    }

    #[test]
    fn report_lists_checks_without_user_name() {
        let d = DiagData {
            version: "0.5.0".into(), os: "Windows 10.0.26100".into(), now: 600_000.0, user: "vasya".into(),
            hosts: vec![
                HostDiag { id: "windows".into(), up: true, events: true, mailbox: true, status_line: Some("none".into()), last_event_at: Some(540_000.0), sessions: 2, sources: vec!["claude-desktop".into(), "cli".into()], ..Default::default() },
                HostDiag { id: "wsl".into(), distro: Some("Ubuntu".into()), error: Some("cannot read /home/vasya/.claude/settings.json".into()), ..Default::default() },
            ],
            helper: true, wrapper: Some("none".into()), policy: Some("RemoteSigned".into()), desktop_chats: 3, new_chat_in: "wsl".into(), sdk_chats: false,
        };
        let t = format_diagnostics(&d);
        assert!(t.contains("ccPet 0.5.0"));
        assert!(t.contains("- windows: up, events yes, messages yes, permissions no, status line none, last event 1 min ago, sessions 2 (claude-desktop, cli)"));
        assert!(t.contains("- wsl (Ubuntu): DOWN (cannot read /home/<user>/.claude/settings.json)"));
        assert!(!t.contains("vasya"));
        assert!(t.contains("desktop app chats found: 3"));
        assert!(t.contains("PowerShell wrapper: none, execution policy RemoteSigned"));
    }
}
