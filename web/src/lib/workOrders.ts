import { useQuery } from '@tanstack/react-query';
import type { WoKind, WoPriority, WoStatus, WoTimes } from '@shared/maintenance';
import { get, qs } from './api';

export interface WorkOrder {
  id: string;
  code: string;
  opened_by: string;
  opened_by_name: string;
  area_id: number;
  area_name: string;
  area_color: string;
  asset_ref: string;
  kind: WoKind;
  machine_stopped: boolean;
  description: string;
  priority: WoPriority;
  pinned: boolean;
  status: WoStatus;
  suggested_to: string | null;
  suggested_name: string | null;
  transfer_from: string | null;
  transfer_from_name: string | null;
  transfer_to: string | null;
  transfer_to_name: string | null;
  service_done: string | null;
  material: string | null;
  opened_at: string;
  first_accepted_at: string | null;
  finished_at: string | null;
  finished_by_name: string | null;
  workers: { id: string; name: string; since: string }[];
  pauses: { from: string; to: string | null; reason: string }[];
  files: number;
  times: WoTimes;
}

export interface WorkOrderDetail extends WorkOrder {
  events: { id: number; action: string; data: Record<string, any>; created_at: string; actor_name: string | null }[];
  attachments: WoFile[];
  hoursByWorker: { id: string; name: string; ms: number }[];
  stints: { user_id: string; name: string; joined_at: string; left_at: string | null; left_reason: string | null }[];
}
export type WoFile = { id: string; purpose: 'abertura' | 'servico'; filename: string; mime: string; size_bytes: number; created_at: string };

export interface WoOptions {
  areas: { id: number; slug: string; name: string; color: string }[];
  team: { id: string; name: string; role: string }[];
  maintenanceAreaId: number | null;
  canWork: boolean;
  canLead: boolean;
}

export const useWoOptions = () => useQuery<WoOptions>({ queryKey: ['os', 'options'], queryFn: () => get('/api/os/options'), staleTime: 5 * 60_000 });

export const useWoList = (view: 'abertas' | 'finalizadas', params: Record<string, unknown> = {}, enabled = true) =>
  useQuery<WorkOrder[]>({ queryKey: ['os', 'list', view, params], queryFn: () => get(`/api/os${qs({ view, ...params })}`), enabled });

export const useWoDetail = (id: string | null) =>
  useQuery<WorkOrderDetail>({ queryKey: ['os', 'detail', id], queryFn: () => get(`/api/os/${id}`), enabled: !!id });

/** Wording of each step of the history. */
export function eventText(e: { action: string; data: Record<string, any> }): string {
  const d = e.data ?? {};
  switch (e.action) {
    case 'abriu': return `abriu a OS${d.parada ? ' (máquina parada)' : ''}`;
    case 'aceitou': return 'aceitou a OS';
    case 'entrou': return 'entrou na OS';
    case 'assumiu': return `assumiu a OS${d.de ? ` passada por ${d.de}` : ''}`;
    case 'saiu': return `saiu da OS: ${d.motivo}`;
    case 'devolveu': return `devolveu para a fila: ${d.motivo}`;
    case 'passou': return `quer passar a OS para ${d.para}`;
    case 'recusou': return 'não aceitou a passagem';
    case 'cancelou_passagem': return 'cancelou a passagem';
    case 'pausou': return `pausou: ${d.motivo}`;
    case 'retomou': return 'retomou o atendimento';
    case 'finalizou': return 'finalizou a OS';
    case 'priorizou': return [d.prioridade && `prioridade ${d.prioridade}`, d.topo].filter(Boolean).join('; ');
    case 'indicou': return `indicou a OS para ${d.para}`;
    case 'anexou': return `anexou ${d.finalidade === 'servico' ? 'foto do serviço' : 'foto'}`;
    default: return e.action;
  }
}
