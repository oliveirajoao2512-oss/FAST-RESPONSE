import { useQuery } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { woCategory } from '@shared/maintenance';
import { get, qs } from '../../lib/api';
import { duration, fmtShort, num } from '../../lib/format';
import { useWoDomain, useWoList } from '../../lib/workOrders';
import { Button, Card, cx, Empty, ErrorBox, Input, Kpi, Segmented, Select, Spinner } from '../ui';

// same validated hues used by the other panels (blue / green / orange); a legend is shown whenever two series share a chart
const C_OPENED = '#2a78d6';
const C_FINISHED = '#1baf7a';
const C_WAIT = '#ea6a1f';
const C_WORK = '#2a78d6';
const C_STOPPED = '#d03b3b';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
const h = (v: number | null | undefined) =>
  v == null ? '—' : v < 1 ? `${Math.round(v * 60)} min` : v < 48 ? `${num(v)} h` : `${Math.round(v).toLocaleString('pt-BR')} h (${Math.round(v / 24)} dias)`;
const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
const iso = (d: Date) => d.toLocaleDateString('en-CA');

type Period = '30d' | '3m' | '6m' | '12m' | 'custom';
const PERIODS: { value: Period; label: string }[] = [
  { value: '30d', label: '30 dias' },
  { value: '3m', label: '3 meses' },
  { value: '6m', label: '6 meses' },
  { value: '12m', label: '12 meses' },
  { value: 'custom', label: 'Outro' },
];
function rangeOf(p: Period): { from: string; to: string } {
  const now = new Date();
  const to = iso(now);
  if (p === '30d') return { from: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), to };
  const back = p === '3m' ? 2 : p === '12m' ? 11 : 5;
  return { from: iso(new Date(now.getFullYear(), now.getMonth() - back, 1)), to };
}

const bucketLabel = (key: string, bucket: 'dia' | 'semana' | 'mes') => {
  const [y, m, d] = key.split('-');
  if (bucket === 'mes') return `${MONTHS[Number(m) - 1]}/${y.slice(2)}`;
  return `${d}/${m}`;
};

interface Report {
  from: string; to: string; bucket: 'dia' | 'semana' | 'mes';
  now: { aberta: number; em_atendimento: number; pausada: number; criticas: number; paradas: number };
  totals: { opened: number; finished: number; stoppedOpened: number; waitH: number | null; workH: number | null; totalH: number | null; stoppedH: number; quickPct: number | null };
  series: { key: string; opened: number; finished: number; waitH: number | null; workH: number | null }[];
  assets: Group[];
  byCategory: Group[];
  byArea: Group[];
  heat: number[][];
  pauses: { reason: string; n: number; hours: number }[];
  workers: { id: string; name: string; hours: number; orders: number; finished: number }[];
  filters: { areas: { id: number; name: string }[]; categories: { key: string; label: string }[] };
}
interface Group { key: string; label: string; n: number; stoppedH: number; finished: number; workH: number | null }

/** Dashboard of one order module, for the leadership of its area: indicators, charts and history. */
export function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const D = useWoDomain();
  const adj = D.d === 'ajuste';
  const [period, setPeriod] = useState<Period>('6m');
  const [custom, setCustom] = useState(() => rangeOf('6m'));
  const [areaId, setAreaId] = useState('');
  const [category, setCategory] = useState('');
  const [asset, setAsset] = useState('');
  const range = period === 'custom' ? custom : rangeOf(period);
  const params = { ...range, areaId: areaId || undefined, category: category || undefined, asset: asset || undefined };
  const r = useQuery<Report>({ queryKey: ['os', D.d, 'report', params], queryFn: () => get(`${D.api}/report${qs(params)}`) });
  const filtered = !!(areaId || category || asset);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <div>
          <span className="mb-0.5 block text-xs text-gray-600">Período</span>
          <Segmented value={period} onChange={(p) => { if (p === 'custom') setCustom(range); setPeriod(p); }} options={PERIODS} />
        </div>
        {period === 'custom' && (
          <>
            <label className="text-xs text-gray-600">De<Input type="date" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} className="mt-0.5 w-40" /></label>
            <label className="text-xs text-gray-600">Até<Input type="date" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} className="mt-0.5 w-40" /></label>
          </>
        )}
        <label className="text-xs text-gray-600">Setor
          <Select value={areaId} onChange={(e) => setAreaId(e.target.value)} className="mt-0.5 w-40">
            <option value="">Todos</option>
            {r.data?.filters.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </label>
        <label className="text-xs text-gray-600">{adj ? 'Motivo' : 'Tipo'}
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-0.5 w-52">
            <option value="">Todos</option>
            {r.data?.filters.categories.slice().sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true })).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </Select>
        </label>
        {asset && (
          <span className="inline-flex items-center gap-1 self-center rounded-full bg-brand-50 px-3 py-1 text-sm text-brand-800">
            Máquina {asset}<button aria-label="Tirar filtro de máquina" onClick={() => setAsset('')}><X size={14} /></button>
          </span>
        )}
        {filtered && <Button kind="ghost" size="sm" onClick={() => { setAreaId(''); setCategory(''); setAsset(''); }}>Limpar filtros</Button>}
        <a href={`${D.api}/export.xlsx${qs(params)}`} className="ml-auto"><Button><Download size={16} />Exportar Excel</Button></a>
      </div>

      {r.isLoading ? <Spinner /> : r.error ? <ErrorBox error={r.error} onRetry={() => r.refetch()} /> : r.data && (
        <Charts d={r.data} adj={adj} onCategory={setCategory} onAsset={setAsset} />
      )}

      <History range={range} asset={asset} areaId={areaId} category={category} onOpen={onOpen} />
    </div>
  );
}

function Charts({ d, adj, onCategory, onAsset }: { d: Report; adj: boolean; onCategory: (k: string) => void; onAsset: (a: string) => void }) {
  const D = useWoDomain();
  const series = d.series.map((s) => ({ ...s, label: bucketLabel(s.key, d.bucket), waitH: round1(s.waitH), workH: round1(s.workH) }));
  const per = d.bucket === 'dia' ? 'por dia' : d.bucket === 'semana' ? 'por semana' : 'por mês';
  const axis = { tick: { fontSize: 11, fill: '#6b7280' }, tickLine: false };
  const workLabel = adj ? 'Tempo de ajuste' : 'Atendimento';
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Aguardando aceite" value={d.now.aberta} tone={d.now.aberta ? 'warn' : 'default'} hint={`${d.now.criticas} crítica(s) · ${d.now.paradas} com máquina parada`} />
        <Kpi label="Em atendimento" value={d.now.em_atendimento} tone="info" hint={`${d.now.pausada} pausada(s)`} />
        <Kpi label="Abertas no período" value={d.totals.opened} hint={`${d.totals.finished} finalizada(s) · ${d.totals.stoppedOpened} com máquina parada`} />
        <Kpi label="Espera média" value={h(d.totals.waitH)} hint={d.totals.quickPct == null ? 'abertura até o aceite' : `${Math.round(d.totals.quickPct * 100)}% aceitas em até 30 min`} />
        <Kpi label={`${workLabel} médio`} value={h(d.totals.workH)} hint={`sem pausas · total médio ${h(d.totals.totalH)}`} />
        <Kpi label="Máquina parada" value={h(d.totals.stoppedH)} tone={d.totals.stoppedH ? 'danger' : 'default'} hint="soma no período" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`${D.short} abertas e finalizadas ${per}`}>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={series} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="label" {...axis} axisLine={{ stroke: '#d1d5db' }} minTickGap={8} />
                <YAxis allowDecimals={false} {...axis} axisLine={false} />
                <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" formatter={(v) => <span className="text-gray-700">{v}</span>} />
                <Bar dataKey="opened" name="Abertas" fill={C_OPENED} radius={[4, 4, 0, 0]} maxBarSize={24} />
                <Bar dataKey="finished" name="Finalizadas" fill={C_FINISHED} radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title={`Tempo médio ${per} (horas)`}>
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={series} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="label" {...axis} axisLine={{ stroke: '#d1d5db' }} minTickGap={8} />
                <YAxis {...axis} axisLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v) => h(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" formatter={(v) => <span className="text-gray-700">{v}</span>} />
                <Line dataKey="waitH" name="Espera na fila" stroke={C_WAIT} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                <Line dataKey="workH" name={workLabel} stroke={C_WORK} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={adj ? 'Motivos mais frequentes' : 'OS por tipo de manutenção'} actions={<span className="text-xs text-gray-500">clique para filtrar</span>}>
          <HBars data={d.byCategory.map((c) => ({ key: c.key, label: c.label, value: c.n, extra: c.stoppedH ? `${h(c.stoppedH)} parada` : '' }))}
            unit={(v) => `${v} ${D.short}`} color={C_OPENED} onPick={onCategory} empty="Nenhuma ordem no período." />
        </Card>
        <Card title="Máquinas com mais horas paradas" actions={<span className="text-xs text-gray-500">clique para filtrar</span>}>
          <HBars data={d.assets.filter((a) => a.stoppedH > 0 || a.n > 0).map((a) => ({ key: a.label, label: a.label, value: a.stoppedH, extra: `${a.n} ${D.short}` }))}
            unit={(v) => h(v)} color={C_STOPPED} onPick={onAsset} empty="Nenhuma máquina parada no período." />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <Card title={`Horas por ${D.worker}`}>
          <HBars data={d.workers.map((w) => ({ key: w.id, label: w.name, value: w.hours, extra: `${w.orders} ${D.short} · ${w.finished} finalizada(s)` }))}
            unit={(v) => h(v)} color={C_WORK} empty="Nenhum atendimento no período." />
        </Card>
        <Card title="Setores que mais abrem">
          <HBars data={d.byArea.map((a) => ({ key: a.key, label: a.label, value: a.n, extra: '' }))} unit={(v) => `${v} ${D.short}`} color={C_OPENED} empty="—" />
        </Card>
        <Card title="Tempo pausado por motivo">
          <HBars data={d.pauses.map((p) => ({ key: p.reason, label: p.reason, value: p.hours, extra: `${p.n} pausa(s)` }))} unit={(v) => h(v)} color={C_WAIT} empty="Nenhuma pausa no período." />
        </Card>
      </div>

      <Card title="Quando os chamados acontecem" actions={<span className="text-xs text-gray-500">aberturas por dia da semana e hora</span>}>
        <Heatmap heat={d.heat} short={D.short} />
      </Card>
    </>
  );
}

/** Horizontal bars, sorted as received, with the value written at the end of each bar. */
function HBars({ data, unit, color, onPick, empty }: {
  data: { key: string; label: string; value: number; extra: string }[]; unit: (v: number) => string; color: string; onPick?: (k: string) => void; empty: string;
}) {
  const rows = data.filter((x) => x.value > 0).slice(0, 12);
  if (!rows.length) return <p className="text-sm text-gray-500">{empty}</p>;
  const max = Math.max(...rows.map((x) => x.value));
  return (
    <ul className="space-y-1.5">
      {rows.map((x) => (
        <li key={x.key}>
          <button type="button" disabled={!onPick} onClick={() => onPick?.(x.key)} title={onPick ? 'Filtrar por este item' : undefined}
            className={cx('group grid w-full grid-cols-[minmax(0,11rem)_1fr] items-center gap-3 rounded-md px-1 py-0.5 text-left text-sm sm:grid-cols-[minmax(0,15rem)_1fr]', onPick && 'hover:bg-gray-50')}>
            <span className="truncate text-gray-800" title={x.label}>{x.label}</span>
            <span className="flex items-center gap-2">
              <span className="h-3.5 rounded-r" style={{ width: `${Math.max(2, (x.value / max) * 100)}%`, background: color, maxWidth: 'calc(100% - 7rem)' }} />
              <span className="whitespace-nowrap text-xs tabular text-gray-700"><b className="text-gray-900">{unit(x.value)}</b>{x.extra && <span className="text-gray-500"> · {x.extra}</span>}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Weekday × hour grid of openings, one hue from light to dark. */
function Heatmap({ heat, short }: { heat: number[][]; short: string }) {
  const max = Math.max(1, ...heat.flat());
  const total = heat.flat().reduce((a, b) => a + b, 0);
  if (!total) return <p className="text-sm text-gray-500">Nenhuma abertura no período.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="mx-auto border-separate" style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th />
            {Array.from({ length: 24 }, (_, hr) => <th key={hr} className="w-6 text-center text-[10px] font-normal text-gray-500">{hr % 3 === 0 ? `${hr}h` : ''}</th>)}
          </tr>
        </thead>
        <tbody>
          {heat.map((row, d) => (
            <tr key={d}>
              <th className="pr-2 text-right text-xs font-normal text-gray-600">{WEEKDAYS[d]}</th>
              {row.map((n, hr) => (
                <td key={hr} title={`${WEEKDAYS[d]} ${hr}h: ${n} ${short}`} className="h-6 w-6 rounded"
                  style={{ background: n ? `rgba(42,120,214,${0.15 + 0.85 * (n / max)})` : '#f3f4f6' }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-center text-xs text-gray-500">Mais escuro = mais aberturas (máximo {max} no mesmo horário).</p>
    </div>
  );
}

/** Finished orders in the period, with the same filters, to look back at each one. */
function History({ range, asset, areaId, category, onOpen }: { range: { from: string; to: string }; asset: string; areaId: string; category: string; onOpen: (id: string) => void }) {
  const D = useWoDomain();
  const adj = D.d === 'ajuste';
  const [text, setText] = useState('');
  const list = useWoList('finalizadas', { ...range, asset: asset || undefined, q: text.trim() || undefined });
  const rows = useMemo(() => (list.data ?? []).filter((o) =>
    (!areaId || String(o.area_id) === areaId) && (!category || String(o.kind ?? o.reason) === category)), [list.data, areaId, category]);
  return (
    <Card title={`Histórico de ${D.short} finalizadas`} actions={
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Buscar no histórico…" aria-label="Buscar no histórico" className="w-56" />}>
      {list.isLoading ? <Spinner /> : list.error ? <ErrorBox error={list.error} /> : !rows.length ? <Empty>Nenhuma {D.short} finalizada com esses filtros.</Empty> : (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="px-4 pb-2 font-medium">{D.short}</th>
                <th className="pb-2 font-medium">Máquina</th>
                <th className="pb-2 font-medium">{adj ? 'Motivo' : 'Tipo'}</th>
                <th className="pb-2 font-medium">{adj ? 'Chamada' : 'Abertura'}</th>
                <th className="pb-2 font-medium">Finalização</th>
                <th className="pb-2 text-right font-medium">Espera</th>
                <th className="pb-2 text-right font-medium">{adj ? 'Ajuste' : 'Atendimento'}</th>
                <th className="pb-2 pl-3 font-medium">Finalizada por</th>
                <th className="px-4 pb-2 font-medium">{adj ? 'Ação tomada' : 'Serviço'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((o) => (
                <tr key={o.id} className="cursor-pointer hover:bg-gray-50" onClick={() => onOpen(o.id)}>
                  <td className="px-4 py-2 font-mono text-xs"><button className="text-brand-700 hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(o.id); }}>{o.code}</button></td>
                  <td className="py-2 font-medium">{o.asset_ref}{o.machine_stopped && <span className="ml-1 text-xs font-bold text-red-700">parada</span>}</td>
                  <td className="max-w-48 truncate py-2" title={woCategory(o)}>{woCategory(o)}</td>
                  <td className="py-2 tabular text-gray-600">{fmtShort(o.opened_at)}</td>
                  <td className="py-2 tabular text-gray-600">{fmtShort(o.finished_at)}</td>
                  <td className="py-2 text-right tabular">{duration(o.times.waitMs)}</td>
                  <td className="py-2 text-right tabular">{o.times.workMs == null ? '—' : duration(o.times.workMs)}</td>
                  <td className="py-2 pl-3">{o.finished_by_name}</td>
                  <td className="max-w-72 truncate px-4 py-2 text-gray-700" title={o.service_done ?? ''}>{o.service_done}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length >= 300 && <p className="px-4 pt-2 text-xs text-gray-500">Mostrando as 300 mais recentes. Use o Excel para o período completo.</p>}
        </div>
      )}
    </Card>
  );
}
