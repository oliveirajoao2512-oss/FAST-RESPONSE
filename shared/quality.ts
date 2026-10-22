// Quality module ("Resposta Rápida"): customer, internal and supplier non-conformities (NC).
// Same rules as the company spreadsheet: 11 steps with planned and realized dates, closing = last step.

export const QUALITY_ORIGINS = ['externa', 'interna', 'fornecedor'] as const;
export type QualityOrigin = (typeof QUALITY_ORIGINS)[number];
export const ORIGIN_LABELS: Record<QualityOrigin, string> = {
  externa: 'NC Externa',
  interna: 'NC Interna',
  fornecedor: 'NC Fornecedor',
};
/** Name of the partner column in each spreadsheet tab. */
export const PARTNER_LABELS: Record<QualityOrigin, string> = {
  externa: 'Cliente',
  interna: 'Cliente',
  fornecedor: 'Fornecedor',
};
/** Fixed series colors (validated for color-vision deficiency, always shown with a label). */
export const ORIGIN_COLORS: Record<QualityOrigin, string> = {
  externa: '#2a78d6',
  interna: '#ea6a1f',
  fornecedor: '#1baf7a',
};

/** Steps and exit criteria (days after opening) of the "Quadro de Resposta Rápida". */
export const QUALITY_STEPS = [
  { key: 'contencao', label: 'Contenção', days: 1 },
  { key: 'causa_raiz', label: 'Causa raiz', days: 7 },
  { key: 'acoes_corretivas', label: 'Ações corretivas', days: 14 },
  { key: 'poka_yoke', label: 'Poka-yoke', days: 14 },
  { key: 'validacao', label: 'Validação da eficácia', days: 34 },
  { key: 'pfmea', label: 'PFMEA', days: 35 },
  { key: 'plano_controle', label: 'Plano de controle', days: 35 },
  { key: 'trabalho_padronizado', label: 'Trabalho padronizado', days: 35 },
  { key: 'treinamento', label: 'Treinamento', days: 35 },
  { key: 'lpa', label: 'LPA', days: 40 },
  { key: 'licoes', label: 'Lições aprendidas', days: 40 },
] as const;
export type StepKey = (typeof QUALITY_STEPS)[number]['key'];
export const STEP_KEYS = QUALITY_STEPS.map((s) => s.key) as StepKey[];
export const STEP_LABELS = Object.fromEntries(QUALITY_STEPS.map((s) => [s.key, s.label])) as Record<StepKey, string>;
/** Overall deadline: opening + 40 days. */
export const QUALITY_DUE_DAYS = 40;

export type StepMark = 'na' | 'hold';
/** Dates are calendar days (YYYY-MM-DD). */
export interface QStep {
  plan: string | null;
  done: string | null;
  mark: StepMark | null;
}
export type QSteps = Record<StepKey, QStep>;

export const PROCEDENTE = ['SIM', 'NÃO', 'EM ANÁLISE'] as const;
export type Procedente = (typeof PROCEDENTE)[number];

export const Q_STATUSES = ['atrasado', 'no_prazo', 'on_hold', 'concluido_no_prazo', 'concluido_fora', 'na'] as const;
export type QStatus = (typeof Q_STATUSES)[number];
export const Q_STATUS_LABELS: Record<QStatus, string> = {
  atrasado: 'Atrasado',
  no_prazo: 'Pendente no prazo',
  on_hold: 'On hold',
  concluido_no_prazo: 'Concluído no prazo',
  concluido_fora: 'Concluído fora do prazo',
  na: 'N/A',
};
export const Q_OPEN_STATUSES: QStatus[] = ['atrasado', 'no_prazo', 'on_hold'];

export type StepState = 'feito' | 'feito_atrasado' | 'atrasado' | 'pendente' | 'na' | 'hold';

export interface QualityNcCore {
  opened_on: string;
  due_on: string;
  steps: Partial<QSteps>;
  on_hold: boolean;
  procedente: Procedente | null;
}

export interface QualityEval {
  status: QStatus;
  closedOn: string | null;
  totalDays: number;
  daysOver: number;
  /** "Fechado no prazo?" column of the spreadsheet. */
  closedOnTime: 'SIM' | 'NÃO' | 'ITEM EM ABERTO' | 'ITEM SUSPENSO';
  stepStates: Record<StepKey, StepState>;
  /** First step neither done nor N/A. */
  currentStep: StepKey | null;
  /** Steps done or N/A, 0–11. */
  doneCount: number;
}

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
export function addDays(date: string, n: number): string {
  return new Date(toMs(date) + n * DAY).toISOString().slice(0, 10);
}
export const daysBetween = (from: string, to: string) => Math.round((toMs(to) - toMs(from)) / DAY);
export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toMs(s));

export function defaultPlan(openedOn: string, key: StepKey): string {
  return addDays(openedOn, QUALITY_STEPS.find((s) => s.key === key)!.days);
}

/** All 11 steps, filling missing planned dates from the exit criteria. */
export function normalizeSteps(openedOn: string, steps: Partial<QSteps> | null | undefined): QSteps {
  const out = {} as QSteps;
  for (const k of STEP_KEYS) {
    const s = steps?.[k];
    out[k] = { plan: s?.plan ?? defaultPlan(openedOn, k), done: s?.mark ? null : (s?.done ?? null), mark: s?.mark ?? null };
  }
  return out;
}

/** Status rules of the spreadsheet ("STATUS GERAL", "DIAS TOTAIS", "FECHADO NO PRAZO?"), with `today` as reference. */
export function evaluate(nc: QualityNcCore, today: string): QualityEval {
  const steps = normalizeSteps(nc.opened_on, nc.steps);
  const stepStates = {} as Record<StepKey, StepState>;
  let currentStep: StepKey | null = null;
  let doneCount = 0;
  let anyLate = false;
  let anyHold = false;
  for (const k of STEP_KEYS) {
    const s = steps[k];
    let st: StepState;
    if (s.mark === 'na') st = 'na';
    else if (s.mark === 'hold') st = 'hold';
    else if (s.done) st = s.plan && s.done > s.plan ? 'feito_atrasado' : 'feito';
    else st = s.plan && today > s.plan ? 'atrasado' : 'pendente';
    stepStates[k] = st;
    if (st === 'feito_atrasado' || st === 'atrasado') anyLate = true;
    if (st === 'hold') anyHold = true;
    if (st === 'feito' || st === 'feito_atrasado' || st === 'na') doneCount++;
    else if (!currentStep) currentStep = k;
  }
  // A non-valid incident ("procedente = NÃO") is closed at its last recorded step.
  const lastDone = STEP_KEYS.map((k) => steps[k].done).filter((d): d is string => !!d).sort().pop() ?? null;
  const closedOn = steps.licoes.done ?? (nc.procedente === 'NÃO' ? lastDone : null);
  const ref = closedOn ?? today;
  const totalDays = Math.max(0, daysBetween(nc.opened_on, ref));
  const daysOver = Math.max(0, daysBetween(nc.due_on, ref));

  let status: QStatus;
  if (nc.procedente === 'NÃO') status = 'na';
  else if (closedOn) status = closedOn <= nc.due_on ? 'concluido_no_prazo' : 'concluido_fora';
  else if (nc.on_hold || anyHold) status = 'on_hold';
  else if (anyLate) status = 'atrasado';
  else if (doneCount === STEP_KEYS.length && STEP_KEYS.every((k) => stepStates[k] === 'na')) status = 'na';
  else status = 'no_prazo';

  let closedOnTime: QualityEval['closedOnTime'];
  if (status === 'on_hold') closedOnTime = 'ITEM SUSPENSO';
  else if (nc.procedente === 'NÃO') closedOnTime = 'SIM';
  else if (closedOn) closedOnTime = closedOn <= nc.due_on ? 'SIM' : 'NÃO';
  else closedOnTime = 'ITEM EM ABERTO';

  return { status, closedOn, totalDays, daysOver, closedOnTime, stepStates, currentStep, doneCount };
}

/** Next occurrence number in the "NNN/AA" pattern used by the spreadsheet. */
export function nextNumber(numbers: string[], today: string): string {
  const yy = today.slice(2, 4);
  let max = 0;
  for (const n of numbers) {
    const m = /^(\d+)\s*\/\s*(\d{2})$/.exec(n.trim());
    if (m && m[2] === yy) max = Math.max(max, Number(m[1]));
  }
  return `${max + 1}/${yy}`;
}

/** Suggested actions: the next step of each open NC, when overdue or due within this many days. */
export const SUGGESTION_HORIZON_DAYS = 7;
