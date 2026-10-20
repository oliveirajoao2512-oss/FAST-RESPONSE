import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightLeft, Ban, CalendarClock, CheckCircle2, ChevronDown, ChevronUp, CircleSlash, FileText, History, Link2, ListChecks, Lock,
  MessageSquare, Play, Plus, RotateCcw, ShieldAlert, ThumbsUp, UserCheck, UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { COMPLEXITY_LABELS, SOURCE_LABELS, STATUS_LABELS, STEP_STATUS_LABELS, ASSET_TYPE_LABELS, type Status } from '@shared/constants';
import { errorMessage, get, patch, post } from '../lib/api';
import { age, fmtDateTime, fromLocalInput } from '../lib/format';
import { useMeta } from '../lib/meta';
import { useMe } from '../lib/session';
import { useToast } from '../lib/toast';
import {
  AssignModal, AttachButton, BlockModal, CancelModal, CompleteModal, DeadlineModal, ReopenModal, TransferModal, UserSelect, ValidateModal,
} from './actions';
import { AreaDot, Button, cx, DueLabel, ErrorBox, Field, Input, Modal, OverdueBadge, PriorityBadge, Progress, Select, Spinner, StatusBadge, Textarea } from './ui';

/** Detail overlay driven by the ?p=<id> search param, so any page can open an issue. */
export function IssueOverlay() {
  const [params, setParams] = useSearchParams();
  const id = params.get('p');
  if (!id) return null;
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('p');
    setParams(next);
  };
  return (
    <Modal open wide onClose={close} title="Pendência">
      <IssueDetail id={id} />
    </Modal>
  );
}

type ModalKind = 'complete' | 'block' | 'cancel' | 'assign' | 'transfer' | 'deadline' | 'validate' | 'reopen' | null;

export function IssueDetail({ id }: { id: string }) {
  const me = useMe();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['issue', id], queryFn: () => get(`/api/issues/${id}`) });
  const [modal, setModal] = useState<ModalKind>(null);
  const [stepDeadline, setStepDeadline] = useState<any>(null);
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  const [editNext, setEditNext] = useState<string | null>(null);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const i = q.data;
  const p = i.permissions;
  const status: Status = i.status;
  const active = ['aberta', 'aguardando_responsavel', 'planejada', 'em_andamento', 'bloqueada'].includes(status);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast('ok', ok);
    } catch (e) {
      toast('error', errorMessage(e));
    }
    qc.invalidateQueries();
  };

  const actions: React.ReactElement[] = [];
  if (p.selfAssign && !i.assignee_id && active) actions.push(<Button key="take" kind="primary" onClick={() => act(() => post(`/api/issues/${id}/assign`, { version: i.version, assigneeId: me.id }), 'Você assumiu a pendência')}><UserCheck size={16} />Assumir</Button>);
  if (p.changeStatus && ['aberta', 'planejada'].includes(status) && i.assignee_id) actions.push(<Button key="start" kind="primary" onClick={() => act(() => post(`/api/issues/${id}/status`, { version: i.version, status: 'em_andamento' }), 'Execução iniciada')}><Play size={16} />Iniciar</Button>);
  if (p.changeStatus && status === 'aberta') actions.push(<Button key="plan" onClick={() => act(() => post(`/api/issues/${id}/status`, { version: i.version, status: 'planejada' }), 'Marcada como planejada')}>Planejada</Button>);
  if (p.complete && ['aberta', 'planejada', 'em_andamento'].includes(status)) actions.push(<Button key="complete" kind="success" onClick={() => setModal('complete')}><CheckCircle2 size={16} />Concluir</Button>);
  if (p.validate && status === 'aguardando_validacao') actions.push(<Button key="validate" kind="success" onClick={() => setModal('validate')}><ThumbsUp size={16} />Validar</Button>);
  if (p.block && ['aberta', 'aguardando_responsavel', 'planejada', 'em_andamento', 'bloqueada'].includes(status)) actions.push(<Button key="block" onClick={() => setModal('block')}><Ban size={16} />Impedimento</Button>);
  if (p.assign && active) actions.push(<Button key="assign" onClick={() => setModal('assign')}><UserPlus size={16} />Responsável</Button>);
  if (p.transfer && active) actions.push(<Button key="transfer" onClick={() => setModal('transfer')}><ArrowRightLeft size={16} />Transferir</Button>);
  if ((p.changeDeadline || p.requestDeadline) && active) actions.push(<Button key="deadline" onClick={() => setModal('deadline')}><CalendarClock size={16} />{p.changeDeadline ? 'Prazo' : 'Solicitar prazo'}</Button>);
  if (p.reopen && status === 'concluida') actions.push(<Button key="reopen" kind="danger" onClick={() => setModal('reopen')}><RotateCcw size={16} />Reabrir</Button>);
  if (p.cancel && !['concluida', 'cancelada'].includes(status)) actions.push(<Button key="cancel" kind="ghost" onClick={() => setModal('cancel')}><CircleSlash size={16} />Cancelar</Button>);

  const openImpediments = i.impediments.filter((x: any) => !x.resolved_at);
  const pendingDeadlines = i.deadline_changes.filter((d: any) => d.status === 'pendente');

  return (
    <div className="space-y-5">
      {/* header */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-gray-500">{i.code}</span>
          <StatusBadge status={status} />
          <PriorityBadge priority={i.priority} safety={i.is_safety_critical} />
          {i.is_overdue && <OverdueBadge />}
          <span className="text-xs text-gray-500">{SOURCE_LABELS[i.source as keyof typeof SOURCE_LABELS]}</span>
        </div>
        <h3 className="mt-1 text-xl font-semibold text-gray-900">{i.title}</h3>
        {i.is_safety_critical && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white"><ShieldAlert size={18} />Segurança crítica — tratamento imediato</div>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-gray-50 p-4 text-sm sm:grid-cols-4">
        <Info label="Área responsável"><span className="inline-flex items-center gap-1.5"><AreaDot color={i.area_color} />{i.area_name}</span></Info>
        <Info label="Área de origem">{i.origin_area_name}</Info>
        <Info label="Responsável">{i.assignee_name ?? <span className="font-medium text-amber-700">Sem responsável</span>}</Info>
        <Info label="Aberta por">{i.opened_by_name}</Info>
        <Info label="Abertura">{fmtDateTime(i.opened_at)}<div className="text-xs text-gray-500">há {age(i.opened_at)}</div></Info>
        <Info label="Prazo">
          {fmtDateTime(i.due_at)}
          <div><DueLabel due={i.due_at} overdue={i.is_overdue} closed={!active} /></div>
          {new Date(i.original_due_at).getTime() !== new Date(i.due_at).getTime() && <div className="text-xs text-gray-500">original: {fmtDateTime(i.original_due_at)}</div>}
        </Info>
        <Info label="Categoria">{i.category_name ?? '—'}</Info>
        <Info label="Referência">{i.asset_ref ? `${ASSET_TYPE_LABELS[i.asset_type as keyof typeof ASSET_TYPE_LABELS] ?? ''} ${i.asset_ref}` : '—'}</Info>
        <Info label="Complexidade">
          <span>{COMPLEXITY_LABELS[i.complexity as keyof typeof COMPLEXITY_LABELS]}</span>
          <span className="block text-xs text-gray-500">{i.complexity_approved_by ? 'classificação aprovada' : 'automática (etapas)'}</span>
          {p.setComplexity && <ComplexityEdit id={id} value={i.complexity_approved_by ? i.complexity : ''} />}
        </Info>
        {i.recurrence_of_id && <Info label="Reincidência de"><a className="text-brand-700 underline" href={`?p=${i.recurrence_of_id}`}>{i.recurrence_of_code}</a></Info>}
        {i.reopen_count > 0 && <Info label="Reaberturas"><span className="font-semibold text-red-700">{i.reopen_count}</span></Info>}
      </dl>

      {actions.length > 0 && <div className="flex flex-wrap gap-2">{actions}</div>}

      {pendingDeadlines.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          {pendingDeadlines.map((d: any) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2">
              <CalendarClock size={16} className="text-amber-700" />
              <span className="flex-1">
                <strong>{d.requested_by_name}</strong> solicitou prazo {d.step_title ? `da etapa "${d.step_title}" ` : ''}para <strong>{fmtDateTime(d.new_due_at)}</strong>: {d.reason}
              </span>
              {p.approveDeadline && d.requested_by !== me.id && (
                <>
                  <Button size="sm" kind="success" onClick={() => act(() => post(`/api/deadline-changes/${d.id}/decide`, { approve: true }), 'Prazo aprovado')}>Aprovar</Button>
                  <Button size="sm" kind="danger" onClick={() => {
                    const note = prompt('Motivo da rejeição:');
                    if (note !== null) act(() => post(`/api/deadline-changes/${d.id}/decide`, { approve: false, note }), 'Solicitação rejeitada');
                  }}>Rejeitar</Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {openImpediments.length > 0 && (
        <div className="space-y-2">
          {openImpediments.map((imp: any) => (
            <div key={imp.id} className="flex flex-wrap items-start gap-2 rounded-lg border border-fuchsia-300 bg-fuchsia-50 p-3 text-sm">
              <Ban size={16} className="mt-0.5 text-fuchsia-700" />
              <div className="flex-1">
                <div className="font-medium text-fuchsia-900">{imp.description}</div>
                <div className="text-xs text-fuchsia-800">
                  {imp.blocking_area_name && <>Depende de <strong>{imp.blocking_area_name}</strong> · </>}
                  registrado por {imp.created_by_name} em {fmtDateTime(imp.created_at)}
                </div>
              </div>
              {p.block && <Button size="sm" onClick={() => {
                const r = prompt('Como o impedimento foi resolvido?');
                if (r) act(() => post(`/api/impediments/${imp.id}/resolve`, { resolution: r }), 'Impedimento resolvido');
              }}>Resolver</Button>}
            </div>
          ))}
        </div>
      )}

      {/* next action */}
      <div className="rounded-xl border border-brand-200 bg-brand-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-brand-800">Próxima ação</span>
          {p.edit && active && editNext === null && <Button size="sm" kind="ghost" onClick={() => setEditNext(i.next_action ?? '')}>Editar</Button>}
        </div>
        {editNext === null ? (
          <p className="mt-1 text-sm text-gray-900">{i.next_action || <span className="text-gray-500">Não definida</span>}</p>
        ) : (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input value={editNext} onChange={(e) => setEditNext(e.target.value)} maxLength={500} autoFocus />
            <Button kind="primary" onClick={() => act(() => patch(`/api/issues/${id}`, { version: i.version, nextAction: editNext }), 'Próxima ação atualizada').then(() => setEditNext(null))}>Salvar</Button>
            <Button onClick={() => setEditNext(null)}>Cancelar</Button>
          </div>
        )}
      </div>

      {(i.description || i.expected_action) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {i.description && <TextBlock label="Situação encontrada" text={i.description} />}
          {i.expected_action && <TextBlock label="Ação esperada / critério de conclusão" text={i.expected_action} />}
        </div>
      )}

      {i.solution && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Solução aplicada</div>
          <p className="mt-1 whitespace-pre-wrap">{i.solution}</p>
          <p className="mt-1 text-xs text-emerald-800">
            Concluída por {i.completed_by_name} em {fmtDateTime(i.completed_at)}
            {i.validated_at && <> · validada por {i.validated_by_name} em {fmtDateTime(i.validated_at)}</>}
          </p>
        </div>
      )}
      {i.cancel_reason && <TextBlock label="Motivo do cancelamento" text={i.cancel_reason} />}

      <StepsPanel issue={i} onStepDeadline={setStepDeadline} />

      {/* attachments */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="flex items-center gap-2 text-sm font-semibold"><FileText size={16} />Evidências e anexos ({i.attachments.length})</h4>
          <div className="flex gap-2">
            <AttachButton issueId={id} purpose="evidencia" label="Evidência" />
            <AttachButton issueId={id} purpose="anexo" label="Anexo" />
          </div>
        </div>
        {i.attachments.length > 0 && (
          <ul className="grid gap-2 sm:grid-cols-2">
            {i.attachments.map((a: any) => (
              <li key={a.id}>
                <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg border border-gray-200 p-2 text-sm hover:bg-gray-50">
                  {a.mime.startsWith('image/') ? <img src={`/api/attachments/${a.id}`} alt="" className="h-12 w-12 rounded object-cover" loading="lazy" /> : <FileText size={28} className="text-gray-400" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.filename}</span>
                    <span className="text-xs text-gray-500">{a.purpose === 'anexo' ? 'Anexo' : 'Evidência'} · {a.uploaded_by_name} · {fmtDateTime(a.created_at)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* comments & history */}
      <section>
        <div className="mb-2 flex gap-1 border-b">
          <TabBtn on={tab === 'comments'} onClick={() => setTab('comments')}><MessageSquare size={14} />Comentários ({i.comments.length})</TabBtn>
          <TabBtn on={tab === 'history'} onClick={() => setTab('history')}><History size={14} />Histórico ({i.timeline.length})</TabBtn>
        </div>
        {tab === 'comments' ? <Comments issue={i} /> : <Timeline issue={i} />}
      </section>

      {modal === 'complete' && <CompleteModal issue={i} onClose={() => setModal(null)} />}
      {modal === 'block' && <BlockModal issue={i} steps={i.steps.filter((s: any) => !['concluida', 'cancelada'].includes(s.status))} onClose={() => setModal(null)} />}
      {modal === 'cancel' && <CancelModal issue={i} onClose={() => setModal(null)} />}
      {modal === 'assign' && <AssignModal issue={i} onClose={() => setModal(null)} />}
      {modal === 'transfer' && <TransferModal issue={i} onClose={() => setModal(null)} />}
      {modal === 'deadline' && <DeadlineModal issue={i} direct={p.changeDeadline} onClose={() => setModal(null)} />}
      {modal === 'validate' && <ValidateModal issue={i} onClose={() => setModal(null)} />}
      {modal === 'reopen' && <ReopenModal issue={i} onClose={() => setModal(null)} />}
      {stepDeadline && <DeadlineModal issue={i} direct={p.changeDeadline} step={stepDeadline} onClose={() => setStepDeadline(null)} />}
      {meta === undefined && null}
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-900">{children}</dd>
    </div>
  );
}

function TextBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-xl border border-gray-200 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{text}</p>
    </div>
  );
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cx('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm', on ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-gray-600 hover:text-gray-900')}>{children}</button>;
}

function ComplexityEdit({ id, value }: { id: string; value: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <select aria-label="Classificar complexidade" className="mt-1 block rounded border border-gray-300 bg-white px-1 py-0.5 text-xs" value={value}
      onChange={async (e) => {
        try {
          await post(`/api/issues/${id}/complexity`, { complexity: e.target.value || null });
          toast('ok', 'Complexidade atualizada');
        } catch (err) {
          toast('error', errorMessage(err));
        }
        qc.invalidateQueries();
      }}>
      <option value="">Automática</option>
      <option value="simples">Simples (aprovada)</option>
      <option value="moderada">Moderada (aprovada)</option>
      <option value="complexa">Complexa (aprovada)</option>
    </select>
  );
}

function StepsPanel({ issue, onStepDeadline }: { issue: any; onStepDeadline: (s: any) => void }) {
  const me = useMe();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [mandatory, setMandatory] = useState(true);
  const [dep, setDep] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const manage = issue.permissions.manageSteps;
  const closed = ['concluida', 'cancelada', 'aguardando_validacao'].includes(issue.status);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast('ok', ok);
    } catch (e) {
      toast('error', errorMessage(e));
    }
    qc.invalidateQueries();
  };
  const add = async () => {
    setBusy(true);
    await run(() => post(`/api/issues/${issue.id}/steps`, { steps: [{ title, assigneeId: assignee || null, dueAt: due ? fromLocalInput(due) : null, mandatory, dependsOn: dep ? [dep] : [] }] }), 'Etapa adicionada');
    setBusy(false);
    setTitle('');
    setDue('');
    setDep('');
  };
  const applyTemplate = (name: string) => {
    const t = meta?.stepTemplates.find((x) => x.name === name);
    if (!t) return;
    run(() => post(`/api/issues/${issue.id}/steps`, { steps: t.steps.map((s) => ({ title: s, assigneeId: issue.assignee_id })) }), `Modelo "${name}" aplicado`);
  };
  const byId = Object.fromEntries(issue.steps.map((s: any) => [s.id, s]));
  if (!issue.steps.length && (!manage || closed)) return null;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold"><ListChecks size={16} />Etapas {issue.steps.length > 0 && <span className="tabular text-gray-500">({issue.progress}%)</span>}</h4>
        {manage && !closed && (
          <div className="flex gap-2">
            {(meta?.stepTemplates.length ?? 0) > 0 && (
              <select className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm" value="" onChange={(e) => applyTemplate(e.target.value)} aria-label="Aplicar modelo de etapas">
                <option value="">Aplicar modelo…</option>
                {meta?.stepTemplates.map((t) => <option key={t.name}>{t.name}</option>)}
              </select>
            )}
            <Button size="sm" onClick={() => setAdding((v) => !v)}><Plus size={14} />Etapa</Button>
          </div>
        )}
      </div>
      {issue.steps.length > 0 && <Progress value={issue.progress} className="mb-3" />}
      <ol className="space-y-2">
        {issue.steps.map((s: any, idx: number) => {
          const canStatus = (manage || s.assignee_id === me.id) && !closed && s.status !== 'bloqueada';
          const deps = (s.depends_on as string[]).map((d) => byId[d]).filter(Boolean);
          const waiting = deps.some((d: any) => !['concluida', 'cancelada'].includes(d.status));
          return (
            <li key={s.id} className={cx('rounded-lg border p-3', s.status === 'concluida' ? 'border-emerald-200 bg-emerald-50/50' : s.is_overdue ? 'border-red-300 bg-red-50/50' : 'border-gray-200')}>
              <div className="flex flex-wrap items-start gap-2">
                <span className="mt-0.5 w-5 text-right text-sm tabular text-gray-400">{idx + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className={cx('text-sm font-medium', s.status === 'concluida' && 'text-gray-500 line-through', s.status === 'cancelada' && 'text-gray-400 line-through')}>
                    {s.title} {!s.mandatory && <span className="text-xs font-normal text-gray-500">(opcional)</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-gray-600">
                    <span>{s.assignee_name ?? 'sem responsável'}</span>
                    {s.due_at && <span className={cx(s.is_overdue && 'font-semibold text-red-700')}>prazo {fmtDateTime(s.due_at)}{s.original_due_at && new Date(s.original_due_at).getTime() !== new Date(s.due_at).getTime() && ` (orig. ${fmtDateTime(s.original_due_at)})`}</span>}
                    {s.completed_at && <span>concluída por {s.completed_by_name} em {fmtDateTime(s.completed_at)}</span>}
                    {deps.length > 0 && <span className={cx('inline-flex items-center gap-1', waiting && 'text-amber-700')}><Link2 size={11} />depende de {deps.map((d: any) => d.title).join(', ')}</span>}
                  </div>
                </div>
                {canStatus ? (
                  <select aria-label={`Status da etapa ${s.title}`} value={s.status}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                    onChange={(e) => run(() => patch(`/api/steps/${s.id}`, { version: s.version, status: e.target.value }))}>
                    {['pendente', 'em_andamento', 'concluida', ...(manage ? ['cancelada'] : [])].map((st) => <option key={st} value={st}>{STEP_STATUS_LABELS[st as keyof typeof STEP_STATUS_LABELS]}</option>)}
                  </select>
                ) : (
                  <span className={cx('rounded-full px-2 py-0.5 text-xs', s.status === 'bloqueada' ? 'bg-fuchsia-100 text-fuchsia-800' : 'bg-gray-100 text-gray-700')}>
                    {s.status === 'bloqueada' && <Lock size={10} className="mr-1 inline" />}{STEP_STATUS_LABELS[s.status as keyof typeof STEP_STATUS_LABELS]}
                  </span>
                )}
                <button className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Detalhes da etapa" onClick={() => setOpen(open === s.id ? null : s.id)}>
                  {open === s.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
              </div>
              {open === s.id && (
                <StepDetails issue={issue} step={s} manage={manage && !closed} onDeadline={() => onStepDeadline(s)} run={run} />
              )}
            </li>
          );
        })}
      </ol>
      {adding && (
        <div className="mt-3 grid gap-2 rounded-lg border border-dashed border-gray-300 p-3 sm:grid-cols-2">
          <Field label="Título da etapa" required className="sm:col-span-2"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
          <Field label="Responsável"><UserSelect value={assignee} onChange={setAssignee} areaId={issue.area_id} allowEmpty="—" /></Field>
          <Field label="Prazo da etapa"><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label="Depende de">
            <Select value={dep} onChange={(e) => setDep(e.target.value)}>
              <option value="">Nenhuma</option>
              {issue.steps.map((s: any) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />Obrigatória para encerrar</label>
          <div className="flex gap-2 sm:col-span-2">
            <Button kind="primary" loading={busy} disabled={!title.trim()} onClick={add}>Adicionar etapa</Button>
            <Button onClick={() => setAdding(false)}>Fechar</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function StepDetails({ issue, step, manage, onDeadline, run }: { issue: any; step: any; manage: boolean; onDeadline: () => void; run: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [comment, setComment] = useState('');
  const [assignee, setAssignee] = useState(step.assignee_id ?? '');
  const [due, setDue] = useState('');
  const comments = issue.comments.filter((c: any) => c.step_id === step.id);
  const files = issue.attachments.filter((a: any) => a.step_id === step.id);
  const history = issue.timeline.filter((e: any) => e.entity_type === 'step' && (e.data?.etapa === step.title || e.data?.titulo === step.title));
  return (
    <div className="mt-3 space-y-3 border-t pt-3 text-sm">
      {manage && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Responsável" className="min-w-48 flex-1"><UserSelect value={assignee} onChange={setAssignee} areaId={issue.area_id} allowEmpty="—" /></Field>
          <Button onClick={() => run(() => patch(`/api/steps/${step.id}`, { version: step.version, assigneeId: assignee || null }), 'Responsável da etapa atualizado')}>Salvar</Button>
          {step.due_at ? (
            <Button onClick={onDeadline}><CalendarClock size={14} />Alterar prazo</Button>
          ) : (
            <>
              <Field label="Definir prazo"><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
              <Button disabled={!due} onClick={() => run(() => patch(`/api/steps/${step.id}`, { version: step.version, dueAt: fromLocalInput(due) }), 'Prazo da etapa definido')}>Definir</Button>
            </>
          )}
        </div>
      )}
      {comments.map((c: any) => (
        <div key={c.id} className="rounded bg-gray-50 px-2 py-1"><strong>{c.author_name}</strong> <span className="text-xs text-gray-500">{fmtDateTime(c.created_at)}</span><p className="whitespace-pre-wrap">{c.body}</p></div>
      ))}
      <div className="flex gap-2">
        <Input placeholder="Comentário na etapa" value={comment} onChange={(e) => setComment(e.target.value)} />
        <Button disabled={!comment.trim()} onClick={() => run(() => post(`/api/issues/${issue.id}/comments`, { body: comment, stepId: step.id }), 'Comentário registrado').then(() => setComment(''))}>Enviar</Button>
        <AttachButton issueId={issue.id} stepId={step.id} purpose="evidencia" label="Evidência" />
      </div>
      {files.length > 0 && <ul className="text-xs">{files.map((f: any) => <li key={f.id}><a className="text-brand-700 underline" href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer">{f.filename}</a></li>)}</ul>}
      {history.length > 0 && (
        <ul className="space-y-0.5 text-xs text-gray-500">{history.map((h: any) => <li key={h.id}>{fmtDateTime(h.at)} · {h.actor_name ?? 'Sistema'} · {describe(h)}</li>)}</ul>
      )}
      {step.due_at && <p className="text-xs text-gray-400">Prazo da etapa é independente do prazo da pendência ({fmtDateTime(issue.due_at)}).</p>}
    </div>
  );
}

function Comments({ issue }: { issue: any }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const list = issue.comments.filter((c: any) => !c.step_id);
  return (
    <div className="space-y-3">
      {list.map((c: any) => (
        <div key={c.id} className={cx('rounded-lg p-3 text-sm', c.kind === 'decisao_reuniao' ? 'border border-brand-200 bg-brand-50' : 'bg-gray-50')}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <strong className="text-gray-800">{c.author_name}</strong>{fmtDateTime(c.created_at)}
            {c.kind === 'decisao_reuniao' && <span className="rounded bg-brand-600 px-1.5 text-white">Fast Response</span>}
          </div>
          <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
        </div>
      ))}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Textarea rows={2} placeholder="Escreva uma atualização…" value={text} onChange={(e) => setText(e.target.value)} />
        <Button kind="primary" loading={busy} disabled={!text.trim()} onClick={async () => {
          setBusy(true);
          try {
            await post(`/api/issues/${issue.id}/comments`, { body: text });
            setText('');
            qc.invalidateQueries({ queryKey: ['issue', issue.id] });
          } catch (e) {
            toast('error', errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}>Comentar</Button>
      </div>
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'issue.create': 'abriu a pendência', 'issue.update': 'editou', 'issue.assign': 'alterou o responsável', 'issue.transfer': 'transferiu',
  'issue.status': 'alterou o status', 'issue.complete': 'registrou a conclusão', 'issue.validate': 'validou', 'issue.reopen': 'reabriu',
  'issue.cancel': 'cancelou', 'issue.overdue': 'pendência ficou ATRASADA', 'issue.escalate': 'escalonada aos gestores', 'issue.complexity': 'classificou a complexidade',
  'impediment.create': 'registrou impedimento', 'impediment.resolve': 'resolveu impedimento', 'deadline.change': 'alterou o prazo',
  'deadline.request': 'solicitou alteração de prazo', 'deadline.approve': 'aprovou alteração de prazo', 'deadline.reject': 'rejeitou alteração de prazo',
  'step.create': 'criou etapa', 'step.update': 'atualizou etapa', 'comment.create': 'comentou', 'attachment.upload': 'anexou arquivo', 'meeting.decision': 'registrou decisão do Fast Response',
};

function describe(e: any): string {
  const d = e.data ?? {};
  const base = ACTION_LABELS[e.action] ?? e.action;
  if (e.action === 'issue.status') return `${base}: ${STATUS_LABELS[d.de as Status] ?? d.de} → ${STATUS_LABELS[d.para as Status] ?? d.para}${d.motivo ? ` (${d.motivo})` : ''}`;
  if (e.action === 'issue.transfer') return `${base}: ${d.area_de} → ${d.area_para} — ${d.motivo}`;
  if (e.action.startsWith('deadline')) return `${base}${d.novo_prazo ? `: ${fmtDateTime(d.novo_prazo)}` : ''}${d.motivo ? ` — ${d.motivo}` : ''}`;
  if (e.action === 'issue.validate') return d.aprovada ? 'validou a solução' : `rejeitou a solução: ${d.motivo}`;
  if (e.action === 'step.create') return `${base}: ${d.titulo}`;
  if (e.action === 'step.update') return `${base} "${d.etapa}"${d.status ? `: ${d.status.de} → ${d.status.para}` : ''}`;
  if (e.action === 'attachment.upload') return `${base}: ${d.arquivo}`;
  if (e.action === 'impediment.create') return `${base}: ${d.descricao}`;
  if (e.action === 'issue.complete') return `${base}${d.dentro_do_prazo === false ? ' (após o prazo)' : ''}`;
  if (e.action === 'issue.update') return `${base}: ${Object.keys(d).join(', ')}`;
  return base;
}

function Timeline({ issue }: { issue: any }) {
  return (
    <ol className="relative space-y-3 border-l border-gray-200 pl-4">
      {[...issue.timeline].reverse().map((e: any) => (
        <li key={e.id} className="text-sm">
          <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-gray-300" />
          <div className="text-xs text-gray-500">{fmtDateTime(e.at)}</div>
          <div><strong>{e.actor_name ?? 'Sistema'}</strong> {describe(e)}</div>
        </li>
      ))}
    </ol>
  );
}
