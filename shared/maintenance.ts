// Work orders requested by anyone and handled by a specialist team. Two kinds share the same flow
// (queue, accept, pause, hand over, finish) and differ only in the opening form and who works on them:
//  - Ordem de Manutenção ("OS"): corrective maintenance, handled by maintainers ("manutentor").
//  - Ordem de Ajuste ("OA"): process adjustment, handled by process technicians ("tecnico_processo").
// Every time is recorded by the system, never typed.

import type { Role } from './constants.js';
import type { Actor } from './permissions.js';

export const WO_DOMAINS = ['manutencao', 'ajuste'] as const;
export type WoDomain = (typeof WO_DOMAINS)[number];

export interface WoDomainInfo {
  /** API prefix (/api/os, /api/oa) and web route (/os, /ajustes). */
  api: string;
  path: string;
  /** Code prefix and short name used in sentences ("a OS", "a OA"). */
  short: 'OS' | 'OA';
  title: string;
  /** Area whose gestores and líderes run the queue and see the dashboard. */
  areaSlug: string;
  team: string;
  workerRole: Role;
  worker: string;
  workers: string;
  pauseReasons: readonly string[];
}

export const WO_DOMAIN: Record<WoDomain, WoDomainInfo> = {
  manutencao: {
    api: '/api/os', path: '/os', short: 'OS', title: 'Ordens de Manutenção', areaSlug: 'manutencao', team: 'manutenção',
    workerRole: 'manutentor', worker: 'manutentor', workers: 'manutentores',
    pauseReasons: ['Aguardando peça', 'Aguardando liberação da produção', 'Aguardando terceiro', 'Outro'],
  },
  ajuste: {
    api: '/api/oa', path: '/ajustes', short: 'OA', title: 'Ordens de Ajuste', areaSlug: 'processos', team: 'processos',
    workerRole: 'tecnico_processo', worker: 'processista', workers: 'processistas',
    pauseReasons: ['Aguardando material', 'Aguardando manutenção', 'Aguardando ferramentaria', 'Aguardando liberação da qualidade', 'Outro'],
  },
};

/** Gestor or líder of the domain's area (identified by role + area, not by name), or administrator. */
export const leadsDomain = (a: Actor, areaId: number | null | undefined) =>
  a.role === 'admin' || ((a.role === 'gestor' || a.role === 'lider') && a.areaId != null && a.areaId === areaId);

/** Who can accept and work on orders: the domain's technicians and its leadership. */
export const worksDomain = (d: WoDomain, a: Actor, areaId: number | null | undefined) =>
  a.role === WO_DOMAIN[d].workerRole || leadsDomain(a, areaId);

/** Where the order is: a machine or an assembly cell. Adjustments only happen on machines. */
export const WO_LOCATIONS = ['maquina', 'montagem'] as const;
export type WoLocation = (typeof WO_LOCATIONS)[number];
export const WO_LOCATION_LABELS: Record<WoLocation, string> = { maquina: 'Máquina', montagem: 'Montagem' };
export const domainLocations = (d: WoDomain): WoLocation[] => (d === 'ajuste' ? ['maquina'] : ['maquina', 'montagem']);

/** Dashboards of a module: its area leadership, plus the plant manager (read only). */
export const seesDomainDashboard = (a: Actor, areaId: number | null | undefined) => leadsDomain(a, areaId) || a.role === 'plant_manager';

/** Reasons printed on the paper "Ordem de Ajuste - Processo" (numbered as on the form). */
export const ADJ_REASONS: Record<number, string> = {
  1: 'Contaminação',
  2: 'Problemas com desumidificador de material',
  3: 'Deformações',
  4: 'Gravações e datadores ilegíveis',
  5: 'Ajustes dimensionais (espessura)',
  6: 'Ajuste de peso',
  7: 'Problemas com fechador de parison',
  8: 'Problemas com o molde',
  9: 'Abrindo na linha de fechamento',
  10: 'Problemas com dobras internas / caroço',
  11: 'Parada de máquina',
  12: 'Início de máquina após manutenção de máquina',
  13: 'Início de máquina após manutenção no dispositivo',
  14: 'Início de máquina após falta de operador',
  15: 'Início de máquina após atualização de datadores',
  16: 'Início de máquina após refeições',
  17: 'Início de máquina após setup',
  18: 'Início de máquina após queda de energia',
  19: 'Início de máquina após falta de matéria-prima',
  20: 'Início de máquina após falta de embalagem',
  21: 'Ajuste devido a % incorreta de material',
};
export const ADJ_REASON_CODES = Object.keys(ADJ_REASONS).map(Number);
/** Reason that asks for the virgin and regrind material percentages. */
export const ADJ_MATERIAL_REASON = 21;
export const adjReasonLabel = (n: number) => `${n}. ${ADJ_REASONS[n] ?? '?'}`;

export const WO_KINDS = ['mecanica', 'eletrica', 'hidraulica', 'pneumatica', 'outros'] as const;
export type WoKind = (typeof WO_KINDS)[number];
export const WO_KIND_LABELS: Record<WoKind, string> = {
  mecanica: 'Mecânica',
  eletrica: 'Elétrica',
  hidraulica: 'Hidráulica',
  pneumatica: 'Pneumática',
  outros: 'Outros',
};

export const WO_STATUSES = ['aberta', 'em_atendimento', 'pausada', 'finalizada'] as const;
export type WoStatus = (typeof WO_STATUSES)[number];
export const WO_STATUS_LABELS: Record<WoStatus, string> = {
  aberta: 'Aberta',
  em_atendimento: 'Em atendimento',
  pausada: 'Pausada',
  finalizada: 'Finalizada',
};
export const WO_OPEN_STATUSES: WoStatus[] = ['aberta', 'em_atendimento', 'pausada'];

export const WO_PRIORITIES = ['critica', 'alta', 'normal', 'baixa'] as const;
export type WoPriority = (typeof WO_PRIORITIES)[number];
export const WO_PRIORITY_LABELS: Record<WoPriority, string> = {
  critica: 'Crítica',
  alta: 'Alta',
  normal: 'Normal',
  baixa: 'Baixa',
};
/** Queue order: lower first. */
export const WO_PRIORITY_RANK: Record<WoPriority, number> = { critica: 0, alta: 1, normal: 2, baixa: 3 };

/** Slug of the area whose managers and leaders run the maintenance queue. */
export const MAINTENANCE_AREA_SLUG = 'manutencao';

/** Type of maintenance or reason of the adjustment, as one label. */
export const woCategory = (o: { kind: WoKind | null; reason: number | null }) => (o.kind ? WO_KIND_LABELS[o.kind] : o.reason ? adjReasonLabel(o.reason) : '—');

/** Gerente/líder de manutenção, or administrator. */
export const leadsMaintenance = leadsDomain;
export const worksMaintenance = (a: Actor, maintenanceAreaId: number | null | undefined) => worksDomain('manutencao', a, maintenanceAreaId);

export const woCode = (year: number, number: number, d: WoDomain = 'manutencao') => `${WO_DOMAIN[d].short}-${year}-${String(number).padStart(5, '0')}`;

export interface Interval { from: string | Date; to: string | Date | null }

const ms = (d: string | Date | null, now: number) => (d == null ? now : new Date(d).getTime());

/** Milliseconds of [from, to] that fall outside every pause. */
export function workedMs(span: Interval, pauses: Interval[], now = Date.now()): number {
  const a = ms(span.from, now);
  const b = ms(span.to, now);
  if (b <= a) return 0;
  let paused = 0;
  for (const p of pauses) {
    const s = Math.max(a, ms(p.from, now));
    const e = Math.min(b, ms(p.to, now));
    if (e > s) paused += e - s;
  }
  return b - a - paused;
}

export interface WoTimes {
  /** Opening → first acceptance (or now). */
  waitMs: number;
  /** First acceptance → finish (or now), without paused time. */
  workMs: number | null;
  pausedMs: number;
  /** Opening → finish (or now). */
  totalMs: number;
}

export function woTimes(o: { opened_at: string | Date; first_accepted_at: string | Date | null; finished_at: string | Date | null }, pauses: Interval[], now = Date.now()): WoTimes {
  const opened = new Date(o.opened_at).getTime();
  const end = ms(o.finished_at, now);
  const accepted = o.first_accepted_at ? new Date(o.first_accepted_at).getTime() : null;
  const pausedMs = pauses.reduce((s, p) => s + Math.max(0, ms(p.to, now) - new Date(p.from).getTime()), 0);
  return {
    waitMs: (accepted ?? end) - opened,
    workMs: accepted == null ? null : workedMs({ from: new Date(accepted), to: new Date(end) }, pauses, now),
    pausedMs,
    totalMs: end - opened,
  };
}

/** Wording of each step of the history. */
export function eventText(e: { action: string; data: Record<string, any> }): string {
  const d = e.data ?? {};
  switch (e.action) {
    case 'abriu': return `abriu a ordem${d.parada ? ' (máquina parada)' : ''}`;
    case 'aceitou': return 'aceitou a ordem';
    case 'entrou': return 'entrou na ordem';
    case 'assumiu': return `assumiu a ordem${d.de ? ` passada por ${d.de}` : ''}`;
    case 'saiu': return `saiu da ordem: ${d.motivo}`;
    case 'devolveu': return `devolveu para a fila: ${d.motivo}`;
    case 'passou': return `quer passar a ordem para ${d.para}`;
    case 'recusou': return 'não aceitou a passagem';
    case 'cancelou_passagem': return 'cancelou a passagem';
    case 'pausou': return `pausou: ${d.motivo}`;
    case 'retomou': return 'retomou o atendimento';
    case 'finalizou': return 'finalizou a ordem';
    case 'priorizou': return [d.prioridade && `prioridade ${d.prioridade}`, d.topo].filter(Boolean).join('; ');
    case 'indicou': return `indicou a ordem para ${d.para}`;
    case 'anexou': return `anexou ${d.finalidade === 'servico' ? 'foto do serviço' : 'foto'}`;
    default: return e.action;
  }
}
