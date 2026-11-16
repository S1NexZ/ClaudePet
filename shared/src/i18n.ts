/**
 * Tiny UI localisation: every user-facing string is written in place as L('русский', 'English').
 * The language is chosen once at startup (and on change) with setLang; Russian is the default so tests and old callers keep working.
 * Strings that are built at module load must be functions, because the language can change after import.
 */
export type Lang = 'ru' | 'en' | 'zh';
export type LangPref = 'auto' | Lang;
export const LANG_PREFS: readonly LangPref[] = ['auto', 'ru', 'en', 'zh'];

let current: Lang = 'ru';
export const setLang = (l: Lang): void => { current = l; };
export const getLang = (): Lang => current;
/** Chinese is optional: a string without a translation falls back to English. */
export const L = (ru: string, en: string, zh?: string): string => (current === 'zh' ? (zh ?? en) : current === 'en' ? en : ru);

/** 'auto' follows the system language: Russian -> ru, Chinese -> zh, anything else -> en. */
export function resolveLang(pref: unknown, systemLocale: string): Lang {
  if (pref === 'ru' || pref === 'en' || pref === 'zh') return pref;
  if (/^zh\b/i.test(systemLocale || '')) return 'zh';
  return /^ru\b/i.test(systemLocale || '') ? 'ru' : 'en';
}
