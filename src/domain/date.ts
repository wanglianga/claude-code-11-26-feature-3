import type { ISODate } from './types';

/** 纯日期工具：统一按 UTC 午夜处理，避免时区漂移，引擎内禁止使用 Date.now() */

export function parseISO(d: ISODate): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function toISO(date: Date): ISODate {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(d: ISODate, days: number): ISODate {
  const dt = parseISO(d);
  dt.setUTCDate(dt.getUTCDate() + days);
  return toISO(dt);
}

/** b - a 的天数差（b 在 a 之后为正） */
export function diffDays(a: ISODate, b: ISODate): number {
  const ms = parseISO(b).getTime() - parseISO(a).getTime();
  return Math.round(ms / 86_400_000);
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

/** 生成 [start, start + days - 1] 的日期序列 */
export function dateRange(start: ISODate, days: number): ISODate[] {
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}

export function isBeforeOrEqual(a: ISODate, b: ISODate): boolean {
  return a <= b;
}

export function formatZh(d: ISODate): string {
  const [y, m, day] = d.split('-');
  return `${y}-${m}-${day}`;
}
