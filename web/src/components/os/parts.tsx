import { AlertOctagon, Pause, Pin, Wrench } from 'lucide-react';
import { WO_KIND_LABELS, WO_PRIORITY_LABELS, WO_STATUS_LABELS, type WoPriority, type WoStatus } from '@shared/maintenance';
import { duration, fmtShort } from '../../lib/format';
import type { WorkOrder } from '../../lib/workOrders';
import { AreaDot, cx } from '../ui';

const PRIORITY_STYLE: Record<WoPriority, string> = {
  critica: 'bg-red-600 text-white',
  alta: 'bg-orange-100 text-orange-800',
  normal: 'bg-sky-100 text-sky-800',
  baixa: 'bg-gray-100 text-gray-600',
};
export function WoPriorityBadge({ priority }: { priority: WoPriority }) {
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap', PRIORITY_STYLE[priority])}>{WO_PRIORITY_LABELS[priority]}</span>;
}

const STATUS_STYLE: Record<WoStatus, string> = {
  aberta: 'bg-slate-100 text-slate-700 ring-slate-300',
  em_atendimento: 'bg-blue-50 text-blue-700 ring-blue-200',
  pausada: 'bg-amber-50 text-amber-800 ring-amber-300',
  finalizada: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
};
export function WoStatusBadge({ status }: { status: WoStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', STATUS_STYLE[status])}>
      {status === 'pausada' && <Pause size={11} />}
      {status === 'aberta' ? 'Aguardando aceite' : WO_STATUS_LABELS[status]}
    </span>
  );
}

export function StoppedTag() {
  return <span className="inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-xs font-bold text-red-700 ring-1 ring-red-200 whitespace-nowrap"><AlertOctagon size={12} />MÁQUINA PARADA</span>;
}

/** One line saying where the order stands, for the requester and the team. */
export function WoSituation({ o, position, meId }: { o: WorkOrder; position?: number; meId: string }) {
  const pause = o.pauses.find((p) => !p.to);
  if (o.status === 'finalizada') {
    return <span className="text-emerald-800">Finalizada por {o.finished_by_name} em {fmtShort(o.finished_at)} · total {duration(o.times.totalMs)}</span>;
  }
  const others = o.workers.filter((w) => w.id !== meId).map((w) => w.name);
  const mine = o.workers.length > others.length;
  const who = mine ? ['Você', ...others] : others;
  const whoText = who.length > 1 ? `${who.slice(0, -1).join(', ')} e ${who.at(-1)} estão atuando` : `${who[0]} está atuando`;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {o.status === 'aberta' && <span className="text-gray-700">Aguardando aceite{position ? ` · ${position}º na fila` : ''} · há {duration(o.times.waitMs)}</span>}
      {o.status !== 'aberta' && who.length > 0 && (
        <span className="inline-flex items-center gap-1 font-medium text-blue-800"><Wrench size={14} />{whoText}</span>
      )}
      {pause && <span className="font-medium text-amber-800">Pausada: {pause.reason}</span>}
      {o.suggested_name && o.status === 'aberta' && <span className="text-indigo-700">Indicada para {o.suggested_to === meId ? 'você' : o.suggested_name}</span>}
    </span>
  );
}

export function WoHeadline({ o }: { o: WorkOrder }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {o.pinned && <Pin size={14} className="text-brand-700" aria-label="Fixada no topo" />}
      <span className="font-mono text-xs text-gray-500">{o.code}</span>
      <WoPriorityBadge priority={o.priority} />
      <WoStatusBadge status={o.status} />
      {o.machine_stopped && o.status !== 'finalizada' && <StoppedTag />}
    </span>
  );
}

export function WoWhere({ o }: { o: WorkOrder }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-sm text-gray-600">
      <span className="font-semibold text-gray-900">{o.asset_ref}</span>
      <span>· {WO_KIND_LABELS[o.kind]}</span>
      <span className="inline-flex items-center gap-1">· <AreaDot color={o.area_color} />{o.area_name}</span>
    </span>
  );
}
