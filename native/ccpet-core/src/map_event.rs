//! Claude Code hook events -> the pet's state (mapEvent.ts).

use crate::types::{HookEvent, PetState};
use regex_lite::Regex;
use serde_json::Value;
use std::sync::OnceLock;

fn test_runners() -> &'static [Regex] {
    static R: OnceLock<Vec<Regex>> = OnceLock::new();
    R.get_or_init(|| {
        [
            r"\b(pytest|py\.test|vitest|jest|mocha|rspec|phpunit)\b",
            r"\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b",
            r"\bgo\s+test\b",
            r"\bcargo\s+test\b",
            r"\bdotnet\s+test\b",
            r"\bmvn\s+test\b",
            r"\bgradle\w*\s+test\b",
        ].iter().map(|p| Regex::new(p).unwrap()).collect()
    })
}

/** A command that runs a test suite (shown as 'testing'; its result makes the pet react). */
pub fn is_test_command(cmd: &str) -> bool { test_runners().iter().any(|r| r.is_match(cmd)) }

/** JavaScript truthiness of a JSON value. */
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn tool_state(ev: &HookEvent) -> PetState {
    match ev.tool() {
        "Read" | "Grep" | "Glob" | "LS" | "WebFetch" | "WebSearch" => PetState::Reading,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => PetState::Writing,
        "Task" | "Agent" => PetState::Subagent, // Claude Code renamed Task to Agent
        "Bash" => {
            let cmd = ev.tool_input.as_ref().and_then(|i| i.get("command")).map(js_string).unwrap_or_default();
            if is_test_command(&cmd) { PetState::Testing } else { PetState::Running }
        }
        _ => PetState::Running,
    }
}

/** String(x) of JavaScript for the values hooks carry. */
pub fn js_string(v: &Value) -> String {
    match v { Value::String(s) => s.clone(), Value::Null => "null".into(), other => other.to_string() }
}

/** The pet state a hook event moves a session to; None = no change. */
pub fn map_event(ev: &HookEvent) -> Option<PetState> {
    match ev.hook_event_name.as_str() {
        "UserPromptSubmit" => Some(PetState::Thinking),
        "PreToolUse" => Some(tool_state(ev)),
        "PostToolUse" => Some(if truthy(ev.tool_response.as_ref().and_then(|r| r.get("is_error"))) { PetState::Error } else { PetState::Thinking }),
        // a failed command is ordinary work: Claude reads the error and goes on
        "PostToolUseFailure" => Some(PetState::Thinking),
        "Notification" => if ev.message.as_deref().unwrap_or("").to_lowercase().contains("permission") { Some(PetState::Waiting) } else { None },
        "Stop" => Some(PetState::Done),
        "SessionStart" => Some(PetState::Idle),
        "SessionEnd" => Some(PetState::Sleeping),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_commands() {
        for c in ["pytest -q", "npx vitest run", "npm test", "npm run test", "yarn test", "go test ./...", "cargo test", "dotnet test", "mvn test", "./gradlew test", "gradle test"] {
            assert!(is_test_command(c), "{c}");
        }
        for c in ["npm install", "cargo build", "echo testing", "git commit -m test", "npm && test"] { assert!(!is_test_command(c), "{c}"); }
    }

    #[test]
    fn states() {
        let mut e = HookEvent::new("PreToolUse", "s", "/x");
        e.tool_name = Some("Bash".into());
        e.tool_input = Some(json!({"command": "npm test"}));
        assert_eq!(map_event(&e), Some(PetState::Testing));
        e.tool_name = Some("Read".into());
        assert_eq!(map_event(&e), Some(PetState::Reading));
        e.tool_name = Some("Agent".into());
        assert_eq!(map_event(&e), Some(PetState::Subagent));
        let mut p = HookEvent::new("PostToolUse", "s", "/x");
        p.tool_response = Some(json!({"is_error": true}));
        assert_eq!(map_event(&p), Some(PetState::Error));
        p.tool_response = Some(json!({}));
        assert_eq!(map_event(&p), Some(PetState::Thinking));
        let mut n = HookEvent::new("Notification", "s", "/x");
        n.message = Some("Claude needs your permission to use Bash".into());
        assert_eq!(map_event(&n), Some(PetState::Waiting));
        n.message = Some("idle".into());
        assert_eq!(map_event(&n), None);
    }
}
