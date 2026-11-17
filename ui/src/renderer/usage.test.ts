import { describe, it, expect } from 'vitest';
import { windowView, usageStatus, planLabel, fmtPct, fmtAge, fmtIn, panelModel, ringModel, errorText, STALE_MS, STALE_LIVE_MS } from './usage.js';
import type { UsageInfo } from '../../../shared/src/types.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);
const info = (o: Partial<UsageInfo> = {}): UsageInfo => ({
  plan: 'pro', updatedAt: NOW - 60_000, statusLine: 'ours',
  fiveHour: { usedPct: 23.5, resetsAt: sec(NOW + 2 * 3600_000 + 15 * 60_000) },
  sevenDay: { usedPct: 41.2, resetsAt: sec(NOW + 3 * 86400_000) }, ...o,
});

describe('windows', () => {
  it('current / expired / missing', () => {
    expect(windowView({ usedPct: 10, resetsAt: sec(NOW + 1000) + 1 }, NOW).kind).toBe('ok');
    expect(windowView({ usedPct: 10, resetsAt: sec(NOW) }, NOW).kind).toBe('expired');
    expect(windowView(null, NOW).kind).toBe('none');
  });
});

describe('status', () => {
  it('unavailable without data, fresh, stale after the threshold', () => {
    expect(usageStatus(null, NOW)).toBe('unavailable');
    expect(usageStatus(info({ updatedAt: null }), NOW)).toBe('unavailable');
    expect(usageStatus(info({ fiveHour: null, sevenDay: null }), NOW)).toBe('unavailable');
    expect(usageStatus(info(), NOW)).toBe('fresh');
    expect(usageStatus(info({ updatedAt: NOW - STALE_MS - 1 }), NOW)).toBe('stale');
  });
});

describe('formatting', () => {
  it('plan label never invents Pro', () => {
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('max')).toBe('Max');
    expect(planLabel(null)).toBe('План неизвестен');
    expect(planLabel('weird')).toBe('Weird');
  });
  it('percentages', () => {
    expect(fmtPct(23.5)).toBe('24%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(0.4)).toBe('<1%');
    expect(fmtPct(100)).toBe('100%');
  });
  it('age', () => {
    expect(fmtAge(NOW - 5000, NOW)).toBe('только что');
    expect(fmtAge(NOW - 5 * 60_000, NOW)).toBe('5 мин назад');
    expect(fmtAge(NOW - 3 * 3600_000, NOW)).toBe('3 ч назад');
    expect(fmtAge(NOW - 2 * 86400_000, NOW)).toBe('2 д назад');
  });
  it('time until reset', () => {
    expect(fmtIn(sec(NOW + 45 * 60_000), NOW)).toBe('45 мин');
    expect(fmtIn(sec(NOW + 2 * 3600_000 + 15 * 60_000), NOW)).toBe('2 ч 15 мин');
    expect(fmtIn(sec(NOW + 3 * 3600_000), NOW)).toBe('3 ч');
    expect(fmtIn(sec(NOW + 60 * 3600_000), NOW)).toBe('2 д 12 ч');
    expect(fmtIn(sec(NOW - 1000), NOW)).toBe('сейчас');
    expect(fmtIn(sec(NOW + 1000), NOW)).toBe('1 мин');
  });
});

describe('panel', () => {
  it('shows real values, reset hints and age', () => {
    const p = panelModel(info(), NOW);
    expect(p.header).toBe('Лимиты использования плана · Pro');
    expect(p.status).toBe('fresh');
    expect(p.rows[0]).toMatchObject({ label: '5-часовой лимит', pct: 23.5, value: '24% использовано' });
    expect(p.rows[0].sub).toMatch(/^Сброс через 2 ч 15 мин \(\d\d:\d\d\)$/);
    expect(p.rows[1]).toMatchObject({ label: 'Недельный лимит · все модели', pct: 41.2 });
    expect(p.rows[1].sub).toMatch(/^Сброс в \S+, \d\d:\d\d$/);
    expect(p.footer).toMatch(/^Последнее успешное обновление: \d\d:\d\d:\d\d \(1 мин назад\)$/);
    expect(p.note).toBe('');
  });
  it('stale data is labelled, not hidden', () => {
    const p = panelModel(info({ updatedAt: NOW - 40 * 60_000 }), NOW);
    expect(p.status).toBe('stale');
    expect(p.footer).toMatch(/^Данные устарели · последнее успешное обновление: \d\d:\d\d:\d\d \(40 мин назад\)/);
    expect(p.rows[0].pct).toBe(23.5);
  });
  it('an expired window is not shown as a percentage', () => {
    const p = panelModel(info({ fiveHour: { usedPct: 99, resetsAt: sec(NOW - 5000) } }), NOW);
    expect(p.rows[0]).toMatchObject({ pct: null, value: '—' });
    expect(p.rows[0].sub).toMatch(/сброшен/);
    expect(p.rows[1].pct).toBe(41.2);
  });
  it('a missing window says so', () => {
    expect(panelModel(info({ sevenDay: null }), NOW).rows[1]).toMatchObject({ pct: null, sub: 'Нет данных' });
  });
  it('unavailable explains why, per statusLine state, and unknown plan is not Pro', () => {
    expect(panelModel(null, NOW).message).toMatch(/мостом/);
    expect(panelModel(info({ updatedAt: null, fiveHour: null, sevenDay: null, statusLine: 'none' }), NOW).message).toMatch(/подключите статус-строку/);
    expect(panelModel(info({ updatedAt: null, fiveHour: null, sevenDay: null, statusLine: 'ours' }), NOW).message).toMatch(/первого ответа/);
    expect(panelModel(info({ updatedAt: null, fiveHour: null, sevenDay: null, statusLine: 'other' }), NOW).message).toMatch(/Данных пока нет/);
    expect(panelModel(info({ plan: null }), NOW).header).toBe('Лимиты использования плана · План неизвестен');
  });
});

describe('ring', () => {
  it('shows the fuller window (the one that stops work first), colours by level', () => {
    expect(ringModel(info(), NOW)).toMatchObject({ text: '41', level: 'ok', stale: false });
    // a nearly used-up week with a fresh 5 h window: the ring warns about the week
    expect(ringModel(info({ fiveHour: { usedPct: 14, resetsAt: sec(NOW + 1e6) }, sevenDay: { usedPct: 94, resetsAt: sec(NOW + 1e6) } }), NOW)).toMatchObject({ text: '94', level: 'high' });
    expect(ringModel(info({ fiveHour: { usedPct: 80, resetsAt: sec(NOW + 1e6) } }), NOW).level).toBe('warn');
    expect(ringModel(info({ fiveHour: { usedPct: 95, resetsAt: sec(NOW + 1e6) } }), NOW).level).toBe('high');
    expect(ringModel(info({ fiveHour: null }), NOW).text).toBe('41');
    // a used-up limit reads 100 (not a frozen 99) and gets its own level
    expect(ringModel(info({ fiveHour: { usedPct: 100, resetsAt: sec(NOW + 1e6) } }), NOW)).toMatchObject({ text: '100', level: 'full', pct: 100 });
    expect(ringModel(info({ fiveHour: { usedPct: 99.6, resetsAt: sec(NOW + 1e6) } }), NOW)).toMatchObject({ text: '100', level: 'full' });
    expect(ringModel(info({ fiveHour: { usedPct: 99.2, resetsAt: sec(NOW + 1e6) } }), NOW)).toMatchObject({ text: '99', level: 'high' });
  });
  it('unavailable, expired and stale', () => {
    expect(ringModel(null, NOW)).toMatchObject({ pct: null, level: 'none' });
    const exp = ringModel(info({ fiveHour: { usedPct: 9, resetsAt: sec(NOW - 1) }, sevenDay: null }), NOW);
    expect(exp.pct).toBeNull();
    expect(ringModel(info({ updatedAt: NOW - STALE_MS - 1 }), NOW).stale).toBe(true);
  });
});

describe('periodic query states', () => {
  const live = (o: Partial<UsageInfo> = {}) => info({ source: 'live', liveActive: true, lastError: null, lastAttemptAt: NOW - 5000, updatedAt: NOW - 5000, ...o });
  it('with the periodic query three missed cycles make data stale (not 15 minutes)', () => {
    expect(usageStatus(live({ updatedAt: NOW - STALE_LIVE_MS + 1000 }), NOW)).toBe('fresh');
    expect(usageStatus(live({ updatedAt: NOW - STALE_LIVE_MS - 1000 }), NOW)).toBe('stale');
    expect(usageStatus(info({ updatedAt: NOW - 5 * 60_000 }), NOW)).toBe('fresh'); // no periodic query: the old 15 min rule
  });
  it('a failed query marks the kept data stale at once, keeps the values and shows the last good time and the reason', () => {
    const u = live({ updatedAt: NOW - 70_000, lastAttemptAt: NOW - 10_000, lastError: 'timeout' });
    expect(usageStatus(u, NOW)).toBe('stale');
    const p = panelModel(u, NOW);
    expect(p.rows[0].pct).toBe(23.5);
    expect(p.footer).toMatch(/^Данные устарели · последнее успешное обновление: \d\d:\d\d:\d\d \(1 мин назад\) · запрос Claude Code$/);
    expect(p.note).toContain('таймаут запроса');
    expect(ringModel(u, NOW).stale).toBe(true);
  });
  it('a newer success after a failure is fresh again', () => {
    expect(usageStatus(live({ updatedAt: NOW - 1000, lastAttemptAt: NOW - 1000, lastError: null }), NOW)).toBe('fresh');
  });
  it('no data: invalid answer, unsupported, unavailable plan, first request pending, other failure', () => {
    const none = { updatedAt: null, fiveHour: null, sevenDay: null };
    expect(usageStatus(live({ ...none, lastError: 'invalid' }), NOW)).toBe('invalid');
    expect(panelModel(live({ ...none, lastError: 'invalid' }), NOW).message).toMatch(/не распознан/);
    expect(panelModel(live({ ...none, lastError: 'unsupported' }), NOW).message).toMatch(/не поддерживает/);
    expect(panelModel(live({ ...none, lastError: 'unavailable' }), NOW).message).toMatch(/недоступны для этого входа/);
    expect(panelModel(live({ ...none, lastError: null, lastAttemptAt: null }), NOW).message).toMatch(/Запрашиваю/);
    expect(panelModel(live({ ...none, lastError: 'timeout' }), NOW).message).toMatch(/таймаут запроса.*Нажмите на кружок/);
    expect(ringModel(live({ ...none, lastError: 'invalid' }), NOW)).toMatchObject({ pct: null, level: 'none' });
  });
  it('error texts', () => {
    expect(errorText(null)).toBe('');
    expect(errorText('spawn')).toMatch(/запустить/);
    expect(errorText('weird')).toBe('ошибка запроса');
  });
});

describe('manual refresh', () => {
  const base: any = { plan: 'pro', updatedAt: Date.now() - 120_000, fiveHour: { usedPct: 23, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, sevenDay: null, statusLine: 'ours', source: 'statusline', liveActive: false };
  it('says it is updating while a manual query runs, and nothing about retrying every minute', () => {
    const m = panelModel({ ...base, refreshing: true }, Date.now());
    expect(m.note).toMatch(/Обновляю|Updating|更新/);
    expect(panelModel({ ...base, lastError: 'timeout', lastAttemptAt: Date.now() }, Date.now()).note).not.toMatch(/минуту|minute/);
  });
  it('the ring keeps the numbers in its title (the ring itself shows no number)', () => {
    const r = ringModel(base, Date.now());
    expect(r.title).toContain('23%');
    expect(r.level).toBe('ok');
  });
});
