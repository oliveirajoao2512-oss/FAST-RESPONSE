import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Check, CheckCircle2, FileDown, LogOut, Pause, Pin, PinOff, Play, Trash2, Wrench, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { WO_PRIORITIES, WO_PRIORITY_LABELS } from '@shared/maintenance';
import { errorMessage, post } from '../../lib/api';
import { duration, fmtDateTime, fmtShort } from '../../lib/format';
import { useMe } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { eventText, useWoDetail, useWoDomain, useWoOptions, type WorkOrderDetail } from '../../lib/workOrders';
import { Button, cx, ErrorBox, Field, Input, Modal, Select, Spinner, Textarea } from '../ui';
import { PhotoPicker, uploadWoFiles } from './NewWoModal';
import { WoHeadline, WoSituation, WoWhere } from './parts';

type Prompt = 'pausar' | 'devolver' | 'passar' | 'finalizar' | 'excluir' | null;

/** Re-renders every 30 s so the running times stay current. */
function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [on]);
}

export function WoDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const D = useWoDomain();
  const opts = useWoOptions();
  const q = useWoDetail(id);
  const o = q.data;
  useTick(!!o && o.status !== 'finalizada');
  return (
    <Modal open wide onClose={onClose} title={o ? `${o.code} · ${o.asset_ref}` : D.d === 'ajuste' ? 'Ordem de ajuste' : 'Ordem de manutenção'}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : o && (
        <Body o={o} meId={me.id} isAdmin={me.role === 'admin'} canWork={!!opts.data?.canWork} canLead={!!opts.data?.canLead} team={opts.data?.team ?? []} onClose={onClose} />
      )}
    </Modal>
  );
}

function Body({ o, meId, isAdmin, canWork, canLead, team, onClose }: {
  o: WorkOrderDetail; meId: string; isAdmin: boolean; canWork: boolean; canLead: boolean; team: { id: string; name: string; role: string }[]; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const D = useWoDomain();
  const S = D.short;
  const adj = D.d === 'ajuste';
  const [busy, setBusy] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const finished = o.status === 'finalizada';
  const working = o.workers.some((w) => w.id === meId);
  const handOverToMe = o.transfer_to === meId;
  const live = !finished;

  const run = async (action: string, body: unknown = {}, ok?: string) => {
    setBusy(action);
    try {
      await post(`${D.api}/${o.id}/${action}`, body);
      await qc.invalidateQueries({ queryKey: ['os'] });
      if (ok) toast('ok', ok);
      return true;
    } catch (e) {
      toast('error', errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const acceptLabel = handOverToMe ? `Assumir a ${S}` : o.status === 'aberta' ? `Aceitar ${S}` : `Entrar na ${S}`;
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <WoHeadline o={o} />
        <WoWhere o={o} />
        <div className="text-sm"><WoSituation o={o} meId={meId} /></div>
      </div>
      <a href={`${D.api}/${o.id}/comprovante.pdf`} target="_blank" rel="noreferrer" className="inline-flex">
        <Button size="sm"><FileDown size={16} />Comprovante (PDF)</Button>
      </a>

      {handOverToMe && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <ArrowRightLeft size={16} /><span className="flex-1"><b>{o.transfer_from_name}</b> quer passar esta {S} para você.</span>
          <Button size="sm" kind="success" loading={busy === 'aceitar'} onClick={() => run('aceitar', {}, `Você assumiu a ${S}.`)}><Check size={16} />Aceitar</Button>
          <Button size="sm" loading={busy === 'recusar'} onClick={() => run('recusar', {}, 'Passagem recusada.')}>Recusar</Button>
        </div>
      )}
      {o.transfer_from === meId && o.transfer_to && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
          <ArrowRightLeft size={16} /><span className="flex-1">Aguardando <b>{o.transfer_to_name}</b> aceitar a passagem. Até lá, a {S} continua com você.</span>
          <Button size="sm" loading={busy === 'recusar'} onClick={() => run('recusar', {}, 'Passagem cancelada.')}>Cancelar passagem</Button>
        </div>
      )}

      {/* main actions: large, for use on tablets and phones */}
      {live && (canWork || working) && (
        <div className="flex flex-wrap gap-2">
          {canWork && !working && !handOverToMe && (
            <Button kind="primary" className="min-h-11 flex-1 sm:flex-none" loading={busy === 'aceitar'} onClick={() => run('aceitar', {}, o.status === 'aberta' ? `${S} aceita. Quem abriu já está vendo que você está atuando.` : `Você entrou na ${S}.`)}>
              <Wrench size={18} />{acceptLabel}
            </Button>
          )}
          {working && (
            <>
              <Button kind="success" className="min-h-11 flex-1 sm:flex-none" onClick={() => setPrompt('finalizar')}><CheckCircle2 size={18} />Finalizar</Button>
              {o.status === 'em_atendimento'
                ? <Button className="min-h-11" onClick={() => setPrompt('pausar')}><Pause size={18} />Pausar</Button>
                : <Button className="min-h-11" loading={busy === 'retomar'} onClick={() => run('retomar', {}, 'Atendimento retomado.')}><Play size={18} />Retomar</Button>}
              {!o.transfer_to && <Button className="min-h-11" onClick={() => setPrompt('passar')}><ArrowRightLeft size={18} />Passar</Button>}
              <Button className="min-h-11" onClick={() => setPrompt('devolver')}><LogOut size={18} />{o.workers.length > 1 ? `Sair da ${S}` : 'Devolver'}</Button>
            </>
          )}
          {!working && canLead && o.status === 'pausada' && <Button className="min-h-11" loading={busy === 'retomar'} onClick={() => run('retomar', {}, 'Atendimento retomado.')}><Play size={18} />Retomar</Button>}
        </div>
      )}

      {live && canLead && <QueueControls o={o} team={team} run={run} busy={busy} />}

      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <div className="space-y-4">
          {(o.part_number || o.virgin_pct != null) && (
            <Section title="Dados do ajuste">
              <p className="text-sm text-gray-800">
                {o.part_number && <>Part number: <b>{o.part_number}</b></>}
                {o.part_number && o.virgin_pct != null && ' · '}
                {o.virgin_pct != null && <>Material: <b>{o.virgin_pct}%</b> virgem e <b>{o.regrind_pct}%</b> moído</>}
              </p>
            </Section>
          )}
          <Section title={adj ? 'Motivo / problema da parada' : 'Problema'}>
            <p className="whitespace-pre-wrap text-sm text-gray-800">{o.description}</p>
            <p className="mt-1 text-xs text-gray-500">Aberta por {o.opened_by_name} em {fmtDateTime(o.opened_at)}</p>
          </Section>
          {finished && (
            <Section title={adj ? 'Ação tomada' : 'Serviço realizado'}>
              <p className="whitespace-pre-wrap text-sm text-gray-800">{o.service_done}</p>
              {o.material && <p className="mt-1 text-sm text-gray-700"><span className="font-medium">{adj ? 'Observações' : 'Material'}:</span> {o.material}</p>}
              <p className="mt-1 text-xs text-gray-500">Finalizada por {o.finished_by_name} em {fmtDateTime(o.finished_at)}</p>
            </Section>
          )}
          <Photos o={o} canAdd={o.opened_by === meId || canWork} />
          <Section title="Histórico">
            <ol className="space-y-1.5 border-l-2 border-gray-200 pl-3">
              {o.events.filter((e) => e.action !== 'anexou').map((e) => (
                <li key={e.id} className="text-sm">
                  <span className="text-xs tabular text-gray-500">{fmtShort(e.created_at)}</span>{' '}
                  <span className="font-medium">{e.actor_name ?? 'Sistema'}</span> {eventText(e)}
                </li>
              ))}
            </ol>
          </Section>
        </div>
        <aside className="space-y-3">
          <Section title="Tempos (automáticos)">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <Time label="Espera na fila" ms={o.times.waitMs} running={o.status === 'aberta'} />
              <Time label={adj ? 'Tempo de ajuste' : 'Atendimento'} ms={o.times.workMs} running={o.status === 'em_atendimento'} />
              <Time label="Pausado" ms={o.times.pausedMs} running={o.status === 'pausada'} />
              <Time label="Total" ms={o.times.totalMs} running={live} />
            </dl>
          </Section>
          {o.hoursByWorker.length > 0 && (
            <Section title={`Horas por ${D.worker}`}>
              <ul className="space-y-1 text-sm">{o.hoursByWorker.map((w) => <li key={w.id} className="flex justify-between gap-2"><span>{w.name}</span><span className="tabular text-gray-700">{duration(w.ms)}</span></li>)}</ul>
            </Section>
          )}
          {isAdmin && <Button kind="ghost" size="sm" className="text-red-700" onClick={() => setPrompt('excluir')}><Trash2 size={14} />Excluir definitivamente</Button>}
        </aside>
      </div>

      {prompt === 'pausar' && <PauseModal onClose={() => setPrompt(null)} onConfirm={async (motivo) => (await run('pausar', { motivo }, `${S} pausada.`)) && setPrompt(null)} busy={busy === 'pausar'} />}
      {prompt === 'devolver' && (
        <ReasonModal title={o.workers.length > 1 ? `Sair da ${S}` : 'Devolver para a fila'} busy={busy === 'devolver'} onClose={() => setPrompt(null)}
          hint={o.workers.length > 1 ? `Os outros ${D.workers} continuam na ${S}.` : `A ${S} volta para a fila e outro ${D.worker} pode aceitar.`}
          onConfirm={async (motivo) => (await run('devolver', { motivo }, o.workers.length > 1 ? `Você saiu da ${S}.` : `${S} devolvida para a fila.`)) && setPrompt(null)} />
      )}
      {prompt === 'passar' && <PassModal team={team.filter((t) => !o.workers.some((w) => w.id === t.id))} busy={busy === 'passar'} onClose={() => setPrompt(null)}
        onConfirm={async (userId) => (await run('passar', { userId }, `Pedido enviado. A ${S} muda de mãos quando o colega aceitar.`)) && setPrompt(null)} />}
      {prompt === 'finalizar' && <FinishModal o={o} onClose={() => setPrompt(null)} onDone={() => { setPrompt(null); }} />}
      {prompt === 'excluir' && <PurgeModal o={o} onClose={() => setPrompt(null)} onDone={onClose} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section><h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>{children}</section>;
}

function Time({ label, ms, running }: { label: string; ms: number | null; running: boolean }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={cx('font-semibold tabular', running ? 'text-blue-700' : 'text-gray-900')}>{ms == null ? '—' : duration(ms)}{running && ms != null && <span className="ml-1 text-xs font-normal">correndo</span>}</dd>
    </div>
  );
}

function QueueControls({ o, team, run, busy }: { o: WorkOrderDetail; team: { id: string; name: string }[]; run: (a: string, b?: unknown, ok?: string) => Promise<boolean>; busy: string | null }) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <span className="w-full text-xs font-semibold uppercase tracking-wide text-gray-500">Gestão da fila</span>
      <label className="text-xs text-gray-600">Prioridade
        <Select value={o.priority} disabled={busy === 'prioridade'} onChange={(e) => run('prioridade', { priority: e.target.value }, 'Prioridade alterada.')} className="mt-0.5 w-36">
          {WO_PRIORITIES.map((p) => <option key={p} value={p}>{WO_PRIORITY_LABELS[p]}</option>)}
        </Select>
      </label>
      {o.status === 'aberta' && (
        <label className="text-xs text-gray-600">Indicar para
          <Select value={o.suggested_to ?? ''} disabled={busy === 'indicar'} onChange={(e) => run('indicar', { userId: e.target.value || null }, e.target.value ? 'Aviso enviado.' : 'Indicação removida.')} className="mt-0.5 w-48">
            <option value="">Ninguém</option>
            {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </label>
      )}
      <Button size="sm" loading={busy === 'prioridade'} onClick={() => run('prioridade', { pinned: !o.pinned }, o.pinned ? 'Saiu do topo da fila.' : 'Fixada no topo da fila.')}>
        {o.pinned ? <><PinOff size={14} />Tirar do topo</> : <><Pin size={14} />Fixar no topo</>}
      </Button>
    </div>
  );
}

function Photos({ o, canAdd }: { o: WorkOrderDetail; canAdd: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const D = useWoDomain();
  const [busy, setBusy] = useState(false);
  if (!o.attachments.length && !canAdd) return null;
  const add = async (files: File[]) => {
    setBusy(true);
    try {
      await uploadWoFiles(D.api, o.id, files, o.status === 'aberta' ? 'abertura' : 'servico');
      await qc.invalidateQueries({ queryKey: ['os'] });
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Fotos">
      <div className="flex flex-wrap gap-2">
        {o.attachments.map((f) => (
          <a key={f.id} href={`${D.api}/files/${f.id}`} target="_blank" rel="noreferrer" className="block h-20 w-20 overflow-hidden rounded-lg border border-gray-200 bg-gray-50" title={`${f.purpose === 'servico' ? 'Serviço' : 'Abertura'} · ${f.filename}`}>
            {f.mime.startsWith('image/') ? <img src={`${D.api}/files/${f.id}`} alt={f.filename} className="h-full w-full object-cover" loading="lazy" /> : <span className="flex h-full items-center justify-center p-1 text-center text-xs text-gray-500">{f.filename}</span>}
          </a>
        ))}
        {canAdd && (
          <label className={cx('flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-gray-300 text-xs text-gray-500 hover:border-brand-400', busy && 'opacity-50')}>
            {busy ? 'Enviando…' : '+ Foto'}
            <input type="file" accept="image/*,video/*" multiple className="sr-only" disabled={busy} onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          </label>
        )}
      </div>
    </Section>
  );
}

function PauseModal({ onClose, onConfirm, busy }: { onClose: () => void; onConfirm: (m: string) => void; busy: boolean }) {
  const D = useWoDomain();
  const [reason, setReason] = useState<string>(D.pauseReasons[0]);
  const [other, setOther] = useState('');
  const text = reason === 'Outro' ? other.trim() : reason;
  return (
    <Modal open onClose={onClose} title={`Pausar ${D.short}`} footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="primary" loading={busy} disabled={!text} onClick={() => onConfirm(text)}><Pause size={16} />Pausar</Button></>}>
      <div className="space-y-2" role="radiogroup" aria-label="Motivo da pausa">
        {D.pauseReasons.map((r) => (
          <label key={r} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm', reason === r ? 'border-brand-500 bg-brand-50' : 'border-gray-200')}>
            <input type="radio" name="pause" checked={reason === r} onChange={() => setReason(r)} className="accent-brand-600" />{r}
          </label>
        ))}
        {reason === 'Outro' && <Input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Qual o motivo?" maxLength={300} aria-label="Outro motivo" />}
        <p className="text-xs text-gray-500">O tempo pausado é contado à parte e não entra no tempo de atendimento.</p>
      </div>
    </Modal>
  );
}

function ReasonModal({ title, hint, busy, onClose, onConfirm }: { title: string; hint: string; busy: boolean; onClose: () => void; onConfirm: (m: string) => void }) {
  const [text, setText] = useState('');
  return (
    <Modal open onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="primary" loading={busy} disabled={!text.trim()} onClick={() => onConfirm(text.trim())}>Confirmar</Button></>}>
      <Field label="Motivo" required hint={hint}><Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={300} placeholder="Ex.: precisa de eletricista" /></Field>
    </Modal>
  );
}

function PassModal({ team, busy, onClose, onConfirm }: { team: { id: string; name: string }[]; busy: boolean; onClose: () => void; onConfirm: (id: string) => void }) {
  const { short: S } = useWoDomain();
  const [to, setTo] = useState('');
  return (
    <Modal open onClose={onClose} title={`Passar a ${S}`} footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="primary" loading={busy} disabled={!to} onClick={() => onConfirm(to)}><ArrowRightLeft size={16} />Enviar pedido</Button></>}>
      <Field label="Para quem?" required hint={`A ${S} só muda de mãos quando o colega aceitar. Até lá, continua com você.`}>
        <Select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Selecione…</option>
          {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
    </Modal>
  );
}

function FinishModal({ o, onClose, onDone }: { o: WorkOrderDetail; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const D = useWoDomain();
  const adj = D.d === 'ajuste';
  const [servico, setServico] = useState('');
  const [material, setMaterial] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (files.length) await uploadWoFiles(D.api, o.id, files, 'servico');
      await post(`${D.api}/${o.id}/finalizar`, { servico: servico.trim(), material: material.trim() || null });
      await qc.invalidateQueries({ queryKey: ['os'] });
      toast('ok', `${o.code} finalizada. Quem abriu foi avisado.`);
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Finalizar ${o.code}`}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="success" loading={busy} disabled={!servico.trim()} onClick={confirm}><CheckCircle2 size={16} />Finalizar</Button></>}>
      <div className="space-y-3">
        <Field label={adj ? 'Ação tomada' : 'O que foi feito?'} required><Textarea value={servico} onChange={(e) => setServico(e.target.value)} rows={3} maxLength={2000} placeholder={adj ? 'Ex.: ajustado tempo de sopro e peso conferido' : 'Ex.: troca do retentor do cilindro e teste de vazamento'} /></Field>
        <Field label={adj ? 'Observações' : 'Material utilizado'}><Input value={material} onChange={(e) => setMaterial(e.target.value)} maxLength={500} placeholder="Opcional" /></Field>
        <PhotoPicker files={files} onChange={setFiles} label="Foto do serviço (opcional)" />
        {error != null && <ErrorBox error={error} />}
      </div>
    </Modal>
  );
}

function PurgeModal({ o, onClose, onDone }: { o: WorkOrderDetail; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { api, short: S } = useWoDomain();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await post(`${api}/${o.id}/purge`, { confirm: text });
      await qc.invalidateQueries({ queryKey: ['os'] });
      toast('ok', `${o.code} excluída sem rastro.`);
      onDone();
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Excluir definitivamente"
      footer={<><Button onClick={onClose}><X size={16} />Cancelar</Button><Button kind="danger" loading={busy} disabled={text.trim().toUpperCase() !== o.code} onClick={go}><Trash2 size={16} />Excluir</Button></>}>
      <p className="mb-3 text-sm text-gray-700">Use só para {S} de teste. A {S}, as fotos, o histórico e as notificações são apagados e não podem ser recuperados.</p>
      <Field label={`Digite ${o.code} para confirmar`}><Input value={text} onChange={(e) => setText(e.target.value)} /></Field>
    </Modal>
  );
}
