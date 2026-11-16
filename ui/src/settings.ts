import { readFileSync, writeFileSync } from 'node:fs';

import { MODEL_ID, DEFAULT_MODEL } from './models/registry.js';
import { clampScale } from './petScale.js';
import { LANG_PREFS, type LangPref } from '../../shared/src/i18n.js';
import { PERMISSION_POLICIES, type PermissionPolicy } from '../../shared/src/types.js';
import { cleanAppearance, type Appearance } from './appearance.js';

export interface Settings { autostart: boolean; notify: boolean; hotkey: string; /** id of the active pet model */ model: string; appearance: Appearance; /** how the chat answers tool permission requests */ permissions: PermissionPolicy; /** UI language: follow the system or fixed */ language: LangPref; /** pet size, 0.6-1.8 */ petScale: number }
export const DEFAULTS: Settings = { autostart: false, notify: true, hotkey: 'Control+Alt+P', model: DEFAULT_MODEL, appearance: { primary: null, accent: null }, permissions: 'ask', language: 'auto', petScale: 1 };

export function loadSettings(file: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>;
    return {
      autostart: typeof raw.autostart === 'boolean' ? raw.autostart : DEFAULTS.autostart,
      notify: typeof raw.notify === 'boolean' ? raw.notify : DEFAULTS.notify,
      hotkey: typeof raw.hotkey === 'string' ? raw.hotkey : DEFAULTS.hotkey,
      model: typeof raw.model === 'string' && MODEL_ID.test(raw.model) ? raw.model : DEFAULTS.model,
      appearance: cleanAppearance(raw.appearance),
      petScale: clampScale(raw.petScale),
      language: LANG_PREFS.includes(raw.language as LangPref) ? (raw.language as LangPref) : DEFAULTS.language,
      permissions: PERMISSION_POLICIES.includes(raw.permissions as PermissionPolicy) ? (raw.permissions as PermissionPolicy) : DEFAULTS.permissions,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(file: string, s: Settings): void {
  writeFileSync(file, JSON.stringify(s, null, 2));
}
