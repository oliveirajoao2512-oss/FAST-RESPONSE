import { useQueryClient } from '@tanstack/react-query';
import { Camera, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ADJ_MATERIAL_REASON, ADJ_REASON_CODES, ADJ_REASONS, domainLocations, WO_KIND_LABELS, WO_KINDS, WO_LOCATION_LABELS, type WoKind, type WoLocation } from '@shared/maintenance';
import { api as request, post } from '../../lib/api';
import { useMe } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { useWoDomain, useWoList, useWoOptions } from '../../lib/workOrders';
import { Button, cx, ErrorBox, Field, Input, Select, Textarea } from '../ui';
import { WoStatusBadge } from './parts';

export async function uploadWoFiles(api: string, id: string, files: File[], purpose: 'abertura' | 'servico') {
  if (!files.length) return;
  const fd = new FormData();
  fd.append('purpose', purpose);
  for (const f of files) fd.append('file', f, f.name);
  await request('POST', `${api}/${id}/attachments`, fd);
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
  const D = useWoDomain();
  const adj = D.d === 'ajuste';
  const opts = useWoOptions();
  const openList = useWoList('abertas');
  const [areaId, setAreaId] = useState<number | ''>(me.area?.id ?? '');
  const [asset, setAsset] = useState('');
  const [kind, setKind] = useState<WoKind | null>(null);
  const [reason, setReason] = useState<number | null>(null);
  const [partNumber, setPartNumber] = useState('');
  const [virgin, setVirgin] = useState('');
  const [regrind, setRegrind] = useState('');
  const [stopped, setStopped] = useState<boolean | null>(null);
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tried, setTried] = useState(false);

  // where: machine or assembly cell (adjustments only on machines), then the registered list of that kind
  const locations = domainLocations(D.d);
  const [location, setLocation] = useState<WoLocation | null>(locations.length === 1 ? locations[0] : null);
  const places = location ? opts.data?.places?.[location] ?? [] : [];
  const sameMachine = (openList.data ?? []).filter((o) => asset && o.asset_ref.trim().toLowerCase() === asset.toLowerCase());

  const stoppedQuestion = location === 'montagem' ? 'A montagem está parada?' : 'A máquina está parada?';
  const askMaterial = adj && reason === ADJ_MATERIAL_REASON;
  const pctOk = (v: string) => v.trim() !== '' && Number(v) >= 0 && Number(v) <= 100;
  const missing = {
    area: !areaId, location: !location, asset: !asset.trim(), kind: adj ? !reason : !kind, stopped: stopped === null, description: !description.trim(),
    material: askMaterial && (!pctOk(virgin) || !pctOk(regrind)),
  };
  const submit = async () => {
    setTried(true);
    if (Object.values(missing).some(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: string; code: string }>(D.api, {
        areaId, location, assetRef: asset.trim(), machineStopped: stopped, description: description.trim(),
        ...(adj
          ? { reason, partNumber: partNumber.trim() || null, ...(askMaterial ? { virginPct: Number(virgin), regrindPct: Number(regrind) } : {}) }
          : { kind }),
      });
      try {
        await uploadWoFiles(D.api, r.id, files, 'abertura');
      } catch {
        toast('error', `A ${D.short} foi aberta, mas a foto não foi enviada. Abra a ${D.short} e tente anexar de novo.`);
      }
      toast('ok', `${r.code} aberta${stopped ? ` como crítica: a equipe de ${D.team} foi avisada` : ''}. O comprovante em PDF já está disponível.`);
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
      <div role="dialog" aria-modal="true" aria-label={`Abrir ordem de ${adj ? 'ajuste' : 'manutenção'}`} className="flex max-h-[95vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">Abrir ordem de {adj ? 'ajuste' : 'manutenção'}</h2>
          <button onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Fechar"><X size={20} /></button>
        </div>
        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <Field label="Setor" required error={tried && missing.area ? 'Escolha o setor.' : undefined}>
            <Select value={areaId} onChange={(e) => setAreaId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Selecione…</option>
              {opts.data?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          {locations.length > 1 && (
            <div>
              <span className="mb-1 block text-sm font-medium text-gray-700">Onde é? <span className="text-red-600" aria-hidden>*</span></span>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Onde é?">
                {locations.map((l) => (
                  <button key={l} type="button" role="radio" aria-checked={location === l} className={choice(location === l)}
                    onClick={() => { if (l !== location) setAsset(''); setLocation(l); }}>{WO_LOCATION_LABELS[l]}</button>
                ))}
              </div>
              {tried && missing.location && <span className="mt-1 block text-xs text-red-600" role="alert">Escolha máquina ou montagem.</span>}
            </div>
          )}
          {location && (
            <div>
              <span className="mb-1 block text-sm font-medium text-gray-700">{WO_LOCATION_LABELS[location]} <span className="text-red-600" aria-hidden>*</span></span>
              {places.length ? (
                <div className="grid max-h-48 grid-cols-3 gap-1.5 overflow-y-auto rounded-lg border border-gray-200 p-1.5 sm:grid-cols-4" role="radiogroup" aria-label={WO_LOCATION_LABELS[location]}>
                  {places.map((p) => (
                    <button key={p.code} type="button" role="radio" aria-checked={asset === p.code} title={p.description ?? undefined} onClick={() => setAsset(p.code)}
                      className={cx('rounded-md border px-2 py-2 text-sm font-medium', asset === p.code ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50')}>
                      {p.code}
                    </button>
                  ))}
                </div>
              ) : <p className="text-sm text-gray-500">Nenhuma {location === 'montagem' ? 'montagem' : 'máquina'} cadastrada. Peça ao gestor para incluir em Gestão → Cadastros.</p>}
              {tried && missing.asset && <span className="mt-1 block text-xs text-red-600" role="alert">Escolha {location === 'montagem' ? 'a montagem' : 'a máquina'}.</span>}
            </div>
          )}
          {sameMachine.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
              Já existe {D.short} aberta para {location === 'montagem' ? 'esta montagem' : 'esta máquina'}:
              {sameMachine.map((o) => (
                <button key={o.id} type="button" onClick={() => onCreated(o.id)} className="mt-1 flex w-full items-center gap-2 text-left underline-offset-2 hover:underline">
                  <span className="font-mono text-xs">{o.code}</span><WoStatusBadge status={o.status} /><span className="truncate">{o.description}</span>
                </button>
              ))}
            </div>
          )}
          {adj ? (
            <div>
              <span className="mb-1 block text-sm font-medium text-gray-700">Motivo <span className="text-red-600" aria-hidden>*</span></span>
              <div className="grid max-h-64 gap-1.5 overflow-y-auto rounded-lg border border-gray-200 p-1.5 sm:grid-cols-2" role="radiogroup" aria-label="Motivo">
                {ADJ_REASON_CODES.map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={reason === n} onClick={() => setReason(n)}
                    className={cx('flex items-start gap-2 rounded-md border px-2.5 py-2 text-left text-sm',
                      reason === n ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50')}>
                    <span className={cx('w-5 shrink-0 text-right font-mono text-xs leading-5', reason === n ? 'text-white' : 'text-gray-400')}>{n}</span>{ADJ_REASONS[n]}
                  </button>
                ))}
              </div>
              {tried && missing.kind && <span className="mt-1 block text-xs text-red-600" role="alert">Escolha o motivo.</span>}
            </div>
          ) : (
            <div>
              <span className="mb-1 block text-sm font-medium text-gray-700">Tipo de manutenção <span className="text-red-600" aria-hidden>*</span></span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tipo de manutenção">
                {WO_KINDS.map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={choice(kind === k)} onClick={() => setKind(k)}>{WO_KIND_LABELS[k]}</button>)}
              </div>
              {tried && missing.kind && <span className="mt-1 block text-xs text-red-600" role="alert">Escolha o tipo.</span>}
            </div>
          )}
          {askMaterial && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="% de material virgem" required error={tried && !pctOk(virgin) ? 'Informe de 0 a 100.' : undefined}>
                <Input type="number" inputMode="decimal" min={0} max={100} value={virgin} onChange={(e) => setVirgin(e.target.value)} />
              </Field>
              <Field label="% de moído" required error={tried && !pctOk(regrind) ? 'Informe de 0 a 100.' : undefined}>
                <Input type="number" inputMode="decimal" min={0} max={100} value={regrind} onChange={(e) => setRegrind(e.target.value)} />
              </Field>
            </div>
          )}
          {adj && (
            <Field label="Part number">
              <Input value={partNumber} onChange={(e) => setPartNumber(e.target.value)} maxLength={60} placeholder="Opcional" autoComplete="off" />
            </Field>
          )}
          <div>
            <span className="mb-1 block text-sm font-medium text-gray-700">{stoppedQuestion} <span className="text-red-600" aria-hidden>*</span></span>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={stoppedQuestion}>
              <button type="button" role="radio" aria-checked={stopped === true} className={choice(stopped === true, true)} onClick={() => setStopped(true)}>Sim, parada</button>
              <button type="button" role="radio" aria-checked={stopped === false} className={choice(stopped === false)} onClick={() => setStopped(false)}>Não</button>
            </div>
            {stopped && <span className="mt-1 block text-xs text-red-700">A {D.short} entra como crítica e a equipe de {D.team} é avisada na hora.</span>}
            {tried && missing.stopped && <span className="mt-1 block text-xs text-red-600" role="alert">Responda se a máquina está parada.</span>}
          </div>
          <Field label={adj ? 'Motivo / problema da parada' : 'O que está acontecendo e onde é o problema?'} required error={tried && missing.description ? 'Descreva o problema.' : undefined}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} placeholder={adj ? 'O que está acontecendo e onde é o problema. Ex.: peça saindo com peso abaixo do especificado' : 'O que está acontecendo e onde é o problema. Ex.: vazamento de óleo no cilindro do molde'} />
          </Field>
          <PhotoPicker files={files} onChange={setFiles} />
          {error != null && <ErrorBox error={error} />}
          <p className="text-xs text-gray-500">Solicitante, data e hora são registrados automaticamente, e o comprovante em PDF fica disponível assim que a {D.short} é aberta.</p>
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button onClick={onClose}>Cancelar</Button>
          <Button kind="primary" onClick={submit} loading={busy}>Abrir {D.short}</Button>
        </div>
      </div>
    </div>
  );
}
