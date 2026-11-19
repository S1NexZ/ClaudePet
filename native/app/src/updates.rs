//! Update check (port of ui/src/updates.ts): one GET to GitHub's public "latest release" endpoint,
//! a generic User-Agent, no user data. It only reports; it never downloads or installs anything.
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

pub const RELEASES_API: &str = "https://api.github.com/repos/S1NexZ/ccPet/releases/latest";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Update {
    pub version: String,
    pub url: String,
}

/// (major, minor, patch, has pre-release tag); `v` prefix allowed, like the TS regex.
fn parse(v: &str) -> Option<([u64; 3], bool)> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    if let Some(p) = pre {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
            return None;
        }
    }
    let mut it = core.split('.');
    let mut n = [0u64; 3];
    for slot in n.iter_mut() {
        let part = it.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    if it.next().is_some() {
        return None;
    }
    Some((n, pre.is_some()))
}

/// `candidate` is a later release than `current` (a pre-release counts as earlier than its final version).
fn newer_version(candidate: &str, current: &str) -> bool {
    let (Some((a, apre)), Some((b, bpre))) = (parse(candidate), parse(current)) else { return false };
    if a != b {
        return a > b;
    }
    !apre && bpre
}

/// Pure part: decide from the releases-API answer whether it is a newer release.
pub fn newer(current: &str, latest_json: &Value) -> Option<Update> {
    let s = |k: &str| latest_json.get(k).and_then(Value::as_str).unwrap_or("");
    let flag = |k: &str| latest_json.get(k).map_or(false, |v| !matches!(v, Value::Null | Value::Bool(false)));
    let (tag, url) = (s("tag_name"), s("html_url"));
    if flag("draft") || flag("prerelease") || !url.starts_with("https://github.com/S1NexZ/ccPet/") {
        return None;
    }
    if !newer_version(tag, current) {
        return None;
    }
    Some(Update { version: tag.strip_prefix('v').unwrap_or(tag).to_string(), url: url.to_string() })
}

/// Blocking network call; any error -> None.
pub fn check_latest(current: &str) -> Option<Update> {
    let j: Value = ureq::get(RELEASES_API)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "ccPet-update-check")
        .timeout(Duration::from_secs(15))
        .call()
        .ok()?
        .into_json()
        .ok()?;
    newer(current, &j)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compares_versions() {
        assert!(newer_version("0.5.1", "0.5.0"));
        assert!(newer_version("v0.10.0", "0.9.9"));
        assert!(!newer_version("0.5.0", "0.5.0"));
        assert!(!newer_version("0.4.9", "0.5.0"));
        assert!(newer_version("1.0.0-beta.1", "0.9.0"));
        assert!(!newer_version("0.6.0-beta.1", "0.6.0"));
        assert!(newer_version("0.6.0", "0.6.0-beta.1"));
        assert!(!newer_version("garbage", "0.5.0"));
    }

    #[test]
    fn newer_release_only() {
        let url = "https://github.com/S1NexZ/ccPet/releases/tag/v0.5.1";
        let ok = json!({"tag_name": "v0.5.1", "html_url": url, "draft": false, "prerelease": false});
        assert_eq!(newer("0.5.0", &ok), Some(Update { version: "0.5.1".into(), url: url.into() }));
        assert!(newer("0.5.1", &ok).is_none());
        assert!(newer("0.5.0", &json!({"tag_name": "v0.5.0", "html_url": "https://github.com/x"})).is_none());
        assert!(newer("0.5.0", &json!({"tag_name": "v9.0.0", "html_url": "https://evil.example/ccPet"})).is_none());
        assert!(newer("0.5.0", &json!({})).is_none());
        let draft = json!({"tag_name": "v9.0.0", "html_url": "https://github.com/S1NexZ/ccPet/releases/tag/v9.0.0", "draft": true});
        assert!(newer("0.5.0", &draft).is_none());
    }

    /** hits GitHub: run by hand with `cargo test --lib live_github -- --ignored` */
    #[test]
    #[ignore]
    fn live_github() {
        let u = check_latest("0.0.1");
        eprintln!("latest: {u:?}");
        assert!(u.is_some(), "no release found (network, API rate limit, or no non-draft release)");
    }
}
