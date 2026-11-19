//! Port of ui/src/hub/merge.ts (+ pickAttention from daemon/src/sessionStore.ts, freshestWindow from shared/src/usageWindow.ts).
//! Sessions, snapshots and usage stay `serde_json::Value`: the renderer gets exactly the TS wire format.

use serde_json::{json, Map, Value};

/** 'windows', 'wsl' (the default distro) or 'wsl:<distro>' */
pub struct HostPart { pub host: String, pub snap: Option<Value>, pub distro: Option<String> }

/** JavaScript truthiness of an optional JSON value */
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
fn num(v: &Value, k: &str) -> f64 { v.get(k).and_then(Value::as_f64).unwrap_or(0.0) }
fn sessions(snap: &Option<Value>) -> &[Value] { snap.as_ref().and_then(|s| s["sessions"].as_array()).map_or(&[], |v| v.as_slice()) }

const QUIET: [&str; 3] = ["idle", "sleeping", "done"];

fn newest<'a>(xs: Vec<&'a Value>) -> Option<&'a Value> {
    xs.into_iter().reduce(|a, b| if num(b, "lastEventAt") >= num(a, "lastEventAt") { b } else { a })
}

/** The session the pet should show: waiting > error > newest active > newest overall. */
pub fn pick_attention(all: &[Value]) -> Option<&Value> {
    // reduce((a, b) => b.lastEventAt >= a.lastEventAt ? b : a): a later element wins a tie
    let state = |x: &Value| x["state"].as_str().unwrap_or("").to_string();
    for pick in [
        &(|x: &Value| state(x) == "waiting") as &dyn Fn(&Value) -> bool,
        &|x: &Value| state(x) == "error",
        &|x: &Value| !QUIET.contains(&state(x).as_str()),
    ] {
        if let Some(n) = newest(all.iter().filter(|x| pick(x)).collect()) { return Some(n); }
    }
    newest(all.iter().collect())
}

/** One session list from every host's snapshot (each session tagged with its host); the attention is picked across all of them. */
pub fn merge_snapshots(parts: &[HostPart]) -> Value {
    let mut all = Vec::new();
    for p in parts {
        for s in sessions(&p.snap) {
            let mut s = s.clone();
            if let Some(o) = s.as_object_mut() {
                o.insert("host".into(), json!(if p.host == "windows" { "windows" } else { "wsl" }));
                o.insert("hostId".into(), json!(p.host));
                if let Some(d) = p.distro.as_ref().filter(|d| !d.is_empty()) { o.insert("distro".into(), json!(d)); }
            }
            all.push(s);
        }
    }
    let attention = pick_attention(&all).map(|s| s["id"].clone()).unwrap_or(Value::Null);
    json!({ "type": "snapshot", "sessions": all, "attention": attention })
}

/** The host that owns a session id. */
pub fn host_of(session_id: &str, parts: &[HostPart]) -> Option<String> {
    parts.iter().find(|p| sessions(&p.snap).iter().any(|s| s["id"] == session_id)).map(|p| p.host.clone())
}

/** The host that has this pending permission id. */
pub fn host_of_permission(id: &str, parts: &[HostPart]) -> Option<String> {
    parts.iter().find(|p| sessions(&p.snap).iter().any(|s| s["pendingPermission"]["id"] == id)).map(|p| p.host.clone())
}

/** Which of two reports of the same limit window is current (later reset; within one window the higher usage). */
pub fn freshest_window(a: &Value, b: &Value) -> Value {
    if !truthy(Some(a)) { return b.clone(); }
    if !truthy(Some(b)) { return a.clone(); }
    if a["resetsAt"] != b["resetsAt"] { return if num(a, "resetsAt") > num(b, "resetsAt") { a.clone() } else { b.clone() }; }
    if num(b, "usedPct") > num(a, "usedPct") { b.clone() } else { a.clone() }
}

/** Limits as several hosts know them (mergeUsage): each window from the report current for it. */
pub fn merge_usage(parts: &[Value]) -> Option<Value> {
    if parts.is_empty() { return None; }
    if parts.len() == 1 { return Some(parts[0].clone()); }
    let has = |p: &Value, k: &str| p.get(k).map_or(false, |v| !v.is_null());
    let mut with_data: Vec<&Value> = parts.iter().filter(|p| has(p, "updatedAt") && (truthy(p.get("fiveHour")) || truthy(p.get("sevenDay")))).collect();
    with_data.sort_by(|a, b| num(b, "updatedAt").partial_cmp(&num(a, "updatedAt")).unwrap_or(std::cmp::Ordering::Equal)); // stable, like Array.sort
    let base = with_data.first().copied().unwrap_or(&parts[0]);
    let rank = |v: &Value| match v.as_str() { Some("ours") => 2, Some("other") => 1, _ => 0 };
    let mut lines: Vec<&Value> = parts.iter().map(|p| p.get("statusLine").unwrap_or(&Value::Null)).collect();
    lines.sort_by(|a, b| rank(b).cmp(&rank(a)));
    let live = parts.iter().find(|p| truthy(p.get("liveActive"))).or_else(|| parts.iter().find(|p| has(p, "lastAttemptAt")));
    let mut out: Map<String, Value> = base.as_object().cloned().unwrap_or_default();
    if !with_data.is_empty() {
        let fold = |k: &str| with_data.iter().fold(Value::Null, |acc, p| freshest_window(&acc, p.get(k).unwrap_or(&Value::Null)));
        out.insert("fiveHour".into(), fold("fiveHour"));
        out.insert("sevenDay".into(), fold("sevenDay"));
    }
    let plan = if has(base, "plan") { base["plan"].clone() } else { parts.iter().find(|p| truthy(p.get("plan"))).map_or(Value::Null, |p| p["plan"].clone()) };
    out.insert("plan".into(), plan);
    if let Some(l) = lines.first() { if !l.is_null() { out.insert("statusLine".into(), (*l).clone()); } else { out.remove("statusLine"); } }
    out.insert("liveActive".into(), json!(parts.iter().any(|p| truthy(p.get("liveActive")))));
    if parts.iter().any(|p| truthy(p.get("refreshing"))) { out.insert("refreshing".into(), json!(true)); }
    let pick = |k: &str| live.filter(|l| has(l, k)).map(|l| l[k].clone()).or_else(|| has(base, k).then(|| base[k].clone())).unwrap_or(Value::Null);
    out.insert("lastAttemptAt".into(), pick("lastAttemptAt"));
    out.insert("lastError".into(), pick("lastError"));
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, state: &str, at: i64) -> Value { json!({ "id": id, "state": state, "lastEventAt": at }) }
    fn part(host: &str, list: Vec<Value>) -> HostPart { HostPart { host: host.into(), snap: Some(json!({ "type": "snapshot", "sessions": list, "attention": null })), distro: None } }

    #[test]
    fn merges_and_tags_hosts() {
        let mut d = part("wsl:Debian", vec![s("c", "idle", 1)]);
        d.distro = Some("Debian".into());
        let m = merge_snapshots(&[part("wsl", vec![s("a", "idle", 5)]), part("windows", vec![s("b", "thinking", 2)]), d, HostPart { host: "x".into(), snap: None, distro: None }]);
        let l = m["sessions"].as_array().unwrap();
        assert_eq!(l.len(), 3);
        assert_eq!((l[0]["host"].as_str(), l[0]["hostId"].as_str()), (Some("wsl"), Some("wsl")));
        assert_eq!(l[1]["host"], "windows");
        assert_eq!((l[2]["host"].as_str(), l[2]["hostId"].as_str(), l[2]["distro"].as_str()), (Some("wsl"), Some("wsl:Debian"), Some("Debian")));
        assert_eq!(m["attention"], "b"); // active beats a newer idle one
    }

    #[test]
    fn attention_order_and_ties() {
        assert_eq!(pick_attention(&[s("a", "error", 9), s("b", "waiting", 1)]).unwrap()["id"], "b");
        assert_eq!(pick_attention(&[s("a", "idle", 3), s("b", "done", 3)]).unwrap()["id"], "b"); // a later one wins a tie
        assert!(pick_attention(&[]).is_none());
    }

    #[test]
    fn routes_by_session_and_permission() {
        let mut w = s("w1", "waiting", 1);
        w["pendingPermission"] = json!({ "id": "win-1" });
        let parts = [part("wsl", vec![s("a", "idle", 1)]), part("windows", vec![w])];
        assert_eq!(host_of("w1", &parts).as_deref(), Some("windows"));
        assert_eq!(host_of("zz", &parts), None);
        assert_eq!(host_of_permission("win-1", &parts).as_deref(), Some("windows"));
    }

    #[test]
    fn freshest_window_rules() {
        let w = |r: i64, u: f64| json!({ "resetsAt": r, "usedPct": u });
        assert_eq!(freshest_window(&Value::Null, &w(1, 2.0)), w(1, 2.0));
        assert_eq!(freshest_window(&w(2, 1.0), &w(1, 50.0)), w(2, 1.0));
        assert_eq!(freshest_window(&w(1, 10.0), &w(1, 30.0)), w(1, 30.0));
        assert_eq!(freshest_window(&w(1, 30.0), &w(1, 30.0)), w(1, 30.0));
    }

    #[test]
    fn usage_merge() {
        assert_eq!(merge_usage(&[]), None);
        let one = json!({ "plan": "pro", "updatedAt": 1 });
        assert_eq!(merge_usage(&[one.clone()]), Some(one));
        let wsl = json!({ "plan": null, "updatedAt": 100, "fiveHour": { "resetsAt": 10, "usedPct": 20 }, "sevenDay": null, "statusLine": "none", "liveActive": true, "lastAttemptAt": 90, "lastError": null, "source": "live" });
        let win = json!({ "plan": "max", "updatedAt": 200, "fiveHour": { "resetsAt": 10, "usedPct": 15 }, "sevenDay": { "resetsAt": 99, "usedPct": 3 }, "statusLine": "ours", "liveActive": false, "refreshing": true, "source": "statusline" });
        let m = merge_usage(&[wsl, win]).unwrap();
        assert_eq!(m["source"], "statusline"); // the newest report is the base
        assert_eq!(m["fiveHour"]["usedPct"], 20); // same window: the higher usage
        assert_eq!(m["sevenDay"]["resetsAt"], 99);
        assert_eq!(m["plan"], "max");
        assert_eq!(m["statusLine"], "ours");
        assert_eq!(m["liveActive"], true);
        assert_eq!(m["refreshing"], true);
        assert_eq!(m["lastAttemptAt"], 90); // from the live part
        // no data anywhere: the first part is the base, windows untouched
        let m = merge_usage(&[json!({ "updatedAt": null, "plan": null, "statusLine": "other" }), json!({ "updatedAt": null, "plan": "pro" })]).unwrap();
        assert_eq!(m["plan"], "pro");
        assert!(m.get("fiveHour").is_none());
        assert!(m.get("refreshing").is_none());
    }
}
