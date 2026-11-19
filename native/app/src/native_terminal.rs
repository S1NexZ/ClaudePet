//! Opening and raising terminals on Linux and macOS. Port of ui/src/nativeTerminal.ts; pure: every choice is a function of its inputs.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub file: String,
    pub args: Vec<String>,
}

fn launch(file: &str, args: Vec<String>) -> Launch {
    Launch { file: file.to_string(), args }
}

fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// AppleScript string literal.
fn asq(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The shell line a new terminal runs: resume a session, or start a new one with an optional first prompt.
pub fn shell_line(claude: Option<&str>, session_id: Option<&str>, prompt: Option<&str>) -> String {
    let bin = match claude {
        Some(c) if !c.is_empty() => sq(c),
        _ => "claude".to_string(),
    };
    let prompt = prompt.unwrap_or("").trim();
    let tail = match session_id {
        Some(s) if !s.is_empty() => format!(" --resume {}", sq(s)),
        _ if !prompt.is_empty() => format!(" {}", sq(prompt)),
        _ => String::new(),
    };
    format!("{bin}{tail}; exit 0")
}

/// Terminal emulators in the order we try them (the first one installed wins).
const LINUX_TERMS: [&str; 7] = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "kitty", "alacritty", "xterm"];

fn linux_args(bin: &str, cwd: &str, line: &str) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let mut a = match bin {
        "x-terminal-emulator" => s(&["-e", "bash", "-lc"]),
        "gnome-terminal" => vec![format!("--working-directory={cwd}"), "--".into(), "bash".into(), "-lc".into()],
        "konsole" => s(&["--workdir", cwd, "-e", "bash", "-lc"]),
        "xfce4-terminal" => vec![format!("--working-directory={cwd}"), "-x".into(), "bash".into(), "-lc".into()],
        "kitty" => s(&["--directory", cwd, "bash", "-lc"]),
        "alacritty" => s(&["--working-directory", cwd, "-e", "bash", "-lc"]),
        _ => s(&["-e", "bash", "-lc"]), // xterm
    };
    a.push(line.to_string());
    a
}

/// The command that opens a terminal running `claude` as described; None when no terminal emulator is installed (Linux).
pub fn native_terminal_command(
    platform: &str,
    cwd: &str,
    claude: Option<&str>,
    session_id: Option<&str>,
    prompt: Option<&str>,
    on_path: &dyn Fn(&str) -> bool,
) -> Option<Launch> {
    let line = shell_line(claude, session_id, prompt);
    if platform == "darwin" {
        let script = format!("cd {} && {}", sq(cwd), line);
        return Some(launch(
            "osascript",
            vec![
                "-e".into(),
                format!("tell application \"Terminal\" to do script {}", asq(&script)),
                "-e".into(),
                "tell application \"Terminal\" to activate".into(),
            ],
        ));
    }
    let bin = LINUX_TERMS.iter().find(|b| on_path(b))?;
    // x-terminal-emulator and xterm take no working-directory option: change folder inside the line
    let inner = if *bin == "x-terminal-emulator" || *bin == "xterm" { format!("cd {} && {}", sq(cwd), line) } else { line };
    Some(launch(bin, linux_args(bin, cwd, &inner)))
}

/// Raises the terminal window whose title contains `title`. Best effort: None = nothing to try.
pub fn native_focus_command(platform: &str, title: &str, on_path: &dyn Fn(&str) -> bool) -> Option<Launch> {
    if platform == "darwin" {
        let t = asq(title);
        let script = format!(
            "tell application \"System Events\" to set procs to name of every process whose name is \"Terminal\" or name is \"iTerm2\"\n\
             set found to false\n\
             if procs contains \"Terminal\" then tell application \"Terminal\"\n\
             repeat with w in windows\nif (name of w) contains {t} then\nset index of w to 1\nactivate\nset found to true\nexit repeat\nend if\nend repeat\nend tell\n\
             if found then return \"ok\"\nreturn \"none\""
        );
        return Some(launch("osascript", vec!["-e".into(), script]));
    }
    if on_path("wmctrl") {
        return Some(launch("wmctrl", vec!["-a".into(), title.into()]));
    }
    if on_path("xdotool") {
        return Some(launch("xdotool", vec!["search".into(), "--name".into(), title.into(), "windowactivate".into()]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn only<'a>(b: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |x| b.contains(&x)
    }
    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn shell_line_cases() {
        assert_eq!(shell_line(None, Some("abc"), None), "claude --resume 'abc'; exit 0");
        assert_eq!(shell_line(Some("/o b/claude"), None, Some("it's $x")), "'/o b/claude' 'it'\\''s $x'; exit 0");
        assert_eq!(shell_line(None, None, None), "claude; exit 0");
    }

    #[test]
    fn linux_first_installed_in_order() {
        let c = native_terminal_command("linux", "/w", None, Some("s"), None, &only(&["konsole", "xterm"])).unwrap();
        assert_eq!(c, Launch { file: "konsole".into(), args: v(&["--workdir", "/w", "-e", "bash", "-lc", "claude --resume 's'; exit 0"]) });
    }

    #[test]
    fn linux_cd_in_line() {
        let c = native_terminal_command("linux", "/my dir/it's", None, Some("s"), None, &only(&["xterm"])).unwrap();
        assert_eq!(c.file, "xterm");
        assert_eq!(c.args.last().unwrap(), "cd '/my dir/it'\\''s' && claude --resume 's'; exit 0");
    }

    #[test]
    fn linux_none_installed() {
        assert!(native_terminal_command("linux", "/w", None, None, None, &|_| false).is_none());
    }

    #[test]
    fn macos_terminal() {
        let c = native_terminal_command("darwin", "/Users/a b", None, None, Some("say \"hi\""), &|_| false).unwrap();
        assert_eq!(c.file, "osascript");
        assert_eq!(c.args[1], "tell application \"Terminal\" to do script \"cd '/Users/a b' && claude 'say \\\"hi\\\"'; exit 0\"");
        assert!(c.args[3].contains("activate"));
    }

    #[test]
    fn focus_linux() {
        assert_eq!(native_focus_command("linux", "T", &only(&["wmctrl", "xdotool"])), Some(Launch { file: "wmctrl".into(), args: v(&["-a", "T"]) }));
        assert_eq!(
            native_focus_command("linux", "T", &only(&["xdotool"])),
            Some(Launch { file: "xdotool".into(), args: v(&["search", "--name", "T", "windowactivate"]) })
        );
        assert!(native_focus_command("linux", "T", &|_| false).is_none());
    }

    #[test]
    fn focus_macos() {
        let c = native_focus_command("darwin", "proj - Claude ab12", &|_| false).unwrap();
        assert_eq!(c.file, "osascript");
        assert!(c.args[1].contains("(name of w) contains \"proj - Claude ab12\""));
    }
}
