// Maintenance work orders (Ordem de Manutenção, "OS"): corrective maintenance requested by anyone,
// handled by the maintenance team. Every time is recorded by the system, never typed.

import type { Actor } from './permissions.js';

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

export const WO_PAUSE_REASONS = ['Aguardando peça', 'Aguardando liberação da produção', 'Aguardando terceiro', 'Outro'] as const;

/** Slug of the area whose managers and leaders run the maintenance queue. */
export const MAINTENANCE_AREA_SLUG = 'manutencao';

/** Gerente/líder de manutenção (identified by role + area, not by name), or administrator. */
export const leadsMaintenance = (a: Actor, maintenanceAreaId: number | null | undefined) =>
  a.role === 'admin' || ((a.role === 'gestor' || a.role === 'lider') && a.areaId != null && a.areaId === maintenanceAreaId);

/** Who can accept and work on orders: maintainers and the maintenance leadership. */
export const worksMaintenance = (a: Actor, maintenanceAreaId: number | null | undefined) =>
  a.role === 'manutentor' || leadsMaintenance(a, maintenanceAreaId);

export const woCode = (year: number, number: number) => `OS-${year}-${String(number).padStart(5, '0')}`;

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
