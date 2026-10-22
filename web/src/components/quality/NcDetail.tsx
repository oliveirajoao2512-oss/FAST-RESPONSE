import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CalendarCheck, History, PauseCircle, RotateCcw, ShieldAlert, Repeat } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { STATUS_LABELS, type Status } from '@shared/constants';
import {
  evaluate, PARTNER_LABELS, PROCEDENTE, QUALITY_STEPS, type QSteps, type StepKey,
} from '@shared/quality';
import { ApiError, errorMessage, get, patch } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { dmy, STEP_STATE_LABELS, STEP_TONE, useQualityOptions, type QualityNc } from '../../lib/quality';
import { useToast } from '../../lib/toast';
import { Button, cx, ErrorBox, Field, Input, Modal, Select, Spinner, Textarea } from '../ui';
import { useOpenIssue } from '../issues';
import { OriginTag, QStatusBadge } from './parts';

type Draft = Omit<QualityNc, 'eval' | 'id' | 'version' | 'source' | 'updated_at' | 'updated_by_name'>;
const SCALARS = ['number', 'opened_on', 'kind', 'partner', 'claim_type', 'product', 'internal_code', 'customer_code', 'customer_claim', 'description',
  'primary_problem', 'safety', 'recurrent', 'leader', 'action_plan', 'due_on', 'on_hold', 'on_hold_reason', 'procedente'] as const;

const toDraft = (nc: QualityNc): Draft => {
  const { eval: _e, id: _i, version: _v, source: _s, updated_at: _u, updated_by_name: _n, ...rest } = nc;
  return structuredClone(rest);
};

/** Builds the PATCH body with only what changed. */
function changes(orig: Draft, d: Draft) {
  const body: Record<string, unknown> = {};
  for (const k of SCALARS) {
    const a = orig[k] ?? null;
    const b = typeof d[k] === 'string' && (d[k] as string).trim() === '' ? null : d[k] ?? null;
    if (a !== b) body[k] = b;
  }
  const steps: Record<string, unknown> = {};
  for (const s of QUALITY_STEPS) {
    const a = orig.steps[s.key];
    const b = d.steps[s.key];
    const p: Record<string, unknown> = {};
    if (a.plan !== b.plan) p.plan = b.plan;
    if (a.done !== b.done) p.done = b.done;
    if (a.mark !== b.mark) p.mark = b.mark;
    if (Object.keys(p).length) steps[s.key] = p;
  }
  if (Object.keys(steps).length) body.steps = steps;
  return body;
}

export function NcDetail({ id, today, onClose }: { id: number; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const opts = useQualityOptions();
  const openIssue = useOpenIssue();
  const q = useQuery({ queryKey: ['quality', 'nc', id], queryFn: () => get<{ nc: QualityNc; history: any[]; actions: { step: StepKey; decision: 'criada' | 'descartada'; issue_id: string | null; issue_code: string | null; issue_status: Status | null; area_name: string | null; assignee_name: string | null }[] }>(`/api/quality/ncs/${id}`) });
  const nc = q.data?.nc;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'etapas' | 'dados' | 'historico'>('etapas');
  const orig = useMemo(() => (nc ? toDraft(nc) : null), [nc]);
  // a refresh from another user replaces the draft only when nothing was edited here
  useEffect(() => {
    if (orig && (!draft || Object.keys(changes(orig, draft)).length === 0)) setDraft(structuredClone(orig));
  }, [orig]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = orig && draft ? changes(orig, draft) : {};
  const dirty = Object.keys(pending).length > 0;
  const live = draft ? evaluate(draft, today) : null;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setStep = (k: StepKey, v: Partial<QSteps[StepKey]>) => setDraft((d) => (d ? { ...d, steps: { ...d.steps, [k]: { ...d.steps[k], ...v } } } : d));

  const close = () => {
    if (dirty && !confirm('Descartar as alterações não salvas?')) return;
    onClose();
  };
  const save = async () => {
    if (!nc || !dirty) return;
    setSaving(true);
    try {
      await patch(`/api/quality/ncs/${nc.id}`, { version: nc.version, ...pending });
      toast('ok', `Ocorrência ${draft!.number} atualizada.`);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['quality'] });
    } catch (e) {
      toast('error', errorMessage(e));
      if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['quality'] });
    } finally {
      setSaving(false);
    }
  };

  const partnerList = draft?.origin === 'fornecedor' ? opts.data?.catalog.fornecedor : opts.data?.catalog.cliente;
  return (
    <Modal open onClose={close} wide
      title={nc ? <span className="flex flex-wrap items-center gap-2">Ocorrência {nc.number}<OriginTag origin={nc.origin} />{live && <QStatusBadge status={live.status} />}</span> : 'Ocorrência'}
      footer={draft && (
        <>
          {dirty && <span className="mr-auto self-center text-xs text-amber-700">Alterações não salvas</span>}
          <Button onClick={() => setDraft(structuredClone(orig!))} disabled={!dirty || saving}><RotateCcw size={16} />Desfazer</Button>
          <Button kind="primary" onClick={save} loading={saving} disabled={!dirty}>Salvar alterações</Button>
        </>
      )}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {nc && draft && live && (
        <div className="space-y-4">
          <div className="grid gap-2 rounded-xl bg-gray-50 p-3 text-sm sm:grid-cols-4">
            <div><div className="text-xs text-gray-500">{PARTNER_LABELS[draft.origin]}</div><div className="font-medium">{draft.partner ?? '—'}</div></div>
            <div><div className="text-xs text-gray-500">Abertura · prazo final</div><div className="font-medium tabular">{dmy(draft.opened_on)} · {dmy(draft.due_on)}</div></div>
            <div><div className="text-xs text-gray-500">Dias totais</div><div className={cx('font-medium tabular', live.daysOver > 0 && 'text-red-700')}>{live.totalDays}{live.daysOver > 0 && ` (${live.daysOver} acima do prazo)`}</div></div>
            <div><div className="text-xs text-gray-500">Fechado no prazo?</div><div className="font-medium">{live.closedOnTime}</div></div>
            <div className="sm:col-span-4"><div className="text-xs text-gray-500">Problema</div><div>{draft.description ?? '—'}{draft.primary_problem && <span className="text-gray-500"> · {draft.primary_problem}</span>}</div></div>
            {(draft.safety || draft.recurrent) && (
              <div className="flex gap-3 sm:col-span-4 text-xs font-medium">
                {draft.safety && <span className="inline-flex items-center gap-1 text-red-700"><ShieldAlert size={14} />Segurança / regulatório</span>}
                {draft.recurrent && <span className="inline-flex items-center gap-1 text-purple-700"><Repeat size={14} />Reincidente</span>}
              </div>
            )}
          </div>

          <div className="flex gap-1 border-b" role="tablist">
            {([['etapas', 'Etapas'], ['dados', 'Dados da ocorrência'], ['historico', 'Histórico']] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} data-autofocus={tab === k ? '' : undefined} onClick={() => setTab(k)}
                className={cx('-mb-px border-b-2 px-3 py-2 text-sm', tab === k ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-gray-600 hover:text-gray-900')}>{l}</button>
            ))}
          </div>

          {tab === 'etapas' && (
            <ol className="space-y-1.5">
              {QUALITY_STEPS.map((s, i) => {
                const st = draft.steps[s.key];
                const state = live.stepStates[s.key];
                const current = live.currentStep === s.key;
                return (
                  <li key={s.key} className={cx('grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]', current ? 'border-brand-300 bg-brand-50/40' : 'border-gray-200')}>
                    <span className={cx('flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold', STEP_TONE[state], ['feito', 'feito_atrasado', 'atrasado', 'hold'].includes(state) ? 'text-white' : 'text-gray-600')}>{i + 1}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{s.label}</div>
                      <div className={cx('text-xs', state === 'atrasado' ? 'text-red-700' : state === 'feito_atrasado' ? 'text-amber-700' : 'text-gray-500')}>
                        {STEP_STATE_LABELS[state]}{state === 'atrasado' && st.plan && ` há ${Math.round((Date.parse(today) - Date.parse(st.plan)) / 86400000)} dia(s)`}
                        <span className="text-gray-400"> · critério {s.days === 1 ? '24 h' : `${s.days} dias`}</span>
                      </div>
                      {q.data!.actions.filter((a) => a.step === s.key).map((a, j) => (
                        <div key={j} className="text-xs">
                          {a.decision === 'criada' && a.issue_id
                            ? <button className="text-brand-700 hover:underline" onClick={() => openIssue(a.issue_id!)}>Pendência {a.issue_code} · {a.area_name}{a.assignee_name ? ` · ${a.assignee_name}` : ''} · {STATUS_LABELS[a.issue_status!]}</button>
                            : <span className="text-gray-400">Sugestão de ação descartada</span>}
                        </div>
                      ))}
                    </div>
                    <label className="col-span-2 flex items-center gap-1.5 text-xs text-gray-500 sm:col-span-1">Prazo
                      <Input type="date" className="w-36 py-1" value={st.plan ?? ''} onChange={(e) => setStep(s.key, { plan: e.target.value || null })} />
                    </label>
                    <label className="col-span-2 flex items-center gap-1.5 text-xs text-gray-500 sm:col-span-1">Realizado
                      <Input type="date" className="w-36 py-1" value={st.done ?? ''} max={today} disabled={!!st.mark}
                        onChange={(e) => setStep(s.key, { done: e.target.value || null, mark: null })} />
                    </label>
                    <div className="col-span-2 flex gap-1 sm:col-span-1">
                      <button type="button" title="Concluída hoje" onClick={() => setStep(s.key, { done: today, mark: null })}
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-emerald-50"><CalendarCheck size={14} /></button>
                      <button type="button" aria-pressed={st.mark === 'na'} title="Não aplicável" onClick={() => setStep(s.key, { mark: st.mark === 'na' ? null : 'na', done: null })}
                        className={cx('rounded-md border px-2 py-1 text-xs', st.mark === 'na' ? 'border-gray-700 bg-gray-700 text-white' : 'border-gray-300 hover:bg-gray-100')}>N/A</button>
                      <button type="button" aria-pressed={st.mark === 'hold'} title="On hold (suspensa)" onClick={() => setStep(s.key, { mark: st.mark === 'hold' ? null : 'hold', done: null })}
                        className={cx('rounded-md border px-2 py-1 text-xs', st.mark === 'hold' ? 'border-violet-600 bg-violet-600 text-white' : 'border-gray-300 hover:bg-violet-50')}><PauseCircle size={14} /></button>
                    </div>
                  </li>
                );
              })}
              <p className="pt-1 text-xs text-gray-500">A ocorrência é concluída quando “Lições aprendidas” recebe a data de realização. Atraso em qualquer etapa deixa a ocorrência atrasada, como na planilha.</p>
            </ol>
          )}

          {tab === 'dados' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <datalist id="q-tipos">{opts.data?.catalog.tipo.map((v) => <option key={v} value={v} />)}</datalist>
              <datalist id="q-parceiros">{partnerList?.map((v) => <option key={v} value={v} />)}</datalist>
              <datalist id="q-problemas">{opts.data?.catalog.problema.map((v) => <option key={v} value={v} />)}</datalist>
              <datalist id="q-lideres">{opts.data?.catalog.lider.map((v) => <option key={v} value={v} />)}</datalist>
              <Field label="Número da ocorrência"><Input value={draft.number} onChange={(e) => set('number', e.target.value)} /></Field>
              <Field label="Data de abertura" hint="Os prazos das etapas que seguem o critério padrão acompanham a nova data."><Input type="date" value={draft.opened_on} max={today} onChange={(e) => e.target.value && set('opened_on', e.target.value)} /></Field>
              <Field label={PARTNER_LABELS[draft.origin]}><Input list="q-parceiros" value={draft.partner ?? ''} onChange={(e) => set('partner', e.target.value)} /></Field>
              <Field label="Tipo"><Input list="q-tipos" value={draft.kind ?? ''} onChange={(e) => set('kind', e.target.value)} /></Field>
              <Field label="Reclamação">
                <Select value={draft.claim_type ?? ''} onChange={(e) => set('claim_type', e.target.value || null)}>
                  <option value="">—</option><option>Oficial</option><option>Não Oficial</option>
                  {draft.claim_type && !['Oficial', 'Não Oficial'].includes(draft.claim_type) && <option>{draft.claim_type}</option>}
                </Select>
              </Field>
              <Field label="Líder"><Input list="q-lideres" value={draft.leader ?? ''} onChange={(e) => set('leader', e.target.value)} /></Field>
              <Field label="Descrição do produto"><Input value={draft.product ?? ''} onChange={(e) => set('product', e.target.value)} /></Field>
              <Field label="Código interno"><Input value={draft.internal_code ?? ''} onChange={(e) => set('internal_code', e.target.value)} /></Field>
              {draft.origin !== 'fornecedor' && <Field label="Código cliente"><Input value={draft.customer_code ?? ''} onChange={(e) => set('customer_code', e.target.value)} /></Field>}
              {draft.origin === 'externa' && <Field label="Número da reclamação do cliente"><Input value={draft.customer_claim ?? ''} onChange={(e) => set('customer_claim', e.target.value)} /></Field>}
              <Field label="Problema primário"><Input list="q-problemas" value={draft.primary_problem ?? ''} onChange={(e) => set('primary_problem', e.target.value)} /></Field>
              <Field label="Incidente procedente?">
                <Select value={draft.procedente ?? ''} onChange={(e) => set('procedente', (e.target.value || null) as Draft['procedente'])}>
                  <option value="">Sem confirmação</option>{PROCEDENTE.map((p) => <option key={p}>{p}</option>)}
                </Select>
              </Field>
              <Field label="Descrição do problema" className="sm:col-span-2"><Textarea value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
              <Field label="Plano de ação / contramedidas" className="sm:col-span-2"><Textarea value={draft.action_plan ?? ''} onChange={(e) => set('action_plan', e.target.value)} /></Field>
              <Field label="Prazo final"><Input type="date" value={draft.due_on} onChange={(e) => e.target.value && set('due_on', e.target.value)} /></Field>
              <div className="flex flex-col justify-end gap-2 text-sm">
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={draft.safety} onChange={(e) => set('safety', e.target.checked)} />Segurança / regulatório</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={draft.recurrent} onChange={(e) => set('recurrent', e.target.checked)} />Reincidente</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={draft.on_hold} onChange={(e) => set('on_hold', e.target.checked)} />On hold geral (item suspenso)</label>
              </div>
              {draft.on_hold && <Field label="Motivo do on hold" className="sm:col-span-2"><Input value={draft.on_hold_reason ?? ''} onChange={(e) => set('on_hold_reason', e.target.value)} /></Field>}
            </div>
          )}

          {tab === 'historico' && (
            <ul className="space-y-2">
              {q.data!.history.length === 0 && <li className="text-sm text-gray-500">Sem registros.</li>}
              {q.data!.history.map((h) => (
                <li key={h.id} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <History size={14} />{fmtDateTime(h.at)} · {h.actor_name ?? 'sistema'} ·
                    <span className="font-medium text-gray-700">{{
                      'quality.create': 'Cadastrou a ocorrência',
                      'quality.update': 'Alterou',
                      'quality.import_create': `Importou da planilha ${h.data.arquivo ?? ''}`,
                      'quality.import_update': `Atualizou pela planilha ${h.data.arquivo ?? ''}`,
                      'quality.action_create': 'Aprovou ação',
                      'quality.action_dismiss': 'Descartou sugestão de ação',
                    }[h.action as string] ?? h.action}</span>
                  </div>
                  {Array.isArray(h.data.alteracoes) && h.data.alteracoes.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-gray-700">{h.data.alteracoes.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
                  )}
                </li>
              ))}
              <li className="flex items-center gap-1 text-xs text-gray-500"><Ban size={12} />O histórico é permanente: não pode ser editado nem apagado.</li>
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
