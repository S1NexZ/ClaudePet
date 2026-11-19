//! One bridge process in a WSL distro (`ui/src/hub/wslHost.ts`): `wsl.exe … ccpet-bridge`, JSON lines over stdio, restarted with a growing back-off.

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{channel, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub trait HostEvents: Send + Sync + 'static {
    /** the bridge said hello (`claude` = the CLI it found, '' = none) */
    fn ready(&self, claude: &str);
    fn up(&self, up: bool);
    fn message(&self, m: Value);
    fn log(&self, line: &str);
}

pub struct WslHost {
    /** commands go through a writer thread: a full pipe never blocks the caller (the UI thread) */
    stdin: Mutex<Option<Sender<String>>>,
    child: Mutex<Option<Child>>,
    stopped: AtomicBool,
    up: AtomicBool,
    claude: Mutex<String>,
    /** the distro's real name once the bridge said hello */
    distro: Mutex<String>,
    /** answers come back in the order the commands went out: one FIFO per answer type; a timed-out request keeps its place so its late answer is dropped */
    waiters: Mutex<HashMap<String, VecDeque<Sender<Value>>>>,
    marks: Mutex<HashMap<String, Sender<bool>>>,
}

/** `C:\a\b` -> `/mnt/c/a/b` (daemon/src/paths.ts toWslPath) */
pub fn to_wsl_path(p: &str) -> String {
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        format!("/mnt/{}{}", (b[0] as char).to_ascii_lowercase(), p[2..].replace('\\', "/"))
    } else {
        p.replace('\\', "/")
    }
}

fn sq(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }

/** the bash script `wsl.exe -e bash -c` runs: optional exports, then the native bridge */
pub fn script(bridge_wsl: &str, exports: &[(String, String)]) -> String {
    let mut s = String::new();
    // values are the app's own constants; double quotes so `$HOME` expands
    for (k, v) in exports { s.push_str(&format!("export {}=\"{}\"; ", k, v.replace(['"', '\\', '`'], ""))); }
    s.push_str(&format!("B={}; exec \"$B\"", sq(bridge_wsl)));
    s
}

/** every line until EOF; bytes that are not UTF-8 never stop the reading (a stalled pipe would hang the bridge) */
fn each_line(r: impl Read, mut f: impl FnMut(&str)) {
    let mut r = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => { let l = String::from_utf8_lossy(&buf); let l = l.trim_end_matches(['\n', '\r']); if !l.is_empty() { f(l); } }
        }
    }
}

impl WslHost {
    /** `distro` '' = the default one */
    pub fn start(distro: String, bridge_win_path: String, exports: Vec<(String, String)>, ev: Arc<dyn HostEvents>) -> Arc<WslHost> {
        let host = Arc::new(WslHost { stdin: Mutex::new(None), child: Mutex::new(None), stopped: AtomicBool::new(false), up: AtomicBool::new(false), claude: Mutex::new(String::new()), distro: Mutex::new(String::new()), waiters: Mutex::new(HashMap::new()), marks: Mutex::new(HashMap::new()) });
        let h = host.clone();
        std::thread::spawn(move || {
            let mut backoff = 1000u64;
            while !h.stopped.load(Ordering::SeqCst) {
                let mut cmd = Command::new("wsl.exe");
                if !distro.is_empty() { cmd.args(["-d", &distro]); }
                cmd.args(["-e", "bash", "-c", &script(&to_wsl_path(&bridge_win_path), &exports)])
                    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(windows)]
                { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
                match cmd.spawn() {
                    Ok(mut child) => {
                        let mut w = child.stdin.take().unwrap();
                        let (tx, rx) = channel::<String>();
                        std::thread::spawn(move || { for line in rx { if writeln!(w, "{line}").and_then(|_| w.flush()).is_err() { break; } } }); // ends (stdin EOF) when the sender goes
                        *h.stdin.lock().unwrap() = Some(tx);
                        let out = child.stdout.take().unwrap();
                        let err = child.stderr.take().unwrap();
                        *h.child.lock().unwrap() = Some(child);
                        let ev2 = ev.clone();
                        std::thread::spawn(move || {
                            each_line(err, |l| ev2.log(&format!("bridge wsl stderr: {}", l.chars().take(500).collect::<String>())));
                        });
                        each_line(out, |line| {
                            let Ok(m) = serde_json::from_str::<Value>(line) else { return };
                            if m.get("type").and_then(Value::as_str) == Some("ready") {
                                backoff = 1000;
                                ev.log(&format!("bridge wsl ready (claude={}, distro={})", m["claude"], m["distro"]));
                                *h.claude.lock().unwrap() = m["claude"].as_str().unwrap_or("").to_string();
                                *h.distro.lock().unwrap() = m["distro"].as_str().unwrap_or("").to_string();
                                h.up.store(true, Ordering::SeqCst);
                                ev.up(true);
                                ev.ready(m["claude"].as_str().unwrap_or(""));
                                return;
                            }
                            let t = m["type"].as_str().unwrap_or("").to_string();
                            if t == "termMark" {
                                if let Some(w) = h.marks.lock().unwrap().remove(m["sessionId"].as_str().unwrap_or("")) { let _ = w.send(m["ok"] == true); }
                                return;
                            }
                            if t == "hooks" || t == "statusline" {
                                let w = { let mut ws = h.waiters.lock().unwrap(); let q = ws.entry(t.clone()).or_default(); let w = q.pop_front(); if q.is_empty() { ws.remove(&t); } w };
                                if let Some(w) = w { let _ = w.send(m); return; } // a dropped receiver (timed out): the late answer goes nowhere
                                if t == "statusline" { return; }
                            }
                            ev.message(m);
                        });
                        let code = h.child.lock().unwrap().take().and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
                        *h.stdin.lock().unwrap() = None;
                        ev.log(&format!("bridge wsl exited ({code:?})"));
                        h.up.store(false, Ordering::SeqCst);
                        h.waiters.lock().unwrap().clear();
                        h.marks.lock().unwrap().clear();
                        ev.up(false);
                    }
                    Err(e) => ev.log(&format!("bridge wsl spawn error: {e}")),
                }
                std::thread::sleep(Duration::from_millis(backoff));
                backoff = (backoff * 2).min(10_000);
            }
        });
        host
    }

    pub fn send(&self, cmd: &Value) {
        if let Some(tx) = self.stdin.lock().unwrap().as_ref() { let _ = tx.send(cmd.to_string()); }
    }

    pub fn is_up(&self) -> bool { self.up.load(Ordering::SeqCst) }
    pub fn claude(&self) -> String { self.claude.lock().unwrap().clone() }
    pub fn distro(&self) -> String { self.distro.lock().unwrap().clone() }

    /** a command and its answer of `reply` type ('hooks' / 'statusline'); None: no answer in 4 s or the bridge is down */
    pub fn request(&self, cmd: &Value, reply: &str) -> Option<Value> {
        if !self.is_up() { return None; }
        let (tx, rx) = channel();
        self.waiters.lock().unwrap().entry(reply.into()).or_default().push_back(tx);
        self.send(cmd);
        rx.recv_timeout(Duration::from_secs(4)).ok()
    }

    /** give the session's terminal tab a recognisable title (false: no live terminal) */
    pub fn mark_terminal(&self, session_id: &str, text: &str) -> bool {
        if !self.is_up() { return false; }
        let (tx, rx) = channel();
        self.marks.lock().unwrap().insert(session_id.into(), tx);
        self.send(&serde_json::json!({ "type": "term-mark", "sessionId": session_id, "text": text }));
        let ok = rx.recv_timeout(Duration::from_secs(3)).unwrap_or(false);
        self.marks.lock().unwrap().remove(session_id);
        ok
    }

    /** stdin EOF: the bridge exits by itself (it never kills Claude Code) */
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.stdin.lock().unwrap().take();
        if let Some(mut c) = self.child.lock().unwrap().take() {
            std::thread::sleep(Duration::from_millis(500));
            let _ = c.kill();
        }
    }
}

pub struct Distro { pub name: String, pub running: bool, pub is_default: bool, pub version: u32 }

/** `wsl.exe -l -v` output (already decoded from UTF-16) -> distros; the default one is marked with `*` (wslHost.ts parseDistroList) */
pub fn parse_distro_list(text: &str) -> Vec<Distro> {
    let text = text.replace('\0', "");
    text.lines().skip(1).filter_map(|raw| {
        let l = raw.trim_end();
        let (is_default, rest) = match l.trim_start().strip_prefix('*') { Some(r) => (true, r.trim_start()), None => (false, l.trim_start()) };
        let (head, version) = rest.rsplit_once(char::is_whitespace)?;
        let version: u32 = version.parse().ok().filter(|_| version.len() == 1)?;
        let (name, state) = head.trim_end().rsplit_once(char::is_whitespace)?;
        let name = name.trim_end();
        // the name is separated from the state by at least two spaces
        if name.is_empty() || !head.trim_end()[name.len()..].starts_with("  ") { return None; }
        Some(Distro { name: name.into(), running: state.eq_ignore_ascii_case("running"), is_default, version })
    }).collect()
}

/** distros worth following besides the default: running WSL 2 ones (a stopped one is never started), not Docker's internal ones */
pub fn secondary_distros(list: &[Distro]) -> Vec<String> {
    list.iter().filter(|d| d.running && !d.is_default && d.version == 2 && !d.name.to_lowercase().starts_with("docker-desktop")).map(|d| d.name.clone()).collect()
}

/** a stable port per distro name in 47900-47999; `taken` ports are skipped (portForDistro) */
pub fn port_for_distro(name: &str, taken: &[u16]) -> u16 {
    let mut h: u32 = 0;
    for ch in name.encode_utf16() { h = h.wrapping_mul(31).wrapping_add(ch as u32); }
    let mut p = 47900 + (h % 100) as u16;
    while taken.contains(&p) { p = if p >= 47999 { 47900 } else { p + 1 }; }
    p
}

#[cfg(test)]
mod tests {
    #[test]
    fn distro_list() {
        let t = "  NAME                   STATE           VERSION\r\n* Ubuntu                 Running         2\r\n  Debian                 Stopped         2\r\n  My Distro              Running         2\r\n  docker-desktop         Running         2\r\n  Old                    Running         1\r\n";
        let l = super::parse_distro_list(t);
        assert_eq!(l.len(), 5);
        assert!(l[0].is_default && l[0].running && l[0].name == "Ubuntu");
        assert_eq!(l[2].name, "My Distro");
        assert_eq!(super::secondary_distros(&l), vec!["My Distro".to_string()]);
        let p = super::port_for_distro("Debian", &[]);
        assert!((47900..=47999).contains(&p));
        assert_ne!(super::port_for_distro("Debian", &[p]), p);
    }
    use super::*;
    #[test]
    fn paths_and_script() {
        assert_eq!(to_wsl_path(r"C:\ClaudePet-v2\build\hook\ccpet-bridge"), "/mnt/c/ClaudePet-v2/build/hook/ccpet-bridge");
        assert_eq!(script("/a/it's", &[("X".into(), "$HOME/1".into())]), r#"export X="$HOME/1"; B='/a/it'\''s'; exec "$B""#);
    }
}
