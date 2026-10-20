import { DateTime } from 'luxon';
import type { AppConfig } from './config.js';

type DeadlineConfig = Pick<AppConfig, 'timezone' | 'deadline'>;

function isNonWorkingDay(day: DateTime, cfg: DeadlineConfig): boolean {
  if (!cfg.deadline.skipWeekends) return false;
  return day.weekday >= 6 || cfg.deadline.holidays.includes(day.toISODate()!);
}

/**
 * Default due date: an issue opened on local day D is due on day D + N
 * (N = cfg.deadline.days, default 1) at cfg.deadline.time, in the factory timezone.
 * Example: opened Tuesday 15:00 → due Wednesday 23:59:59.999.
 */
export function computeDefaultDue(openedAt: Date, cfg: DeadlineConfig): Date {
  const local = DateTime.fromJSDate(openedAt, { zone: cfg.timezone });
  let day = local.startOf('day');
  let remaining = Math.max(0, Math.floor(cfg.deadline.days));
  while (remaining > 0) {
    day = day.plus({ days: 1 });
    if (!isNonWorkingDay(day, cfg)) remaining--;
  }
  while (isNonWorkingDay(day, cfg)) day = day.plus({ days: 1 });
  const [h, m] = parseTime(cfg.deadline.time);
  return day.set({ hour: h, minute: m, second: 59, millisecond: 999 }).toJSDate();
}

/** Critical safety issues: immediate treatment, due N hours after opening. */
export function computeCriticalSafetyDue(openedAt: Date, cfg: DeadlineConfig): Date {
  return new Date(openedAt.getTime() + cfg.deadline.criticalSafetyHours * 3600_000);
}

export function computeDue(openedAt: Date, isCriticalSafety: boolean, cfg: DeadlineConfig): Date {
  return isCriticalSafety ? computeCriticalSafetyDue(openedAt, cfg) : computeDefaultDue(openedAt, cfg);
}

export function isOverdue(dueAt: Date | string | null, now: Date = new Date()): boolean {
  if (!dueAt) return false;
  return new Date(dueAt).getTime() < now.getTime();
}

export function isDueToday(dueAt: Date | string | null, timezone: string, now: Date = new Date()): boolean {
  if (!dueAt) return false;
  const d = DateTime.fromJSDate(new Date(dueAt), { zone: timezone });
  const n = DateTime.fromJSDate(now, { zone: timezone });
  return d.hasSame(n, 'day');
}

/** Start/end of the current local day as UTC instants. */
export function localDayBounds(timezone: string, now: Date = new Date()): { start: Date; end: Date } {
  const n = DateTime.fromJSDate(now, { zone: timezone });
  return { start: n.startOf('day').toJSDate(), end: n.endOf('day').toJSDate() };
}

/** Local month bounds for 'YYYY-MM'. */
export function monthBounds(month: string, timezone: string): { start: Date; end: Date } {
  const start = DateTime.fromFormat(month, 'yyyy-MM', { zone: timezone }).startOf('month');
  if (!start.isValid) throw new Error('Mês inválido');
  return { start: start.toJSDate(), end: start.plus({ months: 1 }).toJSDate() };
}

export function currentMonth(timezone: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now, { zone: timezone }).toFormat('yyyy-MM');
}

function parseTime(t: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return [23, 59];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}
