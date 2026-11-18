//! Windows (or \\wsl$ UNC) paths from the app -> WSL paths (paths.ts).

/** `~/.claude-pet`: socket, usage file, hub.json, pty sockets. */
pub fn pet_dir() -> std::path::PathBuf {
    // CLAUDE_PET_DIR: a separate pet folder (tests, a second bridge next to the user's own)
    if let Some(d) = std::env::var_os("CLAUDE_PET_DIR") { return d.into(); }
    std::path::PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default()).join(".claude-pet")
}

pub fn to_wsl_path(p: &str) -> String {
    let lower = p.to_ascii_lowercase();
    for pre in ["\\\\wsl$\\", "\\\\wsl.localhost\\"] {
        if lower.starts_with(pre) {
            let rest = &p[pre.len()..];
            let after_distro = match rest.find('\\') { Some(i) => &rest[i + 1..], None => "" };
            return format!("/{}", after_distro.replace('\\', "/").trim_end_matches('/'));
        }
    }
    let b = p.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        let rest = p[2..].trim_start_matches(['\\', '/']).replace('\\', "/");
        let rest = rest.trim_end_matches('/');
        return format!("/mnt/{}{}", (b[0] as char).to_ascii_lowercase(), if rest.is_empty() { String::new() } else { format!("/{rest}") });
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn converts() {
        assert_eq!(to_wsl_path("C:\\Users\\me\\proj\\"), "/mnt/c/Users/me/proj");
        assert_eq!(to_wsl_path("D:"), "/mnt/d");
        assert_eq!(to_wsl_path("\\\\wsl$\\Ubuntu\\home\\me"), "/home/me");
        assert_eq!(to_wsl_path("\\\\wsl.localhost\\Ubuntu"), "/");
        assert_eq!(to_wsl_path("/home/me"), "/home/me");
    }
}
