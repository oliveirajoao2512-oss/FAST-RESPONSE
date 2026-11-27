/**
 * Conferência de produção (stage 1, João 27/11/2026): the leader reports how many pieces a machine made in a period;
 * the system compares it with what the standard cycle allows and checks whether the stops already registered
 * (OS/OA with the machine stopped, setups) explain the difference. Pure functions, shared by server and web.
 */

/** Below this many minutes a difference is treated as noise (rounding, a few slow cycles). */
export const PRODUCTION_TOLERANCE_MIN = 5;
/** A single report covers at most this many hours. */
export const PRODUCTION_MAX_HOURS = 12;

/**
 * Preview: live only for the administrator (João, 27/11/2026) until he releases it. Turning it off gives the rules
 * below to the leadership of Produção and the plant manager.
 */
export const productionAccess = { adminOnly: true };

/** who reports production and sees the conferência: leadership of Produção, plant manager and administrator */
export const canReportProduction = (a: { role: string }, areaSlug: string | null | undefined) =>
  a.role === 'admin' || (!productionAccess.adminOnly && (a.role === 'plant_manager' || ((a.role === 'lider' || a.role === 'gestor') && areaSlug === 'producao')));
/** who edits the standard cycles: administrator, plant manager and the gestor of Produção */
export const canEditStandards = (a: { role: string }, areaSlug: string | null | undefined) =>
  a.role === 'admin' || (!productionAccess.adminOnly && (a.role === 'plant_manager' || (a.role === 'gestor' && areaSlug === 'producao')));

export const machineKey = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');

export type StopSource = 'manutencao' | 'ajuste' | 'setup';
export const STOP_SOURCE_LABEL: Record<StopSource, string> = { manutencao: 'Manutenção', ajuste: 'Ajuste de processo', setup: 'Setup' };

export interface StopInput { source: StopSource; ref: string; label: string; start: number; end: number }
export interface StopInPeriod extends StopInput {
  /** minutes of this stop inside the period */
  minutes: number;
  /** of those, minutes already covered by an earlier stop (counted only once) */
  overlapMinutes: number;
}

export type CheckStatus = 'sem_padrao' | 'meta' | 'justificada' | 'divergencia';
export const CHECK_STATUS: Record<CheckStatus, { label: string; tone: 'gray' | 'green' | 'blue' | 'red' }> = {
  sem_padrao: { label: 'Sem ciclo padrão', tone: 'gray' },
  meta: { label: 'Meta atingida', tone: 'green' },
  justificada: { label: 'Diferença justificada', tone: 'blue' },
  divergencia: { label: 'Tempo não justificado', tone: 'red' },
};
export const UNJUSTIFIED_MESSAGE = 'PRODUÇÃO COM TEMPO NÃO JUSTIFICADO — NECESSÁRIA IDENTIFICAÇÃO DO MOTIVO.';

export interface CheckInput {
  start: number; end: number; quantity: number;
  cycleSeconds: number | null; cavities: number | null;
  stops: StopInput[];
  toleranceMin?: number;
}
export interface CheckResult {
  status: CheckStatus;
  periodMin: number;
  /** pieces per hour at the standard cycle */
  ratePerHour: number | null;
  expected: number | null;
  quantity: number;
  lossPieces: number | null;
  lossMin: number | null;
  /** registered stop time inside the period, overlaps counted once */
  stopMin: number;
  justifiedMin: number | null;
  unjustifiedMin: number | null;
  unjustifiedPieces: number | null;
  /** produced more than the standard allows: cycle, cavities or period may be wrong */
  aboveStandard: boolean;
  /** registered stops are longer than the loss: the machine produced while a stop was open */
  stopsExceedLoss: boolean;
  stops: StopInPeriod[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** stops clipped to the period, sorted by start; each one tells how much of it was already covered by earlier ones */
export function clipStops(stops: StopInput[], start: number, end: number): { stops: StopInPeriod[]; totalMin: number } {
  const inside = stops
    .map((s) => ({ ...s, a: Math.max(s.start, start), b: Math.min(s.end, end) }))
    .filter((s) => s.b > s.a)
    .sort((x, y) => x.a - y.a || y.b - x.b);
  let coveredTo = start;
  let total = 0;
  const out: StopInPeriod[] = inside.map((s) => {
    const fresh = Math.max(0, s.b - Math.max(s.a, coveredTo));
    total += fresh;
    coveredTo = Math.max(coveredTo, s.b);
    const minutes = (s.b - s.a) / 60000;
    return { source: s.source, ref: s.ref, label: s.label, start: s.start, end: s.end, minutes: round1(minutes), overlapMinutes: round1(minutes - fresh / 60000) };
  });
  return { stops: out, totalMin: total / 60000 };
}

export function checkProduction(i: CheckInput): CheckResult {
  const tol = i.toleranceMin ?? PRODUCTION_TOLERANCE_MIN;
  const periodMin = Math.max(0, (i.end - i.start) / 60000);
  const { stops, totalMin } = clipStops(i.stops, i.start, i.end);
  const stopMin = round1(totalMin);
  const base = { periodMin: round1(periodMin), quantity: i.quantity, stopMin, stops };
  if (!i.cycleSeconds || i.cycleSeconds <= 0) {
    return {
      ...base, status: 'sem_padrao', ratePerHour: null, expected: null, lossPieces: null, lossMin: null,
      justifiedMin: null, unjustifiedMin: null, unjustifiedPieces: null, aboveStandard: false, stopsExceedLoss: false,
    };
  }
  const perMin = (60 / i.cycleSeconds) * (i.cavities || 1);
  const expectedExact = periodMin * perMin;
  const lossPieces = Math.max(0, expectedExact - i.quantity);
  const lossMin = lossPieces / perMin;
  const justifiedMin = Math.min(lossMin, totalMin);
  const unjustifiedMin = lossMin - justifiedMin;
  const status: CheckStatus = lossMin <= tol ? 'meta' : unjustifiedMin <= tol ? 'justificada' : 'divergencia';
  return {
    ...base,
    status,
    ratePerHour: round1(perMin * 60),
    expected: Math.floor(expectedExact + 1e-9),
    lossPieces: Math.round(lossPieces),
    lossMin: round1(lossMin),
    justifiedMin: round1(justifiedMin),
    unjustifiedMin: round1(unjustifiedMin),
    unjustifiedPieces: Math.round(unjustifiedMin * perMin),
    aboveStandard: i.quantity > expectedExact + tol * perMin,
    stopsExceedLoss: totalMin > lossMin + tol,
  };
}
