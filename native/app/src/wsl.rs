//! One bridge process in a WSL distro (`ui/src/hub/wslHost.ts`): `wsl.exe … ccpet-bridge`, JSON lines over stdio, restarted with a growing back-off.

use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
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
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    stopped: AtomicBool,
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

impl WslHost {
    pub fn start(bridge_win_path: String, exports: Vec<(String, String)>, ev: Arc<dyn HostEvents>) -> Arc<WslHost> {
        let host = Arc::new(WslHost { stdin: Mutex::new(None), child: Mutex::new(None), stopped: AtomicBool::new(false) });
        let h = host.clone();
        std::thread::spawn(move || {
            let mut backoff = 1000u64;
            while !h.stopped.load(Ordering::SeqCst) {
                let mut cmd = Command::new("wsl.exe");
                cmd.args(["-e", "bash", "-c", &script(&to_wsl_path(&bridge_win_path), &exports)])
                    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(windows)]
                { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
                match cmd.spawn() {
                    Ok(mut child) => {
                        *h.stdin.lock().unwrap() = child.stdin.take();
                        let out = child.stdout.take().unwrap();
                        let err = child.stderr.take().unwrap();
                        *h.child.lock().unwrap() = Some(child);
                        let ev2 = ev.clone();
                        std::thread::spawn(move || {
                            for l in BufReader::new(err).lines().map_while(Result::ok) { ev2.log(&format!("bridge wsl stderr: {}", l.chars().take(500).collect::<String>())); }
                        });
                        for line in BufReader::new(out).lines().map_while(Result::ok) {
                            let Ok(m) = serde_json::from_str::<Value>(line.trim_end_matches('\r')) else { continue };
                            if m.get("type").and_then(Value::as_str) == Some("ready") {
                                backoff = 1000;
                                ev.log(&format!("bridge wsl ready (claude={}, distro={})", m["claude"], m["distro"]));
                                ev.up(true);
                                ev.ready(m["claude"].as_str().unwrap_or(""));
                                continue;
                            }
                            ev.message(m);
                        }
                        let code = h.child.lock().unwrap().take().and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
                        *h.stdin.lock().unwrap() = None;
                        ev.log(&format!("bridge wsl exited ({code:?})"));
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
        if let Some(w) = self.stdin.lock().unwrap().as_mut() { let _ = writeln!(w, "{cmd}"); let _ = w.flush(); }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_and_script() {
        assert_eq!(to_wsl_path(r"C:\ClaudePet-v2\build\hook\ccpet-bridge"), "/mnt/c/ClaudePet-v2/build/hook/ccpet-bridge");
        assert_eq!(script("/a/it's", &[("X".into(), "$HOME/1".into())]), r#"export X="$HOME/1"; B='/a/it'\''s'; exec "$B""#);
    }
}
