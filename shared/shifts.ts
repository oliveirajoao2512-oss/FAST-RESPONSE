import { DateTime } from 'luxon';

/**
 * A work shift: its name, the local time (HH:mm) it starts and, optionally, its calendar.
 * - `days`: weekdays it starts on with the regular hours (1 = segunda … 7 = domingo). Missing = every day.
 * - `saturday`: a different window on Saturday (e.g. 06:00–11:00), used when Saturday is not in `days`.
 * On a regular day each shift runs until the next one starts; the last one runs past midnight.
 */
export interface Shift {
  name: string;
  start: string;
  days?: number[];
  saturday?: { start: string; end: string } | null;
}

/** Name used for anything that happens when no shift is working (e.g. Sunday). */
export const OFF_SHIFT = 'Fora do turno';
export const WEEKDAY_NAMES = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const works = (s: Shift, weekday: number) => !s.days || s.days.includes(weekday);

/** Shifts in the order of the day, with the time each one ends on a regular day (the start of the next). */
export function shiftRanges(shifts: Shift[]): { name: string; start: string; end: string; days?: number[]; saturday?: { start: string; end: string } | null }[] {
  const sorted = [...shifts].sort((a, b) => minutes(a.start) - minutes(b.start));
  return sorted.map((s, i) => ({ name: s.name, start: s.start, end: sorted[(i + 1) % sorted.length].start, days: s.days, saturday: s.saturday ?? null }));
}

/** Name of the shift in which a moment falls, by the factory clock, or OFF_SHIFT when no shift is working. */
export function shiftOf(at: Date | string, shifts: Shift[], zone: string): string | null {
  if (!shifts.length) return null;
  const x = DateTime.fromJSDate(new Date(at)).setZone(zone);
  const now = x.hour * 60 + x.minute;
  const wd = x.weekday;
  const prev = wd === 1 ? 7 : wd - 1;
  if (wd === 6) for (const s of shifts) if (s.saturday && now >= minutes(s.saturday.start) && now < minutes(s.saturday.end)) return s.name;
  for (const r of shiftRanges(shifts)) {
    const st = minutes(r.start);
    const en = minutes(r.end);
    if (shifts.length === 1) { if (works(r, now >= st ? wd : prev)) return r.name; continue; }
    if (st < en) { if (now >= st && now < en && works(r, wd)) return r.name; }
    else if ((now >= st && works(r, wd)) || (now < en && works(r, prev))) return r.name;
  }
  return OFF_SHIFT;
}

/** Short description of when a shift works, e.g. "seg a sex 06:00–14:00 · sáb 06:00–11:00". */
export function shiftSchedule(r: { start: string; end: string; days?: number[]; saturday?: { start: string; end: string } | null }): string {
  const d = r.days;
  const days = !d || d.length === 7 ? 'todos os dias' : d.join(',') === '1,2,3,4,5' ? 'seg a sex' : d.join(',') === '1,2,3,4,5,6' ? 'seg a sáb' : d.map((n) => WEEKDAY_NAMES[n - 1].slice(0, 3)).join(', ');
  return `${days} ${r.start}–${r.end}${r.saturday ? ` · sáb ${r.saturday.start}–${r.saturday.end}` : ''}`;
}

/** Error message for an invalid shift list, or null. */
export function shiftsProblem(shifts: Shift[]): string | null {
  const hhmm = (v: unknown) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  if (!Array.isArray(shifts) || shifts.length < 1 || shifts.length > 6) return 'Cadastre de 1 a 6 turnos.';
  if (shifts.some((s) => !s || typeof s !== 'object' || typeof s.name !== 'string' || typeof s.start !== 'string')) return 'Turno inválido.';
  if (shifts.some((s) => !s.name?.trim())) return 'Todo turno precisa de um nome.';
  if (shifts.some((s) => !hhmm(s.start))) return 'Horário de início do turno inválido (use HH:MM).';
  if (new Set(shifts.map((s) => s.name.trim().toLowerCase())).size !== shifts.length) return 'Os turnos precisam de nomes diferentes.';
  if (new Set(shifts.map((s) => s.start)).size !== shifts.length) return 'Dois turnos não podem começar no mesmo horário.';
  for (const s of shifts) {
    if (s.days != null && (!Array.isArray(s.days) || !s.days.length || s.days.some((n) => !Number.isInteger(n) || n < 1 || n > 7))) return `Escolha pelo menos um dia de trabalho do ${s.name}.`;
    if (s.saturday != null) {
      if (!hhmm(s.saturday.start) || !hhmm(s.saturday.end) || minutes(s.saturday.start) >= minutes(s.saturday.end)) return `Horário de sábado do ${s.name} inválido: o fim precisa ser depois do início, no mesmo dia.`;
      if (s.days?.includes(6)) return `O ${s.name} já trabalha no sábado com o horário normal: tire o sábado dos dias ou o horário especial.`;
    }
  }
  const sat = shifts.filter((s) => s.saturday).map((s) => s.saturday!).sort((a, b) => minutes(a.start) - minutes(b.start));
  for (let i = 1; i < sat.length; i++) if (minutes(sat[i].start) < minutes(sat[i - 1].end)) return 'Os horários de sábado de dois turnos se sobrepõem.';
  return null;
}

/** Keeps only the known fields of each shift (what the settings screen saves). */
export const cleanShifts = (shifts: Shift[]): Shift[] => shifts.map((s) => ({
  name: s.name.trim(), start: s.start,
  ...(s.days ? { days: [...new Set(s.days)].sort((a, b) => a - b) } : {}),
  ...(s.saturday ? { saturday: { start: s.saturday.start, end: s.saturday.end } } : {}),
}));
