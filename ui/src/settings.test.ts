import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, saveSettings, DEFAULTS } from './settings.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'pset-')), 's.json');

describe('settings', () => {
  it('missing file gives defaults', () => expect(loadSettings(file())).toEqual(DEFAULTS));
  it('corrupt or wrongly typed content gives defaults for the bad fields', () => {
    const f = file(); writeFileSync(f, '{nope');
    expect(loadSettings(f)).toEqual(DEFAULTS);
    writeFileSync(f, JSON.stringify({ autostart: 'yes', notify: false, hotkey: 42 }));
    expect(loadSettings(f)).toEqual({ ...DEFAULTS, notify: false });
    writeFileSync(f, JSON.stringify({ model: '../evil' }));
    expect(loadSettings(f).model).toBe(DEFAULTS.model);
  });
  it('default hotkey is Control+Alt+P; an empty string disables it', () => {
    expect(DEFAULTS.hotkey).toBe('Control+Alt+P');
    const f = file(); writeFileSync(f, JSON.stringify({ hotkey: '' }));
    expect(loadSettings(f).hotkey).toBe('');
  });
  it('round-trips', () => {
    const f = file();
    saveSettings(f, { autostart: true, notify: false, hotkey: 'Control+Shift+K', model: 'clawd', appearance: { primary: null, accent: null }, permissions: 'ask', answerPermissions: false, sdkChats: false, newChatIn: 'wsl', checkUpdates: true, language: 'auto', petScale: 1 });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ autostart: true, notify: false, hotkey: 'Control+Shift+K', model: 'clawd', appearance: { primary: null, accent: null }, permissions: 'ask', answerPermissions: false, sdkChats: false, newChatIn: 'wsl', checkUpdates: true, language: 'auto', petScale: 1 });
    expect(loadSettings(f)).toEqual({ autostart: true, notify: false, hotkey: 'Control+Shift+K', model: 'clawd', appearance: { primary: null, accent: null }, permissions: 'ask', answerPermissions: false, sdkChats: false, newChatIn: 'wsl', checkUpdates: true, language: 'auto', petScale: 1 });
  });
  it('a fresh install uses Claude-maiden; a valid model id is kept', () => {
    expect(DEFAULTS.model).toBe('claude-maiden');
    const f = file(); writeFileSync(f, JSON.stringify({ model: 'my-pet' }));
    expect(loadSettings(f).model).toBe('my-pet');
  });
  it('appearance is validated and survives a save/load round trip (a restart)', () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ appearance: { primary: '#FF0000', accent: 'javascript:1' } }));
    expect(loadSettings(f).appearance).toEqual({ primary: '#ff0000', accent: null });
    saveSettings(f, { ...DEFAULTS, appearance: { primary: '#4f8cff', accent: '#ff6b9d' } });
    expect(loadSettings(f).appearance).toEqual({ primary: '#4f8cff', accent: '#ff6b9d' });
    expect(loadSettings(file()).appearance).toEqual({ primary: null, accent: null });
  });

  it('permissions: default is ask; valid values persist; garbage falls back to ask', () => {
    expect(DEFAULTS.permissions).toBe('ask');
    const f = file(); saveSettings(f, { ...DEFAULTS, permissions: 'edits' });
    expect(loadSettings(f).permissions).toBe('edits');
    writeFileSync(f, JSON.stringify({ permissions: 'root' }));
    expect(loadSettings(f).permissions).toBe('ask');
  });

  it('language: default auto; ru/en persist; garbage falls back to auto', () => {
    expect(DEFAULTS.language).toBe('auto');
    const f = file(); saveSettings(f, { ...DEFAULTS, language: 'en' });
    expect(loadSettings(f).language).toBe('en');
    writeFileSync(f, JSON.stringify({ language: 'fr' }));
    expect(loadSettings(f).language).toBe('auto');
  });

  it('petScale: default 1; clamped and rounded on load', () => {
    expect(DEFAULTS.petScale).toBe(1);
    const f = file(); writeFileSync(f, JSON.stringify({ petScale: 1.52 }));
    expect(loadSettings(f).petScale).toBe(1.5);
    writeFileSync(f, JSON.stringify({ petScale: 50 }));
    expect(loadSettings(f).petScale).toBe(1.8);
    writeFileSync(f, JSON.stringify({ petScale: 'x' }));
    expect(loadSettings(f).petScale).toBe(1);
  });
  it('new chats start in WSL by default; "windows" is kept, anything else falls back', () => {
    expect(DEFAULTS.newChatIn).toBe('wsl');
    const f = file(); writeFileSync(f, JSON.stringify({ newChatIn: 'windows' }));
    expect(loadSettings(f).newChatIn).toBe('windows');
    writeFileSync(f, JSON.stringify({ newChatIn: 'mars' }));
    expect(loadSettings(f).newChatIn).toBe('wsl');
  });
});

