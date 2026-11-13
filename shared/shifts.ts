import { DateTime } from 'luxon';

/** A work shift, given by its name and the local time (HH:mm) it starts. Each shift runs until the next one starts. */
export interface Shift {
  name: string;
  start: string;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Name of the shift in which a moment falls, by the factory clock. The last shift of the day runs past midnight. */
export function shiftOf(at: Date | string, shifts: Shift[], zone: string): string | null {
  if (!shifts.length) return null;
  const x = DateTime.fromJSDate(new Date(at)).setZone(zone);
  const now = x.hour * 60 + x.minute;
  const sorted = [...shifts].sort((a, b) => minutes(a.start) - minutes(b.start));
  let cur = sorted[sorted.length - 1];
  for (const s of sorted) if (minutes(s.start) <= now) cur = s;
  return cur.name;
}

/** Shifts in the order of the day, with the time each one ends (the start of the next). */
export function shiftRanges(shifts: Shift[]): { name: string; start: string; end: string }[] {
  const sorted = [...shifts].sort((a, b) => minutes(a.start) - minutes(b.start));
  return sorted.map((s, i) => ({ name: s.name, start: s.start, end: sorted[(i + 1) % sorted.length].start }));
}

/** Error message for an invalid shift list, or null. */
export function shiftsProblem(shifts: Shift[]): string | null {
  if (!Array.isArray(shifts) || shifts.length < 1 || shifts.length > 6) return 'Cadastre de 1 a 6 turnos.';
  if (shifts.some((s) => !s || typeof s !== 'object' || typeof s.name !== 'string' || typeof s.start !== 'string')) return 'Turno inválido.';
  if (shifts.some((s) => !s.name?.trim())) return 'Todo turno precisa de um nome.';
  if (shifts.some((s) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start))) return 'Horário de início do turno inválido (use HH:MM).';
  if (new Set(shifts.map((s) => s.name.trim().toLowerCase())).size !== shifts.length) return 'Os turnos precisam de nomes diferentes.';
  if (new Set(shifts.map((s) => s.start)).size !== shifts.length) return 'Dois turnos não podem começar no mesmo horário.';
  return null;
}
