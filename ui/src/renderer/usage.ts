import type { UsageInfo, UsageWindow } from '../../../shared/src/types.js';
import { L, getLang } from '../../../shared/src/i18n.js';

/** Without the periodic query: older than this, the numbers may no longer match reality (a limit moves only when some session answers). */
export const STALE_MS = 15 * 60_000;
/** With the periodic query (one request a minute): three missed cycles and the data is stale. */
export const STALE_LIVE_MS = 190_000;
const staleLimit = (u: UsageInfo) => (u.liveActive ? STALE_LIVE_MS : STALE_MS);

export type WindowView = { kind: 'ok'; pct: number; resetsAt: number } | { kind: 'expired' } | { kind: 'none' };
export type UsageStatus = 'unavailable' | 'invalid' | 'stale' | 'fresh';

/** A window whose reset time has passed no longer describes the current period: never shown as a percentage. */
export function windowView(w: UsageWindow | null | undefined, now: number): WindowView {
  if (!w) return { kind: 'none' };
  return w.resetsAt * 1000 <= now ? { kind: 'expired' } : { kind: 'ok', pct: w.usedPct, resetsAt: w.resetsAt };
}

const hasData = (u: UsageInfo): boolean => u.updatedAt != null && !!(u.fiveHour || u.sevenDay);

/**
 * fresh: recent data and the last query (if any) succeeded.
 * stale: data exists but the last query failed, or it is older than the limit: shown, marked, with its own time.
 * invalid: no usable data and the last answer could not be understood. unavailable: no data (any other reason).
 */
export function usageStatus(u: UsageInfo | null, now: number): UsageStatus {
  if (!u) return 'unavailable';
  if (!hasData(u)) return u.lastError === 'invalid' ? 'invalid' : 'unavailable';
  if (u.lastError && u.lastAttemptAt != null && u.lastAttemptAt >= (u.updatedAt as number)) return 'stale';
  return now - (u.updatedAt as number) > staleLimit(u) ? 'stale' : 'fresh';
}

const errorTexts = (): Record<string, string> => ({
  timeout: L('таймаут запроса', 'request timed out'), spawn: L('не удалось запустить claude', 'could not start claude'),
  unsupported: L('метод не поддерживается этой версией Claude Code', 'not supported by this Claude Code version'),
  unavailable: L('лимиты недоступны для этого входа', 'limits are not available for this login'),
  invalid: L('ответ не распознан', 'response not understood'), error: L('ошибка запроса', 'request failed'),
});
export const errorText = (code: string | null | undefined): string => (code ? errorTexts()[code] ?? L('ошибка запроса', 'request failed') : '');

const PLAN_NAMES: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
export function planLabel(plan: string | null | undefined): string {
  if (!plan) return L('План неизвестен', 'Plan unknown');
  return PLAN_NAMES[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

export const fmtPct = (p: number): string => (p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`);

export function fmtAge(updatedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 60) return L('только что', 'just now');
  const m = Math.floor(s / 60);
  if (m < 60) return L(`${m} мин назад`, `${m} min ago`);
  const h = Math.floor(m / 60);
  return h < 24 ? L(`${h} ч назад`, `${h} h ago`) : L(`${Math.floor(h / 24)} д назад`, `${Math.floor(h / 24)} d ago`);
}

/** "2 ч 15 мин", "45 мин", "1 д 3 ч" until a reset (rounded up to a whole minute). */
export function fmtIn(resetsAt: number, now: number): string {
  const ms = resetsAt * 1000 - now;
  if (ms <= 0) return L('сейчас', 'now');
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return L(`${mins} мин`, `${mins} min`);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h >= 48) { const d = Math.floor(h / 24); const hh = h % 24; return hh ? L(`${d} д ${hh} ч`, `${d} d ${hh} h`) : L(`${d} д`, `${d} d`); }
  return m ? L(`${h} ч ${m} мин`, `${h} h ${m} min`) : L(`${h} ч`, `${h} h`);
}

const locale = () => (getLang() === 'en' ? 'en-GB' : 'ru-RU');
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const weekday = (t: number) => new Date(t * 1000).toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '');

const clockSec = (ms: number) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtReset5h = (resetsAt: number, now: number): string => L(`Сброс через ${fmtIn(resetsAt, now)} (${clock(resetsAt)})`, `Resets in ${fmtIn(resetsAt, now)} (${clock(resetsAt)})`);
export const fmtResetWeek = (resetsAt: number): string => L(`Сброс в ${weekday(resetsAt)}, ${clock(resetsAt)}`, `Resets ${weekday(resetsAt)}, ${clock(resetsAt)}`);

export interface RowModel { label: string; sub: string; pct: number | null; value: string }
export interface PanelModel { header: string; status: UsageStatus; rows: RowModel[]; message: string; footer: string; note: string }

const unavailableText = (u: UsageInfo | null): string => {
  if (!u) return L('Нет связи с мостом питомца: лимиты недоступны.', 'No connection to the pet bridge: limits are unavailable.');
  const why = errorText(u.lastError);
  if (u.lastError === 'invalid') return L('Ответ сервера лимитов не распознан, данных нет. Повторю через минуту.', 'The limits response was not understood, no data. Retrying in a minute.');
  if (u.lastError === 'unavailable') return L('Лимиты плана недоступны для этого входа (нужна подписка Pro/Max через вход claude.ai).', 'Plan limits are not available for this login (needs a Pro/Max subscription signed in via claude.ai).');
  if (u.lastError === 'unsupported') return L('Эта версия Claude Code не поддерживает запрос лимитов.', 'This Claude Code version does not support the limits query.');
  if (u.liveActive && u.lastError) return L(`Не удалось получить лимиты (${why}). Повторю через минуту.`, `Could not get the limits (${why}). Retrying in a minute.`);
  if (u.liveActive) return L('Запрашиваю данные о лимитах…', 'Requesting limit data…');
  if (u.statusLine === 'other') return L('В Claude Code уже настроена другая строка состояния: питомец её не заменяет, лимиты недоступны.', 'Claude Code already has another status line: the pet does not replace it, so limits are unavailable.');
  if (u.statusLine === 'none') return L('Лимиты недоступны: строка состояния Claude Code не подключена к питомцу.', 'Limits unavailable: the Claude Code status line is not connected to the pet.');
  return L('Данных пока нет. Они приходят после первого ответа Claude в любой сессии (только для подписок Pro/Max).', 'No data yet. It arrives after Claude’s first answer in any session (Pro/Max subscriptions only).');
};

export function panelModel(u: UsageInfo | null, now: number): PanelModel {
  const status = usageStatus(u, now);
  const header = `${L('Лимиты использования плана', 'Plan usage limits')} · ${planLabel(u?.plan)}`;
  if (status === 'unavailable' || status === 'invalid') return { header, status, rows: [], message: unavailableText(u), footer: '', note: '' };
  const f = windowView(u!.fiveHour, now), w = windowView(u!.sevenDay, now);
  const row = (label: string, v: WindowView, sub: (r: number) => string, missing: string): RowModel =>
    v.kind === 'ok' ? { label, sub: sub(v.resetsAt), pct: Math.min(100, Math.max(0, v.pct)), value: L(`${fmtPct(v.pct)} использовано`, `${fmtPct(v.pct)} used`) }
      : { label, sub: v.kind === 'expired' ? L('Период сброшен, новых данных ещё нет', 'Period reset, no new data yet') : missing, pct: null, value: '—' };
  const rows = [
    row(L('5-часовой лимит', '5-hour limit'), f, (r) => fmtReset5h(r, now), L('Нет данных', 'No data')),
    row(L('Недельный лимит · все модели', 'Weekly limit · all models'), w, (r) => fmtResetWeek(r), L('Нет данных', 'No data')),
  ];
  const at = u!.updatedAt as number;
  const src = u!.source === 'live' ? L('запрос Claude Code', 'Claude Code query') : u!.source === 'statusline' ? L('строка состояния', 'status line') : '';
  const footer = `${status === 'stale' ? L('Данные устарели · последнее', 'Data is stale · last') : L('Последнее', 'Last')} ${L('успешное обновление', 'successful update')}: ${clockSec(at)} (${fmtAge(at, now)})${src ? ' · ' + src : ''}`;
  const note = u!.lastError ? L(`Последний запрос не удался: ${errorText(u!.lastError)}. Показаны сохранённые данные.`, `The last request failed: ${errorText(u!.lastError)}. Showing saved data.`) : '';
  return { header, status, rows, message: '', footer, note };
}

export interface RingModel { text: string; pct: number | null; level: 'none' | 'ok' | 'warn' | 'high' | 'full'; stale: boolean; title: string }

/** The ring shows the 5-hour window (the one that blocks work first); the weekly one when 5 h has nothing current. */
export function ringModel(u: UsageInfo | null, now: number): RingModel {
  const status = usageStatus(u, now);
  const none: RingModel = { text: '—', pct: null, level: 'none', stale: false, title: L('Лимиты плана: данных нет', 'Plan limits: no data') };
  if (status === 'unavailable' || status === 'invalid') return { ...none, title: status === 'invalid' ? L('Лимиты плана: ответ не распознан', 'Plan limits: response not understood') : none.title };
  const f = windowView(u!.fiveHour, now), w = windowView(u!.sevenDay, now);
  const main = f.kind === 'ok' ? f : w.kind === 'ok' ? w : null;
  if (!main) return { ...none, title: L('Лимиты плана: данные устарели (период сброшен)', 'Plan limits: data is stale (period reset)'), stale: true };
  const parts = [f.kind === 'ok' && `${L('5 ч', '5 h')}: ${fmtPct(f.pct)}`, w.kind === 'ok' && `${L('неделя', 'week')}: ${fmtPct(w.pct)}`].filter(Boolean).join(' · ');
  const stale = status === 'stale';
  return {
    text: String(Math.min(100, Math.round(main.pct))), pct: Math.min(100, main.pct), stale,
    // 'full' = the limit is used up (rounds to 100): the ring closes and breathes instead of sitting at 99
    level: Math.round(main.pct) >= 100 ? 'full' : main.pct >= 90 ? 'high' : main.pct >= 75 ? 'warn' : 'ok',
    title: `${L('Лимиты плана', 'Plan limits')} — ${parts}${stale ? L(' (данные устарели)', ' (data is stale)') : ''}`,
  };
}
