//! Process facts the bridge needs, portable between Linux (/proc) and macOS (`ps`). None when the process is gone (procinfo.ts).

#[cfg(not(target_os = "linux"))]
fn ps(pid: u32, field: &str) -> Option<String> {
    let o = std::process::Command::new("ps").args(["-o", &format!("{field}="), "-p", &pid.to_string()]).stderr(std::process::Stdio::null()).output().ok()?;
    let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
    if t.is_empty() { None } else { Some(t) }
}

/** Short name of the process (`claude`, `node`, ...). */
pub fn proc_name(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    { std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s| s.trim().to_string()) }
    #[cfg(not(target_os = "linux"))]
    { ps(pid, "comm").map(|c| c.rsplit('/').next().unwrap_or("").to_string()) }
}

/** Terminal device the process is attached to (`/dev/pts/3`, `/dev/ttys004`), None if none. */
pub fn tty_path(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    { std::fs::read_link(format!("/proc/{pid}/fd/0")).ok().map(|p| p.to_string_lossy().into_owned()).filter(|t| t.starts_with("/dev/pts/")) }
    #[cfg(not(target_os = "linux"))]
    { ps(pid, "tty").filter(|t| t != "??" && t != "?").map(|t| if t.starts_with("/dev/") { t } else { format!("/dev/{t}") }) }
}

#[cfg(test)]
mod tests {
    #[test]
    fn own_process_is_known_and_a_dead_one_is_not() {
        assert!(super::proc_name(std::process::id()).is_some());
        assert_eq!(super::proc_name(u32::MAX - 1), None);
    }
}
