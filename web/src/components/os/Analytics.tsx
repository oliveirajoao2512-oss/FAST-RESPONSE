import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronUp, Download, Info, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { get, qs, withSlot } from '../../lib/api';
import { num } from '../../lib/format';
import { useWoDomain } from '../../lib/workOrders';
import { Button, Card, cx, Empty, ErrorBox, Input, Select, Spinner } from '../ui';

/**
 * Analytical dashboard of one order module (OA or OS), planned with João on 25/11/2026. Read only: every number
 * comes from /api/{oa,os}/analytics, which applies the filters on the server; the browser only draws.
 * In test: shown only to the administrator until it is released.
 */

// validated hues already used by the other panels; one hue per measure, shifts in a fixed order
const C_QTY = '#2a78d6';
const C_TIME = '#ea6a1f';
const C_STOP = '#d03b3b';
const C_PREV = '#1baf7a';
const SHIFT_COLORS = ['#2a78d6', '#ea6a1f', '#1baf7a', '#8b5cf6', '#64748b', '#0f766e'];

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
  options: { shifts: string[]; techs: { id: string; name: string }[]; pns: { key: string; label: string }[]; assets: { key: string; label: string }[]; categories: { key: string; label: string }[]; components: { key: string; label: string }[]; hasImported: boolean };
}
interface RecordRow {
  id: string; code: string; imported: boolean; legacy: string | null; openedAt: string; shift: string | null; techs: string[]; pn: string | null; asset: string; category: string;
  type: string; durationMin: number | null; reliable: boolean; review: string | null; stopped: boolean; stoppedH: number | null; status: string; statusLabel: string;
  description: string; serviceDone: string | null; notes: string | null; openedBy: string; area: string;
}

interface F { shift: string; tech: string; pn: string; asset: string; category: string; type: string; component: string }
const EMPTY: F = { shift: '', tech: '', pn: '', asset: '', category: '', type: '', component: '' };
type Section = 'geral' | 'turnos' | 'tecnicos' | 'maquinas' | 'registros';

const min = (v: number | null | undefined) => (v == null ? '—' : v < 60 ? `${num(v)} min` : `${num(v / 60)} h`);
const hrs = (v: number | null | undefined) => (v == null ? '—' : v < 1 ? `${Math.round(v * 60)} min` : `${num(v)} h`);
const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const bucketLabel = (key: string, b: Analytics['bucket']) => { const [y, m, d] = key.split('-'); return b === 'mes' ? `${MONTHS[+m - 1]}/${y.slice(2)}` : `${d}/${m}`; };

export function AnalyticsDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const D = useWoDomain();
  const adj = D.short === 'OA';
  const [period, setPeriod] = useState<PeriodKey>('mes');
  const [custom, setCustom] = useState(() => rangeOf('mes', { from: '', to: '' }));
  const [f, setF] = useState<F>(EMPTY);
  const [imported, setImported] = useState(true);
  const go = (sec: Section) => document.getElementById(`dash-${sec}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const range = rangeOf(period, custom);
  const params = { ...range, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), ...(imported ? {} : { imported: '0' }) };
  const r = useQuery<Analytics>({ queryKey: ['os', 'analytics', D.api, params], queryFn: () => get(`${D.api}/analytics${qs(params)}`), placeholderData: keepPreviousData });
  const set = (k: keyof F, v: string) => setF((cur) => ({ ...cur, [k]: cur[k] === v ? '' : v }));
  const pick = (k: keyof F) => (v: string) => set(k, v);
  const d = r.data;
  const o = d?.options;
  const word = adj ? 'ajustes' : 'manutenções';
  const catWord = adj ? 'Motivo' : 'Tipo';

  // label of each active filter, for the chips
  const chips: [keyof F, string, string][] = [];
  if (f.shift) chips.push(['shift', 'Turno', f.shift]);
  if (f.tech) chips.push(['tech', 'Técnico', o?.techs.find((t) => t.id === f.tech)?.name ?? '…']);
  if (f.pn) chips.push(['pn', 'PN', f.pn === '-' ? 'Sem PN' : f.pn]);
  if (f.asset) chips.push(['asset', 'Máquina', o?.assets.find((a) => a.key === f.asset)?.label ?? f.asset]);
  if (f.category) chips.push(['category', catWord, o?.categories.find((c) => c.key === f.category)?.label ?? f.category]);
  if (f.type) chips.push(['type', 'Tipo', f.type === 'preventiva' ? 'Preventiva (programada)' : 'Corretiva']);
  if (f.component) chips.push(['component', 'Onde', o?.components.find((c) => c.key === f.component)?.label ?? f.component]);

  const exportHref = withSlot(`${D.api}/export.xlsx${qs({ ...range, shift: f.shift || undefined, pn: f.pn && f.pn !== '-' ? f.pn : undefined, category: f.category || undefined, component: f.component || undefined,
    asset: f.asset ? f.asset.split('|')[1] : undefined, location: f.asset ? f.asset.split('|')[0] || undefined : undefined })}`);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <b>Dashboard novo em teste.</b> Só você está vendo. Os números vêm {adj ? 'dos ajustes registrados' : 'das manutenções registradas'}, sem nenhum valor estimado.
      </div>

      {/* filters: all of them work together and update every number below */}
      <section id="dash-filtros" className="scroll-mt-4 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex w-[calc(50%-4px)] flex-col text-xs text-gray-600 sm:w-auto">Período
            <Select value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} className="mt-0.5 w-full sm:w-40">{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
          </label>
          {period === 'custom' && (<>
            <label className="flex w-[calc(50%-4px)] flex-col text-xs text-gray-600 sm:w-auto">De<Input type="date" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} className="mt-0.5 w-full sm:w-40" /></label>
            <label className="flex w-[calc(50%-4px)] flex-col text-xs text-gray-600 sm:w-auto">Até<Input type="date" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} className="mt-0.5 w-full sm:w-40" /></label>
          </>)}
          <FilterSelect label="Turno" value={f.shift} onChange={(v) => setF({ ...f, shift: v })} options={(o?.shifts ?? []).map((s) => [s, s])} />
          <FilterSelect label="Técnico" value={f.tech} onChange={(v) => setF({ ...f, tech: v })} options={(o?.techs ?? []).map((t) => [t.id, t.name])} wide />
          <FilterSelect label="Part number" value={f.pn} onChange={(v) => setF({ ...f, pn: v })} options={(o?.pns ?? []).map((p) => [p.key, p.key === '-' ? 'Sem PN' : p.key])} />
          <FilterSelect label="Máquina" value={f.asset} onChange={(v) => setF({ ...f, asset: v })} options={(o?.assets ?? []).map((a) => [a.key, a.label])} wide />
          <FilterSelect label={catWord} value={f.category} onChange={(v) => setF({ ...f, category: v })} options={(o?.categories ?? []).map((c) => [c.key, c.label])} wide />
          {!adj && <FilterSelect label="Corretiva / preventiva" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={[['corretiva', 'Corretiva'], ['preventiva', 'Preventiva (programada)']]} />}
          {!adj && <FilterSelect label="Onde foi o problema" value={f.component} onChange={(v) => setF({ ...f, component: v })} options={(o?.components ?? []).map((c) => [c.key, c.label])} />}
          {o?.hasImported && (
            <label className="mb-2 inline-flex items-center gap-1.5 text-xs text-gray-700" title="OS de outubro trazidas da planilha antiga: sem PN, sem turno e sem hora de aceite">
              <input type="checkbox" checked={imported} onChange={(e) => setImported(e.target.checked)} /> Incluir histórico importado
            </label>
          )}
        </div>
      </section>
      <div className="sticky -top-3 z-20 -mx-1 flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-gray-200 bg-white/95 px-2 py-1.5 shadow-sm backdrop-blur sm:-top-5">
        <span className="text-xs font-semibold text-gray-700">{PERIODS.find((x) => x.value === period)?.label}{period === 'custom' ? ` (${range.from} a ${range.to})` : ''}</span>
        {chips.length ? chips.map(([k, l, v]) => (
          <span key={k} className="inline-flex items-center gap-1 rounded-full bg-brand-600 py-0.5 pl-2.5 pr-1 text-xs font-medium text-white">
            {l}: {v}<button onClick={() => setF({ ...f, [k]: '' })} aria-label={`Tirar filtro ${l}`} className="rounded-full p-0.5 hover:bg-white/20"><X size={12} /></button>
          </span>
        )) : <span className="text-xs text-gray-500">sem outros filtros<span className="hidden sm:inline"> · clique em qualquer barra, linha ou cartão para filtrar</span></span>}
        {chips.length > 0 && <button onClick={() => setF(EMPTY)} className="text-xs font-medium text-brand-700 underline">Limpar filtros</button>}
        {r.isFetching && <span className="text-xs text-gray-400">atualizando…</span>}
        <button onClick={() => document.getElementById('dash-filtros')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="ml-auto text-xs font-medium text-brand-700 underline">Alterar filtros</button>
      </div>

      {r.error && <ErrorBox error={r.error} onRetry={() => r.refetch()} />}
      {!d && !r.error && <Spinner />}
      {d && (<>
        {d.kpis.n === 0 ? (
          <Card><Empty>Nenhuma {adj ? 'OA' : 'OS'} com esses filtros. {chips.length ? 'Tire um dos filtros acima ou ' : ''}Escolha outro período.</Empty></Card>
        ) : (<>
          <Block id="geral" title="Visão geral"><Overview d={d} adj={adj} word={word} pick={pick} go={go} /></Block>
          <Block id="turnos" title="O que acontece em cada turno"><Shifts d={d} adj={adj} pick={pick} active={f.shift} /></Block>
          <Block id="tecnicos" title="Técnicos"><Techs d={d} adj={adj} pick={pick} active={f.tech} /></Block>
          <Block id="maquinas" title={adj ? 'Máquinas e PN' : 'Máquinas, PN e dispositivos'}><Assets d={d} adj={adj} pick={pick} /></Block>
        </>)}
        <Block id="registros" title={adj ? 'Ajustes, um a um: o que foi feito' : 'Manutenções, uma a uma: o que o técnico fez'}><Records api={D.api} params={params} adj={adj} onOpen={onOpen} exportHref={exportHref} /></Block>
        {d.kpis.n > 0 && <Criteria d={d} />}
      </>)}
    </div>
  );
}

function Block({ id, title, children }: { id: Section; title: string; children: ReactNode }) {
  return (
    <section id={`dash-${id}`} className="scroll-mt-14 space-y-3 pt-2">
      <h2 className="border-b border-gray-200 pb-1 text-lg font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function FilterSelect({ label, value, onChange, options, wide }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; wide?: boolean }) {
  return (
    <label className="flex w-[calc(50%-4px)] flex-col text-xs text-gray-600 sm:w-auto">{label}
      <Select value={value} onChange={(e) => onChange(e.target.value)} className={cx('mt-0.5 w-full', wide ? 'sm:w-52' : 'sm:w-40')}>
        <option value="">Todos</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
    </label>
  );
}

const TONE: Record<'qty' | 'time' | 'stop' | 'where', string> = { qty: C_QTY, time: C_TIME, stop: C_STOP, where: '#64748b' };
function Stat({ label, value, sub, onClick, tone = 'where' }: { label: string; value: ReactNode; sub?: ReactNode; onClick?: () => void; tone?: keyof typeof TONE }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} style={{ borderLeft: `4px solid ${TONE[tone]}` }}
      className={cx('flex min-w-0 flex-col items-start rounded-xl border border-gray-200 bg-white px-4 py-3 text-left', onClick && 'hover:border-brand-400 hover:shadow-sm')}>
      <span className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</span>
      <span className={cx('mt-1 max-w-full break-words text-xl font-bold leading-tight tabular sm:text-2xl', tone === 'stop' ? 'text-red-700' : 'text-gray-900')}>{value}</span>
      {sub && <span className="line-clamp-2 max-w-full text-xs text-gray-500">{sub}</span>}
    </Tag>
  );
}

const axis = { tick: { fontSize: 11, fill: '#6b7280' }, tickLine: false, axisLine: false } as const;
const tip = { fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' };

/** Horizontal ranking: the top 10, with a button to see the rest. Clicking a bar filters by it. */
function Ranking({ rows, value, fmt, color, onPick, note, colorOf }: { rows: { key: string; label: string }[]; value: (r: any) => number | null; fmt: (v: number) => string; color: string; onPick?: (k: string) => void; note?: (r: any) => string; colorOf?: (r: any) => string }) {
  const [all, setAll] = useState(false);
  const list = rows.filter((r) => (value(r) ?? 0) > 0);
  const shown = all ? list : list.slice(0, 10);
  const max = Math.max(1, ...list.map((r) => value(r) ?? 0));
  if (!list.length) return <Empty>Sem registros.</Empty>;
  return (
    <div>
      <ul className="space-y-1.5">
        {shown.map((r) => (
          <li key={r.key}>
            <button type="button" disabled={!onPick} onClick={() => onPick?.(r.key)} title={onPick ? 'Clique para filtrar' : undefined}
              className="grid w-full grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-gray-50 disabled:hover:bg-transparent sm:grid-cols-[minmax(0,13rem)_1fr_auto]">
              <span className="truncate text-gray-800" title={r.label}>{r.label}</span>
              <span className="h-4 rounded bg-gray-100"><span className="block h-4 rounded" style={{ width: `${((value(r) ?? 0) / max) * 100}%`, background: colorOf?.(r) ?? color }} /></span>
              <span className="whitespace-nowrap text-right tabular text-gray-900"><b>{fmt(value(r) ?? 0)}</b>{note && <span className="ml-1.5 text-xs text-gray-500">{note(r)}</span>}</span>
            </button>
          </li>
        ))}
      </ul>
      {list.length > 10 && (
        <button onClick={() => setAll(!all)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700">
          {all ? <><ChevronUp size={14} />Mostrar só os 10 primeiros</> : <><ChevronDown size={14} />Ver todos ({list.length})</>}
        </button>
      )}
    </div>
  );
}

function Overview({ d, adj, word, pick, go }: { d: Analytics; adj: boolean; word: string; pick: (k: keyof F) => (v: string) => void; go: (s: Section) => void }) {
  const k = d.kpis;
  const series = d.series.map((s) => ({ ...s, label: bucketLabel(s.key, d.bucket) }));
  const Word = adj ? 'Ajustes' : 'Manutenções';
  const avgPer = series.length ? series.reduce((a, b) => a + b.n, 0) / series.length : 0;
  const total = d.pareto.reduce((a, b) => a + b.n, 0) || 1;
  const vitalCount = d.pareto.findIndex((p) => p.cumPct >= 80) + 1;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <KpiGroup title="Quantidade" color={C_QTY} cols={2}>
          <Stat tone="qty" label={`Total de ${word}`} value={k.n} sub={`${k.finished} finalizadas · ${k.open} em aberto`} />
          {!adj ? <Stat tone="qty" label="Corretivas / preventivas" value={`${k.corrective} / ${k.preventive}`} sub="preventiva = programada" />
            : <Stat tone="qty" label="Máquinas / PNs envolvidos" value={`${k.assets} / ${k.pns}`} sub={`${k.withPn} de ${k.n} com PN informado`} />}
        </KpiGroup>
        <KpiGroup title="Tempo" color={C_TIME}>
          <Stat tone="time" label={`Tempo total em ${word}`} value={hrs(k.workH)} sub={`${k.timed} ordens com tempo confiável`} />
          <Stat tone="time" label="Tempo médio por ordem" value={min(k.avgMin)} sub="do aceite ao fim, sem pausas" />
          <Stat tone="time" label="Tempo para aceitar" value={min(k.avgWaitMin)} sub="média da abertura ao aceite" />
        </KpiGroup>
        {!adj && (
          <KpiGroup title="Máquina parada" color={C_STOP} cols={2}>
            <Stat tone="stop" label="Tempo de máquina parada" value={hrs(k.stoppedH)} sub={`${k.stops} paradas${k.mttrH != null ? ` · MTTR ${hrs(k.mttrH)}` : ''}`} />
            <Stat tone="stop" label="Máquina mais tempo parada" value={k.topStopAsset?.label ?? '—'} sub={k.topStopAsset ? `${hrs(k.topStopAsset.stoppedH)} parada` : undefined} onClick={k.topStopAsset ? () => pick('asset')(k.topStopAsset!.key) : undefined} />
          </KpiGroup>
        )}
        <KpiGroup title="Onde mais acontece" color="#64748b">
          <Stat label={`Máquina com mais ${word}`} value={k.topAsset?.label ?? '—'} sub={k.topAsset ? `${k.topAsset.n} ordens` : undefined} onClick={k.topAsset ? () => pick('asset')(k.topAsset!.key) : undefined} />
          <Stat label="Turno com mais ordens" value={k.topShift?.label ?? '—'} sub={k.topShift ? `${k.topShift.n} ordens · ${k.topShift.pct}% do total` : undefined} onClick={k.topShift ? () => go('turnos') : undefined} />
          {adj ? <Stat label="PN com mais ajustes" value={k.topPn?.key ?? '—'} sub={k.topPn ? `${k.topPn.n} ajustes` : undefined} onClick={k.topPn ? () => pick('pn')(k.topPn!.key) : undefined} />
            : <Stat label="Principal tipo" value={k.topCategory?.label ?? '—'} sub={k.topCategory ? `${k.topCategory.n} OS` : undefined} onClick={k.topCategory ? () => pick('category')(k.topCategory!.key) : undefined} />}
        </KpiGroup>
      </div>

      {d.quality.excluded > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <Info size={14} className="mt-0.5 shrink-0" />
          {d.quality.excluded} ordem(ns) ficaram fora das médias de tempo ({d.quality.long} com mais de 24 h aberta, {d.quality.instant} finalizada(s) menos de 1 min depois do aceite). Elas continuam na contagem e aparecem em Registros → "Só as para conferir".
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Evolução: ${word} por ${d.bucket === 'dia' ? 'dia' : d.bucket === 'semana' ? 'semana' : 'mês'}`}
          actions={!adj ? <Legend items={[['Corretivas', C_QTY], ['Preventivas', C_PREV]]} /> : undefined}>
          <Hint>Cada barra é {d.bucket === 'dia' ? 'um dia' : d.bucket === 'semana' ? 'uma semana' : 'um mês'}. A linha tracejada é a média ({num(avgPer, 1)} por {d.bucket}): barras acima dela são {d.bucket === 'dia' ? 'dias' : 'períodos'} com mais {word} que o normal.</Hint>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={series} margin={{ top: 18, right: 70, left: -24, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#f0f1f3" />
                <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={8} />
                <YAxis allowDecimals={false} {...axis} />
                <Tooltip cursor={{ fill: '#f3f4f6' }} content={({ payload }) => {
                  const p: any = payload?.[0]?.payload; if (!p) return null;
                  return <div className="rounded-lg border bg-white px-3 py-2 text-xs shadow"><b>{p.label}</b><div>{p.n} {p.n === 1 ? (adj ? 'ajuste' : 'manutenção') : word}{!adj && p.preventive ? ` (${p.preventive} preventiva${p.preventive > 1 ? 's' : ''})` : ''}</div>{p.workH != null && <div className="text-gray-500">{hrs(p.workH)} de trabalho</div>}</div>;
                }} />
                <ReferenceLine y={avgPer} stroke="#6b7280" strokeDasharray="4 4" ifOverflow="extendDomain" label={{ value: `média ${num(avgPer, 1)}`, position: 'right', fontSize: 11, fontWeight: 600, fill: '#4b5563' }} />
                {adj ? (
                  <Bar dataKey="n" name={Word} fill={C_QTY} radius={[4, 4, 0, 0]} maxBarSize={28}><LabelList dataKey="n" position="top" fontSize={10} fill="#374151" formatter={(v: any) => (v ? v : '')} /></Bar>
                ) : (<>
                  <Bar dataKey="corrective" name="Corretivas" stackId="a" fill={C_QTY} maxBarSize={28} />
                  <Bar dataKey="preventive" name="Preventivas" stackId="a" fill={C_PREV} radius={[4, 4, 0, 0]} maxBarSize={28}><LabelList dataKey="n" position="top" fontSize={10} fill="#374151" formatter={(v: any) => (v ? v : '')} /></Bar>
                </>)}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title={`Quais ${adj ? 'motivos' : 'tipos'} mais aparecem`} actions={<span className="text-xs text-gray-500">clique para filtrar</span>}>
          <Hint>{vitalCount > 0 ? <>Os <b className="text-gray-800">{vitalCount} primeiros</b> (em laranja forte) somam 80% das ordens: atacar esses resolve a maior parte.</> : null}</Hint>
          <div className="grid grid-cols-[minmax(0,11rem)_1fr_2.5rem_3.5rem] gap-2 border-b px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 sm:grid-cols-[minmax(0,15rem)_1fr_2.5rem_3.5rem]">
            <span>{adj ? 'Motivo' : 'Tipo'}</span><span /><span className="text-right">Qtd</span><span className="text-right">%</span>
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {d.pareto.slice(0, 12).map((p, i) => {
              const max = d.pareto[0]?.n || 1;
              const vital = i < vitalCount;
              return (
                <li key={p.key}>
                  {i === vitalCount && vitalCount > 0 && <div className="my-1.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-gray-400"><span className="h-px flex-1 border-t border-dashed border-gray-300" />acima desta linha: 80% das ordens<span className="h-px flex-1 border-t border-dashed border-gray-300" /></div>}
                  <button onClick={() => pick('category')(p.key)} className="grid w-full grid-cols-[minmax(0,11rem)_1fr_2.5rem_3.5rem] items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-gray-50 sm:grid-cols-[minmax(0,15rem)_1fr_2.5rem_3.5rem]">
                    <span className={cx('truncate', vital ? 'font-medium text-gray-900' : 'text-gray-600')} title={p.label}>{p.label}</span>
                    <span className="h-4 rounded bg-gray-100"><span className="block h-4 rounded" style={{ width: `${(p.n / max) * 100}%`, background: vital ? C_TIME : '#f5c3a3' }} /></span>
                    <b className="text-right tabular">{p.n}</b>
                    <span className="text-right text-xs tabular text-gray-600">{num((p.n / total) * 100, 0)}%</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Máquinas que mais pedem atenção" actions={<span className="text-xs text-gray-500">clique para filtrar</span>}>
          <Hint>Ordenadas pelo tempo gasto. Barra azul = quantas ordens, barra laranja = quantas horas de {adj ? 'ajuste' : 'manutenção'}.</Hint>
          <Attention rows={d.byAsset} adj={adj} onPick={pick('asset')} />
        </Card>
        <Card title="Problemas que se repetem" actions={<span className="text-xs text-gray-500">mesma máquina e {adj ? 'motivo' : 'tipo'} em até 7 dias</span>}>
          <Hint>O mesmo problema voltou na mesma máquina. "Volta a cada" é o tempo médio entre uma ordem e a seguinte: quanto menor, mais urgente achar a causa.</Hint>
          {d.recurrence.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-xs text-gray-500"><th className="py-1.5">Máquina</th><th>{adj ? 'Motivo' : 'Tipo'}</th><th className="text-right">Ordens</th><th className="text-right">Repetiu</th><th className="text-right">Volta a cada</th></tr></thead>
                <tbody>{d.recurrence.slice(0, 8).map((x) => (
                  <tr key={x.asset + x.category} className="cursor-pointer border-b last:border-0 hover:bg-gray-50" onClick={() => { pick('asset')(x.asset); }}>
                    <td className="py-1.5 font-medium">{x.assetLabel}</td><td className="max-w-48 truncate" title={x.categoryLabel}>{x.categoryLabel}</td>
                    <td className="text-right tabular">{x.n}</td><td className="text-right tabular font-semibold text-red-700">{x.repeats}×</td><td className="text-right tabular">{hrs(x.avgGapH)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <Empty>Nenhum problema repetido na mesma máquina em até 7 dias.</Empty>}
        </Card>
      </div>
    </div>
  );
}

function KpiGroup({ title, color, children, cols = 3 }: { title: string; color: string; children: ReactNode; cols?: 2 | 3 }) {
  return (
    <div className="rounded-xl bg-gray-50 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-gray-600"><span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />{title}</div>
      <div className={cx('grid grid-cols-2 gap-2 [&>*]:min-h-[5.5rem]', cols === 3 && 'sm:grid-cols-3')}>{children}</div>
    </div>
  );
}

/** One line under a chart title saying how to read it. */
function Hint({ children }: { children: ReactNode }) {
  return <p className="-mt-1 mb-3 text-xs text-gray-500">{children}</p>;
}

function Legend({ items }: { items: [string, string][] }) {
  return <div className="flex flex-wrap gap-3 text-xs text-gray-600">{items.map(([l, c]) => <span key={l} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{l}</span>)}</div>;
}

function Attention({ rows, adj, onPick }: { rows: Analytics['byAsset']; adj: boolean; onPick: (k: string) => void }) {
  const list = [...rows].filter((r) => r.n).sort((a, b) => (b.workH ?? 0) - (a.workH ?? 0) || b.n - a.n).slice(0, 8);
  if (!list.length) return <Empty>Sem registros.</Empty>;
  const maxN = Math.max(1, ...list.map((r) => r.n));
  const maxH = Math.max(0.01, ...list.map((r) => r.workH ?? 0));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="border-b text-left text-[11px] uppercase tracking-wide text-gray-500">
          <th className="py-1.5">Máquina</th><th className="w-[24%]">Ordens</th><th className="w-[24%]">Horas</th>{!adj && <th className="text-right">Parada</th>}<th className="pl-2">{adj ? 'Motivo' : 'Tipo'} mais comum</th>
        </tr></thead>
        <tbody>{list.map((r) => (
          <tr key={r.key} onClick={() => onPick(r.key)} className="cursor-pointer border-b last:border-0 hover:bg-gray-50">
            <td className="whitespace-nowrap py-1.5 pr-2 font-medium">{r.label}</td>
            <td className="pr-2"><MiniBar v={r.n} max={maxN} color={C_QTY} text={String(r.n)} /></td>
            <td className="pr-2"><MiniBar v={r.workH ?? 0} max={maxH} color={C_TIME} text={hrs(r.workH)} /></td>
            {!adj && <td className="whitespace-nowrap text-right tabular text-red-700">{r.stoppedH ? hrs(r.stoppedH) : <span className="text-gray-300">—</span>}</td>}
            <td className="max-w-40 truncate pl-2 text-gray-600" title={r.topCategory?.label}>{r.topCategory?.label ?? '—'}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function MiniBar({ v, max, color, text }: { v: number; max: number; color: string; text: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-3 flex-1 rounded-sm bg-gray-100"><span className="block h-3 rounded-sm" style={{ width: `${(v / max) * 100}%`, background: color }} /></span>
      <span className="w-14 text-right text-xs font-semibold tabular">{text}</span>
    </div>
  );
}

function Shifts({ d, adj, pick, active }: { d: Analytics; adj: boolean; pick: (k: keyof F) => (v: string) => void; active: string }) {
  const rows = d.byShift.map((s, i) => ({ ...s, color: SHIFT_COLORS[i % SHIFT_COLORS.length] }));
  const totN = rows.reduce((a, b) => a + b.n, 0) || 1;
  const totH = rows.reduce((a, b) => a + (b.workH ?? 0), 0) || 1;
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">O que acontece em cada turno no período. Clique num turno para filtrar o dashboard inteiro por ele.{d.noShift ? ` ${d.noShift} ordem(ns) do histórico importado não têm turno.` : ''}</p>
      <div className="grid gap-3 lg:grid-cols-3">
        {rows.map((s) => (
          <section key={s.key} className={cx('min-w-0 rounded-xl border bg-white', active === s.key ? 'border-brand-500 ring-2 ring-brand-200' : 'border-gray-200')} style={{ borderTop: `4px solid ${s.color}` }}>
            <button onClick={() => pick('shift')(s.key)} className="flex w-full items-baseline justify-between gap-2 px-4 pt-3 text-left">
              <h3 className="text-base font-bold">{s.label}</h3><span className="text-xs text-gray-500">{s.start} às {s.end}</span>
            </button>
            <div className="px-4 pt-2">
              <div className="flex items-center justify-between text-xs text-gray-500"><span>Parte das ordens do período</span><b className="text-gray-800">{num((s.n / totN) * 100, 0)}%</b></div>
              <span className="mt-1 block h-2 rounded-full bg-gray-100"><span className="block h-2 rounded-full" style={{ width: `${(s.n / totN) * 100}%`, background: s.color }} /></span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
              <dt className="text-gray-600">Ordens</dt><dd className="text-right font-bold tabular">{s.n}</dd>
              <dt className="text-gray-600">Tempo total</dt><dd className="text-right font-semibold tabular">{hrs(s.workH)}</dd>
              <dt className="text-gray-600">Tempo médio</dt><dd className="text-right font-semibold tabular">{min(s.avgMin)}</dd>
              <dt className="text-gray-600">Tempo para aceitar</dt><dd className="text-right font-semibold tabular">{min(s.avgWaitMin)}</dd>
              <dt className="text-gray-600">Máquina parada</dt><dd className="text-right font-semibold tabular text-red-700">{s.stops} · {hrs(s.stoppedH)}</dd>
            </dl>
            <div className="space-y-3 border-t border-gray-100 px-4 py-3 text-sm">
              <MiniList title="Máquinas" items={s.topAssets.map((a) => ({ key: a.key, label: a.label, n: a.n }))} onPick={pick('asset')} />
              <MiniList title={adj ? 'Motivos' : 'Tipos'} items={s.topCategories.map((a) => ({ key: a.key, label: a.label, n: a.n }))} onPick={pick('category')} />
              <MiniList title="Técnicos" items={s.techs.map((t) => ({ key: t.id, label: t.name, n: t.n }))} onPick={pick('tech')} />
            </div>
          </section>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Quantidade de ordens por turno"><Hint>Número em cima da barra: ordens e a parte do total.</Hint><ShiftBars rows={rows} value="n" fmt={(v) => `${v}\u00a0(${num((v / totN) * 100, 0)}%)`} onPick={pick('shift')} /></Card>
        <Card title={`Horas de ${adj ? 'ajuste' : 'manutenção'} por turno`}><Hint>Soma do tempo de trabalho nas ordens de cada turno.</Hint><ShiftBars rows={rows} value="workH" fmt={(v) => `${hrs(v)}\u00a0(${num((v / totH) * 100, 0)}%)`.replace(/ /g, '\u00a0')} onPick={pick('shift')} /></Card>
      </div>
      <Card title="Quando as ordens são abertas" actions={<span className="text-xs text-gray-500">dia da semana × hora · mais escuro = mais ordens</span>}><Heat heat={d.heat} shifts={rows} /></Card>
    </div>
  );
}

function MiniList({ title, items, onPick }: { title: string; items: { key: string; label: string; n: number }[]; onPick: (k: string) => void }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</div>
      {items.length ? (
        <ul className="mt-1 space-y-0.5">
          {items.slice(0, 5).map((x) => (
            <li key={x.key}><button onClick={() => onPick(x.key)} className="flex w-full justify-between gap-2 rounded px-1 text-left hover:bg-gray-50"><span className="truncate" title={x.label}>{x.label}</span><b className="tabular">{x.n}</b></button></li>
          ))}
        </ul>
      ) : <p className="mt-1 text-xs text-gray-400">Nenhum registro.</p>}
    </div>
  );
}

function ShiftBars({ rows, value, fmt, onPick }: { rows: (Shift & { color: string })[]; value: 'n' | 'workH'; fmt: (v: number) => string; onPick: (k: string) => void }) {
  return (
    <div className="h-56">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 20, right: 4, left: -20, bottom: 0 }}>
          <XAxis dataKey="label" {...axis} />
          <YAxis {...axis} allowDecimals={value === 'workH'} />
          <CartesianGrid vertical={false} stroke="#f0f1f3" />
          <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={tip} formatter={(v: any) => fmt(Number(v))} />
          <Bar dataKey={value} name={value === 'n' ? 'Ordens' : 'Horas'} radius={[4, 4, 0, 0]} maxBarSize={64} cursor="pointer" onClick={(p: any) => onPick(p.key)}>
            {rows.map((r) => <Cell key={r.key} fill={r.color} />)}
            <LabelList dataKey={value} position="top" fontSize={12} fontWeight={600} fill="#111827" formatter={(v: any) => (v ? fmt(Number(v)) : '')} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Heat({ heat, shifts }: { heat: number[][]; shifts: { label: string; start: string; end: string; color: string }[] }) {
  // which shift each hour belongs to, to draw the shift band above the grid
  const shiftAt = (h: number) => shifts.find((s) => {
    const a = +s.start.slice(0, 2), b = +s.end.slice(0, 2);
    return a < b ? h >= a && h < b : h >= a || h < b;
  });
  const max = Math.max(1, ...heat.flat());
  let peak = { d: 0, h: 0, n: 0 };
  heat.forEach((row, d) => row.forEach((n, h) => { if (n > peak.n) peak = { d, h, n }; }));
  const shade = (n: number) => (n ? `rgba(234,106,31,${0.15 + (n / max) * 0.85})` : '#f3f4f6');
  return (
    <div className="overflow-x-auto">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
        <span>{peak.n ? <>Horário com mais aberturas: <b className="text-gray-900">{WEEKDAYS[peak.d]} às {peak.h}h</b> ({peak.n} ordens)</> : 'Sem aberturas no período.'}</span>
        <span className="inline-flex items-center gap-1">menos{[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f} className="h-3 w-4 rounded-sm" style={{ background: shade(f ? Math.max(1, Math.round(f * max)) : 0) }} />)}mais</span>
      </div>
      <table className="border-separate border-spacing-0.5 text-[10px] text-gray-500">
        <thead>
          <tr><th />{Array.from({ length: 24 }, (_, h) => { const s = shiftAt(h); const first = s && shiftAt((h + 23) % 24) !== s; return <th key={h} className="relative h-4 p-0 text-left align-bottom text-[10px] font-semibold" style={{ color: s?.color }}>{first && <span className="absolute bottom-0 left-0 whitespace-nowrap">{s!.label}</span>}</th>; })}</tr>
          <tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="h-1.5 p-0"><span className="block h-1.5" style={{ background: shiftAt(h)?.color ?? '#e5e7eb' }} /></th>)}</tr>
          <tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="w-7 font-normal">{h % 2 === 0 ? `${h}h` : ''}</th>)}</tr>
        </thead>
        <tbody>{heat.map((row, d) => (
          <tr key={d}><th className="pr-1 text-right font-normal">{WEEKDAYS[d]}</th>
            {row.map((n, h) => <td key={h} title={`${WEEKDAYS[d]} ${h}h: ${n} ordem(ns)`} className="h-7 w-7 rounded text-center align-middle text-[10px] font-semibold text-white" style={{ background: shade(n) }}>{n / max > 0.5 ? n : ''}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Techs({ d, adj, pick, active }: { d: Analytics; adj: boolean; pick: (k: keyof F) => (v: string) => void; active: string }) {
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: 'n', dir: -1 });
  const rows = useMemo(() => [...d.byTech].sort((a: any, b: any) => (a[sort.k] > b[sort.k] ? 1 : a[sort.k] < b[sort.k] ? -1 : 0) * sort.dir), [d.byTech, sort]);
  const th = (k: string, l: string, right = true) => (
    <th className={cx('cursor-pointer select-none whitespace-nowrap py-2', right && 'text-right')} onClick={() => setSort({ k, dir: sort.k === k ? (-sort.dir as 1 | -1) : -1 })} aria-sort={sort.k === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      {l}{sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Intervenções por técnico" actions={<span className="text-xs text-gray-500">conta as ordens em que trabalhou</span>}>
          <Ranking rows={d.byTech.map((t) => ({ ...t, key: t.id, label: t.name }))} value={(r) => r.n} fmt={(v) => String(v)} color={C_QTY} onPick={pick('tech')}
            note={(r) => (r.helped ? `${r.lead} + ${r.helped} ajudando` : '')} colorOf={(r) => (active && r.key !== active ? '#d1d5db' : C_QTY)} />
        </Card>
        <Card title={`Tempo médio por ${adj ? 'ajuste' : 'manutenção'}, por técnico`} actions={<span className="text-xs text-gray-500">só ordens em que foi o responsável</span>}>
          <Ranking rows={[...d.byTech].filter((t) => t.avgMin != null).sort((a, b) => (b.avgMin ?? 0) - (a.avgMin ?? 0)).map((t) => ({ ...t, key: t.id, label: t.name }))}
            value={(r) => r.avgMin} fmt={(v) => min(v)} color={C_TIME} onPick={pick('tech')} note={(r) => `${r.timed} ordens`} />
        </Card>
      </div>
      <Card title="Ranking de técnicos" actions={<span className="text-xs text-gray-500">clique no título para ordenar · na linha para filtrar</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
              {th('name', 'Técnico', false)}{th('n', 'Intervenções')}{th('lead', 'Responsável')}{th('helped', 'Ajudou')}{th('manH', 'Horas trabalhadas')}{th('avgMin', 'Tempo médio')}
            </tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.id} onClick={() => pick('tech')(t.id)} className={cx('cursor-pointer border-b last:border-0 hover:bg-gray-50', active === t.id && 'bg-brand-50')}>
                <td className="py-2 font-medium">{t.name}</td><td className="text-right tabular">{t.n}</td><td className="text-right tabular">{t.lead}</td><td className="text-right tabular">{t.helped}</td>
                <td className="text-right tabular">{hrs(t.manH)}</td><td className="text-right tabular">{min(t.avgMin)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-500">Horas trabalhadas somam o tempo de cada técnico na ordem (homem-hora): uma ordem de 1 h com dois técnicos conta 1 h para cada um.</p>
      </Card>
    </div>
  );
}

function Assets({ d, adj, pick }: { d: Analytics; adj: boolean; pick: (k: keyof F) => (v: string) => void }) {
  const byTime = [...d.byAsset].sort((a, b) => (b.workH ?? 0) - (a.workH ?? 0));
  const byStop = [...d.byAsset].sort((a, b) => (b.stoppedH ?? 0) - (a.stoppedH ?? 0));
  const byAvg = [...d.byAsset].filter((a) => a.avgMin != null).sort((a, b) => (b.avgMin ?? 0) - (a.avgMin ?? 0));
  const pnTime = [...d.byPn].sort((a, b) => (b.workH ?? 0) - (a.workH ?? 0));
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`${adj ? 'Ajustes' : 'Ocorrências'} por máquina`}><Ranking rows={d.byAsset} value={(r) => r.n} fmt={(v) => String(v)} color={C_QTY} onPick={pick('asset')} note={(r) => r.topCategory?.label ?? ''} /></Card>
        <Card title={`Tempo de ${adj ? 'ajuste' : 'manutenção'} por máquina`}><Ranking rows={byTime} value={(r) => r.workH} fmt={hrs} color={C_TIME} onPick={pick('asset')} note={(r) => `${r.timed} ordens`} /></Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {!adj && <Card title="Tempo de máquina parada por máquina" actions={<span className="text-xs text-gray-500">diferente do tempo de manutenção</span>}><Ranking rows={byStop} value={(r) => r.stoppedH} fmt={hrs} color={C_STOP} onPick={pick('asset')} note={(r) => `${r.stops} paradas`} /></Card>}
        <Card title={`Tempo médio por ${adj ? 'ajuste' : 'manutenção'}, por máquina`}><Ranking rows={byAvg} value={(r) => r.avgMin} fmt={min} color={C_TIME} onPick={pick('asset')} note={(r) => `${r.timed} ordens`} /></Card>
        <Card title={`${adj ? 'Ajustes' : 'Ordens'} por PN`} actions={<span className="text-xs text-gray-500">"Sem PN" separado</span>}>
          <Ranking rows={d.byPn} value={(r) => r.n} fmt={(v) => String(v)} color={C_QTY} onPick={pick('pn')} note={(r) => (r.topAsset ? `mais na ${r.topAsset.label}` : '')} colorOf={(r) => (r.key === '-' ? '#9ca3af' : C_QTY)} />
        </Card>
        <Card title={`Tempo de ${adj ? 'ajuste' : 'manutenção'} por PN`}><Ranking rows={pnTime} value={(r) => r.workH} fmt={hrs} color={C_TIME} onPick={pick('pn')} colorOf={(r) => (r.key === '-' ? '#d1d5db' : C_TIME)} /></Card>
        {!adj && <Card title="Onde foi o problema"><Ranking rows={d.byComponent} value={(r) => r.n} fmt={(v) => String(v)} color={C_QTY} onPick={pick('component')} note={(r) => hrs(r.workH)} /></Card>}
        {!adj && d.byTool.length > 0 && <Card title="Dispositivos e trim dies com mais OS"><Ranking rows={d.byTool} value={(r) => r.n} fmt={(v) => String(v)} color={C_QTY} /></Card>}
      </div>
    </div>
  );
}

function Records({ api, params, adj, onOpen, exportHref }: { api: string; params: Record<string, string>; adj: boolean; onOpen: (id: string) => void; exportHref: string }) {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [sort, setSort] = useState<{ k: string; dir: 'asc' | 'desc' }>({ k: 'opened_at', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [review, setReview] = useState(false);
  const p = { ...params, q: term || undefined, sort: sort.k, dir: sort.dir, page, review: review ? '1' : undefined };
  const r = useQuery<{ total: number; page: number; size: number; rows: RecordRow[] }>({ queryKey: ['os', 'analytics-records', api, p], queryFn: () => get(`${api}/analytics/records${qs(p)}`), placeholderData: keepPreviousData });
  const pages = r.data ? Math.max(1, Math.ceil(r.data.total / r.data.size)) : 1;
  const th = (k: string, l: string, cls = '') => (
    <th className={cx('cursor-pointer select-none whitespace-nowrap px-2 py-2', cls)} aria-sort={sort.k === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => { setSort({ k, dir: sort.k === k && sort.dir === 'desc' ? 'asc' : 'desc' }); setPage(1); }}>{l}{sort.k === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>
  );
  return (
    <Card title={`Registros${r.data ? ` (${r.data.total})` : ''}`} actions={
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); setTerm(text.trim()); setPage(1); }} className="flex gap-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Nº, PN, máquina, técnico ou palavra do serviço" aria-label="Pesquisar nos registros" className="w-64" />
          <Button type="submit" size="sm">Pesquisar</Button>
        </form>
        <label className="inline-flex items-center gap-1 text-xs text-gray-700"><input type="checkbox" checked={review} onChange={(e) => { setReview(e.target.checked); setPage(1); }} />Só as para conferir</label>
        <a href={exportHref} className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"><Download size={14} />Excel</a>
      </div>}>
      {r.error && <ErrorBox error={r.error} />}
      {!r.data && !r.error && <Spinner />}
      {r.data && (r.data.rows.length ? (<>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
              {th('code', 'Ordem')}{th('opened_at', 'Data e hora')}{th('shift', 'Turno')}{th('asset', 'Máquina')}{th('pn', 'PN')}{th('category', adj ? 'Motivo' : 'Tipo')}{th('techs', 'Técnico')}{th('duration', 'Duração', 'text-right')}{th('stopped', 'Parada', 'text-right')}{th('status', 'Status')}
            </tr></thead>
            <tbody>{r.data.rows.map((x) => (
              <tr key={x.id} onClick={() => onOpen(x.id)} className="cursor-pointer border-b align-top last:border-0 hover:bg-gray-50">
                <td className="whitespace-nowrap px-2 py-2 font-semibold">{x.code}{x.imported && <span className="block text-[10px] font-normal text-gray-500">histórico{x.legacy ? ` · ${x.legacy}` : ''}</span>}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular">{new Date(x.openedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                <td className="whitespace-nowrap px-2 py-2">{x.shift ?? '—'}</td>
                <td className="whitespace-nowrap px-2 py-2">{x.asset}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular">{x.pn ?? <span className="text-gray-400">sem PN</span>}</td>
                <td className="max-w-48 px-2 py-2">{x.category}{!adj && x.type === 'preventiva' && <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] font-semibold text-emerald-700">PREVENTIVA</span>}</td>
                <td className="px-2 py-2">{x.techs.length ? x.techs.map((t) => <span key={t} className="block whitespace-nowrap">{t}</span>) : '—'}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular">{x.durationMin == null ? '—' : min(x.durationMin)}{x.review && <span title={x.review} className="ml-1 inline-flex text-amber-600"><AlertTriangle size={13} /></span>}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular text-red-700">{x.stopped ? hrs(x.stoppedH) : ''}</td>
                <td className="whitespace-nowrap px-2 py-2">{x.statusLabel}</td>
              </tr>
            )).flatMap((row, i) => {
              const x = r.data!.rows[i];
              // what was reported and what the technician did, right under each order
              return [row, (
                <tr key={`${x.id}-txt`} onClick={() => onOpen(x.id)} className="cursor-pointer border-b bg-gray-50/60 text-xs last:border-0 hover:bg-gray-100">
                  <td colSpan={10} className="px-2 pb-2.5 pt-1">
                    <div className="grid gap-1.5 md:grid-cols-3">
                      <p className="min-w-0"><span className="font-semibold text-gray-500">Problema: </span>{x.description}</p>
                      <p className="min-w-0"><span className="font-semibold text-gray-500">{adj ? 'Ação tomada' : 'O que o técnico fez'}: </span>{x.serviceDone ?? <i className="text-gray-400">ainda não finalizada</i>}</p>
                      <p className="min-w-0"><span className="font-semibold text-gray-500">{adj ? 'Observações' : 'Material / observações'}: </span>{x.notes || <span className="text-gray-400">—</span>}</p>
                    </div>
                  </td>
                </tr>
              )];
            })}</tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-gray-500">Página {r.data.page} de {pages} · {r.data.total} ordem(ns)</span>
          <div className="flex gap-1">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button>
            <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</Button>
          </div>
        </div>
      </>) : <Empty>Nenhuma ordem encontrada com esses filtros{term ? ` e a pesquisa "${term}"` : ''}.</Empty>)}
    </Card>
  );
}

function Criteria({ d }: { d: Analytics }) {
  return (
    <details className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
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
