import type { Complexity } from './constants.js';
import type { AppConfig } from './config.js';

export interface ScoredIssue {
  id: string;
  code: string;
  complexity: Complexity;
  openedById: string;
  creditedUserId: string;
  openedAt: Date;
  completedAt: Date;
  dueAt: Date;
  reopenCount: number;
  /** Another issue was registered as a recurrence of this one within the window. */
  hadRecurrence: boolean;
}

export interface IssueScore {
  issueId: string;
  code: string;
  points: number;
  base: number;
  onTime: boolean;
  adjustments: { reason: string; points: number }[];
  counted: boolean;
}

/**
 * Transparent per-issue score. Only issues concluded AND validated in the month
 * reach this function (cancelled or awaiting validation never do).
 */
export function scoreIssue(i: ScoredIssue, cfg: AppConfig['scoring'], simpleIndex: number): IssueScore {
  const base = cfg.base[i.complexity];
  const adjustments: { reason: string; points: number }[] = [];
  const onTime = i.completedAt.getTime() <= i.dueAt.getTime();

  const minutes = (i.completedAt.getTime() - i.openedAt.getTime()) / 60000;
  if (i.complexity === 'simples' && i.openedById === i.creditedUserId && minutes < cfg.quickSelfCloseMinutes) {
    return { issueId: i.id, code: i.code, points: 0, base, onTime, counted: false,
      adjustments: [{ reason: `Aberta e encerrada pelo mesmo colaborador em menos de ${cfg.quickSelfCloseMinutes} min`, points: -base }] };
  }
  if (i.complexity === 'simples' && simpleIndex >= cfg.maxSimplePerMonth) {
    return { issueId: i.id, code: i.code, points: 0, base, onTime, counted: false,
      adjustments: [{ reason: `Limite mensal de ${cfg.maxSimplePerMonth} pendências simples pontuadas`, points: -base }] };
  }
  if (onTime) adjustments.push({ reason: 'Concluída dentro do prazo', points: round((base * cfg.onTimeBonusPct) / 100) });
  else adjustments.push({ reason: 'Concluída após o prazo', points: -round((base * cfg.latePenaltyPct) / 100) });
  if (i.reopenCount > 0)
    adjustments.push({ reason: `Reaberta ${i.reopenCount}x por solução ineficaz`, points: -cfg.reopenPenalty * i.reopenCount });
  if (i.hadRecurrence) adjustments.push({ reason: 'Problema reincidente', points: -cfg.recurrencePenalty });

  const total = Math.max(0, base + adjustments.reduce((s, a) => s + a.points, 0));
  return { issueId: i.id, code: i.code, points: round(total), base, onTime, adjustments, counted: true };
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
