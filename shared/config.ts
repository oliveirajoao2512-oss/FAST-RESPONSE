import type { Complexity, Priority, Role } from './constants.js';

/** Company configuration, editable by administrators. Stored in the `settings` table. */
export interface AppConfig {
  timezone: string;
  deadline: {
    /** Calendar days added to the opening day (D + days). */
    days: number;
    /** Local time (HH:mm) at which the due day ends. */
    time: string;
    /** When true, Saturdays, Sundays and holidays are skipped. */
    skipWeekends: boolean;
    /** Holidays as YYYY-MM-DD, skipped when skipWeekends is true. */
    holidays: string[];
    /** Critical safety issues get due = opened + N hours. */
    criticalSafetyHours: number;
    /** "Prazo próximo" warning window, in hours. */
    dueSoonHours: number;
  };
  workflow: {
    requireValidation: boolean;
    /** Whoever completed the issue may not validate it (unless true). */
    allowSelfValidation: boolean;
    /** Priorities for which closing evidence (attachment) is mandatory. */
    evidenceRequiredForPriorities: Priority[];
    /** Roles whose deadline changes need approval by a leader/manager. */
    deadlineChangeRequiresApprovalFor: Role[];
  };
  escalation: {
    notifyLeadersOnOverdue: boolean;
    /** Managers are notified once an issue has been overdue for N hours. */
    managerAfterOverdueHours: number;
    notifyManagersOnCriticalSafety: boolean;
  };
  complexity: {
    /** Number of mandatory steps from which the issue is "moderada". */
    moderateMinSteps: number;
    /** Number of mandatory steps from which the issue is "complexa". */
    complexMinSteps: number;
  };
  recurrence: {
    /** Window to auto-detect a recurrence (same asset + same category). */
    windowDays: number;
  };
  scoring: {
    base: Record<Complexity, number>;
    onTimeBonusPct: number;
    latePenaltyPct: number;
    reopenPenalty: number;
    recurrencePenalty: number;
    stepPoints: number;
    /** Self-opened simple issues closed faster than this earn no points. */
    quickSelfCloseMinutes: number;
    /** Simple issues beyond this count in a month earn no points. */
    maxSimplePerMonth: number;
    /** Minimum validated issues to be eligible for "campeão do mês". */
    minIssuesForChampion: number;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  timezone: 'America/Sao_Paulo',
  deadline: {
    days: 1,
    time: '23:59',
    skipWeekends: false,
    holidays: [],
    criticalSafetyHours: 4,
    dueSoonHours: 4,
  },
  workflow: {
    requireValidation: true,
    allowSelfValidation: false,
    evidenceRequiredForPriorities: ['critica'],
    deadlineChangeRequiresApprovalFor: ['colaborador'],
  },
  escalation: {
    notifyLeadersOnOverdue: true,
    managerAfterOverdueHours: 24,
    notifyManagersOnCriticalSafety: true,
  },
  complexity: { moderateMinSteps: 2, complexMinSteps: 5 },
  recurrence: { windowDays: 90 },
  scoring: {
    base: { simples: 10, moderada: 20, complexa: 35 },
    onTimeBonusPct: 30,
    latePenaltyPct: 40,
    reopenPenalty: 15,
    recurrencePenalty: 10,
    stepPoints: 3,
    quickSelfCloseMinutes: 30,
    maxSimplePerMonth: 40,
    minIssuesForChampion: 3,
  },
};

/** Deep-merges a stored partial config over the defaults. */
export function mergeConfig(stored: unknown): AppConfig {
  const merge = (base: any, over: any): any => {
    if (Array.isArray(base)) return Array.isArray(over) ? over : base;
    if (base && typeof base === 'object') {
      const out: any = { ...base };
      if (over && typeof over === 'object' && !Array.isArray(over)) {
        for (const k of Object.keys(base)) if (k in over) out[k] = merge(base[k], over[k]);
      }
      return out;
    }
    return over === undefined || over === null || typeof over !== typeof base ? base : over;
  };
  return merge(DEFAULT_CONFIG, stored);
}
