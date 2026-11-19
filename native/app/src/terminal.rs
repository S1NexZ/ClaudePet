//! Opening terminals (wt.exe / cmd.exe) and the PowerShell profile `claude` wrapper block.
//! Port of ui/src/terminal.ts (Windows parts), ui/src/psProfile.ts and ui/src/psLine.ts. Commands are returned as data (`Launch`).
//! No folder, prompt or path ever goes on a wt.exe / cmd.exe command line except as a plain token; the WSL script travels base64-encoded.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub file: String,
    pub args: Vec<String>,
    /// working directory for the spawned wt.exe / cmd.exe
    pub cwd: Option<String>,
}

fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn safe(what: &str, v: &str) -> Result<String, String> {
    let ok = !v.is_empty() && v.len() <= 128 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-');
    if ok { Ok(v.to_string()) } else { Err(format!("unsafe {what}: {v:?}")) }
}

fn strs(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

/// `bash -lc` that runs `script` without exposing any of its characters to wt.exe or cmd.exe (no quotes, no ';')
pub fn encoded_bash(script: &str) -> Vec<String> {
    vec!["bash".into(), "-lc".into(), format!("source <(echo {} | base64 -d)", STANDARD.encode(script.as_bytes()))]
}

fn wsl(distro: &str, script: &str) -> Result<Vec<String>, String> {
    let mut v = strs(&["wsl.exe"]);
    if !distro.is_empty() {
        v.push("-d".into());
        v.push(safe("distro", distro)?);
    }
    v.push("--exec".into());
    v.extend(encoded_bash(script));
    Ok(v)
}

fn launch(windows_terminal: bool, run: Vec<String>, cwd: Option<&str>) -> Launch {
    let cwd = cwd.filter(|c| !c.is_empty());
    let mut args = if windows_terminal { strs(&["-w", "new"]) } else { strs(&["/c", "start", "\"\""]) };
    if cwd.is_some() {
        args.extend(strs(if windows_terminal { &["-d", "."] } else { &["/D", "."] }));
    }
    if windows_terminal {
        args.push("--".into());
    }
    args.extend(run);
    Launch { file: if windows_terminal { "wt.exe" } else { "cmd.exe" }.into(), args, cwd: cwd.map(String::from) }
}

fn claude_bin(claude: &str) -> String {
    if claude.is_empty() { "claude".into() } else { sq(claude) }
}

/// Opens a Windows-side session again in Windows Terminal: `claude --resume <id>` in its folder.
pub fn windows_terminal_command(cwd: &str, session_id: &str, windows_terminal: bool) -> Result<Launch, String> {
    Ok(launch(windows_terminal, strs(&["claude", "--resume", &safe("session id", session_id)?]), Some(cwd)))
}

/// Opens a WSL session in a real terminal: `claude --resume <id>` inside WSL, in the session's folder.
pub fn terminal_command(distro: &str, cwd: &str, claude: &str, session_id: &str, windows_terminal: bool) -> Result<Launch, String> {
    let script = format!("cd -- {} && {} --resume {}\nexit 0\n", sq(cwd), claude_bin(claude), sq(session_id));
    Ok(launch(windows_terminal, wsl(distro, &script)?, None))
}

/// A NEW Claude Code session in a real terminal (WSL), optionally started with a first prompt.
pub fn new_session_command(distro: &str, cwd: &str, claude: &str, prompt: Option<&str>, windows_terminal: bool) -> Result<Launch, String> {
    let p = prompt.unwrap_or("").trim();
    let tail = if p.is_empty() { String::new() } else { format!(" {}", sq(p)) };
    let script = format!("cd -- {} && {}{}\nexit 0\n", sq(cwd), claude_bin(claude), tail);
    Ok(launch(windows_terminal, wsl(distro, &script)?, None))
}

/// A NEW Claude Code session in a Windows terminal, through `pet-helper pty` when there is a helper. The prompt never goes on the command line.
pub fn windows_new_session_command(cwd: &str, helper: Option<&str>, windows_terminal: bool) -> Launch {
    let run = match helper.filter(|h| !h.is_empty()) {
        Some(h) => strs(&[h, "pty", "claude"]),
        None => strs(&["claude"]),
    };
    launch(windows_terminal, run, Some(cwd))
}

fn norm_dir(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// The session a "new chat" on Windows turned into: same folder, appeared after the launch, idle, typable (has the wrapper's pipe).
/// `sessions`: JSON objects with id, cwd, since, pty, state, host.
pub fn match_new_session(sessions: &[Value], cwd: &str, at: f64, known: &[String]) -> Option<String> {
    let dir = norm_dir(cwd);
    sessions.iter().find(|s| {
        let str_of = |k: &str| s.get(k).and_then(Value::as_str);
        str_of("host") == Some("windows")
            && s.get("pty").map_or(false, |p| p.as_str().map_or(false, |x| !x.is_empty()))
            && str_of("state") == Some("idle")
            && s.get("since").and_then(Value::as_f64).map_or(false, |x| x >= at)
            && str_of("id").map_or(false, |id| !known.iter().any(|k| k == id))
            && str_of("cwd").map_or(false, |c| norm_dir(c) == dir)
    }).and_then(|s| s.get("id")?.as_str().map(String::from))
}

// ---- PowerShell profile wrapper ----

const START: &str = "# >>> ccPet >>>";
const END: &str = "# <<< ccPet <<<";

/// The PowerShell `claude` wrapper line.
pub fn wrapper_line(helper: &str) -> String {
    format!("function claude {{ & '{}' pty claude @args }}", helper.replace('\'', "''"))
}

fn block(helper: &str, nl: &str) -> String {
    [START, "# claude runs through the ccPet wrapper (Esc, Stop and typing from the pet); remove this block to undo", &wrapper_line(helper), END].join(nl) + nl
}

/// Byte range of our block (START .. END plus one optional line break).
fn find_block(s: &str) -> Option<(usize, usize)> {
    let a = s.find(START)?;
    let e = a + s[a..].find(END)? + END.len();
    let rest = &s[e..];
    let tail = if rest.starts_with("\r\n") { 2 } else if rest.starts_with('\n') { 1 } else { 0 };
    Some((a, e + tail))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileState { None, Ours, Stale }

pub fn profile_state(content: &str, helper: &str) -> ProfileState {
    match find_block(content) {
        None => ProfileState::None,
        Some((a, b)) => if content[a..b].contains(&wrapper_line(helper)) { ProfileState::Ours } else { ProfileState::Stale },
    }
}

/// +/- line diff (same algorithm as daemon/src/installHooks.ts lineDiff).
pub fn line_diff(a: &[&str], b: &[&str]) -> String {
    let mut dp = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            dp[i][j] = if a[i] == b[j] { dp[i + 1][j + 1] + 1 } else { dp[i + 1][j].max(dp[i][j + 1]) };
        }
    }
    let (mut i, mut j, mut out) = (0, 0, Vec::new());
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] { i += 1; j += 1; }
        else if j < b.len() && (i == a.len() || dp[i][j + 1] >= dp[i + 1][j]) { out.push(format!("+ {}", b[j])); j += 1; }
        else { out.push(format!("- {}", a[i])); i += 1; }
    }
    out.join("\n")
}

fn lines(s: &str) -> Vec<&str> {
    s.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

fn diff_of(a: &str, b: &str) -> String {
    if a == b { String::new() } else { line_diff(&lines(a), &lines(b)) }
}

/// The profile with our block added (or updated in place) and its diff.
pub fn plan_profile(content: &str, helper: &str) -> (String, String) {
    let nl = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let b = block(helper, nl);
    let next = match find_block(content) {
        Some((x, y)) => format!("{}{}{}", &content[..x], b, &content[y..]),
        None if content.is_empty() => b,
        None => format!("{}{}{}", content, if content.ends_with('\n') { "" } else { nl }, b),
    };
    let diff = diff_of(content, &next);
    (next, diff)
}

pub fn remove_from_profile(content: &str) -> (String, String) {
    let next = match find_block(content) {
        Some((x, y)) => format!("{}{}", &content[..x], &content[y..]),
        None => content.to_string(),
    };
    let diff = diff_of(content, &next);
    (next, diff)
}

/// Windows PowerShell 5 and PowerShell 7 profiles under `documents`.
pub fn profile_paths(documents: &Path) -> Vec<PathBuf> {
    ["WindowsPowerShell", "PowerShell"].iter().map(|d| documents.join(d).join("Microsoft.PowerShell_profile.ps1")).collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Enc { Utf8, Utf16 }

/// By BOM; BOM-less valid UTF-8 counts as UTF-8; anything else is ANSI (None), which we do not edit.
fn encoding_of(raw: &[u8]) -> Option<Enc> {
    if raw.starts_with(&[0xff, 0xfe]) { Some(Enc::Utf16) }
    else if raw.starts_with(&[0xef, 0xbb, 0xbf]) || std::str::from_utf8(raw).is_ok() { Some(Enc::Utf8) }
    else { None }
}

const ANSI: &str = "The PowerShell profile is in an ANSI code page: ccPet does not edit it. Add the line yourself (see Settings → Connections).";

/// The profile's text ("" when there is none). Err for an ANSI profile.
pub fn read_profile(path: &Path) -> Result<String, String> {
    if !path.exists() { return Ok(String::new()); }
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    match encoding_of(&raw).ok_or(ANSI)? {
        Enc::Utf16 => {
            let u: Vec<u16> = raw[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            Ok(String::from_utf16_lossy(&u))
        }
        Enc::Utf8 => Ok(String::from_utf8_lossy(&raw).trim_start_matches('\u{feff}').to_string()),
    }
}

/// Writes the profile (copying an existing one to `.bak` first). UTF-16 stays UTF-16; everything else is UTF-8 with a BOM.
pub fn apply_profile(path: &Path, next: &str) -> Result<(), String> {
    let mut enc = Enc::Utf8;
    if path.exists() {
        enc = encoding_of(&std::fs::read(path).map_err(|e| e.to_string())?).ok_or(ANSI)?;
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        std::fs::copy(path, PathBuf::from(bak)).map_err(|e| e.to_string())?;
    } else if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let body = next.trim_start_matches('\u{feff}');
    let mut out = Vec::new();
    if enc == Enc::Utf16 {
        out.extend([0xff, 0xfe]);
        for u in body.encode_utf16() { out.extend(u.to_le_bytes()); }
    } else {
        out.extend([0xef, 0xbb, 0xbf]);
        out.extend(body.as_bytes());
    }
    std::fs::write(path, out).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn script(args: &[String]) -> String {
        let last = args.last().unwrap();
        let b = last.strip_prefix("source <(echo ").unwrap().strip_suffix(" | base64 -d)").unwrap();
        assert!(b.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'='));
        String::from_utf8(STANDARD.decode(b).unwrap()).unwrap()
    }
    fn risky(a: &[String]) -> bool {
        a.iter().filter(|x| *x != "\"\"").any(|x| x.contains([';', '&', '^', '"', '%']))
    }

    #[test]
    fn wsl_terminal() {
        let c = terminal_command("Ubuntu", "/home/u/my proj", "/home/u/.local/bin/claude", "abc-123", true).unwrap();
        assert_eq!(c.file, "wt.exe");
        assert_eq!(c.args[..7], strs(&["-w", "new", "--", "wsl.exe", "-d", "Ubuntu", "--exec"])[..]);
        assert_eq!(script(&c.args), "cd -- '/home/u/my proj' && '/home/u/.local/bin/claude' --resume 'abc-123'\nexit 0\n");
        assert_eq!(c.cwd, None);
    }
    #[test]
    fn nothing_risky_reaches_the_command_line() {
        let cwd = "/home/u/x; new-tab calc & \"q\" 'it''s' ^%PATH%";
        for wt in [true, false] {
            let c = terminal_command("Ubuntu", cwd, "/c", "a'b", wt).unwrap();
            assert!(!risky(&c.args));
            assert!(script(&c.args).contains("cd -- '/home/u/x; new-tab calc & \"q\" '\\''it'\\'''\\''s'\\'' ^%PATH%'"));
            let n = new_session_command("", "/p", "", Some("fix tests; then commit & push \"now\""), wt).unwrap();
            assert!(!risky(&n.args));
            assert_eq!(script(&n.args), "cd -- '/p' && claude 'fix tests; then commit & push \"now\"'\nexit 0\n");
        }
    }
    #[test]
    fn cmd_fallback_and_distro() {
        assert_eq!(terminal_command("Ubuntu", "/p", "", "s", false).unwrap().args[..4], strs(&["/c", "start", "\"\"", "wsl.exe"])[..]);
        assert!(!terminal_command("", "/p", "", "s", true).unwrap().args.contains(&"-d".to_string()));
        assert!(terminal_command("x;calc", "/p", "", "s", true).unwrap_err().contains("unsafe distro"));
    }
    #[test]
    fn windows_sessions() {
        let cwd = "C:\\Users\\u\\a;b&c";
        let w = windows_terminal_command(cwd, "local_1-2", true).unwrap();
        assert_eq!(w, Launch { file: "wt.exe".into(), args: strs(&["-w", "new", "-d", ".", "--", "claude", "--resume", "local_1-2"]), cwd: Some(cwd.into()) });
        let n = windows_new_session_command(cwd, Some("C:\\pet\\pet-helper.exe"), true);
        assert_eq!(n.args, strs(&["-w", "new", "-d", ".", "--", "C:\\pet\\pet-helper.exe", "pty", "claude"]));
        let c = windows_new_session_command("C:\\p", None, false);
        assert_eq!(c, Launch { file: "cmd.exe".into(), args: strs(&["/c", "start", "\"\"", "/D", ".", "claude"]), cwd: Some("C:\\p".into()) });
        assert!(windows_terminal_command("C:\\p", "x&calc", true).unwrap_err().contains("unsafe session id"));
    }
    #[test]
    fn encoded_bash_is_base64_only() {
        script(&encoded_bash("a; b & c \"d\""));
    }
    #[test]
    fn matches_new_session() {
        let s = vec![
            json!({"id":"old","cwd":"C:\\P","since":10,"pty":"p","state":"idle","host":"windows"}),
            json!({"id":"new","cwd":"c:/p/","since":20,"pty":"p","state":"idle","host":"windows"}),
        ];
        assert_eq!(match_new_session(&s, "C:\\p", 15.0, &["old".into()]), Some("new".into()));
        assert_eq!(match_new_session(&s, "C:\\p", 25.0, &[]), None);
    }

    const H: &str = "C:\\Users\\u\\AppData\\Local\\Programs\\claude-pet\\resources\\helper\\pet-helper.exe";
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ccpet-term-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn wrapper_and_plan() {
        assert_eq!(wrapper_line(H), format!("function claude {{ & '{H}' pty claude @args }}"));
        assert!(wrapper_line("C:\\it's\\pet-helper.exe").contains("'C:\\it''s\\pet-helper.exe'"));
        let (next, diff) = plan_profile("Set-Alias ll ls\r\n", H);
        assert!(next.contains("Set-Alias ll ls") && next.contains(START) && next.contains(&wrapper_line(H)) && next.contains(END));
        assert!(diff.contains("+ "));
        assert!(plan_profile("", H).0.starts_with(START));
    }
    #[test]
    fn idempotent_and_replace() {
        let once = plan_profile("a\n", H).0;
        assert_eq!(plan_profile(&once, H).1, "");
        let moved = plan_profile(&once, "D:\\pet\\pet-helper.exe").0;
        assert_eq!(moved.matches(">>> ccPet >>>").count(), 1);
        assert!(moved.contains("'D:\\pet\\pet-helper.exe'") && moved.starts_with("a\n"));
    }
    #[test]
    fn remove_and_state() {
        let with = plan_profile("a\nb\n", H).0;
        assert_eq!(remove_from_profile(&with).0, "a\nb\n");
        assert_eq!(remove_from_profile("a\n").1, "");
        assert_eq!(profile_state("x", H), ProfileState::None);
        assert_eq!(profile_state(&plan_profile("", H).0, H), ProfileState::Ours);
        assert_eq!(profile_state(&plan_profile("", "D:\\old\\pet-helper.exe").0, H), ProfileState::Stale);
    }
    #[test]
    fn paths() {
        let p = profile_paths(Path::new("D"));
        assert!(p[0].ends_with("WindowsPowerShell/Microsoft.PowerShell_profile.ps1") || p[0].ends_with("WindowsPowerShell\\Microsoft.PowerShell_profile.ps1"));
        assert!(p[1].to_string_lossy().contains("PowerShell") && !p[1].to_string_lossy().contains("WindowsPowerShell"));
    }
    #[test]
    fn apply_with_backup() {
        let d = tmp("apply");
        let f = d.join("WindowsPowerShell").join("p.ps1");
        apply_profile(&f, &plan_profile("", H).0).unwrap();
        assert!(read_profile(&f).unwrap().contains(&wrapper_line(H)));
        assert!(!d.join("WindowsPowerShell").join("p.ps1.bak").exists());
        apply_profile(&f, "changed\n").unwrap();
        let bak = std::fs::read_to_string(d.join("WindowsPowerShell").join("p.ps1.bak")).unwrap();
        assert!(bak.contains(&wrapper_line(H)));
    }
    #[test]
    fn encodings() {
        let d = tmp("enc");
        let cyr = "C:\\Users\\Иван\\pet-helper.exe";
        let f1 = d.join("a.ps1");
        apply_profile(&f1, &plan_profile(&read_profile(&f1).unwrap(), cyr).0).unwrap();
        assert_eq!(std::fs::read(&f1).unwrap()[..3], [0xef, 0xbb, 0xbf]);
        assert!(read_profile(&f1).unwrap().contains(&wrapper_line(cyr)));
        let f2 = d.join("b.ps1");
        let mut raw = vec![0xff, 0xfe];
        for u in "Set-Alias ll ls\r\n".encode_utf16() { raw.extend(u.to_le_bytes()); }
        std::fs::write(&f2, raw).unwrap();
        assert_eq!(read_profile(&f2).unwrap(), "Set-Alias ll ls\r\n");
        apply_profile(&f2, &plan_profile(&read_profile(&f2).unwrap(), cyr).0).unwrap();
        assert_eq!(std::fs::read(&f2).unwrap()[..2], [0xff, 0xfe]);
        assert!(read_profile(&f2).unwrap().contains(&wrapper_line(cyr)));
        let f3 = d.join("c.ps1");
        let ansi = vec![0x23, 0x20, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a];
        std::fs::write(&f3, &ansi).unwrap();
        assert!(read_profile(&f3).unwrap_err().contains("ANSI"));
        assert!(apply_profile(&f3, "x").is_err());
        assert_eq!(std::fs::read(&f3).unwrap(), ansi);
    }
}
