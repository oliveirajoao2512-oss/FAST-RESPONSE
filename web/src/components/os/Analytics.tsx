import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, ChevronUp, Download, Filter, Info, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { get, qs, withSlot } from '../../lib/api';
import { num } from '../../lib/format';
import { useWoDomain } from '../../lib/workOrders';
import { cx, Empty, ErrorBox, Input, Select, Spinner } from '../ui';

/**
 * Analytical dashboard of one order module (OA or OS), BI style (João, 26/11/2026): few charts on the main screen,
 * every click opens a side panel with the details of what was clicked, and inside it the user keeps drilling
 * (problem → machine → technician → orders). Read only: every number comes from /api/{oa,os}/analytics with the
 * filters applied by the server; the browser only draws. In test: shown only to the administrator.
 */

// one hue per measure; categories get a fixed color from the period's frequency order (never by the current rank)
const C_QTY = '#2a78d6';
const C_TIME = '#ea6a1f';
const C_STOP = '#d03b3b';
const C_OTHER = '#c4c9d1';
const PALETTE = ['#2a78d6', '#ea6a1f', '#0f9d8a', '#7c5cd6', '#c99a1a', '#d6458b', '#1aa0c8', '#8a6a4a'];
const SHIFT_COLORS = ['#2a78d6', '#ea6a1f', '#0f9d8a', '#7c5cd6', '#64748b', '#c99a1a'];

type PeriodKey = 'hoje' | 'ontem' | '7d' | '30d' | 'mes' | 'anterior' | 'custom';
const PERIODS: { value: PeriodKey; label: string }[] = [
  { value: 'hoje', label: 'Hoje' }, { value: 'ontem', label: 'Ontem' }, { value: '7d', label: 'Últimos 7 dias' }, { value: '30d', label: 'Últimos 30 dias' },
  { value: 'mes', label: 'Mês atual' }, { value: 'anterior', label: 'Mês anterior' }, { value: 'custom', label: 'Personalizado' },
];
const iso = (d: Date) => d.toLocaleDateString('en-CA');
function rangeOf(p: PeriodKey, custom: { from: string; to: string }) {
  const now = new Date();
  const back = (n: number) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
  switch (p) {
    case 'hoje': return { from: iso(now), to: iso(now) };
    case 'ontem': return { from: back(1), to: back(1) };
    case '7d': return { from: back(6), to: iso(now) };
    case '30d': return { from: back(29), to: iso(now) };
    case 'anterior': return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case 'custom': return custom;
    default: return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  }
}

interface Stats { n: number; finished: number; timed: number; workH: number | null; avgMin: number | null; stops: number; stoppedH: number | null; mttrH: number | null }
interface Named { key: string; label: string; n: number }
interface Shift extends Stats { key: string; label: string; start: string; end: string; avgWaitMin: number | null; topAssets: (Named & { stoppedH: number | null })[]; topCategories: (Named & { stoppedH: number | null })[]; techs: { id: string; name: string; n: number }[] }
interface Analytics {
  domain: 'ajuste' | 'manutencao'; from: string; to: string; bucket: 'dia' | 'semana' | 'mes';
  criteria: { duration: string; stopped: string; shift: string; mtbf: string };
  kpis: Stats & {
    open: number; corrective: number; preventive: number; assets: number; pns: number; withPn: number; avgWaitMin: number | null; imported: number;
    topAsset: Named | null; topStopAsset: { key: string; label: string; stoppedH: number } | null; topPn: Named | null; topShift: (Named & { pct: number }) | null; topCategory: Named | null;
  };
  byShift: Shift[]; noShift: number;
  byAsset: (Stats & { key: string; label: string; topCategory: Named | null })[];
  byPn: (Stats & { key: string; label: string; topAsset: Named | null })[];
  byCategory: (Stats & { key: string; label: string })[];
  pareto: { key: string; label: string; n: number; cumPct: number }[];
  byComponent: (Stats & { key: string; label: string })[];
  byTool: Named[];
  byTech: { id: string; name: string; n: number; lead: number; helped: number; manH: number | null; avgMin: number | null; timed: number; workH: number | null }[];
  series: (Stats & { key: string; preventive: number; corrective: number })[];
  recurrence: { asset: string; assetLabel: string; category: string; categoryLabel: string; n: number; repeats: number; avgGapH: number | null; stoppedH: number | null }[];
  heat: number[][];
  quality: { excluded: number; long: number; instant: number; duplicates: [string, string][] };
  options: { shifts: string[]; techs: { id: string; name: string }[]; pns: { key: string; label: string }[]; assets: { key: string; label: string }[]; categories: { key: string; label: string }[]; categoryOrder?: string[]; components: { key: string; label: string }[]; hasImported: boolean };
}
interface RecordRow {
  id: string; code: string; imported: boolean; legacy: string | null; openedAt: string; shift: string | null; techs: string[]; pn: string | null; asset: string; category: string;
  type: string; durationMin: number | null; reliable: boolean; review: string | null; stopped: boolean; stoppedH: number | null; status: string; statusLabel: string;
  description: string; serviceDone: string | null; notes: string | null; openedBy: string; area: string;
}

interface F { shift: string; tech: string; pn: string; asset: string; category: string; type: string; component: string }
const EMPTY: F = { shift: '', tech: '', pn: '', asset: '', category: '', type: '', component: '' };

/** One step of the drill-down in the side panel. */
type Dim = 'category' | 'asset' | 'pn' | 'tech' | 'shift' | 'day' | 'all';
interface Drill { dim: Dim; key: string; label: string }
const DIM_LABEL = (adj: boolean): Record<Dim, string> => ({ category: adj ? 'Motivo' : 'Problema', asset: 'Máquina', pn: 'Part number', tech: 'Técnico', shift: 'Turno', day: 'Dia', all: 'Pesquisa' });

const min = (v: number | null | undefined) => (v == null ? '—' : v < 60 ? `${num(v)} min` : `${num(v / 60)} h`);
const hrs = (v: number | null | undefined) => (v == null ? '—' : v < 1 ? `${Math.round(v * 60)} min` : `${num(v)} h`);
const pct = (a: number, b: number) => (b ? `${num((a / b) * 100, 0)}%` : '—');
const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const bucketLabel = (key: string, b: Analytics['bucket']) => { const [y, m, d] = key.split('-'); return b === 'mes' ? `${MONTHS[+m - 1]}/${y.slice(2)}` : `${d}/${m}`; };

/** Global filters + the drill-down steps → query string of the analytics API. */
function paramsOf(range: { from: string; to: string }, f: F, imported: boolean, drill: Drill[] = []) {
  const p: Record<string, string> = { ...range, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), ...(imported ? {} : { imported: '0' }) };
  for (const s of drill) {
    if (s.dim === 'day') { p.from = s.key; p.to = s.key; }
    else if (s.dim !== 'all') p[s.dim] = s.key;
  }
  return p;
}

export function AnalyticsDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const D = useWoDomain();
  const adj = D.short === 'OA';
  const [period, setPeriod] = useState<PeriodKey>('mes');
  const [custom, setCustom] = useState(() => rangeOf('mes', { from: '', to: '' }));
  const [f, setF] = useState<F>(EMPTY);
  const [imported, setImported] = useState(true);
  const [drill, setDrill] = useState<Drill[]>([]);
  const range = rangeOf(period, custom);
  const params = paramsOf(range, f, imported);
  const r = useQuery<Analytics>({ queryKey: ['os', 'analytics', D.api, params], queryFn: () => get(`${D.api}/analytics${qs(params)}`), placeholderData: keepPreviousData });
  const d = r.data;
  const o = d?.options;
  const word = adj ? 'ajustes' : 'manutenções';
  const catWord = adj ? 'Motivo' : 'Tipo';

  // fixed color per category, from the period's frequency order
  const colorOf = useMemo(() => {
    const order = o?.categoryOrder ?? [];
    return (key: string) => { const i = order.indexOf(key); return i >= 0 && i < PALETTE.length ? PALETTE[i] : C_OTHER; };
  }, [o?.categoryOrder]);

  const open = (s: Drill) => setDrill([s]);
  const chips: [keyof F, string, string][] = [];
  if (f.shift) chips.push(['shift', 'Turno', f.shift]);
  if (f.tech) chips.push(['tech', 'Técnico', o?.techs.find((t) => t.id === f.tech)?.name ?? '…']);
  if (f.pn) chips.push(['pn', 'PN', f.pn === '-' ? 'Sem PN' : f.pn]);
  if (f.asset) chips.push(['asset', 'Máquina', o?.assets.find((a) => a.key === f.asset)?.label ?? f.asset]);
  if (f.category) chips.push(['category', catWord, o?.categories.find((c) => c.key === f.category)?.label ?? f.category]);
  if (f.type) chips.push(['type', 'Tipo', f.type === 'preventiva' ? 'Preventiva (programada)' : 'Corretiva']);
  if (f.component) chips.push(['component', 'Onde', o?.components.find((c) => c.key === f.component)?.label ?? f.component]);

  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
        <Info size={14} className="shrink-0" /><span><b>Em teste.</b> Só você está vendo. Números das {word} registradas no sistema, sem nenhum valor estimado.</span>
      </p>

      {/* global filters: they change every chart and every detail panel */}
      <section className="rounded-2xl bg-white p-3 ring-1 ring-gray-100">
        <div className="flex flex-wrap items-end gap-2">
          <Pick label="Período" value={period} onChange={(v) => setPeriod(v as PeriodKey)} options={PERIODS.map((p) => [p.value, p.label])} all={false} />
          {period === 'custom' && (<>
            <label className="flex w-[calc(50%-4px)] flex-col text-[11px] font-medium text-gray-500 sm:w-auto">De<Input type="date" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} className="mt-0.5 w-full sm:w-36" /></label>
            <label className="flex w-[calc(50%-4px)] flex-col text-[11px] font-medium text-gray-500 sm:w-auto">Até<Input type="date" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} className="mt-0.5 w-full sm:w-36" /></label>
          </>)}
          <Pick label="Turno" value={f.shift} onChange={(v) => setF({ ...f, shift: v })} options={(o?.shifts ?? []).map((s) => [s, s])} />
          <Pick label="Técnico" value={f.tech} onChange={(v) => setF({ ...f, tech: v })} options={(o?.techs ?? []).map((t) => [t.id, t.name])} wide />
          <Pick label="Part number" value={f.pn} onChange={(v) => setF({ ...f, pn: v })} options={(o?.pns ?? []).map((p) => [p.key, p.key === '-' ? 'Sem PN' : p.key])} />
          <Pick label="Máquina" value={f.asset} onChange={(v) => setF({ ...f, asset: v })} options={(o?.assets ?? []).map((a) => [a.key, a.label])} />
          <Pick label={catWord} value={f.category} onChange={(v) => setF({ ...f, category: v })} options={(o?.categories ?? []).map((c) => [c.key, c.label])} wide />
          {!adj && <Pick label="Corretiva / preventiva" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={[['corretiva', 'Corretiva'], ['preventiva', 'Preventiva (programada)']]} />}
          {!adj && <Pick label="Onde foi o problema" value={f.component} onChange={(v) => setF({ ...f, component: v })} options={(o?.components ?? []).map((c) => [c.key, c.label])} />}
          <button onClick={() => open({ dim: 'all', key: '', label: 'Todas as ordens' })} className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-lg bg-gray-900 px-3 text-sm font-medium text-white hover:bg-gray-700">
            <Search size={15} />Pesquisar ordens
          </button>
        </div>
        {(chips.length > 0 || o?.hasImported || r.isFetching) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {chips.map(([k, l, v]) => (
              <span key={k} className="inline-flex items-center gap-1 rounded-full bg-gray-900 py-0.5 pl-2.5 pr-1 text-xs font-medium text-white">
                {l}: {v}<button onClick={() => setF({ ...f, [k]: '' })} aria-label={`Tirar filtro ${l}`} className="rounded-full p-0.5 hover:bg-white/20"><X size={12} /></button>
              </span>
            ))}
            {chips.length > 0 && <button onClick={() => setF(EMPTY)} className="text-xs font-medium text-gray-600 underline">Limpar filtros</button>}
            {o?.hasImported && (
              <label className="inline-flex items-center gap-1.5 text-xs text-gray-600" title="OS de outubro trazidas da planilha antiga: sem PN, sem turno e sem hora de aceite">
                <input type="checkbox" checked={imported} onChange={(e) => setImported(e.target.checked)} /> Incluir histórico importado
              </label>
            )}
            {r.isFetching && <span className="text-xs text-gray-400">atualizando…</span>}
          </div>
        )}
      </section>

      {r.error && <ErrorBox error={r.error} onRetry={() => r.refetch()} />}
      {!d && !r.error && <Spinner />}
      {d && (d.kpis.n === 0 ? (
        <div className="rounded-2xl bg-white p-6 ring-1 ring-gray-100"><Empty>Nenhuma {adj ? 'OA' : 'OS'} com esses filtros. {chips.length ? 'Tire um dos filtros ou ' : ''}Escolha outro período.</Empty></div>
      ) : (<>
        <KpiStrip d={d} adj={adj} word={word} />
        {d.quality.excluded > 0 && (
          <p className="-mt-2 flex items-start gap-1.5 px-1 text-[11px] text-gray-500">
            <Info size={12} className="mt-0.5 shrink-0" />{d.quality.excluded} ordem(ns) com tempo duvidoso ficaram fora das médias ({d.quality.long} com mais de 24 h, {d.quality.instant} finalizada(s) em menos de 1 min). Continuam na contagem.
          </p>
        )}
        <div className="grid gap-4 xl:grid-cols-5">
          <Panel className="xl:col-span-2" title={adj ? 'Distribuição dos motivos' : 'Distribuição de problemas'} sub="clique numa fatia ou na legenda para ver o detalhe">
            <Donut rows={d.byCategory} colorOf={colorOf} onPick={(k, l) => open({ dim: 'category', key: k, label: l })} unit={adj ? 'ajustes' : 'OS'} />
          </Panel>
          <Panel className="xl:col-span-3" title="Tendência" sub={d.bucket === 'dia' ? 'clique num dia para ver as ordens dele' : `por ${d.bucket}`}>
            <Trend d={d} adj={adj} onDay={d.bucket === 'dia' ? (k) => open({ dim: 'day', key: k, label: new Date(`${k}T12:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' }) }) : undefined} />
          </Panel>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Máquinas" sub="clique numa máquina para ver o histórico dela">
            <MetricRanking adj={adj} rows={d.byAsset.map((a) => ({ key: a.key, label: a.label, n: a.n, h: a.workH, stop: a.stoppedH, avg: a.avgMin, note: a.topCategory?.label }))} onPick={(k, l) => open({ dim: 'asset', key: k, label: l })} />
          </Panel>
          <Panel title="Turnos" sub={`cada cor é um ${adj ? 'motivo' : 'tipo'} · clique num turno ou numa cor`}>
            <ShiftStack d={d} colorOf={colorOf} onShift={(k) => open({ dim: 'shift', key: k, label: k })}
              onPart={(s, c, l) => setDrill([{ dim: 'shift', key: s, label: s }, { dim: 'category', key: c, label: l }])} />
          </Panel>
          <Panel title="Técnicos" sub="clique num técnico para ver os atendimentos dele">
            <TechRanking rows={d.byTech} onPick={(k, l) => open({ dim: 'tech', key: k, label: l })} />
          </Panel>
          <Panel title="Part numbers" sub="clique num PN para ver as ocorrências dele">
            <MetricRanking adj={adj} pnMode rows={d.byPn.map((p) => ({ key: p.key, label: p.key === '-' ? 'Sem PN' : p.label, n: p.n, h: p.workH, stop: p.stoppedH, avg: p.avgMin, note: p.topAsset ? `mais na ${p.topAsset.label}` : undefined, muted: p.key === '-' }))}
              onPick={(k, l) => open({ dim: 'pn', key: k, label: l })} />
          </Panel>
        </div>
        <Panel title="Quando as ordens são abertas" sub="dia da semana × hora, com a faixa de cada turno">
          <Heat heat={d.heat} shifts={d.byShift.map((s, i) => ({ ...s, color: SHIFT_COLORS[i % SHIFT_COLORS.length] }))} />
        </Panel>
        <Criteria d={d} />
      </>))}

      {drill.length > 0 && d && (
        <DrillPanel key={drill.map((x) => x.dim + x.key).join('/')} api={D.api} adj={adj} drill={drill} setDrill={setDrill} base={{ range, f, imported }} totalN={d.kpis.n}
          colorOf={colorOf} onOpen={onOpen}
          onApply={(nf) => { setF(nf); setDrill([]); }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ building blocks

function Pick({ label, value, onChange, options, wide, all = true }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; wide?: boolean; all?: boolean }) {
  return (
    <label className="flex w-[calc(50%-4px)] flex-col text-[11px] font-medium text-gray-500 sm:w-auto">{label}
      <Select value={value} onChange={(e) => onChange(e.target.value)} className={cx('mt-0.5 w-full', wide ? 'sm:w-48' : 'sm:w-36')}>
        {all && <option value="">Todos</option>}
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
    </label>
  );
}

function Panel({ title, sub, right, children, className }: { title: string; sub?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('min-w-0 rounded-2xl bg-white p-4 ring-1 ring-gray-100 sm:p-5', className)}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>{sub && <p className="text-xs text-gray-500">{sub}</p>}</div>
        {right}
      </header>
      {children}
    </section>
  );
}

function Toggle<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="inline-flex rounded-lg bg-gray-100 p-0.5 text-xs font-medium">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={cx('rounded-md px-2.5 py-1 transition-colors', value === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800')}>{l}</button>
      ))}
    </div>
  );
}

function KpiStrip({ d, adj, word }: { d: Analytics; adj: boolean; word: string }) {
  const k = d.kpis;
  const items: [string, ReactNode, ReactNode, string?][] = [
    [`Total de ${word}`, k.n, `${k.finished} finalizadas · ${k.open} em aberto`, C_QTY],
    ['Tempo médio', min(k.avgMin), 'do aceite ao fim, sem pausas', C_TIME],
    ['Horas de trabalho', hrs(k.workH), `${k.timed} ordens com tempo confiável`, C_TIME],
    ['Máquina parada', hrs(k.stoppedH), `${k.stops} paradas${k.mttrH != null ? ` · MTTR ${hrs(k.mttrH)}` : ''}`, C_STOP],
    ['Tempo para aceitar', min(k.avgWaitMin), 'da abertura ao aceite'],
    [adj ? 'PN informado' : 'Corretivas / preventivas', adj ? pct(k.withPn, k.n) : `${k.corrective} / ${k.preventive}`, adj ? `${k.withPn} de ${k.n} ajustes` : 'preventiva = programada'],
  ];
  return (
    <section className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-gray-100 ring-1 ring-gray-100 sm:grid-cols-3 xl:grid-cols-6">
      {items.map(([l, v, s, c]) => (
        <div key={l} className="bg-white px-4 py-3.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">{c && <span className="h-2 w-2 rounded-full" style={{ background: c }} />}{l}</div>
          <div className={cx('mt-1 text-2xl font-semibold tabular leading-tight sm:text-[28px]', c === C_STOP ? 'text-red-700' : 'text-gray-900')}>{v}</div>
          <div className="mt-0.5 text-[11px] text-gray-500">{s}</div>
        </div>
      ))}
    </section>
  );
}

/** Donut with a compact legend; categories beyond the 7th are grouped as "Outros" in the ring but stay in the legend. */
function Donut({ rows, colorOf, onPick, unit }: { rows: { key: string; label: string; n: number }[]; colorOf: (k: string) => string; onPick: (k: string, l: string) => void; unit: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const list = [...rows].filter((r) => r.n).sort((a, b) => b.n - a.n);
  const total = list.reduce((a, b) => a + b.n, 0);
  const big = list.slice(0, 7);
  const rest = list.slice(7);
  const ring = [...big.map((r) => ({ ...r, color: colorOf(r.key) })), ...(rest.length ? [{ key: '__outros', label: `Outros (${rest.length})`, n: rest.reduce((a, b) => a + b.n, 0), color: C_OTHER }] : [])];
  const focus = ring.find((r) => r.key === hover);
  if (!total) return <Empty>Sem registros.</Empty>;
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[200px_1fr]">
      <div className="relative mx-auto h-[200px] w-[200px]">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={ring} dataKey="n" nameKey="label" innerRadius={64} outerRadius={94} paddingAngle={1} stroke="#fff" strokeWidth={2} startAngle={90} endAngle={-270}
              onMouseEnter={(_, i) => setHover(ring[i].key)} onMouseLeave={() => setHover(null)} onClick={(_, i) => ring[i].key !== '__outros' && onPick(ring[i].key, ring[i].label)} isAnimationActive animationDuration={500}>
              {ring.map((r) => <Cell key={r.key} fill={r.color} cursor={r.key === '__outros' ? 'default' : 'pointer'} opacity={hover && hover !== r.key ? 0.35 : 1} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {focus ? (<>
            <span className="text-2xl font-semibold tabular">{pct(focus.n, total)}</span>
            <span className="max-w-[110px] truncate text-[11px] text-gray-500">{focus.label}</span>
            <span className="text-[11px] text-gray-400">{focus.n} {unit}</span>
          </>) : (<>
            <span className="text-2xl font-semibold tabular">{total}</span>
            <span className="text-[11px] text-gray-500">{unit}</span>
          </>)}
        </div>
      </div>
      <ul className="max-h-[220px] space-y-0.5 overflow-y-auto pr-1 text-sm">
        {list.map((r, i) => (
          <li key={r.key}>
            <button onClick={() => onPick(r.key, r.label)} onMouseEnter={() => setHover(i < 7 ? r.key : '__outros')} onMouseLeave={() => setHover(null)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-gray-50">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: i < 7 ? colorOf(r.key) : C_OTHER }} />
              <span className="min-w-0 flex-1 truncate text-gray-700" title={r.label}>{r.label}</span>
              <span className="tabular text-gray-500">{r.n}</span>
              <span className="w-10 text-right font-semibold tabular text-gray-900">{pct(r.n, total)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Trend({ d, adj, onDay }: { d: Analytics; adj: boolean; onDay?: (key: string) => void }) {
  const [m, setM] = useState<'n' | 'workH' | 'stoppedH'>('n');
  const data = d.series.map((s) => ({ key: s.key, label: bucketLabel(s.key, d.bucket), n: s.n, workH: s.workH ?? 0, stoppedH: s.stoppedH ?? 0 }));
  const avg = data.length ? data.reduce((a, b) => a + b[m], 0) / data.length : 0;
  const color = m === 'n' ? C_QTY : m === 'workH' ? C_TIME : C_STOP;
  const fmt = (v: number) => (m === 'n' ? String(v) : hrs(v));
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Toggle value={m} onChange={setM} options={[['n', 'Ordens'], ['workH', 'Horas de trabalho'], ['stoppedH', 'Máquina parada']]} />
        <span className="text-xs text-gray-500">média <b className="text-gray-800">{m === 'n' ? num(avg, 1) : hrs(avg)}</b> por {d.bucket}</span>
      </div>
      <div className="h-[220px]">
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }} onClick={(e: any) => onDay && e?.activePayload?.[0] && onDay(e.activePayload[0].payload.key)} style={{ cursor: onDay ? 'pointer' : undefined }}>
            <defs>
              <linearGradient id={`g-${m}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.22} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="#f1f2f4" />
            <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={14} />
            <YAxis {...axis} allowDecimals={m !== 'n'} />
            <Tooltip cursor={{ stroke: '#9ca3af', strokeDasharray: '3 3' }} content={({ payload }) => {
              const p: any = payload?.[0]?.payload; if (!p) return null;
              return <div className="rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg"><b>{p.label}</b><div>{p.n} {adj ? 'ajustes' : 'OS'} · {hrs(p.workH)} de trabalho</div>{p.stoppedH > 0 && <div>{hrs(p.stoppedH)} de máquina parada</div>}{onDay && <div className="mt-1 text-gray-400">clique para ver as ordens</div>}</div>;
            }} />
            <ReferenceLine y={avg} stroke="#9ca3af" strokeDasharray="4 4" />
            <Area type="monotone" dataKey={m} stroke={color} strokeWidth={2} fill={`url(#g-${m})`} dot={data.length <= 31 ? { r: 2.5, fill: color, strokeWidth: 0 } : false} activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }} isAnimationActive animationDuration={500} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="sr-only">{data.map((x) => `${x.label}: ${fmt(x[m])}`).join('; ')}</p>
    </div>
  );
}

interface RankRow { key: string; label: string; n: number; h: number | null; stop: number | null; avg: number | null; note?: string; muted?: boolean }
/** Horizontal ranking with a measure switch (orders, hours, stopped time, average). */
function MetricRanking({ rows, adj, onPick, pnMode, compact }: { rows: RankRow[]; adj: boolean; onPick: (k: string, l: string) => void; pnMode?: boolean; compact?: boolean }) {
  const [m, setM] = useState<'n' | 'h' | 'stop' | 'avg'>('n');
  const val = (r: RankRow) => (m === 'n' ? r.n : m === 'h' ? r.h ?? 0 : m === 'stop' ? r.stop ?? 0 : r.avg ?? 0);
  const fmt = (v: number) => (m === 'n' ? String(v) : m === 'avg' ? min(v) : hrs(v));
  const color = m === 'n' ? C_QTY : m === 'stop' ? C_STOP : C_TIME;
  const sorted = [...rows].filter((r) => val(r) > 0).sort((a, b) => val(b) - val(a) || b.n - a.n);
  const opts: ['n' | 'h' | 'stop' | 'avg', string][] = [['n', 'Ordens'], ['h', 'Horas'], ['stop', 'Parada'], ['avg', 'Tempo médio']];
  return (
    <div>
      {!compact && <div className="mb-3"><Toggle value={m} onChange={setM} options={pnMode ? opts.filter(([k]) => k !== 'stop') : opts} /></div>}
      <Bars rows={sorted.map((r) => ({ key: r.key, label: r.label, v: val(r), text: fmt(val(r)), note: r.note, color: r.muted ? C_OTHER : color }))} onPick={onPick} limit={compact ? 6 : 8} />
      {m === 'stop' && !compact && <p className="mt-2 text-[11px] text-gray-500">Máquina parada conta da abertura até o fim da ordem{adj ? '' : ' (só OS com máquina parada)'}.</p>}
    </div>
  );
}

function TechRanking({ rows, onPick, compact }: { rows: Analytics['byTech']; onPick: (k: string, l: string) => void; compact?: boolean }) {
  const [m, setM] = useState<'n' | 'manH' | 'avgMin'>('n');
  const val = (r: Analytics['byTech'][number]) => (m === 'n' ? r.n : m === 'manH' ? r.manH ?? 0 : r.avgMin ?? 0);
  const sorted = [...rows].filter((r) => val(r) > 0).sort((a, b) => val(b) - val(a));
  return (
    <div>
      {!compact && <div className="mb-3"><Toggle value={m} onChange={setM} options={[['n', 'Atendimentos'], ['manH', 'Horas trabalhadas'], ['avgMin', 'Tempo médio']]} /></div>}
      <Bars limit={compact ? 6 : 8} onPick={onPick} rows={sorted.map((r) => ({
        key: r.id, label: r.name, v: val(r), color: m === 'n' ? C_QTY : C_TIME,
        text: m === 'n' ? String(r.n) : m === 'manH' ? hrs(r.manH) : min(r.avgMin),
        note: m === 'n' ? (r.helped ? `${r.lead} resp. + ${r.helped} ajudando` : undefined) : m === 'avgMin' ? `${r.timed} ordens` : undefined,
      }))} />
    </div>
  );
}

function Bars({ rows, onPick, limit = 8 }: { rows: { key: string; label: string; v: number; text: string; note?: string; color: string }[]; onPick?: (k: string, l: string) => void; limit?: number }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <Empty>Sem registros.</Empty>;
  const max = Math.max(...rows.map((r) => r.v), 0.0001);
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div>
      <ul className="space-y-1">
        {shown.map((r) => (
          <li key={r.key}>
            <button type="button" disabled={!onPick} onClick={() => onPick?.(r.key, r.label)} title={r.note ? `${r.label} · ${r.note}` : r.label}
              className="group grid w-full grid-cols-[minmax(0,8.5rem)_1fr_auto] items-center gap-3 rounded-md px-1.5 py-1 text-left text-sm hover:bg-gray-50 sm:grid-cols-[minmax(0,11rem)_1fr_auto]">
              <span className="truncate text-gray-700 group-hover:text-gray-900">{r.label}</span>
              <span className="relative h-5 rounded bg-gray-50">
                <span className="absolute inset-y-0 left-0 rounded transition-[width] duration-500 ease-out" style={{ width: `${Math.max(2, (r.v / max) * 100)}%`, background: r.color }} />
              </span>
              <span className="flex items-center gap-1 whitespace-nowrap text-right font-semibold tabular text-gray-900">{r.text}{r.note && <span className="hidden max-w-[9rem] truncate text-[11px] font-normal text-gray-500 md:inline">{r.note}</span>}{onPick && <ChevronRight size={14} className="text-gray-300 group-hover:text-gray-500" />}</span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button onClick={() => setAll(!all)} className="mt-2 inline-flex items-center gap-1 px-1.5 text-xs font-medium text-gray-600 hover:text-gray-900">
          {all ? <><ChevronUp size={14} />Mostrar menos</> : <><ChevronDown size={14} />Ver todos ({rows.length})</>}
        </button>
      )}
    </div>
  );
}

/** One stacked bar per shift: the colors are the categories, so shift → problems is read in one glance. */
function ShiftStack({ d, colorOf, onShift, onPart }: { d: Analytics; colorOf: (k: string) => string; onShift: (k: string) => void; onPart: (shift: string, cat: string, label: string) => void }) {
  const max = Math.max(1, ...d.byShift.map((s) => s.n));
  const total = d.byShift.reduce((a, b) => a + b.n, 0);
  if (!total) return <Empty>Sem ordens com turno no período.</Empty>;
  return (
    <div className="space-y-3.5">
      {d.byShift.map((s, i) => {
        const known = s.topCategories.reduce((a, b) => a + b.n, 0);
        const parts = [...s.topCategories.map((c) => ({ ...c, color: colorOf(c.key) })), ...(s.n - known > 0 ? [{ key: '__outros', label: 'Outros', n: s.n - known, stoppedH: null, color: C_OTHER }] : [])];
        return (
          <div key={s.key}>
            <button onClick={() => onShift(s.key)} className="group flex w-full items-baseline justify-between gap-2 text-left">
              <span className="flex items-baseline gap-2"><span className="h-2.5 w-2.5 self-center rounded-full" style={{ background: SHIFT_COLORS[i % SHIFT_COLORS.length] }} /><b className="text-sm text-gray-900 group-hover:underline">{s.label}</b><span className="text-[11px] text-gray-400">{s.start}–{s.end}</span></span>
              <span className="text-sm"><b className="tabular">{s.n}</b> <span className="text-xs text-gray-500">({pct(s.n, total)})</span></span>
            </button>
            <div className="mt-1 flex h-6 gap-0.5" style={{ width: `${Math.max(4, (s.n / max) * 100)}%` }}>
              {parts.map((p) => (
                <button key={p.key} title={`${p.label}: ${p.n} (${pct(p.n, s.n)} do turno)`} onClick={() => (p.key === '__outros' ? onShift(s.key) : onPart(s.key, p.key, p.label))}
                  className="h-full rounded-sm transition-opacity first:rounded-l-md last:rounded-r-md hover:opacity-80" style={{ flexGrow: p.n, background: p.color }} />
              ))}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-gray-500">
              <span>tempo médio <b className="text-gray-700">{min(s.avgMin)}</b></span>
              <span>aceite <b className="text-gray-700">{min(s.avgWaitMin)}</b></span>
              <span>parada <b className="text-red-700">{hrs(s.stoppedH)}</b></span>
              {s.topAssets[0] && <span>mais na <b className="text-gray-700">{s.topAssets[0].label}</b></span>}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-gray-100 pt-3 text-[11px] text-gray-600">
        {[...new Map(d.byShift.flatMap((s) => s.topCategories).map((c) => [c.key, c.label])).entries()].map(([k, l]) => (
          <span key={k} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: colorOf(k) }} />{l}</span>
        ))}
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: C_OTHER }} />Outros</span>
      </div>
      {d.noShift > 0 && <p className="text-[11px] text-gray-400">{d.noShift} ordem(ns) do histórico importado não têm turno.</p>}
    </div>
  );
}

function Heat({ heat, shifts }: { heat: number[][]; shifts: { label: string; start: string; end: string; color: string }[] }) {
  const shiftAt = (h: number) => shifts.find((s) => {
    const a = +s.start.slice(0, 2), b = +s.end.slice(0, 2);
    return a < b ? h >= a && h < b : h >= a || h < b;
  });
  const max = Math.max(1, ...heat.flat());
  let peak = { d: 0, h: 0, n: 0 };
  heat.forEach((row, d) => row.forEach((n, h) => { if (n > peak.n) peak = { d, h, n }; }));
  const shade = (n: number) => (n ? `rgba(42,120,214,${0.12 + (n / max) * 0.88})` : '#f5f6f8');
  return (
    <div className="overflow-x-auto">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
        <span>{peak.n ? <>Pico: <b className="text-gray-900">{WEEKDAYS[peak.d]} às {peak.h}h</b> ({peak.n} ordens)</> : 'Sem aberturas no período.'}</span>
        <span className="inline-flex items-center gap-1 text-gray-500">menos{[0, 0.25, 0.5, 0.75, 1].map((x) => <span key={x} className="h-3 w-4 rounded-sm" style={{ background: shade(x ? Math.max(1, Math.round(x * max)) : 0) }} />)}mais</span>
      </div>
      <table className="w-full min-w-[640px] border-separate border-spacing-[3px] text-[10px] text-gray-500">
        <thead>
          <tr><th className="w-8" />{Array.from({ length: 24 }, (_, h) => { const s = shiftAt(h); const first = s && shiftAt((h + 23) % 24) !== s; return <th key={h} className="relative h-4 p-0 text-left align-bottom text-[10px] font-semibold" style={{ color: s?.color }}>{first && <span className="absolute bottom-0 left-0 whitespace-nowrap">{s!.label}</span>}</th>; })}</tr>
          <tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="h-1 p-0"><span className="block h-1 rounded-full" style={{ background: shiftAt(h)?.color ?? '#e5e7eb' }} /></th>)}</tr>
          <tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="font-normal">{h % 2 === 0 ? `${h}h` : ''}</th>)}</tr>
        </thead>
        <tbody>{heat.map((row, d) => (
          <tr key={d}><th className="pr-1 text-right font-normal">{WEEKDAYS[d]}</th>
            {row.map((n, h) => <td key={h} title={`${WEEKDAYS[d]} ${h}h: ${n} ordem(ns)`} className="h-6 rounded text-center align-middle text-[10px] font-semibold text-white" style={{ background: shade(n) }}>{n / max > 0.55 ? n : ''}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const axis = { tick: { fontSize: 11, fill: '#9ca3af' }, tickLine: false, axisLine: false } as const;

function Criteria({ d }: { d: Analytics }) {
  return (
    <details className="rounded-xl px-3 py-2 text-xs text-gray-500">
      <summary className="cursor-pointer font-medium">Como os números são calculados</summary>
      <ul className="mt-1.5 list-disc space-y-1 pl-5">
        <li><b>Duração:</b> {d.criteria.duration}</li>
        <li><b>Máquina parada:</b> {d.criteria.stopped}</li>
        <li><b>Turno:</b> {d.criteria.shift}</li>
        <li><b>MTBF:</b> {d.criteria.mtbf}</li>
        <li><b>Contagem:</b> ordens abertas no período, sem as canceladas. Cada ordem conta uma vez, mesmo com vários técnicos.</li>
      </ul>
    </details>
  );
}

// ------------------------------------------------------------------ side panel (drill-down)

function DrillPanel({ api, adj, drill, setDrill, base, totalN, colorOf, onOpen, onApply }: {
  api: string; adj: boolean; drill: Drill[]; setDrill: (d: Drill[]) => void; base: { range: { from: string; to: string }; f: F; imported: boolean }; totalN: number;
  colorOf: (k: string) => string; onOpen: (id: string) => void; onApply: (f: F) => void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const t = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(t); }, []);
  const close = () => { setShown(false); setTimeout(() => setDrill([]), 180); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const L = DIM_LABEL(adj);
  const cur = drill[drill.length - 1];
  const used = new Set(drill.map((x) => x.dim));
  const params = paramsOf(base.range, base.f, base.imported, drill);
  const r = useQuery<Analytics>({ queryKey: ['os', 'analytics', api, params], queryFn: () => get(`${api}/analytics${qs(params)}`), placeholderData: keepPreviousData });
  const d = r.data;
  const push = (s: Drill) => setDrill([...drill, s]);
  const isAll = cur.dim === 'all';

  // the drill steps applied as global filters (day changes the period, so it is not offered)
  const asFilter = (): F | null => {
    if (drill.some((x) => x.dim === 'day' || x.dim === 'all')) return null;
    const nf = { ...base.f };
    for (const s of drill) (nf as any)[s.dim] = s.key;
    return nf;
  };
  const nf = asFilter();

  return (
    <div className="fixed inset-0 z-40" role="complementary" aria-label="Detalhes">
      <div className={cx('absolute inset-0 bg-gray-900/25 transition-opacity duration-200', shown ? 'opacity-100' : 'opacity-0')} onClick={close} />
      <aside className={cx('absolute inset-y-0 right-0 flex w-full max-w-[760px] flex-col bg-gray-50 shadow-2xl transition-transform duration-200 ease-out', shown ? 'translate-x-0' : 'translate-x-full')}>
        <header className="border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <button onClick={() => (drill.length > 1 ? setDrill(drill.slice(0, -1)) : close())} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100" aria-label="Voltar"><ArrowLeft size={18} /></button>
            <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs text-gray-500" aria-label="Caminho">
              <button onClick={close} className="hover:text-gray-900 hover:underline">Visão geral</button>
              {drill.map((s, i) => (
                <span key={i} className="flex min-w-0 items-center gap-1"><ChevronRight size={12} />
                  {i < drill.length - 1 ? <button onClick={() => setDrill(drill.slice(0, i + 1))} className="truncate hover:text-gray-900 hover:underline">{s.label}</button> : <span className="truncate font-medium text-gray-800">{s.label}</span>}
                </span>
              ))}
            </nav>
            <button onClick={close} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100" aria-label="Fechar"><X size={18} /></button>
          </div>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-2 pl-9">
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{L[cur.dim]}</div>
              <h2 className="flex items-center gap-2 truncate text-xl font-semibold text-gray-900">
                {cur.dim === 'category' && <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: colorOf(cur.key) }} />}{cur.label}
              </h2>
            </div>
            {nf && <button onClick={() => onApply(nf)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"><Filter size={13} />Filtrar o dashboard por isto</button>}
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          {r.error && <ErrorBox error={r.error} onRetry={() => r.refetch()} />}
          {!d && !r.error && <Spinner />}
          {d && !isAll && (d.kpis.n === 0 ? <Empty>Nenhuma ordem aqui com os filtros atuais.</Empty> : (<>
            <section className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-gray-100 ring-1 ring-gray-100 sm:grid-cols-3">
              {([
                ['Ocorrências', d.kpis.n, `${d.kpis.finished} finalizadas`],
                ['Do total', pct(d.kpis.n, totalN), `de ${totalN} ${adj ? 'ajustes' : 'OS'} no período`],
                ['Técnicos', d.byTech.length, d.byTech[0] ? `mais: ${d.byTech[0].name}` : '—'],
                ['Tempo médio', min(d.kpis.avgMin), 'por atendimento'],
                ['Horas de trabalho', hrs(d.kpis.workH), `${d.kpis.timed} com tempo confiável`],
                ['Máquina parada', hrs(d.kpis.stoppedH), `${d.kpis.stops} paradas`],
              ] as [string, ReactNode, string][]).map(([l, v, s]) => (
                <div key={l} className="bg-white px-4 py-3">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{l}</div>
                  <div className={cx('text-xl font-semibold tabular', l === 'Máquina parada' && d.kpis.stoppedH ? 'text-red-700' : 'text-gray-900')}>{v}</div>
                  <div className="truncate text-[11px] text-gray-500">{s}</div>
                </div>
              ))}
            </section>

            <div className="grid gap-4 md:grid-cols-2">
              {!used.has('category') && (
                <Mini title={adj ? 'Motivos' : 'Problemas'}>
                  <Bars limit={6} onPick={(k, l) => push({ dim: 'category', key: k, label: l })}
                    rows={[...d.byCategory].sort((a, b) => b.n - a.n).map((c) => ({ key: c.key, label: c.label, v: c.n, text: `${c.n} · ${pct(c.n, d.kpis.n)}`, color: colorOf(c.key) }))} />
                </Mini>
              )}
              {!used.has('asset') && (
                <Mini title="Máquinas envolvidas">
                  <MetricRanking compact adj={adj} onPick={(k, l) => push({ dim: 'asset', key: k, label: l })} rows={d.byAsset.map((a) => ({ key: a.key, label: a.label, n: a.n, h: a.workH, stop: a.stoppedH, avg: a.avgMin }))} />
                </Mini>
              )}
              {!used.has('tech') && (
                <Mini title="Técnicos que atuaram"><TechRanking compact rows={d.byTech} onPick={(k, l) => push({ dim: 'tech', key: k, label: l })} /></Mini>
              )}
              {!used.has('pn') && (
                <Mini title="Part numbers envolvidos">
                  <MetricRanking compact pnMode adj={adj} onPick={(k, l) => push({ dim: 'pn', key: k, label: l })}
                    rows={d.byPn.map((p) => ({ key: p.key, label: p.key === '-' ? 'Sem PN' : p.label, n: p.n, h: p.workH, stop: p.stoppedH, avg: p.avgMin, muted: p.key === '-' }))} />
                </Mini>
              )}
              {!used.has('shift') && !used.has('day') && d.byShift.some((s) => s.n) && (
                <Mini title="Por turno">
                  <Bars limit={6} onPick={(k, l) => push({ dim: 'shift', key: k, label: l })}
                    rows={d.byShift.filter((s) => s.n).map((s) => ({ key: s.key, label: s.label, v: s.n, text: `${s.n} · ${pct(s.n, d.kpis.n)}`, color: SHIFT_COLORS[d.byShift.indexOf(s) % SHIFT_COLORS.length] }))} />
                </Mini>
              )}
              {!used.has('day') && d.series.length > 1 && (
                <Mini title="Quando aconteceu">
                  <div className="h-28">
                    <ResponsiveContainer>
                      <AreaChart data={d.series.map((s) => ({ label: bucketLabel(s.key, d.bucket), n: s.n }))} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                        <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={18} />
                        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any) => [v, 'ordens']} />
                        <Area type="monotone" dataKey="n" stroke={C_QTY} strokeWidth={2} fill={C_QTY} fillOpacity={0.12} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </Mini>
              )}
            </div>
          </>))}

          <RecordsList api={api} params={params} adj={adj} onOpen={onOpen} search={isAll} />
        </div>
      </aside>
    </div>
  );
}

function Mini({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-2xl bg-white p-4 ring-1 ring-gray-100">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
      {children}
    </section>
  );
}

/** The individual orders of the selection, with what was reported and what the technician did. */
function RecordsList({ api, params, adj, onOpen, search }: { api: string; params: Record<string, string>; adj: boolean; onOpen: (id: string) => void; search: boolean }) {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [review, setReview] = useState(false);
  const [sort, setSort] = useState<'opened_at' | 'duration' | 'stopped'>('opened_at');
  const p = { ...params, q: term || undefined, sort, dir: 'desc', page, review: review ? '1' : undefined };
  const r = useQuery<{ total: number; page: number; size: number; rows: RecordRow[] }>({ queryKey: ['os', 'analytics-records', api, p], queryFn: () => get(`${api}/analytics/records${qs(p)}`), placeholderData: keepPreviousData });
  const pages = r.data ? Math.max(1, Math.ceil(r.data.total / r.data.size)) : 1;
  const exportHref = withSlot(`${api}/export.xlsx${qs({ from: params.from, to: params.to, shift: params.shift, pn: params.pn && params.pn !== '-' ? params.pn : undefined, category: params.category, component: params.component,
    asset: params.asset ? params.asset.split('|')[1] : undefined, location: params.asset ? params.asset.split('|')[0] || undefined : undefined })}`);
  return (
    <section className="rounded-2xl bg-white p-4 ring-1 ring-gray-100">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Ordens{r.data ? ` (${r.data.total})` : ''}</h4>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Select value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); setPage(1); }} className="h-8 w-auto py-0 text-xs" aria-label="Ordenar">
            <option value="opened_at">Mais recentes</option><option value="duration">Mais demoradas</option><option value="stopped">Mais tempo parada</option>
          </Select>
          <label className="inline-flex items-center gap-1 text-gray-600"><input type="checkbox" checked={review} onChange={(e) => { setReview(e.target.checked); setPage(1); }} />Só para conferir</label>
          <a href={exportHref} className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"><Download size={13} />Excel</a>
        </div>
      </div>
      {search && (
        <form onSubmit={(e) => { e.preventDefault(); setTerm(text.trim()); setPage(1); }} className="mb-3 flex gap-2">
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Nº da ordem, PN, máquina, técnico ou palavra do serviço" aria-label="Pesquisar ordens" className="flex-1" />
          <button type="submit" className="rounded-lg bg-gray-900 px-3 text-sm font-medium text-white hover:bg-gray-700">Pesquisar</button>
        </form>
      )}
      {r.error && <ErrorBox error={r.error} />}
      {!r.data && !r.error && <Spinner />}
      {r.data && (r.data.rows.length ? (<>
        <ul className="divide-y divide-gray-100">
          {r.data.rows.map((x) => (
            <li key={x.id}>
              <button onClick={() => onOpen(x.id)} className="w-full rounded-lg px-2 py-3 text-left hover:bg-gray-50">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="text-sm font-semibold text-gray-900">{x.code}{x.imported && <span className="ml-1 text-[10px] font-normal text-gray-500">histórico{x.legacy ? ` · ${x.legacy}` : ''}</span>}</span>
                  <span className="text-xs tabular text-gray-500">{new Date(x.openedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{x.shift ? ` · ${x.shift}` : ''}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-600">
                  <span>{x.asset}</span><span>{x.pn ?? 'sem PN'}</span><span>{x.category}{x.type === 'preventiva' ? ' · preventiva' : ''}</span>
                  <span>{x.techs.join(', ') || 'sem técnico'}</span>
                  <span className="tabular">{x.durationMin == null ? x.statusLabel : min(x.durationMin)}{x.review && <AlertTriangle size={12} className="ml-1 inline text-amber-600" aria-label={x.review} />}</span>
                  {x.stopped && <span className="tabular text-red-700">parada {hrs(x.stoppedH)}</span>}
                </div>
                <div className="mt-1.5 grid gap-1 text-xs sm:grid-cols-2">
                  <p><span className="font-medium text-gray-500">Problema relatado: </span><span className="text-gray-800">{x.description}</span></p>
                  <p><span className="font-medium text-gray-500">{adj ? 'Ação tomada' : 'O que o técnico fez'}: </span>{x.serviceDone ? <span className="text-gray-800">{x.serviceDone}</span> : <i className="text-gray-400">ainda não finalizada</i>}</p>
                  {x.notes && <p className="sm:col-span-2"><span className="font-medium text-gray-500">{adj ? 'Observações' : 'Material / observações'}: </span><span className="text-gray-800">{x.notes}</span></p>}
                </div>
              </button>
            </li>
          ))}
        </ul>
        {pages > 1 && (
          <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
            <span>Página {r.data.page} de {pages}</span>
            <div className="flex gap-1">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-md px-2 py-1 ring-1 ring-gray-200 disabled:opacity-40">Anterior</button>
              <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-md px-2 py-1 ring-1 ring-gray-200 disabled:opacity-40">Próxima</button>
            </div>
          </div>
        )}
      </>) : <Empty>{search && !term ? 'Digite algo para pesquisar ou veja todas as ordens do período abaixo.' : `Nenhuma ordem encontrada${term ? ` para "${term}"` : ''}.`}</Empty>)}
    </section>
  );
}
