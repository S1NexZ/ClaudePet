//! The process tree around the hook: parents (so the pet can find this session's claude), whether claude still runs, and
//! whether it is a one-shot `claude -p`.

pub fn parent_id() -> u32 {
    #[cfg(unix)]
    { std::os::unix::process::parent_id() }
    #[cfg(not(unix))]
    { 0 }
}

/** Parent pid (0 if unknown): /proc on Linux, `ps` on macOS. */
pub fn parent_of(pid: u32) -> u32 {
    #[cfg(target_os = "linux")]
    {
        let Ok(st) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return 0 };
        // the name in parentheses may hold spaces: fields count from the last ')'
        st.rfind(')').and_then(|i| st[i + 2..].split(' ').nth(1)).and_then(|p| p.parse().ok()).unwrap_or(0)
    }
    #[cfg(not(target_os = "linux"))]
    {
        ps(&["-o", "ppid=", "-p", &pid.to_string()]).trim().parse().unwrap_or(0)
    }
}

#[cfg(not(target_os = "linux"))]
fn ps(args: &[&str]) -> String {
    std::process::Command::new("ps").args(args).stderr(std::process::Stdio::null()).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

pub fn alive(pid: u32) -> bool {
    if pid <= 1 { return false; }
    #[cfg(target_os = "linux")]
    { std::path::Path::new(&format!("/proc/{pid}")).exists() }
    #[cfg(all(unix, not(target_os = "linux")))]
    { !ps(&["-o", "pid=", "-p", &pid.to_string()]).trim().is_empty() }
    #[cfg(not(unix))]
    { true }
}

/** claude's own executable (`claude`, `claude.exe`, or Node running claude-code's cli.js). */
pub fn is_claude(arg: &str) -> bool {
    let a = arg.to_ascii_lowercase();
    a == "claude" || a == "claude.exe" || a.ends_with("/claude") || a.ends_with("/claude.exe") || a.ends_with("claude-code/cli.js")
}

/** A one-shot `claude -p` (print mode with a prompt, not a stream-json session like the desktop app's). */
pub fn is_one_shot(args: &[String]) -> bool {
    let print = args.iter().any(|a| a == "-p" || a == "--print" || a.starts_with("--print="));
    let stream_in = args.iter().enumerate().any(|(i, a)| a == "--input-format=stream-json" || (a == "--input-format" && args.get(i + 1).map(String::as_str) == Some("stream-json")));
    print && !stream_in
}

/** Command line of a process: /proc on Linux, `ps` on macOS. */
fn cmdline_of(pid: u32) -> Option<Vec<String>> {
    #[cfg(target_os = "linux")]
    {
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        Some(raw.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect())
    }
    #[cfg(not(target_os = "linux"))]
    {
        // `ps` flattens the command line, so an argument with spaces falls apart into words: only options before the first positional
        // word count (a missed one-shot just keeps a harmless waiter; a false one-shot would lose the user's mailbox)
        let t: Vec<String> = ps(&["-o", "command=", "-p", &pid.to_string()]).split_whitespace().map(str::to_string).collect();
        let Some(i) = t.iter().position(|x| is_claude(x)) else { return Some(t) };
        let mut end = i + 1;
        while end < t.len() && (t[end].starts_with('-') || t[end - 1].starts_with('-')) { end += 1; }
        Some(t[..end].to_vec())
    }
}

pub fn one_shot(mut pid: u32) -> bool {
    for _ in 0..3 {
        if pid <= 1 { break; }
        let Some(args) = cmdline_of(pid) else { return false };
        // only claude's own command line counts (a shell or another ancestor may have a -p option of its own)
        if args.iter().any(|a| is_claude(a)) && is_one_shot(&args) { return true; }
        pid = parent_of(pid);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(a: &[&str]) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn one_shots() {
        assert!(is_one_shot(&v(&["claude", "-p", "hi"])));
        assert!(!is_one_shot(&v(&["claude", "-p", "--input-format", "stream-json"])));
        assert!(!is_one_shot(&v(&["claude"])));
        assert!(is_claude("/home/u/.local/bin/claude") && is_claude("node_modules/@anthropic-ai/claude-code/cli.js") && !is_claude("claudette"));
    }

    #[test]
    fn this_process_has_a_parent() {
        assert!(parent_id() > 0);
        assert!(alive(std::process::id()));
    }
}
