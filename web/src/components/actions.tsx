import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Paperclip, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ROLE_LABELS, type Role } from '@shared/constants';
import { api, ApiError, errorMessage, get, post } from '../lib/api';
import { fmtDateTime, fromLocalInput, toLocalInput } from '../lib/format';
import { useMeta } from '../lib/meta';
import { useMe } from '../lib/session';
import { useToast } from '../lib/toast';
import { Button, Field, Input, Modal, Select, Textarea } from './ui';

interface IssueLike {
  id: string;
  code: string;
  title: string;
  version: number;
  area_id: number;
  assignee_id: string | null;
  due_at?: string;
}

function useSubmit(onClose: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; details?: string[] } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast('ok', ok);
      qc.invalidateQueries();
      onClose();
    } catch (e) {
      const details = e instanceof ApiError && Array.isArray(e.details) && e.details.every((d) => typeof d === 'string') ? (e.details as string[]) : undefined;
      setError({ msg: e instanceof ApiError ? e.message : errorMessage(e), details });
      if (e instanceof ApiError && e.code === 'versao_desatualizada') qc.invalidateQueries();
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function FormError({ error }: { error: { msg: string; details?: string[] } | null }) {
  if (!error) return null;
  return (
    <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
      <div className="flex items-center gap-2 font-medium"><TriangleAlert size={16} />{error.msg}</div>
      {error.details && <ul className="mt-1 list-disc pl-6">{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}
    </div>
  );
}

export function UserSelect({ value, onChange, areaId, allowEmpty = 'Sem responsável', id }: { value: string; onChange: (v: string) => void; areaId?: number | null; allowEmpty?: string | false; id?: string }) {
  const meta = useMeta();
  const users = (meta?.users ?? []).filter((u) => u.active);
  const inArea = users.filter((u) => u.area_id === areaId);
  const others = users.filter((u) => u.area_id !== areaId);
  const label = (u: any) => `${u.name}${u.role !== 'colaborador' ? ` (${ROLE_LABELS[u.role as Role]})` : ''}`;
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowEmpty !== false && <option value="">{allowEmpty}</option>}
      {inArea.length > 0 && <optgroup label="Da área">{inArea.map((u) => <option key={u.id} value={u.id}>{label(u)}</option>)}</optgroup>}
      <optgroup label={inArea.length ? 'Outras áreas' : 'Usuários'}>{others.map((u) => <option key={u.id} value={u.id}>{label(u)}</option>)}</optgroup>
    </Select>
  );
}

function Footer({ onClose, busy, submit, label, kind = 'primary' }: { onClose: () => void; busy: boolean; submit: () => void; label: ReactNode; kind?: 'primary' | 'danger' | 'success' }) {
  return (
    <>
      <Button onClick={onClose}>Voltar</Button>
      <Button kind={kind} loading={busy} onClick={submit}>{label}</Button>
    </>
  );
}

export function CompleteModal({ issue, onClose }: { issue: IssueLike; onClose: () => void }) {
  const { busy, error, run } = useSubmit(onClose);
  const meta = useMeta();
  const detail = useQuery({ queryKey: ['issue', issue.id], queryFn: () => get(`/api/issues/${issue.id}`) });
  const d = detail.data;
  const [solution, setSolution] = useState('');
  const [initialWhen] = useState(() => toLocalInput(new Date()));
  const [when, setWhen] = useState(initialWhen);
  const [confirmed, setConfirmed] = useState(false);
  const [files, setFiles] = useState<FileList | null>(null);
  const evidence = (d?.attachments ?? []).filter((a: any) => a.purpose !== 'anexo').length;
  const needsValidation = meta?.config.workflow.requireValidation;
  const submit = () =>
    run(async () => {
      if (files?.length) await uploadFiles(issue.id, files, 'conclusao');
      await post(`/api/issues/${issue.id}/complete`, { version: d?.version ?? issue.version, solution, criteriaConfirmed: confirmed, completedAt: when === initialWhen ? null : fromLocalInput(when) });
    }, needsValidation ? `${issue.code} enviada para validação` : `${issue.code} concluída`);
  return (
    <Modal open onClose={onClose} title={`Concluir ${issue.code}`} footer={<Footer onClose={onClose} busy={busy} submit={submit} kind="success" label={<><CheckCircle2 size={16} />{needsValidation ? 'Enviar para validação' : 'Concluir'}</>} />}>
      <FormError error={error} />
      <p className="mb-3 text-sm text-gray-600">{issue.title}</p>
      {d?.pending_mandatory_steps > 0 && (
        <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Ainda há {d.pending_mandatory_steps} etapa(s) obrigatória(s) pendente(s). Conclua-as antes de encerrar.</div>
      )}
      <div className="space-y-3">
        <Field label="Solução aplicada" required hint="O que foi feito para resolver o problema (mín. 10 caracteres).">
          <Textarea value={solution} onChange={(e) => setSolution(e.target.value)} rows={4} maxLength={4000} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Data e hora da conclusão" required hint="Até 24 h atrás.">
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Field label="Responsável pela conclusão">
            <Input value={d?.assignee_name ?? '—'} disabled />
          </Field>
        </div>
        <Field label={`Evidências${d?.evidence_required ? ' (obrigatória)' : ''}`} hint={evidence ? `${evidence} evidência(s) já anexada(s).` : 'Fotos, vídeos ou documentos que comprovem a solução.'}>
          <Input type="file" multiple accept="image/*,video/mp4,application/pdf,.docx,.xlsx,.pptx,.txt,.csv" onChange={(e) => setFiles(e.target.files)} />
        </Field>
        <label className="flex items-start gap-2 rounded-lg border border-gray-200 p-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>
            Confirmo que o critério de conclusão foi atendido.
            {d?.expected_action && <span className="mt-1 block text-gray-600">Critério: {d.expected_action}</span>}
          </span>
        </label>
        {needsValidation && <p className="text-xs text-gray-500">A pendência ficará “Aguardando validação” até que quem a abriu ou o líder da área valide a solução.</p>}
      </div>
    </Modal>
  );
}

export async function uploadFiles(issueId: string, files: FileList | File[], purpose: string, stepId?: string) {
  const fd = new FormData();
  fd.append('purpose', purpose);
  if (stepId) fd.append('stepId', stepId);
  for (const f of Array.from(files)) fd.append('file', f, f.name);
  return api('POST', `/api/issues/${issueId}/attachments`, fd);
}

export function BlockModal({ issue, onClose, steps }: { issue: IssueLike; onClose: () => void; steps?: { id: string; title: string }[] }) {
  const meta = useMeta();
  const { busy, error, run } = useSubmit(onClose);
  const [description, setDescription] = useState('');
  const [area, setArea] = useState('');
  const [step, setStep] = useState('');
  const submit = () => run(() => post(`/api/issues/${issue.id}/block`, { version: issue.version, description, blockingAreaId: area ? Number(area) : null, stepId: step || null }), `Impedimento registrado em ${issue.code}`);
  return (
    <Modal open onClose={onClose} title={`Registrar impedimento — ${issue.code}`} footer={<Footer onClose={onClose} busy={busy} submit={submit} label="Registrar impedimento" />}>
      <FormError error={error} />
      <div className="space-y-3">
        <Field label="O que está impedindo a execução?" required>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex.: aguardando compra do rolamento" />
        </Field>
        <Field label="Depende de outra área?" hint="A responsabilidade principal continua com a área e o responsável atuais.">
          <Select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">Não</option>
            {meta?.areas.filter((a) => a.id !== issue.area_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        {steps && steps.length > 0 && (
          <Field label="Etapa afetada">
            <Select value={step} onChange={(e) => setStep(e.target.value)}>
              <option value="">Pendência inteira</option>
              {steps.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function CancelModal({ issue, onClose }: { issue: IssueLike; onClose: () => void }) {
  const { busy, error, run } = useSubmit(onClose);
  const [reason, setReason] = useState('');
  const submit = () => run(() => post(`/api/issues/${issue.id}/cancel`, { version: issue.version, reason }), `${issue.code} cancelada`);
  return (
    <Modal open onClose={onClose} title={`Cancelar ${issue.code}`} footer={<Footer onClose={onClose} busy={busy} submit={submit} kind="danger" label="Cancelar pendência" />}>
      <FormError error={error} />
      <p className="mb-3 text-sm text-gray-600">A pendência não é apagada: fica registrada como cancelada, com o motivo, e não conta como conclusão no ranking.</p>
      <Field label="Motivo do cancelamento" required>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: registrada em duplicidade com FR-2026-00012" />
      </Field>
    </Modal>
  );
}

export function AssignModal({ issue, onClose }: { issue: IssueLike; onClose: () => void }) {
  const { busy, error, run } = useSubmit(onClose);
  const [user, setUser] = useState(issue.assignee_id ?? '');
  const [reason, setReason] = useState('');
  const submit = () => run(() => post(`/api/issues/${issue.id}/assign`, { version: issue.version, assigneeId: user || null, reason: reason || null }), 'Responsável atualizado');
  return (
    <Modal open onClose={onClose} title={`Responsável — ${issue.code}`} footer={<Footer onClose={onClose} busy={busy} submit={submit} label="Salvar" />}>
      <FormError error={error} />
      <div className="space-y-3">
        <Field label="Responsável pela execução"><UserSelect value={user} onChange={setUser} areaId={issue.area_id} /></Field>
        <Field label="Observação"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function TransferModal({ issue, onClose }: { issue: IssueLike; onClose: () => void }) {
  const meta = useMeta();
  const { busy, error, run } = useSubmit(onClose);
  const [area, setArea] = useState(String(issue.area_id));
  const [user, setUser] = useState('');
  const [reason, setReason] = useState('');
  const submit = () => run(() => post(`/api/issues/${issue.id}/transfer`, { version: issue.version, areaId: Number(area), assigneeId: user || null, reason }), `${issue.code} transferida`);
  return (
    <Modal open onClose={onClose} title={`Transferir ${issue.code}`} footer={<Footer onClose={onClose} busy={busy} submit={submit} label="Transferir" />}>
      <FormError error={error} />
      <p className="mb-3 text-sm text-gray-600">A área de origem continua registrada e a pendência permanece visível nela.</p>
      <div className="space-y-3">
        <Field label="Nova área responsável" required>
          <Select value={area} onChange={(e) => setArea(e.target.value)}>{meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        </Field>
        <Field label="Novo responsável"><UserSelect value={user} onChange={setUser} areaId={Number(area)} allowEmpty="Definir depois (líder da área)" /></Field>
        <Field label="Motivo" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function DeadlineModal({ issue, direct, step, onClose }: { issue: IssueLike; direct: boolean; step?: { id: string; title: string; due_at: string | null }; onClose: () => void }) {
  const { busy, error, run } = useSubmit(onClose);
  const current = step ? step.due_at : issue.due_at;
  const [when, setWhen] = useState(toLocalInput(current && new Date(current) > new Date() ? current : new Date(Date.now() + 86400000)));
  const [reason, setReason] = useState('');
  const submit = () =>
    run(() => post(`/api/issues/${issue.id}/deadline`, { newDueAt: fromLocalInput(when), reason, stepId: step?.id ?? null }), direct ? 'Prazo alterado' : 'Solicitação enviada para aprovação');
  return (
    <Modal open onClose={onClose} title={step ? `Prazo da etapa — ${step.title}` : `Alterar prazo — ${issue.code}`} footer={<Footer onClose={onClose} busy={busy} submit={submit} label={direct ? 'Alterar prazo' : 'Solicitar alteração'} />}>
      <FormError error={error} />
      <p className="mb-3 text-sm text-gray-600">
        Prazo atual: <strong>{fmtDateTime(current)}</strong>. O prazo original e todas as alterações ficam no histórico.
        {!direct && ' Sua solicitação precisa ser aprovada pelo líder da área ou por um gestor.'}
      </p>
      <div className="space-y-3">
        <Field label="Novo prazo" required><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Justificativa" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: peça importada com entrega prevista para sexta" /></Field>
      </div>
    </Modal>
  );
}

export function ValidateModal({ issue, onClose }: { issue: IssueLike & { solution?: string }; onClose: () => void }) {
  const { busy, error, run } = useSubmit(onClose);
  const [note, setNote] = useState('');
  const send = (approved: boolean) => run(() => post(`/api/issues/${issue.id}/validate`, { version: issue.version, approved, note: note || null }), approved ? `${issue.code} validada e concluída` : `${issue.code} devolvida para execução`);
  return (
    <Modal open onClose={onClose} title={`Validar solução — ${issue.code}`} footer={<>
      <Button onClick={onClose}>Voltar</Button>
      <Button kind="danger" loading={busy} onClick={() => send(false)}>Rejeitar e reabrir</Button>
      <Button kind="success" loading={busy} onClick={() => send(true)}><CheckCircle2 size={16} />Aprovar</Button>
    </>}>
      <FormError error={error} />
      {issue.solution && <div className="mb-3 rounded-lg bg-gray-50 p-3 text-sm"><span className="font-medium">Solução informada:</span> {issue.solution}</div>}
      <Field label="Observação" hint="Obrigatória ao rejeitar. A rejeição conta como reabertura no ranking."><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

export function ReopenModal({ issue, onClose }: { issue: IssueLike; onClose: () => void }) {
  const { busy, error, run } = useSubmit(onClose);
  const [reason, setReason] = useState('');
  const submit = () => run(() => post(`/api/issues/${issue.id}/reopen`, { version: issue.version, reason }), `${issue.code} reaberta`);
  return (
    <Modal open onClose={onClose} title={`Reabrir ${issue.code}`} footer={<Footer onClose={onClose} busy={busy} submit={submit} kind="danger" label="Reabrir por solução ineficaz" />}>
      <FormError error={error} />
      <p className="mb-3 text-sm text-gray-600">A reabertura fica registrada no histórico e reduz a pontuação desta pendência no ranking.</p>
      <Field label="Por que a solução não foi eficaz?" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

export function AttachButton({ issueId, purpose = 'anexo', stepId, label = 'Anexar' }: { issueId: string; purpose?: string; stepId?: string; label?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const me = useMe();
  void me;
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-sm hover:bg-gray-50">
      <Paperclip size={14} />{busy ? 'Enviando…' : label}
      <input type="file" multiple className="sr-only" accept="image/*,video/mp4,video/quicktime,application/pdf,.docx,.xlsx,.pptx,.txt,.csv"
        onChange={async (e) => {
          const files = e.target.files;
          if (!files?.length) return;
          setBusy(true);
          try {
            await uploadFiles(issueId, files, purpose, stepId);
            toast('ok', `${files.length} arquivo(s) anexado(s)`);
            qc.invalidateQueries({ queryKey: ['issue', issueId] });
          } catch (err) {
            toast('error', errorMessage(err));
          } finally {
            setBusy(false);
            e.target.value = '';
          }
        }} />
    </label>
  );
}
