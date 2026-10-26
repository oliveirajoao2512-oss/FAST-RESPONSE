import { useQuery } from '@tanstack/react-query';
import { SlidersHorizontal, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { WO_DOMAIN, WO_LOCATION_LABELS, type WoDomain, type WoLocation } from '@shared/maintenance';
import { get, qs } from '../lib/api';
import { num } from '../lib/format';
import { cx, ErrorBox, Spinner } from '../components/ui';

// Plant indicators in the same visual language as the plant's Power BI reports:
// light gray canvas, white cards, navy + orange series, values written on the marks.
const NAVY = '#1f2a37';
const ORANGE = '#ea6a1f';
const PEACH = '#f2b48a';
const SLATE = '#8a96a3';
const STEEL = '#4b5d73';
const SAND = '#d9c3a5';
const PIE_COLORS = [ORANGE, NAVY, PEACH, STEEL, SAND, SLATE];

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const hfmt = (v: number | null | undefined) => (v == null ? '—' : v < 1 ? `${Math.round(v * 60)} min` : `${num(v, v < 10 ? 1 : 0)} h`);
const pct = (v: number | null | undefined) => (v == null ? '—' : `${num(v * 100, 1)}%`);

interface Tally { key: string; label: string; n: number; downtimeH: number }
interface Panel {
  domain: WoDomain; year: number; month: number | null; years: number[];
  places: Partial<Record<WoLocation, { code: string }[]>>;
  units: number;
  period: { opened: number; finished: number; stops: number; downtimeH: number; mttrH: number | null; waitH: number | null; availability: number | null; mtbfH: number | null };
  now: { open: number; waiting: number; stopped: number; daysSinceStop: number | null };
  months: { month: number; future: boolean; opened: number; finished: number; stops: number; downtimeH: number | null; mttrH: number | null; waitH: number | null; availability: number | null }[];
  byCategory: Tally[]; byAsset: Tally[]; byLocation: Tally[]; byArea: Tally[]; byPn: Tally[];
  partNumbers: string[];
  byWorker: { name: string; hours: number; orders: number }[];
}

const WINDOWS: { value: WoDomain; label: string; short: string; icon: ReactNode }[] = [
  { value: 'manutencao', label: 'Manutenção', short: 'Manut.', icon: <Wrench size={22} /> },
  { value: 'ajuste', label: 'Processos', short: 'Proc.', icon: <SlidersHorizontal size={22} /> },
];

export function PlantPanelPage() {
  const [domain, setDomain] = useState<WoDomain>('manutencao');
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState<number | null>(null);
  const [location, setLocation] = useState<WoLocation | ''>('');
  const [asset, setAsset] = useState('');
  const [pn, setPn] = useState('');
  const params = { domain, year, month: month ?? undefined, location: location || undefined, asset: asset || undefined, pn: pn || undefined };
  const r = useQuery<Panel>({ queryKey: ['os', 'panel', params], queryFn: () => get(`/api/painel${qs(params)}`), placeholderData: (prev) => prev });
  const d = r.data;
  const switchWindow = (w: WoDomain) => {
    setDomain(w);
    setAsset('');
    setPn('');
    if (w === 'ajuste' && location === 'montagem') setLocation('');
  };
  const locations: WoLocation[] = domain === 'ajuste' ? ['maquina'] : ['maquina', 'montagem'];
  const assetOptions = (location ? [location] : locations).flatMap((l) => (d?.places[l] ?? []).map((p) => ({ l, code: p.code })));

  return (
    <div className="-m-3 flex min-h-full bg-[#e6e8eb] sm:-m-5">
      {/* windows: one per module, as the icon rail of the Power BI report */}
      <nav className="sticky top-0 flex w-14 shrink-0 flex-col items-center gap-2 bg-[#d5d8dc] py-3 sm:w-16" aria-label="Janelas do painel">
        {WINDOWS.map((w) => (
          <button key={w.value} onClick={() => switchWindow(w.value)} aria-pressed={domain === w.value} title={w.label} aria-label={w.label}
            className={cx('flex h-12 w-12 flex-col items-center justify-center rounded-md text-[9px] font-semibold uppercase', domain === w.value ? 'bg-[#ea6a1f] text-white shadow' : 'bg-[#eceef0] text-[#3b4552] hover:bg-white')}>
            {w.icon}<span className="mt-0.5">{w.short}</span>
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-end gap-2 rounded-b-xl rounded-t-md bg-[#2b3036] px-3 py-2 text-[11px] text-gray-300 shadow">
          <div className="mr-2 self-center text-sm font-bold tracking-wide text-white">{domain === 'ajuste' ? 'PROCESSOS · ORDENS DE AJUSTE' : 'MANUTENÇÃO · ORDENS DE MANUTENÇÃO'}</div>
          <Filter label="Ano">
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={selectCls}>
              {(d?.years ?? [year]).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </Filter>
          <Filter label="Mês">
            <select value={month ?? ''} onChange={(e) => setMonth(e.target.value ? Number(e.target.value) : null)} className={selectCls}>
              <option value="">Todos</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Filter>
          {locations.length > 1 && (
            <Filter label="Local">
              <select value={location} onChange={(e) => { setLocation(e.target.value as WoLocation | ''); setAsset(''); }} className={selectCls}>
                <option value="">Todos</option>
                {locations.map((l) => <option key={l} value={l}>{WO_LOCATION_LABELS[l]}</option>)}
              </select>
            </Filter>
          )}
          <Filter label={location === 'montagem' ? 'Montagem' : domain === 'ajuste' || location === 'maquina' ? 'Máquina' : 'Máquina / montagem'}>
            <select value={asset} onChange={(e) => setAsset(e.target.value)} className={cx(selectCls, 'w-44')}>
              <option value="">Todas</option>
              {assetOptions.map((a) => <option key={`${a.l}-${a.code}`} value={a.code}>{locations.length > 1 && !location ? `${WO_LOCATION_LABELS[a.l]} ${a.code}` : a.code}</option>)}
            </select>
          </Filter>
          <Filter label="Part number">
            <select value={pn} onChange={(e) => setPn(e.target.value)} className={cx(selectCls, 'w-40')}>
              <option value="">Todos</option>
              {(d?.partNumbers ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Filter>
          <button onClick={() => { setMonth(null); setLocation(''); setAsset(''); setPn(''); }} className="ml-auto rounded-full bg-[#e6e8eb] px-4 py-1.5 text-xs font-semibold text-[#2b3036] hover:bg-white">LIMPAR FILTROS</button>
        </div>

        {r.isLoading ? <Spinner /> : r.error ? <ErrorBox error={r.error} onRetry={() => r.refetch()} /> : d && (
          <Report d={d} month={month} onMonth={(m) => setMonth(m === month ? null : m)} onAsset={setAsset} onPn={setPn} />
        )}
        <p className="px-1 text-[11px] text-gray-500">
          Disponibilidade e MTBF consideram 24 h por dia e {d?.units ?? '—'} {d?.units === 1 ? 'equipamento' : 'equipamentos'} no filtro; a parada conta da abertura ao fim da ordem aberta com máquina parada.
          Clique em um mês para filtrar; clique de novo para tirar o filtro.
        </p>
      </div>
    </div>
  );
}

const selectCls = 'mt-0.5 block w-32 rounded bg-[#3a4047] px-2 py-1 text-xs text-white outline-none ring-1 ring-[#4a5058] focus:ring-[#ea6a1f]';
const Filter = ({ label, children }: { label: string; children: ReactNode }) => <label className="block">{label}{children}</label>;

function Report({ d, month, onMonth, onAsset, onPn }: { d: Panel; month: number | null; onMonth: (m: number) => void; onAsset: (a: string) => void; onPn: (p: string) => void }) {
  const D = WO_DOMAIN[d.domain];
  const adj = d.domain === 'ajuste';
  const months = d.months.filter((m) => !m.future).map((m) => ({
    ...m, label: MONTHS[m.month - 1],
    downtime: m.downtimeH == null ? null : Math.round(m.downtimeH * 10) / 10,
    mttr: m.mttrH == null ? null : Math.round(m.mttrH * 10) / 10,
    wait: m.waitH == null ? null : Math.round(m.waitH * 10) / 10,
    avail: m.availability == null ? null : Math.round(m.availability * 1000) / 10,
  }));
  const dim = (m: number) => (month && m !== month ? 0.35 : 1);
  const axis = { tick: { fontSize: 10, fill: '#4b5563' }, tickLine: false, axisLine: false } as const;
  const periodLabel = month ? MONTHS[month - 1] : `${d.year}`;
  const totalCat = d.byCategory.reduce((a, c) => a + c.n, 0);
  const top = d.byCategory.slice(0, 5);
  const rest = d.byCategory.slice(5).reduce((a, c) => a + c.n, 0);
  const pie = [...top.map((c) => ({ name: c.label, value: c.n })), ...(rest ? [{ name: 'Outros', value: rest }] : [])];

  return (
    <div className="grid gap-3 xl:grid-cols-12">
      {/* headline: days without a stop, like "dias sem acidente" */}
      <Tile section="Disponibilidade" className="xl:col-span-3">
        <div className="flex items-center gap-4">
          <div className="flex-1 text-center">
            <div className="text-[11px] font-bold uppercase text-[#1f2a37]">Dias sem {adj ? 'parada para ajuste' : 'máquina parada'}</div>
            <div className="mt-1 text-5xl font-bold tabular text-[#1f2a37]">{d.now.daysSinceStop ?? '—'}</div>
            <div className="text-[11px] font-semibold text-[#ea6a1f]">{d.now.stopped ? `${d.now.stopped} parada(s) agora` : 'nenhuma parada agora'}</div>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-2 text-center">
            <Mini label="Disponib." value={pct(d.period.availability)} />
            <Mini label="MTBF" value={hfmt(d.period.mtbfH)} />
            <Mini label={adj ? 'T. ajuste' : 'MTTR'} value={hfmt(d.period.mttrH)} />
            <Mini label="Espera" value={hfmt(d.period.waitH)} />
          </div>
        </div>
      </Tile>

      <Tile section="Chamados" className="xl:col-span-4">
        <div className="grid grid-cols-4 gap-2 text-center">
          <Big label={`Abertas · ${periodLabel}`} value={d.period.opened} />
          <Big label="Finalizadas" value={d.period.finished} accent />
          <Big label="Em aberto agora" value={d.now.open} />
          <Big label="Aguardando aceite" value={d.now.waiting} accent />
        </div>
      </Tile>

      <Tile section="Paradas" className="xl:col-span-5">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Big label={`Horas paradas · ${periodLabel}`} value={hfmt(d.period.downtimeH)} accent />
          <Big label="Chamados com parada" value={d.period.stops} />
          <Big label={adj ? 'Máquinas no filtro' : 'Equipamentos no filtro'} value={d.units} />
        </div>
      </Tile>

      <Tile section="Chamados" title={`${D.short} abertas x finalizadas - qtd`} legend={[['Abertas', NAVY], ['Finalizadas', ORANGE]]} className="xl:col-span-6">
        <div className="h-60">
          <ResponsiveContainer>
            <BarChart data={months} margin={{ top: 18, right: 4, left: -24, bottom: 0 }} barGap={2} onClick={(e: any) => e?.activePayload && onMonth(e.activePayload[0].payload.month)}>
              <XAxis dataKey="label" {...axis} interval={0} angle={-35} textAnchor="end" height={44} />
              <YAxis allowDecimals={false} {...axis} />
              <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={tip} />
              <Bar dataKey="opened" name="Abertas" fill={NAVY} maxBarSize={22} radius={[3, 3, 0, 0]} cursor="pointer">
                {months.map((m) => <Cell key={m.month} fillOpacity={dim(m.month)} />)}
                <LabelList dataKey="opened" position="top" fontSize={10} fill="#1f2a37" />
              </Bar>
              <Bar dataKey="finished" name="Finalizadas" fill={ORANGE} maxBarSize={22} radius={[3, 3, 0, 0]} cursor="pointer">
                {months.map((m) => <Cell key={m.month} fillOpacity={dim(m.month)} />)}
                <LabelList dataKey="finished" position="top" fontSize={10} fill="#9a3f0b" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Tile>

      <Tile section="Tempo" title={`${adj ? 'Tempo de ajuste' : 'MTTR'} e espera - horas`} legend={[['Espera na fila', NAVY], [adj ? 'Tempo de ajuste' : 'MTTR (reparo)', ORANGE]]} className="xl:col-span-6">
        <div className="h-60">
          <ResponsiveContainer>
            <LineChart data={months} margin={{ top: 18, right: 16, left: -24, bottom: 0 }} onClick={(e: any) => e?.activePayload && onMonth(e.activePayload[0].payload.month)}>
              <CartesianGrid vertical={false} stroke="#eef0f2" />
              <XAxis dataKey="label" {...axis} interval={0} angle={-35} textAnchor="end" height={44} />
              <YAxis {...axis} />
              <Tooltip contentStyle={tip} formatter={(v) => hfmt(Number(v))} />
              <Line dataKey="wait" name="Espera na fila" stroke={NAVY} strokeWidth={2} dot={{ r: 3 }} connectNulls>
                <LabelList dataKey="wait" position="top" fontSize={10} fill={NAVY} formatter={(v: any) => (v == null ? '' : num(v))} />
              </Line>
              <Line dataKey="mttr" name={adj ? 'Tempo de ajuste' : 'MTTR'} stroke={ORANGE} strokeWidth={2} dot={{ r: 3 }} connectNulls>
                <LabelList dataKey="mttr" position="bottom" fontSize={10} fill="#9a3f0b" formatter={(v: any) => (v == null ? '' : num(v))} />
              </Line>
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Tile>

      <Tile section="Paradas" title="Horas paradas - qtd" className="xl:col-span-4">
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={months} margin={{ top: 18, right: 4, left: -24, bottom: 0 }} onClick={(e: any) => e?.activePayload && onMonth(e.activePayload[0].payload.month)}>
              <XAxis dataKey="label" {...axis} interval={0} angle={-35} textAnchor="end" height={44} />
              <YAxis {...axis} />
              <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={tip} formatter={(v) => hfmt(Number(v))} />
              <Bar dataKey="downtime" name="Horas paradas" fill={ORANGE} maxBarSize={26} radius={[3, 3, 0, 0]} cursor="pointer">
                {months.map((m) => <Cell key={m.month} fillOpacity={dim(m.month)} />)}
                <LabelList dataKey="downtime" position="top" fontSize={10} fill="#9a3f0b" formatter={(v: any) => (v ? num(v) : '')} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Tile>

      <Tile section="Disponibilidade" title="Disponibilidade - %" className="xl:col-span-4">
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={months} margin={{ top: 18, right: 8, left: 8, bottom: 0 }} onClick={(e: any) => e?.activePayload && onMonth(e.activePayload[0].payload.month)}>
              <XAxis dataKey="label" {...axis} interval={0} angle={-35} textAnchor="end" height={44} />
              <YAxis {...axis} domain={[0, 100]} hide />
              <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={tip} formatter={(v) => `${num(Number(v))}%`} />
              <Bar dataKey="avail" name="Disponibilidade" maxBarSize={30} cursor="pointer">
                {months.map((m) => <Cell key={m.month} fill={month === m.month || (!month && m === months[months.length - 1]) ? PEACH : ORANGE} fillOpacity={dim(m.month)} />)}
                <LabelList dataKey="avail" position="top" fontSize={10} fill="#1f2a37" formatter={(v: any) => (v == null ? '' : `${num(v)}%`)} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Tile>

      <Tile section="Ocorrências" title={adj ? 'Motivos mais frequentes' : 'Tipos de manutenção'} className="xl:col-span-4">
        {totalCat ? (
          <div className="flex items-center gap-2">
            <div className="h-48 w-44 shrink-0">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pie} dataKey="value" nameKey="name" innerRadius={44} outerRadius={70} paddingAngle={1} stroke="#fff" strokeWidth={2}>
                    {pie.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={tip} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="min-w-0 flex-1 space-y-1 text-[11px]">
              {pie.map((p, i) => (
                <li key={p.name} className="flex items-start gap-1.5">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span className="min-w-0 flex-1 truncate text-gray-700" title={p.name}>{p.name}</span>
                  <span className="whitespace-nowrap font-semibold tabular text-gray-900">{p.value} ({num((p.value / totalCat) * 100, 0)}%)</span>
                </li>
              ))}
            </ul>
          </div>
        ) : <Empty />}
      </Tile>

      <Tile section="Equipamentos" title={`${adj ? 'Máquinas' : 'Máquinas e montagens'} com mais ${D.short} - qtd`} className="xl:col-span-4">
        <HBars rows={d.byAsset.map((a) => ({ key: a.label, label: a.label, value: a.n, note: a.downtimeH ? `${hfmt(a.downtimeH)} parada` : '' }))} color={NAVY} onPick={onAsset} />
      </Tile>

      <Tile section="Produtos" title={`Part numbers com mais ${D.short} - qtd`} className="xl:col-span-4">
        <HBars rows={d.byPn.map((p) => ({ key: p.key, label: p.label, value: p.n, note: p.downtimeH ? `${hfmt(p.downtimeH)} parada` : '' }))} color={ORANGE} onPick={onPn} />
      </Tile>

      <Tile section="Pessoas" title={`Horas por ${D.worker} - qtd`} className="xl:col-span-4">
        <HBars rows={d.byWorker.map((w) => ({ key: w.name, label: w.name, value: Math.round(w.hours * 10) / 10, note: `${w.orders} ${D.short}`, fmt: hfmt }))} color={ORANGE} />
      </Tile>

      {adj ? (
        <Tile section="Ocorrências" title="Motivos - todos" className="xl:col-span-12">
          <HBars rows={d.byCategory.map((c) => ({ key: c.key, label: c.label, value: c.n, note: c.downtimeH ? `${hfmt(c.downtimeH)} parada` : '' }))} color={ORANGE} />
        </Tile>
      ) : (
        <Tile section="Origem" title="Máquina x montagem e setores que abrem - qtd" className="xl:col-span-12">
          <div className="grid gap-4 md:grid-cols-2">
            <HBars rows={d.byLocation.map((l) => ({ key: l.key, label: l.label, value: l.n, note: l.downtimeH ? `${hfmt(l.downtimeH)} parada` : '' }))} color={NAVY} />
            <HBars rows={d.byArea.map((a) => ({ key: a.key, label: a.label, value: a.n, note: '' }))} color={ORANGE} />
          </div>
        </Tile>
      )}
    </div>
  );
}

const tip = { fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' };

function Tile({ section, title, legend, className, children }: { section: string; title?: string; legend?: [string, string][]; className?: string; children: ReactNode }) {
  return (
    <section className={cx('rounded-xl bg-white p-3 shadow-sm', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{section}</div>
      {title && <h2 className="mt-1 text-[13px] font-bold uppercase text-[#1f2a37]">{title}</h2>}
      {legend && (
        <div className="mt-0.5 flex flex-wrap gap-3 text-[10px] font-semibold uppercase text-gray-600">
          {legend.map(([l, c]) => <span key={l} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{l}</span>)}
        </div>
      )}
      <div className="mt-2">{children}</div>
    </section>
  );
}

const Big = ({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) => (
  <div>
    <div className={cx('text-3xl font-bold tabular', accent ? 'text-[#ea6a1f]' : 'text-[#1f2a37]')}>{value}</div>
    <div className="text-[10px] font-semibold uppercase leading-tight text-gray-500">{label}</div>
  </div>
);
const Mini = ({ label, value }: { label: string; value: ReactNode }) => (
  <div>
    <div className="whitespace-nowrap text-base font-bold tabular text-[#1f2a37]">{value}</div>
    <div className="text-[10px] font-semibold uppercase text-gray-500">{label}</div>
  </div>
);
const Empty = () => <p className="py-6 text-center text-xs text-gray-500">Sem dados no filtro.</p>;

function HBars({ rows, color, onPick }: { rows: { key: string; label: string; value: number; note: string; fmt?: (v: number) => string }[]; color: string; onPick?: (k: string) => void }) {
  const list = rows.filter((r) => r.value > 0).slice(0, 12);
  if (!list.length) return <Empty />;
  const max = Math.max(...list.map((r) => r.value));
  return (
    <ul className="space-y-1">
      {list.map((r) => (
        <li key={r.key}>
          <button type="button" disabled={!onPick} onClick={() => onPick?.(r.key)} title={onPick ? 'Filtrar por este item' : undefined}
            className={cx('grid w-full grid-cols-[minmax(0,40%)_1fr] items-center gap-2 rounded px-1 py-0.5 text-left text-xs', onPick && 'hover:bg-gray-50')}>
            <span className="truncate text-gray-800" title={r.label}>{r.label}</span>
            <span className="flex items-center gap-2">
              <span className="h-4 rounded-sm" style={{ width: `${Math.max(2, (r.value / max) * 70)}%`, background: color }} />
              <span className="whitespace-nowrap tabular"><b className="text-gray-900">{r.fmt ? r.fmt(r.value) : r.value}</b>{r.note && <span className="text-gray-500"> · {r.note}</span>}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
