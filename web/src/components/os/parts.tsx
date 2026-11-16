import { AlertOctagon, CalendarClock, Pause, Pin, Wrench } from 'lucide-react';
import { placeLabel, woCategory, WO_PRIORITY_LABELS, WO_STATUS_LABELS, type WoPriority, type WoStatus } from '@shared/maintenance';
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
  em_analise: 'bg-violet-50 text-violet-800 ring-violet-300',
  programada: 'bg-indigo-50 text-indigo-800 ring-indigo-300',
  recusada: 'bg-gray-100 text-gray-600 ring-gray-300',
  aberta: 'bg-slate-100 text-slate-700 ring-slate-300',
  em_atendimento: 'bg-blue-50 text-blue-700 ring-blue-200',
  pausada: 'bg-amber-50 text-amber-800 ring-amber-300',
  finalizada: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
};
export function WoStatusBadge({ status }: { status: WoStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', STATUS_STYLE[status])}>
      {status === 'pausada' && <Pause size={11} />}
      {(status === 'em_analise' || status === 'programada') && <CalendarClock size={11} />}
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
  if (o.status === 'em_analise') {
    return <span className="text-violet-800">Aguardando análise da Logística · pedida para {fmtShort(o.requested_start)} · {o.planned_hours} h de parada</span>;
  }
  if (o.status === 'programada') {
    const due = o.planned_start && new Date(o.planned_start).getTime() <= Date.now();
    return (
      <span className={cx('flex flex-wrap items-center gap-x-2', due ? 'font-medium text-red-700' : 'text-indigo-800')}>
        <span>{due ? 'Manutenção programada: já está na hora' : 'Programada para'} {fmtShort(o.planned_start)} · {o.planned_hours} h de parada</span>
        {o.suggested_name && <span className="text-indigo-700">Indicada para {o.suggested_to === meId ? 'você' : o.suggested_name}</span>}
      </span>
    );
  }
  if (o.status === 'recusada') {
    return <span className="text-gray-700">Recusada pela Logística{o.analyzed_by_name ? ` (${o.analyzed_by_name})` : ''}: {o.analysis_note}</span>;
  }
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
      {o.imported && <span className="inline-flex items-center rounded bg-gray-200 px-1.5 py-0.5 text-xs font-semibold text-gray-700 whitespace-nowrap" title="Carregada do histórico antigo: só a data é conhecida, sem a hora">HISTÓRICO{o.legacy_number ? ` · OS ${o.legacy_number}` : ''}</span>}
      {o.scheduled && o.status !== 'em_analise' && o.status !== 'programada' && <span className="inline-flex items-center gap-1 rounded bg-indigo-600 px-1.5 py-0.5 text-xs font-bold text-white whitespace-nowrap"><CalendarClock size={12} />PROGRAMADA</span>}
    </span>
  );
}

/**
 * The device (D) or trim die (T) of the order, in the plant's own way of naming it, standing out for the maintainer.
 * When the opener did not know which, it says so.
 */
export function WoToolTag({ o, big }: { o: Pick<WorkOrder, 'component' | 'tool_code' | 'tool_description'>; big?: boolean }) {
  if (o.component !== 'dispositivo' && o.component !== 'trim_die') return null;
  const name = o.component === 'dispositivo' ? 'DISPOSITIVO' : 'TRIM DIE';
  if (!o.tool_code) {
    return <span className={cx('inline-flex items-center rounded border border-dashed border-amber-500 bg-amber-50 px-1.5 py-0.5 font-bold text-amber-800 whitespace-nowrap', big ? 'text-sm' : 'text-xs')}>{name} NÃO INFORMADO</span>;
  }
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded bg-gray-900 px-2 py-0.5 font-bold text-white whitespace-nowrap', big ? 'text-base' : 'text-xs')}
      title={o.tool_description ?? undefined}>
      <span className="font-semibold opacity-75">{name}</span><span className="font-mono tracking-wide">{o.tool_code}</span>
    </span>
  );
}

export function WoWhere({ o }: { o: WorkOrder }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-sm text-gray-600">
      {/* on a machine, the device / trim die goes in its own tag, right after the machine */}
      <span className="font-semibold text-gray-900">{o.location_type && (o.component === 'dispositivo' || o.component === 'trim_die') ? placeLabel({ ...o, component: 'maquina' }) : placeLabel(o)}</span>
      {o.location_type && <WoToolTag o={o} />}
      <span>· {woCategory(o)}</span>
      {o.part_number && <span>· PN {o.part_number}</span>}
      <span className="inline-flex items-center gap-1">· <AreaDot color={o.area_color} />{o.area_name}</span>
    </span>
  );
}
