import { Filter, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS } from '@shared/constants';
import { useMeta } from '../lib/meta';
import { Button, cx, Input, Select } from './ui';

export const FLAG_LABELS: Record<string, string> = {
  open: 'Em aberto', overdue: 'Atrasadas', due_today: 'Vencem hoje', unassigned: 'Sem responsável', blocked: 'Bloqueadas',
  awaiting_validation: 'Aguardando validação', safety: 'Críticas / segurança', recurrent: 'Reincidentes', completed: 'Concluídas', closed: 'Encerradas',
};

const KEYS = ['q', 'flag', 'areaId', 'assigneeId', 'priority', 'status', 'categoryId', 'openedFrom', 'openedTo', 'dueFrom', 'dueTo', 'source'];

/** Reads list filters from the URL so every filtered view is linkable. */
export function useFilters(defaults: Record<string, string> = {}) {
  const [params, setParams] = useSearchParams();
  const values: Record<string, string> = { ...defaults };
  for (const k of KEYS) {
    const v = params.get(k);
    if (v !== null) values[k] = v;
  }
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };
  const clear = () => {
    const next = new URLSearchParams();
    if (params.get('p')) next.set('p', params.get('p')!);
    setParams(next, { replace: true });
  };
  return { values, set, clear };
}

export function FilterBar({ f, hideArea, flags = ['open', 'overdue', 'due_today', 'blocked', 'unassigned', 'awaiting_validation', 'safety', 'completed'] }: { f: ReturnType<typeof useFilters>; hideArea?: boolean; flags?: string[] }) {
  const meta = useMeta();
  const [more, setMore] = useState(false);
  const v = f.values;
  const active = KEYS.filter((k) => v[k] && k !== 'flag').length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtros rápidos">
        {flags.map((fl) => (
          <button key={fl} onClick={() => f.set({ flag: v.flag === fl ? 'all' : fl })}
            className={cx('rounded-full border px-3 py-1 text-sm', v.flag === fl ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')}>
            {FLAG_LABELS[fl]}
          </button>
        ))}
        <button onClick={() => f.set({ flag: 'all' })} className={cx('rounded-full border px-3 py-1 text-sm', v.flag === 'all' ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-300 bg-white text-gray-700')}>Todas</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Pesquisar…" value={v.q ?? ''} onChange={(e) => f.set({ q: e.target.value })} aria-label="Pesquisar" />
        {!hideArea && (
          <Select className="w-auto" value={v.areaId ?? ''} onChange={(e) => f.set({ areaId: e.target.value })} aria-label="Área">
            <option value="">Todas as áreas</option>
            {meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        )}
        <Select className="w-auto" value={v.priority ?? ''} onChange={(e) => f.set({ priority: e.target.value })} aria-label="Prioridade">
          <option value="">Todas as prioridades</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
        </Select>
        <Button size="sm" kind="ghost" onClick={() => setMore((m) => !m)}><Filter size={14} />Mais filtros{active ? ` (${active})` : ''}</Button>
        {(active > 0 || (v.flag && v.flag !== 'open')) && <Button size="sm" kind="ghost" onClick={f.clear}><X size={14} />Limpar</Button>}
      </div>
      {more && (
        <div className="grid gap-2 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-gray-600">Responsável
            <Select value={v.assigneeId ?? ''} onChange={(e) => f.set({ assigneeId: e.target.value })}>
              <option value="">Todos</option>
              <option value="me">Eu</option>
              {meta?.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </label>
          <label className="text-xs text-gray-600">Status
            <Select value={v.status ?? ''} onChange={(e) => f.set({ status: e.target.value })}>
              <option value="">Todos</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </Select>
          </label>
          <label className="text-xs text-gray-600">Categoria
            <Select value={v.categoryId ?? ''} onChange={(e) => f.set({ categoryId: e.target.value })}>
              <option value="">Todas</option>
              {meta?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </label>
          <label className="text-xs text-gray-600">Origem
            <Select value={v.source ?? ''} onChange={(e) => f.set({ source: e.target.value })}>
              <option value="">Todas</option><option value="fast_response">Fast Response</option><option value="direto">Registro direto</option>
            </Select>
          </label>
          <label className="text-xs text-gray-600">Abertura de<Input type="date" value={v.openedFrom ?? ''} onChange={(e) => f.set({ openedFrom: e.target.value })} /></label>
          <label className="text-xs text-gray-600">Abertura até<Input type="date" value={v.openedTo ?? ''} onChange={(e) => f.set({ openedTo: e.target.value })} /></label>
          <label className="text-xs text-gray-600">Vencimento de<Input type="date" value={v.dueFrom ?? ''} onChange={(e) => f.set({ dueFrom: e.target.value })} /></label>
          <label className="text-xs text-gray-600">Vencimento até<Input type="date" value={v.dueTo ?? ''} onChange={(e) => f.set({ dueTo: e.target.value })} /></label>
        </div>
      )}
    </div>
  );
}

/** Converts URL filter values to API query params. */
export function toApi(v: Record<string, string>) {
  const out: Record<string, string> = { ...v };
  if (out.flag === 'all') delete out.flag;
  return out;
}
