import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Camera, Check, Plus, Search, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { errorMessage, post } from '../lib/api';
import { fmtShort } from '../lib/format';
import { usePersistentState } from '../lib/hooks';
import { can, useMe } from '../lib/session';
import { useToast } from '../lib/toast';
import { useWoList, useWoOptions, type WorkOrder } from '../lib/workOrders';
import { Indicators } from '../components/os/Indicators';
import { NewWoModal } from '../components/os/NewWoModal';
import { WoHeadline, WoSituation, WoWhere } from '../components/os/parts';
import { WoDetail } from '../components/os/WoDetail';
import { Button, cx, Empty, ErrorBox, Input, Segmented, Spinner } from '../components/ui';

type Tab = 'fila' | 'finalizadas' | 'indicadores';

export function WorkOrdersPage() {
  const me = useMe();
  const opts = useWoOptions();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = usePersistentState<Tab>('fr-os-tab', 'fila');
  const [creating, setCreating] = useState(false);
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const openId = params.get('id');
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('id', id);
    else next.delete('id');
    setParams(next, { replace: !id });
  };
  // links from the reports page (?tab=indicadores) and the "Nova OS" shortcut (?nova=1)
  useEffect(() => {
    const t = params.get('tab') as Tab | null;
    const nova = params.get('nova') === '1';
    if (!t && !nova) return;
    if (t) setTab(t);
    if (nova) setCreating(true);
    const next = new URLSearchParams(params);
    next.delete('tab');
    next.delete('nova');
    setParams(next, { replace: true });
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const seeIndicators = !!opts.data?.canLead || can.viewReports(me);
  const current = tab === 'indicadores' && !seeIndicators ? 'fila' : tab;
  const open = useWoList('abertas', { q: term });
  const done = useWoList('finalizadas', { q: term }, current === 'finalizadas');
  const waiting = open.data?.filter((o) => o.status === 'aberta').length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-2xl font-bold">Ordens de Manutenção</h1>
        <Button kind="primary" className="min-h-11 px-5 text-base" onClick={() => setCreating(true)}><Plus size={20} />Abrir OS</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={current} onChange={setTab} options={[
          { value: 'fila', label: <>Fila{waiting ? <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs font-bold text-white">{waiting}</span> : null}</> },
          { value: 'finalizadas', label: 'Finalizadas' },
          ...(seeIndicators ? [{ value: 'indicadores' as Tab, label: 'Indicadores' }] : []),
        ]} />
        {current !== 'indicadores' && (
          <div className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Buscar OS, máquina, problema…" aria-label="Buscar OS" className="pl-9" />
          </div>
        )}
      </div>

      {current === 'fila' && <Queue q={open} canWork={!!opts.data?.canWork} onOpen={setOpen} meId={me.id} searching={!!term} />}
      {current === 'finalizadas' && (
        done.isLoading ? <Spinner /> : done.error ? <ErrorBox error={done.error} onRetry={() => done.refetch()} /> : !done.data?.length ? <Empty>Nenhuma OS finalizada{term ? ' com essa busca' : ''}.</Empty> : (
          <ul className="space-y-2">{done.data.map((o) => <WoCard key={o.id} o={o} meId={me.id} onOpen={() => setOpen(o.id)} />)}</ul>
        )
      )}
      {current === 'indicadores' && <Indicators />}

      {creating && <NewWoModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      {openId && <WoDetail id={openId} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Queue({ q, canWork, onOpen, meId, searching }: { q: ReturnType<typeof useWoList>; canWork: boolean; onOpen: (id: string) => void; meId: string; searching: boolean }) {
  const list = q.data ?? [];
  const { mine, forMe, rest } = useMemo(() => {
    const mineIds = new Set(list.filter((o) => o.workers.some((w) => w.id === meId)).map((o) => o.id));
    const forMeIds = new Set(list.filter((o) => !mineIds.has(o.id) && (o.transfer_to === meId || (o.status === 'aberta' && o.suggested_to === meId))).map((o) => o.id));
    return { mine: list.filter((o) => mineIds.has(o.id)), forMe: list.filter((o) => forMeIds.has(o.id)), rest: list.filter((o) => !mineIds.has(o.id) && !forMeIds.has(o.id)) };
  }, [list, meId]);
  const position = useMemo(() => new Map(list.filter((o) => o.status === 'aberta').map((o, i) => [o.id, i + 1])), [list]);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const counts = { aberta: 0, em_atendimento: 0, pausada: 0, critica: 0 };
  for (const o of list) {
    counts[o.status as 'aberta']++;
    if (o.priority === 'critica') counts.critica++;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
        <Chip tone="slate" n={counts.aberta} label="aguardando aceite" />
        <Chip tone="blue" n={counts.em_atendimento} label="em atendimento" />
        <Chip tone="amber" n={counts.pausada} label="pausadas" />
        {counts.critica > 0 && <Chip tone="red" n={counts.critica} label="críticas" />}
      </div>
      {!list.length && <Empty>{searching ? 'Nenhuma OS aberta com essa busca.' : 'Nenhuma OS aberta. Tudo em dia.'}</Empty>}
      {forMe.length > 0 && <Group title="Para você">{forMe.map((o) => <WoCard key={o.id} o={o} meId={meId} position={position.get(o.id)} canWork={canWork} onOpen={() => onOpen(o.id)} highlight />)}</Group>}
      {mine.length > 0 && <Group title="Você está atuando">{mine.map((o) => <WoCard key={o.id} o={o} meId={meId} onOpen={() => onOpen(o.id)} />)}</Group>}
      {rest.length > 0 && <Group title={mine.length || forMe.length ? 'Fila' : undefined}>{rest.map((o) => <WoCard key={o.id} o={o} meId={meId} position={position.get(o.id)} canWork={canWork} onOpen={() => onOpen(o.id)} />)}</Group>}
    </div>
  );
}

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section>
      {title && <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h2>}
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

const CHIP = { slate: 'bg-slate-100 text-slate-800', blue: 'bg-blue-50 text-blue-800', amber: 'bg-amber-50 text-amber-900', red: 'bg-red-600 text-white' };
function Chip({ n, label, tone }: { n: number; label: string; tone: keyof typeof CHIP }) {
  return <span className={cx('rounded-full px-3 py-1', CHIP[tone])}><b className="tabular">{n}</b> {label}</span>;
}

function WoCard({ o, meId, position, canWork, onOpen, highlight }: { o: WorkOrder; meId: string; position?: number; canWork?: boolean; onOpen: () => void; highlight?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      await post(`/api/os/${o.id}/aceitar`);
      await qc.invalidateQueries({ queryKey: ['os'] });
      toast('ok', `${o.code} aceita. Quem abriu já está vendo que você está atuando.`);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const quickAccept = canWork && (o.status === 'aberta' || o.transfer_to === meId) && !o.workers.some((w) => w.id === meId);
  return (
    <li>
      <div
        className={cx('flex flex-col gap-2 rounded-xl border bg-white p-3 transition hover:border-brand-400 hover:shadow-sm sm:flex-row sm:items-center sm:gap-4 sm:p-4',
          o.priority === 'critica' && o.status !== 'finalizada' ? 'border-l-4 border-red-200 border-l-red-600' : 'border-gray-200',
          highlight && 'ring-2 ring-amber-300')}>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 space-y-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300">
          <WoHeadline o={o} />
          <WoWhere o={o} />
          <span className="line-clamp-2 text-sm text-gray-800">{o.status === 'finalizada' && o.service_done ? <><span className="text-gray-500">Feito:</span> {o.service_done}</> : o.description}</span>
          <span className="block text-sm"><WoSituation o={o} meId={meId} position={position} /></span>
          {o.transfer_to === meId && <span className="flex items-center gap-1 text-sm font-medium text-amber-800"><ArrowRightLeft size={14} />{o.transfer_from_name} quer passar esta OS para você</span>}
          <span className="flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
            <span>Aberta por {o.opened_by_name} · {fmtShort(o.opened_at)}</span>
            {o.files > 0 && <span className="inline-flex items-center gap-1"><Camera size={12} />{o.files}</span>}
          </span>
        </button>
        {quickAccept && (
          <Button kind="primary" className="min-h-11 shrink-0 px-5" loading={busy} onClick={accept}>
            {o.transfer_to === meId ? <><Check size={18} />Assumir</> : <><Wrench size={18} />Aceitar</>}
          </Button>
        )}
      </div>
    </li>
  );
}
