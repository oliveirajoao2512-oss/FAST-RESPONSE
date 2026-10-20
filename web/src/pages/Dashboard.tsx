import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, Award, Ban, CalendarCheck, CheckCircle2, Clock, Hourglass, ListTodo, ShieldAlert, Timer, UserX } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Evolution } from '../components/Evolution';
import { FLAG_LABELS, useFilters } from '../components/Filters';
import { IssueTable } from '../components/issues';
import { AreaDot, Button, Card, ErrorBox, Input, Kpi, Modal, Segmented, Select, Spinner } from '../components/ui';
import { get, qs } from '../lib/api';
import { hours, num } from '../lib/format';
import { useIssues } from '../lib/hooks';
import { useMeta } from '../lib/meta';
import { PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS } from '@shared/constants';

export function DashboardPage() {
  const meta = useMeta();
  const f = useFilters();
  const v = f.values;
  const params = { areaId: v.areaId, assigneeId: v.assigneeId, priority: v.priority, status: v.status, openedFrom: v.openedFrom, openedTo: v.openedTo, dueFrom: v.dueFrom, dueTo: v.dueTo };
  const [period, setPeriod] = useState<{ from?: string; to?: string }>({});
  const q = useQuery({ queryKey: ['dashboard', params, period], queryFn: () => get(`/api/dashboard${qs({ ...params, ...period })}`) });
  const [unit, setUnit] = useState<'week' | 'month'>('week');
  const [drill, setDrill] = useState<string | null>(null);

  const k = q.data?.kpi;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Painel geral</h1>
          <p className="text-sm text-gray-500">Clique em um indicador para ver a lista correspondente.</p>
        </div>
      </div>

      <div className="grid gap-2 rounded-xl border border-gray-200 bg-white p-3 sm:grid-cols-3 lg:grid-cols-6">
        <Select value={v.areaId ?? ''} onChange={(e) => f.set({ areaId: e.target.value })} aria-label="Área">
          <option value="">Todas as áreas</option>
          {meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select value={v.assigneeId ?? ''} onChange={(e) => f.set({ assigneeId: e.target.value })} aria-label="Responsável">
          <option value="">Todos os responsáveis</option>
          <option value="me">Eu</option>
          {meta?.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <Select value={v.priority ?? ''} onChange={(e) => f.set({ priority: e.target.value })} aria-label="Prioridade">
          <option value="">Todas as prioridades</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
        </Select>
        <Select value={v.status ?? ''} onChange={(e) => f.set({ status: e.target.value })} aria-label="Status">
          <option value="">Todos os status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </Select>
        <label className="flex items-center gap-1 text-xs text-gray-600">Aberta de<Input type="date" value={v.openedFrom ?? ''} onChange={(e) => f.set({ openedFrom: e.target.value })} /></label>
        <label className="flex items-center gap-1 text-xs text-gray-600">até<Input type="date" value={v.openedTo ?? ''} onChange={(e) => f.set({ openedTo: e.target.value })} /></label>
        <label className="flex items-center gap-1 text-xs text-gray-600">Vence de<Input type="date" value={v.dueFrom ?? ''} onChange={(e) => f.set({ dueFrom: e.target.value })} /></label>
        <label className="flex items-center gap-1 text-xs text-gray-600">até<Input type="date" value={v.dueTo ?? ''} onChange={(e) => f.set({ dueTo: e.target.value })} /></label>
        <label className="flex items-center gap-1 text-xs text-gray-600">Período de<Input type="date" value={period.from ?? ''} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value || undefined }))} /></label>
        <label className="flex items-center gap-1 text-xs text-gray-600">até<Input type="date" value={period.to ?? ''} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value || undefined }))} /></label>
        <Button kind="ghost" onClick={() => { f.clear(); setPeriod({}); }}>Limpar filtros</Button>
      </div>

      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {k && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Kpi icon={<ListTodo size={14} />} label="Em aberto" value={k.open} onClick={() => setDrill('open')} />
            <Kpi icon={<AlertOctagon size={14} />} label="Atrasadas" value={k.overdue} tone={k.overdue ? 'danger' : 'default'} onClick={() => setDrill('overdue')} />
            <Kpi icon={<Clock size={14} />} label="Vencem hoje" value={k.due_today} tone={k.due_today ? 'warn' : 'default'} onClick={() => setDrill('due_today')} />
            <Kpi icon={<ShieldAlert size={14} />} label="Críticas" value={k.critical} tone={k.critical ? 'danger' : 'default'} onClick={() => setDrill('safety')} />
            <Kpi icon={<UserX size={14} />} label="Sem responsável" value={k.unassigned} tone={k.unassigned ? 'warn' : 'default'} onClick={() => setDrill('unassigned')} />
            <Kpi icon={<Ban size={14} />} label="Bloqueadas" value={k.blocked} onClick={() => setDrill('blocked')} />
            <Kpi icon={<Hourglass size={14} />} label="Aguardando validação" value={k.awaiting_validation} onClick={() => setDrill('awaiting_validation')} />
            <Kpi icon={<CheckCircle2 size={14} />} label="Concluídas no período" value={k.completed_period} tone="ok" onClick={() => setDrill('completed')} hint="validadas" />
            <Kpi icon={<Timer size={14} />} label="Tempo médio" value={hours(k.avg_resolution_hours)} hint="abertura → conclusão" />
            <Kpi icon={<CalendarCheck size={14} />} label="No prazo" value={k.on_time_pct == null ? '—' : `${num(k.on_time_pct)}%`} tone={k.on_time_pct >= 80 ? 'ok' : k.on_time_pct == null ? 'default' : 'warn'} hint="das concluídas no período" />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Pendências por área (agora)" className="lg:col-span-1">
              <AreaBars rows={q.data.byArea} />
            </Card>
            <Card title="Evolução: abertas × concluídas" className="lg:col-span-2"
              actions={<Segmented value={unit} onChange={setUnit} options={[{ value: 'week', label: 'Semanal' }, { value: 'month', label: 'Mensal' }]} />}>
              <Evolution data={unit === 'week' ? q.data.weekly : q.data.monthly} unit={unit} />
            </Card>
          </div>

          <Card title={<span className="flex items-center gap-2"><Award size={16} className="text-brand-600" />Ranking do mês (parcial)</span>} actions={<Link to="/ranking" className="text-sm text-brand-700 hover:underline">Ver ranking completo</Link>}>
            {q.data.rankingTop.length === 0 ? <p className="text-sm text-gray-500">Nenhuma pendência validada neste mês ainda.</p> : (
              <ol className="divide-y">
                {q.data.rankingTop.map((u: any, idx: number) => (
                  <li key={u.user_id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="w-6 text-center font-bold text-gray-400">{idx + 1}º</span>
                    <span className="flex-1 font-medium">{u.name}<span className="ml-2 text-xs text-gray-500">{u.area_name}</span></span>
                    <span className="text-xs text-gray-500">{u.validated_count} validadas · {u.on_time_pct ?? '—'}% no prazo</span>
                    <span className="w-16 text-right font-bold tabular">{num(u.points)} pts</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      )}
      {drill && <DrillDown flag={drill} params={params} onClose={() => setDrill(null)} />}
    </div>
  );
}

function AreaBars({ rows }: { rows: any[] }) {
  const max = Math.max(1, ...rows.map((r) => r.open));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.id}>
          <Link to={`/areas/${r.slug}`} className="group block">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-medium group-hover:underline"><AreaDot color={r.color} />{r.name}</span>
              <span className="tabular text-gray-700">{r.open}{r.overdue > 0 && <span className="ml-2 font-semibold text-red-700">{r.overdue} atras.</span>}</span>
            </div>
            <div className="mt-1 flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-gray-100">
              {r.overdue > 0 && <div className="h-2 bg-red-600" style={{ width: `${(r.overdue / max) * 100}%` }} title={`${r.overdue} atrasadas`} />}
              <div className="h-2 rounded-r-full" style={{ width: `${((r.open - r.overdue) / max) * 100}%`, background: r.color }} title={`${r.open - r.overdue} no prazo`} />
            </div>
          </Link>
        </li>
      ))}
      <li className="flex gap-4 pt-1 text-xs text-gray-500"><span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-red-600" />atrasadas</span><span>cor da área = em aberto no prazo</span></li>
    </ul>
  );
}

function DrillDown({ flag, params, onClose }: { flag: string; params: Record<string, unknown>; onClose: () => void }) {
  const extra = flag === 'completed' ? { sort: 'updated' } : {};
  const q = useIssues({ ...params, flag, limit: 300, ...extra });
  return (
    <Modal open wide onClose={onClose} title={`${FLAG_LABELS[flag]}${q.data ? ` (${q.data.total})` : ''}`}
      footer={<Link to={`/pendencias${qs({ ...params, flag })}`} className="text-sm text-brand-700 hover:underline" onClick={onClose}>Abrir em tela cheia (Kanban / exportar)</Link>}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : <IssueTable items={q.data.items} />}
    </Modal>
  );
}
