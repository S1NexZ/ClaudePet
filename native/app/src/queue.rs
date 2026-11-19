//! Port of ui/src/hub/messageQueue.ts (MessageQueue; `parseAt` is not part of this module).
//! Messages the pet types into sessions later: after the current turn ends, or at a set time.
//! Sessions and messages stay `serde_json::Value` so the wire format is the TS one.
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub struct MessageQueue {
    save: Box<dyn Fn(&Value) + Send>,
    items: HashMap<String, Vec<Value>>,
    /// a message just went out: wait for the session to pick it up before the next one
    sent_at: HashMap<String, f64>,
    seq: u64,
    /// ms since epoch; injectable for tests
    clock: Box<dyn Fn() -> f64 + Send>,
}

/// JS-style number: whole values serialize as integers (`123`, not `123.0`).
fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 { Value::from(n as i64) } else { Value::from(n) }
}

fn base36(mut n: u64) -> String {
    if n == 0 { return "0".into(); }
    let mut b = Vec::new();
    while n > 0 { b.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]); n /= 36; }
    b.reverse();
    String::from_utf8(b).unwrap()
}

impl MessageQueue {
    pub fn new(save: Box<dyn Fn(&Value) + Send>, loaded: Option<Value>) -> Self {
        let mut items = HashMap::new();
        if let Some(Value::Object(o)) = loaded {
            for (id, list) in o {
                if let Value::Array(l) = list {
                    if l.is_empty() { continue; }
                    let ok = |m: &Value| m.get("text").map_or(false, Value::is_string) && m.get("id").map_or(false, Value::is_string);
                    items.insert(id, l.into_iter().filter(ok).collect());
                }
            }
        }
        let clock = Box::new(|| {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
        });
        MessageQueue { save, items, sent_at: HashMap::new(), seq: 0, clock }
    }

    /// Replace the time source (tests).
    pub fn set_clock(&mut self, clock: Box<dyn Fn() -> f64 + Send>) { self.clock = clock; }

    /// Returns the queued message `{id, text, at?}`; `at` of None or 0 means untimed.
    pub fn add(&mut self, session_id: &str, text: &str, at: Option<f64>) -> Value {
        self.seq += 1;
        let id = format!("q{}{}", base36((self.clock)() as u64), self.seq);
        let mut m = json!({ "id": id, "text": text });
        if let Some(a) = at.filter(|a| *a != 0.0 && !a.is_nan()) { m["at"] = num(a); }
        self.items.entry(session_id.to_string()).or_default().push(m.clone());
        self.persist();
        m
    }

    /// one message, or all of a session's (id None or empty)
    pub fn remove(&mut self, session_id: &str, id: Option<&str>) {
        let left: Vec<Value> = match id.filter(|i| !i.is_empty()) {
            Some(id) => self.items.get(session_id).map(|l| l.iter().filter(|m| m["id"] != id).cloned().collect()).unwrap_or_default(),
            None => Vec::new(),
        };
        if left.is_empty() { self.items.remove(session_id); } else { self.items.insert(session_id.to_string(), left); }
        self.persist();
    }

    pub fn of(&self, session_id: &str) -> Option<&Vec<Value>> { self.items.get(session_id) }

    /// The messages to send now, at most one per session; they are taken out of the queue.
    pub fn due(&mut self, sessions: &[Value], now: f64) -> Vec<(String, Value)> {
        let mut out = Vec::new();
        for s in sessions {
            let Some(sid) = s["id"].as_str() else { continue };
            let Some(list) = self.items.get(sid).filter(|l| !l.is_empty()) else { continue };
            if !matches!(s["state"].as_str(), Some("idle" | "done" | "error")) { continue; }
            if s.get("pendingPermission").map_or(false, |p| !p.is_null()) { continue; }
            if now - self.sent_at.get(sid).copied().unwrap_or(0.0) < 4000.0 { continue; }
            let Some(m) = list.iter().find(|x| { let at = x["at"].as_f64().unwrap_or(0.0); at == 0.0 || at <= now }).cloned() else { continue };
            self.sent_at.insert(sid.to_string(), now);
            self.remove(sid, m["id"].as_str());
            out.push((sid.to_string(), m));
        }
        out
    }

    /// the sessions with their queues attached (for the pet's snapshot)
    pub fn decorate(&self, sessions: Vec<Value>) -> Vec<Value> {
        sessions.into_iter().map(|mut s| {
            if let Some(l) = s["id"].as_str().and_then(|id| self.items.get(id)).filter(|l| !l.is_empty()) {
                s["queue"] = Value::Array(l.clone());
            }
            s
        }).collect()
    }

    fn persist(&self) {
        let o: Map<String, Value> = self.items.iter().map(|(k, v)| (k.clone(), Value::Array(v.clone()))).collect();
        (self.save)(&Value::Object(o));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn sess(id: &str, state: &str) -> Value { json!({ "id": id, "cwd": "/p", "project": "p", "state": state, "since": 0, "lastEventAt": 0, "owned": false }) }
    fn nop() -> Box<dyn Fn(&Value) + Send> { Box::new(|_| {}) }
    fn texts(v: Vec<(String, Value)>) -> Vec<String> { v.into_iter().map(|(_, m)| m["text"].as_str().unwrap().to_string()).collect() }

    #[test]
    fn sends_next_message_only_once_turn_is_over_in_order() {
        let mut q = MessageQueue::new(nop(), None);
        q.add("s1", "first", None); q.add("s1", "second", None);
        assert!(q.due(&[sess("s1", "thinking")], 1e6).is_empty());
        assert_eq!(texts(q.due(&[sess("s1", "done")], 1e6)), ["first"]);
        assert!(q.due(&[sess("s1", "done")], 1e6 + 1000.0).is_empty());
        assert_eq!(texts(q.due(&[sess("s1", "idle")], 1e6 + 5000.0)), ["second"]);
        assert!(q.of("s1").is_none());
    }

    #[test]
    fn pending_permission_holds_the_queue() {
        let mut q = MessageQueue::new(nop(), None);
        q.add("s1", "x", None);
        let mut s = sess("s1", "idle");
        s["pendingPermission"] = json!({ "id": "a", "tool": "Bash", "summary": "" });
        assert!(q.due(&[s], 1e6).is_empty());
    }

    #[test]
    fn timed_message_waits_untimed_behind_it_not_blocked() {
        let mut q = MessageQueue::new(nop(), None);
        q.add("s1", "night", Some(5e6)); q.add("s1", "now", None);
        assert_eq!(texts(q.due(&[sess("s1", "idle")], 1e6)), ["now"]);
        assert!(q.due(&[sess("s1", "idle")], 2e6).is_empty());
        assert_eq!(texts(q.due(&[sess("s1", "idle")], 5e6)), ["night"]);
    }

    #[test]
    fn saved_on_every_change_and_restored() {
        let saved: Arc<Mutex<Value>> = Arc::new(Mutex::new(Value::Null));
        let s2 = saved.clone();
        let mut q = MessageQueue::new(Box::new(move |d| *s2.lock().unwrap() = d.clone()), None);
        q.set_clock(Box::new(|| 1.7e12));
        let m = q.add("s1", "a", Some(123.0));
        assert_eq!(m, json!({ "id": "q", "text": "a", "at": 123 }).as_object().map(|_| m.clone()).unwrap());
        assert!(m["id"].as_str().unwrap().starts_with('q') && m["id"].as_str().unwrap().ends_with('1'));
        assert_eq!(m["at"].to_string(), "123");
        let snap = saved.lock().unwrap().clone();
        assert_eq!(snap, json!({ "s1": [m.clone()] }));
        let mut back = MessageQueue::new(nop(), Some(snap));
        assert_eq!(back.of("s1"), Some(&vec![m.clone()]));
        back.remove("s1", m["id"].as_str());
        assert!(back.of("s1").is_none());
        assert!(back.decorate(vec![sess("s1", "idle")])[0].get("queue").is_none());
        assert_eq!(q.decorate(vec![sess("s1", "idle")])[0]["queue"], json!([m]));
    }

    #[test]
    fn invalid_loaded_data_is_ignored() {
        let q = MessageQueue::new(nop(), Some(json!({ "a": [], "b": "x", "c": [{ "id": "q1", "text": "ok" }, { "id": 1, "text": "bad" }, null] })));
        assert!(q.of("a").is_none() && q.of("b").is_none());
        assert_eq!(q.of("c").unwrap().len(), 1);
    }
}
