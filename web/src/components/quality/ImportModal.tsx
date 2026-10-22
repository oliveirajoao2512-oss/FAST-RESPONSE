import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, PencilLine, Plus, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ORIGIN_LABELS, type QualityOrigin } from '@shared/quality';
import { api, errorMessage } from '../../lib/api';
import { dmy } from '../../lib/quality';
import { useToast } from '../../lib/toast';
import { Button, cx, ErrorBox, Modal, Spinner } from '../ui';

interface Preview {
  filename: string;
  sheets: { name: string; origin: QualityOrigin; count: number }[];
  warnings: string[];
  created: { origin: QualityOrigin; number: string; partner: string | null; opened_on: string; description: string | null }[];
  updated: { origin: QualityOrigin; number: string; partner: string | null; edited: boolean; changes: string[] }[];
  unchanged: number;
  kept: number;
  committed: boolean;
}

const send = (file: File, commit: boolean, keepEdited: boolean) => {
  const fd = new FormData();
  fd.append('file', file);
  return api<Preview>('POST', `/api/quality/import?commit=${commit ? 1 : 0}&keepEdited=${keepEdited ? 1 : 0}`, fd);
};

export function ImportModal({ initialFile, onClose }: { initialFile?: File | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [keepEdited, setKeepEdited] = useState(true);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<'novas' | 'alteradas' | 'avisos' | null>(null);

  useEffect(() => {
    if (!file) return;
    setPreview(null);
    setError(null);
    setBusy(true);
    send(file, false, true).then(setPreview, setError).finally(() => setBusy(false));
  }, [file]);

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    if (!/\.xls[xm]$/i.test(f.name)) {
      setError(new Error('Selecione a planilha no formato Excel (.xlsx).'));
      return;
    }
    setFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files?.[0]);
  };
  const confirm = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await send(file, true, keepEdited);
      const upd = r.updated.length - r.kept;
      toast('ok', `Planilha importada: ${r.created.length} nova(s), ${upd} atualizada(s), ${r.unchanged} sem alteração.`);
      await qc.invalidateQueries({ queryKey: ['quality'] });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const edited = preview?.updated.filter((u) => u.edited).length ?? 0;
  const toApply = (preview?.updated.length ?? 0) - (keepEdited ? edited : 0);
  const nothing = preview && preview.created.length === 0 && toApply === 0;
  return (
    <Modal open onClose={onClose} wide title="Importar planilha Resposta Rápida"
      footer={(
        <>
          <Button onClick={onClose}>Cancelar</Button>
          {preview && <Button kind="primary" onClick={confirm} loading={busy} disabled={!!nothing}><Upload size={16} />{nothing ? 'Nada a importar' : 'Confirmar importação'}</Button>}
        </>
      )}>
      <div className="space-y-4">
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
          onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
          className={cx('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition', over ? 'border-brand-500 bg-brand-50' : 'border-gray-300 hover:border-brand-400 hover:bg-gray-50')}>
          <FileSpreadsheet size={32} className="text-emerald-700" />
          {file ? (
            <div className="text-sm"><span className="font-medium">{file.name}</span> <span className="text-gray-500">· clique para trocar</span></div>
          ) : (
            <>
              <div className="text-sm font-medium">Arraste a planilha aqui ou clique para escolher</div>
              <div className="text-xs text-gray-500">Abas NC Externa, NC Interna e NC Fornecedor (.xlsx). A aba CADASTRO alimenta as listas de sugestões.</div>
            </>
          )}
          <input ref={input} type="file" accept=".xlsx,.xlsm" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        </div>

        {busy && !preview && <Spinner label="Lendo a planilha…" />}
        {error != null && <ErrorBox error={error} />}

        {preview && (
          <>
            <p className="text-sm text-gray-600">
              Prévia — nada foi gravado ainda. Abas lidas: {preview.sheets.map((s) => `${s.name} (${s.count})`).join(', ')}.
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Summary icon={<Plus size={16} />} label="Novas" value={preview.created.length} tone="text-emerald-700" onClick={() => setOpen(open === 'novas' ? null : 'novas')} />
              <Summary icon={<PencilLine size={16} />} label="Atualizadas" value={toApply} tone="text-blue-700" onClick={() => setOpen(open === 'alteradas' ? null : 'alteradas')} />
              <Summary icon={<CheckCircle2 size={16} />} label="Sem alteração" value={preview.unchanged + (keepEdited ? edited : 0)} tone="text-gray-700" />
              <Summary icon={<AlertTriangle size={16} />} label="Avisos" value={preview.warnings.length} tone={preview.warnings.length ? 'text-amber-700' : 'text-gray-700'} onClick={() => setOpen(open === 'avisos' ? null : 'avisos')} />
            </div>

            {edited > 0 && (
              <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <input type="checkbox" className="mt-0.5" checked={keepEdited} onChange={(e) => setKeepEdited(e.target.checked)} />
                <span><b>{edited} ocorrência(s)</b> foram alteradas no sistema depois da última importação e estão diferentes na planilha.
                  Marcado: mantém o que está no sistema. Desmarcado: a planilha substitui.</span>
              </label>
            )}

            {open === 'novas' && (
              <List empty="Nenhuma ocorrência nova.">
                {preview.created.map((c) => (
                  <li key={`${c.origin}${c.number}`} className="py-1.5"><b className="tabular">{c.number}</b> · {ORIGIN_LABELS[c.origin]} · {c.partner ?? '—'} · {dmy(c.opened_on)}
                    {c.description && <div className="text-xs text-gray-500">{c.description}</div>}</li>
                ))}
              </List>
            )}
            {open === 'alteradas' && (
              <List empty="Nenhuma alteração.">
                {preview.updated.map((u) => (
                  <li key={`${u.origin}${u.number}`} className={cx('py-1.5', keepEdited && u.edited && 'opacity-50')}>
                    <b className="tabular">{u.number}</b> · {ORIGIN_LABELS[u.origin]} · {u.partner ?? '—'}
                    {u.edited && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-900">{keepEdited ? 'mantida como está no sistema' : 'editada no sistema — será substituída'}</span>}
                    <ul className="list-disc pl-5 text-xs text-gray-600">{u.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
                  </li>
                ))}
              </List>
            )}
            {open === 'avisos' && (
              <List empty="Nenhum aviso.">{preview.warnings.map((w, i) => <li key={i} className="py-1.5 text-amber-900">{w}</li>)}</List>
            )}
            <p className="text-xs text-gray-500">Ocorrências que não estão na planilha continuam no sistema. Toda importação fica registrada no histórico de cada ocorrência e na auditoria.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function Summary({ icon, label, value, tone, onClick }: { icon: React.ReactNode; label: string; value: number; tone: string; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={cx('rounded-xl border border-gray-200 px-3 py-2 text-left', onClick && 'hover:border-brand-400')}>
      <div className="flex items-center gap-1 text-xs text-gray-500">{icon}{label}</div>
      <div className={cx('text-2xl font-bold tabular', tone)}>{value}</div>
    </Tag>
  );
}

function List({ children, empty }: { children: React.ReactNode[]; empty: string }) {
  return children.length === 0 ? <p className="text-sm text-gray-500">{empty}</p> : <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border border-gray-200 px-3 text-sm">{children}</ul>;
}
