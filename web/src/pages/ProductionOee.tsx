import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info } from 'lucide-react';
import { DateTime } from 'luxon';
import { useState, type ReactNode } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { LOSS_LABEL, type LossKey } from '@shared/production';
import { get, qs } from '../lib/api';
import { tz } from '../lib/format';
import { cx, Empty, ErrorBox, Input, Select, Spinner } from '../components/ui';

/**
 * OEE da produção (João, 27/11/2026): Disponibilidade (paradas registradas: manutenção, ajuste, setup), Performance
 * (ritmo) e Qualidade (refugo informado pelo líder), with where the planned time went, by machine and by shift.
 * Every number comes from /api/producao/oee; the browser only draws.
 */

interface Ind { key: string; oee: number | null; availability: number | null; performance: number | null; quality: number | null; plannedMin: number; good: number; scrap: number; entries: number; lossMin: number }
interface Loss { key: LossKey; label: string; min: number }
interface Oee {
  from: string; to: string; bucket: 'hora' | 'dia'; shifts: string[];
  setup: { ok: boolean; error: string | null } | null;
  totals: Ind & { stopMin: number; noStandard: number; pendingReason: number; aboveStandard: number };
  losses: Loss[];
  series: Ind[];
  byMachine: (Ind & { losses: Loss[] })[];
  byShift: (Ind & { losses: Loss[] })[];
  byPn: Ind[];
  scrapByReason: { reason: string; pieces: number }[];
  rhythmByReason: { reason: string; min: number }[];
}

// one fixed color per kind of time, in this order everywhere (never by rank)
const C_GOOD = '#0f9d8a';
const LOSS_COLOR: Record<LossKey, string> = {
  manutencao: '#2a78d6', ajuste: '#ea6a1f', setup: '#7c5cd6', refugo: '#d6458b', ritmo: '#c99a1a', pendente: '#c4c9d1',
};
const IND = [
  { k: 'oee', label: 'OEE', color: '#1f2937', width: 3 },
  { k: 'availability', label: 'Disponibilidade', color: '#2a78d6', width: 2 },
  { k: 'performance', label: 'Performance', color: '#c99a1a', width: 2 },
  { k: 'quality', label: 'Qualidade', color: '#d6458b', width: 2 },
] as const;

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const n0 = (n: number) => Math.round(n).toLocaleString('pt-BR');
const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}` : `${Math.round(m)} min`);

type Period = 'hoje' | 'ontem' | '7d' | '30d' | 'mes' | 'custom';
function rangeOf(p: Period, c: { from: string; to: string }) {
  const t = DateTime.now().setZone(tz()).startOf('day');
  const d = (x: DateTime) => x.toISODate()!;
  if (p === 'hoje') return { from: d(t), to: d(t) };
  if (p === 'ontem') return { from: d(t.minus({ days: 1 })), to: d(t.minus({ days: 1 })) };
  if (p === '7d') return { from: d(t.minus({ days: 6 })), to: d(t) };
  if (p === '30d') return { from: d(t.minus({ days: 29 })), to: d(t) };
  if (p === 'mes') return { from: d(t.startOf('month')), to: d(t) };
  return c;
}

export function OeeDashboard({ machines }: { machines: string[] }) {
  const [period, setPeriod] = useState<Period>('hoje');
  const [custom, setCustom] = useState(() => { const t = DateTime.now().setZone(tz()).toISODate()!; return { from: t, to: t }; });
  const [shift, setShift] = useState('');
  const [machine, setMachine] = useState('');
  const range = rangeOf(period, custom);
  const r = useQuery<Oee>({
    queryKey: ['producao', 'oee', range, shift, machine],
    queryFn: () => get(`/api/producao/oee${qs({ ...range, shift: shift || undefined, machine: machine || undefined })}`),
    placeholderData: keepPreviousData,
  });
  const d = r.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl bg-white p-3 ring-1 ring-gray-100">
        <Pick label="Período" value={period} onChange={(v) => setPeriod(v as Period)} options={[['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', 'Últimos 7 dias'], ['30d', 'Últimos 30 dias'], ['mes', 'Mês atual'], ['custom', 'Personalizado']]} />
        {period === 'custom' && (
          <>
            <label className="text-xs text-gray-500">De<Input type="date" value={custom.from} onChange={(x) => setCustom({ ...custom, from: x.target.value })} /></label>
            <label className="text-xs text-gray-500">Até<Input type="date" value={custom.to} onChange={(x) => setCustom({ ...custom, to: x.target.value })} /></label>
          </>
        )}
        <Pick label="Turno" value={shift} onChange={setShift} options={[['', 'Todos'], ...(d?.shifts ?? []).map((s) => [s, s] as [string, string])]} />
        <Pick label="Máquina" value={machine} onChange={setMachine} options={[['', 'Todas'], ...machines.map((m) => [m, m] as [string, string])]} />
        {(shift || machine) && <button onClick={() => { setShift(''); setMachine(''); }} className="mb-2 text-xs font-medium text-brand-700 hover:underline">Limpar filtros</button>}
      </div>

      {r.isLoading ? <Spinner /> : r.error ? <ErrorBox error={r.error} onRetry={() => r.refetch()} /> : !d ? null : d.totals.entries === 0 ? (
        <Empty>Nenhum apontamento com ciclo padrão neste filtro.</Empty>
      ) : (
        <>
          {(d.totals.pendingReason > 0 || d.totals.noStandard > 0 || d.totals.aboveStandard > 0 || d.setup?.ok === false) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-xl bg-amber-50 px-4 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
              {d.totals.pendingReason > 0 && <span className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" />{d.totals.pendingReason} apontamentos ainda sem motivo: a perda deles está em "Sem motivo informado".</span>}
              {d.totals.aboveStandard > 0 && <span>{d.totals.aboveStandard} apontamentos acima do ciclo padrão (contados até 100%): confira o ciclo ou a quantidade.</span>}
              {d.totals.noStandard > 0 && <span>{d.totals.noStandard} apontamentos sem ciclo padrão ficaram fora do OEE.</span>}
              {d.setup?.ok === false && <span>Controle de Setup fora do ar: as paradas de setup podem estar faltando.</span>}
            </div>
          )}

          <Kpis d={d} />

          <div className="grid gap-4 lg:grid-cols-5">
            <Panel title="Para onde foi o tempo planejado" sub={`${hm(d.totals.plannedMin)} planejados (sem refeição)`} className="lg:col-span-2">
              <TimeSplit planned={d.totals.plannedMin} good={d.totals.plannedMin - d.totals.lossMin} losses={d.losses} />
            </Panel>
            <Panel title={d.bucket === 'hora' ? 'OEE hora a hora' : 'OEE dia a dia'} sub="Disponibilidade × Performance × Qualidade" className="lg:col-span-3">
              <Trend d={d} />
            </Panel>
          </div>

          <Panel title="Por máquina" sub="OEE e o que tirou tempo de cada máquina. Toque para filtrar.">
            <Stacks rows={d.byMachine} onPick={machine ? undefined : setMachine} label={(k) => `Máq. ${k}`} />
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Por turno"><Stacks rows={d.byShift} onPick={shift ? undefined : setShift} label={(k) => k} /></Panel>
            <Panel title="Refugo por defeito" sub={`${n0(d.totals.scrap)} peças refugadas no período`}>
              <Bars color={LOSS_COLOR.refugo} rows={d.scrapByReason.map((x) => ({ key: x.reason, v: x.pieces, text: `${n0(x.pieces)} pç` }))} empty="Nenhum refugo informado." />
            </Panel>
            <Panel title="Peças não produzidas, por motivo" sub="Perda de ritmo explicada pelo líder">
              <Bars color={LOSS_COLOR.ritmo} rows={d.rhythmByReason.map((x) => ({ key: x.reason, v: x.min, text: hm(x.min) }))} empty="Nenhum motivo de ritmo informado." />
            </Panel>
            <Panel title="PNs que mais perderam tempo" sub="Tempo planejado que não virou peça boa">
              <Bars color="#64748b" rows={d.byPn.filter((x) => x.lossMin > 0).map((x) => ({ key: x.key, v: x.lossMin, text: hm(x.lossMin), note: `OEE ${pct(x.oee)}` }))} empty="Sem perdas." />
            </Panel>
          </div>

          <p className="flex items-start gap-1.5 px-1 text-xs text-gray-500"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Disponibilidade = tempo planejado menos as paradas registradas (OS e OA com máquina parada, setups), sobre o planejado. Performance = peças feitas (boas + refugo) no ciclo padrão, sobre o tempo rodando. Qualidade = peças boas sobre peças feitas. Peças que faltaram sem parada registrada entram como refugo ou ritmo conforme o líder informou.
          </p>
        </>
      )}
    </div>
  );
}

function Pick({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="text-xs text-gray-500">{label}
      <Select value={value} onChange={(x) => onChange(x.target.value)} className="min-w-[9rem]">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
    </label>
  );
}

function Panel({ title, sub, children, className }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx('min-w-0 rounded-2xl bg-white p-4 ring-1 ring-gray-100 sm:p-5', className)}>
      <header className="mb-3"><h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>{sub && <p className="text-xs text-gray-500">{sub}</p>}</header>
      {children}
    </section>
  );
}

function Kpis({ d }: { d: Oee }) {
  const t = d.totals;
  const items: { label: string; v: string; hint: string; big?: boolean }[] = [
    { label: 'OEE', v: pct(t.oee), hint: `${n0(t.good)} peças boas`, big: true },
    { label: 'Disponibilidade', v: pct(t.availability), hint: `${hm(t.stopMin)} de paradas` },
    { label: 'Performance', v: pct(t.performance), hint: 'ritmo no ciclo padrão' },
    { label: 'Qualidade', v: pct(t.quality), hint: `${n0(t.scrap)} peças refugadas` },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className={cx('rounded-2xl p-4 ring-1', i.big ? 'bg-gray-900 text-white ring-gray-900' : 'bg-white ring-gray-100')}>
          <div className={cx('text-sm', i.big ? 'text-gray-300' : 'text-gray-500')}>{i.label}</div>
          <div className="text-3xl font-bold tabular">{i.v}</div>
          <div className={cx('text-xs', i.big ? 'text-gray-400' : 'text-gray-500')}>{i.hint}</div>
        </div>
      ))}
    </div>
  );
}

/** one bar of the whole planned time: good production, then each loss, with the list under it */
function TimeSplit({ planned, good, losses }: { planned: number; good: number; losses: Loss[] }) {
  const parts = [{ key: 'boa', label: 'Produção boa', min: Math.max(0, good), color: C_GOOD }, ...losses.map((l) => ({ ...l, color: LOSS_COLOR[l.key] }))];
  return (
    <div>
      <div className="flex h-7 gap-0.5 overflow-hidden rounded-md">
        {parts.filter((p) => p.min > 0.4).map((p) => (
          <div key={p.key} title={`${p.label}: ${hm(p.min)}`} style={{ width: `${(p.min / planned) * 100}%`, background: p.color }} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-sm">
        {parts.map((p) => (
          <li key={p.key} className={cx('flex items-center gap-2', p.min <= 0.4 && 'text-gray-400')}>
            <i className="h-3 w-3 shrink-0 rounded-sm" style={{ background: p.color }} />
            <span className="flex-1">{p.label}</span>
            <span className="tabular font-semibold">{hm(p.min)}</span>
            <span className="w-12 text-right tabular text-xs text-gray-500">{pct(p.min / planned)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Trend({ d }: { d: Oee }) {
  const data = d.series.map((s) => ({
    label: d.bucket === 'hora' ? s.key : DateTime.fromISO(s.key).toFormat('dd/MM'),
    oee: s.oee == null ? null : s.oee * 100, availability: s.availability == null ? null : s.availability * 100,
    performance: s.performance == null ? null : s.performance * 100, quality: s.quality == null ? null : s.quality * 100, n: s.entries,
  }));
  const shown = d.bucket === 'hora' ? data.filter((x, i) => x.n > 0 || data.slice(0, i).some((y) => y.n > 0) && data.slice(i).some((y) => y.n > 0)) : data;
  return (
    <div className="h-[260px]">
      <ResponsiveContainer>
        <LineChart data={shown} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#f1f2f4" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} interval="preserveStartEnd" minTickGap={12} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
          <ReferenceLine y={(d.totals.oee ?? 0) * 100} stroke="#9ca3af" strokeDasharray="4 4" />
          <Tooltip cursor={{ stroke: '#9ca3af', strokeDasharray: '3 3' }} content={({ payload, label }) => {
            const p: any = payload?.[0]?.payload; if (!p) return null;
            if (!p.n) return <div className="rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg"><b>{label}</b><div className="text-gray-400">sem apontamento</div></div>;
            return (
              <div className="rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg"><b>{label}</b>
                {IND.map((i) => <div key={i.k} className="flex justify-between gap-4"><span>{i.label}</span><b className="tabular">{p[i.k] == null ? '—' : `${p[i.k].toFixed(1)}%`}</b></div>)}
                <div className="text-gray-400">{p.n} apontamentos</div>
              </div>
            );
          }} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
          {IND.map((i) => (
            <Line key={i.k} name={i.label} dataKey={i.k} stroke={i.color} strokeWidth={i.width} connectNulls={false}
              dot={shown.length <= 31 ? { r: i.k === 'oee' ? 3 : 2, fill: i.color, strokeWidth: 0 } : false} activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** a 100% bar per machine (or shift): good production and each loss, OEE on the right */
function Stacks({ rows, onPick, label }: { rows: (Ind & { losses: Loss[] })[]; onPick?: (k: string) => void; label: (k: string) => string }) {
  if (!rows.length) return <Empty>Sem registros.</Empty>;
  return (
    <div>
      <ul className="space-y-1">
        {rows.map((r) => {
          const good = r.plannedMin - r.lossMin;
          const parts = [{ key: 'boa', label: 'Produção boa', min: good, color: C_GOOD }, ...r.losses.map((l) => ({ ...l, color: LOSS_COLOR[l.key] }))].filter((p) => p.min > 0.4);
          return (
            <li key={r.key}>
              <button type="button" disabled={!onPick} onClick={() => onPick?.(r.key)}
                title={`${label(r.key)} · OEE ${pct(r.oee)} · D ${pct(r.availability)} · P ${pct(r.performance)} · Q ${pct(r.quality)}\n` + parts.map((p) => `${p.label}: ${hm(p.min)}`).join('\n')}
                className="grid w-full grid-cols-[5.5rem_1fr_3.5rem] items-center gap-3 rounded-md px-1.5 py-1 text-left text-sm hover:bg-gray-50 disabled:hover:bg-transparent sm:grid-cols-[7rem_1fr_4rem]">
                <span className="truncate text-gray-700">{label(r.key)}</span>
                <span className="flex h-5 gap-0.5 overflow-hidden rounded">
                  {parts.map((p) => <span key={p.key} style={{ width: `${(p.min / r.plannedMin) * 100}%`, background: p.color }} />)}
                </span>
                <span className="text-right font-semibold tabular text-gray-900">{pct(r.oee)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 px-1.5 text-xs text-gray-500">
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: C_GOOD }} />Produção boa</span>
        {(Object.keys(LOSS_COLOR) as LossKey[]).map((k) => <span key={k} className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: LOSS_COLOR[k] }} />{LOSS_LABEL[k]}</span>)}
      </div>
    </div>
  );
}

function Bars({ rows, color, empty }: { rows: { key: string; v: number; text: string; note?: string }[]; color: string; empty: string }) {
  if (!rows.length) return <p className="text-sm text-gray-500">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.v), 0.0001);
  return (
    <ul className="space-y-1">
      {rows.slice(0, 8).map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 px-1.5 py-1 text-sm">
          <span className="truncate text-gray-700" title={r.key}>{r.key}</span>
          <span className="relative h-5 rounded bg-gray-50"><span className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.max(2, (r.v / max) * 100)}%`, background: color }} /></span>
          <span className="whitespace-nowrap text-right font-semibold tabular text-gray-900">{r.text}{r.note && <span className="ml-1.5 text-xs font-normal text-gray-500">{r.note}</span>}</span>
        </li>
      ))}
    </ul>
  );
}
