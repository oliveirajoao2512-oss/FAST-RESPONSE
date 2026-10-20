import { Download, KanbanSquare, List } from 'lucide-react';
import { FilterBar, toApi, useFilters } from '../components/Filters';
import { IssueTable, Kanban } from '../components/issues';
import { ErrorBox, Segmented, Spinner } from '../components/ui';
import { qs } from '../lib/api';
import { useIssues, usePersistentState } from '../lib/hooks';

export function IssuesPage() {
  const f = useFilters({ flag: 'open' });
  const [view, setView] = usePersistentState<'kanban' | 'list'>('fr:view:all', 'list');
  const params = toApi(f.values);
  const q = useIssues({ ...params, limit: 500 });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Pendências {q.data && <span className="text-base font-normal text-gray-500">({q.data.total})</span>}</h1>
        <div className="flex items-center gap-2">
          <a className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50" href={`/api/issues/export.csv${qs(params)}`}><Download size={16} />Exportar CSV</a>
          <ViewToggle view={view} setView={setView} />
        </div>
      </div>
      <FilterBar f={f} />
      <IssueResults q={q} view={view} />
    </div>
  );
}

export function ViewToggle({ view, setView }: { view: 'kanban' | 'list'; setView: (v: 'kanban' | 'list') => void }) {
  return <Segmented value={view} onChange={setView} options={[{ value: 'kanban', label: <><KanbanSquare size={14} />Kanban</> }, { value: 'list', label: <><List size={14} />Lista</> }]} />;
}

export function IssueResults({ q, view, showArea = true }: { q: ReturnType<typeof useIssues>; view: 'kanban' | 'list'; showArea?: boolean }) {
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className={q.isFetching ? 'opacity-70 transition-opacity' : ''}>
      {view === 'kanban' ? <Kanban items={q.data.items} showArea={showArea} /> : <IssueTable items={q.data.items} showArea={showArea} />}
      {q.data.total > q.data.items.length && <p className="mt-2 text-xs text-gray-500">Mostrando {q.data.items.length} de {q.data.total}. Refine os filtros para ver as demais.</p>}
    </div>
  );
}
