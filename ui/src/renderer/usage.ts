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
  timeout: L('таймаут запроса', 'request timed out', '请求超时'), spawn: L('не удалось запустить claude', 'could not start claude', '无法启动 claude'),
  unsupported: L('метод не поддерживается этой версией Claude Code', 'not supported by this Claude Code version', '此 Claude Code 版本不支持'),
  unavailable: L('лимиты недоступны для этого входа', 'limits are not available for this login', '此登录方式无法获取额度'),
  invalid: L('ответ не распознан', 'response not understood', '无法理解响应'), error: L('ошибка запроса', 'request failed', '请求失败'),
});
export const errorText = (code: string | null | undefined): string => (code ? errorTexts()[code] ?? L('ошибка запроса', 'request failed', '请求失败') : '');

const PLAN_NAMES: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
export function planLabel(plan: string | null | undefined): string {
  if (!plan) return L('План неизвестен', 'Plan unknown', '套餐未知');
  return PLAN_NAMES[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

export const fmtPct = (p: number): string => (p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`);

export function fmtAge(updatedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 60) return L('только что', 'just now', '刚刚');
  const m = Math.floor(s / 60);
  if (m < 60) return L(`${m} мин назад`, `${m} min ago`, `${m} 分钟前`);
  const h = Math.floor(m / 60);
  return h < 24 ? L(`${h} ч назад`, `${h} h ago`, `${h} 小时前`) : L(`${Math.floor(h / 24)} д назад`, `${Math.floor(h / 24)} d ago`, `${Math.floor(h / 24)} 天前`);
}

/** "2 ч 15 мин", "45 мин", "1 д 3 ч" until a reset (rounded up to a whole minute). */
export function fmtIn(resetsAt: number, now: number): string {
  const ms = resetsAt * 1000 - now;
  if (ms <= 0) return L('сейчас', 'now', '现在');
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return L(`${mins} мин`, `${mins} min`, `${mins} 分钟`);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h >= 48) { const d = Math.floor(h / 24); const hh = h % 24; return hh ? L(`${d} д ${hh} ч`, `${d} d ${hh} h`, `${d} 天 ${hh} 小时`) : L(`${d} д`, `${d} d`, `${d} 天`); }
  return m ? L(`${h} ч ${m} мин`, `${h} h ${m} min`, `${h} 小时 ${m} 分钟`) : L(`${h} ч`, `${h} h`, `${h} 小时`);
}

const locale = () => (({ en: 'en-GB', ru: 'ru-RU', zh: 'zh-CN' } as const)[getLang()]);
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const weekday = (t: number) => new Date(t * 1000).toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '');

const clockSec = (ms: number) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtReset5h = (resetsAt: number, now: number): string => L(`Сброс через ${fmtIn(resetsAt, now)} (${clock(resetsAt)})`, `Resets in ${fmtIn(resetsAt, now)} (${clock(resetsAt)})`, `${fmtIn(resetsAt, now)}后重置（${clock(resetsAt)}）`);
export const fmtResetWeek = (resetsAt: number): string => L(`Сброс в ${weekday(resetsAt)}, ${clock(resetsAt)}`, `Resets ${weekday(resetsAt)}, ${clock(resetsAt)}`, `${weekday(resetsAt)} ${clock(resetsAt)} 重置`);

export interface RowModel { label: string; sub: string; pct: number | null; value: string }
export interface PanelModel { header: string; status: UsageStatus; rows: RowModel[]; message: string; footer: string; note: string }

const unavailableText = (u: UsageInfo | null): string => {
  if (!u) return L('Нет связи с мостом питомца: лимиты недоступны.', 'No connection to the pet bridge: limits are unavailable.', '与宠物桥接无连接：无法获取额度。');
  const why = errorText(u.lastError);
  if (u.lastError === 'invalid') return L('Ответ сервера лимитов не распознан, данных нет. Нажмите на кружок, чтобы повторить.', 'The limits response was not understood, no data. Click the ring to retry.', '无法理解额度响应，暂无数据。点击圆环重试。');
  if (u.lastError === 'unavailable') return L('Лимиты плана недоступны для этого входа (нужна подписка Pro/Max через вход claude.ai).', 'Plan limits are not available for this login (needs a Pro/Max subscription signed in via claude.ai).', '此登录方式无法获取套餐额度（需要通过 claude.ai 登录的 Pro/Max 订阅）。');
  if (u.lastError === 'unsupported') return L('Эта версия Claude Code не поддерживает запрос лимитов.', 'This Claude Code version does not support the limits query.', '此 Claude Code 版本不支持额度查询。');
  if (u.lastError) return L(`Не удалось получить лимиты (${why}). Нажмите на кружок, чтобы повторить.`, `Could not get the limits (${why}). Click the ring to retry.`, `无法获取额度（${why}）。点击圆环重试。`);
  if (u.refreshing || u.liveActive) return L('Запрашиваю данные о лимитах…', 'Requesting limit data…', '正在请求额度数据…');
  if (u.statusLine === 'none') return L('Данных пока нет. Нажмите на кружок, чтобы запросить их, или подключите статус-строку (Настройки → Подключения): тогда кружок будет обновляться сам.', 'No data yet. Click the ring to request it, or connect the status line (Settings → Connections) so the ring updates by itself.', '暂无数据。点击圆环请求，或连接状态栏（设置 → 连接），圆环就会自动更新。');
  return L('Данных пока нет. Они приходят после первого ответа Claude в любой сессии (только для подписок Pro/Max).', 'No data yet. It arrives after Claude’s first answer in any session (Pro/Max subscriptions only).', '暂无数据。在任意会话中 Claude 首次回答后会获得（仅限 Pro/Max 订阅）。');
};

export function panelModel(u: UsageInfo | null, now: number): PanelModel {
  const status = usageStatus(u, now);
  const header = `${L('Лимиты использования плана', 'Plan usage limits', '套餐用量额度')} · ${planLabel(u?.plan)}`;
  if (status === 'unavailable' || status === 'invalid') return { header, status, rows: [], message: unavailableText(u), footer: '', note: '' };
  const f = windowView(u!.fiveHour, now), w = windowView(u!.sevenDay, now);
  const row = (label: string, v: WindowView, sub: (r: number) => string, missing: string): RowModel =>
    v.kind === 'ok' ? { label, sub: sub(v.resetsAt), pct: Math.min(100, Math.max(0, v.pct)), value: L(`${fmtPct(v.pct)} использовано`, `${fmtPct(v.pct)} used`, `已用 ${fmtPct(v.pct)}`) }
      : { label, sub: v.kind === 'expired' ? L('Период сброшен, новых данных ещё нет', 'Period reset, no new data yet', '周期已重置，暂无新数据') : missing, pct: null, value: '—' };
  const rows = [
    row(L('5-часовой лимит', '5-hour limit', '5 小时额度'), f, (r) => fmtReset5h(r, now), L('Нет данных', 'No data', '无数据')),
    row(L('Недельный лимит · все модели', 'Weekly limit · all models', '每周额度 · 所有模型'), w, (r) => fmtResetWeek(r), L('Нет данных', 'No data', '无数据')),
  ];
  const at = u!.updatedAt as number;
  const src = u!.source === 'live' ? L('запрос Claude Code', 'Claude Code query', 'Claude Code 查询') : u!.source === 'statusline' ? L('строка состояния', 'status line', '状态栏') : '';
  const footer = `${status === 'stale' ? L('Данные устарели · последнее', 'Data is stale · last', '数据已过期 · 上次') : L('Последнее', 'Last', '上次')} ${L('успешное обновление', 'successful update', '成功更新')}: ${clockSec(at)} (${fmtAge(at, now)})${src ? ' · ' + src : ''}`;
  const note = u!.refreshing ? L('Обновляю данные…', 'Updating…', '正在更新…') : u!.lastError ? L(`Последний запрос не удался: ${errorText(u!.lastError)}. Показаны сохранённые данные.`, `The last request failed: ${errorText(u!.lastError)}. Showing saved data.`, `上次请求失败：${errorText(u!.lastError)}。显示已保存的数据。`) : '';
  return { header, status, rows, message: '', footer, note };
}

export interface RingModel { text: string; pct: number | null; level: 'none' | 'ok' | 'warn' | 'high' | 'full'; stale: boolean; title: string }

/** The ring shows the 5-hour window (the weekly one when 5 h has nothing current); both are in the tooltip. */
export function ringModel(u: UsageInfo | null, now: number): RingModel {
  const status = usageStatus(u, now);
  const none: RingModel = { text: '—', pct: null, level: 'none', stale: false, title: L('Лимиты плана: данных нет', 'Plan limits: no data', '套餐额度：无数据') };
  if (status === 'unavailable' || status === 'invalid') return { ...none, title: status === 'invalid' ? L('Лимиты плана: ответ не распознан', 'Plan limits: response not understood', '套餐额度：无法理解响应') : none.title };
  const f = windowView(u!.fiveHour, now), w = windowView(u!.sevenDay, now);
  const main = f.kind === 'ok' ? f : w.kind === 'ok' ? w : null;
  if (!main) return { ...none, title: L('Лимиты плана: данные устарели (период сброшен)', 'Plan limits: data is stale (period reset)', '套餐额度：数据已过期（周期已重置）'), stale: true };
  const parts = [f.kind === 'ok' && `${L('5 ч', '5 h', '5 小时')}: ${fmtPct(f.pct)}`, w.kind === 'ok' && `${L('неделя', 'week', '本周')}: ${fmtPct(w.pct)}`].filter(Boolean).join(' · ');
  const stale = status === 'stale';
  return {
    text: String(Math.min(100, Math.round(main.pct))), pct: Math.min(100, main.pct), stale,
    // 'full' = the limit is used up (rounds to 100): the ring closes and breathes instead of sitting at 99
    level: Math.round(main.pct) >= 100 ? 'full' : main.pct >= 90 ? 'high' : main.pct >= 75 ? 'warn' : 'ok',
    title: `${L('Лимиты плана', 'Plan limits', '套餐额度')} — ${parts}${stale ? L(' (данные устарели)', ' (data is stale)', ' （数据已过期）') : ''}`,
  };
}
