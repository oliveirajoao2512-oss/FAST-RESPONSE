let TZ = 'America/Sao_Paulo';
export function setTimezone(tz: string) {
  TZ = tz;
}
export const tz = () => TZ;

const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...o });

export function fmtDateTime(d?: string | Date | null) {
  if (!d) return '—';
  return dtf({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
}
export function fmtDate(d?: string | Date | null) {
  if (!d) return '—';
  return dtf({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));
}
export function fmtShort(d?: string | Date | null) {
  if (!d) return '—';
  return dtf({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
}

/** Local calendar day key (YYYY-MM-DD) in the factory timezone. */
export function dayKey(d: string | Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
}

export function duration(ms: number) {
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
  return `${Math.floor(h / 24)} dias`;
}

export function age(from: string | Date) {
  return duration(Date.now() - new Date(from).getTime());
}

/** Human description of a deadline relative to now. */
export function dueText(due: string | Date | null) {
  if (!due) return 'sem prazo';
  const diff = new Date(due).getTime() - Date.now();
  const today = dayKey(new Date()) === dayKey(due);
  const tomorrow = dayKey(new Date(Date.now() + 86400000)) === dayKey(due);
  const time = dtf({ hour: '2-digit', minute: '2-digit' }).format(new Date(due));
  if (diff < 0) return `atrasada há ${duration(-diff)}`;
  if (today) return `vence hoje ${time}`;
  if (tomorrow) return `vence amanhã ${time}`;
  return `vence ${fmtShort(due)}`;
}

/** Value for <input type="datetime-local"> in the factory timezone. */
export function toLocalInput(d: Date | string) {
  const p = Object.fromEntries(
    dtf({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(d)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Interprets a datetime-local value as factory local time and returns ISO (UTC). */
export function fromLocalInput(v: string): string {
  const guess = new Date(v + ':00Z');
  // offset of the factory timezone at that instant
  const asLocal = new Date(toLocalInput(guess) + ':00Z');
  const offset = asLocal.getTime() - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

export const num = (n: number | null | undefined, digits = 1) =>
  n == null ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: digits });

export function hours(h: number | null | undefined) {
  if (h == null) return '—';
  if (h < 48) return `${num(h)} h`;
  return `${num(h / 24)} dias`;
}
