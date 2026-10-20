import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, Ban, Clock, Gavel, Hourglass, Play, Repeat, ShieldAlert, Square, UserX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { FormError, UserSelect } from '../components/actions';
import { useOpenIssue } from '../components/issues';
import { NewIssueModal } from '../components/NewIssueModal';
import { AreaDot, Button, Card, cx, DueLabel, Empty, ErrorBox, Field, Input, Modal, PriorityBadge, Select, Spinner, StatusBadge, Textarea } from '../components/ui';
import { errorMessage, get, post, qs } from '../lib/api';
import { age, fmtDateTime, fmtShort, fromLocalInput } from '../lib/format';
import { useMeta } from '../lib/meta';
import { can, useMe } from '../lib/session';
import { useToast } from '../lib/toast';

const SECTIONS: { key: string; title: string; icon: ReactNode; tone: string; empty: string }[] = [
  { key: 'critical', title: 'Críticas e segurança', icon: <ShieldAlert size={18} />, tone: 'text-red-700', empty: 'Nenhuma pendência crítica.' },
  { key: 'overdue', title: 'Atrasadas', icon: <AlertOctagon size={18} />, tone: 'text-red-700', empty: 'Nenhuma pendência atrasada.' },
  { key: 'due_today', title: 'Vencem hoje', icon: <Clock size={18} />, tone: 'text-amber-700', empty: 'Nada vence hoje.' },
  { key: 'blocked', title: 'Bloqueadas', icon: <Ban size={18} />, tone: 'text-fuchsia-700', empty: 'Nenhuma atividade bloqueada.' },
  { key: 'unassigned', title: 'Sem responsável', icon: <UserX size={18} />, tone: 'text-amber-700', empty: 'Todas têm responsável.' },
  { key: 'recurrent', title: 'Reincidentes', icon: <Repeat size={18} />, tone: 'text-purple-700', empty: 'Nenhuma reincidência aberta.' },
  { key: 'awaiting_validation', title: 'Aguardando validação', icon: <Hourglass size={18} />, tone: 'text-teal-700', empty: 'Nada aguardando validação.' },
];

export function FastResponsePage() {
  const me = useMe();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [areaId, setAreaId] = useState('');
  const q = useQuery({ queryKey: ['fast-response', areaId], queryFn: () => get(`/api/fast-response${qs({ areaId })}`), refetchInterval: 60_000 });
  const [decide, setDecide] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const openIssue = useOpenIssue();
  const manage = can.manageMeeting(me);

  const startMeeting = async () => {
    try {
      await post('/api/meetings');
      toast('ok', 'Reunião iniciada');
    } catch (e) {
      toast('error', errorMessage(e));
    }
    qc.invalidateQueries();
  };
  const endMeeting = async () => {
    const notes = prompt('Observações gerais da reunião (opcional):') ?? undefined;
    try {
      await post(`/api/meetings/${q.data.meeting.id}/end`, { notes: notes || null });
      toast('ok', 'Reunião encerrada');
    } catch (e) {
      toast('error', errorMessage(e));
    }
    qc.invalidateQueries();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Fast Response diário</h1>
          <p className="text-sm text-gray-500">Prioridades da reunião: segurança, atrasos, vencimentos do dia, bloqueios e pendências sem dono.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-auto" value={areaId} onChange={(e) => setAreaId(e.target.value)} aria-label="Área">
            <option value="">Todas as áreas</option>
            {meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Button onClick={() => setCreating(true)}>Novo problema</Button>
          {manage && (q.data?.meeting
            ? <Button kind="danger" onClick={endMeeting}><Square size={16} />Encerrar reunião</Button>
            : <Button kind="primary" onClick={startMeeting}><Play size={16} />Iniciar reunião</Button>)}
        </div>
      </div>

      {q.data?.meeting && (
        <div className="rounded-xl border border-brand-300 bg-brand-50 px-4 py-3 text-sm">
          <strong>Reunião em andamento</strong> desde {fmtShort(q.data.meeting.started_at)} (conduzida por {q.data.meeting.started_by_name}).
          {' '}Use <Gavel size={14} className="inline" /> <strong>Decisão</strong> em cada pendência para registrar encaminhamentos sem criar tarefas duplicadas.
        </div>
      )}

      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            {SECTIONS.map((s) => {
              const rows = q.data.sections[s.key] as any[];
              return (
                <Card key={s.key} title={<span className={cx('flex items-center gap-2', s.tone)}>{s.icon}{s.title} <span className="rounded-full bg-gray-100 px-2 text-xs text-gray-700">{rows.length}</span></span>}>
                  {rows.length === 0 ? <p className="text-sm text-gray-500">{s.empty}</p> : (
                    <ul className="divide-y">
                      {rows.map((r) => <Row key={r.id} r={r} meeting={q.data.meeting} onOpen={() => openIssue(r.id)} onDecide={() => setDecide(r)} />)}
                    </ul>
                  )}
                </Card>
              );
            })}
          </div>
          <div className="space-y-4">
            {q.data.meeting && (
              <Card title={`Decisões desta reunião (${q.data.decisions.length})`}>
                {q.data.decisions.length === 0 ? <p className="text-sm text-gray-500">Nenhuma decisão registrada ainda.</p> : (
                  <ul className="space-y-2 text-sm">
                    {q.data.decisions.map((d: any) => (
                      <li key={d.id} className="rounded-lg bg-gray-50 p-2">
                        <button className="font-mono text-xs text-brand-700 hover:underline" onClick={() => openIssue(d.issue_id)}>{d.code}</button>
                        <div>{d.decision}</div>
                        <div className="text-xs text-gray-500">{d.owner_name && `Responsável: ${d.owner_name} · `}{d.due_at && `Prazo: ${fmtShort(d.due_at)}`}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
            <Card title="Atualizações desde a última reunião">
              <p className="mb-2 text-xs text-gray-500">Desde {fmtDateTime(q.data.updatesSince)}</p>
              {q.data.updates.length === 0 ? <Empty>Sem atualizações.</Empty> : (
                <ul className="max-h-[70vh] space-y-2 overflow-y-auto text-sm">
                  {q.data.updates.map((u: any) => (
                    <li key={u.id} className="border-l-2 border-gray-200 pl-2">
                      <div className="text-xs text-gray-500">{fmtShort(u.at)} · {u.area_name}</div>
                      <button className="text-left hover:underline" onClick={() => openIssue(u.issue_id)}>
                        <span className="font-mono text-xs">{u.code}</span> {u.title}
                      </button>
                      <div className="text-xs text-gray-700">{u.actor_name ?? 'Sistema'}: {UPDATE_LABELS[u.action] ?? u.action}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
      {decide && <DecisionModal issue={decide} meeting={q.data?.meeting} onClose={() => setDecide(null)} />}
      {creating && <NewIssueModal onClose={() => setCreating(false)} defaults={{ source: 'fast_response', areaId: areaId ? Number(areaId) : undefined }} />}
    </div>
  );
}

const UPDATE_LABELS: Record<string, string> = {
  'issue.create': 'abriu', 'issue.status': 'mudou status', 'issue.transfer': 'transferiu', 'issue.assign': 'definiu responsável', 'issue.complete': 'concluiu (aguarda validação)',
  'issue.validate': 'validou/rejeitou', 'issue.reopen': 'reabriu', 'issue.cancel': 'cancelou', 'impediment.create': 'registrou impedimento', 'impediment.resolve': 'resolveu impedimento',
  'deadline.change': 'alterou prazo', 'deadline.approve': 'aprovou prazo', 'deadline.request': 'pediu prazo', 'issue.overdue': 'ficou atrasada', 'meeting.decision': 'decisão de reunião',
};

function Row({ r, meeting, onOpen, onDecide }: { r: any; meeting: any; onOpen: () => void; onDecide: () => void }) {
  const me = useMe();
  return (
    <li className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-gray-500">{r.code}</span>
          <PriorityBadge priority={r.priority} safety={r.is_safety_critical} />
          <StatusBadge status={r.status} />
          <span className="inline-flex items-center gap-1 text-xs text-gray-600"><AreaDot color={r.area_color} />{r.area_name}</span>
        </div>
        <div className="font-medium text-gray-900 hover:underline">{r.title}</div>
        <div className="flex flex-wrap gap-x-3 text-xs text-gray-600">
          <span className={cx(!r.assignee_name && 'font-semibold text-amber-700')}>{r.assignee_name ?? 'Sem responsável'}</span>
          <span>idade {age(r.opened_at)}</span>
          <DueLabel due={r.due_at} overdue={r.is_overdue} closed={r.status === 'aguardando_validacao'} />
          {r.steps_total > 0 && <span>etapas {r.steps_done}/{r.steps_total}</span>}
        </div>
        {(r.blocker || r.next_action) && <div className="text-xs text-gray-800">{r.blocker ? <span className="text-fuchsia-800">Bloqueio: {r.blocker}</span> : <>Próxima ação: {r.next_action}</>}</div>}
      </button>
      {meeting && can.manageMeeting(me) && <Button size="sm" onClick={onDecide}><Gavel size={14} />Decisão</Button>}
    </li>
  );
}

function DecisionModal({ issue, meeting, onClose }: { issue: any; meeting: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [decision, setDecision] = useState('');
  const [owner, setOwner] = useState(issue.assignee_id ?? '');
  const [due, setDue] = useState('');
  const [step, setStep] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/meetings/${meeting.id}/decisions`, {
        issueId: issue.id, decision, ownerId: owner || null, dueAt: due ? fromLocalInput(due) : null, stepTitle: step || null, nextAction: next || null,
      });
      toast('ok', 'Decisão registrada na pendência');
      qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError({ msg: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Decisão da reunião — ${issue.code}`} footer={<><Button onClick={onClose}>Voltar</Button><Button kind="primary" loading={busy} onClick={submit}>Registrar decisão</Button></>}>
      <FormError error={error} />
      <p className="mb-3 text-sm text-gray-600">{issue.title}. A decisão fica no histórico desta pendência (nenhuma tarefa nova é criada).</p>
      <div className="space-y-3">
        <Field label="Decisão / encaminhamento" required><Textarea value={decision} onChange={(e) => setDecision(e.target.value)} /></Field>
        <Field label="Responsável"><UserSelect value={owner} onChange={setOwner} areaId={issue.area_id} allowEmpty="Manter" /></Field>
        <Field label="Próxima ação"><Input value={next} onChange={(e) => setNext(e.target.value)} maxLength={500} /></Field>
        <Field label="Novo prazo" hint="Opcional. Fica registrado como alteração de prazo com a decisão como justificativa."><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Adicionar etapa" hint="Opcional."><Input value={step} onChange={(e) => setStep(e.target.value)} placeholder="Ex.: Medir vibração do redutor" /></Field>
      </div>
    </Modal>
  );
}
