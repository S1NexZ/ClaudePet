import type { TurnSummary } from '../../../shared/src/types.js';
import { L } from '../../../shared/src/i18n.js';

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** 75 s -> "1 мин 15 с"; under a minute -> "42 с"; an hour or more -> "1 ч 5 мин" */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return L(`${s} с`, `${s}s`, `${s} 秒`);
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h) return L(`${h} ч ${m % 60} мин`, `${h}h ${m % 60}m`, `${h} 小时 ${m % 60} 分`);
  return s % 60 ? L(`${m} мин ${s % 60} с`, `${m}m ${s % 60}s`, `${m} 分 ${s % 60} 秒`) : L(`${m} мин`, `${m}m`, `${m} 分`);
}

/** 3400 -> "3,4 тыс."; under a thousand as is */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  const k = (n / 1000).toFixed(n < 10_000 ? 1 : 0);
  return L(`${k.replace('.', ',')} тыс.`, `${k}k`, `${k}k`);
}

const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};

/** The card's head line: files, lines, time, tokens */
export function summaryHead(s: TurnSummary): string {
  const add = s.files.reduce((a, f) => a + f.added, 0), del = s.files.reduce((a, f) => a + f.removed, 0);
  const n = s.files.length;
  const files = L(`${n} ${plural(n, 'файл', 'файла', 'файлов')}`, `${n} file${n === 1 ? '' : 's'}`, `${n} 个文件`);
  const parts = [files, `+${add} −${del}`, duration(s.ms)];
  if (s.tokens) parts.push(L(`${tokens(s.tokens)} токенов`, `${tokens(s.tokens)} tokens`, `${tokens(s.tokens)} 令牌`));
  return parts.join(' · ');
}

/** Rows for the files (at most `max`; the rest is counted in the last row) */
export function summaryRows(s: TurnSummary, max = 5): { name: string; path: string; stat: string }[] {
  const rows = s.files.slice(0, max).map((f) => ({ name: base(f.path), path: f.path, stat: `+${f.added} −${f.removed}` }));
  const more = s.files.length - rows.length;
  if (more > 0) rows.push({ name: L(`и ещё ${more}`, `and ${more} more`, `还有 ${more} 个`), path: s.files.slice(max).map((f) => f.path).join('\n'), stat: '' });
  return rows;
}
