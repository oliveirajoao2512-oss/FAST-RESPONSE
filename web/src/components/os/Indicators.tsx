import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { WO_KIND_LABELS, type WoKind } from '@shared/maintenance';
import { get, qs } from '../../lib/api';
import { num } from '../../lib/format';
import { Button, Card, ErrorBox, Input, Kpi, Spinner } from '../ui';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
// same validated pair used by the quality panel (blue / green), always with a legend
const C_OPENED = '#2a78d6';
const C_FINISHED = '#1baf7a';
const C_WAIT = '#ea6a1f';
const C_WORK = '#2a78d6';

const h = (v: number | null | undefined) => (v == null ? '—' : v < 1 ? `${Math.round(v * 60)} min` : `${num(v)} h`);
const monthStart = (d: Date, back: number) => new Date(d.getFullYear(), d.getMonth() - back, 1).toLocaleDateString('en-CA');

export function Indicators() {
  const [from, setFrom] = useState(() => monthStart(new Date(), 5));
  const [to, setTo] = useState(() => new Date().toLocaleDateString('en-CA'));
  const r = useQuery({ queryKey: ['os', 'report', from, to], queryFn: () => get(`/api/os/report${qs({ from, to })}`) });
  if (r.isLoading) return <Spinner />;
  if (r.error) return <ErrorBox error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const byMonth = d.byMonth.map((m: any) => ({ ...m, label: monthLabel(m.month), waitH: m.waitH == null ? null : Math.round(m.waitH * 10) / 10, workH: m.workH == null ? null : Math.round(m.workH * 10) / 10 }));
  const axis = { tick: { fontSize: 11, fill: '#6b7280' }, tickLine: false };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-600">De<Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="mt-0.5 w-40" /></label>
        <label className="text-xs text-gray-600">Até<Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="mt-0.5 w-40" /></label>
        <a href={`/api/os/export.xlsx${qs({ from, to })}`} className="ml-auto"><Button><Download size={16} />Exportar Excel</Button></a>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Na fila agora" value={d.now.aberta} tone={d.now.aberta ? 'warn' : 'default'} hint={`${d.now.criticas} crítica(s) em aberto`} />
        <Kpi label="Em atendimento" value={d.now.em_atendimento} tone="info" hint={`${d.now.pausada} pausada(s)`} />
        <Kpi label="Abertas no período" value={d.totals.opened} hint={`${d.totals.finished} finalizada(s)`} />
        <Kpi label="Espera média" value={h(d.totals.waitH)} hint="abertura até o aceite" />
        <Kpi label="Atendimento médio" value={h(d.totals.workH)} hint="sem o tempo pausado" />
        <Kpi label="Máquina parada" value={h(d.totals.stoppedH)} tone={d.totals.stoppedH ? 'danger' : 'default'} hint="soma no período" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="OS abertas e finalizadas por mês">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={byMonth} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="label" {...axis} axisLine={{ stroke: '#d1d5db' }} />
                <YAxis allowDecimals={false} {...axis} axisLine={false} />
                <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" formatter={(v) => <span className="text-gray-700">{v}</span>} />
                <Bar dataKey="opened" name="Abertas" fill={C_OPENED} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="finished" name="Finalizadas" fill={C_FINISHED} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Tempo médio por mês (horas)">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={byMonth} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="label" {...axis} axisLine={{ stroke: '#d1d5db' }} />
                <YAxis {...axis} axisLine={false} />
                <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v) => `${num(Number(v))} h`} />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" formatter={(v) => <span className="text-gray-700">{v}</span>} />
                <Bar dataKey="waitH" name="Espera na fila" fill={C_WAIT} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="workH" name="Atendimento" fill={C_WORK} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
        <Card title="Máquinas com mais horas paradas">
          <Table empty="Nenhuma OS no período." head={['Máquina', 'OS', 'Parada']} rows={d.assets.map((a: any) => [a.asset, a.orders, h(a.stoppedH)])} />
        </Card>
        <Card title="Horas por manutentor">
          <Table empty="Nenhum atendimento no período." head={['Manutentor', 'OS', 'Horas']} rows={d.workers.map((w: any) => [w.name, w.orders, h(w.hours)])} />
        </Card>
        <Card title="OS por tipo">
          <Table empty="—" head={['Tipo', 'OS']} rows={d.byKind.map((k: any) => [WO_KIND_LABELS[k.key as WoKind], k.n])} />
        </Card>
        <Card title="OS por setor">
          <Table empty="—" head={['Setor', 'OS']} rows={d.byArea.map((k: any) => [k.key, k.n])} />
        </Card>
      </div>
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: (string | number)[][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-gray-500">{empty}</p>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs text-gray-500">{head.map((x, i) => <th key={x} className={i ? 'pb-1 text-right font-medium' : 'pb-1 font-medium'}>{x}</th>)}</tr></thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'py-1.5 text-right tabular' : 'py-1.5 font-medium text-gray-900'}>{c}</td>)}</tr>)}
      </tbody>
    </table>
  );
}
