import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, Maximize, Minimize, PauseCircle, Settings2, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { WO_DOMAIN, type WoDomain } from '@shared/maintenance';
import { get } from '../lib/api';
import { tz } from '../lib/format';
import { useRealtime } from '../lib/realtime';

/**
 * Status da fábrica: a screen for a TV on the shop floor. Read-only, full screen, updates by itself
 * (server events + a refresh every 30 s) and keeps the clocks running between updates.
 */

interface Place {
  type: 'maquina' | 'montagem'; code: string; description: string | null;
  state: 'parada' | 'setup' | 'atencao' | 'ok'; since: string | null;
  orders: { code: string; domain: WoDomain; status: string; stopped: boolean; workers: string[] }[];
  setup?: SetupInfo;
}
interface SetupInfo { status: 'Em andamento' | 'Aguardando Produção'; pn: string | null; user: string | null; startedAt: string; finishedAt: string | null }
/** from the Controle de Setup app; only the administrator receives it */
interface SetupBoard {
  ok: boolean; error: string | null; inSetup: number; waitingProduction: number; today: number; finishedToday: number; hoursToday: number;
  unknownMachines: string[]; active: (SetupInfo & { machine: string })[];
}
interface QueueItem {
  id: string; code: string; domain: WoDomain; status: 'aberta' | 'em_atendimento' | 'pausada'; priority: string; stopped: boolean;
  place: string; category: string; description: string; openedAt: string; acceptedAt: string | null; workers: string[];
  pauseReason: string | null; pausedAt: string | null;
}
interface Board {
  now: string;
  places: Place[];
  queue: QueueItem[];
  scheduled: { id: string; code: string; domain: WoDomain; place: string; plannedStart: string; plannedHours: number | null; description: string }[];
  today: { opened: number; finished: number; stops: number; acceptMin: number | null; downtimeH: number; stoppedNow: number; waiting: number; working: number; paused: number };
  issues: { open: number; overdue: number; safety: number; areas: { name: string; color: string | null; open: number; overdue: number; safety: number }[] };
  setup?: SetupBoard;
}

/** "8 min", "1 h 05", "2 d 3 h" */
function since(from: string | null, now: number) {
  if (!from) return '';
  const m = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const hm = (d: string | Date) => new Date(d).toLocaleTimeString('pt-BR', { timeZone: tz(), hour: '2-digit', minute: '2-digit' });
const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1).replace('.', ',')} h`);

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function StatusBoardPage() {
  const conn = useRealtime(true);
  const { data, isError, dataUpdatedAt } = useQuery<Board>({
    queryKey: ['os', 'tela'],
    queryFn: () => get('/api/tela'),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });
  const now = useNow(1000);
  const root = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  // a TV must not go dark while showing the board
  useEffect(() => {
    let lock: any = null;
    const take = () => (navigator as any).wakeLock?.request('screen').then((l: any) => { lock = l; }).catch(() => {});
    take();
    const vis = () => document.visibilityState === 'visible' && take();
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); lock?.release?.(); };
  }, []);

  const stale = isError || conn !== 'online' || (dataUpdatedAt && now - dataUpdatedAt > 90_000);
  const date = new Date(now);

  return (
    <div ref={root} className="flex min-h-screen flex-col bg-[#0b1220] text-slate-100 [font-size:clamp(13px,0.95vw,22px)] lg:h-screen lg:overflow-hidden">
      {/* header */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 bg-[#0f1a30] px-4 py-3 lg:px-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500 text-lg font-black text-white">FR</div>
        <div className="min-w-[9em] flex-1">
          <h1 className="text-[1.6em] font-bold leading-tight tracking-tight">Status da fábrica</h1>
          <p className="hidden text-[0.85em] text-slate-400 sm:block">Fast Response · ordens de manutenção, ajustes e pendências ao vivo</p>
        </div>
        <div className="ml-auto flex items-center gap-3 lg:gap-5">
          <span className={`flex items-center gap-2 text-[0.85em] ${stale ? 'text-amber-300' : 'text-emerald-300'}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${stale ? 'animate-pulse bg-amber-400' : 'bg-emerald-400'}`} />
            {stale ? 'Reconectando…' : 'Ao vivo'}
          </span>
          <div className="text-right leading-tight">
            <div className="text-[1.6em] font-bold tabular-nums lg:text-[2.2em]">{date.toLocaleTimeString('pt-BR', { timeZone: tz() })}</div>
            <div className="text-[0.85em] text-slate-400 first-letter:uppercase">{date.toLocaleDateString('pt-BR', { timeZone: tz(), weekday: 'long', day: '2-digit', month: 'long' })}</div>
          </div>
          <button
            onClick={() => (full ? document.exitFullscreen() : root.current?.requestFullscreen?.())?.catch?.(() => {})}
            className="rounded-lg border border-white/15 p-2 text-slate-300 hover:bg-white/10" title={full ? 'Sair da tela cheia' : 'Tela cheia'}>
            {full ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </button>
          {!full && <Link to="/" className="rounded-lg border border-white/15 p-2 text-slate-300 hover:bg-white/10" title="Voltar ao sistema"><X className="h-5 w-5" /></Link>}
        </div>
      </header>

      {!data ? (
        <div className="flex flex-1 items-center justify-center text-[1.4em] text-slate-400">{isError ? 'Não foi possível carregar. Tentando de novo…' : 'Carregando…'}</div>
      ) : (
        <>
          {/* KPIs */}
          <section className={`grid grid-cols-2 gap-3 px-4 pt-4 sm:grid-cols-3 lg:px-6 ${data.setup ? 'lg:grid-cols-7' : 'lg:grid-cols-6'}`}>
            <Kpi tone={data.today.stoppedNow ? 'red' : 'green'} label="Máquinas paradas agora" value={data.today.stoppedNow} />
            <Kpi tone={data.today.waiting ? 'amber' : 'plain'} label="Aguardando aceite" value={data.today.waiting} />
            <Kpi tone="blue" label="Em atendimento" value={data.today.working} sub={data.today.paused ? `${data.today.paused} pausada(s)` : undefined} />
            <Kpi tone="plain" label="Abertas hoje" value={data.today.opened} sub={`${data.today.stops} com máquina parada`} />
            <Kpi tone="green" label="Finalizadas hoje" value={data.today.finished}
              sub={data.today.acceptMin != null ? `aceite médio ${Math.round(data.today.acceptMin)} min` : undefined} />
            <Kpi tone={data.today.downtimeH > 0 ? 'amber' : 'plain'} label="Máquina parada hoje" value={hours(data.today.downtimeH)} />
            {data.setup && (
              <Kpi tone={data.setup.inSetup + data.setup.waitingProduction ? 'violet' : 'plain'} label="Em setup agora" value={data.setup.inSetup}
                sub={!data.setup.ok ? 'Controle de Setup sem resposta' : data.setup.waitingProduction ? `+${data.setup.waitingProduction} aguardando produção` : `${data.setup.today} hoje · ${hours(data.setup.hoursToday)}`} />
            )}
          </section>

          <main className="grid flex-1 gap-4 px-4 py-4 lg:min-h-0 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] lg:px-6">
            {/* machines */}
            <section className="flex flex-col gap-3 lg:min-h-0 lg:overflow-hidden">
              <PlaceGrid title="Máquinas" places={data.places.filter((p) => p.type === 'maquina')} now={now} />
              <PlaceGrid title="Montagens" places={data.places.filter((p) => p.type === 'montagem')} now={now} />
              <Legend setup={!!data.setup} />
            </section>

            {/* queue */}
            <section className="flex flex-col gap-3 lg:min-h-0">
              <Panel title="Ordens em aberto agora" count={data.queue.length} className="min-h-[12em] lg:min-h-0 lg:flex-1">
                {data.queue.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-emerald-300">
                    <CheckCircle2 className="h-12 w-12" />
                    <span className="text-[1.2em] font-semibold">Nenhuma ordem em aberto</span>
                  </div>
                ) : (
                  <Queue items={data.queue} now={now} />
                )}
              </Panel>
              {data.setup && data.setup.active.length > 0 && (
                <Panel title="Em setup agora" count={data.setup.active.length} icon={<Settings2 className="h-4 w-4" />}>
                  <ul className="space-y-1.5">
                    {data.setup.active.slice(0, 6).map((s) => (
                      <li key={s.machine + s.startedAt} className="flex items-baseline gap-2 text-[0.9em]">
                        <span className="font-bold text-violet-300">Máq. {s.machine}</span>
                        <span className="truncate text-slate-300">{s.pn ?? ''}{s.user ? ` · ${s.user}` : ''}</span>
                        <span className={`ml-auto shrink-0 font-semibold tabular-nums ${s.status === 'Aguardando Produção' ? 'text-amber-300' : 'text-violet-200'}`}>
                          {s.status === 'Aguardando Produção' ? `aguard. produção ${since(s.finishedAt ?? s.startedAt, now)}` : since(s.startedAt, now)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {data.setup.unknownMachines.length > 0 && (
                    <div className="mt-1 text-[0.75em] text-slate-500">Sem cadastro no Fast Response: {data.setup.unknownMachines.join(', ')}</div>
                  )}
                </Panel>
              )}
              {data.scheduled.length > 0 && (
                <Panel title="Programadas para hoje" count={data.scheduled.length} icon={<CalendarClock className="h-4 w-4" />}>
                  <ul className="space-y-1.5">
                    {data.scheduled.slice(0, 4).map((s) => (
                      <li key={s.id} className="flex items-baseline gap-2 text-[0.9em]">
                        <span className="font-bold tabular-nums text-sky-300">{hm(s.plannedStart)}</span>
                        <span className="font-semibold">{s.place}</span>
                        <span className="truncate text-slate-400">{s.code}{s.plannedHours ? ` · ${String(s.plannedHours).replace('.', ',')} h` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </section>
          </main>

          {/* pendências */}
          <footer className="flex flex-wrap items-center gap-4 border-t border-white/10 bg-[#0f1a30] px-4 py-3 lg:px-6">
            <div className="shrink-0">
              <div className="text-[0.75em] uppercase tracking-wider text-slate-400">Pendências</div>
              <div className="text-[1.1em] font-bold">
                {data.issues.open} abertas
                {data.issues.overdue > 0 && <span className="text-red-400"> · {data.issues.overdue} atrasadas</span>}
                {data.issues.safety > 0 && <span className="text-amber-300"> · {data.issues.safety} de segurança</span>}
              </div>
            </div>
            <div className="flex w-full min-w-0 flex-wrap gap-2 lg:w-auto lg:flex-1 lg:max-h-[4.6em] lg:overflow-hidden">
              {data.issues.areas.map((a) => (
                <span key={a.name} className={`flex items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-[0.85em] ${a.overdue ? 'border-red-500/50 bg-red-500/10' : 'border-white/10 bg-white/5'}`}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.color ?? '#94a3b8' }} />
                  <span className="font-semibold">{a.name}</span>
                  <span className="tabular-nums text-slate-300">{a.open}</span>
                  {a.overdue > 0 && <span className="font-bold tabular-nums text-red-300">{a.overdue} atras.</span>}
                </span>
              ))}
              {data.issues.areas.length === 0 && <span className="text-[0.9em] text-emerald-300">Nenhuma pendência aberta.</span>}
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

const TONES = {
  red: 'border-red-500/60 bg-red-500/15 text-red-200',
  amber: 'border-amber-400/50 bg-amber-400/10 text-amber-200',
  green: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  blue: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  violet: 'border-violet-500/50 bg-violet-500/15 text-violet-200',
  plain: 'border-white/10 bg-white/5 text-slate-200',
};
function Kpi({ label, value, sub, tone }: { label: string; value: number | string; sub?: string; tone: keyof typeof TONES }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${TONES[tone]}`}>
      <div className="text-[0.8em] font-medium uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-[2.4em] font-bold leading-none tabular-nums text-white">{value}</div>
      <div className="mt-1 h-[1.2em] truncate text-[0.8em] opacity-80">{sub ?? ''}</div>
    </div>
  );
}

function Panel({ title, count, icon, className = '', children }: { title: string; count?: number; icon?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col rounded-xl border border-white/10 bg-[#111a2e] p-3 ${className}`}>
      <h2 className="mb-2 flex items-center gap-2 text-[0.85em] font-semibold uppercase tracking-wider text-slate-400">
        {icon}{title}{count != null && <span className="rounded-full bg-white/10 px-2 text-slate-200">{count}</span>}
      </h2>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

const STATE = {
  parada: 'border-red-500 bg-red-600/90 text-white shadow-[0_0_18px_rgba(239,68,68,.45)]',
  setup: 'border-violet-400 bg-violet-600/35 text-violet-50',
  atencao: 'border-amber-400 bg-amber-400/15 text-amber-100',
  ok: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-100',
};
function PlaceGrid({ title, places, now }: { title: string; places: Place[]; now: number }) {
  if (!places.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-[#111a2e] p-3">
      <h2 className="mb-2 text-[0.85em] font-semibold uppercase tracking-wider text-slate-400">
        {title} <span className="normal-case text-slate-500">· {places.filter((p) => p.state === 'ok').length} de {places.length} sem ordem aberta{places.some((p) => p.state === 'setup') ? ` · ${places.filter((p) => p.state === 'setup').length} em setup` : ''}</span>
      </h2>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(6.4em, 1fr))' }}>
        {places.map((p) => {
          const o = p.orders.find((x) => x.stopped) ?? p.orders[0];
          return (
            <div key={p.code} className={`flex min-h-[3.9em] flex-col justify-between rounded-lg border-2 px-2 py-1 ${STATE[p.state]} ${p.state === 'parada' ? 'animate-[pulse_2.5s_ease-in-out_infinite]' : ''}`}
              title={p.description ?? p.code}>
              <div className={`truncate font-bold leading-tight ${p.code.length > 8 ? 'text-[0.8em]' : 'text-[1.05em]'}`}>{p.code}</div>
              {p.state === 'setup' && p.setup ? (
                <div className="text-[0.75em] leading-tight">
                  <div className="truncate font-semibold">{p.setup.status === 'Aguardando Produção' ? 'AG. PRODUÇÃO' : `SETUP ${since(p.since, now).replace(' h ', 'h').replace(' min', 'min').replace(' d ', 'd')}`}</div>
                  <div className="truncate opacity-90">{p.setup.status === 'Aguardando Produção' ? `há ${since(p.since, now)}` : p.setup.pn ?? p.setup.user ?? 'em setup'}</div>
                </div>
              ) : o ? (
                <div className="text-[0.75em] leading-tight">
                  <div className="truncate font-semibold">{p.state === 'parada' ? `PARADA ${since(p.since, now).replace(" h ", "h").replace(" min", "min").replace(" d ", "d")}` : `${WO_DOMAIN[o.domain].short} aberta`}</div>
                  <div className="truncate opacity-90">
                    {o.status === 'aberta' ? 'sem aceite' : o.status === 'pausada' ? 'pausada' : o.workers.join(', ') || 'em atendimento'}
                  </div>
                </div>
              ) : (
                <div className="text-[0.75em] opacity-60">sem ordem</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Legend({ setup }: { setup: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 text-[0.8em] text-slate-400">
      <span className="flex items-center gap-2"><span className="h-3 w-3 rounded bg-red-600" />Máquina parada com ordem aberta</span>
      {setup && <span className="flex items-center gap-2"><span className="h-3 w-3 rounded bg-violet-500" />Em setup (Controle de Setup)</span>}
      <span className="flex items-center gap-2"><span className="h-3 w-3 rounded border-2 border-amber-400" />Ordem aberta, máquina rodando</span>
      <span className="flex items-center gap-2"><span className="h-3 w-3 rounded border-2 border-emerald-600/60" />Sem ordem aberta</span>
    </div>
  );
}

/**
 * The list scrolls (mouse wheel, touch, scroll bar). On a TV nobody scrolls, so while nobody touches it the list moves
 * one screen down by itself every 10 s and goes back to the top at the end.
 */
function Queue({ items, now }: { items: QueueItem[]; now: number }) {
  const list = useRef<HTMLUListElement>(null);
  const touched = useRef(0);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const check = () => setMore(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mark = () => { touched.current = Date.now(); };
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('touchstart', mark, { passive: true });
    el.addEventListener('pointerdown', mark);
    el.addEventListener('keydown', mark);
    const t = window.setInterval(() => {
      if (Date.now() - touched.current < 30_000 || el.scrollHeight <= el.clientHeight + 2) return;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      el.scrollTo({ top: atEnd ? 0 : el.scrollTop + el.clientHeight - 24, behavior: 'smooth' });
    }, 10_000);
    return () => {
      ro.disconnect(); clearInterval(t);
      el.removeEventListener('wheel', mark); el.removeEventListener('touchstart', mark);
      el.removeEventListener('pointerdown', mark); el.removeEventListener('keydown', mark);
    };
  }, []);
  useEffect(() => { const el = list.current; if (el) setMore(el.scrollHeight > el.clientHeight + 2); }, [items.length]);
  const shown = items;
  return (
    <div className="flex h-full flex-col">
      <ul ref={list} tabIndex={0} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 outline-none [scrollbar-color:rgba(255,255,255,.25)_transparent] [scrollbar-width:thin]">
        {shown.map((o) => {
          const waiting = o.status === 'aberta';
          return (
            <li key={o.id} className={`rounded-lg border-l-4 bg-white/5 px-3 py-2 ${o.stopped ? 'border-red-500' : waiting ? 'border-amber-400' : 'border-sky-400'}`}>
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="text-[1.05em] font-bold">{o.place}</span>
                {o.stopped && <span className="rounded bg-red-600 px-1.5 text-[0.7em] font-bold uppercase">parada</span>}
                <span className="text-[0.8em] text-slate-400">{o.code}</span>
                <span className={`ml-auto flex items-center gap-1 text-[0.95em] font-bold tabular-nums ${waiting && o.stopped ? 'text-red-300' : waiting ? 'text-amber-300' : 'text-slate-200'}`}>
                  <Clock className="h-3.5 w-3.5" />{since(o.openedAt, now)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[0.82em]">
                {waiting ? (
                  <span className="flex items-center gap-1 font-semibold text-amber-300"><AlertTriangle className="h-3.5 w-3.5" />Aguardando aceite</span>
                ) : o.status === 'pausada' ? (
                  <span className="flex min-w-0 items-center gap-1 text-slate-300"><PauseCircle className="h-3.5 w-3.5 shrink-0" /><span className="truncate">Pausada{o.pauseReason ? `: ${o.pauseReason}` : ''}</span></span>
                ) : (
                  <span className="flex min-w-0 items-center gap-1 text-sky-200"><Wrench className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{o.workers.join(', ') || 'Em atendimento'}</span></span>
                )}
                <span className="ml-auto shrink-0 text-slate-400">{o.category}</span>
              </div>
              <div className="truncate text-[0.8em] text-slate-400">{o.description}</div>
            </li>
          );
        })}
      </ul>
      {more && <div className="mt-1 text-center text-[0.75em] text-slate-500">role a lista para ver todas · na TV ela desce sozinha</div>}
    </div>
  );
}
