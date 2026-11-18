//! ccPet's Claude Code hook (replaces hook/pet-hook.mjs and hook/pet-statusline.mjs).
//!
//! - `ccpet-hook`            a hook event on stdin: forwarded to the pet's bridge over its unix socket. Never blocks or fails
//!                           Claude Code: always exits 0, prints nothing, gives up after 150 ms.
//! - `ccpet-hook wait`       the mailbox waiter (an `asyncRewake` hook): long-polls the pet; a message is printed to stderr and
//!                           exit code 2 wakes the session with it. No pet, unknown session, claude gone: exits 0 quietly.
//! - `ccpet-hook statusline [--chain <base64url JSON>]`
//!                           Claude Code's status line: saves the plan limits for the pet and prints a short line (or, chained,
//!                           runs the user's own status line with the same input and prints its output).
//!
//! No dependencies beyond serde_json; one small static binary, so a waiter costs about a megabyte instead of a Node process.

use serde_json::{json, Map, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

mod http;
mod procs;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("wait") => wait_mode(),
        Some("statusline") => statusline_mode(&args[1..]),
        Some("--version") => println!("ccpet-hook {}", env!("CARGO_PKG_VERSION")),
        _ => event_mode(),
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

fn read_stdin() -> String {
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    s
}

// ---- hook events ----

fn event_mode() -> ! {
    // the whole hook gets 150 ms: a slow or missing pet must never hold Claude Code up
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(150));
        std::process::exit(0)
    });
    let input = read_stdin();
    let Ok(Value::Object(mut event)) = serde_json::from_str::<Value>(&input) else { std::process::exit(0) };
    // the chain claude -> sh -> hook: lets the pet find (and on request end) the claude process of this session
    let mut parents = vec![procs::parent_id()];
    for _ in 0..3 {
        let last = *parents.last().unwrap();
        if last <= 1 { break; }
        parents.push(procs::parent_of(last));
    }
    // set when claude was started through scripts/pet-claude.py: the pet can type into this very process
    if let Some(pty) = std::env::var("PET_PTY_SOCK").ok().filter(|p| !p.is_empty()) {
        event.insert("pet_pty".into(), Value::String(pty));
    }
    event.insert("pet_parents".into(), json!(parents.into_iter().filter(|p| *p > 1).collect::<Vec<_>>()));
    send_event(&Value::Object(event).to_string());
    std::process::exit(0)
}

#[cfg(unix)]
fn send_event(body: &str) {
    let path = std::env::var_os("CLAUDE_PET_SOCK").map(PathBuf::from).unwrap_or_else(|| home().join(".claude-pet").join("hook.sock"));
    if let Ok(mut s) = std::os::unix::net::UnixStream::connect(path) {
        let _ = s.write_all(body.as_bytes());
        let _ = s.shutdown(std::net::Shutdown::Write);
        let mut sink = [0u8; 64];
        let _ = s.read(&mut sink); // wait for the bridge to close, as the Node hook did
    }
}

#[cfg(not(unix))]
fn send_event(_body: &str) {
    // Windows sessions send their events to the pet with Claude Code's own `http` hooks
}

// ---- the mailbox waiter ----

fn valid_session(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

struct Hub { port: u16, token: String }

fn read_hub() -> Option<Hub> {
    let text = std::fs::read_to_string(home().join(".claude-pet").join("hub.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let port = v.get("port")?.as_u64().filter(|p| *p > 0 && *p < 65536)? as u16;
    let token = v.get("token").and_then(Value::as_str).unwrap_or("").to_string();
    Some(Hub { port, token })
}

fn env_ms(name: &str, default: u64) -> Duration {
    Duration::from_millis(std::env::var(name).ok().and_then(|v| v.parse().ok()).filter(|v| *v > 0).unwrap_or(default))
}

fn wait_mode() -> ! {
    let input = read_stdin();
    let sid = serde_json::from_str::<Value>(&input).ok().and_then(|v| v.get("session_id").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
    if !valid_session(&sid) || read_hub().is_none() { std::process::exit(0) }
    let parent = procs::parent_id();
    // `claude -p "…"` waits for its async hooks before exiting: a waiter there would hang it
    if procs::one_shot(parent) { std::process::exit(0) }
    // no answer (the pet is not running or restarting): try again later while claude lives, but give up after a while, so waiters do
    // not pile up while the pet is away (a new one starts at the session's next turn anyway)
    let retry = env_ms("CLAUDE_PET_WAIT_RETRY_MS", 10_000);
    let max_down = env_ms("CLAUDE_PET_WAIT_DOWN_MS", 600_000);
    let mut down_since: Option<Instant> = None;
    loop {
        if !procs::alive(parent) { std::process::exit(0) }
        let hub = match read_hub() { Some(h) if !h.token.is_empty() => Some(h), _ => None };
        let outcome = hub.map(|h| http::get("127.0.0.1", h.port, &format!("/mailbox/{}/{}", h.token, sid), Duration::from_secs(70)));
        match outcome {
            Some(Ok(r)) => {
                down_since = None;
                match r.status {
                    200 if !r.body.is_empty() => {
                        let _ = std::io::stderr().write_all(&r.body);
                        std::process::exit(2)
                    }
                    204 => continue,
                    _ => std::process::exit(0), // 409 (another waiter) or anything unexpected
                }
            }
            Some(Err(http::Error::Timeout)) => continue,
            _ => {
                let since = *down_since.get_or_insert_with(Instant::now);
                if since.elapsed() > max_down { std::process::exit(0) }
                std::thread::sleep(retry);
            }
        }
    }
}

// ---- the status line ----

/** One rate-limit window as stored: both numbers present and finite. */
fn window(w: Option<&Value>) -> Option<(f64, f64)> {
    let w = w?;
    let num = |v: Option<&Value>| -> Option<f64> {
        match v? {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
        .filter(|f| f.is_finite())
    };
    Some((num(w.get("used_percentage"))?, num(w.get("resets_at"))?))
}

/** A number as JavaScript would write it: 23, not 23.0. */
fn js_num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.0e15 { json!(f as i64) } else { json!(f) }
}

fn window_json(w: Option<(f64, f64)>) -> Value {
    match w {
        Some((used, resets)) => json!({ "used_percentage": js_num(used), "resets_at": js_num(resets) }),
        None => Value::Null,
    }
}

/** Other sessions re-render their line with the numbers of their last API response: within one window (same reset time) usage only grows,
 *  so a lower value is stale and the saved one stays; a later reset time is a new window. */
fn keep(new: Option<(f64, f64)>, old: Option<(f64, f64)>) -> Option<(f64, f64)> {
    match (new, old) {
        (None, o) => o,
        (n, None) => n,
        (Some(n), Some(o)) if o.1 != n.1 => Some(if o.1 > n.1 { o } else { n }),
        (Some(n), Some(o)) => Some(if o.0 > n.0 { o } else { n }),
    }
}

fn base64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn statusline_mode(args: &[String]) -> ! {
    let usage_file = std::env::var_os("CLAUDE_PET_USAGE").map(PathBuf::from).unwrap_or_else(|| home().join(".claude-pet").join("usage.json"));
    // `--chain <base64url JSON>`: the user's own statusLine, wrapped by the pet. Store the limits, then run it with the same input and print ITS output.
    let chain_at = args.iter().position(|a| a == "--chain");
    let chained: Option<Value> = chain_at.map(|i| {
        args.get(i + 1).and_then(|s| base64url_decode(s)).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}))
    });
    let input = read_stdin();
    if let Ok(event) = serde_json::from_str::<Value>(&input) {
        let rl = event.get("rate_limits");
        let (five, seven) = (window(rl.and_then(|r| r.get("five_hour"))), window(rl.and_then(|r| r.get("seven_day"))));
        if five.is_some() || seven.is_some() {
            let saved: Option<Value> = std::fs::read_to_string(&usage_file).ok().and_then(|t| serde_json::from_str(&t).ok());
            let five2 = keep(five, window(saved.as_ref().and_then(|s| s.get("five_hour"))));
            let seven2 = keep(seven, window(saved.as_ref().and_then(|s| s.get("seven_day"))));
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let mut out = Map::new();
            out.insert("version".into(), json!(1));
            out.insert("updatedAt".into(), json!(now));
            out.insert("five_hour".into(), window_json(five2));
            out.insert("seven_day".into(), window_json(seven2));
            let _ = write_private_atomic(&usage_file, Value::Object(out).to_string().as_bytes());
            if chained.is_none() {
                let p = |w: (f64, f64)| format!("{}%", w.0.round() as i64);
                let parts: Vec<String> = [five2.map(|w| format!("5h {}", p(w))), seven2.map(|w| format!("7d {}", p(w)))].into_iter().flatten().collect();
                println!("{}", parts.join(" · "));
            }
        }
    }
    if let Some(cmd) = chained.as_ref().and_then(|c| c.get("command")).and_then(Value::as_str).filter(|c| !c.is_empty()) {
        if let Some(out) = run_shell(cmd, &input, Duration::from_secs(4)) {
            let _ = std::io::stdout().write_all(&out);
        }
    }
    let _ = std::io::stdout().flush();
    std::process::exit(0)
}

/** Written to a temp file then renamed, so the bridge never reads half a file; 0600 in a 0700 folder. */
fn write_private_atomic(file: &PathBuf, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(&tmp)?.write_all(data)?;
    std::fs::rename(&tmp, file)
}

/** The user's own status line: run through the shell with the same input; nothing if it fails or runs over `limit`. */
fn run_shell(cmd: &str, input: &str, limit: Duration) -> Option<Vec<u8>> {
    use std::process::{Command, Stdio};
    #[cfg(unix)]
    let mut c = Command::new("/bin/sh");
    #[cfg(unix)]
    c.arg("-c").arg(cmd);
    #[cfg(not(unix))]
    let mut c = Command::new("cmd.exe");
    #[cfg(not(unix))]
    c.arg("/d").arg("/s").arg("/c").arg(cmd);
    let mut child = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let data = input.as_bytes().to_vec();
    std::thread::spawn(move || { let _ = stdin.write_all(&data); });
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || { let mut b = Vec::new(); let _ = stdout.read_to_end(&mut b); b });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(10)),
            _ => { let _ = child.kill(); let _ = child.wait(); return None; }
        }
    }
    reader.join().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids() {
        assert!(valid_session("abc-DEF_123"));
        assert!(!valid_session(""));
        assert!(!valid_session("a/b"));
        assert!(!valid_session(&"a".repeat(101)));
    }

    #[test]
    fn keeps_the_newer_window() {
        assert_eq!(keep(Some((10.0, 100.0)), Some((30.0, 100.0))), Some((30.0, 100.0))); // same window: the higher use stays
        assert_eq!(keep(Some((5.0, 200.0)), Some((90.0, 100.0))), Some((5.0, 200.0))); // a later reset: a new window
        assert_eq!(keep(None, Some((1.0, 2.0))), Some((1.0, 2.0)));
    }

    #[test]
    fn numbers_as_javascript_writes_them() {
        assert_eq!(js_num(23.0).to_string(), "23");
        assert_eq!(js_num(23.5).to_string(), "23.5");
    }

    #[test]
    fn base64url() {
        assert_eq!(base64url_decode("eyJhIjoxfQ").unwrap(), b"{\"a\":1}");
        assert_eq!(base64url_decode("_-8").unwrap(), vec![0xff, 0xef]);
    }
}
