import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ORIGIN_LABELS, PARTNER_LABELS, QUALITY_ORIGINS, type QualityOrigin } from '@shared/quality';
import { errorMessage, post } from '../../lib/api';
import { useQualityOptions } from '../../lib/quality';
import { useToast } from '../../lib/toast';
import { Button, Field, Input, Modal, Select, Textarea } from '../ui';

export function NewNcModal({ today, onClose, onCreated }: { today: string; onClose: () => void; onCreated: (id: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const opts = useQualityOptions();
  const [f, setF] = useState({
    origin: 'externa' as QualityOrigin, number: '', opened_on: today, partner: '', claim_type: 'Oficial', product: '', internal_code: '',
    customer_code: '', customer_claim: '', primary_problem: '', description: '', leader: '', safety: false, recurrent: false,
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (opts.data && !f.number) setF((x) => ({ ...x, number: opts.data!.nextNumber }));
  }, [opts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? null : v]));
      const r = await post<{ id: number }>('/api/quality/ncs', body);
      toast('ok', `Ocorrência ${f.number} cadastrada. Prazos das etapas calculados a partir de ${f.opened_on.split('-').reverse().join('/')}.`);
      await qc.invalidateQueries({ queryKey: ['quality'] });
      onCreated(r.id);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const partners = f.origin === 'fornecedor' ? opts.data?.catalog.fornecedor : opts.data?.catalog.cliente;
  return (
    <Modal open onClose={onClose} wide title="Nova ocorrência de qualidade"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="primary" type="submit" form="new-nc" loading={busy}>Cadastrar</Button></>}>
      <form id="new-nc" onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <datalist id="n-parceiros">{partners?.map((v) => <option key={v} value={v} />)}</datalist>
        <datalist id="n-problemas">{opts.data?.catalog.problema.map((v) => <option key={v} value={v} />)}</datalist>
        <datalist id="n-lideres">{opts.data?.catalog.lider.map((v) => <option key={v} value={v} />)}</datalist>
        <Field label="Origem" required>
          <Select value={f.origin} onChange={(e) => set('origin', e.target.value)}>{QUALITY_ORIGINS.map((o) => <option key={o} value={o}>{ORIGIN_LABELS[o]}</option>)}</Select>
        </Field>
        <Field label="Número" required hint="Sugerido o próximo número do ano."><Input required value={f.number} onChange={(e) => set('number', e.target.value)} /></Field>
        <Field label="Data de abertura" required><Input type="date" required max={today} value={f.opened_on} onChange={(e) => set('opened_on', e.target.value)} /></Field>
        <Field label={PARTNER_LABELS[f.origin]}><Input list="n-parceiros" value={f.partner} onChange={(e) => set('partner', e.target.value)} /></Field>
        <Field label="Reclamação"><Select value={f.claim_type} onChange={(e) => set('claim_type', e.target.value)}><option>Oficial</option><option>Não Oficial</option></Select></Field>
        <Field label="Líder"><Input list="n-lideres" value={f.leader} onChange={(e) => set('leader', e.target.value)} /></Field>
        <Field label="Descrição do produto"><Input value={f.product} onChange={(e) => set('product', e.target.value)} /></Field>
        <Field label="Código interno"><Input value={f.internal_code} onChange={(e) => set('internal_code', e.target.value)} /></Field>
        {f.origin !== 'fornecedor' ? <Field label="Código cliente"><Input value={f.customer_code} onChange={(e) => set('customer_code', e.target.value)} /></Field> : <div />}
        {f.origin === 'externa' && <Field label="Nº reclamação do cliente"><Input value={f.customer_claim} onChange={(e) => set('customer_claim', e.target.value)} /></Field>}
        <Field label="Problema primário" className={f.origin === 'externa' ? 'sm:col-span-2' : 'sm:col-span-3'}><Input list="n-problemas" value={f.primary_problem} onChange={(e) => set('primary_problem', e.target.value)} /></Field>
        <Field label="Descrição do problema" className="sm:col-span-3"><Textarea value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <div className="flex gap-4 text-sm sm:col-span-3">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.safety} onChange={(e) => set('safety', e.target.checked)} />Segurança / regulatório</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.recurrent} onChange={(e) => set('recurrent', e.target.checked)} />Reincidente</label>
        </div>
        <p className="text-xs text-gray-500 sm:col-span-3">Os prazos seguem os critérios da planilha: contenção em 24 h, causa raiz em 7 dias, ações corretivas em 14, validação em 34, documentação em 35 e encerramento em 40 dias.</p>
      </form>
    </Modal>
  );
}
