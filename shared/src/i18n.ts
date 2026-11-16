/**
 * Tiny UI localisation: every user-facing string is written in place as L('русский', 'English').
 * The language is chosen once at startup (and on change) with setLang; Russian is the default so tests and old callers keep working.
 * Strings that are built at module load must be functions, because the language can change after import.
 */
export type Lang = 'ru' | 'en';
export type LangPref = 'auto' | Lang;
export const LANG_PREFS: readonly LangPref[] = ['auto', 'ru', 'en'];

let current: Lang = 'ru';
export const setLang = (l: Lang): void => { current = l; };
export const getLang = (): Lang => current;
export const L = (ru: string, en: string): string => (current === 'en' ? en : ru);

/** 'auto' follows the system language: Russian system -> ru, anything else -> en. */
export function resolveLang(pref: unknown, systemLocale: string): Lang {
  if (pref === 'ru' || pref === 'en') return pref;
  return /^ru\b/i.test(systemLocale || '') ? 'ru' : 'en';
}
