import { describe, it, expect, afterEach } from 'vitest';
import { L, setLang, getLang, resolveLang } from './i18n.js';

describe('i18n', () => {
  afterEach(() => setLang('ru'));
  it('is Russian by default and switches with setLang', () => {
    expect(getLang()).toBe('ru');
    expect(L('Привет', 'Hello')).toBe('Привет');
    setLang('en');
    expect(L('Привет', 'Hello')).toBe('Hello');
  });
  it('auto follows the system: ru-* is Russian, everything else English; an explicit choice wins', () => {
    expect(resolveLang('auto', 'ru')).toBe('ru');
    expect(resolveLang('auto', 'ru-RU')).toBe('ru');
    expect(resolveLang('auto', 'en-US')).toBe('en');
    expect(resolveLang('auto', 'de')).toBe('en');
    expect(resolveLang('auto', '')).toBe('en');
    expect(resolveLang('en', 'ru')).toBe('en');
    expect(resolveLang('ru', 'en-US')).toBe('ru');
    expect(resolveLang(undefined, 'ru-RU')).toBe('ru');
  });
  it('Chinese: zh-* follows the system, an explicit choice wins, a missing translation falls back to English', () => {
    expect(resolveLang('auto', 'zh-CN')).toBe('zh');
    expect(resolveLang('auto', 'zh-TW')).toBe('zh');
    expect(resolveLang('zh', 'en-US')).toBe('zh');
    setLang('zh');
    expect(L('Привет', 'Hello', '你好')).toBe('你好');
    expect(L('Привет', 'Hello')).toBe('Hello');
  });
});
