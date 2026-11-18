//! The pet's mailbox for sessions it cannot type into (mailbox.ts). A waiter is a long-poll from the session's background hook (or the
//! ccPet plugin); a message answers it. A message sent while nobody waits is kept for a few minutes and goes out with the next waiter.
//! Thread-based: `wait` blocks the calling (connection) thread.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub enum Waited { Message(String), Timeout, Busy }

#[derive(Debug, PartialEq)]
pub enum Sent { Delivered, Queued }

struct Waiter { token: u64, is_mod: bool }

#[derive(Default)]
struct Inner {
    queues: HashMap<String, Vec<(String, i64)>>,
    waiters: HashMap<String, Waiter>,
    /** what each waiting call got: Some(text) delivered, None cancelled */
    answers: HashMap<u64, Option<String>>,
    mod_seen: HashMap<String, i64>,
    next_token: u64,
}

pub struct Mailbox {
    ttl_ms: i64,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    inner: Mutex<Inner>,
    cv: Condvar,
}

const MOD_TTL_MS: i64 = 90_000;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Mailbox {
    pub fn new() -> Self { Self::with_clock(5 * 60_000, Box::new(now_ms)) }

    pub fn with_clock(ttl_ms: i64, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Mailbox { ttl_ms, now, inner: Mutex::new(Inner::default()), cv: Condvar::new() }
    }

    fn fresh(&self, inner: &mut Inner, sid: &str) -> usize {
        let now = (self.now)();
        let ttl = self.ttl_ms;
        let n = match inner.queues.get_mut(sid) {
            Some(q) => { q.retain(|(_, at)| now - at < ttl); q.len() }
            None => 0,
        };
        if n == 0 { inner.queues.remove(sid); }
        n
    }

    /** Delivered: a waiter took it now; Queued: it goes out when the next waiter arrives. */
    pub fn send(&self, sid: &str, text: &str) -> Sent {
        let mut g = self.inner.lock().unwrap();
        if let Some(w) = g.waiters.remove(sid) {
            g.answers.insert(w.token, Some(text.to_string()));
            self.cv.notify_all();
            return Sent::Delivered;
        }
        self.fresh(&mut g, sid);
        let now = (self.now)();
        g.queues.entry(sid.to_string()).or_default().push((text.to_string(), now));
        Sent::Queued
    }

    /** Blocks up to `wait` for a message; Busy when another waiter already waits for this session. `on_start` runs once registered. */
    pub fn wait(&self, sid: &str, wait: Duration, is_mod: bool, gone: &dyn Fn() -> bool) -> Waited {
        let mut g = self.inner.lock().unwrap();
        if g.waiters.contains_key(sid) { return Waited::Busy; }
        if self.fresh(&mut g, sid) > 0 {
            let q = g.queues.remove(sid).unwrap_or_default();
            return Waited::Message(q.into_iter().map(|(t, _)| t).collect::<Vec<_>>().join("\n\n"));
        }
        g.next_token += 1;
        let token = g.next_token;
        g.waiters.insert(sid.to_string(), Waiter { token, is_mod });
        let deadline = Instant::now() + wait;
        loop {
            if let Some(a) = g.answers.remove(&token) {
                return match a { Some(t) => Waited::Message(t), None => Waited::Timeout };
            }
            let now = Instant::now();
            // the client went away (its hook process was killed): free the slot so a later message is queued instead of lost
            if now >= deadline || gone() {
                if g.waiters.get(sid).map_or(false, |w| w.token == token) { g.waiters.remove(sid); }
                return Waited::Timeout;
            }
            let step = (deadline - now).min(Duration::from_millis(500));
            g = self.cv.wait_timeout(g, step).unwrap().0;
        }
    }

    pub fn has_waiter(&self, sid: &str) -> bool { self.inner.lock().unwrap().waiters.contains_key(sid) }

    /** The waiter went away: its call returns Timeout. */
    pub fn cancel(&self, sid: &str) {
        let mut g = self.inner.lock().unwrap();
        if let Some(w) = g.waiters.remove(sid) { g.answers.insert(w.token, None); self.cv.notify_all(); }
    }

    pub fn pending(&self, sid: &str) -> usize { let mut g = self.inner.lock().unwrap(); self.fresh(&mut g, sid) }
    pub fn mark_mod(&self, sid: &str) { let now = (self.now)(); self.inner.lock().unwrap().mod_seen.insert(sid.into(), now); }
    pub fn is_mod(&self, sid: &str) -> bool {
        let g = self.inner.lock().unwrap();
        g.mod_seen.get(sid).map_or(false, |at| (self.now)() - at < MOD_TTL_MS)
    }
    pub fn waiter_is_mod(&self, sid: &str) -> bool { self.inner.lock().unwrap().waiters.get(sid).map_or(false, |w| w.is_mod) }
}

impl Default for Mailbox { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn delivers_to_a_waiter_and_queues_otherwise() {
        let mb = Arc::new(Mailbox::new());
        assert_eq!(mb.send("s", "one"), Sent::Queued);
        assert_eq!(mb.send("s", "two"), Sent::Queued);
        match mb.wait("s", Duration::from_millis(10), false, &|| false) { Waited::Message(t) => assert_eq!(t, "one\n\ntwo"), _ => panic!() }
        let m2 = mb.clone();
        let h = std::thread::spawn(move || m2.wait("s", Duration::from_secs(5), false, &|| false));
        while !mb.has_waiter("s") { std::thread::sleep(Duration::from_millis(5)); }
        assert!(matches!(mb.wait("s", Duration::from_millis(10), false, &|| false), Waited::Busy));
        assert_eq!(mb.send("s", "hi"), Sent::Delivered);
        match h.join().unwrap() { Waited::Message(t) => assert_eq!(t, "hi"), _ => panic!() }
        assert!(!mb.has_waiter("s"));
    }

    #[test]
    fn times_out_cancels_and_expires() {
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(0));
        let c = clock.clone();
        let mb = Arc::new(Mailbox::with_clock(1000, Box::new(move || c.load(std::sync::atomic::Ordering::Relaxed))));
        assert!(matches!(mb.wait("s", Duration::from_millis(20), false, &|| false), Waited::Timeout));
        assert!(!mb.has_waiter("s"));
        let m2 = mb.clone();
        let h = std::thread::spawn(move || m2.wait("s", Duration::from_secs(5), true, &|| false));
        while !mb.has_waiter("s") { std::thread::sleep(Duration::from_millis(5)); }
        assert!(mb.waiter_is_mod("s"));
        mb.cancel("s");
        assert!(matches!(h.join().unwrap(), Waited::Timeout));
        mb.send("s", "old");
        clock.store(2000, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(mb.pending("s"), 0);
        mb.mark_mod("s");
        assert!(mb.is_mod("s"));
        clock.store(2000 + MOD_TTL_MS, std::sync::atomic::Ordering::Relaxed);
        assert!(!mb.is_mod("s"));
    }

    #[test]
    fn a_gone_client_frees_the_slot() {
        let mb = Mailbox::new();
        assert!(matches!(mb.wait("s", Duration::from_secs(5), false, &|| true), Waited::Timeout));
        assert!(!mb.has_waiter("s"));
    }
}
