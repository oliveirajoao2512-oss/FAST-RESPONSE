import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, CalendarDays, Camera, Check, ChevronLeft, ChevronRight, List, Lock, Plus, Search, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessage, post } from '../lib/api';
import { fmtShort } from '../lib/format';
import { usePersistentState } from '../lib/hooks';
import { useMe } from '../lib/session';
import { useToast } from '../lib/toast';
import { WO_DOMAIN, WO_DOMAINS, type WoDomain } from '@shared/maintenance';
import { useWoDomain, useWoList, useWoOptions, WoDomainProvider, type WorkOrder } from '../lib/workOrders';
import { AnalyticsDashboard } from '../components/os/Analytics';
import { Dashboard } from '../components/os/Dashboard';
import { NewWoModal } from '../components/os/NewWoModal';
import { WoHeadline, WoSituation, WoWhere } from '../components/os/parts';
import { WoDetail } from '../components/os/WoDetail';
import { Button, cx, Empty, ErrorBox, Input, Segmented, Spinner } from '../components/ui';

type Tab = 'fila' | 'finalizadas' | 'dashboard' | 'analise';

/** Maintenance orders (/os) and process adjustment orders (/ajustes) share this page. */
export function WorkOrdersPage({ domain }: { domain: WoDomain }) {
  return <WoDomainProvider value={domain}><Page key={domain} /></WoDomainProvider>;
}

function Page() {
  const me = useMe();
  const D = useWoDomain();
  const opts = useWoOptions();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const other = WO_DOMAIN[WO_DOMAINS.find((d) => WO_DOMAIN[d].path !== D.path)!];
  const [tab, setTab] = usePersistentState<Tab>(`fr-${D.short.toLowerCase()}-tab`, 'fila');
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
  // links from the reports page (?tab=dashboard) and the "Nova OS" shortcut (?nova=1)
  useEffect(() => {
    const raw = params.get('tab');
    const t = (raw === 'indicadores' ? 'dashboard' : raw) as Tab | null;
    const nova = params.get('nova') === '1';
    if (!t && !nova) return;
    if (t) setTab(t);
    if (nova) setCreating(true);
    const next = new URLSearchParams(params);
    next.delete('tab');
    next.delete('nova');
    setParams(next, { replace: true });
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  // the dashboard is only for the gestores and líderes of the team's area, the plant manager and the administrator
  const seeDashboard = !!opts.data?.canSeeDashboard;
  const current = (tab === 'dashboard' && !seeDashboard) || (tab === 'analise' && me.role !== 'admin') ? 'fila' : tab;
  const open = useWoList('abertas', { q: term });
  // finished orders, month by month (current month first); a search looks in every month
  const [month, setMonthRaw] = useState(thisMonth);
  const [finView, setFinView] = usePersistentState<'lista' | 'calendario'>(`fr-${D.short.toLowerCase()}-finview`, 'lista');
  const [day, setDay] = useState<string | null>(null);
  const setMonth = (m: string) => { setMonthRaw(m); setDay(null); };
  const range = monthRange(month);
  const done = useWoList('finalizadas', term ? { q: term } : { from: range.from, to: range.to }, current === 'finalizadas');
  const canAnalyze = !!opts.data?.canAnalyze;
  const waiting = open.data?.filter((o) => o.status === 'aberta' || (canAnalyze && o.status === 'em_analise')).length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-2xl font-bold">{D.title}</h1>
        {/* the other module's order can be opened from here too (a processista opening an OS, a manutentor an OA) */}
        <Button className="min-h-11 px-4 text-base" onClick={() => navigate(`${other.path}?nova=1`)} title={`Abrir uma ${other.title.replace('Ordens', 'Ordem')}`}><Plus size={20} />Abrir {other.short}</Button>
        <Button kind="primary" className="min-h-11 px-5 text-base" onClick={() => setCreating(true)}><Plus size={20} />Abrir {D.short}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={current} onChange={setTab} options={[
          { value: 'fila', label: <>Fila{waiting ? <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs font-bold text-white">{waiting}</span> : null}</> },
          { value: 'finalizadas', label: 'Finalizadas' },
          ...(seeDashboard ? [{ value: 'dashboard' as Tab, label: 'Dashboard' }] : []),
          // new analytical dashboard, in test: only the administrator sees it until it is released
          ...(me.role === 'admin' ? [{ value: 'analise' as Tab, label: 'Dashboard (novo)' }] : []),
        ]} />
        {current !== 'dashboard' && current !== 'analise' && (
          <div className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Buscar ${D.short}, máquina, problema…`} aria-label={`Buscar ${D.short}`} className="pl-9" />
          </div>
        )}
      </div>

      {current === 'fila' && <Queue q={open} canWork={!!opts.data?.canWork} canAnalyze={canAnalyze} onOpen={setOpen} meId={me.id} searching={!!term} onAt={opts.data?.busy?.[me.id]} />}
      {current === 'finalizadas' && (
        <div className="space-y-3">
          {term ? (
            <p className="text-sm text-gray-600">Buscando “{term}” em todos os meses{done.data ? ` · ${done.data.length} ${done.data.length === 1 ? 'resultado' : 'resultados'}` : ''}.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <MonthNav month={month} onChange={setMonth} count={done.data?.length} />
              <div className="ml-auto"><Segmented value={finView} onChange={setFinView} options={[
                { value: 'lista', label: <span className="flex items-center gap-1.5"><List size={15} />Lista</span> },
                { value: 'calendario', label: <span className="flex items-center gap-1.5"><CalendarDays size={15} />Calendário</span> },
              ]} /></div>
            </div>
          )}
          {done.isLoading ? <Spinner /> : done.error ? <ErrorBox error={done.error} onRetry={() => done.refetch()} /> : !done.data?.length ? (
            <Empty>{term ? `Nenhuma ${D.short} finalizada com essa busca.` : `Nenhuma ${D.short} finalizada em ${monthLabel(month).toLowerCase()}.`}</Empty>
          ) : term ? (
            groupByMonth(done.data).map(([m, list]) => (
              <section key={m}>
                <h2 className="mb-2 mt-1 flex items-baseline gap-2 text-sm font-semibold text-gray-700">{monthLabel(m)}<span className="font-normal normal-case text-gray-500">{list.length}</span></h2>
                <ul className="space-y-2">{list.map((o) => <WoCard key={o.id} o={o} meId={me.id} onOpen={() => setOpen(o.id)} />)}</ul>
              </section>
            ))
          ) : finView === 'calendario' ? (
            <FinishedCalendar month={month} list={done.data} day={day} onDay={setDay} meId={me.id} onOpen={setOpen} />
          ) : (
            groupByDay(done.data).map(([d, list]) => (
              <section key={d}>
                <h2 className="mb-2 mt-1 flex items-baseline gap-2 text-sm font-semibold text-gray-700">{dayLabel(d)}<span className="font-normal text-gray-500">{list.length}</span></h2>
                <ul className="space-y-2">{list.map((o) => <WoCard key={o.id} o={o} meId={me.id} onOpen={() => setOpen(o.id)} />)}</ul>
              </section>
            ))
          )}
        </div>
      )}
      {current === 'dashboard' && <Dashboard onOpen={setOpen} />}
      {current === 'analise' && <AnalyticsDashboard onOpen={setOpen} />}

      {creating && <NewWoModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      {openId && <WoDetail id={openId} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ------------------------------------------------------------ months of the "Finalizadas" tab

const pad = (n: number) => String(n).padStart(2, '0');
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
function monthRange(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return { from: `${m}-01`, to: `${m}-${pad(new Date(y, mo, 0).getDate())}` };
}
const shiftMonth = (m: string, by: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + by, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); const t = new Date(y, mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1); };
const finishedMonth = (o: WorkOrder) => { const d = new Date(o.finished_at ?? o.analyzed_at ?? o.cancelled_at ?? o.opened_at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
function groupByMonth(list: WorkOrder[]): [string, WorkOrder[]][] {
  const m = new Map<string, WorkOrder[]>();
  for (const o of list) m.set(finishedMonth(o), [...(m.get(finishedMonth(o)) ?? []), o]);
  return [...m.entries()].sort(([a], [b]) => b.localeCompare(a));
}

// ------------------------------------------------------------ days of the "Finalizadas" tab: list by day and calendar

const finishedDay = (o: WorkOrder) => { const d = new Date(o.finished_at ?? o.analyzed_at ?? o.cancelled_at ?? o.opened_at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const todayKey = () => finishedDay({ finished_at: new Date().toISOString() } as WorkOrder);
function groupByDay(list: WorkOrder[]): [string, WorkOrder[]][] {
  const m = new Map<string, WorkOrder[]>();
  for (const o of list) { const k = finishedDay(o); m.set(k, [...(m.get(k) ?? []), o]); }
  return [...m.entries()].sort(([a], [b]) => b.localeCompare(a));
}
/** "Hoje · terça, 17/11", "Ontem · segunda, 16/11", "Sexta, 13/11" */
const dayLabel = (k: string) => {
  const [y, mo, d] = k.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  const t = date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
  const now = new Date();
  const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - date.getTime()) / 86_400_000);
  return diff === 0 ? `Hoje · ${t}` : diff === 1 ? `Ontem · ${t}` : t[0].toUpperCase() + t.slice(1);
};
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** Month grid: how many orders were finished each day (and how many with the machine stopped); a day shows its orders. */
function FinishedCalendar({ month, list, day, onDay, meId, onOpen }: {
  month: string; list: WorkOrder[]; day: string | null; onDay: (d: string | null) => void; meId: string; onOpen: (id: string) => void;
}) {
  const { short: S } = useWoDomain();
  const byDay = useMemo(() => new Map(groupByDay(list)), [list]);
  const [y, mo] = month.split('-').map(Number);
  const first = new Date(y, mo - 1, 1).getDay();
  const days = new Date(y, mo, 0).getDate();
  const today = todayKey();
  const max = Math.max(1, ...[...byDay.values()].map((l) => l.length));
  const cells: (string | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${pad(i + 1)}`)];
  while (cells.length % 7) cells.push(null);
  // with no day chosen, the latest day with orders is shown
  const shown = day ?? groupByDay(list)[0]?.[0] ?? null;
  const items = shown ? byDay.get(shown) ?? [] : [];
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          {WEEKDAYS.map((w) => <div key={w} className="py-1.5">{w}</div>)}
        </div>
        <div className="grid grid-cols-7" role="grid" aria-label={`Ordens finalizadas por dia em ${monthLabel(month).toLowerCase()}`}>
          {cells.map((k, i) => {
            if (!k) return <div key={i} className="min-h-14 border-b border-r border-gray-100 bg-gray-50/60 sm:min-h-20" />;
            const l = byDay.get(k) ?? [];
            const stopped = l.filter((o) => o.machine_stopped).length;
            const future = k > today;
            const sel = k === shown;
            const n = Number(k.slice(8));
            return (
              <button key={k} type="button" role="gridcell" aria-selected={sel} disabled={future || !l.length}
                aria-label={`${n}: ${l.length ? `${l.length} ${l.length === 1 ? `${S} finalizada` : `${S} finalizadas`}${stopped ? `, ${stopped} com máquina parada` : ''}` : 'nenhuma'}`}
                onClick={() => onDay(k)}
                className={cx('relative flex min-h-14 flex-col items-start border-b border-r border-gray-100 p-1 text-left sm:min-h-20 sm:p-1.5',
                  sel ? 'bg-brand-600 text-white' : l.length ? 'hover:bg-brand-50' : 'text-gray-400',
                  future && 'bg-gray-50/60')}>
                <span className={cx('text-xs font-semibold', k === today && !sel && 'rounded-full bg-gray-900 px-1.5 text-white')}>{n}</span>
                {l.length > 0 && (
                  <span className="mt-auto flex w-full flex-col gap-0.5">
                    <span className={cx('text-sm font-bold leading-none sm:text-base', !sel && 'text-gray-900')}>{l.length}<span className={cx('ml-0.5 hidden text-[11px] font-normal sm:inline', sel ? 'text-white/80' : 'text-gray-500')}>{S}</span></span>
                    {/* bar shows the day's volume against the busiest day of the month */}
                    <span className={cx('h-1 rounded-full', sel ? 'bg-white/70' : 'bg-brand-400')} style={{ width: `${Math.max(15, (l.length / max) * 100)}%` }} />
                    {stopped > 0 && <span className={cx('truncate text-[10px] font-medium leading-tight', sel ? 'text-white' : 'text-red-700')}>{stopped} parada{stopped > 1 ? 's' : ''}</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {shown ? (
        <section>
          <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-gray-700">{dayLabel(shown)}<span className="font-normal text-gray-500">{items.length} {items.length === 1 ? `${S} finalizada` : `${S} finalizadas`}</span></h2>
          <ul className="space-y-2">{items.map((o) => <WoCard key={o.id} o={o} meId={meId} onOpen={() => onOpen(o.id)} />)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function MonthNav({ month, onChange, count }: { month: string; onChange: (m: string) => void; count?: number }) {
  const { short: S } = useWoDomain();
  const now = thisMonth();
  const months = useMemo(() => Array.from({ length: 24 }, (_, i) => shiftMonth(now, -i)), [now]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center rounded-lg border border-gray-300 bg-white">
        <button type="button" className="p-2 text-gray-600 hover:bg-gray-50" aria-label="Mês anterior" onClick={() => onChange(shiftMonth(month, -1))}><ChevronLeft size={18} /></button>
        <select value={month} onChange={(e) => onChange(e.target.value)} aria-label="Mês" className="border-0 bg-transparent py-1.5 pl-1 pr-7 text-sm font-semibold focus:ring-0">
          {(months.includes(month) ? months : [month, ...months]).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <button type="button" className="p-2 text-gray-600 hover:bg-gray-50 disabled:opacity-30" aria-label="Próximo mês" disabled={month >= now} onClick={() => onChange(shiftMonth(month, 1))}><ChevronRight size={18} /></button>
      </div>
      {month !== now && <Button size="sm" kind="ghost" onClick={() => onChange(now)}>Mês atual</Button>}
      {count != null && <span className="text-sm text-gray-600">{count} {count === 1 ? `${S} finalizada` : `${S} finalizadas`}</span>}
    </div>
  );
}

function Queue({ q, canWork, canAnalyze, onOpen, meId, searching, onAt }: { q: ReturnType<typeof useWoList>; canWork: boolean; canAnalyze: boolean; onOpen: (id: string) => void; meId: string; searching: boolean; onAt?: { code: string; id: string; domain: WoDomain } }) {
  const { short: S } = useWoDomain();
  const navigate = useNavigate();
  const list = q.data ?? [];
  const { mine, forMe, rest, analysis, planned } = useMemo(() => {
    const byDate = (a: WorkOrder, b: WorkOrder) => new Date(a.planned_start ?? a.opened_at).getTime() - new Date(b.planned_start ?? b.opened_at).getTime();
    const mineIds = new Set(list.filter((o) => o.workers.some((w) => w.id === meId)).map((o) => o.id));
    const forMeIds = new Set(list.filter((o) => !mineIds.has(o.id) && (o.transfer_to === meId || (['aberta', 'programada'].includes(o.status) && o.suggested_to === meId))).map((o) => o.id));
    const free = list.filter((o) => !mineIds.has(o.id) && !forMeIds.has(o.id));
    return {
      mine: list.filter((o) => mineIds.has(o.id)), forMe: list.filter((o) => forMeIds.has(o.id)),
      rest: free.filter((o) => o.status !== 'em_analise' && o.status !== 'programada'),
      analysis: free.filter((o) => o.status === 'em_analise').sort(byDate),
      planned: free.filter((o) => o.status === 'programada').sort(byDate),
    };
  }, [list, meId]);
  const position = useMemo(() => new Map(list.filter((o) => o.status === 'aberta').map((o, i) => [o.id, i + 1])), [list]);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const counts = { aberta: 0, em_atendimento: 0, pausada: 0, programada: 0, em_analise: 0, critica: 0 };
  for (const o of list) {
    if (o.status in counts) counts[o.status as 'aberta']++;
    if (o.priority === 'critica') counts.critica++;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
        <Chip tone="slate" n={counts.aberta} label="aguardando aceite" />
        <Chip tone="blue" n={counts.em_atendimento} label="em atendimento" />
        <Chip tone="amber" n={counts.pausada} label="pausadas" />
        {counts.programada > 0 && <Chip tone="indigo" n={counts.programada} label="programadas" />}
        {counts.em_analise > 0 && <Chip tone="violet" n={counts.em_analise} label="aguardando o gestor de Manutenção" />}
        {counts.critica > 0 && <Chip tone="red" n={counts.critica} label="críticas" />}
      </div>
      {canWork && onAt && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900" role="status">
          <Lock size={16} className="shrink-0" />
          <span className="min-w-[12rem] flex-1">Você está atuando na <b>{onAt.code}</b>. Uma ordem por vez: finalize, devolva ou saia dela para aceitar outra.</span>
          {/* the order is shown right below when it is of this module; an order of the other module gets a link */}
          {!list.some((o) => o.id === onAt.id) && <Button size="sm" onClick={() => navigate(`${onAt.domain === 'ajuste' ? '/ajustes' : '/os'}?id=${onAt.id}`)}>Abrir {onAt.code}</Button>}
        </div>
      )}
      {canAnalyze && analysis.length > 0 && <Group title="Manutenções programadas para você analisar">{analysis.map((o) => <WoCard key={o.id} o={o} meId={meId} onOpen={() => onOpen(o.id)} highlight />)}</Group>}
      {!list.length && <Empty>{searching ? `Nenhuma ${S} aberta com essa busca.` : `Nenhuma ${S} aberta. Tudo em dia.`}</Empty>}
      {forMe.length > 0 && <Group title="Para você">{forMe.map((o) => <WoCard key={o.id} o={o} meId={meId} position={position.get(o.id)} canWork={canWork && !onAt} onOpen={() => onOpen(o.id)} highlight />)}</Group>}
      {mine.length > 0 && <Group title="Você está atuando">{mine.map((o) => <WoCard key={o.id} o={o} meId={meId} onOpen={() => onOpen(o.id)} />)}</Group>}
      {rest.length > 0 && <Group title={mine.length || forMe.length || (canAnalyze && analysis.length) ? 'Fila' : undefined}>{rest.map((o) => <WoCard key={o.id} o={o} meId={meId} position={position.get(o.id)} canWork={canWork && !onAt} onOpen={() => onOpen(o.id)} />)}</Group>}
      {planned.length > 0 && <Group title="Manutenções programadas">{planned.map((o) => <WoCard key={o.id} o={o} meId={meId} canWork={canWork && !onAt} onOpen={() => onOpen(o.id)} />)}</Group>}
      {!canAnalyze && analysis.length > 0 && <Group title="Aguardando o gestor de Manutenção">{analysis.map((o) => <WoCard key={o.id} o={o} meId={meId} onOpen={() => onOpen(o.id)} />)}</Group>}
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

const CHIP = { slate: 'bg-slate-100 text-slate-800', blue: 'bg-blue-50 text-blue-800', amber: 'bg-amber-50 text-amber-900', red: 'bg-red-600 text-white', indigo: 'bg-indigo-50 text-indigo-800', violet: 'bg-violet-50 text-violet-800' };
function Chip({ n, label, tone }: { n: number; label: string; tone: keyof typeof CHIP }) {
  return <span className={cx('rounded-full px-3 py-1', CHIP[tone])}><b className="tabular">{n}</b> {label}</span>;
}

function WoCard({ o, meId, position, canWork, onOpen, highlight }: { o: WorkOrder; meId: string; position?: number; canWork?: boolean; onOpen: () => void; highlight?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { api, short: S } = useWoDomain();
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      await post(`${api}/${o.id}/aceitar`);
      await qc.invalidateQueries({ queryKey: ['os'] });
      toast('ok', `${o.code} aceita. Quem abriu já está vendo que você está atuando.`);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const quickAccept = canWork && (o.status === 'aberta' || o.status === 'programada' || o.transfer_to === meId) && !o.workers.some((w) => w.id === meId);
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
          {o.transfer_to === meId && <span className="flex items-center gap-1 text-sm font-medium text-amber-800"><ArrowRightLeft size={14} />{o.transfer_from_name} quer passar esta {S} para você</span>}
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
