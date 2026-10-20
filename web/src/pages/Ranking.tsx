import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, ChevronDown, ChevronUp, Info, Lock, Trophy } from 'lucide-react';
import { Fragment, useState } from 'react';
import { AreaDot, Button, Card, ErrorBox, Input, Spinner } from '../components/ui';
import { errorMessage, get, post } from '../lib/api';
import { fmtDateTime, hours, num } from '../lib/format';
import { can, useMe } from '../lib/session';
import { useToast } from '../lib/toast';

const monthLabel = (m: string) => {
  const [y, mm] = m.split('-').map(Number);
  return new Date(y, mm - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};

export function RankingPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [month, setMonth] = useState('');
  const q = useQuery({ queryKey: ['ranking', month], queryFn: () => get(`/api/ranking${month ? `?month=${month}` : ''}`) });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  const c = r.criteria;
  const current = new Date().toISOString().slice(0, 7);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Ranking e reconhecimento — <span className="capitalize">{monthLabel(r.month)}</span></h1>
          <p className="text-sm text-gray-500">{r.finalized ? 'Mês fechado: pontuação congelada.' : `Parcial, recalculada em ${fmtDateTime(r.computedAt)}.`}</p>
        </div>
        <div className="flex items-center gap-2">
          <Input type="month" value={month || r.month} max={current} onChange={(e) => setMonth(e.target.value)} aria-label="Mês" className="w-44" />
          {can.recomputeRanking(me) && !r.finalized && r.month < current && (
            <Button onClick={async () => {
              if (!confirm(`Fechar o ranking de ${monthLabel(r.month)}? A pontuação ficará congelada.`)) return;
              try { await post(`/api/ranking/${r.month}/finalize`); toast('ok', 'Mês fechado'); } catch (e) { toast('error', errorMessage(e)); }
              qc.invalidateQueries({ queryKey: ['ranking'] });
            }}><Lock size={14} />Fechar mês</Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-amber-300 bg-gradient-to-br from-amber-50 to-white p-5 lg:col-span-1">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-amber-800"><Trophy size={18} />Campeão do mês</div>
          {r.champion ? (
            <>
              <div className="mt-2 text-2xl font-bold">{r.champion.name}</div>
              <div className="text-sm text-gray-600">{r.champion.area_name}</div>
              <div className="mt-3 text-3xl font-bold tabular text-amber-700">{num(r.champion.points)} pts</div>
              <div className="text-sm text-gray-600">{r.champion.validated_count} pendências validadas · {r.champion.on_time_pct ?? '—'}% no prazo</div>
            </>
          ) : <p className="mt-2 text-sm text-gray-600">Ainda não há colaborador elegível (mínimo de {c.minIssuesForChampion} pendências validadas no mês).</p>}
        </div>
        <Card title={<span className="flex items-center gap-2"><Info size={16} />Como a pontuação é calculada</span>} className="lg:col-span-2">
          <ul className="grid gap-x-6 gap-y-1 text-sm text-gray-700 sm:grid-cols-2">
            <li>• Conta apenas pendências <strong>concluídas e validadas</strong> no mês.</li>
            <li>• Canceladas e aguardando validação <strong>não contam</strong>.</li>
            <li>• Pontos base por complexidade: simples <strong>{c.base.simples}</strong>, moderada <strong>{c.base.moderada}</strong>, complexa <strong>{c.base.complexa}</strong>.</li>
            <li>• Complexidade objetiva: nº de etapas obrigatórias, ou classificação aprovada por líder/gestor.</li>
            <li>• Dentro do prazo: <strong>+{c.onTimeBonusPct}%</strong>. Após o prazo: <strong>−{c.latePenaltyPct}%</strong>.</li>
            <li>• Reabertura por solução ineficaz: <strong>−{c.reopenPenalty}</strong> cada.</li>
            <li>• Problema reincidente: <strong>−{c.recurrencePenalty}</strong>.</li>
            <li>• Colaboração: <strong>+{c.stepPoints}</strong> por etapa concluída em pendência de outro responsável.</li>
            <li>• Simples aberta e encerrada pela mesma pessoa em menos de {c.quickSelfCloseMinutes} min: 0 pontos.</li>
            <li>• Máximo de {c.maxSimplePerMonth} pendências simples pontuadas por pessoa no mês.</li>
          </ul>
          <p className="mt-2 text-xs text-gray-500">Prazo considerado é o vigente após alterações aprovadas; o prazo original permanece no histórico. Critérios configuráveis pelo administrador.</p>
        </Card>
      </div>

      <Card title="Colaboradores">
        {r.users.length === 0 ? <p className="text-sm text-gray-500">Nenhuma pontuação no mês.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-2">#</th><th>Colaborador</th><th className="text-right">Validadas</th><th className="text-right">No prazo</th><th className="text-right">Reaberturas</th><th className="text-right">Etapas</th><th className="text-right">Pontos</th><th /></tr></thead>
              <tbody className="divide-y">
                {r.users.map((u: any, idx: number) => (
                  <Fragment key={u.user_id}>
                    <tr className={u.user_id === me.id ? 'bg-brand-50' : ''}>
                      <td className="py-2 font-bold text-gray-400">{idx === 0 && r.champion?.user_id === u.user_id ? <Award size={16} className="text-amber-600" /> : `${idx + 1}º`}</td>
                      <td><div className="font-medium">{u.name}</div><div className="text-xs text-gray-500">{u.area_name}</div></td>
                      <td className="text-right tabular">{u.validated_count}</td>
                      <td className="text-right tabular">{u.on_time_pct == null ? '—' : `${num(u.on_time_pct)}%`}</td>
                      <td className="text-right tabular">{u.reopen_count}</td>
                      <td className="text-right tabular">{u.steps_count}</td>
                      <td className="text-right font-bold tabular">{num(u.points)}</td>
                      <td className="text-right"><button aria-label="Detalhar pontuação" className="rounded p-1 hover:bg-gray-100" onClick={() => setOpen(open === u.user_id ? null : u.user_id)}>{open === u.user_id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button></td>
                    </tr>
                    {open === u.user_id && (
                      <tr><td colSpan={8} className="bg-gray-50 px-3 py-2">
                        <ul className="space-y-1 text-xs">
                          {u.breakdown.issues.map((b: any) => (
                            <li key={b.issueId}><span className="font-mono">{b.code}</span> {b.title}: base {b.base}{b.adjustments.map((a: any) => ` ${a.points >= 0 ? '+' : ''}${a.points} (${a.reason})`).join('')} = <strong>{b.points}</strong></li>
                          ))}
                          {u.breakdown.steps.map((s: any, k: number) => <li key={k}>Etapa "{s.title}" em <span className="font-mono">{s.code}</span>: +{s.points}</li>)}
                        </ul>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Áreas">
          <p className="mb-2 text-xs text-gray-500">Reconhecimento coletivo: a evolução de cada área conta mais que a comparação direta.</p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Área</th><th className="text-right">Validadas</th><th className="text-right">No prazo</th><th className="text-right">Tempo médio</th><th className="text-right">Pontos</th></tr></thead>
            <tbody className="divide-y">
              {r.areas.map((a: any) => (
                <tr key={a.area_id}><td className="py-1.5"><span className="inline-flex items-center gap-2"><AreaDot color={a.color} />{a.name}</span></td>
                  <td className="text-right tabular">{a.validated_count}</td><td className="text-right tabular">{a.on_time_pct == null ? '—' : `${num(a.on_time_pct)}%`}</td>
                  <td className="text-right tabular">{hours(a.avg_resolution_hours)}</td><td className="text-right font-semibold tabular">{num(a.points)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Histórico mensal">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Mês</th><th>Campeão</th><th className="text-right">Validadas</th><th className="text-right">No prazo</th></tr></thead>
            <tbody className="divide-y">
              {[...r.history].reverse().map((h: any) => (
                <tr key={h.month} className="cursor-pointer hover:bg-gray-50" onClick={() => setMonth(h.month)}>
                  <td className="py-1.5 capitalize">{monthLabel(h.month)} {h.finalized && <Lock size={11} className="inline text-gray-400" />}</td>
                  <td>{h.champion ? `${h.champion.name} (${num(h.champion.points)})` : '—'}</td>
                  <td className="text-right tabular">{h.validated}</td>
                  <td className="text-right tabular">{h.on_time_pct == null ? '—' : `${num(h.on_time_pct)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
