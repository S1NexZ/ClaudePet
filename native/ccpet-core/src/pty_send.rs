//! Typing into a `pet-claude.py` PTY socket: prompts, Esc, terminal titles (ptySend.ts).

use crate::i18n::l;
#[cfg(unix)]
use std::io::Read;
use std::io::Write;
use std::time::Duration;

pub const ENTER: &str = "\r";
pub const ESC: &str = "\x1b";

/** Drops control characters that could act as keystrokes (Esc, Ctrl+C, ...); keeps newlines and tabs. */
pub fn sanitize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").chars().filter(|c| !matches!(*c, '\x00'..='\x08' | '\x0b'..='\x1f' | '\x7f')).collect()
}

/** What to write to the PTY to type `text`; multi-line text goes in as a bracketed paste. Empty text gives an empty body. */
pub fn typed_input(text: &str) -> String {
    let t = sanitize(text).trim().to_string();
    if t.contains('\n') { format!("\x1b[200~{t}\x1b[201~") } else { t }
}

#[derive(Debug)]
pub struct PtyGone;
impl std::fmt::Display for PtyGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&l("Сокет терминальной сессии недоступен: окно закрыто или Claude завершился",
            "The terminal session socket is unavailable: the window was closed or Claude exited",
            "终端会话套接字不可用：窗口已关闭或 Claude 已退出"))
    }
}
impl std::error::Error for PtyGone {}

/** Writes chunks to the socket, pausing between them (the TUI treats a lone Enter after the text as "submit"). */
#[cfg(unix)]
pub fn write_pty(sock: &str, chunks: &[&str], gap_ms: u64) -> Result<(), PtyGone> {
    let mut c = std::os::unix::net::UnixStream::connect(sock).map_err(|_| PtyGone)?;
    // the wrapper streams its output to every client; we only write, so drain it in the background to never block it
    if let Ok(mut r) = c.try_clone() { std::thread::spawn(move || { let mut b = [0u8; 4096]; while r.read(&mut b).map_or(false, |n| n > 0) {} }); }
    for (i, ch) in chunks.iter().enumerate() {
        if i > 0 { std::thread::sleep(Duration::from_millis(gap_ms)); }
        c.write_all(ch.as_bytes()).map_err(|_| PtyGone)?;
    }
    std::thread::sleep(Duration::from_millis(40)); // let the wrapper read the last chunk before the connection closes
    // shutdown (not just drop): the draining clone would otherwise keep the connection open
    let _ = c.shutdown(std::net::Shutdown::Both);
    Ok(())
}
/** The Windows wrapper's pipe (hookHttp.ts PIPE_NAME): `\\.\pipe\claude-pet-<1..10 digits>`. */
pub fn is_pipe_name(s: &str) -> bool {
    s.strip_prefix(r"\\.\pipe\claude-pet-").map_or(false, |d| (1..=10).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit()))
}

/** Same as the unix path over a named pipe. shortcut: no output drain (a blocking read on a synchronous handle would stall our writes), fine for a short-lived connection. */
#[cfg(windows)]
pub fn write_pty(sock: &str, chunks: &[&str], gap_ms: u64) -> Result<(), PtyGone> {
    if !is_pipe_name(sock) { return Err(PtyGone); }
    let mut c = std::fs::OpenOptions::new().read(true).write(true).open(sock).map_err(|_| PtyGone)?;
    for (i, ch) in chunks.iter().enumerate() {
        if i > 0 { std::thread::sleep(Duration::from_millis(gap_ms)); }
        c.write_all(ch.as_bytes()).map_err(|_| PtyGone)?;
    }
    std::thread::sleep(Duration::from_millis(40)); // let the helper read the last chunk before the handle closes
    Ok(())
}
#[cfg(not(any(unix, windows)))]
pub fn write_pty(_sock: &str, _chunks: &[&str], _gap_ms: u64) -> Result<(), PtyGone> { Err(PtyGone) }

pub fn send_prompt(sock: &str, text: &str, gap_ms: u64) -> Result<(), PtyGone> {
    let body = typed_input(text);
    if body.is_empty() { return Ok(()); }
    write_pty(sock, &[&body, ENTER], gap_ms)
}
pub fn send_esc(sock: &str) -> Result<(), PtyGone> { write_pty(sock, &[ESC], 300) }

/** OSC title the pet writes so it can find the terminal window of a session. */
pub fn title_chunk(title: &str) -> String {
    let t: String = sanitize(title).replace(['\n', '\t'], " ").chars().take(120).collect();
    format!("\x1b]ccpet-title;{t}\x07")
}

/** Windows wrapper: titles the terminal window/tab so the pet can raise it (sendTitle). */
pub fn send_title(sock: &str, title: &str) -> Result<(), PtyGone> { write_pty(sock, &[&title_chunk(title)], 300) }

#[cfg(test)]
mod name_tests {
    use super::is_pipe_name;
    #[test]
    fn pipe_names() {
        assert!(is_pipe_name(r"\\.\pipe\claude-pet-1"));
        assert!(is_pipe_name(r"\\.\pipe\claude-pet-1234567890"));
        for bad in [r"\\.\pipe\claude-pet-", r"\\.\pipe\claude-pet-12345678901", r"\\.\pipe\claude-pet-1a", r"\\.\pipe\claude-pet-1\x", r"\\.\pipe\other-1", "/tmp/x.sock", ""] { assert!(!is_pipe_name(bad), "{bad}"); }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn sanitizes_and_pastes() {
        assert_eq!(sanitize("a\x1bb\x03c\r\nd\te\rf"), "abc\nd\te\nf");
        assert_eq!(typed_input("  hi  "), "hi");
        assert_eq!(typed_input("a\nb"), "\x1b[200~a\nb\x1b[201~");
        assert_eq!(typed_input("\x1b\x03"), "");
        assert_eq!(title_chunk("a\tb\nc"), "\x1b]ccpet-title;a b c\x07");
    }

    #[test]
    fn types_into_a_socket_and_reports_a_dead_one() {
        let p = std::env::temp_dir().join(format!("ccpet-pty-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&p);
        let ls = UnixListener::bind(&p).unwrap();
        let t = std::thread::spawn(move || { let (mut s, _) = ls.accept().unwrap(); let mut b = String::new(); s.read_to_string(&mut b).unwrap(); b });
        send_prompt(p.to_str().unwrap(), "hello\x1b", 10).unwrap();
        assert_eq!(t.join().unwrap(), "hello\r");
        assert!(send_prompt(p.to_str().unwrap(), "x", 10).is_err());
        assert!(send_prompt("/nonexistent/x.sock", "", 10).is_ok(), "nothing to type, nothing to connect");
    }
}
