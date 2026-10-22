import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, ListChecks, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PRIORITIES, PRIORITY_LABELS, type Priority, type Status } from '@shared/constants';
import { can } from '@shared/permissions';
import { ORIGIN_LABELS, STEP_LABELS, type QualityOrigin, type StepKey } from '@shared/quality';
import { errorMessage, get, post } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useMeta } from '../../lib/meta';
import { dmy } from '../../lib/quality';
import { useMe } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { useOpenIssue } from '../issues';
import { Button, Card, cx, Empty, ErrorBox, Input, Select, Spinner, StatusBadge } from '../ui';
import { OriginTag } from './parts';

export interface Suggestion {
  ncId: number; number: string; origin: QualityOrigin; partner: string | null; product: string | null; problem: string | null; safety: boolean;
  step: StepKey; stepLabel: string; plan: string; daysLate: number; leader: string | null;
  areaId: number; assigneeId: string | null; title: string; description: string; priority: Priority;
}
interface Decided {
  id: number; step: StepKey; decision: 'criada' | 'descartada'; decided_at: string; note: string | null; nc_id: number; number: string; origin: QualityOrigin;
  partner: string | null; decided_by_name: string; issue_id: string | null; issue_code: string | null; issue_status: Status | null; area_name: string | null; assignee_name: string | null;
}
type Edit = { areaId: number; assigneeId: string | null; title: string; priority: Priority };
const key = (s: { ncId: number; step: string }) => `${s.ncId}|${s.step}`;

export const useSuggestions = (horizon: number) =>
  useQuery({ queryKey: ['quality', 'suggestions', horizon], queryFn: () => get<{ pending: Suggestion[]; decided: Decided[] }>(`/api/quality/suggestions?horizon=${horizon}`) });

export function SuggestionsTab({ horizon, setHorizon, onOpenNc }: { horizon: number; setHorizon: (h: number) => void; onOpenNc: (id: number) => void }) {
  const me = useMe();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const openIssue = useOpenIssue();
  const q = useSuggestions(horizon);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const pending = q.data?.pending ?? [];
  useEffect(() => {
    setEdits((cur) => {
      const next: Record<string, Edit> = {};
      for (const s of pending) next[key(s)] = cur[key(s)] ?? { areaId: s.areaId, assigneeId: s.assigneeId, title: s.title, priority: s.priority };
      return next;
    });
    setSelected((cur) => new Set([...cur].filter((k) => pending.some((s) => key(s) === k))));
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const usersByArea = useMemo(() => {
    const m = new Map<number, { id: string; name: string }[]>();
    for (const u of meta?.users ?? []) if (u.active && u.area_id) m.set(u.area_id, [...(m.get(u.area_id) ?? []), u]);
    return m;
  }, [meta]);
  const canAssignIn = (areaId: number) => can.assign(me, { areaId, originAreaId: areaId, assigneeId: null, openedById: me.id });

  const run = async (kind: 'approve' | 'dismiss', keys: string[]) => {
    const list = pending.filter((s) => keys.includes(key(s)));
    if (!list.length) return;
    let note: string | null = null;
    if (kind === 'dismiss') {
      note = prompt(`Descartar ${list.length} sugestão(ões)? Motivo (opcional):`, '');
      if (note === null) return;
    }
    setBusy(true);
    try {
      if (kind === 'approve') {
        const r = await post<{ created: { code: string; assigned: boolean }[] }>('/api/quality/suggestions/approve', {
          items: list.map((s) => {
            const e = edits[key(s)];
            return { ncId: s.ncId, step: s.step, areaId: e.areaId, assigneeId: canAssignIn(e.areaId) ? e.assigneeId : null, title: e.title, priority: e.priority, description: s.description };
          }),
        });
        const waiting = r.created.filter((c) => !c.assigned).length;
        toast('ok', `${r.created.length} pendência(s) criada(s): ${r.created.map((c) => c.code).join(', ')}.${waiting ? ` ${waiting} aguardam o líder da área definir o responsável.` : ''}`);
      } else {
        await post('/api/quality/suggestions/dismiss', { items: list.map((s) => ({ ncId: s.ncId, step: s.step })), note: note || null });
        toast('ok', `${list.length} sugestão(ões) descartada(s).`);
      }
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ['quality'] });
      if (kind === 'approve') qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'quality' && x.queryKey[0] !== 'me' && x.queryKey[0] !== 'meta' });
    } catch (e) {
      toast('error', errorMessage(e));
      q.refetch();
    } finally {
      setBusy(false);
    }
  };

  const allKeys = pending.map(key);
  const allOn = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  return (
    <div className="space-y-4">
      <Card title={<span className="inline-flex items-center gap-2"><ListChecks size={16} />Ações sugeridas aguardando aprovação</span>}
        actions={(
          <label className="flex items-center gap-2 text-xs text-gray-600">Etapas vencidas e que vencem em até
            <Select className="w-auto py-1" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {[7, 15, 30].map((h) => <option key={h} value={h}>{h} dias</option>)}
            </Select>
          </label>
        )}>
        <p className="mb-3 text-sm text-gray-600">
          O sistema sugere só a <b>próxima etapa</b> de cada ocorrência em aberto. Nada vira pendência sem aprovação: confira a área e o
          responsável e clique em <b>Criar pendência</b>. Quando a etapa for registrada como realizada, a etapa seguinte aparece aqui.
        </p>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
        {q.data && (pending.length === 0 ? <Empty>Nenhuma ação aguardando aprovação.</Empty> : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label className="mr-auto inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(allKeys))} />Selecionar todas ({pending.length})</label>
              <Button size="sm" disabled={!selected.size || busy} onClick={() => run('dismiss', [...selected])}><X size={14} />Descartar selecionadas</Button>
              <Button size="sm" kind="primary" disabled={!selected.size} loading={busy} onClick={() => run('approve', [...selected])}><CheckCheck size={14} />Criar {selected.size || ''} pendência(s)</Button>
            </div>
            <ul className="space-y-2">
              {pending.map((s) => {
                const k = key(s);
                const e = edits[k];
                if (!e) return null;
                const assignable = canAssignIn(e.areaId);
                const set = (p: Partial<Edit>) => setEdits((x) => ({ ...x, [k]: { ...x[k], ...p } }));
                return (
                  <li key={k} className={cx('rounded-xl border p-3', selected.has(k) ? 'border-brand-400 bg-brand-50/40' : 'border-gray-200')}>
                    <div className="flex flex-wrap items-start gap-3">
                      <input type="checkbox" className="mt-1" aria-label={`Selecionar ${s.number} ${s.stepLabel}`} checked={selected.has(k)}
                        onChange={() => setSelected((x) => { const n = new Set(x); n.has(k) ? n.delete(k) : n.add(k); return n; })} />
                      <span className={cx('w-16 shrink-0 rounded-md px-1.5 py-1 text-center text-xs font-bold tabular', s.daysLate > 0 ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-900')}>
                        {s.daysLate > 0 ? `+${s.daysLate} d` : s.daysLate === 0 ? 'hoje' : `${-s.daysLate} d`}
                      </span>
                      <div className="min-w-0 flex-1">
                        <button className="font-medium hover:underline" onClick={() => onOpenNc(s.ncId)}>{s.number}</button>
                        <span className="text-gray-600"> · {s.stepLabel} · prazo {dmy(s.plan)}</span>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500"><OriginTag origin={s.origin} short />{s.partner ?? '—'} · {s.problem ?? '—'} · líder na planilha: {s.leader ?? '—'}</div>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,2fr)_1fr_1fr_8rem]">
                      <Input aria-label="Título da pendência" value={e.title} maxLength={200} onChange={(ev) => set({ title: ev.target.value })} />
                      <Select aria-label="Área" value={e.areaId} onChange={(ev) => set({ areaId: Number(ev.target.value), assigneeId: null })}>
                        {meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </Select>
                      <Select aria-label="Responsável" value={assignable ? e.assigneeId ?? '' : ''} disabled={!assignable} onChange={(ev) => set({ assigneeId: ev.target.value || null })}
                        title={assignable ? undefined : 'Você não atribui pessoas nesta área: o líder da área define o responsável.'}>
                        <option value="">{assignable ? 'Sem responsável (líder define)' : 'Líder da área define'}</option>
                        {(usersByArea.get(e.areaId) ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </Select>
                      <Select aria-label="Prioridade" value={e.priority} onChange={(ev) => set({ priority: ev.target.value as Priority })}>
                        {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
                      </Select>
                    </div>
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      <Button size="sm" kind="ghost" disabled={busy} onClick={() => run('dismiss', [k])}>Descartar</Button>
                      <Button size="sm" kind="success" disabled={busy || !e.title.trim()} onClick={() => run('approve', [k])}>Criar pendência em {meta?.areas.find((a) => a.id === e.areaId)?.name}</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ))}
      </Card>

      <Card title="Decisões recentes">
        {!q.data?.decided.length ? <Empty>Nenhuma decisão ainda.</Empty> : (
          <ul className="divide-y text-sm">
            {q.data.decided.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="text-xs text-gray-500 tabular">{fmtDateTime(d.decided_at)}</span>
                <button className="font-medium hover:underline" onClick={() => onOpenNc(d.nc_id)}>{d.number}</button>
                <span className="text-gray-600">{ORIGIN_LABELS[d.origin].replace('NC ', '')} · {d.partner ?? '—'} · {STEP_LABELS[d.step]}</span>
                {d.decision === 'criada' && d.issue_id ? (
                  <span className="inline-flex items-center gap-2">→ <button className="font-mono text-xs text-brand-700 hover:underline" onClick={() => openIssue(d.issue_id!)}>{d.issue_code}</button>
                    {d.issue_status && <StatusBadge status={d.issue_status} />}<span className="text-xs text-gray-500">{d.area_name}{d.assignee_name ? ` · ${d.assignee_name}` : ''}</span></span>
                ) : <span className="text-xs text-gray-500">descartada{d.note ? `: ${d.note}` : ''}</span>}
                <span className="ml-auto text-xs text-gray-400">por {d.decided_by_name}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
