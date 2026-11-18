//! ccPet's bridge for WSL, Linux and macOS: JSON lines on stdin/stdout to the app, a unix socket for the hooks, a loopback HTTP receiver
//! (mailbox long-poll, permission answers). Closing the app (stdin EOF) ends it; it never touches Claude Code's processes.

use ccpet_core::bridge::{Bridge, BridgeOpts};
use ccpet_core::hook_http::{HookServer, HookServerOpts};
use ccpet_core::hook_socket::{default_socket_path, HookSocket};
use ccpet_core::install::is_pet_status_line;
use ccpet_core::paths::pet_dir;
use ccpet_core::types::HookEvent;
use ccpet_core::live_usage::{claude_fetch, LivePoller};
use ccpet_core::runner::SessionRunner;
use ccpet_core::usage::{default_usage_path, now_ms, LiveSource, UsageSource};
use ccpet_core::{adopt, mailbox::Mailbox};
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn home() -> PathBuf { PathBuf::from(std::env::var_os("HOME").unwrap_or_default()) }

fn send(v: &Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

fn find_claude() -> Option<PathBuf> {
    let h = home();
    let env = std::env::var_os("CLAUDE_PET_CLAUDE_BIN").map(PathBuf::from);
    let found = env.into_iter().chain([".local/bin/claude", ".claude/local/claude", ".npm-global/bin/claude", ".bun/bin/claude"].map(|p| h.join(p)))
        .chain(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map(PathBuf::from)).find(|p| p.exists());
    if found.is_some() { return found; }
    let sh = std::env::var("SHELL").ok().filter(|s| ["bash", "zsh", "sh", "dash"].iter().any(|n| s.ends_with(&format!("/{n}")))).unwrap_or("bash".into());
    let o = std::process::Command::new(sh).args(["-lc", "command -v claude"]).stderr(std::process::Stdio::null()).output().ok()?;
    let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (!p.is_empty()).then(|| PathBuf::from(p))
}

fn random_token() -> String {
    let mut b = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        let t = now_ms() as u128 * 6364136223846793005 ^ std::process::id() as u128;
        b.copy_from_slice(&t.to_le_bytes());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/** The hook binary Claude Code should run: a copy in `~/.claude-pet/bin` that outlives this install path (a running waiter keeps the old file busy: rename over it). */
fn stable_hook() -> String {
    if let Ok(p) = std::env::var("CLAUDE_PET_HOOK") { return p; }
    let dst = pet_dir().join("bin").join("ccpet-hook");
    let src = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("../hook/ccpet-hook").to_path_buf()).or(None)).filter(|p| p.exists())
        .or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("ccpet-hook"))).filter(|p| p.exists()));
    if let Some(src) = src {
        let same = std::fs::read(&src).ok().zip(std::fs::read(&dst).ok()).map_or(false, |(a, b)| a == b);
        if !same {
            let tmp = dst.with_extension(format!("{}.tmp", std::process::id()));
            let ok = std::fs::create_dir_all(dst.parent().unwrap()).and_then(|_| std::fs::copy(&src, &tmp)).and_then(|_| {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
                std::fs::rename(&tmp, &dst)
            }).is_ok();
            if !ok { return src.to_string_lossy().into_owned(); }
        }
    }
    dst.to_string_lossy().into_owned()
}

fn hub_token(file: &Path) -> String {
    std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|j| j.get("token").and_then(Value::as_str).map(String::from))
        .filter(|t| t.len() >= 16 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).unwrap_or_else(random_token)
}

fn main() {
    // the app asks this before relying on the binary (a build for another system or processor fails it)
    if std::env::args().nth(1).as_deref() == Some("--version") { println!("ccpet-bridge {}", env!("CARGO_PKG_VERSION")); return; }
    let claude = find_claude();
    let settings = home().join(".claude").join("settings.json");
    let hub_file = pet_dir().join("hub.json");
    let port: u16 = std::env::var("CLAUDE_PET_HOOK_PORT").ok().and_then(|p| p.parse().ok()).filter(|p| *p != 0).unwrap_or(47822);
    let token = hub_token(&hub_file);
    let mailbox = Arc::new(Mailbox::new());

    let mut o = BridgeOpts::new(Box::new(|v| send(&v)), settings.clone(), &stable_hook());
    o.mailbox = mailbox.clone();
    // the limits query runs only when the user clicks the ring (never on a timer, never at start); CLAUDE_PET_LIVE_USAGE=0 removes it.
    // The ring is otherwise fed by Claude Code's own status line
    let live_on = std::env::var("CLAUDE_PET_LIVE_USAGE").map_or(true, |v| v != "0");
    let poller = claude.clone().filter(|_| live_on).map(|c| LivePoller::new(claude_fetch(c, pet_dir().join("usage-query"), Duration::from_secs(25)), Duration::from_secs(60)));
    let live: Option<Box<dyn LiveSource + Send>> = poller.clone().map(|p| Box::new(p) as Box<dyn LiveSource + Send>);
    o.usage = Some(UsageSource::new(default_usage_path(), settings, claude.clone(), live, is_pet_status_line));
    o.host_hooks = Some((format!("http://127.0.0.1:{port}"), token.clone()));
    let bridge = Bridge::new(o);
    if let Some(p) = &poller { let b = bridge.clone(); p.set_notify(move || b.push_usage()); }
    let runner = SessionRunner::new(Arc::new(bridge.clone()), claude.clone());
    bridge.set_runner(Arc::new(runner));

    let (b1, b2, b3) = (bridge.clone(), bridge.clone(), bridge.clone());
    let http = HookServer::start(HookServerOpts {
        port, token: token.clone(), mailbox, wait_ms: 50_000,
        on_event: Box::new(move |e| b1.on_hook(e)),
        on_waiter: Some(Box::new(move |sid, cwd, src| {
            // the session exists even if its SessionStart never arrived
            if !b2.has_session(sid) { b2.on_hook(HookEvent::new("SessionStart", sid, cwd)); }
            let _ = src;
        })),
        on_permission: Some(Box::new(move |e, gone| b3.on_permission(e, gone))),
        on_reply: None,
    });
    let http = match http {
        Ok(h) => {
            let _ = std::fs::create_dir_all(pet_dir());
            let _ = std::fs::write(&hub_file, json!({ "port": h.port, "token": token }).to_string());
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&hub_file, std::fs::Permissions::from_mode(0o600)); }
            Some(h)
        }
        Err(e) => { eprintln!("hook http receiver unavailable: {e}"); None }
    };

    let b = bridge.clone();
    let sock = match HookSocket::listen(&default_socket_path(), move |e| b.on_hook(e)) {
        Ok(s) => s,
        Err(e) => { send(&json!({ "type": "error", "message": e.to_string() })); std::process::exit(1); }
    };
    send(&json!({ "type": "ready", "claude": claude.as_ref().map(|c| c.to_string_lossy().into_owned()), "distro": std::env::var("WSL_DISTRO_NAME").unwrap_or_default() }));
    bridge.snapshot(false);

    // sessions that are probably running although no hook told us (the pet started later): recently written transcripts
    let b = bridge.clone();
    std::thread::spawn(move || {
        let projects = home().join(".claude").join("projects");
        let mut adopted = std::collections::HashSet::new();
        let mut last_adopt = 0;
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let now = now_ms();
            b.tick(now);
            if now - last_adopt > 15_000 {
                last_adopt = now;
                for r in adopt::find_running(&projects, now, 10 * 60_000) {
                    if adopted.contains(&r.id) || b.has_session(&r.id) { continue; }
                    adopted.insert(r.id.clone());
                    let mut e = HookEvent::new("SessionStart", &r.id, &r.cwd);
                    e.transcript_path = Some(r.path.to_string_lossy().into_owned());
                    b.on_hook(e);
                }
            }
        }
    });

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if let Ok(cmd) = serde_json::from_str::<Value>(&line) { bridge.handle(&cmd); }
    }
    // the app went away
    bridge.close_runner();
    sock.close();
    if let Some(h) = http { h.close(); }
}
