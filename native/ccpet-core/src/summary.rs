//! One-line description of a tool call for permission prompts and chat chips (summary.ts).

use serde_json::Value;

/** The first `n` characters (JavaScript's slice counts UTF-16 units; characters are close enough for display). */
pub fn head(s: &str, n: usize) -> String { s.chars().take(n).collect() }

pub fn summarize(tool: &str, input: &Value) -> String {
    if tool == "Bash" {
        return match input.get("command") { None | Some(Value::Null) => String::new(), Some(v) => head(&crate::map_event::js_string(v), 200) };
    }
    for k in ["file_path", "path", "pattern", "url", "query", "description"] {
        if let Some(Value::String(s)) = input.get(k) { return head(s, 200); }
    }
    let s = if input.is_null() { "{}".to_string() } else { input.to_string() };
    if s == "{}" { String::new() } else { head(&s, 120) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn lines() {
        assert_eq!(summarize("Bash", &json!({"command": "ls -la"})), "ls -la");
        assert_eq!(summarize("Bash", &json!({})), "");
        assert_eq!(summarize("Read", &json!({"file_path": "/a/b"})), "/a/b");
        assert_eq!(summarize("X", &json!({})), "");
        assert_eq!(summarize("X", &json!({"a": 1})), "{\"a\":1}");
    }
}
