import { useQuery } from '@tanstack/react-query';
import { can } from '@shared/permissions';
import type { Procedente, QSteps, QualityEval, QualityOrigin, QStatus, StepState } from '@shared/quality';
import { get } from './api';
import type { Me } from './session';

export interface QualityNc {
  id: number;
  origin: QualityOrigin;
  number: string;
  opened_on: string;
  kind: string | null;
  partner: string | null;
  claim_type: string | null;
  product: string | null;
  internal_code: string | null;
  customer_code: string | null;
  customer_claim: string | null;
  description: string | null;
  primary_problem: string | null;
  safety: boolean;
  recurrent: boolean;
  leader: string | null;
  steps: QSteps;
  action_plan: string | null;
  due_on: string;
  on_hold: boolean;
  on_hold_reason: string | null;
  procedente: Procedente | null;
  source: 'manual' | 'importacao';
  version: number;
  updated_at: string;
  updated_by_name: string | null;
  eval: QualityEval;
}

export interface QualityData {
  today: string;
  ncs: QualityNc[];
  lastImport: { filename: string; imported_at: string; imported_by_name: string; created_count: number; updated_count: number } | null;
}

export function useQualityAccess(me: Me | null) {
  return !!me && can.manageQuality(me, me.area?.slug === 'qualidade' ? me.area.id : null);
}

export const useQualityData = () => useQuery({ queryKey: ['quality', 'ncs'], queryFn: () => get<QualityData>('/api/quality/ncs') });
export const useQualityOptions = () =>
  useQuery({ queryKey: ['quality', 'options'], queryFn: () => get<{ catalog: Record<'tipo' | 'cliente' | 'fornecedor' | 'problema' | 'lider', string[]>; nextNumber: string }>('/api/quality/options'), staleTime: 60_000 });

/** dd/mm/aaaa from YYYY-MM-DD, without time-zone shifts. */
export const dmy = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : '—');
export const dm = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '—');
export const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;

export const STATUS_TONE: Record<QStatus, string> = {
  atrasado: 'bg-red-100 text-red-800 ring-red-200',
  no_prazo: 'bg-blue-50 text-blue-800 ring-blue-200',
  on_hold: 'bg-violet-100 text-violet-800 ring-violet-200',
  concluido_no_prazo: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  concluido_fora: 'bg-amber-100 text-amber-900 ring-amber-200',
  na: 'bg-gray-100 text-gray-600 ring-gray-200',
};
export const STEP_TONE: Record<StepState, string> = {
  feito: 'bg-emerald-500 border-emerald-500',
  feito_atrasado: 'bg-amber-400 border-amber-400',
  atrasado: 'bg-red-600 border-red-600',
  pendente: 'bg-white border-gray-300',
  na: 'bg-gray-200 border-gray-200',
  hold: 'bg-violet-400 border-violet-400',
};
export const STEP_STATE_LABELS: Record<StepState, string> = {
  feito: 'Concluída no prazo',
  feito_atrasado: 'Concluída com atraso',
  atrasado: 'Vencida sem registro',
  pendente: 'A fazer',
  na: 'Não aplicável',
  hold: 'On hold',
};
