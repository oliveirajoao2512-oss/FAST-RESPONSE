import { useQuery } from '@tanstack/react-query';
import {
  AlertOctagon, CheckCircle2, ClipboardCopy, Clock, Download, FileSpreadsheet, Maximize2, PauseCircle, Plus, Printer, Repeat, Search, ShieldAlert, Timer, Upload,
} from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ORIGIN_COLORS, ORIGIN_LABELS, PARTNER_LABELS, Q_OPEN_STATUSES, Q_STATUS_LABELS, Q_STATUSES, QUALITY_ORIGINS, STEP_LABELS, type QStatus, type QualityOrigin,
} from '@shared/quality';
import { ImportModal } from '../components/quality/ImportModal';
import { NcDetail } from '../components/quality/NcDetail';
import { NewNcModal } from '../components/quality/NewNcModal';
import { OriginTag, QStatusBadge, StepDots, StepLegend } from '../components/quality/parts';
import { SuggestionsTab, useSuggestions } from '../components/quality/Suggestions';
import { Button, Card, cx, Empty, ErrorBox, Input, Kpi, Segmented, Select, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { usePersistentState } from '../lib/hooks';
import { dm, dmy, MONTHS, useQualityData, type QualityNc } from '../lib/quality';
import { qualityStats, summaryText, type QualityStats } from '../lib/qualityStats';
import { useToast } from '../lib/toast';

type OriginFilter = 'todas' | QualityOrigin;
interface Filters { origin: OriginFilter; year: string; month: string; partner: string; leader: string; problem: string; proc: 'SIM' | 'todas'; status: '' | 'abertas' | QStatus; text: string }
const EMPTY: Omit<Filters, 'year'> = { origin: 'todas', month: '', partner: '', leader: '', problem: '', proc: 'SIM', status: '', text: '' };

function applyFilters(list: QualityNc[], f: Filters, ignoreOrigin = false) {
  const t = f.text.trim().toLowerCase();
  return list.filter((n) =>
    (ignoreOrigin || f.origin === 'todas' || n.origin === f.origin)
    && (f.year === 'todos' || n.opened_on.startsWith(f.year))
    && (!f.month || n.opened_on.slice(5, 7) === f.month)
    && (!f.partner || n.partner === f.partner)
    && (!f.leader || n.leader === f.leader)
    && (!f.problem || n.primary_problem === f.problem)
    && (f.proc === 'todas' || n.procedente === 'SIM')
    && (!f.status || (f.status === 'abertas' ? Q_OPEN_STATUSES.includes(n.eval.status) : n.eval.status === f.status))
    && (!t || [n.number, n.partner, n.product, n.internal_code, n.customer_code, n.customer_claim, n.description, n.primary_problem, n.leader]
      .some((v) => v?.toLowerCase().includes(t))));
}

export function QualityPage() {
  const q = useQualityData();
  const toast = useToast();
  const data = q.data;
  const today = data?.today ?? new Date().toISOString().slice(0, 10);
  const [tab, setTab] = usePersistentState<'painel' | 'acoes' | 'ocorrencias' | 'importacoes'>('fr-quality-tab', 'painel');
  const [horizon, setHorizon] = useState(7);
  const sugg = useSuggestions(horizon);
  const pendingActions = sugg.data?.pending.length;
  const [f, setF] = useState<Filters>({ ...EMPTY, year: today.slice(0, 4) });
  const set = (p: Partial<Filters>) => setF((x) => ({ ...x, ...p }));
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState<{ file: File | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  const all = data?.ncs ?? [];
  const years = useMemo(() => [...new Set([today.slice(0, 4), ...all.map((n) => n.opened_on.slice(0, 4))])].sort().reverse(), [all, today]);
  const filtered = useMemo(() => applyFilters(all, f), [all, f]);
  // the customer-complaint traffic light always looks at NC Externa, whatever the origin filter
  const stats = useMemo(() => {
    const s = qualityStats(filtered, today, f.year);
    const ext = applyFilters(all, { ...f, month: '' }, true);
    // months before the first record in the base have no data (not "zero complaints")
    const first = all.reduce((m, n) => (n.opened_on < m ? n.opened_on : m), today).slice(0, 7);
    return { ...s, farol: qualityStats(ext, today, f.year).farol.map((m) => ({ ...m, noData: m.ym < first })) };
  }, [filtered, all, f, today]);
  const options = useMemo(() => {
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return { partners: uniq(all.map((n) => n.partner)), leaders: uniq(all.map((n) => n.leader)), problems: uniq(all.map((n) => n.primary_problem)) };
  }, [all]);
  const active = Object.entries(EMPTY).some(([k, v]) => f[k as keyof Filters] !== v) || f.year !== today.slice(0, 4);
  const scope = [f.origin !== 'todas' && ORIGIN_LABELS[f.origin], f.year !== 'todos' && (f.month ? `${MONTHS[Number(f.month) - 1]}/${f.year}` : f.year), f.partner, f.leader, f.problem].filter(Boolean).join(' · ');

  const goList = (p: Partial<Filters>) => { set(p); setTab('ocorrencias'); };
  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText(stats, today, scope));
      toast('ok', 'Resumo copiado. Cole no e-mail, Teams ou WhatsApp.');
    } catch {
      toast('error', 'Não foi possível copiar. Verifique a permissão da área de transferência do navegador.');
    }
  };
  const print = () => {
    document.body.classList.add('print-quality');
    window.print();
    setTimeout(() => document.body.classList.remove('print-quality'), 500);
  };
  const present = () => panel.current?.requestFullscreen?.().catch(() => toast('error', 'O navegador não permitiu a tela cheia.'));

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files') || importing) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) setImporting({ file });
  };

  return (
    <div className="relative space-y-4" onDragOver={onDragOver} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={onDrop}>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-brand-600/15 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-brand-600 bg-white px-8 py-6 text-center shadow-xl">
            <FileSpreadsheet className="mx-auto text-emerald-700" size={40} />
            <div className="mt-2 font-semibold">Solte a planilha para importar</div>
            <div className="text-sm text-gray-500">Você confere a prévia antes de gravar.</div>
          </div>
        </div>
      )}

      <div className="no-print flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Qualidade · Resposta Rápida</h1>
          <p className="text-sm text-gray-500">
            Não conformidades de clientes, internas e de fornecedores.{' '}
            {data?.lastImport && <>Última importação: {fmtDateTime(data.lastImport.imported_at)} por {data.lastImport.imported_by_name}.</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button kind="primary" onClick={() => setImporting({ file: null })}><Upload size={16} />Importar planilha</Button>
          <Button onClick={() => setCreating(true)}><Plus size={16} />Nova ocorrência</Button>
          <a href="/api/quality/export.xlsx" download className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"><Download size={16} />Exportar Excel</a>
        </div>
      </div>

      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'painel', label: 'Painel' }, { value: 'acoes', label: <>Ações sugeridas{pendingActions ? <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs font-bold text-white">{pendingActions}</span> : null}</> }, { value: 'ocorrencias', label: `Ocorrências${data ? ` (${filtered.length})` : ''}` }, { value: 'importacoes', label: 'Importações' }]} />
        {tab === 'painel' && (
          <div className="flex flex-wrap gap-1">
            <Button kind="ghost" size="sm" onClick={copySummary}><ClipboardCopy size={16} />Copiar resumo</Button>
            <Button kind="ghost" size="sm" onClick={present}><Maximize2 size={16} />Apresentar</Button>
            <Button kind="ghost" size="sm" onClick={print}><Printer size={16} />Imprimir / PDF</Button>
          </div>
        )}
      </div>

      {(tab === 'painel' || tab === 'ocorrencias') && (
        <div className="no-print grid grid-cols-2 gap-2 rounded-xl border border-gray-200 bg-white p-3 lg:grid-cols-4">
          <Select aria-label="Origem" value={f.origin} onChange={(e) => set({ origin: e.target.value as OriginFilter })}>
            <option value="todas">Todas as origens</option>
            {QUALITY_ORIGINS.map((o) => <option key={o} value={o}>{ORIGIN_LABELS[o]}</option>)}
          </Select>
          <Select aria-label="Ano" value={f.year} onChange={(e) => set({ year: e.target.value, month: e.target.value === 'todos' ? '' : f.month })}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
            <option value="todos">Todos os anos</option>
          </Select>
          <Select aria-label="Mês" value={f.month} disabled={f.year === 'todos'} onChange={(e) => set({ month: e.target.value })}>
            <option value="">Ano inteiro</option>
            {MONTHS.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
          </Select>
          <Select aria-label="Cliente ou fornecedor" value={f.partner} onChange={(e) => set({ partner: e.target.value })}>
            <option value="">Clientes e fornecedores</option>
            {options.partners.map((p) => <option key={p}>{p}</option>)}
          </Select>
          <Select aria-label="Líder" value={f.leader} onChange={(e) => set({ leader: e.target.value })}>
            <option value="">Todos os líderes</option>
            {options.leaders.map((p) => <option key={p}>{p}</option>)}
          </Select>
          <Select aria-label="Problema primário" value={f.problem} onChange={(e) => set({ problem: e.target.value })}>
            <option value="">Todos os problemas</option>
            {options.problems.map((p) => <option key={p}>{p}</option>)}
          </Select>
          <Select aria-label="Procedência" value={f.proc} onChange={(e) => set({ proc: e.target.value as Filters['proc'] })} title="Critério gerencial: indicadores consideram só incidentes procedentes">
            <option value="SIM">Somente procedentes</option>
            <option value="todas">Todas (inclui não procedentes)</option>
          </Select>
          <Select aria-label="Status" value={f.status} onChange={(e) => set({ status: e.target.value as Filters['status'] })}>
            <option value="">Todos os status</option>
            <option value="abertas">Em aberto</option>
            {Q_STATUSES.map((s) => <option key={s} value={s}>{Q_STATUS_LABELS[s]}</option>)}
          </Select>
          {active && <Button kind="ghost" size="sm" className="justify-self-start" onClick={() => setF({ ...EMPTY, year: today.slice(0, 4) })}>Limpar filtros</Button>}
        </div>
      )}

      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}

      {data && all.length === 0 && (tab === 'painel' || tab === 'ocorrencias') && (
        <button onClick={() => setImporting({ file: null })} className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-gray-300 bg-white px-6 py-12 text-center hover:border-brand-400">
          <FileSpreadsheet size={44} className="text-emerald-700" />
          <span className="text-lg font-semibold">Comece importando a planilha Resposta Rápida</span>
          <span className="max-w-lg text-sm text-gray-500">Arraste o arquivo .xlsx para esta tela ou clique aqui. As abas NC Externa, NC Interna e NC Fornecedor viram o painel na hora, e você confere tudo antes de gravar.</span>
        </button>
      )}

      {data && all.length > 0 && tab === 'painel' && (
        <div ref={panel} className="space-y-4 [&:fullscreen]:overflow-y-auto [&:fullscreen]:bg-[#f5f6f8] [&:fullscreen]:p-6">
          <div className="hidden items-baseline justify-between [.print-quality_&]:flex [:fullscreen>&]:flex">
            <h1 className="text-xl font-bold">Qualidade · Resposta Rápida</h1>
            <span className="text-sm text-gray-500">{scope || 'Todas as ocorrências'} · referência {dmy(today)}</span>
          </div>
          <Panel s={stats} today={today} year={f.year} onOpen={setOpenId} goList={goList} setFilter={set} />
        </div>
      )}

      {data && all.length > 0 && tab === 'ocorrencias' && (
        <NcList list={filtered} text={f.text} setText={(text) => set({ text })} onOpen={setOpenId} />
      )}

      {tab === 'importacoes' && <ImportHistory />}
      {tab === 'acoes' && <SuggestionsTab horizon={horizon} setHorizon={setHorizon} onOpenNc={setOpenId} />}

      {openId != null && <NcDetail id={openId} today={today} onClose={() => setOpenId(null)} />}
      {creating && <NewNcModal today={today} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />}
      {importing && <ImportModal initialFile={importing.file} onClose={() => setImporting(null)} />}
    </div>
  );
}

function Panel({ s, today, year, onOpen, goList, setFilter }: {
  s: QualityStats; today: string; year: string; onOpen: (id: number) => void; goList: (p: Partial<Filters>) => void; setFilter: (p: Partial<Filters>) => void;
}) {
  const k = s.kpi;
  const maxPareto = Math.max(1, ...s.pareto.map((p) => p.count));
  const maxStep = Math.max(1, ...s.steps.map((x) => x.overdue + x.late));
  const maxPartner = Math.max(1, ...s.partners.map((p) => p.total));
  const late = s.actions.filter((a) => a.nc.eval.status !== 'on_hold');
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-8">
        <Kpi label="Ocorrências" value={k.total} onClick={() => goList({ status: '' })} />
        <Kpi label="Em aberto" value={k.open} tone="info" icon={<Clock size={14} />} onClick={() => goList({ status: 'abertas' })} />
        <Kpi label="Atrasadas" value={k.late} tone={k.late ? 'danger' : 'ok'} icon={<AlertOctagon size={14} />} onClick={() => goList({ status: 'atrasado' })} />
        <Kpi label="On hold" value={k.hold} icon={<PauseCircle size={14} />} onClick={() => goList({ status: 'on_hold' })} />
        <Kpi label="Encerradas no prazo" value={k.onTimePct == null ? '—' : `${k.onTimePct}%`} tone="ok" icon={<CheckCircle2 size={14} />} hint={`${k.onTime} de ${k.closed} encerradas`} onClick={() => goList({ status: 'concluido_no_prazo' })} />
        <Kpi label="Tempo médio" value={k.avgDays == null ? '—' : `${k.avgDays} d`} icon={<Timer size={14} />} hint="abertura → lições aprendidas" />
        <Kpi label="Segurança / regulat." value={k.safety} tone={k.safety ? 'danger' : 'default'} icon={<ShieldAlert size={14} />} />
        <Kpi label="Reincidentes" value={k.recurrent} tone={k.recurrent ? 'warn' : 'default'} icon={<Repeat size={14} />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="O que precisa de ação agora" actions={<span className="text-xs text-gray-500">próxima etapa de cada ocorrência em aberto</span>}>
          {late.length === 0 ? <Empty>Nenhuma ocorrência em aberto com os filtros atuais.</Empty> : (
            <ul className="divide-y">
              {late.slice(0, 8).map((a) => (
                <li key={a.nc.id}>
                  <button onClick={() => onOpen(a.nc.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2 text-left hover:bg-gray-50">
                    <span className={cx('w-16 shrink-0 rounded-md px-1.5 py-1 text-center text-xs font-bold tabular', a.days > 0 ? 'bg-red-600 text-white' : a.days >= -3 ? 'bg-amber-100 text-amber-900' : 'bg-gray-100 text-gray-700')}>
                      {a.days > 0 ? `+${a.days} d` : a.days === 0 ? 'hoje' : `${-a.days} d`}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{a.nc.number}</span> <span className="text-gray-600">· {a.nc.partner ?? '—'}</span>
                      <span className="block text-xs text-gray-500">{a.step ? STEP_LABELS[a.step] : 'Encerramento'} · prazo {dm(a.plan)} · {a.nc.leader ?? 'sem líder'}</span>
                    </span>
                    <StepDots states={a.nc.eval.stepStates} steps={a.nc.steps} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {late.length > 8 && <button className="mt-2 text-sm text-brand-700 hover:underline" onClick={() => goList({ status: 'abertas' })}>Ver todas as {late.length} em aberto</button>}
          <div className="mt-3 border-t pt-2"><StepLegend /></div>
        </Card>

        <Card className="lg:col-span-2" title="Farol de reclamações de clientes" actions={<span className="text-xs text-gray-500">meta: zero</span>}>
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
            {s.farol.map((m) => (
              <button key={m.ym} disabled={m.future || m.noData} onClick={() => setFilter({ origin: 'externa', year: m.ym.slice(0, 4), month: m.ym.slice(5, 7) })}
                title={m.future ? 'Mês futuro' : m.noData ? 'Antes do primeiro registro da base' : `${m.count} reclamação(ões), ${m.official} oficial(is)`}
                className={cx('flex flex-col items-center rounded-lg py-2 text-xs font-medium',
                  m.future || m.noData ? 'bg-gray-100 text-gray-400' : m.count === 0 ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-red-600 text-white hover:bg-red-700')}>
                <span className="uppercase">{m.label}</span>
                <span className="text-lg font-bold tabular">{m.future || m.noData ? '·' : m.count}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500">Verde: mês sem reclamação de cliente (meta). Vermelho: houve reclamação. Cinza: mês futuro ou sem registros na base. Clique em um mês para filtrar.</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={year === 'todos' ? 'Ocorrências por mês (últimos 12 meses)' : `Ocorrências por mês em ${year}`}>
          <div className="h-72 w-full" aria-label="Ocorrências por mês e origem">
            <ResponsiveContainer>
              <BarChart data={s.byMonth} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#d1d5db' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" formatter={(v) => <span className="text-gray-700">{v}</span>} />
                {QUALITY_ORIGINS.map((o, i) => (
                  <Bar key={o} dataKey={o} name={ORIGIN_LABELS[o]} stackId="o" fill={ORIGIN_COLORS[o]} stroke="#fff" strokeWidth={1}
                    radius={i === QUALITY_ORIGINS.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={28} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Pareto dos problemas" actions={<span className="text-xs text-gray-500">clique para filtrar</span>}>
          {s.pareto.length === 0 ? <Empty>Sem dados.</Empty> : (
            <ul className="space-y-1.5">
              {s.pareto.slice(0, 10).map((p, i) => {
                const vital = i === 0 || s.pareto[i - 1].cum < 80;
                return (
                  <li key={p.name}>
                    <button onClick={() => setFilter({ problem: p.name })} className="w-full text-left text-sm hover:opacity-80">
                      <div className="flex justify-between gap-2"><span className="truncate">{p.name}</span><span className="shrink-0 tabular text-gray-600">{p.count} · <span className="text-xs">{p.cum}% acum.</span></span></div>
                      <div className="mt-0.5 h-2 rounded-full bg-gray-100"><div className={cx('h-2 rounded-full', vital ? 'bg-chart-b' : 'bg-gray-400')} style={{ width: `${(p.count / maxPareto) * 100}%` }} /></div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-xs text-gray-500">Em laranja, os problemas que somam até 80% das ocorrências.</p>
        </Card>

        <Card title="Gargalos por etapa">
          <div className="mb-2 flex gap-3 text-xs text-gray-600">
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-red-600" />Vencidas sem registro</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-400" />Concluídas com atraso</span>
          </div>
          <ul className="space-y-1.5">
            {s.steps.map((x) => (
              <li key={x.key} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-2 text-sm">
                <span className="truncate text-gray-700">{x.label}</span>
                <span className="flex h-3 gap-0.5">
                  {x.overdue > 0 && <span className="h-3 rounded-sm bg-red-600" style={{ width: `${(x.overdue / maxStep) * 100}%` }} title={`${x.overdue} vencida(s) sem registro`} />}
                  {x.late > 0 && <span className="h-3 rounded-sm bg-amber-400" style={{ width: `${(x.late / maxStep) * 100}%` }} title={`${x.late} concluída(s) com atraso`} />}
                </span>
                <span className="text-right tabular text-gray-600">{x.overdue + x.late}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Clientes e fornecedores" actions={<span className="text-xs text-gray-500">clique para filtrar</span>}>
          {s.partners.length === 0 ? <Empty>Sem dados.</Empty> : (
            <ul className="space-y-1.5">
              {s.partners.slice(0, 10).map((p) => (
                <li key={p.name}>
                  <button onClick={() => setFilter({ partner: p.name })} className="grid w-full grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-left text-sm hover:opacity-80">
                    <span className="flex items-center gap-1.5 truncate">{p.origins.map((o) => <span key={o} className="h-2 w-2 shrink-0 rounded-sm" style={{ background: ORIGIN_COLORS[o] }} title={ORIGIN_LABELS[o]} />)}<span className="truncate">{p.name}</span></span>
                    <span className="h-2.5 rounded-full bg-gray-100"><span className="block h-2.5 rounded-full bg-chart-a" style={{ width: `${(p.total / maxPartner) * 100}%` }} /></span>
                    <span className="tabular text-gray-600">{p.total}{p.late > 0 && <span className="ml-1 text-xs text-red-700">({p.late} atras.)</span>}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Líderes">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Líder</th><th className="text-right">Em aberto</th><th className="text-right">Atrasadas</th><th className="text-right">Encerradas</th><th className="text-right">No prazo</th><th className="text-right">Tempo médio</th></tr></thead>
            <tbody className="divide-y">
              {s.leaders.map((l) => (
                <tr key={l.name} className="cursor-pointer hover:bg-gray-50" onClick={() => setFilter({ leader: l.name })}>
                  <td className="py-1.5 font-medium">{l.name}</td>
                  <td className="text-right tabular">{l.open}</td>
                  <td className={cx('text-right tabular', l.late > 0 && 'font-semibold text-red-700')}>{l.late}</td>
                  <td className="text-right tabular">{l.closed}</td>
                  <td className="text-right tabular">{l.onTimePct == null ? '—' : `${l.onTimePct}%`}</td>
                  <td className="text-right tabular">{l.avgDays == null ? '—' : `${l.avgDays} d`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-500">Volume de ocorrências conduzidas por líder; não indica responsabilidade pela origem do problema. Referência: {dmy(today)}.</p>
      </Card>
    </>
  );
}

function NcList({ list, text, setText, onOpen }: { list: QualityNc[]; text: string; setText: (t: string) => void; onOpen: (id: number) => void }) {
  const [limit, setLimit] = useState(100);
  const shown = list.slice(0, limit);
  return (
    <Card title={<span className="relative block w-full sm:w-80"><Search size={16} className="absolute left-2.5 top-2.5 text-gray-400" /><Input className="pl-8" placeholder="Buscar número, código, produto, problema…" value={text} onChange={(e) => setText(e.target.value)} /></span>}
      actions={<StepLegend />}>
      {list.length === 0 ? <Empty>Nenhuma ocorrência com os filtros atuais.</Empty> : (
        <>
          <ul className="divide-y md:hidden">
            {shown.map((n) => (
              <li key={n.id}>
                <button className="w-full py-2.5 text-left" onClick={() => onOpen(n.id)}>
                  <div className="flex items-center justify-between gap-2"><span className="font-semibold">{n.number}</span><QStatusBadge status={n.eval.status} /></div>
                  <div className="text-sm text-gray-700">{n.partner ?? '—'} · {n.product ?? '—'}</div>
                  <div className="text-xs text-gray-500">{dmy(n.opened_on)} · {n.primary_problem ?? '—'} · {n.leader ?? '—'}</div>
                  <div className="mt-1 flex items-center gap-2"><StepDots states={n.eval.stepStates} steps={n.steps} /><OriginTag origin={n.origin} short /></div>
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm [&_td]:px-1.5 [&_th]:px-1.5">
              <thead className="text-left text-xs uppercase text-gray-500">
                <tr><th className="py-1.5">Nº</th><th>Origem</th><th>Abertura</th><th>Cliente / fornecedor</th><th>Produto · problema</th><th>Líder</th><th>Etapas</th><th>Próxima etapa</th><th>Status</th><th className="text-right">Dias</th></tr>
              </thead>
              <tbody className="divide-y">
                {shown.map((n) => (
                  <tr key={n.id} className="cursor-pointer hover:bg-gray-50" onClick={() => onOpen(n.id)}>
                    <td className="py-2 font-semibold tabular">{n.number}</td>
                    <td><OriginTag origin={n.origin} short /></td>
                    <td className="tabular">{dmy(n.opened_on)}</td>
                    <td>{n.partner ?? '—'}</td>
                    <td className="max-w-xs"><div className="truncate">{n.product ?? '—'}</div><div className="truncate text-xs text-gray-500">{n.primary_problem ?? n.description ?? ''}</div></td>
                    <td>{n.leader ?? '—'}</td>
                    <td><StepDots states={n.eval.stepStates} steps={n.steps} /></td>
                    <td className="text-xs">{n.eval.currentStep && Q_OPEN_STATUSES.includes(n.eval.status) ? <>{STEP_LABELS[n.eval.currentStep]}<div className="text-gray-500">prazo {dm(n.steps[n.eval.currentStep].plan)}</div></> : '—'}</td>
                    <td><QStatusBadge status={n.eval.status} /></td>
                    <td className={cx('text-right tabular', n.eval.daysOver > 0 && 'font-semibold text-red-700')} title={n.eval.daysOver > 0 ? `${n.eval.daysOver} dia(s) acima do prazo` : undefined}>{n.eval.totalDays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.length > limit && <Button className="mt-3" onClick={() => setLimit(limit + 200)}>Mostrar mais ({list.length - limit})</Button>}
          <p className="mt-2 text-xs text-gray-500">{PARTNER_LABELS.externa} para NC Externa e Interna; {PARTNER_LABELS.fornecedor.toLowerCase()} para NC Fornecedor. Dias em vermelho: acima do prazo de 40 dias.</p>
        </>
      )}
    </Card>
  );
}

function ImportHistory() {
  const q = useQuery({ queryKey: ['quality', 'imports'], queryFn: () => get<any[]>('/api/quality/imports') });
  return (
    <Card title="Importações da planilha">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.length === 0 ? <Empty>Nenhuma importação ainda.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Data</th><th>Arquivo</th><th>Por</th><th className="text-right">Novas</th><th className="text-right">Atualizadas</th><th className="text-right">Sem alteração</th><th className="text-right">Avisos</th></tr></thead>
            <tbody className="divide-y">{q.data.map((i) => (
              <tr key={i.id}><td className="py-1.5 tabular">{fmtDateTime(i.imported_at)}</td><td className="max-w-xs truncate">{i.filename}</td><td>{i.imported_by_name}</td>
                <td className="text-right tabular">{i.created_count}</td><td className="text-right tabular">{i.updated_count}</td><td className="text-right tabular">{i.unchanged_count}</td><td className="text-right tabular">{i.warnings}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      <p className="mt-2 text-xs text-gray-500">O registro das importações é permanente. Cada alteração feita pela planilha aparece também no histórico da ocorrência.</p>
    </Card>
  );
}
