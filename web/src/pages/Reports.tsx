import { useQuery } from '@tanstack/react-query';
import { Download, Printer, SlidersHorizontal, Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { STATUS_LABELS, type Status } from '@shared/constants';
import { useOpenIssue } from '../components/issues';
import { AreaDot, Button, Card, ErrorBox, Input, Kpi, Select, Spinner } from '../components/ui';
import { get, qs } from '../lib/api';
import { fmtDate, hours, num } from '../lib/format';
import { useMeta } from '../lib/meta';
import { useWoOptions } from '../lib/workOrders';

function defaultFrom() {
  const d = new Date();
  d.setMonth(d.getMonth() - 5, 1);
  return d.toISOString().slice(0, 10);
}

export function ReportsPage() {
  const meta = useMeta();
  const openIssue = useOpenIssue();
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [areaId, setAreaId] = useState('');
  const [priority, setPriority] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const params = { from, to, areaId, priority, assigneeId };
  const q = useQuery({ queryKey: ['reports', params], queryFn: () => get(`/api/reports${qs(params)}`) });
  const exp = (table: string) => `/api/reports/export.csv${qs({ ...params, table })}`;
  const r = q.data;
  // each order dashboard is only for the leadership of its area
  const osLead = !!useWoOptions('manutencao').data?.canLead;
  const oaLead = !!useWoOptions('ajuste').data?.canLead;
  const maxCat = Math.max(1, ...(r?.categories ?? []).map((c: any) => c.count));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold">Indicadores gerenciais</h1>
        <div className="flex flex-wrap gap-2">
          {osLead && <Link to="/os?tab=dashboard"><Button><Wrench size={16} />Dashboard de manutenção</Button></Link>}
          {oaLead && <Link to="/ajustes?tab=dashboard"><Button><SlidersHorizontal size={16} />Dashboard de ajustes</Button></Link>}
          <Button onClick={() => window.print()}><Printer size={16} />Imprimir / PDF</Button>
        </div>
      </div>
      <div className="grid gap-2 rounded-xl border border-gray-200 bg-white p-3 sm:grid-cols-3 lg:grid-cols-5">
        <label className="text-xs text-gray-600">De<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs text-gray-600">Até<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="text-xs text-gray-600">Área<Select value={areaId} onChange={(e) => setAreaId(e.target.value)}><option value="">Todas</option>{meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></label>
        <label className="text-xs text-gray-600">Prioridade<Select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">Todas</option><option value="critica">Crítica</option><option value="alta">Alta</option><option value="media">Média</option><option value="baixa">Baixa</option></Select></label>
        <label className="text-xs text-gray-600">Responsável<Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}><option value="">Todos</option>{meta?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></label>
      </div>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Concluídas (validadas)" value={r.resolution.count} />
            <Kpi label="Tempo médio" value={hours(r.resolution.avg_hours)} />
            <Kpi label="Tempo mediano" value={hours(r.resolution.median_hours)} />
            <Kpi label="90% resolvidas em até" value={hours(r.resolution.p90_hours)} />
            <Kpi label="Dentro do prazo" value={r.resolution.on_time_pct == null ? '—' : `${num(r.resolution.on_time_pct)}%`} tone="ok" />
            <Kpi label="Reaberturas" value={r.resolution.reopens ?? 0} tone={r.resolution.reopens ? 'warn' : 'default'} />
          </div>
          <p className="text-xs text-gray-500">Tempo de resolução = da abertura até a conclusão registrada (tempo corrido). O sistema não registra tempo efetivamente trabalhado; tempo em status não é tempo de trabalho.</p>

          <Card title="Comparativo entre áreas" actions={<a className="inline-flex items-center gap-1 text-sm text-brand-700" href={exp('areas')}><Download size={14} />CSV</a>}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Área</th><th className="text-right">Abertas</th><th className="text-right">Concluídas</th><th className="text-right">No prazo</th><th className="text-right">Média</th><th className="text-right">Mediana</th><th className="text-right">Em aberto agora</th><th className="text-right">Vencidas agora</th></tr></thead>
                <tbody className="divide-y">
                  {r.areas.map((a: any) => (
                    <tr key={a.id}><td className="py-1.5"><span className="inline-flex items-center gap-2"><AreaDot color={a.color} />{a.name}</span></td>
                      <td className="text-right tabular">{a.opened}</td><td className="text-right tabular">{a.completed}</td>
                      <td className="text-right tabular">{a.on_time_pct == null ? '—' : `${num(a.on_time_pct)}%`}</td>
                      <td className="text-right tabular">{hours(a.avg_hours)}</td><td className="text-right tabular">{hours(a.median_hours)}</td>
                      <td className="text-right tabular">{a.open_now}</td><td className={`text-right tabular ${a.overdue_now ? 'font-semibold text-red-700' : ''}`}>{a.overdue_now}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Abertas × concluídas por mês" actions={<a className="inline-flex items-center gap-1 text-sm text-brand-700" href={exp('months')}><Download size={14} />CSV</a>}>
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Mês</th><th className="text-right">Abertas</th><th className="text-right">Concluídas</th><th className="text-right">Canceladas</th><th className="text-right">No prazo</th></tr></thead>
                <tbody className="divide-y">{r.openedVsClosed.map((m: any) => (
                  <tr key={m.month}><td className="py-1.5">{m.month.split('-').reverse().join('/')}</td><td className="text-right tabular">{m.opened}</td><td className="text-right tabular">{m.completed}</td><td className="text-right tabular">{m.cancelled}</td><td className="text-right tabular">{m.on_time_pct == null ? '—' : `${num(m.on_time_pct)}%`}</td></tr>
                ))}</tbody>
              </table>
            </Card>
            <Card title="Tempo de permanência em cada status">
              <p className="mb-2 text-xs text-gray-500">Pendências abertas no período. Mostra espera e fluxo, não tempo trabalhado.</p>
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Status</th><th className="text-right">Pendências</th><th className="text-right">Média</th><th className="text-right">Mediana</th></tr></thead>
                <tbody className="divide-y">{r.statusTime.map((s: any) => (
                  <tr key={s.status}><td className="py-1.5">{STATUS_LABELS[s.status as Status]}</td><td className="text-right tabular">{s.issues}</td><td className="text-right tabular">{hours(s.avg_hours)}</td><td className="text-right tabular">{hours(s.median_hours)}</td></tr>
                ))}</tbody>
              </table>
            </Card>
            <Card title="Principais categorias de problemas" actions={<a className="inline-flex items-center gap-1 text-sm text-brand-700" href={exp('categories')}><Download size={14} />CSV</a>}>
              <ul className="space-y-2">{r.categories.map((c: any) => (
                <li key={c.name} className="text-sm">
                  <div className="flex justify-between"><span>{c.name}</span><span className="tabular">{c.count}{c.recurrent > 0 && <span className="ml-2 text-xs text-purple-700">{c.recurrent} reincid.</span>}</span></div>
                  <div className="mt-1 h-2 rounded-full bg-gray-100"><div className="h-2 rounded-full bg-chart-a" style={{ width: `${(c.count / maxCat) * 100}%` }} /></div>
                </li>
              ))}</ul>
            </Card>
            <Card title="Pendências reincidentes">
              {r.recurrent.length === 0 ? <p className="text-sm text-gray-500">Nenhuma reincidência no período.</p> : (
                <ul className="divide-y text-sm">{r.recurrent.map((x: any) => (
                  <li key={x.id} className="py-1.5">
                    <button className="text-left hover:underline" onClick={() => openIssue(x.id)}><span className="font-mono text-xs">{x.code}</span> {x.title}</button>
                    <div className="text-xs text-gray-500">{x.area_name} · {x.asset_ref ?? 'sem referência'} · {fmtDate(x.opened_at)} · reincidência de <button className="underline" onClick={() => openIssue(x.recurrence_of_id)}>{x.recurrence_of_code}</button></div>
                  </li>
                ))}</ul>
              )}
            </Card>
          </div>

          <Card title="Volume por colaborador" actions={<a className="inline-flex items-center gap-1 text-sm text-brand-700" href={exp('collaborators')}><Download size={14} />CSV</a>}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Colaborador</th><th>Área</th><th className="text-right">Em aberto</th><th className="text-right">Atrasadas</th><th className="text-right">Concluídas</th><th className="text-right">No prazo</th><th className="text-right">Tempo médio</th></tr></thead>
                <tbody className="divide-y">{r.collaborators.map((c: any) => (
                  <tr key={c.id}><td className="py-1.5 font-medium">{c.name}</td><td>{c.area_name ?? '—'}</td><td className="text-right tabular">{c.open_now}</td>
                    <td className={`text-right tabular ${c.overdue_now ? 'font-semibold text-red-700' : ''}`}>{c.overdue_now}</td><td className="text-right tabular">{c.completed}</td>
                    <td className="text-right tabular">{c.on_time_pct == null ? '—' : `${num(c.on_time_pct)}%`}</td><td className="text-right tabular">{hours(c.avg_hours)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
          <a className="inline-flex items-center gap-1 text-sm text-brand-700" href={`/api/issues/export.csv${qs({ areaId, priority, assigneeId, openedFrom: from, openedTo: to })}`}><Download size={14} />Exportar lista de pendências abertas no período (CSV)</a>
        </>
      )}
    </div>
  );
}
