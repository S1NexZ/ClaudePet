//! Port of ui/src/settings.ts (+ appearance.ts cleanAppearance, petScale.ts clampScale).
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

pub const PERMISSION_POLICIES: &[&str] = &["ask", "edits", "all"];
pub const LANG_PREFS: &[&str] = &["auto", "ru", "en", "zh"];
pub const PET_SCALE_MIN: f64 = 0.6;
pub const PET_SCALE_MAX: f64 = 1.8;
const PET_SCALE_DEFAULT: f64 = 1.0;
pub const DEFAULT_MODEL: &str = "claude-maiden";

#[derive(Clone, Debug, PartialEq, Serialize, Default)]
pub struct Appearance {
    pub primary: Option<String>,
    pub accent: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub autostart: bool,
    pub notify: bool,
    pub hotkey: String,
    pub model: String,
    pub appearance: Appearance,
    pub permissions: String,
    pub answer_permissions: bool,
    pub sdk_chats: bool,
    pub new_chat_in: String,
    pub desktop_send: String,
    pub check_updates: bool,
    pub language: String,
    pub pet_scale: f64,
    pub answer_keys: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            autostart: false,
            notify: true,
            hotkey: "Control+Alt+P".into(),
            model: DEFAULT_MODEL.into(),
            appearance: Appearance::default(),
            permissions: "ask".into(),
            answer_permissions: false,
            sdk_chats: false,
            new_chat_in: "wsl".into(),
            desktop_send: "real".into(),
            check_updates: true,
            language: "auto".into(),
            pet_scale: 1.0,
            answer_keys: true,
        }
    }
}

/// MODEL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
fn model_id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let ok = |c: u8, dash: bool| c.is_ascii_lowercase() || c.is_ascii_digit() || (dash && c == b'-');
    (1..=40).contains(&b.len()) && ok(b[0], false) && b[1..].iter().all(|&c| ok(c, true))
}

fn clean_color(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    let ok = s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|c| c.is_ascii_hexdigit());
    ok.then(|| s.to_ascii_lowercase())
}

pub fn clean_appearance(v: &Value) -> Appearance {
    Appearance { primary: clean_color(v.get("primary")), accent: clean_color(v.get("accent")) }
}

pub fn clamp_scale(v: &Value) -> f64 {
    let n = v.as_f64().filter(|n| n.is_finite()).unwrap_or(PET_SCALE_DEFAULT);
    (n.clamp(PET_SCALE_MIN, PET_SCALE_MAX) * 20.0).round() / 20.0
}

pub fn load(path: &Path) -> Settings {
    let raw: Value = match std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()) {
        Some(v) => v,
        None => return Settings::default(),
    };
    let d = Settings::default();
    let get = |k: &str| raw.get(k).unwrap_or(&Value::Null);
    let boolean = |k: &str, def: bool| get(k).as_bool().unwrap_or(def);
    let string = |k: &str, def: &str| get(k).as_str().unwrap_or(def).to_string();
    let one_of = |k: &str, allowed: &[&str], def: &str| match get(k).as_str() {
        Some(s) if allowed.contains(&s) => s.to_string(),
        _ => def.to_string(),
    };
    Settings {
        autostart: boolean("autostart", d.autostart),
        notify: boolean("notify", d.notify),
        hotkey: string("hotkey", &d.hotkey),
        model: match get("model").as_str() {
            Some(m) if model_id_ok(m) => m.to_string(),
            _ => d.model,
        },
        appearance: clean_appearance(get("appearance")),
        permissions: one_of("permissions", PERMISSION_POLICIES, "ask"),
        answer_permissions: get("answerPermissions") == &Value::Bool(true),
        sdk_chats: get("sdkChats") == &Value::Bool(true),
        new_chat_in: one_of("newChatIn", &["windows", "desktop"], "wsl"),
        desktop_send: one_of("desktopSend", &["hook"], "real"),
        check_updates: get("checkUpdates") != &Value::Bool(false),
        language: one_of("language", LANG_PREFS, "auto"),
        pet_scale: clamp_scale(get("petScale")),
        answer_keys: get("answerKeys") != &Value::Bool(false),
    }
}

pub fn save(path: &Path, s: &Settings) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(s).map_err(std::io::Error::other)?;
    std::fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);
    struct Tmp(std::path::PathBuf);
    impl Tmp {
        fn new() -> Tmp {
            let n = N.fetch_add(1, Ordering::SeqCst);
            Tmp(std::env::temp_dir().join(format!("ccpet-settings-{}-{}.json", std::process::id(), n)))
        }
        fn write(&self, v: Value) { std::fs::write(&self.0, v.to_string()).unwrap(); }
        fn load(&self) -> Settings { load(&self.0) }
    }
    impl Drop for Tmp { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }

    #[test]
    fn missing_and_corrupt_give_defaults() {
        let f = Tmp::new();
        assert_eq!(f.load(), Settings::default());
        std::fs::write(&f.0, "{nope").unwrap();
        assert_eq!(f.load(), Settings::default());
        f.write(json!({"autostart": "yes", "notify": false, "hotkey": 42}));
        assert_eq!(f.load(), Settings { notify: false, ..Settings::default() });
        f.write(json!({"model": "../evil"}));
        assert_eq!(f.load().model, DEFAULT_MODEL);
        f.write(json!(null));
        assert_eq!(f.load(), Settings::default());
    }

    #[test]
    fn hotkey_and_model() {
        assert_eq!(Settings::default().hotkey, "Control+Alt+P");
        let f = Tmp::new();
        f.write(json!({"hotkey": ""}));
        assert_eq!(f.load().hotkey, "");
        f.write(json!({"model": "my-pet"}));
        assert_eq!(f.load().model, "my-pet");
        f.write(json!({"model": "-x"}));
        assert_eq!(f.load().model, DEFAULT_MODEL);
        f.write(json!({"model": "a".repeat(41)}));
        assert_eq!(f.load().model, DEFAULT_MODEL);
    }

    #[test]
    fn round_trips_and_json_shape() {
        let f = Tmp::new();
        let s = Settings {
            autostart: true, notify: false, hotkey: "Control+Shift+K".into(), model: "clawd".into(),
            answer_keys: false, ..Settings::default()
        };
        save(&f.0, &s).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&f.0).unwrap()).unwrap();
        assert_eq!(v["appearance"], json!({"primary": null, "accent": null}));
        assert_eq!(v["answerKeys"], json!(false));
        assert_eq!(v["newChatIn"], json!("wsl"));
        assert_eq!(f.load(), s);
    }

    #[test]
    fn appearance_validated_and_persisted() {
        let f = Tmp::new();
        f.write(json!({"appearance": {"primary": "#FF0000", "accent": "javascript:1"}}));
        assert_eq!(f.load().appearance, Appearance { primary: Some("#ff0000".into()), accent: None });
        let s = Settings { appearance: Appearance { primary: Some("#4f8cff".into()), accent: Some("#ff6b9d".into()) }, ..Settings::default() };
        save(&f.0, &s).unwrap();
        assert_eq!(f.load().appearance, s.appearance);
    }

    #[test]
    fn clean_appearance_cases() {
        assert_eq!(clean_appearance(&json!({"primary": "#FF0000", "accent": "nope", "extra": 1})),
            Appearance { primary: Some("#ff0000".into()), accent: None });
        for bad in [json!("#fff"), json!("red"), json!("39c5bb"), json!("#12345g"), json!("#1234567"), json!(""), json!(null), json!(5), json!("#ff0000; background:url(x)")] {
            assert_eq!(clean_appearance(&json!({"primary": bad})).primary, None);
        }
        assert_eq!(clean_appearance(&json!({"primary": "#39C5BB"})).primary.as_deref(), Some("#39c5bb"));
        assert_eq!(clean_appearance(&Value::Null), Appearance::default());
        assert_eq!(clean_appearance(&json!("x")), Appearance::default());
    }

    #[test]
    fn enums_fall_back() {
        let f = Tmp::new();
        f.write(json!({"permissions": "edits", "language": "en", "newChatIn": "desktop", "desktopSend": "hook"}));
        let s = f.load();
        assert_eq!((s.permissions.as_str(), s.language.as_str(), s.new_chat_in.as_str(), s.desktop_send.as_str()), ("edits", "en", "desktop", "hook"));
        f.write(json!({"permissions": "root", "language": "fr", "newChatIn": "mars", "desktopSend": "x"}));
        assert_eq!(f.load(), Settings::default());
        f.write(json!({"newChatIn": "windows"}));
        assert_eq!(f.load().new_chat_in, "windows");
    }

    #[test]
    fn bool_flags() {
        let f = Tmp::new();
        f.write(json!({"answerPermissions": 1, "sdkChats": "true", "checkUpdates": 0, "answerKeys": null}));
        let s = f.load();
        assert!(!s.answer_permissions && !s.sdk_chats && s.check_updates && s.answer_keys);
        f.write(json!({"answerPermissions": true, "sdkChats": true, "checkUpdates": false, "answerKeys": false}));
        let s = f.load();
        assert!(s.answer_permissions && s.sdk_chats && !s.check_updates && !s.answer_keys);
    }

    #[test]
    fn pet_scale() {
        let f = Tmp::new();
        f.write(json!({"petScale": 1.52}));
        assert_eq!(f.load().pet_scale, 1.5);
        f.write(json!({"petScale": 50}));
        assert_eq!(f.load().pet_scale, 1.8);
        f.write(json!({"petScale": "x"}));
        assert_eq!(f.load().pet_scale, 1.0);
        assert_eq!(clamp_scale(&json!(1)), 1.0);
        assert_eq!(clamp_scale(&json!(0.1)), 0.6);
        assert_eq!(clamp_scale(&json!(9)), 1.8);
        assert_eq!(clamp_scale(&json!(1.23)), 1.25);
        assert_eq!(clamp_scale(&json!("big")), 1.0);
        assert_eq!(clamp_scale(&Value::Null), 1.0);
    }
}
