//! L("русский", "English", "中文"): the bridge's few user-facing strings, in the language the app sets (Russian until told).

use std::sync::atomic::{AtomicU8, Ordering};

static LANG: AtomicU8 = AtomicU8::new(0); // 0 ru, 1 en, 2 zh

pub fn set_lang(lang: &str) {
    match lang { "ru" => LANG.store(0, Ordering::Relaxed), "en" => LANG.store(1, Ordering::Relaxed), "zh" => LANG.store(2, Ordering::Relaxed), _ => {} }
}

pub fn l(ru: &str, en: &str, zh: &str) -> String {
    match LANG.load(Ordering::Relaxed) { 1 => en, 2 => zh, _ => ru }.to_string()
}
