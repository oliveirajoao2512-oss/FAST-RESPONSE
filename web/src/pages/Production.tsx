import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock, Download, Factory, HelpCircle, Info, Pencil, Save, Upload } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import {
  CHECK_STATUS, PRODUCTION_TOLERANCE_MIN, checkProduction, machineKey, type CheckStatus, type StopSource,
} from '@shared/production';
import { normalizePn } from '@shared/maintenance';
import { shiftOf } from '@shared/shifts';
import { errorMessage, get, patch, post, put, qs } from '../lib/api';
import { tz } from '../lib/format';
import { Button, Card, cx, Empty, ErrorBox, Field, Input, Modal, Segmented, Select, Spinner, Textarea } from '../components/ui';

/**
 * Produção (stage 1, João 27/11/2026): the leader reports pieces per machine and period, and the conferência shows
 * whether the stops already registered (OS, OA with the machine stopped, setups) explain what was not produced.
 */

interface Standard { machine: string; pn: string; cycleSeconds: number; cavities: number; source: 'manual' | 'controle_ciclo' | 'planilha_pcp'; updatedAt: string; description: string | null }
interface Options {
  machines: string[]; standards: Standard[]; shifts: any[]; timezone: string; canEditStandards: boolean;
  last: { machine: string; pn: string; periodEnd: string }[];
}
interface Stop { source: StopSource; sourceLabel: string; ref: string; label: string; start: string; end: string; minutes: number; overlapMinutes: number }
interface Entry {
  id: string; machine: string; pn: string; shift: string | null; start: string; end: string; leader: string; note: string | null;
  cycleSeconds: number | null; cavities: number | null; standardFrom: 'maquina' | 'outra_maquina' | 'atual' | null; standardMachine: string | null;
  reason: string | null; reasonBy: string | null; reasonAt: string | null; message: string | null; canEdit: boolean;
  status: CheckStatus; periodMin: number; breakMin: number; plannedMin: number; ratePerHour: number | null; expected: number | null; quantity: number;
  lossPieces: number | null; lossMin: number | null; stopMin: number; justifiedMin: number | null; unjustifiedMin: number | null;
  unjustifiedPieces: number | null; aboveStandard: boolean; stopsExceedLoss: boolean; stops: Stop[];
}
interface Conference {
  from: string; to: string; setup: { ok: boolean; error: string | null } | null;
  totals: { entries: number; expected: number; quantity: number; lossMin: number; stopMin: number; justifiedMin: number; unjustifiedMin: number; unjustifiedPieces: number; byStatus: Record<CheckStatus, number>; pendingReason: number };
  entries: Entry[];
}

const zone = () => tz();
const hm = (d: string) => DateTime.fromISO(d, { zone: zone() }).toFormat('HH:mm');
const dm = (d: string) => DateTime.fromISO(d, { zone: zone() }).toFormat('dd/MM');
const n0 = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('pt-BR'));
const min = (m: number | null | undefined) => {
  if (m == null) return '—';
  const r = Math.round(m);
  return r < 60 ? `${r} min` : `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, '0')}`;
};
const cycleText = (s: { cycleSeconds: number; cavities: number }) =>
  `${String(s.cycleSeconds).replace('.', ',')} s${s.cavities > 1 ? ` · ${s.cavities} cavidades` : ''} · ${Math.round((3600 / s.cycleSeconds) * s.cavities)} pç/h`;

const TONE: Record<'gray' | 'green' | 'blue' | 'red', string> = {
  gray: 'bg-gray-100 text-gray-700 ring-gray-300',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  blue: 'bg-sky-50 text-sky-800 ring-sky-300',
  red: 'bg-red-50 text-red-800 ring-red-300',
};
function StatusTag({ s }: { s: CheckStatus }) {
  const c = CHECK_STATUS[s];
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1', TONE[c.tone])}>{c.label}</span>;
}

export function ProductionPage() {
  const opts = useQuery<Options>({ queryKey: ['producao', 'opcoes'], queryFn: () => get('/api/producao/opcoes') });
  const [day, setDay] = useState(() => DateTime.now().setZone(zone()).toISODate()!);
  if (opts.isLoading) return <Spinner />;
  if (opts.error) return <ErrorBox error={opts.error} onRetry={() => opts.refetch()} />;
  const o = opts.data!;
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900"><Factory className="h-5 w-5 text-brand-600" />Produção</h1>
          <p className="text-sm text-gray-500">A cada hora, as máquinas e os PNs já vêm do planejamento do PCP e dos setups: o líder só digita as peças. O sistema compara com a meta e com as paradas já registradas (OS, OA e setup).</p>
        </div>
      </header>
      <HourRound o={o} />
      <ManualReport o={o} onSaved={(d) => setDay(d)} />
      <ConferenceView day={day} setDay={setDay} machines={o.machines} options={o} />
      <StandardsSection o={o} />
    </div>
  );
}

/* ------------------------------------------------------------------ apontar */

interface FormState { machine: string; pn: string; date: string; from: string; to: string; quantity: string; breakMin: string; note: string }

function suggestPeriod(o: Options, machine: string): Pick<FormState, 'date' | 'from' | 'to'> {
  const now = DateTime.now().setZone(zone());
  const end = now.minute < 10 ? now.startOf('hour') : now.set({ second: 0, millisecond: 0 }).set({ minute: now.minute - (now.minute % 5) });
  const last = o.last.find((l) => machineKey(l.machine) === machineKey(machine));
  let start = end.minus({ hours: 1 }).startOf('hour');
  if (last) {
    const le = DateTime.fromISO(last.periodEnd, { zone: zone() });
    if (le < end && end.diff(le, 'hours').hours <= 12) start = le;
  }
  return { date: start.toISODate()!, from: start.toFormat('HH:mm'), to: end.toFormat('HH:mm') };
}

/** the period in absolute time; an end before the start means it crossed midnight (3º turno) */
function periodOf(f: Pick<FormState, 'date' | 'from' | 'to'>) {
  if (!f.date || !/^\d\d:\d\d$/.test(f.from) || !/^\d\d:\d\d$/.test(f.to)) return null;
  const a = DateTime.fromISO(`${f.date}T${f.from}`, { zone: zone() });
  let b = DateTime.fromISO(`${f.date}T${f.to}`, { zone: zone() });
  if (b <= a) b = b.plus({ days: 1 });
  return { start: a, end: b };
}

/** reporting outside the hour round: a machine that is not in the plan, or another period */
function ManualReport({ o, onSaved }: { o: Options; onSaved: (day: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex w-full items-center justify-between rounded-xl border border-dashed border-gray-300 bg-white px-4 py-3 text-left text-sm text-gray-600 hover:border-brand-400">
        <span><b className="text-gray-800">Apontamento avulso</b> · máquina fora do planejamento ou outro horário</span><ChevronDown className="h-4 w-4" />
      </button>
    );
  }
  return <ReportForm o={o} onSaved={onSaved} onClose={() => setOpen(false)} />;
}

function ReportForm({ o, onSaved, onClose }: { o: Options; onSaved: (day: string) => void; onClose?: () => void }) {
  const qc = useQueryClient();
  const blank = (machine = ''): FormState => ({ machine, pn: '', ...suggestPeriod(o, machine), quantity: '', breakMin: '', note: '' });
  const [f, setF] = useState<FormState>(() => blank());
  const [saved, setSaved] = useState<string | null>(null);
  const set = (p: Partial<FormState>) => { setSaved(null); setF((x) => ({ ...x, ...p })); };

  const pickMachine = (machine: string) => {
    const last = o.last.find((l) => machineKey(l.machine) === machineKey(machine));
    const forMachine = o.standards.filter((s) => machineKey(s.machine) === machineKey(machine));
    set({ machine, ...suggestPeriod(o, machine), pn: last?.pn ?? (forMachine.length === 1 ? forMachine[0].pn : '') });
  };
  const pn = normalizePn(f.pn) ?? '';
  const std = useMemo(() => {
    const same = o.standards.find((s) => machineKey(s.machine) === machineKey(f.machine) && s.pn === pn);
    return same ? { ...same, other: false } : (() => { const x = o.standards.find((s) => s.pn === pn); return x ? { ...x, other: true } : null; })();
  }, [o.standards, f.machine, pn]);
  const pnOptions = useMemo(() => {
    const mine = o.standards.filter((s) => machineKey(s.machine) === machineKey(f.machine));
    const rest = o.standards.filter((s) => machineKey(s.machine) !== machineKey(f.machine));
    return [...mine, ...rest].filter((s, i, a) => a.findIndex((x) => x.pn === s.pn) === i);
  }, [o.standards, f.machine]);
  const period = periodOf(f);
  const qty = f.quantity === '' ? null : Number(f.quantity);
  const preview = period && std
    ? checkProduction({ start: period.start.toMillis(), end: period.end.toMillis(), quantity: qty ?? 0, cycleSeconds: std.cycleSeconds, cavities: std.cavities, breakMin: Number(f.breakMin) || 0, stops: [] })
    : null;
  const shift = period ? shiftOf(period.start.toJSDate(), o.shifts, zone()) : null;

  const save = useMutation({
    mutationFn: () => post('/api/producao/apontamentos', {
      machine: f.machine, pn: f.pn, start: period!.start.toISO(), end: period!.end.toISO(), quantity: qty, breakMinutes: Number(f.breakMin) || 0, note: f.note || null,
    }),
    onSuccess: () => {
      setSaved(`Máquina ${f.machine}: ${qty} peças de ${f.from} a ${f.to} salvas.`);
      onSaved(f.date);
      qc.invalidateQueries({ queryKey: ['producao'] });
      setF((x) => ({ ...x, quantity: '', breakMin: '', note: '' }));
    },
  });
  // after saving, the next period of the same machine starts where this one ended
  useEffect(() => { if (f.machine && saved) setF((x) => ({ ...x, ...suggestPeriod(o, x.machine) })); }, [o]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = f.machine && pn && period && qty != null && Number.isInteger(qty) && qty >= 0;
  return (
    <Card title="Apontamento avulso" actions={onClose && <Button size="sm" kind="ghost" onClick={onClose}>Fechar</Button>}>
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-sm font-medium text-gray-700">Máquina</div>
          <div className="flex flex-wrap gap-1.5">
            {o.machines.map((m) => (
              <button key={m} onClick={() => pickMachine(m)}
                className={cx('min-w-[3rem] rounded-lg border px-2.5 py-2 text-sm font-semibold', f.machine === m ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 bg-white text-gray-800 hover:border-brand-400')}>
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_0.7fr_0.7fr_1fr]">
          <Field label="PN produzido" required hint={std ? `Ciclo padrão ${cycleText(std)}${std.other ? ` (da máquina ${std.machine})` : ''}` : pn ? 'Sem ciclo padrão: a meta não será calculada' : undefined}>
            <Input list="pn-producao" value={f.pn} onChange={(e) => set({ pn: e.target.value })} placeholder="Ex.: 10001054733" autoComplete="off" />
            <datalist id="pn-producao">
              {pnOptions.map((s) => <option key={s.pn} value={s.pn}>{s.description ?? ''}</option>)}
            </datalist>
          </Field>
          <Field label="Data" required><Input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
          <Field label="De" required><Input type="time" value={f.from} onChange={(e) => set({ from: e.target.value })} /></Field>
          <Field label="Até" required><Input type="time" value={f.to} onChange={(e) => set({ to: e.target.value })} /></Field>
          <Field label="Peças produzidas" required>
            <Input type="number" inputMode="numeric" min={0} step={1} value={f.quantity} onChange={(e) => set({ quantity: e.target.value })} className="text-lg font-semibold" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600">
          {period && <span>{period.end.diff(period.start, 'minutes').minutes} min{Number(f.breakMin) > 0 ? ` − ${Number(f.breakMin)} min de refeição` : ''}{shift ? ` · ${shift}` : ''}{period.end.day !== period.start.day ? ' · passa da meia-noite' : ''}</span>}
          {preview && <span>Meta do período: <b className="text-gray-900">{n0(preview.expected)} peças</b></span>}
          {preview && qty != null && preview.lossMin! > PRODUCTION_TOLERANCE_MIN && (
            <span className="text-amber-700">Faltam {n0(preview.lossPieces)} peças ({min(preview.lossMin)}). A conferência vai procurar paradas registradas.</span>
          )}
          {preview && qty != null && preview.aboveStandard && <span className="text-amber-700">Acima do que o ciclo permite: confira o período e a quantidade.</span>}
        </div>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Pausa de refeição (min)" hint="Se a máquina parou para o almoço nesse período">
          <Input type="number" inputMode="numeric" min={0} step={5} value={f.breakMin} onChange={(e) => set({ breakMin: e.target.value })} placeholder="0" />
        </Field>
        <Field label="Observação (opcional)"><Input value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={500} placeholder="Ex.: troca de bobina de embalagem" /></Field>
        </div>
        {save.error && <p className="text-sm text-red-700">{errorMessage(save.error)}</p>}
        {saved && <p className="flex items-center gap-1.5 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />{saved}</p>}
        <div className="flex justify-end">
          <Button kind="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}><Save className="h-4 w-4" />Salvar apontamento</Button>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ conferência */

function ConferenceView({ day, setDay, machines, options }: { day: string; setDay: (d: string) => void; machines: string[]; options: Options }) {
  const [machine, setMachine] = useState('');
  const [status, setStatus] = useState<'' | CheckStatus>('');
  const query = useQuery<Conference>({
    queryKey: ['producao', 'conferencia', day, machine],
    queryFn: () => get(`/api/producao/conferencia${qs({ from: day, to: day, machine: machine || undefined })}`),
  });
  const d = query.data;
  const list = d?.entries.filter((e) => !status || e.status === status) ?? [];
  return (
    <Card title="Conferência: produção × paradas registradas"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-40"><Input type="date" aria-label="Dia" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></div>
          <div className="w-44"><Select aria-label="Máquina" value={machine} onChange={(e) => setMachine(e.target.value)}>
            <option value="">Todas as máquinas</option>
            {machines.map((m) => <option key={m} value={m}>Máquina {m}</option>)}
          </Select></div>
        </div>
      }>
      {query.isLoading ? <Spinner /> : query.error ? <ErrorBox error={query.error} onRetry={() => query.refetch()} /> : d && (
        <div className="space-y-4">
          {d.setup && !d.setup.ok && (
            <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"><AlertTriangle className="h-4 w-4" />O Controle de Setup não respondeu: os setups não entraram nesta conferência.</p>
          )}
          <Totals t={d.totals} />
          {d.entries.length > 0 && (
            <Segmented<'' | CheckStatus> value={status} onChange={setStatus} options={[
              { value: '', label: `Todos ${d.entries.length}` },
              { value: 'divergencia', label: `Não justificado ${d.totals.byStatus.divergencia}` },
              { value: 'justificada', label: `Justificado ${d.totals.byStatus.justificada}` },
              { value: 'meta', label: `Na meta ${d.totals.byStatus.meta}` },
              ...(d.totals.byStatus.sem_padrao ? [{ value: 'sem_padrao' as const, label: `Sem ciclo ${d.totals.byStatus.sem_padrao}` }] : []),
            ]} />
          )}
          {list.length === 0 ? <Empty>Nenhum apontamento {status ? 'nesse filtro ' : ''}em {DateTime.fromISO(day).toFormat('dd/MM/yyyy')}.</Empty> : (
            <ul className="space-y-3">{list.map((e) => <EntryCard key={e.id} e={e} options={options} />)}</ul>
          )}
        </div>
      )}
    </Card>
  );
}

function Totals({ t }: { t: Conference['totals'] }) {
  if (!t.entries) return null;
  const pct = t.expected ? Math.round((t.quantity / t.expected) * 100) : null;
  const items: [string, string, string?][] = [
    ['Deveria produzir', `${n0(t.expected)} pç`],
    ['Produziu', `${n0(t.quantity)} pç`, pct != null ? `${pct}% da meta` : undefined],
    ['Tempo de perda', min(t.lossMin)],
    ['Paradas registradas', min(t.stopMin)],
    ['Justificado', min(t.justifiedMin)],
    ['Sem justificativa', min(t.unjustifiedMin), t.unjustifiedPieces ? `${n0(t.unjustifiedPieces)} peças` : undefined],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([label, value, sub], i) => (
        <div key={label} className={cx('rounded-lg border px-3 py-2', i === 5 && t.unjustifiedMin > 0 ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50')}>
          <div className="text-xs text-gray-500">{label}</div>
          <div className={cx('text-lg font-bold tabular', i === 5 && t.unjustifiedMin > 0 ? 'text-red-700' : 'text-gray-900')}>{value}</div>
          <div className="h-4 text-xs text-gray-500">{sub ?? ''}</div>
        </div>
      ))}
    </div>
  );
}

/** the period as a bar: produced, loss explained by stops, loss without explanation */
function PeriodBar({ e }: { e: Entry }) {
  if (e.expected == null || !e.periodMin) return null;
  const lossMin = e.lossMin ?? 0;
  const prodMin = Math.max(0, e.plannedMin - lossMin);
  const seg = (m: number) => `${(m / e.periodMin) * 100}%`;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-gray-100" aria-hidden>
        {prodMin >= 0.5 && <div className="bg-emerald-500" style={{ width: seg(prodMin) }} />}
        {(e.justifiedMin ?? 0) >= 0.5 && <div className="border-l-2 border-white bg-sky-400" style={{ width: seg(e.justifiedMin ?? 0) }} />}
        {(e.unjustifiedMin ?? 0) >= 0.5 && <div className="border-l-2 border-white bg-red-500" style={{ width: seg(e.unjustifiedMin ?? 0) }} />}
        {e.breakMin >= 0.5 && <div className="border-l-2 border-white bg-gray-300" style={{ width: seg(e.breakMin) }} />}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-gray-600">
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500" />Produzindo {min(prodMin)}</span>
        {(e.justifiedMin ?? 0) >= 0.5 && <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-sky-400" />Parada registrada {min(e.justifiedMin)}</span>}
        {(e.unjustifiedMin ?? 0) >= 0.5 && <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-red-500" />Sem justificativa {min(e.unjustifiedMin)}</span>}
        {e.breakMin >= 0.5 && <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-gray-300" />Refeição {min(e.breakMin)}</span>}
      </div>
    </div>
  );
}

function EntryCard({ e, options, compact }: { e: Entry; options: Options; compact?: boolean }) {
  const [open, setOpen] = useState(e.status === 'divergencia' && (!compact || !e.reason));
  const [editing, setEditing] = useState(false);
  return (
    <li className={cx('rounded-xl border bg-white', e.status === 'divergencia' && !e.reason ? 'border-red-300' : 'border-gray-200')}>
      <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="text-base font-bold text-gray-900">Máq. {e.machine}</span>
        <span className="text-sm text-gray-700">PN {e.pn}</span>
        <span className="flex items-center gap-1 text-sm text-gray-500"><Clock className="h-3.5 w-3.5" />{hm(e.start)}–{hm(e.end)}{e.shift ? ` · ${e.shift}` : ''}</span>
        <span className="text-sm text-gray-500">{e.leader}</span>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-sm tabular text-gray-700"><b className="text-gray-900">{n0(e.quantity)}</b> / {n0(e.expected)} pç</span>
          {e.aboveStandard && <span className="whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-300" title="Produção acima do que o ciclo padrão permite">acima do ciclo</span>}
          <StatusTag s={e.status} />
          <ChevronDown className={cx('h-4 w-4 text-gray-400 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-gray-100 px-4 py-3">
          {e.message && (
            <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{e.message}</p>
          )}
          <PeriodBar e={e} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <Item k="Ciclo padrão" v={e.cycleSeconds ? cycleText({ cycleSeconds: e.cycleSeconds, cavities: e.cavities ?? 1 }) : 'não cadastrado'}
              hint={e.standardFrom === 'outra_maquina' ? `ciclo da máquina ${e.standardMachine}` : e.standardFrom === 'atual' ? 'cadastrado depois do apontamento' : undefined} />
            <Item k="Deveria produzir" v={`${n0(e.expected)} pç em ${min(e.plannedMin)}`} hint={e.breakMin > 0 ? `período ${min(e.periodMin)} − refeição ${min(e.breakMin)}` : undefined} />
            <Item k="Produziu" v={`${n0(e.quantity)} pç`} hint={e.lossPieces ? `faltaram ${n0(e.lossPieces)} pç = ${min(e.lossMin)}` : undefined} />
            <Item k="Paradas registradas" v={min(e.stopMin)} hint={e.stops.some((s) => s.overlapMinutes > 0) ? 'sobreposição contada uma vez' : undefined} />
            <Item k="Justificado" v={min(e.justifiedMin)} />
            <Item k="Sem justificativa" v={min(e.unjustifiedMin)} hint={e.unjustifiedPieces ? `${n0(e.unjustifiedPieces)} peças` : undefined} strong={(e.unjustifiedMin ?? 0) > PRODUCTION_TOLERANCE_MIN} />
          </dl>
          {e.stopsExceedLoss && (
            <p className="flex items-start gap-2 text-sm text-amber-800"><Info className="mt-0.5 h-4 w-4 shrink-0" />As paradas registradas somam mais do que a perda: alguma ordem pode ter ficado aberta depois de a máquina voltar a produzir.</p>
          )}
          {e.aboveStandard && (
            <p className="flex items-start gap-2 text-sm text-amber-800"><Info className="mt-0.5 h-4 w-4 shrink-0" />Produção acima do que o ciclo padrão permite: confira o ciclo, as cavidades ou o período.</p>
          )}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Paradas encontradas no período</div>
            {e.stops.length === 0 ? <p className="text-sm text-gray-500">Nenhuma OS, OA ou setup com a máquina parada nesse horário.</p> : (
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 text-sm">
                {e.stops.map((s) => (
                  <li key={s.source + s.ref} className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5">
                    <span className={cx('rounded px-1.5 text-xs font-semibold', s.source === 'setup' ? 'bg-violet-100 text-violet-800' : s.source === 'ajuste' ? 'bg-orange-100 text-orange-800' : 'bg-blue-100 text-blue-800')}>{s.sourceLabel}</span>
                    <span className="min-w-0 flex-1 break-words text-gray-800">{s.label}</span>
                    <span className="tabular text-gray-500">{dm(s.start)} {hm(s.start)}–{hm(s.end)}</span>
                    <span className="tabular font-semibold text-gray-900">{min(s.minutes)} no período{s.overlapMinutes > 0 ? ` (${min(s.overlapMinutes)} simultâneos)` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {e.note && <p className="text-sm text-gray-600"><b>Observação:</b> {e.note}</p>}
          {(e.status === 'divergencia' || e.reason) && <ReasonBox e={e} />}
          {e.canEdit && (
            <div className="flex justify-end">
              <Button size="sm" kind="ghost" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" />Corrigir apontamento</Button>
            </div>
          )}
        </div>
      )}
      {editing && <EditEntry e={e} options={options} onClose={() => setEditing(false)} />}
    </li>
  );
}

function Item({ k, v, hint, strong }: { k: string; v: string; hint?: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{k}</dt>
      <dd className={cx('font-semibold tabular', strong ? 'text-red-700' : 'text-gray-900')}>{v}</dd>
      {hint && <dd className="text-xs text-gray-500">{hint}</dd>}
    </div>
  );
}

function ReasonBox({ e }: { e: Entry }) {
  const qc = useQueryClient();
  const [text, setText] = useState(e.reason ?? '');
  const [edit, setEdit] = useState(!e.reason);
  const save = useMutation({
    mutationFn: () => post(`/api/producao/apontamentos/${e.id}/motivo`, { reason: text }),
    onSuccess: () => { setEdit(false); qc.invalidateQueries({ queryKey: ['producao', 'conferencia'] }); },
  });
  if (!edit) {
    return (
      <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Motivo informado pelo líder</span>
          <Button size="sm" kind="ghost" onClick={() => setEdit(true)}>Alterar</Button>
        </div>
        <p className="text-gray-900">{e.reason}</p>
        <p className="text-xs text-gray-500">{e.reasonBy}{e.reasonAt ? ` · ${DateTime.fromISO(e.reasonAt, { zone: zone() }).toFormat('dd/MM HH:mm')}` : ''}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/50 p-3">
      <label className="flex items-center gap-1.5 text-sm font-semibold text-gray-800"><HelpCircle className="h-4 w-4" />O que aconteceu nos {min(e.unjustifiedMin)} sem justificativa?</label>
      <Textarea value={text} onChange={(x) => setText(x.target.value)} placeholder="Ex.: falta de operador, aguardando embalagem, máquina parada sem OS aberta…" maxLength={1000} />
      {save.error && <p className="text-sm text-red-700">{errorMessage(save.error)}</p>}
      <div className="flex justify-end gap-2">
        {e.reason && <Button size="sm" onClick={() => { setText(e.reason ?? ''); setEdit(false); }}>Cancelar</Button>}
        <Button size="sm" kind="primary" disabled={text.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>Salvar motivo</Button>
      </div>
    </div>
  );
}

function EditEntry({ e, options, onClose }: { e: Entry; options: Options; onClose: () => void }) {
  const qc = useQueryClient();
  const s = DateTime.fromISO(e.start, { zone: zone() });
  const en = DateTime.fromISO(e.end, { zone: zone() });
  const [f, setF] = useState({ machine: e.machine, pn: e.pn, date: s.toISODate()!, from: s.toFormat('HH:mm'), to: en.toFormat('HH:mm'), quantity: String(e.quantity), breakMin: String(e.breakMin || ''), note: e.note ?? '' });
  const period = periodOf(f);
  const save = useMutation({
    mutationFn: () => patch(`/api/producao/apontamentos/${e.id}`, { machine: f.machine, pn: f.pn, start: period!.start.toISO(), end: period!.end.toISO(), quantity: Number(f.quantity), breakMinutes: Number(f.breakMin) || 0, note: f.note || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['producao'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={`Corrigir apontamento da máquina ${e.machine}`}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="primary" loading={save.isPending} disabled={!period || f.quantity === ''} onClick={() => save.mutate()}>Salvar correção</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Máquina"><Select value={f.machine} onChange={(x) => setF({ ...f, machine: x.target.value })}>{options.machines.map((m) => <option key={m}>{m}</option>)}</Select></Field>
        <Field label="PN"><Input value={f.pn} onChange={(x) => setF({ ...f, pn: x.target.value })} /></Field>
        <Field label="Data"><Input type="date" value={f.date} onChange={(x) => setF({ ...f, date: x.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="De"><Input type="time" value={f.from} onChange={(x) => setF({ ...f, from: x.target.value })} /></Field>
          <Field label="Até"><Input type="time" value={f.to} onChange={(x) => setF({ ...f, to: x.target.value })} /></Field>
        </div>
        <Field label="Peças produzidas"><Input type="number" min={0} value={f.quantity} onChange={(x) => setF({ ...f, quantity: x.target.value })} /></Field>
        <Field label="Pausa de refeição (min)"><Input type="number" min={0} value={f.breakMin} onChange={(x) => setF({ ...f, breakMin: x.target.value })} /></Field>
        <Field label="Observação" className="sm:col-span-2"><Input value={f.note} onChange={(x) => setF({ ...f, note: x.target.value })} /></Field>
      </div>
      <p className="mt-2 text-xs text-gray-500">O valor anterior fica guardado na auditoria.</p>
      {save.error && <p className="mt-2 text-sm text-red-700">{errorMessage(save.error)}</p>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ ciclos padrão */

function StandardsSection({ o }: { o: Options }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [pcp, setPcp] = useState(false);
  const [form, setForm] = useState({ machine: '', pn: '', cycleSeconds: '', cavities: '1' });
  const saveStd = useMutation({
    mutationFn: () => put('/api/producao/padroes', { machine: form.machine, pn: form.pn, cycleSeconds: Number(form.cycleSeconds.replace(',', '.')), cavities: Number(form.cavities) }),
    onSuccess: () => { setForm({ machine: form.machine, pn: '', cycleSeconds: '', cavities: '1' }); qc.invalidateQueries({ queryKey: ['producao'] }); },
  });
  const importCycle = useMutation({
    mutationFn: () => post<{ total: number; added: number; updated: number; kept: number; skipped: string[] }>('/api/producao/padroes/importar-ciclo'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['producao'] }),
  });
  const term = filter.trim().toUpperCase();
  const rows = o.standards.filter((s) => !term || s.pn.includes(term) || machineKey(s.machine) === machineKey(term) || (s.description ?? '').toUpperCase().includes(term));
  return (
    <>
    {pcp && <PcpImportModal onClose={() => setPcp(false)} />}
    <Card title={<button className="flex items-center gap-2" onClick={() => setOpen((v) => !v)}>Ciclos padrão por máquina e PN <span className="rounded-full bg-gray-100 px-2 text-xs text-gray-600">{o.standards.length}</span><ChevronDown className={cx('h-4 w-4 text-gray-400', open && 'rotate-180')} /></button>}
      actions={open && o.canEditStandards ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" kind="primary" onClick={() => setPcp(true)}><Upload className="h-3.5 w-3.5" />Importar planilha do PCP</Button>
          <Button size="sm" loading={importCycle.isPending} onClick={() => importCycle.mutate()}><Download className="h-3.5 w-3.5" />Trazer do Controle de Ciclo</Button>
        </div>
      ) : undefined}>
      {!open ? (
        <p className="text-sm text-gray-500">A meta usa o ciclo padrão do PN naquela máquina. Sem ciclo cadastrado, o apontamento é salvo, mas a meta não é calculada.</p>
      ) : (
        <div className="space-y-3">
          {importCycle.data && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Controle de Ciclo: {importCycle.data.total} produtos lidos · {importCycle.data.added} novos · {importCycle.data.updated} atualizados · {importCycle.data.kept} sem mudança.
              {importCycle.data.skipped.length > 0 && ` ${importCycle.data.skipped.length} ficaram de fora (máquina fora do cadastro ou sem ciclo): ${importCycle.data.skipped.slice(0, 8).join(', ')}${importCycle.data.skipped.length > 8 ? '…' : ''}`}
              {' '}Cavidades vêm como 1: ajuste onde a máquina faz mais de uma peça por ciclo.
            </p>
          )}
          {importCycle.error && <p className="text-sm text-red-700">{errorMessage(importCycle.error)}</p>}
          {o.canEditStandards && (
            <div className="grid items-end gap-2 sm:grid-cols-[0.8fr_1.4fr_0.8fr_0.6fr_auto]">
              <Field label="Máquina"><Select value={form.machine} onChange={(e) => setForm({ ...form, machine: e.target.value })}><option value="">—</option>{o.machines.map((m) => <option key={m}>{m}</option>)}</Select></Field>
              <Field label="PN"><Input value={form.pn} onChange={(e) => setForm({ ...form, pn: e.target.value })} /></Field>
              <Field label="Ciclo (s)"><Input inputMode="decimal" value={form.cycleSeconds} onChange={(e) => setForm({ ...form, cycleSeconds: e.target.value })} /></Field>
              <Field label="Cavidades"><Input type="number" min={1} max={64} value={form.cavities} onChange={(e) => setForm({ ...form, cavities: e.target.value })} /></Field>
              <Button kind="primary" loading={saveStd.isPending} disabled={!form.machine || !form.pn || !Number(form.cycleSeconds.replace(',', '.'))} onClick={() => saveStd.mutate()}>Salvar</Button>
            </div>
          )}
          {saveStd.error && <p className="text-sm text-red-700">{errorMessage(saveStd.error)}</p>}
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar por máquina, PN ou descrição" />
          {rows.length === 0 ? <Empty>Nenhum ciclo padrão {term ? 'nesse filtro' : 'cadastrado ainda'}.</Empty> : (
            <div className="max-h-96 overflow-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-left text-xs text-gray-500"><tr><th className="px-3 py-2">Máquina</th><th className="px-3 py-2">PN</th><th className="px-3 py-2">Ciclo</th><th className="px-3 py-2">Origem</th></tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((s) => (
                    <tr key={s.machine + s.pn} className={o.canEditStandards ? 'cursor-pointer hover:bg-gray-50' : ''}
                      onClick={() => o.canEditStandards && setForm({ machine: s.machine, pn: s.pn, cycleSeconds: String(s.cycleSeconds).replace('.', ','), cavities: String(s.cavities) })}>
                      <td className="px-3 py-1.5 font-semibold">{s.machine}</td>
                      <td className="px-3 py-1.5">{s.pn}{s.description && <span className="block text-xs text-gray-500">{s.description}</span>}</td>
                      <td className="px-3 py-1.5 tabular">{cycleText(s)}</td>
                      <td className="px-3 py-1.5 text-xs text-gray-500">{s.source === 'controle_ciclo' ? 'Controle de Ciclo' : s.source === 'planilha_pcp' ? 'Planilha do PCP' : 'digitado'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
    </>
  );
}

interface PcpPreview {
  sheets: string[]; total: number; added: number; updated: number; same: number; manual: number;
  outside: { machine: string; n: number }[];
  mismatches: { machine: string; pn: string; cycleSeconds: number; cavities: number; perHour: number }[];
  examples: { machine: string; pn: string; cycleSeconds: number; cavities: number; before: { cycleSeconds: number; cavities: number; source: string } | null }[];
}
/** standard cycles and cavities from the PCP spreadsheet "PLANEJAMENTO APONTAMENTO …": check first, then import */
function PcpImportModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PcpPreview | null>(null);
  const [done, setDone] = useState<PcpPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (commit: boolean) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    setBusy(true); setError(null);
    try {
      const r = await post<PcpPreview>(`/api/producao/padroes/importar-planilha?commit=${commit ? 1 : 0}`, fd);
      if (commit) { setDone(r); qc.invalidateQueries({ queryKey: ['producao'] }); } else setPreview(r);
    } catch (e) { setError(errorMessage(e)); setPreview(null); } finally { setBusy(false); }
  };
  const p = done ?? preview;
  return (
    <Modal open onClose={onClose} title="Importar ciclos da planilha do PCP" wide
      footer={done ? <Button kind="primary" onClick={onClose}>Fechar</Button> : <>
        <Button onClick={onClose}>Cancelar</Button>
        {preview ? <Button kind="primary" loading={busy} disabled={!preview.added && !preview.updated} onClick={() => send(true)}>Importar {preview.added + preview.updated}</Button>
          : <Button kind="primary" loading={busy} disabled={!file} onClick={() => send(false)}>Conferir planilha</Button>}
      </>}>
      <div className="space-y-3 text-sm">
        <p className="text-gray-600">Envie a planilha "PLANEJAMENTO APONTAMENTO" (.xlsm). São lidas as abas com máquina, part number, ciclo e cavidade (a base de produtos e o planejamento do dia; o planejamento vence, porque é a máquina usada de fato). Ciclo digitado à mão não é trocado. Nada é apagado.</p>
        {!done && <input type="file" accept=".xlsx,.xlsm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />}
        {error && <p className="text-red-700">{error}</p>}
        {p && (
          <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
            {done && <p className="flex items-center gap-1.5 font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" />Importado.</p>}
            <p><b>{p.total}</b> linhas de ciclo nas abas {p.sheets.join(' e ')}: <b>{p.added}</b> novos, <b>{p.updated}</b> com ciclo ou cavidade diferente, {p.same} iguais{p.manual ? `, ${p.manual} digitados à mão (mantidos)` : ''}.</p>
            {p.examples.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase text-gray-500">Mudanças (exemplos)</div>
                <ul className="text-xs">{p.examples.map((x) => (
                  <li key={x.machine + x.pn}>Máq. {x.machine} · {x.pn}: {x.before ? `${x.before.cycleSeconds} s × ${x.before.cavities}` : 'novo'} → <b>{x.cycleSeconds} s × {x.cavities}</b></li>
                ))}</ul>
              </div>
            )}
            {p.mismatches.length > 0 && (
              <p className="text-xs text-amber-800">Na planilha, "peças por hora" não bate com ciclo × cavidades em: {p.mismatches.map((m) => `${m.machine} PN ${m.pn} (${m.cycleSeconds} s × ${m.cavities} = ${Math.round((3600 / m.cycleSeconds) * m.cavities)}/h, planilha ${m.perHour}/h)`).join('; ')}. Usei ciclo × cavidades.</p>
            )}
            {p.outside.length > 0 && (
              <p className="text-xs text-gray-500">Fora das máquinas cadastradas (não entram): {p.outside.map((o) => `${o.machine} (${o.n})`).join(', ')}.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ rodada da hora */

interface RoundRow {
  machine: string; pn: string; source: 'plano' | 'setup'; op: string | null;
  setup: { status: string; startedAt: string; user: string | null } | null;
  cycleSeconds: number | null; cavities: number | null; perHour: number | null; entry: Entry | null;
}
interface Round {
  start: string; end: string; shift: { name: string; index: number; date: string } | null;
  plan: { date: string; uploadedAt: string; by: string; sameDay: boolean } | null;
  setup: { ok: boolean; error: string | null } | null;
  rows: RoundRow[]; extra: Entry[]; pending: number; isLatest: boolean;
}
const BREAKS = [0, 30, 60];
const rowKey = (r: { machine: string; pn: string }) => `${r.machine}|${r.pn}`;

function HourRound({ o }: { o: Options }) {
  const qc = useQueryClient();
  const [end, setEnd] = useState<string | null>(null);
  const [upload, setUpload] = useState(false);
  const [vals, setVals] = useState<Record<string, { qty: string; brk: number }>>({});
  const [result, setResult] = useState<{ saved: number; errors: { machine: string; pn: string; erro: string }[] } | null>(null);
  const round = useQuery<Round>({
    queryKey: ['producao', 'rodada', end],
    queryFn: () => get(`/api/producao/rodada${qs({ end: end ?? undefined })}`),
    refetchInterval: 60_000,
  });
  const d = round.data;
  const go = (hours: number) => {
    if (!d) return;
    setVals({}); setResult(null);
    setEnd(DateTime.fromISO(d.end, { zone: zone() }).plus({ hours }).toISO());
  };
  const filled = (d?.rows ?? []).filter((r) => !r.entry && (vals[rowKey(r)]?.qty ?? '') !== '');
  const save = useMutation({
    mutationFn: () => post<{ saved: number; errors: { machine: string; pn: string; erro: string }[] }>('/api/producao/rodada', {
      start: d!.start, end: d!.end,
      items: filled.map((r) => ({ machine: r.machine, pn: r.pn, quantity: Number(vals[rowKey(r)].qty), breakMinutes: vals[rowKey(r)].brk ?? 0 })),
    }),
    onSuccess: (r) => {
      setResult(r);
      // keep what failed on screen so the leader can fix it
      setVals((v) => Object.fromEntries(Object.entries(v).filter(([k]) => r.errors.some((x) => rowKey(x) === k))));
      qc.invalidateQueries({ queryKey: ['producao'] });
    },
  });
  const set = (r: RoundRow, p: Partial<{ qty: string; brk: number }>) =>
    setVals((v) => ({ ...v, [rowKey(r)]: { qty: v[rowKey(r)]?.qty ?? '', brk: v[rowKey(r)]?.brk ?? 0, ...p } }));

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-brand-600" />
          {d ? <>Hora {hm(d.start)}–{hm(d.end)}{d.shift ? ` · ${d.shift.name}` : ''}</> : 'Rodada da hora'}
        </span>
      }
      actions={
        <div className="flex items-center gap-1.5">
          <Button size="sm" onClick={() => go(-1)} disabled={!d} aria-label="Hora anterior"><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="sm" onClick={() => go(1)} disabled={!d || d.isLatest} aria-label="Próxima hora"><ChevronRight className="h-4 w-4" /></Button>
          <Button size="sm" onClick={() => setUpload(true)}><Upload className="h-3.5 w-3.5" />Planejamento do PCP</Button>
        </div>
      }>
      {upload && <PlanUploadModal onClose={() => setUpload(false)} />}
      {round.isLoading ? <Spinner /> : round.error ? <ErrorBox error={round.error} onRetry={() => round.refetch()} /> : d && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {!d.shift ? <span className="text-gray-500">Fora do horário dos turnos.</span>
              : d.plan ? (
                <span className={d.plan.sameDay ? 'text-gray-500' : 'text-amber-700'}>
                  {d.plan.sameDay ? 'Planejamento' : 'Sem planejamento deste dia: usando o'} de {DateTime.fromISO(d.plan.date).toFormat('dd/MM')}, enviado por {d.plan.by} às {DateTime.fromISO(d.plan.uploadedAt, { zone: zone() }).toFormat('dd/MM HH:mm')}
                </span>
              ) : <span className="flex items-center gap-1.5 text-amber-700"><AlertTriangle className="h-4 w-4" />Nenhum planejamento enviado. Suba a planilha do PCP para as máquinas virem preenchidas.</span>}
            {d.setup && !d.setup.ok && <span className="text-amber-700">Controle de Setup sem resposta: PNs só do planejamento.</span>}
            {d.rows.length > 0 && <span className="ml-auto text-gray-600">{d.rows.length - d.pending} de {d.rows.length} apontadas</span>}
          </div>

          {d.rows.length > 0 && (
            <ul className="space-y-2">
              {d.rows.map((r) => r.entry ? (
                <EntryCard key={rowKey(r)} e={r.entry} options={o} compact />
              ) : (
                <li key={rowKey(r)} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-gray-200 px-3 py-2.5">
                  <div className="min-w-[9rem] flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-base font-bold text-gray-900">Máq. {r.machine}</span>
                      <span className="text-sm text-gray-700">{r.pn}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-2 text-xs text-gray-500">
                      {r.perHour != null ? <span>meta {n0(r.perHour)} pç/h</span> : <span className="text-amber-700">sem ciclo padrão</span>}
                      {r.source === 'setup' && <span className="rounded bg-violet-100 px-1 font-semibold text-violet-800">PN do último setup</span>}
                      {r.setup && r.setup.status !== 'Finalizado' && <span className="rounded bg-violet-100 px-1 font-semibold text-violet-800">em setup desde {hm(r.setup.startedAt)}</span>}
                      {r.op && <span>OP {r.op}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1" role="group" aria-label={`Refeição na máquina ${r.machine}`}>
                    <span className="mr-1 text-xs text-gray-500">refeição</span>
                    {BREAKS.map((b) => (
                      <button key={b} onClick={() => set(r, { brk: b })}
                        className={cx('rounded-md border px-2 py-1 text-xs font-semibold', (vals[rowKey(r)]?.brk ?? 0) === b ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-700')}>
                        {b === 0 ? 'não' : `${b} min`}
                      </button>
                    ))}
                  </div>
                  <Input type="number" inputMode="numeric" min={0} aria-label={`Peças da máquina ${r.machine} PN ${r.pn}`} placeholder="peças"
                    value={vals[rowKey(r)]?.qty ?? ''} onChange={(e) => set(r, { qty: e.target.value })} className="!w-28 text-lg font-semibold" />
                </li>
              ))}
            </ul>
          )}

          {save.error && <p className="text-sm text-red-700">{errorMessage(save.error)}</p>}
          {result && result.errors.length > 0 && (
            <ul className="space-y-0.5 text-sm text-red-700">{result.errors.map((x) => <li key={x.machine + x.pn}>Máq. {x.machine} · {x.pn}: {x.erro}</li>)}</ul>
          )}
          {result && result.saved > 0 && (
            <p className="flex items-center gap-1.5 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />{result.saved} apontamento(s) salvos. O resultado de cada máquina está na lista acima.</p>
          )}
          {d.rows.some((r) => !r.entry) && (
            <div className="flex justify-end">
              <Button kind="primary" disabled={!filled.length} loading={save.isPending} onClick={() => save.mutate()}>
                <Save className="h-4 w-4" />{filled.length ? `Salvar ${filled.length} máquina${filled.length > 1 ? 's' : ''}` : 'Digite as peças'}
              </Button>
            </div>
          )}

          {d.extra.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Outros apontamentos desta hora</div>
              <ul className="space-y-2">{d.extra.map((e) => <EntryCard key={e.id} e={e} options={o} compact />)}</ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

interface PlanPreview {
  date: string; fileName: string; machinesPerShift: number[];
  running: { machine: string; pn: string; shifts: number[] }[]; stopped: string[]; outside: string[];
  cycles: { added: number; updated: number; same: number; manual: number; mismatches: { machine: string; pn: string }[] };
}
function PlanUploadModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState('');
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (commit: boolean) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    setBusy(true); setError(null);
    try {
      const r = await post<PlanPreview>(`/api/producao/planejamento${qs({ commit: commit ? 1 : 0, date: date || undefined })}`, fd);
      setPreview(r);
      if (!date) setDate(r.date);
      if (commit) { setDone(true); qc.invalidateQueries({ queryKey: ['producao'] }); }
    } catch (e) { setError(errorMessage(e)); setPreview(null); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Planejamento do dia (PCP)" wide
      footer={done ? <Button kind="primary" onClick={onClose}>Fechar</Button> : <>
        <Button onClick={onClose}>Cancelar</Button>
        {preview ? <Button kind="primary" loading={busy} onClick={() => send(true)}>Usar este planejamento</Button>
          : <Button kind="primary" loading={busy} disabled={!file} onClick={() => send(false)}>Conferir planilha</Button>}
      </>}>
      <div className="space-y-3 text-sm">
        <p className="text-gray-600">Envie a planilha "PLANEJAMENTO APONTAMENTO" do dia (.xlsm). A aba PLANEJAMENTO diz o PN de cada máquina em cada turno (T1, T2, T3; "X" = não roda). Pode enviar de novo quando o plano mudar: vale o último envio do dia. Os ciclos e cavidades também são atualizados.</p>
        {!done && (
          <div className="flex flex-wrap items-end gap-3">
            <input type="file" accept=".xlsx,.xlsm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setDate(''); }} />
            <Field label="Dia do planejamento" hint="Lido do nome do arquivo; troque se precisar"><Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setPreview(null); }} /></Field>
          </div>
        )}
        {error && <p className="text-red-700">{error}</p>}
        {preview && (
          <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
            {done && <p className="flex items-center gap-1.5 font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" />Planejamento de {DateTime.fromISO(preview.date).toFormat('dd/MM/yyyy')} em uso.</p>}
            <p>Dia <b>{DateTime.fromISO(preview.date).toFormat('dd/MM/yyyy')}</b>: {preview.machinesPerShift.map((n, i) => `${n} máquinas no ${i + 1}º turno`).join(' · ')}.</p>
            <ul className="grid gap-x-4 text-xs sm:grid-cols-2">
              {preview.running.map((x) => <li key={x.machine + x.pn}>Máq. <b>{x.machine}</b> · {x.pn} · T{x.shifts.join(', T')}</li>)}
            </ul>
            {preview.stopped.length > 0 && <p className="text-xs text-gray-500">Paradas no plano (X): {preview.stopped.join(', ')}.</p>}
            {preview.outside.length > 0 && <p className="text-xs text-gray-500">Fora das máquinas cadastradas: {preview.outside.join(', ')}.</p>}
            <p className="text-xs text-gray-600">Ciclos: {preview.cycles.added} novos, {preview.cycles.updated} atualizados, {preview.cycles.same} iguais{preview.cycles.manual ? `, ${preview.cycles.manual} digitados à mão mantidos` : ''}.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
