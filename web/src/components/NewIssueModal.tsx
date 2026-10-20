import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Repeat, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ASSET_TYPE_LABELS, ASSET_TYPES, PRIORITIES, PRIORITY_LABELS, type Priority } from '@shared/constants';
import { ApiError, get, post, qs } from '../lib/api';
import { fromLocalInput } from '../lib/format';
import { useMeta } from '../lib/meta';
import { can, useMe } from '../lib/session';
import { useToast } from '../lib/toast';
import { FormError, uploadFiles, UserSelect } from './actions';
import { useOpenIssue } from './issues';
import { Button, cx, Field, Input, Modal, Select, Textarea } from './ui';

const LAST_AREA_KEY = 'fr:lastArea';

export function NewIssueModal({ onClose, defaults }: { onClose: () => void; defaults?: { areaId?: number; source?: 'fast_response' | 'direto' } }) {
  const me = useMe();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const openIssue = useOpenIssue();
  const stored = (() => { try { return Number(localStorage.getItem(LAST_AREA_KEY)) || undefined; } catch { return undefined; } })();
  const [title, setTitle] = useState('');
  const [areaId, setAreaId] = useState<number>(defaults?.areaId ?? me.areaId ?? stored ?? meta?.areas[0]?.id ?? 1);
  const [priority, setPriority] = useState<Priority>('media');
  const [assignee, setAssignee] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [assetType, setAssetType] = useState('');
  const [assetRef, setAssetRef] = useState('');
  const [description, setDescription] = useState('');
  const [expected, setExpected] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [source, setSource] = useState<'fast_response' | 'direto'>(defaults?.source ?? 'fast_response');
  const [recurrenceOf, setRecurrenceOf] = useState('');
  const [more, setMore] = useState(false);
  const [customDue, setCustomDue] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; details?: string[] } | null>(null);
  const [titleErr, setTitleErr] = useState('');

  const probe = { areaId, originAreaId: areaId, assigneeId: null, openedById: me.id };
  const canAssignOthers = can.assign(me, probe);
  const canCustomDue = can.changeDeadline(me, probe, meta?.config.workflow.deadlineChangeRequiresApprovalFor ?? ['colaborador']);
  const area = meta?.areas.find((a) => a.id === areaId);
  const categories = (meta?.categories ?? []).filter((c) => c.active && (c.area_id === null || c.area_id === areaId));
  const otherCategories = (meta?.categories ?? []).filter((c) => c.active && c.area_id !== null && c.area_id !== areaId);
  const category = meta?.categories.find((c) => String(c.id) === categoryId);
  const safety = priority === 'critica' && (area?.slug === 'seguranca' || category?.is_safety);

  // Suggestions to avoid duplicates: open issues with a similar title or the same asset.
  const [debounced, setDebounced] = useState({ title: '', assetRef: '' });
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ title, assetRef }), 400);
    return () => clearTimeout(t);
  }, [title, assetRef]);
  const similar = useQuery({
    queryKey: ['similar', debounced],
    queryFn: () => get(`/api/issues/similar${qs({ title: debounced.title, assetRef: debounced.assetRef })}`),
    enabled: debounced.title.length >= 4 || debounced.assetRef.length >= 2,
  });
  const assets = useQuery({
    queryKey: ['assets', assetType, assetRef],
    queryFn: () => get(`/api/assets${qs({ q: assetRef, type: assetType || undefined })}`),
    enabled: assetRef.length >= 1,
    staleTime: 60_000,
  });

  const dueText = useMemo(() => {
    const cfg = meta?.config.deadline;
    if (!cfg) return '';
    if (safety) return `Imediato: ${cfg.criticalSafetyHours} h após a abertura`;
    return `${cfg.days === 1 ? 'Amanhã' : `D+${cfg.days}`} às ${cfg.time}${cfg.skipWeekends ? ' (dias úteis)' : ''}`;
  }, [meta, safety]);

  const submit = async () => {
    if (!title.trim()) {
      setTitleErr('Informe o título do problema.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await post('/api/issues', {
        title, areaId, priority, source,
        assigneeId: assignee || null,
        categoryId: categoryId ? Number(categoryId) : null,
        assetType: assetType || null, assetRef: assetRef || null,
        description: description || null, expectedAction: expected || null, nextAction: nextAction || null,
        recurrenceOfId: recurrenceOf || null,
        customDueAt: customDue ? fromLocalInput(customDue) : null, customDueReason: customDue ? customReason : null,
      });
      try { localStorage.setItem(LAST_AREA_KEY, String(areaId)); } catch {}
      if (files?.length) {
        try {
          await uploadFiles(r.id, files, 'evidencia');
        } catch (e) {
          toast('error', `Pendência criada, mas os anexos falharam: ${(e as Error).message}`);
        }
      }
      toast('ok', `Pendência ${r.code} registrada`);
      qc.invalidateQueries();
      onClose();
      openIssue(r.id);
    } catch (e) {
      const details = e instanceof ApiError && Array.isArray(e.details) && e.details.every((d) => typeof d === 'string') ? (e.details as string[]) : undefined;
      setError({ msg: (e as Error).message, details });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Nova pendência" wide footer={<>
      <Button onClick={onClose}>Cancelar</Button>
      <Button kind="primary" loading={busy} onClick={submit}>Registrar pendência</Button>
    </>}>
      <FormError error={error} />
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Título do problema" required error={titleErr} className="sm:col-span-2">
          <Input value={title} maxLength={200} placeholder="Ex.: Vazamento de óleo na injetora 07" onChange={(e) => { setTitle(e.target.value); setTitleErr(''); }} />
        </Field>

        {similar.data?.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm sm:col-span-2">
            <div className="mb-1 font-medium text-amber-900">Já existem pendências abertas parecidas — evite duplicidade:</div>
            <ul className="space-y-1">
              {similar.data.map((s: any) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  <button type="button" className="text-left text-brand-700 underline" onClick={() => { onClose(); openIssue(s.id); }}>{s.code} — {s.title}</button>
                  <span className="text-xs text-gray-600">{s.area_name}</span>
                  <button type="button" onClick={() => setRecurrenceOf(recurrenceOf === s.id ? '' : s.id)} className={cx('ml-auto inline-flex items-center gap-1 rounded px-1.5 text-xs', recurrenceOf === s.id ? 'bg-purple-600 text-white' : 'bg-white text-purple-800 ring-1 ring-purple-300')}>
                    <Repeat size={11} />{recurrenceOf === s.id ? 'Marcada como reincidência' : 'É reincidência'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Field label="Área responsável" required>
          <Select value={areaId} onChange={(e) => { setAreaId(Number(e.target.value)); setCategoryId(''); }}>
            {meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Prioridade" required>
          <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Prioridade">
            {PRIORITIES.map((p) => (
              <button type="button" key={p} role="radio" aria-checked={priority === p} onClick={() => setPriority(p)}
                className={cx('rounded-lg border px-1 py-2 text-xs font-semibold sm:text-sm', priority === p
                  ? p === 'critica' ? 'border-red-600 bg-red-600 text-white' : p === 'alta' ? 'border-orange-500 bg-orange-500 text-white' : 'border-brand-600 bg-brand-600 text-white'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')}>
                {PRIORITY_LABELS[p]}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Responsável pela execução" hint={canAssignOthers ? 'Sem responsável: o líder da área é avisado.' : 'Você pode assumir a pendência ou deixar para o líder da área atribuir.'}>
          {canAssignOthers ? (
            <UserSelect value={assignee} onChange={setAssignee} areaId={areaId} />
          ) : (
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Sem responsável (líder atribui)</option>
              <option value={me.id}>Eu ({me.name})</option>
            </Select>
          )}
        </Field>
        <Field label="Categoria do problema">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Selecione…</option>
            <optgroup label={area?.name ?? 'Área'}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
            {otherCategories.length > 0 && <optgroup label="Outras áreas">{otherCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>}
          </Select>
        </Field>

        <Field label="Tipo de referência">
          <Select value={assetType} onChange={(e) => setAssetType(e.target.value)}>
            <option value="">Não se aplica</option>
            {ASSET_TYPES.map((t) => <option key={t} value={t}>{ASSET_TYPE_LABELS[t]}</option>)}
          </Select>
        </Field>
        <Field label="Máquina, molde, item ou OP" hint="Sugestões do cadastro e de pendências anteriores.">
          <Input value={assetRef} onChange={(e) => setAssetRef(e.target.value)} list="asset-suggestions" maxLength={100} placeholder="Ex.: INJ-07, M-45, OP 12345" />
          <datalist id="asset-suggestions">{(assets.data ?? []).map((a: any) => <option key={`${a.type}-${a.code}`} value={a.code}>{a.description ?? ''}</option>)}</datalist>
        </Field>

        <Field label="Descrição / situação encontrada" className="sm:col-span-2">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
        </Field>

        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm sm:col-span-2">
          {safety && <ShieldAlert size={16} className="text-red-600" />}
          <span className={cx(safety && 'font-semibold text-red-700')}>Prazo automático: {dueText}</span>
          <span className="text-xs text-gray-500">— calculado pelo servidor no horário da fábrica.</span>
        </div>

        <button type="button" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 sm:col-span-2" onClick={() => setMore((v) => !v)}>
          {more ? <ChevronUp size={16} /> : <ChevronDown size={16} />} Mais campos (critério de conclusão, próxima ação, origem, anexos{canCustomDue ? ', prazo específico' : ''})
        </button>
        {more && (
          <>
            <Field label="Ação esperada / critério de conclusão" className="sm:col-span-2">
              <Textarea value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="Ex.: máquina operando sem vazamento por 1 turno" />
            </Field>
            <Field label="Próxima ação"><Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} maxLength={500} /></Field>
            <Field label="Origem">
              <Select value={source} onChange={(e) => setSource(e.target.value as any)}>
                <option value="fast_response">Fast Response</option>
                <option value="direto">Registro direto</option>
              </Select>
            </Field>
            <Field label="Evidências, fotos e anexos" className="sm:col-span-2">
              <Input type="file" multiple accept="image/*,video/mp4,video/quicktime,application/pdf,.docx,.xlsx,.pptx,.txt,.csv" onChange={(e) => setFiles(e.target.files)} />
            </Field>
            {canCustomDue && (
              <>
                <Field label="Prazo específico (exceção)" hint="Apenas para atividades complexas. Fica registrado com o prazo padrão original.">
                  <Input type="datetime-local" value={customDue} onChange={(e) => setCustomDue(e.target.value)} />
                </Field>
                <Field label="Justificativa do prazo" required={Boolean(customDue)}>
                  <Input value={customReason} onChange={(e) => setCustomReason(e.target.value)} disabled={!customDue} />
                </Field>
              </>
            )}
          </>
        )}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
