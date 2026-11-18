//! The unix socket hooks write to: one JSON document per connection (hookSocket.ts).

use crate::paths::pet_dir;
use crate::types::HookEvent;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MAX: u64 = 1_000_000;

pub fn default_socket_path() -> PathBuf { std::env::var_os("CLAUDE_PET_SOCK").map(PathBuf::from).unwrap_or_else(|| pet_dir().join("hook.sock")) }

pub struct HookSocket { path: PathBuf, stop: Arc<AtomicBool> }

impl HookSocket {
    /** Another live bridge on the same socket is an error; a stale socket file from a crash is replaced. */
    pub fn listen(path: &Path, on_event: impl Fn(HookEvent) + Send + Sync + 'static) -> std::io::Result<HookSocket> {
        if UnixStream::connect(path).is_ok() { return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, format!("ccPet bridge is already running ({})", path.display()))); }
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
            let _ = std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700));
        }
        let _ = std::fs::remove_file(path);
        let ls = UnixListener::bind(path)?;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        let stop = Arc::new(AtomicBool::new(false));
        let on_event = Arc::new(on_event);
        let st = stop.clone();
        std::thread::spawn(move || {
            for conn in ls.incoming() {
                if st.load(Ordering::Relaxed) { break; }
                let Ok(mut c) = conn else { continue };
                let cb = on_event.clone();
                std::thread::spawn(move || {
                    let _ = c.set_read_timeout(Some(Duration::from_secs(10)));
                    let mut body = Vec::new();
                    if c.by_ref().take(MAX + 1).read_to_end(&mut body).is_err() || body.len() as u64 > MAX { return; }
                    if let Some(e) = serde_json::from_slice(&body).ok().and_then(|v| HookEvent::from_value(v, None)) { cb(e); }
                });
            }
        });
        Ok(HookSocket { path: path.to_path_buf(), stop })
    }

    pub fn close(self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = UnixStream::connect(&self.path); // wakes the accept loop
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::mpsc;

    #[test]
    fn receives_events_ignores_junk_and_refuses_a_second_listener() {
        let p = std::env::temp_dir().join(format!("ccpet-hs-{}", std::process::id())).join("hook.sock");
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let hs = HookSocket::listen(&p, move |e| { let _ = tx.lock().unwrap().send(e); }).unwrap();
        let send = |s: &str| { let mut c = UnixStream::connect(&p).unwrap(); c.write_all(s.as_bytes()).unwrap(); };
        send("not json");
        send(r#"{"session_id":"s1"}"#); // no event name
        send(r#"{"session_id":"s1","hook_event_name":"Stop","cwd":5}"#);
        let e = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!((e.session_id.as_str(), e.hook_event_name.as_str(), e.cwd.as_str()), ("s1", "Stop", ""));
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "junk produced no event");
        assert_eq!(HookSocket::listen(&p, |_| {}).err().map(|e| e.kind()), Some(std::io::ErrorKind::AddrInUse));
        hs.close();
        assert!(!p.exists());
    }
}
