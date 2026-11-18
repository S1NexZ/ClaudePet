//! Claude Code transcript JSONL: the visible conversation, turn summaries, interrupt and cwd lookups (transcript.ts).

use crate::summary::summarize;
use crate::types::{ChatItem, FileChange, TurnSummary};
use regex_lite::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

pub const PET_MARKER: &str = "[ccPet message]";
const LEGACY_MARKER: &str = "[Claude Pet message]";

fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/** The user's own text inside a mailbox hook-feedback record, if any. */
pub fn pet_message_of(t: &str) -> Option<String> {
    let re = Regex::new(r"\[(?:ccPet|Claude Pet) message\]\s*([\s\S]*?)\s*(?:</system-reminder>|$)").ok()?;
    let m = re.captures(t)?.get(1)?.as_str().to_string();
    if m.is_empty() { None } else { Some(m) }
}

/** Date.parse for the ISO timestamps Claude Code writes (`2026-01-01T10:00:00.123Z`); None when it is anything else. */
pub fn parse_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' { return None; }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    let mut i = 19;
    let mut ms = 0;
    if b[i] == b'.' {
        let end = (i + 1..b.len()).find(|&k| !b[k].is_ascii_digit()).unwrap_or(b.len());
        let frac = &s[i + 1..end];
        ms = format!("{:0<3}", &frac[..frac.len().min(3)]).parse::<i64>().ok()?;
        i = end;
    }
    // `Z` or a `+HH:MM` / `-HH:MM` offset
    let off = match s.get(i..)? {
        "Z" => 0,
        o if o.len() == 6 && (o.starts_with('+') || o.starts_with('-')) && o.as_bytes()[3] == b':' => {
            let m = o[1..3].parse::<i64>().ok()? * 60 + o[4..6].parse::<i64>().ok()?;
            if o.starts_with('+') { m } else { -m }
        }
        _ => return None,
    };
    // days since 1970-01-01 (Howard Hinnant's civil algorithm)
    let (y, m) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 24 + h) * 60 + mi - off) * 60_000 + sec * 1000 + ms)
}

fn ts_of(e: &Value) -> Option<i64> { e.get("timestamp").and_then(Value::as_str).and_then(parse_ts) }

fn read_range(path: &str, from_end: bool, max: u64) -> Option<(Vec<u8>, u64)> {
    if !path.ends_with(".jsonl") { return None; }
    let mut f = File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let len = size.min(max);
    f.seek(SeekFrom::Start(if from_end { size - len } else { 0 })).ok()?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).ok()?;
    Some((buf, size))
}

/** Which Claude Code front end wrote a transcript (`entrypoint` of its first records). */
pub fn read_entrypoint(path: &str) -> Option<String> {
    let (buf, _) = read_range(path, false, 65536)?;
    let re = Regex::new(r#""entrypoint":"([\w-]+)""#).ok()?;
    String::from_utf8_lossy(&buf).split('\n').take(40).find_map(|l| re.captures(l).map(|c| c[1].to_string()))
}

fn line_count(v: Option<&Value>) -> i64 {
    match v.and_then(Value::as_str) { Some(s) if !s.is_empty() => s.strip_suffix('\n').unwrap_or(s).split('\n').count() as i64, _ => 0 }
}

/** Lines added / removed by one file-editing tool call (Edit, MultiEdit, Write, NotebookEdit); None for other tools. */
pub fn edit_stats(name: &str, input: &Value) -> Option<FileChange> {
    let path = input.get("file_path").or_else(|| input.get("notebook_path")).and_then(Value::as_str)?.to_string();
    let (added, removed) = match name {
        "Edit" => (line_count(input.get("new_string")), line_count(input.get("old_string"))),
        "MultiEdit" => {
            let edits = input.get("edits")?.as_array()?;
            (edits.iter().map(|x| line_count(x.get("new_string"))).sum(), edits.iter().map(|x| line_count(x.get("old_string"))).sum())
        }
        "Write" => (line_count(input.get("content")), 0),
        "NotebookEdit" => (line_count(input.get("new_source")), 0),
        _ => return None,
    };
    Some(FileChange { path, added, removed })
}

struct Turn { start: Option<i64>, end: Option<i64>, files: Vec<FileChange>, tokens: HashMap<String, i64>, tools: i64, done: bool }

fn close_turn(turn: &mut Option<Turn>, out: &mut Vec<ChatItem>) {
    if let Some(t) = turn.take() {
        if !t.files.is_empty() {
            let ms = match (t.start, t.end) { (Some(s), Some(e)) => (e - s).max(0), _ => 0 };
            out.push(ChatItem { role: "summary", text: String::new(), summary: Some(TurnSummary { files: t.files, ms, tokens: t.tokens.values().sum(), tools: t.tools }) });
        }
    }
}

/** The visible conversation (user text, assistant text, tool calls); a finished turn that changed files is followed by a 'summary' item. */
pub fn parse_transcript(jsonl: &str, limit: usize) -> Vec<ChatItem> {
    let mut out: Vec<ChatItem> = Vec::new();
    let mut turn: Option<Turn> = None;
    let item = |role: &'static str, text: String| ChatItem { role, text, summary: None };
    for line in jsonl.split('\n') {
        if line.trim().is_empty() { continue; }
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        let truthy = |k: &str| e.get(k).map_or(false, |v| !matches!(v, Value::Null | Value::Bool(false)));
        if truthy("isMeta") || truthy("isSidechain") { continue; }
        let kind = e.get("type").and_then(Value::as_str);
        let msg = e.get("message");
        if kind == Some("user") {
            let t = text_of(msg.and_then(|m| m.get("content"))).trim().to_string();
            let prompt = if !t.is_empty() && !t.starts_with('<') { Some(t) }
                else if t.contains(PET_MARKER) || t.contains(LEGACY_MARKER) { pet_message_of(&t) } else { None };
            if let Some(text) = prompt {
                close_turn(&mut turn, &mut out);
                out.push(item("user", text));
                let ts = ts_of(&e);
                turn = Some(Turn { start: ts, end: ts, files: vec![], tokens: HashMap::new(), tools: 0, done: false });
            }
        } else if kind == Some("assistant") {
            let mut tooled = false;
            if let Some(Value::Array(blocks)) = msg.and_then(|m| m.get("content")) {
                for b in blocks {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) { out.push(item("assistant", t.to_string())); }
                        }
                        Some("tool_use") => {
                            tooled = true;
                            let name = b.get("name").and_then(Value::as_str).unwrap_or("");
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            let s = summarize(name, &input);
                            out.push(item("tool", if s.is_empty() { name.to_string() } else { format!("{name} · {s}") }));
                            if let Some(t) = turn.as_mut() {
                                t.tools += 1;
                                if let Some(st) = edit_stats(name, &input) {
                                    match t.files.iter_mut().find(|f| f.path == st.path) {
                                        Some(f) => { f.added += st.added; f.removed += st.removed; }
                                        None => t.files.push(st),
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            if let Some(t) = turn.as_mut() {
                if let Some(ts) = ts_of(&e) { t.end = Some(ts); }
                // one API message is written as several records with the same usage: count it once
                if let Some(tok) = msg.and_then(|m| m.get("usage")).and_then(|u| u.get("output_tokens")).and_then(Value::as_f64) {
                    let key = msg.and_then(|m| m.get("id")).and_then(Value::as_str).map(String::from).unwrap_or_else(|| t.tokens.len().to_string());
                    t.tokens.insert(key, tok as i64);
                }
                t.done = msg.and_then(|m| m.get("stop_reason")).and_then(Value::as_str) == Some("end_turn") && !tooled;
            }
        }
    }
    if turn.as_ref().map_or(false, |t| t.done) { close_turn(&mut turn, &mut out); }
    let skip = out.len().saturating_sub(limit);
    let mut items: Vec<ChatItem> = out.into_iter().skip(skip).collect();
    // a cut-off head may start with the summary of a turn whose prompt fell outside the window
    while items.first().map_or(false, |i| i.role == "summary") { items.remove(0); }
    items
}

/** The end of a transcript file: the tail is read first and widened only while it holds too few items. */
pub fn read_transcript(path: &str, limit: usize, first_chunk: u64) -> Vec<ChatItem> {
    let mut len = first_chunk;
    loop {
        let Some((buf, size)) = read_range(path, true, len) else { return vec![] };
        let mut text = String::from_utf8_lossy(&buf).into_owned();
        if (buf.len() as u64) < size { text = text.get(text.find('\n').map_or(0, |i| i + 1)..).unwrap_or("").to_string(); }
        let items = parse_transcript(&text, limit);
        if items.len() >= limit || buf.len() as u64 >= size { return items; }
        len = len.saturating_mul(4);
    }
}

/** True if the transcript text has a "[Request interrupted by user..." entry written at or after `since_ms`. */
pub fn has_interrupt_since(text: &str, since_ms: i64) -> bool {
    for line in text.split('\n').rev() {
        if !line.contains("[Request interrupted by user") { continue; }
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        if e.get("type").and_then(Value::as_str) != Some("user") { continue; }
        if !text_of(e.get("message").and_then(|m| m.get("content"))).starts_with("[Request interrupted by user") { continue; }
        return ts_of(&e).map_or(false, |t| t >= since_ms);
    }
    false
}

pub fn interrupted_since(path: &str, since_ms: i64) -> bool {
    read_range(path, true, 65536).map_or(false, |(b, _)| has_interrupt_since(&String::from_utf8_lossy(&b), since_ms))
}

/** The folder a session was started in: the first absolute `cwd` in the first 128 KB of its transcript. */
pub fn read_original_cwd(path: &str) -> Option<String> {
    let (buf, _) = read_range(path, false, 131072)?;
    String::from_utf8_lossy(&buf).split('\n').filter(|l| l.contains("\"cwd\"")).find_map(|l| {
        let v: Value = serde_json::from_str(l).ok()?;
        v.get("cwd")?.as_str().filter(|c| c.starts_with('/')).map(String::from)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn l(v: Value) -> String { v.to_string() }
    fn tmp(name: &str, content: &str) -> String {
        let d = std::env::temp_dir().join(format!("ccpet-tr-{}-{}", std::process::id(), name.replace('.', "_")));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join(name);
        std::fs::write(&f, content).unwrap();
        f.to_string_lossy().into_owned()
    }

    #[test]
    fn timestamps() {
        assert_eq!(parse_ts("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts("2026-01-01T10:00:30.5Z"), Some(1767261630500));
        assert_eq!(parse_ts("2026-01-01T10:00:30.5Z"), parse_ts("2026-01-01T12:00:30.500000+02:00"));
        assert_eq!(parse_ts("nope"), None);
    }

    #[test]
    fn keeps_visible_items_only() {
        let lines = vec![
            l(json!({"type":"summary"})),
            l(json!({"type":"user","message":{"content":"привет"}})),
            l(json!({"type":"user","isMeta":true,"message":{"content":"meta"}})),
            l(json!({"type":"user","message":{"content":"<command-name>/model</command-name>"}})),
            l(json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"h"},{"type":"text","text":"Сейчас."},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}})),
            l(json!({"type":"user","message":{"content":[{"type":"tool_result","content":"files"}]}})),
            l(json!({"type":"user","message":{"content":[{"type":"text","text":"спасибо"}]}})),
            "{broken".into(),
        ].join("\n");
        let got: Vec<_> = parse_transcript(&lines, 40).into_iter().map(|i| (i.role, i.text)).collect();
        assert_eq!(got, vec![("user", "привет".into()), ("assistant", "Сейчас.".into()), ("tool", "Bash · ls -la".into()), ("user", "спасибо".into())]);
        assert_eq!(parse_transcript(&lines, 2).len(), 2);
    }

    #[test]
    fn tail_read_matches_full_parse() {
        let text: String = (0..300).map(|i| l(json!({"type":"user","message":{"content":format!("message number {i} {}", "x".repeat(200))}})) + "\n").collect();
        let f = tmp("long.jsonl", &text);
        for chunk in [100u64, 1000, 5000, 1 << 20] {
            let r = read_transcript(&f, 40, chunk);
            assert_eq!(r.len(), 40);
            assert!(r[0].text.contains("message number 260 "));
        }
        assert_eq!(read_transcript(&f, 1000, 100).len(), 300);
        assert!(read_transcript("/nonexistent/a.jsonl", 40, 100).is_empty());
        assert!(read_transcript(&tmp("s.txt", &text), 40, 100).is_empty());
    }

    #[test]
    fn interrupts() {
        let line = |t: &str, ts: &str| l(json!({"type":"user","message":{"content":[{"type":"text","text":t}]},"timestamp":ts}));
        let t = parse_ts("2026-11-16T13:00:10Z").unwrap();
        assert!(has_interrupt_since(&format!("{}\n{}", line("hi", "2026-11-16T13:00:20Z"), line("[Request interrupted by user]", "2026-11-16T13:00:20Z")), t));
        assert!(has_interrupt_since(&line("[Request interrupted by user for tool use]", "2026-11-16T13:00:20Z"), t));
        assert!(!has_interrupt_since(&line("[Request interrupted by user]", "2026-11-16T13:00:05Z"), t));
        assert!(!has_interrupt_since(&line("write [Request interrupted by user] in a file", "2026-11-16T13:00:20Z"), t));
        assert!(!has_interrupt_since("garbage\n{\"half", t));
        let f = tmp("i.jsonl", &format!("{}\n{}\n", "x".repeat(200_000), line("[Request interrupted by user]", "2026-11-16T13:00:20Z")));
        assert!(interrupted_since(&f, t));
        assert!(!interrupted_since("/nonexistent/a.jsonl", t));
    }

    #[test]
    fn original_cwd_and_entrypoint() {
        let f = tmp("c.jsonl", "{\"cwd\":\n{\"cwd\":\"relative/x\"}\n{\"cwd\":\"/ok/dir\"}\n{\"cwd\":\"/later\"}\n");
        assert_eq!(read_original_cwd(&f).as_deref(), Some("/ok/dir"));
        assert_eq!(read_original_cwd(&tmp("n.jsonl", "{\"type\":\"mode\"}\n")), None);
        assert_eq!(read_original_cwd(&tmp("n.txt", "{\"cwd\":\"/x\"}\n")), None);
        let e = tmp("e.jsonl", "{\"type\":\"mode\"}\n{\"type\":\"user\",\"entrypoint\":\"claude-desktop\"}\n");
        assert_eq!(read_entrypoint(&e).as_deref(), Some("claude-desktop"));
        assert_eq!(read_entrypoint(&tmp("e2.jsonl", "{}\n")), None);
    }

    #[test]
    fn pet_messages() {
        let rec = l(json!({"type":"user","message":{"content":"<task-notification>x</task-notification>\n<system-reminder>\nfeedback\n[ccPet message] напиши тесты\n</system-reminder>"}}));
        assert_eq!(parse_transcript(&rec, 40).iter().map(|i| i.text.clone()).collect::<Vec<_>>(), vec!["напиши тесты"]);
        let old = l(json!({"type":"user","message":{"content":"<system-reminder>\n[Claude Pet message] старое\n</system-reminder>"}}));
        assert_eq!(parse_transcript(&old, 40)[0].text, "старое");
        assert_eq!(pet_message_of("<system-reminder>other</system-reminder>"), None);
    }

    #[test]
    fn turn_summary() {
        let r = |ts: &str, m: Value| l(json!({"type":"assistant","timestamp":ts,"message":m}));
        let lines = vec![
            l(json!({"type":"user","timestamp":"2026-01-01T10:00:00Z","message":{"content":"fix it"}})),
            r("2026-01-01T10:00:05Z", json!({"id":"m1","usage":{"output_tokens":100},"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/a.ts","old_string":"x\ny","new_string":"x\ny\nz"}}]})),
            r("2026-01-01T10:00:09Z", json!({"id":"m2","usage":{"output_tokens":20},"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/b.ts","content":"a\nb\n"}}]})),
            r("2026-01-01T10:00:30Z", json!({"id":"m3","stop_reason":"end_turn","usage":{"output_tokens":7},"content":[{"type":"thinking","thinking":""}]})),
            r("2026-01-01T10:00:30Z", json!({"id":"m3","stop_reason":"end_turn","usage":{"output_tokens":7},"content":[{"type":"text","text":"Done."}]})),
        ];
        let items = parse_transcript(&lines.join("\n"), 40);
        assert_eq!(items.iter().map(|i| i.role).collect::<Vec<_>>(), vec!["user", "tool", "tool", "assistant", "summary"]);
        let s = items.last().unwrap().summary.as_ref().unwrap();
        assert_eq!((s.ms, s.tokens, s.tools), (30_000, 127, 2));
        assert_eq!((s.files[0].added, s.files[0].removed, s.files[1].added), (3, 2, 2));
        assert!(!parse_transcript(&lines[..3].join("\n"), 40).iter().any(|i| i.role == "summary"), "no card while running");
    }
}
