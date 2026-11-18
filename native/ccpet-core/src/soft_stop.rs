//! Stop for sessions the pet cannot press Esc in (softStop.ts): the session's next tool hook is answered `{"continue": false}`.

use crate::i18n::l;
use crate::types::HookEvent;
use serde_json::{json, Value};
use std::collections::HashMap;

pub struct SoftStop { ttl_ms: i64, asked: HashMap<String, i64> }

impl SoftStop {
    pub fn new() -> Self { SoftStop { ttl_ms: 10 * 60_000, asked: HashMap::new() } }

    fn live(&mut self, id: &str, now: i64) -> bool {
        match self.asked.get(id) {
            None => false,
            Some(at) if now - at > self.ttl_ms => { self.asked.remove(id); false }
            Some(_) => true,
        }
    }
    /** the user pressed Stop: answer this session's next tool hook with "stop" */
    pub fn request(&mut self, id: &str, now: i64) { self.asked.insert(id.into(), now); }
    pub fn pending(&mut self, id: &str, now: i64) -> bool { self.live(id, now) }

    /** The answer to send back for this hook event, or None; Some also means "the session stopped" (the caller marks it). */
    pub fn reply(&mut self, e: &HookEvent, now: i64) -> Option<Value> {
        let id = e.session_id.as_str();
        if matches!(e.hook_event_name.as_str(), "Stop" | "StopFailure" | "UserPromptSubmit" | "SessionEnd") { self.asked.remove(id); return None; }
        if e.hook_event_name != "PreToolUse" && e.hook_event_name != "PostToolUse" { return None; }
        if !self.live(id, now) { return None; }
        self.asked.remove(id);
        let reason = l("Остановлено из ccPet", "Stopped from ccPet", "已从 ccPet 停止");
        Some(if e.hook_event_name == "PreToolUse" {
            json!({ "continue": false, "stopReason": reason, "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason } })
        } else {
            json!({ "continue": false, "stopReason": reason })
        })
    }
}

impl Default for SoftStop { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stops_at_the_next_tool_call_only() {
        let mut s = SoftStop::new();
        s.request("a", 0);
        assert!(s.reply(&HookEvent::new("Notification", "a", ""), 1).is_none());
        let r = s.reply(&HookEvent::new("PreToolUse", "a", ""), 2).unwrap();
        assert_eq!(r["continue"], false);
        assert_eq!(r["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(s.reply(&HookEvent::new("PreToolUse", "a", ""), 3).is_none());
        s.request("a", 0);
        assert!(s.reply(&HookEvent::new("Stop", "a", ""), 1).is_none());
        assert!(!s.pending("a", 2));
        s.request("b", 0);
        assert!(!s.pending("b", 10 * 60_000 + 1));
    }
}
