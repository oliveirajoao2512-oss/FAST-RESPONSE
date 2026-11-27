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
  /** meal break inside the period, told by the leader (the time is not standard: it depends on who covers) */
  breakMin?: number;
}
export interface CheckResult {
  status: CheckStatus;
  periodMin: number;
  breakMin: number;
  /** period minus the meal break: the time the machine was supposed to produce */
  plannedMin: number;
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
  const breakMin = Math.min(periodMin, Math.max(0, i.breakMin ?? 0));
  const plannedMin = periodMin - breakMin;
  const base = { periodMin: round1(periodMin), breakMin: round1(breakMin), plannedMin: round1(plannedMin), quantity: i.quantity, stopMin, stops };
  if (!i.cycleSeconds || i.cycleSeconds <= 0) {
    return {
      ...base, status: 'sem_padrao', ratePerHour: null, expected: null, lossPieces: null, lossMin: null,
      justifiedMin: null, unjustifiedMin: null, unjustifiedPieces: null, aboveStandard: false, stopsExceedLoss: false,
    };
  }
  const perMin = (60 / i.cycleSeconds) * (i.cavities || 1);
  const expectedExact = plannedMin * perMin;
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

/* ------------------------------------------------------------------ refugo e OEE (João, 27/11/2026) */

/**
 * Pieces missing with no registered stop: the leader says whether they were scrap (bad pieces, how many and why) or
 * pieces not made (rhythm: no operator, no packaging…). Scrap is the Quality of the OEE; rhythm is its Performance.
 */
export type GapKind = 'refugo' | 'ritmo';
export const SCRAP_REASONS = ['Rebarba', 'Falha de injeção', 'Chupado', 'Mancha / contaminação', 'Bolha', 'Dimensional', 'Quebrada / trincada', 'Partida de máquina'];
export const RHYTHM_REASONS = ['Falta de M.O', 'Falta de embalagem', 'Falta de componente', 'Microparadas', 'Ciclo acima do padrão', 'Refeição'];

export type LossKey = StopSource | 'refugo' | 'ritmo' | 'pendente';
export const LOSS_LABEL: Record<LossKey, string> = {
  manutencao: 'Parada: manutenção', ajuste: 'Parada: ajuste de processo', setup: 'Parada: setup',
  refugo: 'Refugo', ritmo: 'Perda de ritmo', pendente: 'Sem motivo informado',
};

/** one report split into the OEE times, all in minutes of the standard cycle */
export interface OeeParts {
  plannedMin: number;
  /** stop minutes by source, overlaps counted once */
  stop: Record<StopSource, number>;
  runMin: number;
  /** minutes the good pieces and the scrap take at the standard cycle */
  goodMin: number; scrapMin: number;
  /** running but slower than the standard; `pendingMin` is the part still without a reason */
  rhythmMin: number; pendingMin: number;
  good: number; scrap: number;
}

/**
 * OEE = Disponibilidade × Performance × Qualidade, from one checked report:
 * - Disponibilidade: (planned − registered stops) / planned;
 * - Performance: (good + scrap) at the standard cycle / running time;
 * - Qualidade: good / (good + scrap).
 * So the OEE is the good pieces at the standard cycle over the planned time. A report with no standard cycle is left out.
 */
export function oeeParts(c: CheckResult, gap: { kind: GapKind | null; scrap: number | null; reason: string | null }): OeeParts | null {
  if (!c.ratePerHour || c.plannedMin <= 0) return null;
  const perMin = c.ratePerHour / 60;
  const planned = c.plannedMin;
  const good = c.quantity;
  const scrap = gap.kind === 'refugo' ? Math.max(0, gap.scrap ?? 0) : 0;
  // more pieces than the standard allows (wrong cycle or count): capped at the planned time, never above 100%
  const goodMin = Math.min(planned, good / perMin), scrapMin = Math.min(planned - goodMin, scrap / perMin);
  const stop: Record<StopSource, number> = { manutencao: 0, ajuste: 0, setup: 0 };
  for (const s of c.stops) stop[s.source] += Math.max(0, s.minutes - s.overlapMinutes);
  let stopTotal = Math.min(planned, c.stopMin);
  // made more pieces than the running time allows: part of the "stop" was running (an OS open with production going on)
  const room = planned - (goodMin + scrapMin);
  if (stopTotal > room) stopTotal = Math.max(0, room);
  const raw = stop.manutencao + stop.ajuste + stop.setup;
  if (raw > 0) for (const k of Object.keys(stop) as StopSource[]) stop[k] = (stop[k] / raw) * stopTotal;
  const runMin = planned - stopTotal;
  const rhythmAll = Math.max(0, runMin - goodMin - scrapMin);
  const pendingMin = c.status === 'divergencia' && !gap.reason ? Math.min(rhythmAll, c.unjustifiedMin ?? 0) : 0;
  return { plannedMin: planned, stop, runMin, goodMin, scrapMin, rhythmMin: rhythmAll - pendingMin, pendingMin, good, scrap };
}

export interface OeeSum { plannedMin: number; runMin: number; goodMin: number; scrapMin: number; good: number; scrap: number; stop: Record<StopSource, number>; rhythmMin: number; pendingMin: number; entries: number }
export const emptyOee = (): OeeSum => ({ plannedMin: 0, runMin: 0, goodMin: 0, scrapMin: 0, good: 0, scrap: 0, stop: { manutencao: 0, ajuste: 0, setup: 0 }, rhythmMin: 0, pendingMin: 0, entries: 0 });
export function addOee(t: OeeSum, p: OeeParts) {
  t.plannedMin += p.plannedMin; t.runMin += p.runMin; t.goodMin += p.goodMin; t.scrapMin += p.scrapMin;
  t.good += p.good; t.scrap += p.scrap; t.rhythmMin += p.rhythmMin; t.pendingMin += p.pendingMin; t.entries++;
  for (const k of Object.keys(p.stop) as StopSource[]) t.stop[k] += p.stop[k];
  return t;
}
/** the four indicators of a sum, 0–1 (null when there is no planned time) */
export function oeeOf(t: OeeSum) {
  if (t.plannedMin <= 0) return { oee: null, availability: null, performance: null, quality: null };
  const made = t.goodMin + t.scrapMin;
  return {
    availability: t.runMin / t.plannedMin,
    performance: t.runMin > 0 ? Math.min(1, made / t.runMin) : null,
    quality: made > 0 ? t.goodMin / made : null,
    oee: t.goodMin / t.plannedMin,
  };
}
