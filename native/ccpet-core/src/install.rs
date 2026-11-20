//! Changes to `~/.claude/settings.json`: our hooks, the mailbox waiter, the statusLine (installHooks.ts, hookConfig.ts, installStatusLine.ts).
//! Every change is planned first (new settings + a +/- diff); nothing is written without `write_settings`, which keeps a `.bak`.
//! Entries are recognised by what they run, never by extra keys, so the user's own hooks stay untouched.

use serde_json::{json, Map, Value};
use std::path::Path;

pub const HOOK_EVENTS: [&str; 9] = [
    "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification",
    "Stop", "SubagentStop", "SessionStart", "SessionEnd",
];
const CHAIN: &str = " --chain ";

pub fn line_diff(a: &[String], b: &[String]) -> String {
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() { for j in (0..m).rev() {
        dp[i][j] = if a[i] == b[j] { dp[i + 1][j + 1] + 1 } else { dp[i + 1][j].max(dp[i][j + 1]) };
    } }
    let (mut i, mut j) = (0, 0);
    let mut out: Vec<String> = vec![];
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] { i += 1; j += 1; }
        else if j < m && (i == n || dp[i][j + 1] >= dp[i + 1][j]) { out.push(format!("+ {}", b[j])); j += 1; }
        else { out.push(format!("- {}", a[i])); i += 1; }
    }
    out.join("\n")
}

fn pretty_lines(v: &Value) -> Vec<String> { serde_json::to_string_pretty(v).unwrap_or_default().split('\n').map(String::from).collect() }

pub fn hooks_section_diff(current: &Value, next: &Value) -> String { hooks_diff(current, next) }

fn hooks_diff(current: &Value, next: &Value) -> String {
    if current == next { return String::new(); }
    let section = |v: &Value| json!({ "hooks": v.get("hooks").cloned().unwrap_or_else(|| json!({})) });
    line_diff(&pretty_lines(&section(current)), &pretty_lines(&section(next)))
}

fn s<'a>(h: &'a Value, k: &str) -> &'a str { h.get(k).and_then(Value::as_str).unwrap_or("") }

/** A hook command that is ours: the Node scripts of 0.6 or the native hook of 0.7. */
pub fn is_our_hook_command(c: &str) -> bool { c.contains("pet-hook.mjs") || c.contains("ccpet-hook") }
fn is_wait(c: &str) -> bool { c.split_whitespace().skip(1).any(|w| w == "wait") }
fn is_statusline_cmd(c: &str) -> bool { c.split_whitespace().skip(1).any(|w| w == "statusline") }
fn is_waiter(h: &Value) -> bool {
    h.get("type").and_then(Value::as_str) == Some("command") && {
        let c = s(h, "command");
        let helper = c.trim_end_matches(['"', '\'']).to_lowercase();
        ((helper.ends_with("pet-helper.exe") || helper.ends_with("pet-helper")) && h.get("args").and_then(|a| a.get(0)).and_then(Value::as_str) == Some("wait"))
            || (is_our_hook_command(c) && is_wait(c))
    }
}
/** `http://127.0.0.1:<port>/hook/<hex token>/<Event>` */
fn is_our_http(h: &Value) -> bool {
    if h.get("type").and_then(Value::as_str) != Some("http") { return false; }
    let u = s(h, "url");
    let Some(rest) = u.strip_prefix("http://127.0.0.1:") else { return false };
    let mut p = rest.splitn(4, '/');
    let (port, hook, tok, ev) = (p.next().unwrap_or(""), p.next(), p.next().unwrap_or(""), p.next().unwrap_or(""));
    !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && hook == Some("hook")
        && !tok.is_empty() && tok.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && !ev.is_empty() && ev.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
fn is_ours(h: &Value) -> bool { is_waiter(h) || is_our_http(h) }

/** Drops the handlers `pred` selects from every group; emptied groups, events and the hooks object go too. */
fn strip(next: &mut Value, pred: impl Fn(&Value) -> bool) {
    let Some(hooks) = next.get_mut("hooks").and_then(Value::as_object_mut) else { return };
    let events: Vec<String> = hooks.keys().cloned().collect();
    for ev in events {
        let mut groups = match hooks.get(&ev) { Some(Value::Array(a)) => a.clone(), _ => vec![] };
        for g in groups.iter_mut() {
            if let Some(Value::Array(hs)) = g.get_mut("hooks") { hs.retain(|h| !pred(h)); }
        }
        groups.retain(|g| !matches!(g.get("hooks"), Some(Value::Array(hs)) if hs.is_empty()));
        if groups.is_empty() { hooks.shift_remove(&ev); } else { hooks.insert(ev, Value::Array(groups)); }
    }
    if hooks.is_empty() { next.as_object_mut().map(|o| o.shift_remove("hooks")); }
}

fn add(next: &mut Value, ev: &str, handler: Value, matcher: Option<&str>) {
    let o = next.as_object_mut().expect("settings is an object");
    let hooks = o.entry("hooks").or_insert_with(|| json!({}));
    let mut group = Map::new();
    if let Some(m) = matcher { group.insert("matcher".into(), json!(m)); } else if ev == "PermissionRequest" { group.insert("matcher".into(), json!("*")); }
    group.insert("hooks".into(), json!([handler]));
    let list = hooks.as_object_mut().unwrap().entry(ev).or_insert_with(|| json!([]));
    if let Value::Array(a) = list { a.push(Value::Object(group)); }
}

fn object(v: &Value) -> Value { if v.is_object() { v.clone() } else { json!({}) } }

/** `"hooks": null` becomes `{}`; false when `hooks` is some other non-object (then the plan leaves the settings alone). */
fn prep_hooks(next: &mut Value) -> bool {
    match next.get("hooks") {
        None | Some(Value::Object(_)) => true,
        Some(Value::Null) => { next["hooks"] = json!({}); true }
        _ => false,
    }
}

/** Our events hook for every event (idempotent) and a +/- diff of the hooks section ('' when nothing changes). */
pub fn plan_hooks(current: &Value, hook_path: &str) -> (Value, String) {
    // `|| true`: if the app is ever removed, a missing hook file must not surface as hook errors in Claude Code
    let command = format!("\"{hook_path}\" 2>/dev/null || true");
    let mut next = object(current);
    if !prep_hooks(&mut next) { return (current.clone(), String::new()); }
    // the waiter and the statusLine command belong to other plans: left alone here
    strip(&mut next, |h| is_our_hook_command(s(h, "command")) && !is_wait(s(h, "command")) && !is_statusline_cmd(s(h, "command")));
    for ev in HOOK_EVENTS {
        let matcher = matches!(ev, "PreToolUse" | "PostToolUse").then_some("*");
        add(&mut next, ev, json!({ "type": "command", "command": command }), matcher);
    }
    let diff = hooks_diff(current, &next);
    (next, diff)
}

pub struct HostHooks<'a> { pub origin: &'a str, pub token: &'a str, pub hook_path: &'a str, pub permissions: bool }

/** Our receiver entries next to the events hook: the mailbox waiter and the permission / question answers over HTTP. */
pub fn plan_host_hooks(current: &Value, o: &HostHooks) -> (Value, String) {
    let mut next = object(current);
    if !prep_hooks(&mut next) { return (current.clone(), String::new()); }
    strip(&mut next, is_ours);
    let waiter = json!({ "type": "command", "command": format!("\"{}\" wait", o.hook_path), "asyncRewake": true });
    for ev in ["SessionStart", "Stop"] { add(&mut next, ev, waiter.clone(), None); }
    let url = format!("{}/hook/{}/PermissionRequest", o.origin, o.token);
    if o.permissions { add(&mut next, "PermissionRequest", json!({ "type": "http", "url": url, "timeout": 35 }), None); }
    // Claude's questions (AskUserQuestion) are answered in the pet: the user may take a while, the terminal shows the question meanwhile
    add(&mut next, "PermissionRequest", json!({ "type": "http", "url": url, "timeout": 600 }), Some("AskUserQuestion"));
    let diff = hooks_diff(current, &next);
    (next, diff)
}

/** Windows host: HTTP event hooks for every event, the mailbox waiter (when `helper` is known) and the permission / question answers. Idempotent; an older token's entries are replaced. */
pub fn plan_windows_hooks(current: &Value, origin: &str, token: &str, helper: Option<&str>, permissions: bool) -> (Value, String) {
    let mut next = object(current);
    if !prep_hooks(&mut next) { return (current.clone(), String::new()); }
    strip(&mut next, is_ours);
    for ev in HOOK_EVENTS {
        let matcher = matches!(ev, "PreToolUse" | "PostToolUse" | "PostToolUseFailure").then_some("*");
        add(&mut next, ev, json!({ "type": "http", "url": format!("{origin}/hook/{token}/{ev}"), "timeout": 5 }), matcher);
    }
    if let Some(h) = helper.filter(|h| !h.is_empty()) {
        let waiter = json!({ "type": "command", "command": h, "args": ["wait", format!("{origin}/mailbox/{token}")], "asyncRewake": true });
        for ev in ["SessionStart", "Stop"] { add(&mut next, ev, waiter.clone(), None); }
    }
    let url = format!("{origin}/hook/{token}/PermissionRequest");
    if permissions { add(&mut next, "PermissionRequest", json!({ "type": "http", "url": url, "timeout": 35 }), None); }
    add(&mut next, "PermissionRequest", json!({ "type": "http", "url": url, "timeout": 600 }), Some("AskUserQuestion"));
    let diff = hooks_diff(current, &next);
    (next, diff)
}

/** Windows host removal: only our HTTP and waiter entries go. */
pub fn remove_windows_hooks(current: &Value) -> (Value, String) {
    let mut next = object(current);
    strip(&mut next, is_ours);
    let diff = hooks_diff(current, &next);
    (next, diff)
}

/** Status for the Windows host: `events` means our HTTP hook on every event. */
pub fn windows_hooks_status(current: &Value) -> HooksStatus {
    let events = HOOK_EVENTS.iter().all(|ev| handlers(current, ev).iter().any(|h| is_our_http(h)));
    HooksStatus { events, ..hooks_status(current) }
}

/** Settings without any of our hook entries (events, waiter, HTTP); the user's own stay. */
pub fn remove_hooks(current: &Value) -> (Value, String) {
    let mut next = object(current);
    strip(&mut next, |h| is_ours(h) || is_our_hook_command(s(h, "command")));
    let diff = hooks_diff(current, &next);
    (next, diff)
}

#[derive(Debug, PartialEq, Eq)]
pub struct HooksStatus { pub events: bool, pub mailbox: bool, pub permissions: bool }

fn handlers<'a>(current: &'a Value, ev: &str) -> Vec<&'a Value> {
    match current.get("hooks").and_then(|h| h.get(ev)) {
        Some(Value::Array(gs)) => gs.iter().filter_map(|g| g.get("hooks").and_then(Value::as_array)).flatten().collect(),
        _ => vec![],
    }
}

pub fn hooks_status(current: &Value) -> HooksStatus {
    let events = HOOK_EVENTS.iter().all(|ev| handlers(current, ev).iter().any(|h|
        h.get("type").and_then(Value::as_str) == Some("command") && is_our_hook_command(s(h, "command")) && !is_wait(s(h, "command"))));
    let mailbox = ["SessionStart", "Stop"].iter().all(|ev| handlers(current, ev).iter().any(|h| is_waiter(h)));
    // the questions-only group (matcher AskUserQuestion) is always there: tool permissions are the catch-all one
    let permissions = match current.get("hooks").and_then(|h| h.get("PermissionRequest")) {
        Some(Value::Array(gs)) => gs.iter().any(|g| g.get("matcher").and_then(Value::as_str) != Some("AskUserQuestion")
            && g.get("hooks").and_then(Value::as_array).map_or(false, |hs| hs.iter().any(is_our_http))),
        _ => false,
    };
    HooksStatus { events, mailbox, permissions }
}

/** Where the pet's events hook sends a Notification: the command (WSL / Linux / macOS) or Claude Code's http hook (Windows). */
#[derive(Debug, PartialEq)]
pub enum ProbeTarget { Command(String), Url(String) }

/** The installed events hook a connection test goes through, exactly as Claude Code would run it; None = not installed. */
pub fn probe_target(current: &Value) -> Option<ProbeTarget> {
    handlers(current, "Notification").into_iter().find_map(|h| {
        let c = s(h, "command");
        // the quoted program must be our hook itself: a user's own script that merely mentions it is never run with a test event
        let ours = c.split('"').nth(1).map_or(false, |p| p.ends_with("ccpet-hook") || p.ends_with("pet-hook.mjs"));
        if h.get("type").and_then(Value::as_str) == Some("command") && ours && !is_wait(c) && !is_statusline_cmd(c) { Some(ProbeTarget::Command(c.into())) }
        else if is_our_http(h) { Some(ProbeTarget::Url(s(h, "url").into())) }
        else { None }
    })
}

/** Hook files the settings point at (ours): none = not installed, any missing = stale. */
pub fn referenced_hook_files(current: &Value) -> Vec<String> {
    let Some(Value::Object(hooks)) = current.get("hooks") else { return vec![] };
    let mut out = vec![];
    for gs in hooks.values().filter_map(Value::as_array) {
        for h in gs.iter().filter_map(|g| g.get("hooks").and_then(Value::as_array)).flatten() {
            let c = s(h, "command");
            for part in c.split('"').skip(1).step_by(2) { if part.ends_with("pet-hook.mjs") || part.ends_with("ccpet-hook") { out.push(part.to_string()); } }
        }
    }
    out
}

// ---- statusLine ----

/** pet-statusline.mjs (0.6), `ccpet-hook statusline` (0.7) or `pet-helper.exe statusline` (Windows) */
pub fn is_pet_status_line(command: &str) -> bool {
    if command.contains("pet-statusline.mjs") { return true; }
    let l = command.to_lowercase();
    ["pet-helper.exe", "ccpet-hook"].iter().any(|k| l.match_indices(k).any(|(i, _)| {
        let rest = l[i + k.len()..].trim_start_matches('"');
        rest.starts_with(|c: char| c.is_whitespace()) && rest.trim_start().strip_prefix("statusline").map_or(false, |t| !t.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
    }))
}
fn sl_ours(sl: Option<&Value>) -> bool { sl.map_or(false, |sl| is_pet_status_line(s(sl, "command"))) }

fn b64() -> &'static [u8; 64] { b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" }
fn enc(v: &Value) -> String {
    let bytes = v.to_string().into_bytes();
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..=c.len() { out.push(b64()[(n >> (18 - 6 * k) & 63) as usize] as char); }
    }
    out
}
fn dec(s: &str) -> Option<Value> {
    let mut bytes = vec![];
    let (mut acc, mut bits) = (0u32, 0);
    for ch in s.bytes() {
        let v = b64().iter().position(|&b| b == ch)? as u32;
        acc = acc << 6 | v; bits += 6;
        if bits >= 8 { bits -= 8; bytes.push((acc >> bits & 0xff) as u8); }
    }
    serde_json::from_slice(&bytes).ok()
}

/** The statusLine Claude Code had before we wrapped it (None: ours is not a wrapper, or the wrapper is unreadable). */
pub fn chained_original(sl: &Value) -> Option<Value> {
    if !is_pet_status_line(s(sl, "command")) { return None; }
    let c = s(sl, "command");
    let i = c.rfind(CHAIN)?;
    dec(c[i + CHAIN.len()..].trim().split_whitespace().next()?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chain { None, Ours, Chained }

/** Points `statusLine` at `<hook> statusline`. Someone else's statusLine is wrapped (kept base64 so removal restores it exactly). */
pub fn plan_status_line(current: &Value, hook_path: &str) -> (Value, String, Chain) {
    plan_sl(current, &format!("\"{hook_path}\" statusline"), " 2>/dev/null || true")
}

/** Windows form: `<helper path with forward slashes> statusline`, no quotes and no shell tail (Git Bash and PowerShell both run it). A path with spaces is refused (pass the short 8.3 form). Removal is `remove_status_line`. */
pub fn plan_windows_status_line(current: &Value, helper: &str) -> Result<(Value, String, Chain), String> {
    if helper.chars().any(char::is_whitespace) { return Err("statusLine helper path must not contain spaces (use the short 8.3 path)".into()); }
    Ok(plan_sl(current, &format!("{} statusline", helper.replace('\\', "/")), ""))
}

fn plan_sl(current: &Value, base: &str, tail: &str) -> (Value, String, Chain) {
    let existing = current.get("statusLine").filter(|v| !v.is_null());
    let orig = match existing { Some(e) if sl_ours(Some(e)) => chained_original(e), other => other.cloned() };
    let mut next = object(current);
    let sl = match &orig {
        Some(o) => { let mut m = o.as_object().cloned().unwrap_or_default(); m.insert("type".into(), json!("command")); m.insert("command".into(), json!(format!("{base}{CHAIN}{}{tail}", enc(o)))); Value::Object(m) }
        None => json!({ "type": "command", "command": format!("{base}{tail}"), "padding": 0 }),
    };
    next.as_object_mut().unwrap().insert("statusLine".into(), sl.clone());
    let kind = if orig.is_some() { Chain::Chained } else { Chain::Ours };
    if existing == Some(&sl) { return (next, String::new(), kind); }
    let before = existing.map_or(vec![], |e| pretty_lines(&json!({ "statusLine": e })));
    (next, line_diff(&before, &pretty_lines(&json!({ "statusLine": sl }))), kind)
}

/** A wrapped statusLine is restored to the user's original, a plain one is removed; anything else is left alone. */
pub fn remove_status_line(current: &Value) -> (Value, String) {
    let Some(sl) = current.get("statusLine").filter(|v| sl_ours(Some(v))) else { return (current.clone(), String::new()) };
    let mut next = object(current);
    let orig = chained_original(sl);
    match &orig { Some(o) => { next.as_object_mut().unwrap().insert("statusLine".into(), o.clone()); } None => { next.as_object_mut().unwrap().shift_remove("statusLine"); } }
    let after = orig.map_or(vec![], |o| pretty_lines(&json!({ "statusLine": o })));
    (next, line_diff(&pretty_lines(&json!({ "statusLine": sl })), &after))
}

pub fn status_line_state(current: &Value) -> Chain {
    match current.get("statusLine") { Some(sl) if sl_ours(Some(sl)) => if chained_original(sl).is_some() { Chain::Chained } else { Chain::Ours }, _ => Chain::None }
}

// ---- files ----

/** Reads a settings file; one that is not plain JSON is never touched (the error says so). Returns the settings and whether the file existed. */
pub fn read_settings(path: &Path) -> Result<(Value, bool), String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((json!({}), false)),
        Err(e) => return Err(format!("Cannot read settings file {}: {e}, left untouched.", path.display())),
    };
    if raw.trim().is_empty() { return Ok((json!({}), true)); }
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) if v.is_object() => Ok((v, true)),
        _ => Err(format!("Cannot parse settings file {}: not valid JSON, left untouched.", path.display())),
    }
}

/** Writes the new settings after copying the old file to `backup` (default `<path>.bak`); returns the backup path when there was one. */
pub fn write_settings(path: &Path, next: &Value, had_file: bool, backup: Option<&Path>) -> std::io::Result<Option<std::path::PathBuf>> {
    let mut made = None;
    if had_file {
        let b = backup.map(Path::to_path_buf).unwrap_or_else(|| { let mut p = path.as_os_str().to_owned(); p.push(".bak"); p.into() });
        std::fs::copy(path, &b)?;
        made = Some(b);
    } else if let Some(d) = path.parent() { std::fs::create_dir_all(d)?; }
    std::fs::write(path, serde_json::to_string_pretty(next).unwrap_or_default() + "\n")?;
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;
    const HOOK: &str = "/home/u/.claude-pet/hook/ccpet-hook";

    fn user() -> Value { json!({ "model": "opus", "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "notify.sh" }] }] } }) }

    #[test]
    fn diff_lines() {
        let a: Vec<String> = ["x", "y", "z"].map(String::from).to_vec();
        let b: Vec<String> = ["x", "z", "w"].map(String::from).to_vec();
        assert_eq!(line_diff(&a, &b), "- y\n+ w");
        assert_eq!(line_diff(&a, &a), "");
    }

    #[test]
    fn events_hook_is_idempotent_and_keeps_the_users_own() {
        let (n1, d1) = plan_hooks(&user(), HOOK);
        assert!(!d1.is_empty());
        assert_eq!(n1["model"], "opus");
        assert_eq!(n1["hooks"]["Stop"][0]["hooks"][0]["command"], "notify.sh");
        assert_eq!(n1["hooks"]["PreToolUse"][0]["matcher"], "*");
        assert!(n1["hooks"]["PostToolUseFailure"][0].get("matcher").is_none());
        assert_eq!(n1["hooks"]["SessionEnd"][0]["hooks"][0]["command"], format!("\"{HOOK}\" 2>/dev/null || true"));
        let (n2, d2) = plan_hooks(&n1, HOOK);
        assert_eq!((n2, d2.as_str()), (n1.clone(), ""));
        assert!(hooks_status(&n1).events && !hooks_status(&n1).mailbox);
        // an old Node hook is replaced, not duplicated
        let old = json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "\"/usr/bin/node\" \"/x/pet-hook.mjs\" 2>/dev/null || true" }] }] } });
        let (n3, _) = plan_hooks(&old, HOOK);
        assert_eq!(n3["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(n3["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap().contains("ccpet-hook"));
    }

    #[test]
    fn receiver_entries_and_removal() {
        let (n1, _) = plan_hooks(&user(), HOOK);
        let o = HostHooks { origin: "http://127.0.0.1:47822", token: "abc123", hook_path: HOOK, permissions: true };
        let (n2, d) = plan_host_hooks(&n1, &o);
        assert!(!d.is_empty());
        let st = hooks_status(&n2);
        assert_eq!((st.events, st.mailbox, st.permissions), (true, true, true));
        assert_eq!(n2["hooks"]["Stop"].as_array().unwrap().len(), 3); // user + events + waiter
        assert_eq!(n2["hooks"]["SessionStart"][1]["hooks"][0]["asyncRewake"], true);
        assert_eq!(plan_host_hooks(&n2, &o).1, "", "idempotent");
        let (off, _) = plan_host_hooks(&n2, &HostHooks { permissions: false, ..o });
        assert!(!hooks_status(&off).permissions);
        assert_eq!(off["hooks"]["PermissionRequest"][0]["matcher"], "AskUserQuestion");
        let (gone, _) = remove_hooks(&n2);
        assert_eq!(gone, user());
        assert!(referenced_hook_files(&n2).iter().all(|f| f == HOOK) && !referenced_hook_files(&n2).is_empty());
    }

    #[test]
    fn status_line_plain_chained_and_removed() {
        assert!(is_pet_status_line("\"/x/ccpet-hook\" statusline 2>/dev/null || true"));
        assert!(is_pet_status_line("C:/p/pet-helper.exe statusline"));
        assert!(is_pet_status_line("node /x/pet-statusline.mjs"));
        assert!(!is_pet_status_line("my-line.sh") && !is_pet_status_line("ccpet-hook statuslinex"));
        // plain
        let (n, d, k) = plan_status_line(&json!({}), HOOK);
        assert_eq!((k, d.is_empty(), status_line_state(&n)), (Chain::Ours, false, Chain::Ours));
        assert_eq!(plan_status_line(&n, HOOK).1, "");
        assert_eq!(remove_status_line(&n).0, json!({}));
        // wrapping a foreign one, then restoring it exactly
        let foreign = json!({ "model": "opus", "statusLine": { "type": "command", "command": "my-line.sh --x ü", "padding": 2 } });
        let (w, _, k) = plan_status_line(&foreign, HOOK);
        assert_eq!((k, status_line_state(&w)), (Chain::Chained, Chain::Chained));
        assert_eq!(plan_status_line(&w, HOOK).1, "", "re-planning a wrapper changes nothing");
        assert_eq!(chained_original(&w["statusLine"]).unwrap(), foreign["statusLine"]);
        assert_eq!(remove_status_line(&w).0, foreign);
        // someone else's is left alone
        assert_eq!(remove_status_line(&foreign).1, "");
    }

    #[test]
    fn settings_files_keep_a_backup_and_refuse_broken_json() {
        let d = std::env::temp_dir().join(format!("ccpet-inst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = d.join("sub").join("settings.json");
        let (v, had) = read_settings(&p).unwrap();
        assert!(!had && v == json!({}));
        assert_eq!(write_settings(&p, &json!({ "a": 1 }), false, None).unwrap(), None);
        let b = write_settings(&p, &json!({ "a": 2 }), true, None).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "{\n  \"a\": 1\n}\n");
        std::fs::write(&p, "{ nope").unwrap();
        assert!(read_settings(&p).unwrap_err().contains("left untouched"));
    }

    #[test]
    fn unreadable_settings_are_errors_not_missing() {
        let d = std::env::temp_dir().join(format!("ccpet-inst-rd-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("bad.json");
        std::fs::write(&p, b"{\"a\":\"\xff\"}").unwrap();
        assert!(read_settings(&p).unwrap_err().contains("left untouched"));
        assert!(read_settings(&d).is_err());
        assert_eq!(read_settings(&d.join("none.json")).unwrap(), (json!({}), false));
    }

    #[test]
    fn odd_hooks_values_do_not_panic() {
        let (n, d) = plan_hooks(&json!({ "hooks": null, "a": 1 }), HOOK);
        assert!(!d.is_empty() && n["hooks"]["Stop"].is_array());
        let five = json!({ "hooks": 5 });
        let o = HostHooks { origin: "http://x", token: "t", hook_path: HOOK, permissions: true };
        for (n, d) in [plan_hooks(&five, HOOK), plan_host_hooks(&five, &o)] { assert_eq!(n, five); assert_eq!(d, ""); }
    }

    #[test]
    fn removal_keeps_key_order() {
        let n = plan_hooks(&json!({ "a": 1, "b": 2, "c": 3 }), HOOK).0;
        let with = json!({ "a": 1, "hooks": n["hooks"], "b": 2, "c": 3 });
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&remove_hooks(&with).0), ["a", "b", "c"]);
        let sl = plan_status_line(&json!({ "a": 1, "b": 2, "c": 3 }), HOOK).0;
        let mut sl2 = Map::new();
        for (k, v) in [("a", json!(1)), ("statusLine", sl["statusLine"].clone()), ("b", json!(2)), ("c", json!(3))] { sl2.insert(k.into(), v); }
        assert_eq!(keys(&remove_status_line(&Value::Object(sl2)).0), ["a", "b", "c"]);
    }

    const WORIGIN: &str = "http://127.0.0.1:47821";
    const HELPER: &str = "C:\\pet\\pet-helper.exe";
    fn mine() -> Value { json!({ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "rtk-rewrite" }] }] }, "theme": "dark" }) }

    #[test]
    fn windows_hooks_install_replace_and_remove() {
        let (n, d) = plan_windows_hooks(&mine(), WORIGIN, "ab12cd", Some(HELPER), false);
        assert!(!d.is_empty());
        let pre = &n["hooks"]["PreToolUse"];
        assert_eq!(pre[0], mine()["hooks"]["PreToolUse"][0]);
        assert_eq!(pre[1]["matcher"], "*");
        assert_eq!(pre[1]["hooks"][0], json!({ "type": "http", "url": "http://127.0.0.1:47821/hook/ab12cd/PreToolUse", "timeout": 5 }));
        assert!(n["hooks"]["UserPromptSubmit"][0].get("matcher").is_none());
        assert_eq!(n["hooks"]["Stop"][1]["hooks"][0], json!({ "type": "command", "command": HELPER, "args": ["wait", "http://127.0.0.1:47821/mailbox/ab12cd"], "asyncRewake": true }));
        assert_eq!(n["theme"], "dark");
        assert_eq!(windows_hooks_status(&n), HooksStatus { events: true, mailbox: true, permissions: false });
        // key order of the entry matches the TS literal
        assert_eq!(n["hooks"]["Stop"][1]["hooks"][0].as_object().unwrap().keys().collect::<Vec<_>>(), ["type", "command", "args", "asyncRewake"]);
        // idempotent, a new token replaces the old entries
        assert_eq!(plan_windows_hooks(&n, WORIGIN, "ab12cd", Some(HELPER), false).1, "");
        let again = plan_windows_hooks(&n, WORIGIN, "ff00ee", Some(HELPER), false).0;
        assert!(!again.to_string().contains("ab12cd"));
        assert_eq!(again["hooks"]["Stop"].as_array().unwrap().iter().filter(|g| g["hooks"][0]["type"] == "http").count(), 1);
        // no helper: no waiter
        assert!(!windows_hooks_status(&plan_windows_hooks(&json!({}), WORIGIN, "ab12cd", None, false).0).mailbox);
        // removal
        let (inst, _) = plan_windows_hooks(&mine(), WORIGIN, "ab12cd", Some(HELPER), true);
        assert_eq!(remove_windows_hooks(&inst).0, mine());
        assert_eq!(remove_windows_hooks(&mine()).1, "");
        assert_eq!(windows_hooks_status(&remove_windows_hooks(&inst).0), HooksStatus { events: false, mailbox: false, permissions: false });
    }

    #[test]
    fn windows_permission_hooks() {
        let off = plan_windows_hooks(&json!({}), WORIGIN, "ab12cd", None, false).0;
        let url = "http://127.0.0.1:47821/hook/ab12cd/PermissionRequest";
        assert_eq!(off["hooks"]["PermissionRequest"], json!([{ "matcher": "AskUserQuestion", "hooks": [{ "type": "http", "url": url, "timeout": 600 }] }]));
        assert!(!windows_hooks_status(&off).permissions);
        let on = plan_windows_hooks(&json!({}), WORIGIN, "ab12cd", None, true).0;
        assert_eq!(on["hooks"]["PermissionRequest"][0], json!({ "matcher": "*", "hooks": [{ "type": "http", "url": url, "timeout": 35 }] }));
        assert!(windows_hooks_status(&on).permissions);
    }

    #[test]
    fn windows_status_line() {
        let exe = "C:\\Users\\u\\AppData\\Local\\Programs\\claude-pet\\resources\\helper\\pet-helper.exe";
        let cmd = "C:/Users/u/AppData/Local/Programs/claude-pet/resources/helper/pet-helper.exe statusline";
        let (n, _, k) = plan_windows_status_line(&json!({}), exe).unwrap();
        assert_eq!(k, Chain::Ours);
        assert_eq!(n["statusLine"], json!({ "type": "command", "command": cmd, "padding": 0 }));
        assert_eq!(status_line_state(&n), Chain::Ours);
        let mine = json!({ "type": "command", "command": "powershell -c \"Get-Date\"" });
        let (w, _, k) = plan_windows_status_line(&json!({ "statusLine": mine }), exe).unwrap();
        assert_eq!((k, status_line_state(&w)), (Chain::Chained, Chain::Chained));
        assert_eq!(remove_status_line(&w).0["statusLine"], mine);
        let (moved, _, _) = plan_windows_status_line(&w, "D:\\pet\\pet-helper.exe").unwrap();
        assert!(moved["statusLine"]["command"].as_str().unwrap().contains("D:/pet/pet-helper.exe statusline"));
        assert_eq!(remove_status_line(&moved).0["statusLine"], mine);
        // the old quoted form is ours and gets replaced
        let old = json!({ "statusLine": { "type": "command", "command": format!("\"{exe}\" statusline"), "padding": 0 } });
        assert_eq!(status_line_state(&old), Chain::Ours);
        let (r, d, _) = plan_windows_status_line(&old, exe).unwrap();
        assert!(!d.is_empty());
        assert_eq!(r["statusLine"]["command"], cmd);
        assert!(plan_windows_status_line(&json!({}), "C:\\Program Files\\pet\\pet-helper.exe").is_err());
    }

    #[test]
    fn probe_goes_through_the_installed_events_hook() {
        assert_eq!(probe_target(&mine()), None);
        let wsl = plan_host_hooks(&plan_hooks(&mine(), HOOK).0, &HostHooks { origin: WORIGIN, token: "ab12cd", hook_path: HOOK, permissions: true }).0;
        assert_eq!(probe_target(&wsl), Some(ProbeTarget::Command(format!("\"{HOOK}\" 2>/dev/null || true"))), "the events hook, not the waiter");
        let win = plan_windows_hooks(&mine(), WORIGIN, "ab12cd", Some(HELPER), true).0;
        assert_eq!(probe_target(&win), Some(ProbeTarget::Url(format!("{WORIGIN}/hook/ab12cd/Notification"))));
        assert_eq!(probe_target(&remove_hooks(&wsl).0), None);
        let mine_too = json!({ "hooks": { "Notification": [{ "hooks": [{ "type": "command", "command": "~/log.sh --after ccpet-hook" }] }] } });
        assert_eq!(probe_target(&mine_too), None, "a user's script that mentions the hook is not run");
    }
}
