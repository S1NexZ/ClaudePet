import { readFileSync, writeFileSync } from 'node:fs';

import { MODEL_ID, DEFAULT_MODEL } from './models/registry.js';
import { clampScale } from './petScale.js';
import { LANG_PREFS, type LangPref } from '../../shared/src/i18n.js';
import { PERMISSION_POLICIES, type PermissionPolicy } from '../../shared/src/types.js';
import { cleanAppearance, type Appearance } from './appearance.js';

export interface Settings { autostart: boolean; notify: boolean; hotkey: string; /** id of the active pet model */ model: string; appearance: Appearance; /** how the chat answers tool permission requests */ permissions: PermissionPolicy; /** answer Claude Code's permission questions in the pet (adds the PermissionRequest hook; off by default) */ answerPermissions: boolean; /** let the pet start Claude Code itself through the Agent SDK (new chats, resume fallback); off by default */ sdkChats: boolean; /** where a new chat (a new terminal session) starts when the Agent SDK is off */ newChatIn: 'wsl' | 'windows' | 'desktop'; /** messages to a Claude desktop chat: typed into the app as a real message ("real"), or delivered silently through the hook ("hook") */ desktopSend: 'real' | 'hook'; /** once a day, ask GitHub whether a newer release exists (only tells; never installs) */ checkUpdates: boolean; /** UI language: follow the system or fixed */ language: LangPref; /** pet size, 0.6-1.8 */ petScale: number }
export const DEFAULTS: Settings = { autostart: false, notify: true, hotkey: 'Control+Alt+P', model: DEFAULT_MODEL, appearance: { primary: null, accent: null }, permissions: 'ask', answerPermissions: false, sdkChats: false, newChatIn: 'wsl', desktopSend: 'real', checkUpdates: true, language: 'auto', petScale: 1 };

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
      answerPermissions: raw.answerPermissions === true,
      sdkChats: raw.sdkChats === true,
      newChatIn: raw.newChatIn === 'windows' || raw.newChatIn === 'desktop' ? raw.newChatIn : 'wsl',
      desktopSend: raw.desktopSend === 'hook' ? 'hook' : 'real',
      checkUpdates: raw.checkUpdates !== false,
      permissions: PERMISSION_POLICIES.includes(raw.permissions as PermissionPolicy) ? (raw.permissions as PermissionPolicy) : DEFAULTS.permissions,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(file: string, s: Settings): void {
  writeFileSync(file, JSON.stringify(s, null, 2));
}
