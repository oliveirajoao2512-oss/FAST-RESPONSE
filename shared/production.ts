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
 * Was an admin-only preview; João released it to the leaders of Produção on 27/11/2026 (adminOnly = false). Turning it
 * back on hides the module from everyone but the administrator.
 */
export const productionAccess = { adminOnly: false };

/** who reports production and sees the conferência: leadership of Produção, plant manager and administrator */
export const canReportProduction = (a: { role: string }, areaSlug: string | null | undefined) =>
  a.role === 'admin' || (!productionAccess.adminOnly && (a.role === 'plant_manager' || ((a.role === 'lider' || a.role === 'gestor') && areaSlug === 'producao')));
/** who edits the standard cycles: administrator, plant manager and the gestor of Produção */
export const canEditStandards = (a: { role: string }, areaSlug: string | null | undefined) =>
  a.role === 'admin' || (!productionAccess.adminOnly && (a.role === 'plant_manager' || (a.role === 'gestor' && areaSlug === 'producao')));

export const machineKey = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');

/** `outro`: a stop the leader tells when reporting (no MP, packaging, components…), with no OS/OA/setup behind it */
export type StopSource = 'manutencao' | 'ajuste' | 'setup' | 'outro';
export const STOP_SOURCE_LABEL: Record<StopSource, string> = { manutencao: 'Manutenção', ajuste: 'Ajuste de processo', setup: 'Setup', outro: 'Parada informada' };
/** the plant's stop codes that can explain a missed target before it becomes scrap (João, 27/11/2026) */
export const OTHER_STOP_GROUPS: { group: string; reasons: string[] }[] = [
  { group: 'Áreas de apoio', reasons: [
    '09 Falta energia elétrica', '11 Falta matéria-prima', '13 Falta de embalagem', '15 Ajuste no Injet', '22 Falta de componente',
    '26 Aguardando processo', '32 Falta água / ar comprimido', '34 Falta peça de reposição', '41 Falta rebitadeira', '42 Falta dispositivo',
  ] },
  { group: 'Ajustes', reasons: ['06 Ajuste início de produção', '16 Ajuste de processo', '20 Fechador de parison', '31 Ajuste molde / ferramenta', '37 Ajuste após manutenção'] },
];
export const OTHER_STOP_REASONS = OTHER_STOP_GROUPS.flatMap((g) => g.reasons);

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
  /** stop told by the leader with no OS/OA/setup behind it (minutes inside the period, with its reason) */
  otherStop?: { minutes: number; reason: string; ref: string } | null;
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
  const clipped = clipStops(i.stops, i.start, i.end);
  const stops = clipped.stops;
  let totalMin = clipped.totalMin;
  const breakMin = Math.min(periodMin, Math.max(0, i.breakMin ?? 0));
  // the told stop adds to the registered ones, never beyond the time the machine should have run
  if (i.otherStop && i.otherStop.minutes > 0) {
    const add = Math.max(0, Math.min(i.otherStop.minutes, periodMin - breakMin - totalMin));
    totalMin += add;
    stops.push({ source: 'outro', ref: i.otherStop.ref, label: i.otherStop.reason, start: i.end, end: i.end, minutes: round1(add), overlapMinutes: 0 });
  }
  const stopMin = round1(totalMin);
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
/** OEE target of the plant (João, 27/11/2026) */
export const OEE_TARGET = 0.85;
/** the plant's scrap codes (Consulta Coletor Injet + Alerta Manual, sent by João 27/11/2026) */
export const SCRAP_REASONS = [
  '01 Contaminação', '02 Excesso de material interno', '03 Dimensões fora do especificado', '04 Deformação de peças',
  '05 Corte de faca pelo operador', '06 Danificadas pelo trim die', '07 Contração excessiva', '08 Parison grudando na peça',
  '09 Riscos externos excessivos', '10 Apresentando colapso', '11 Excesso de rebarba/bocal', '12 Peso fora do especificado',
  '13 Problemas com molde', '14 Datadores ilegíveis', '15 Falha no sopro/murcha/peça', '16 Abrindo na linha de fechamento',
  '17 Rachadura externa no bocal menor', '18 Marcas pelo dispositivo/acabamento', '19 Corte irregular', '20 Danificado pelo dispositivo',
  '21 Falha na região da solda', '22 Reprovado na estanqueidade', '23 Furo/estampo fora de posição', '24 Rebarbas excessivas nos estampos',
  '25 Problemas com componentes', '26 Teste de qualidade', '27 Ajuste de processo/manutenção', '28 Aguardando operação posterior', '29 Ajuste de saldo',
];
export const RHYTHM_REASONS = ['Falta de M.O', 'Falta de embalagem', 'Falta de componente', 'Microparadas', 'Ciclo acima do padrão', 'Refeição'];

export type LossKey = StopSource | 'refugo' | 'ritmo' | 'pendente';
export const LOSS_LABEL: Record<LossKey, string> = {
  manutencao: 'Parada: manutenção', ajuste: 'Parada: ajuste de processo', setup: 'Parada: setup', outro: 'Parada informada (apoio / ajuste sem OA)',
  refugo: 'Refugo', ritmo: 'Perda de ritmo', pendente: 'Refugo sem motivo informado',
};

/** one report split into the OEE times, all in minutes of the standard cycle (`scrapMin` + `pendingMin` = all the scrap) */
export interface OeeParts {
  plannedMin: number;
  /** stop minutes by source, overlaps counted once */
  stop: Record<StopSource, number>;
  runMin: number;
  /** minutes the good pieces and the scrap take at the standard cycle */
  goodMin: number; scrapMin: number;
  /** running but slower than the standard; `pendingMin` is scrap still without its defect */
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
  // time with no stop and no answer yet is scrap too (João, 27/11/2026): its pieces wait for the defect
  const pending = c.status === 'divergencia' && !gap.reason && gap.kind == null ? Math.max(0, c.unjustifiedPieces ?? 0) : 0;
  const scrap = (gap.kind === 'refugo' ? Math.max(0, gap.scrap ?? 0) : 0) + pending;
  // more pieces than the standard allows (wrong cycle or count): capped at the planned time, never above 100%
  const goodMin = Math.min(planned, good / perMin), scrapMin = Math.min(planned - goodMin, scrap / perMin);
  const stop: Record<StopSource, number> = { manutencao: 0, ajuste: 0, setup: 0, outro: 0 };
  for (const s of c.stops) stop[s.source] += Math.max(0, s.minutes - s.overlapMinutes);
  let stopTotal = Math.min(planned, c.stopMin);
  // made more pieces than the running time allows: part of the "stop" was running (an OS open with production going on)
  const room = planned - (goodMin + scrapMin);
  if (stopTotal > room) stopTotal = Math.max(0, room);
  const raw = stop.manutencao + stop.ajuste + stop.setup + stop.outro;
  if (raw > 0) for (const k of Object.keys(stop) as StopSource[]) stop[k] = (stop[k] / raw) * stopTotal;
  const runMin = planned - stopTotal;
  const rhythmMin = Math.max(0, runMin - goodMin - scrapMin);
  const pendingMin = Math.min(scrapMin, pending / perMin);
  return { plannedMin: planned, stop, runMin, goodMin, scrapMin: scrapMin - pendingMin, rhythmMin, pendingMin, good, scrap };
}

export interface OeeSum { plannedMin: number; runMin: number; goodMin: number; scrapMin: number; good: number; scrap: number; stop: Record<StopSource, number>; rhythmMin: number; pendingMin: number; entries: number }
export const emptyOee = (): OeeSum => ({ plannedMin: 0, runMin: 0, goodMin: 0, scrapMin: 0, good: 0, scrap: 0, stop: { manutencao: 0, ajuste: 0, setup: 0, outro: 0 }, rhythmMin: 0, pendingMin: 0, entries: 0 });
export function addOee(t: OeeSum, p: OeeParts) {
  t.plannedMin += p.plannedMin; t.runMin += p.runMin; t.goodMin += p.goodMin; t.scrapMin += p.scrapMin;
  t.good += p.good; t.scrap += p.scrap; t.rhythmMin += p.rhythmMin; t.pendingMin += p.pendingMin; t.entries++;
  for (const k of Object.keys(p.stop) as StopSource[]) t.stop[k] += p.stop[k];
  return t;
}
/** the four indicators of a sum, 0–1 (null when there is no planned time) */
export function oeeOf(t: OeeSum) {
  if (t.plannedMin <= 0) return { oee: null, availability: null, performance: null, quality: null };
  const made = t.goodMin + t.scrapMin + t.pendingMin;
  return {
    availability: t.runMin / t.plannedMin,
    performance: t.runMin > 0 ? Math.min(1, made / t.runMin) : null,
    quality: made > 0 ? t.goodMin / made : null,
    oee: t.goodMin / t.plannedMin,
  };
}
