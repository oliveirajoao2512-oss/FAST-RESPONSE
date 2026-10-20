import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Ban, Repeat, ShieldAlert, User, UserX } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CLOSED_STATUSES, STATUS_LABELS, type Status } from '@shared/constants';
import { canSimpleTransition } from '@shared/workflow';
import { errorMessage, post } from '../lib/api';
import { age, fmtShort } from '../lib/format';
import { useToast } from '../lib/toast';
import { BlockModal, CancelModal, CompleteModal } from './actions';
import { AreaDot, cx, DueLabel, Empty, OverdueBadge, PriorityBadge, Progress, STATUS_DOT, StatusBadge } from './ui';

export interface IssueItem {
  id: string;
  code: string;
  title: string;
  status: Status;
  priority: any;
  area_id: number;
  origin_area_id: number;
  area_name: string;
  area_color: string;
  origin_area_name?: string;
  assignee_id: string | null;
  assignee_name: string | null;
  opened_at: string;
  due_at: string;
  original_due_at?: string;
  is_overdue: boolean;
  is_safety_critical: boolean;
  next_action: string | null;
  steps_total?: number;
  steps_done?: number;
  blocker?: string | null;
  recurrence_of_id?: string | null;
  version: number;
  asset_ref?: string | null;
  category_name?: string | null;
  pending_deadline_requests?: number;
}

/** Opens the issue detail overlay (?p=<id>) from anywhere, keeping the current page. */
export function useOpenIssue() {
  const [params, setParams] = useSearchParams();
  return (id: string) => {
    const next = new URLSearchParams(params);
    next.set('p', id);
    setParams(next);
  };
}

export function IssueCard({ issue, onOpen, draggable, showArea = true }: { issue: IssueItem; onOpen: () => void; draggable?: boolean; showArea?: boolean }) {
  const closed = CLOSED_STATUSES.includes(issue.status);
  const progress = issue.steps_total ? Math.round(((issue.steps_done ?? 0) / issue.steps_total) * 100) : null;
  return (
    <button
      onClick={onOpen}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/issue', issue.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className={cx(
        'block w-full rounded-lg border bg-white p-3 text-left shadow-sm hover:border-brand-400 hover:shadow',
        issue.is_overdue ? 'border-red-300 border-l-4 border-l-red-600' : issue.priority === 'critica' ? 'border-l-4 border-l-red-500 border-gray-200' : 'border-gray-200',
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-gray-500">{issue.code}</span>
        <PriorityBadge priority={issue.priority} safety={issue.is_safety_critical} />
        {issue.is_overdue && <OverdueBadge />}
        {issue.recurrence_of_id && <span title="Reincidente" className="inline-flex items-center gap-0.5 rounded bg-purple-100 px-1 text-xs text-purple-800"><Repeat size={11} />reincid.</span>}
      </div>
      <div className="text-sm font-medium leading-snug text-gray-900 line-clamp-2">{issue.title}</div>
      {issue.asset_ref && <div className="mt-0.5 text-xs text-gray-500">{issue.asset_ref}</div>}
      {issue.blocker && (
        <div className="mt-1.5 flex items-start gap-1 rounded bg-fuchsia-50 px-2 py-1 text-xs text-fuchsia-800"><Ban size={12} className="mt-0.5 shrink-0" />{issue.blocker}</div>
      )}
      {issue.next_action && !issue.blocker && <div className="mt-1.5 text-xs text-gray-700"><span className="font-medium">Próxima ação:</span> {issue.next_action}</div>}
      {progress !== null && (
        <div className="mt-2 flex items-center gap-2">
          <Progress value={progress} />
          <span className="text-xs tabular text-gray-500">{issue.steps_done}/{issue.steps_total}</span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className={cx('inline-flex items-center gap-1 text-xs', issue.assignee_name ? 'text-gray-700' : 'font-medium text-amber-700')}>
          {issue.assignee_name ? <User size={12} /> : <UserX size={12} />}
          {issue.assignee_name ?? 'Sem responsável'}
        </span>
        <DueLabel due={issue.due_at} overdue={issue.is_overdue} closed={closed || issue.status === 'aguardando_validacao'} />
      </div>
      {showArea && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
          <AreaDot color={issue.area_color} /> {issue.area_name}
          {issue.origin_area_id !== issue.area_id && issue.origin_area_name && (
            <span className="inline-flex items-center gap-0.5" title="Transferida"><ArrowRightLeft size={11} /> origem {issue.origin_area_name}</span>
          )}
        </div>
      )}
    </button>
  );
}

const KANBAN: Status[] = ['aguardando_responsavel', 'aberta', 'planejada', 'em_andamento', 'bloqueada', 'aguardando_validacao', 'concluida', 'cancelada'];

export function Kanban({ items, showArea = true, hideClosed }: { items: IssueItem[]; showArea?: boolean; hideClosed?: boolean }) {
  const open = useOpenIssue();
  const qc = useQueryClient();
  const toast = useToast();
  const [over, setOver] = useState<Status | null>(null);
  const [modal, setModal] = useState<{ kind: 'complete' | 'block' | 'cancel'; issue: IssueItem } | null>(null);
  const columns = hideClosed ? KANBAN.filter((s) => s !== 'cancelada') : KANBAN;

  const drop = async (e: DragEvent, to: Status) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/issue');
    const issue = items.find((i) => i.id === id);
    if (!issue || issue.status === to) return;
    if (to === 'bloqueada') return setModal({ kind: 'block', issue });
    if (to === 'aguardando_validacao' || to === 'concluida') return setModal({ kind: 'complete', issue });
    if (to === 'cancelada') return setModal({ kind: 'cancel', issue });
    if (!canSimpleTransition(issue.status, to)) {
      toast('error', `Não é possível mover de "${STATUS_LABELS[issue.status]}" para "${STATUS_LABELS[to]}". Abra a pendência para ver as ações disponíveis.`);
      return;
    }
    try {
      await post(`/api/issues/${id}/status`, { version: issue.version, status: to });
      toast('ok', `${issue.code} movida para ${STATUS_LABELS[to]}`);
    } catch (err) {
      toast('error', errorMessage(err));
    }
    qc.invalidateQueries();
  };

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-3 snap-x">
        {columns.map((s) => {
          const col = items.filter((i) => i.status === s);
          return (
            <div key={s}
              onDragOver={(e) => { e.preventDefault(); setOver(s); }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => drop(e, s)}
              className={cx('flex w-72 shrink-0 snap-start flex-col rounded-xl bg-gray-100 p-2', over === s && 'ring-2 ring-brand-400')}>
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="flex items-center gap-2 text-sm font-semibold text-gray-700"><span className={cx('h-2 w-2 rounded-full', STATUS_DOT[s])} />{STATUS_LABELS[s]}</span>
                <span className="rounded-full bg-white px-2 text-xs tabular text-gray-600">{col.length}</span>
              </div>
              <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
                {col.map((i) => <IssueCard key={i.id} issue={i} onOpen={() => open(i.id)} draggable showArea={showArea} />)}
                {!col.length && <div className="px-2 py-4 text-center text-xs text-gray-400">—</div>}
              </div>
            </div>
          );
        })}
      </div>
      {modal?.kind === 'complete' && <CompleteModal issue={modal.issue as any} onClose={() => setModal(null)} />}
      {modal?.kind === 'block' && <BlockModal issue={modal.issue as any} onClose={() => setModal(null)} />}
      {modal?.kind === 'cancel' && <CancelModal issue={modal.issue as any} onClose={() => setModal(null)} />}
    </>
  );
}

export function IssueTable({ items, showArea = true }: { items: IssueItem[]; showArea?: boolean }) {
  const open = useOpenIssue();
  if (!items.length) return <Empty>Nenhuma pendência encontrada com estes filtros.</Empty>;
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      {/* desktop */}
      <table className="hidden w-full text-sm md:table">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2">Pendência</th>
            {showArea && <th className="px-3 py-2">Área</th>}
            <th className="px-3 py-2">Responsável</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Prazo</th>
            <th className="px-3 py-2">Idade</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((i) => (
            <tr key={i.id} onClick={() => open(i.id)} className={cx('cursor-pointer hover:bg-brand-50', i.is_overdue && 'bg-red-50/50')}>
              <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs text-gray-500">{i.code}</span>
                  <PriorityBadge priority={i.priority} safety={i.is_safety_critical} />
                  {i.is_overdue && <OverdueBadge />}
                  {i.recurrence_of_id && <Repeat size={13} className="text-purple-700" aria-label="Reincidente" />}
                </div>
                <button className="mt-0.5 text-left font-medium text-gray-900 hover:underline">{i.title}</button>
                {(i.blocker || i.next_action) && <div className="text-xs text-gray-600">{i.blocker ? `Bloqueio: ${i.blocker}` : `Próxima ação: ${i.next_action}`}</div>}
              </td>
              {showArea && <td className="px-3 py-2 whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><AreaDot color={i.area_color} />{i.area_name}</span></td>}
              <td className="px-3 py-2">{i.assignee_name ?? <span className="font-medium text-amber-700">Sem responsável</span>}</td>
              <td className="px-3 py-2"><StatusBadge status={i.status} /></td>
              <td className="px-3 py-2 whitespace-nowrap tabular">
                <div>{fmtShort(i.due_at)}</div>
                <DueLabel due={i.due_at} overdue={i.is_overdue} closed={CLOSED_STATUSES.includes(i.status) || i.status === 'aguardando_validacao'} />
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-gray-600">{age(i.opened_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* mobile */}
      <div className="flex flex-col gap-2 p-2 md:hidden">
        {items.map((i) => <IssueCard key={i.id} issue={i} onOpen={() => open(i.id)} showArea={showArea} />)}
      </div>
    </div>
  );
}

export function SafetyIcon() {
  return <ShieldAlert size={14} className="text-red-600" />;
}
