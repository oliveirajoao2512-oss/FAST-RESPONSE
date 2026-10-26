import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { WO_DOMAIN, type WoDomain, type WoKind, type WoLocation, type WoPriority, type WoStatus, type WoTimes } from '@shared/maintenance';
import { get, qs } from './api';

/** Which order module the components below are showing (maintenance or process adjustment). */
const DomainContext = createContext<WoDomain>('manutencao');
export const WoDomainProvider = DomainContext.Provider;
export const useWoDomain = () => {
  const d = useContext(DomainContext);
  return { d, ...WO_DOMAIN[d] };
};

export interface WorkOrder {
  id: string;
  domain: WoDomain;
  code: string;
  opened_by: string;
  opened_by_name: string;
  area_id: number;
  area_name: string;
  area_color: string;
  asset_ref: string;
  location_type: WoLocation | null;
  kind: WoKind | null;
  reason: number | null;
  part_number: string | null;
  virgin_pct: number | null;
  regrind_pct: number | null;
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
  teamAreaId: number | null;
  canSeeDashboard: boolean;
  places: Partial<Record<WoLocation, { code: string; description: string | null }[]>>;
  partNumbers?: string[];
  canWork: boolean;
  canLead: boolean;
}

// every key starts with 'os' so one realtime event refreshes both modules
export const useWoOptions = (domain?: WoDomain) => {
  const ctx = useContext(DomainContext);
  const d = domain ?? ctx;
  return useQuery<WoOptions>({ queryKey: ['os', d, 'options'], queryFn: () => get(`${WO_DOMAIN[d].api}/options`), staleTime: 5 * 60_000 });
};

export const useWoList = (view: 'abertas' | 'finalizadas', params: Record<string, unknown> = {}, enabled = true, domain?: WoDomain) => {
  const ctx = useContext(DomainContext);
  const d = domain ?? ctx;
  return useQuery<WorkOrder[]>({ queryKey: ['os', d, 'list', view, params], queryFn: () => get(`${WO_DOMAIN[d].api}${qs({ view, ...params })}`), enabled });
};

export const useWoDetail = (id: string | null) => {
  const d = useContext(DomainContext);
  return useQuery<WorkOrderDetail>({ queryKey: ['os', d, 'detail', id], queryFn: () => get(`${WO_DOMAIN[d].api}/${id}`), enabled: !!id });
};

export { eventText } from '@shared/maintenance';
