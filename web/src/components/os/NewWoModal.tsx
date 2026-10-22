import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { WO_KIND_LABELS, WO_KINDS, type WoKind } from '@shared/maintenance';
import { api, get, post, qs } from '../../lib/api';
import { useMe } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { useWoList, useWoOptions } from '../../lib/workOrders';
import { Button, cx, ErrorBox, Field, Input, Select, Textarea } from '../ui';
import { WoStatusBadge } from './parts';

export async function uploadWoFiles(id: string, files: File[], purpose: 'abertura' | 'servico') {
  if (!files.length) return;
  const fd = new FormData();
  fd.append('purpose', purpose);
  for (const f of files) fd.append('file', f, f.name);
  await api('POST', `/api/os/${id}/attachments`, fd);
}

export function PhotoPicker({ files, onChange, label = 'Foto (opcional)' }: { files: File[]; onChange: (f: File[]) => void; label?: string }) {
  const urls = useMemo(() => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls]);
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      <div className="flex flex-wrap gap-2">
        {files.map((f, i) => (
          <div key={i} className="relative h-20 w-20 overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
            {urls[i] ? <img src={urls[i]!} alt={f.name} className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center p-1 text-center text-xs text-gray-500">{f.name}</span>}
            <button type="button" aria-label={`Remover ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}
              className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"><X size={14} /></button>
          </div>
        ))}
        <label className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-gray-300 text-xs text-gray-500 hover:border-brand-400 hover:text-brand-700">
          <Camera size={22} />Adicionar
          <input type="file" accept="image/*,video/*" multiple className="sr-only" onChange={(e) => { onChange([...files, ...Array.from(e.target.files ?? [])].slice(0, 6)); e.target.value = ''; }} />
        </label>
      </div>
    </div>
  );
}

export function NewWoModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const opts = useWoOptions();
  const openList = useWoList('abertas');
  const [areaId, setAreaId] = useState<number | ''>(me.area?.id ?? '');
  const [asset, setAsset] = useState('');
  const [kind, setKind] = useState<WoKind | null>(null);
  const [stopped, setStopped] = useState<boolean | null>(null);
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tried, setTried] = useState(false);

  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(asset.trim()), 250);
    return () => clearTimeout(t);
  }, [asset]);
  const suggestions = useQuery<{ code: string; description: string | null }[]>({ queryKey: ['os', 'assets', term], queryFn: () => get(`/api/os/assets${qs({ q: term })}`), staleTime: 60_000 });
  const sameMachine = (openList.data ?? []).filter((o) => term && o.asset_ref.trim().toLowerCase() === term.toLowerCase());

  const missing = { area: !areaId, asset: !asset.trim(), kind: !kind, stopped: stopped === null, description: !description.trim() };
  const submit = async () => {
    setTried(true);
    if (Object.values(missing).some(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: string; code: string }>('/api/os', { areaId, assetRef: asset.trim(), kind, machineStopped: stopped, description: description.trim() });
      try {
        await uploadWoFiles(r.id, files, 'abertura');
      } catch {
        toast('error', 'A OS foi aberta, mas a foto não foi enviada. Abra a OS e tente anexar de novo.');
      }
      toast('ok', `${r.code} aberta${stopped ? ' como crítica: a manutenção foi avisada' : ''}.`);
      await qc.invalidateQueries({ queryKey: ['os'] });
      onCreated(r.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const choice = (on: boolean, danger = false) => cx('rounded-lg border px-3 py-2.5 text-sm font-medium',
    on ? (danger ? 'border-red-600 bg-red-600 text-white' : 'border-brand-600 bg-brand-600 text-white') : 'border-gray-300 bg-white text-gray-800 hover:bg-gray-50');

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Abrir ordem de manutenção" className="flex max-h-[95vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">Abrir ordem de manutenção</h2>
          <button onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Fechar"><X size={20} /></button>
        </div>
        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Setor" required error={tried && missing.area ? 'Escolha o setor.' : undefined}>
              <Select value={areaId} onChange={(e) => setAreaId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Selecione…</option>
                {opts.data?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>
            <Field label="Máquina / dispositivo" required error={tried && missing.asset ? 'Informe onde atuar.' : undefined}>
              <Input value={asset} onChange={(e) => setAsset(e.target.value)} list="os-assets" placeholder="Ex.: INJ-07" autoComplete="off" maxLength={120} />
              <datalist id="os-assets">{suggestions.data?.map((s) => <option key={s.code} value={s.code}>{s.description ?? ''}</option>)}</datalist>
            </Field>
          </div>
          {sameMachine.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
              Já existe OS aberta para esta máquina:
              {sameMachine.map((o) => (
                <button key={o.id} type="button" onClick={() => onCreated(o.id)} className="mt-1 flex w-full items-center gap-2 text-left underline-offset-2 hover:underline">
                  <span className="font-mono text-xs">{o.code}</span><WoStatusBadge status={o.status} /><span className="truncate">{o.description}</span>
                </button>
              ))}
            </div>
          )}
          <div>
            <span className="mb-1 block text-sm font-medium text-gray-700">Tipo de manutenção <span className="text-red-600" aria-hidden>*</span></span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tipo de manutenção">
              {WO_KINDS.map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={choice(kind === k)} onClick={() => setKind(k)}>{WO_KIND_LABELS[k]}</button>)}
            </div>
            {tried && missing.kind && <span className="mt-1 block text-xs text-red-600" role="alert">Escolha o tipo.</span>}
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium text-gray-700">A máquina está parada? <span className="text-red-600" aria-hidden>*</span></span>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="A máquina está parada?">
              <button type="button" role="radio" aria-checked={stopped === true} className={choice(stopped === true, true)} onClick={() => setStopped(true)}>Sim, parada</button>
              <button type="button" role="radio" aria-checked={stopped === false} className={choice(stopped === false)} onClick={() => setStopped(false)}>Não</button>
            </div>
            {stopped && <span className="mt-1 block text-xs text-red-700">A OS entra como crítica e a manutenção é avisada na hora.</span>}
            {tried && missing.stopped && <span className="mt-1 block text-xs text-red-600" role="alert">Responda se a máquina está parada.</span>}
          </div>
          <Field label="O que está acontecendo?" required error={tried && missing.description ? 'Descreva o problema.' : undefined}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} placeholder="Ex.: vazamento de óleo no cilindro do molde" />
          </Field>
          <PhotoPicker files={files} onChange={setFiles} />
          {error != null && <ErrorBox error={error} />}
          <p className="text-xs text-gray-500">Solicitante, data e hora são registrados automaticamente.</p>
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button onClick={onClose}>Cancelar</Button>
          <Button kind="primary" onClick={submit} loading={busy}>Abrir OS</Button>
        </div>
      </div>
    </div>
  );
}
