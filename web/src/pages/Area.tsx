import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { FilterBar, toApi, useFilters } from '../components/Filters';
import { Card, cx, ErrorBox, Kpi, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { hours, num } from '../lib/format';
import { useIssues, usePersistentState } from '../lib/hooks';
import { IssueResults, ViewToggle } from './Issues';

export function AreaPage() {
  const { slug } = useParams();
  const s = useQuery({ queryKey: ['area', slug], queryFn: () => get(`/api/areas/${slug}/summary`) });
  const f = useFilters({ flag: 'open' });
  const [view, setView] = usePersistentState<'kanban' | 'list'>('fr:view:area', 'kanban');
  const area = s.data?.area;
  const q = useIssues({ ...toApi(f.values), areaId: area?.id, areaScope: 'involved', limit: 500 }, Boolean(area));
  if (s.isLoading) return <Spinner />;
  if (s.error) return <ErrorBox error={s.error} onRetry={() => s.refetch()} />;
  const k = s.data.kpi;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 border-l-4 pl-3" style={{ borderColor: area.color }}>
        <h1 className="text-2xl font-bold">{area.name}</h1>
        <span className="text-sm text-gray-500">Inclui pendências transferidas de ou para a área.</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Kpi label="Abertas" value={k.open} onClick={() => f.set({ flag: 'open' })} />
        <Kpi label="Atrasadas" value={k.overdue} tone={k.overdue ? 'danger' : 'default'} onClick={() => f.set({ flag: 'overdue' })} />
        <Kpi label="Vencem hoje" value={k.due_today} tone={k.due_today ? 'warn' : 'default'} onClick={() => f.set({ flag: 'due_today' })} />
        <Kpi label="Bloqueadas" value={k.blocked} onClick={() => f.set({ flag: 'blocked' })} />
        <Kpi label="Aguard. validação" value={k.awaiting_validation} onClick={() => f.set({ flag: 'awaiting_validation' })} />
        <Kpi label="Concluídas (mês)" value={k.completed_period} tone="ok" onClick={() => f.set({ flag: 'completed' })} />
        <Kpi label="No prazo (mês)" value={k.on_time_pct == null ? '—' : `${num(k.on_time_pct)}%`} />
        <Kpi label="Tempo médio" value={hours(k.avg_resolution_hours)} />
      </div>
      <Card title="Pendências por colaborador">
        {s.data.people.length === 0 ? <p className="text-sm text-gray-500">Nenhum colaborador com pendências na área.</p> : (
          <div className="flex flex-wrap gap-2">
            {s.data.people.map((p: any) => (
              <button key={p.id} onClick={() => f.set({ assigneeId: f.values.assigneeId === p.id ? '' : p.id, flag: 'open' })}
                className={cx('rounded-lg border px-3 py-2 text-left text-sm', f.values.assigneeId === p.id ? 'border-brand-600 bg-brand-50' : 'border-gray-200 bg-white hover:border-brand-300')}>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-gray-600">
                  {p.open} abertas · {p.in_progress} em andamento
                  {p.overdue > 0 && <span className="font-semibold text-red-700"> · {p.overdue} atrasadas</span>}
                  {p.blocked > 0 && <span className="text-fuchsia-700"> · {p.blocked} bloqueadas</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1"><FilterBar f={f} hideArea /></div>
        <ViewToggle view={view} setView={setView} />
      </div>
      {area && <IssueResults q={q} view={view} />}
    </div>
  );
}
