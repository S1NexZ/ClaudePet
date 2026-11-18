//! The bridge protocol, as shared/src/types.ts defines it: JSON lines between the app and a bridge.
//! Field names and shapes must stay byte-compatible with the TypeScript side.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PetState { Idle, Thinking, Reading, Writing, Running, Testing, Waiting, Subagent, Done, Error, Sleeping }

impl PetState {
    /** States in which Claude is busy with a turn (or waits for the user inside one). */
    pub fn working(self) -> bool {
        matches!(self, PetState::Thinking | PetState::Reading | PetState::Writing | PetState::Running | PetState::Testing | PetState::Waiting | PetState::Subagent)
    }
    pub fn quiet(self) -> bool { matches!(self, PetState::Idle | PetState::Sleeping | PetState::Done) }
}

/** A hook event as Claude Code sends it, plus what our hook adds (`pet_parents`, `pet_pty`). Unknown fields are kept in `extra`. */
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HookEvent {
    pub hook_event_name: String,
    pub session_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_response: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pet_parents: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pet_pty: Option<String>,
}

impl HookEvent {
    pub fn new(name: &str, session_id: &str, cwd: &str) -> Self {
        HookEvent { hook_event_name: name.into(), session_id: session_id.into(), cwd: cwd.into(), ..Default::default() }
    }
    pub fn tool(&self) -> &str { self.tool_name.as_deref().unwrap_or("") }
    /** Parses a hook body: an object with a string `session_id` and `hook_event_name` (the HTTP receiver fills the name from the URL). */
    pub fn from_value(mut v: Value, name_fallback: Option<&str>) -> Option<Self> {
        let o = v.as_object_mut()?;
        if !o.get("session_id").map_or(false, Value::is_string) { return None; }
        if !o.get("hook_event_name").map_or(false, Value::is_string) {
            o.insert("hook_event_name".into(), Value::String(name_fallback?.to_string()));
        }
        if !o.get("cwd").map_or(false, Value::is_string) { o.insert("cwd".into(), Value::String(String::new())); }
        // fields of an unexpected type are dropped rather than failing the whole event
        for k in ["tool_name", "message", "transcript_path", "pet_pty"] {
            if o.get(k).map_or(false, |x| !x.is_string()) { o.remove(k); }
        }
        if o.get("pet_parents").map_or(false, |x| !x.is_array()) { o.remove("pet_parents"); }
        if let Some(Value::Array(a)) = o.get_mut("pet_parents") { a.retain(|x| x.is_i64()); }
        serde_json::from_value(v).ok()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AskOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestion {
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub options: Vec<AskOption>,
    pub multi_select: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PendingPermission {
    pub id: String,
    pub tool: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<AskQuestion>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub cwd: String,
    pub project: String,
    pub state: PetState,
    pub since: i64,
    pub last_event_at: i64,
    pub owned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_permission: Option<PendingPermission>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soft_stop: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mailbox: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "mod")]
    pub is_mod: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSummary {
    pub files: Vec<FileChange>,
    pub ms: i64,
    pub tokens: i64,
    pub tools: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FileChange { pub path: String, pub added: i64, pub removed: i64 }

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ChatItem {
    pub role: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<TurnSummary>,
}

/** One rate-limit window (resetsAt in Unix seconds). */
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow { pub used_pct: f64, pub resets_at: f64 }

/** The newer of two reports of one window: a later reset is a new window; within one, usage only grows. */
pub fn freshest_window(a: Option<UsageWindow>, b: Option<UsageWindow>) -> Option<UsageWindow> {
    match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) if a.resets_at != b.resets_at => Some(if a.resets_at > b.resets_at { a } else { b }),
        (Some(a), Some(b)) => Some(if b.used_pct > a.used_pct { b } else { a }),
    }
}
