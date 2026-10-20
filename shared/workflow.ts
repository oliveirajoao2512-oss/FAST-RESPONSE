import type { Complexity, Status } from './constants.js';
import type { AppConfig } from './config.js';

/**
 * Transitions allowed through the generic "change status" action.
 * Blocking, completing, validating, reopening and cancelling have dedicated
 * actions with their own requirements and are NOT reachable from here.
 */
export const SIMPLE_TRANSITIONS: Partial<Record<Status, Status[]>> = {
  aberta: ['planejada', 'em_andamento'],
  planejada: ['aberta', 'em_andamento'],
  em_andamento: ['planejada'],
};

export function canSimpleTransition(from: Status, to: Status): boolean {
  return SIMPLE_TRANSITIONS[from]?.includes(to) ?? false;
}

export const CAN_BLOCK_FROM: Status[] = ['aberta', 'aguardando_responsavel', 'planejada', 'em_andamento'];
export const CAN_COMPLETE_FROM: Status[] = ['aberta', 'planejada', 'em_andamento'];
export const CAN_CANCEL_FROM: Status[] = ['aberta', 'aguardando_responsavel', 'planejada', 'em_andamento', 'bloqueada', 'aguardando_validacao'];

export interface StepFact {
  mandatory: boolean;
  status: string;
}

/** Progress (0–100) from steps: concluded / non-cancelled. */
export function stepProgress(steps: StepFact[]): number {
  const relevant = steps.filter((s) => s.status !== 'cancelada');
  if (relevant.length === 0) return 0;
  return Math.round((relevant.filter((s) => s.status === 'concluida').length / relevant.length) * 100);
}

export function pendingMandatorySteps(steps: StepFact[]): number {
  return steps.filter((s) => s.mandatory && s.status !== 'concluida' && s.status !== 'cancelada').length;
}

/** Objective complexity: derived from the number of mandatory (non-cancelled) steps. */
export function autoComplexity(steps: StepFact[], cfg: AppConfig['complexity']): Complexity {
  const n = steps.filter((s) => s.mandatory && s.status !== 'cancelada').length;
  if (n >= cfg.complexMinSteps) return 'complexa';
  if (n >= cfg.moderateMinSteps) return 'moderada';
  return 'simples';
}

export interface CompletionInput {
  solution: string;
  criteriaConfirmed: boolean;
  evidenceCount: number;
  evidenceRequired: boolean;
  pendingMandatorySteps: number;
  openImpediments: number;
}

/** Returns the list of unmet closing requirements (empty = may complete). */
export function completionProblems(c: CompletionInput): string[] {
  const p: string[] = [];
  if (!c.solution || c.solution.trim().length < 10) p.push('Descreva a solução aplicada (mínimo 10 caracteres).');
  if (!c.criteriaConfirmed) p.push('Confirme que o critério de conclusão foi atendido.');
  if (c.evidenceRequired && c.evidenceCount === 0) p.push('Anexe ao menos uma evidência da solução.');
  if (c.pendingMandatorySteps > 0) p.push(`Há ${c.pendingMandatorySteps} etapa(s) obrigatória(s) não concluída(s).`);
  if (c.openImpediments > 0) p.push('Há impedimentos em aberto. Resolva-os antes de concluir.');
  return p;
}
