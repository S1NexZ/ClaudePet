//! Sessions the pet knows and their states (sessionStore.ts).

use crate::map_event::map_event;
use crate::types::{HookEvent, PendingPermission, PetState, Session};
use std::collections::{HashMap, HashSet};

const BUSY_DECAY_MS: i64 = 120_000;
const WAITING_DECAY_MS: i64 = 30 * 60_000;
const DONE_TO_IDLE_MS: i64 = 30_000;
const SLEEPING_DROP_MS: i64 = 60 * 60_000;
/** A quiet "idle" session that sent nothing for this long is most likely a closed terminal (no SessionEnd was ever sent). */
const IDLE_TO_SLEEP_MS: i64 = 3 * 60 * 60_000;
/** Hard cap on the list: beyond it the longest-quiet sleeping/idle sessions go (a live one reappears with its next event). */
const MAX_SESSIONS: usize = 15;

pub fn project_name(cwd: &str) -> String {
    let p = cwd.replace('\\', "/");
    let p = p.trim_end_matches('/');
    match p.rsplit('/').next() { Some(b) if !b.is_empty() => b.to_string(), _ => cwd.to_string() }
}

fn newest<'a>(xs: Vec<&'a Session>) -> Option<&'a Session> {
    xs.into_iter().fold(None, |a, b| match a { Some(a) if b.last_event_at < a.last_event_at => Some(a), _ => Some(b) })
}

/** The session the pet should show: waiting > error > newest active > newest overall. */
pub fn pick_attention(all: &[Session]) -> Option<&Session> {
    // the newest wins; on a tie the later one in the list (as reduce with >= does)
    for pick in [
        &(|x: &Session| x.state == PetState::Waiting) as &dyn Fn(&Session) -> bool,
        &|x: &Session| x.state == PetState::Error,
        &|x: &Session| !x.state.quiet(),
    ] {
        let hit: Vec<&Session> = all.iter().filter(|x| pick(x)).collect();
        if !hit.is_empty() { return newest(hit); }
    }
    newest(all.iter().collect())
}

#[derive(Default)]
pub struct Store {
    /** in insertion order, as a JavaScript Map lists them */
    order: Vec<String>,
    sessions: HashMap<String, Session>,
    /** sessions whose process exited while "done" was showing: they sleep after the done period */
    ended: HashSet<String>,
}

impl Store {
    pub fn new() -> Self { Self::default() }

    pub fn apply(&mut self, ev: &HookEvent, now: i64) {
        if !self.sessions.contains_key(&ev.session_id) {
            self.order.push(ev.session_id.clone());
            self.sessions.insert(ev.session_id.clone(), Session {
                id: ev.session_id.clone(), cwd: ev.cwd.clone(), project: project_name(&ev.cwd), state: PetState::Idle,
                since: now, last_event_at: now, owned: false, pty: None, resume_cwd: None, pending_permission: None,
                source: None, soft_stop: None, mailbox: None, is_mod: None,
            });
        }
        let s = self.sessions.get_mut(&ev.session_id).unwrap();
        s.last_event_at = now;
        // a session first seen without a folder (a bare waiter, an event body without cwd) gets it from the first event that has one
        if s.cwd.is_empty() && !ev.cwd.is_empty() { s.cwd = ev.cwd.clone(); s.project = project_name(&ev.cwd); }
        if let Some(pty) = ev.pet_pty.as_ref().filter(|p| !p.is_empty()) { s.pty = Some(pty.clone()); }
        if ev.hook_event_name == "SessionEnd" {
            s.pty = None; // the wrapper (and its socket) goes away with the claude process
            if s.owned { return; } // the pet can still resume it
            if s.state == PetState::Done { self.ended.insert(s.id.clone()); return; } // let "done" stay visible
        } else {
            self.ended.remove(&ev.session_id);
        }
        if let Some(next) = map_event(ev) {
            if next != s.state { s.state = next; s.since = now; }
        }
    }

    pub fn tick(&mut self, now: i64) {
        let mut drop = Vec::new();
        for id in &self.order {
            let s = self.sessions.get_mut(id).unwrap();
            let quiet_for = now - s.last_event_at;
            if s.state == PetState::Done && now - s.since >= DONE_TO_IDLE_MS {
                s.state = if self.ended.remove(id) { PetState::Sleeping } else { PetState::Idle };
                s.since = now;
            } else if s.state == PetState::Waiting && quiet_for >= WAITING_DECAY_MS {
                s.state = PetState::Sleeping; s.since = now;
            } else if !s.state.quiet() && s.state != PetState::Waiting && quiet_for >= BUSY_DECAY_MS {
                s.state = PetState::Sleeping; s.since = now;
            } else if s.state == PetState::Idle && !s.owned && quiet_for >= IDLE_TO_SLEEP_MS {
                s.state = PetState::Sleeping; s.since = now;
            } else if s.state == PetState::Sleeping && now - s.since > SLEEPING_DROP_MS {
                drop.push(id.clone());
            }
        }
        for id in drop { self.remove(&id); }
        self.enforce_cap();
    }

    fn enforce_cap(&mut self) {
        if self.sessions.len() <= MAX_SESSIONS { return; }
        let mut droppable: Vec<(i64, String)> = self.order.iter().map(|id| &self.sessions[id])
            .filter(|x| !x.owned && (x.state == PetState::Sleeping || x.state == PetState::Idle))
            .map(|x| (x.last_event_at, x.id.clone())).collect();
        droppable.sort_by_key(|x| x.0);
        for (_, id) in droppable {
            if self.sessions.len() <= MAX_SESSIONS { break; }
            self.remove(&id);
        }
    }

    pub fn set_source(&mut self, id: &str, source: &str) {
        if let Some(s) = self.sessions.get_mut(id) { if !source.is_empty() { s.source = Some(source.into()); } }
    }
    pub fn set_pty(&mut self, id: &str, pty: &str) -> bool {
        match self.sessions.get_mut(id) { Some(s) if s.pty.as_deref() != Some(pty) => { s.pty = Some(pty.into()); true } _ => false }
    }
    pub fn clear_pty(&mut self, id: &str) { if let Some(s) = self.sessions.get_mut(id) { s.pty = None; } }

    /** An interrupt (Esc) ends the turn without any Stop hook: show the session as idle right away. */
    pub fn mark_interrupted(&mut self, id: &str, now: i64) {
        if let Some(s) = self.sessions.get_mut(id) {
            if !s.state.quiet() { s.pending_permission = None; s.state = PetState::Idle; s.since = now; }
        }
    }
    /** The folder a session was started in. Written once. */
    pub fn set_resume_cwd(&mut self, id: &str, cwd: &str) {
        if let Some(s) = self.sessions.get_mut(id) { if s.resume_cwd.is_none() && !cwd.is_empty() { s.resume_cwd = Some(cwd.into()); } }
    }
    /** Puts back what an aborted attempt had already changed (state, owned flag). */
    pub fn restore(&mut self, id: &str, state: PetState, since: i64, owned: bool) {
        if let Some(s) = self.sessions.get_mut(id) { s.state = state; s.since = since; s.owned = owned; s.pending_permission = None; }
    }
    pub fn set_owned(&mut self, id: &str, owned: bool) { if let Some(s) = self.sessions.get_mut(id) { s.owned = owned; } }
    pub fn set_pending(&mut self, id: &str, p: Option<PendingPermission>) { if let Some(s) = self.sessions.get_mut(id) { s.pending_permission = p; } }

    pub fn remove(&mut self, id: &str) {
        self.sessions.remove(id);
        self.order.retain(|x| x != id);
        self.ended.remove(id);
    }
    pub fn get(&self, id: &str) -> Option<&Session> { self.sessions.get(id) }
    pub fn list(&self) -> Vec<Session> { self.order.iter().map(|id| self.sessions[id].clone()).collect() }
    pub fn attention(&self) -> Option<String> { pick_attention(&self.list()).map(|s| s.id.clone()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(name: &str, id: &str) -> HookEvent { HookEvent::new(name, id, "/home/u/proj") }

    #[test]
    fn lifecycle() {
        let mut st = Store::new();
        st.apply(&ev("SessionStart", "a"), 0);
        assert_eq!(st.get("a").unwrap().project, "proj");
        st.apply(&ev("UserPromptSubmit", "a"), 10);
        assert_eq!(st.get("a").unwrap().state, PetState::Thinking);
        st.apply(&ev("Stop", "a"), 20);
        st.tick(20 + DONE_TO_IDLE_MS);
        assert_eq!(st.get("a").unwrap().state, PetState::Idle);
        // done, then the process ended: it sleeps after the done period
        st.apply(&ev("Stop", "a"), 100_000);
        st.apply(&ev("SessionEnd", "a"), 100_001);
        assert_eq!(st.get("a").unwrap().state, PetState::Done);
        st.tick(100_000 + DONE_TO_IDLE_MS);
        assert_eq!(st.get("a").unwrap().state, PetState::Sleeping);
        st.tick(100_000 + DONE_TO_IDLE_MS + SLEEPING_DROP_MS + 1);
        assert!(st.get("a").is_none());
    }

    #[test]
    fn busy_decays_and_attention() {
        let mut st = Store::new();
        st.apply(&ev("UserPromptSubmit", "a"), 0);
        st.apply(&ev("SessionStart", "b"), 5);
        assert_eq!(st.attention().as_deref(), Some("a")); // active beats newer idle
        let mut n = ev("Notification", "b");
        n.message = Some("needs your permission".into());
        st.apply(&n, 6);
        assert_eq!(st.attention().as_deref(), Some("b")); // waiting beats all
        st.tick(BUSY_DECAY_MS + 1);
        assert_eq!(st.get("a").unwrap().state, PetState::Sleeping);
        assert_eq!(st.get("b").unwrap().state, PetState::Waiting);
    }

    #[test]
    fn cap_drops_the_quietest() {
        let mut st = Store::new();
        for i in 0..20 { st.apply(&ev("SessionStart", &format!("s{i}")), i); }
        st.tick(100);
        assert_eq!(st.list().len(), MAX_SESSIONS);
        assert!(st.get("s0").is_none() && st.get("s19").is_some());
    }

    #[test]
    fn windows_paths() { assert_eq!(project_name("C:\\work\\app\\"), "app"); assert_eq!(project_name("/"), "/"); }
}
