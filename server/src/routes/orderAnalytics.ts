import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  WO_COMPONENT_LABELS, WO_COMPONENTS, WO_DOMAIN, WO_DOMAINS, WO_LOCATION_LABELS, WO_STATUS_LABELS, normalizePn, woCategory, woStart, woTimes, workedMs,
  type Interval, type WoDomain, type WoLocation,
} from '../../../shared/maintenance.js';
import { shiftOf, shiftRanges } from '../../../shared/shifts.js';
import { requireUser } from '../auth.js';
import type { SessionUser } from '../context.js';
import { q } from '../db.js';
import { forbidden } from '../errors.js';
import { getConfig } from '../settings.js';
import { parse } from '../validation.js';

/**
 * Analytical dashboards of the Ordens de Ajuste (OA) and Ordens de Manutenção (OS), planned with João on 25/11/2026
 * ("Dashboards de Ajustes e Manutenção — Diagnóstico e planejamento").
 *
 * Read only: nothing here writes to the database, and every number comes from the orders as they were registered.
 * Records that look wrong are never changed: they are only kept out of the time averages and listed for review.
 *
 * Preview: only the administrator sees it until João releases it to the leadership of each module.
 */

/** An order counts in the time averages only when its duration is believable. */
const MIN_RELIABLE_MS = 60_000; // finished less than a minute after accepting: registered after the job was done
const MAX_RELIABLE_MS = 24 * 3600_000; // more than a day open: most likely someone forgot to finish it
const RECURRENCE_DAYS = 7;
const DUP_MINUTES = 15;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filtersSchema = z.object({
  from: day.optional(),
  to: day.optional(),
  shift: z.string().trim().max(40).optional(),
  tech: z.string().uuid().optional(),
  /** a part number, or "-" for the orders without one */
  pn: z.string().trim().max(60).optional(),
  /** asset key: "<location>|<CODE>" (location may be empty in the imported history) */
  asset: z.string().trim().max(140).optional(),
  /** maintenance kind, or adjustment reason number */
  category: z.string().trim().max(20).optional(),
  /** maintenance only: corretiva (not planned) or preventiva (planned) */
  type: z.enum(['corretiva', 'preventiva']).optional(),
  component: z.enum(WO_COMPONENTS).optional(),
  /** include the history imported from the old spreadsheet (default: yes) */
  imported: z.enum(['0', '1']).optional(),
});
const recordsSchema = filtersSchema.extend({
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['opened_at', 'code', 'shift', 'techs', 'pn', 'asset', 'category', 'duration', 'stopped', 'status']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  /** only the orders flagged for review */
  review: z.enum(['0', '1']).optional(),
});
type Filters = z.infer<typeof filtersSchema>;

interface Stint { user_id: string; name: string; joined_at: string; left_at: string | null }
interface Row {
  id: string; code: string; status: string; opened_at: string; first_accepted_at: string | null; finished_at: string | null;
  scheduled: boolean; planned_start: string | null; imported: boolean; legacy_number: string | null;
  asset_ref: string; location_type: WoLocation | null; kind: any; reason: number | null; part_number: string | null; part_description: string | null;
  machine_stopped: boolean; component: keyof typeof WO_COMPONENT_LABELS | null; tool_code: string | null;
  area_name: string; opened_by_name: string; finished_by: string | null; description: string; service_done: string | null; material: string | null;
  pauses: { from: string; to: string | null }[]; stints: Stint[];
}

/** One order, with everything the dashboards derive from it. */
interface Fact {
  row: Row; start: Date; shift: string | null; assetKey: string; assetLabel: string; pnKey: string; pnLabel: string;
  catKey: string; catLabel: string; finished: boolean; workMs: number | null; reliable: boolean; review: string | null;
  stoppedMs: number; waitMs: number | null; techIds: string[]; techNames: string[]; lead: string | null;
}

const assetKeyOf = (r: Row) => `${r.location_type ?? ''}|${r.asset_ref.trim().toUpperCase()}`;
const assetLabelOf = (r: Row) => {
  const code = r.asset_ref.trim();
  if (r.location_type) return `${WO_LOCATION_LABELS[r.location_type]} ${code}`;
  return /^D\d+$/i.test(code) ? `Dispositivo ${code}` : code;
};

async function loadFacts(d: WoDomain, f: Date, t: Date, zone: string, shifts: { name: string; start: string }[]) {
  // planned maintenance counts from its approved date, like everywhere else in the app
  const rows = await q<Row>(
    `SELECT w.id, w.code, w.status, w.opened_at, w.first_accepted_at, w.finished_at, w.scheduled, w.planned_start, w.imported, w.legacy_number,
            w.asset_ref, w.location_type, w.kind, w.reason, w.part_number, pn.description AS part_description, w.machine_stopped, w.component, w.tool_code,
            a.name AS area_name, ob.name AS opened_by_name, w.finished_by, w.description, w.service_done, w.material,
            COALESCE((SELECT json_agg(json_build_object('from', p.started_at, 'to', p.ended_at) ORDER BY p.started_at)
               FROM work_order_pauses p WHERE p.work_order_id = w.id), '[]') AS pauses,
            COALESCE((SELECT json_agg(json_build_object('user_id', x.user_id, 'name', u.name, 'joined_at', x.joined_at, 'left_at', x.left_at) ORDER BY x.joined_at)
               FROM work_order_workers x JOIN users u ON u.id = x.user_id WHERE x.work_order_id = w.id), '[]') AS stints
       FROM work_orders w JOIN areas a ON a.id = w.area_id JOIN users ob ON ob.id = w.opened_by
       LEFT JOIN part_numbers pn ON pn.code = w.part_number
      WHERE w.domain = $1 AND w.status NOT IN ('cancelada', 'em_analise', 'recusada')
        AND COALESCE(CASE WHEN w.scheduled AND w.planned_start > w.opened_at THEN w.planned_start END, w.opened_at) BETWEEN $2 AND $3
      ORDER BY w.opened_at`, [d, f, t]);
  const now = Date.now();
  return rows.map((r): Fact => {
    const start = new Date(woStart(r));
    const pauses: Interval[] = r.pauses.map((p) => ({ from: p.from, to: p.to }));
    const times = woTimes({ ...r, opened_at: start }, pauses);
    const finished = r.status === 'finalizada' && !!r.finished_at;
    const workMs = finished ? times.workMs : null;
    const totalMs = finished ? times.totalMs : null;
    let review: string | null = null;
    if (finished && totalMs! > MAX_RELIABLE_MS) review = 'Mais de 24 h entre abertura e fim';
    else if (finished && !r.imported && (workMs ?? 0) < MIN_RELIABLE_MS) review = 'Finalizada menos de 1 min depois do aceite';
    const techs = new Map<string, string>();
    for (const s of r.stints) techs.set(s.user_id, s.name);
    const pn = r.part_number?.trim() || '';
    return {
      row: r, start, shift: r.imported ? null : shiftOf(start, shifts, zone),
      assetKey: assetKeyOf(r), assetLabel: assetLabelOf(r),
      pnKey: pn || '-', pnLabel: pn ? (r.part_description ? `${pn} · ${r.part_description}` : pn) : 'Sem PN',
      catKey: String(r.kind ?? r.reason ?? ''), catLabel: woCategory(r),
      finished, workMs, reliable: finished && !review, review,
      // stopped machine: from opening until the order was finished (the app does not record when production restarted)
      stoppedMs: r.machine_stopped ? Math.max(0, (r.finished_at ? new Date(r.finished_at).getTime() : now) - start.getTime()) : 0,
      waitMs: r.imported || !r.first_accepted_at ? null : Math.max(0, new Date(r.first_accepted_at).getTime() - start.getTime()),
      techIds: [...techs.keys()], techNames: [...techs.values()],
      // the person responsible is who finished it; while open, who accepted it first
      lead: r.finished_by ?? r.stints[0]?.user_id ?? null,
    };
  });
}

function applyFilters(facts: Fact[], qs: Filters) {
  const pn = qs.pn && qs.pn !== '-' ? normalizePn(qs.pn) : qs.pn;
  return facts.filter((x) =>
    (qs.imported !== '0' || !x.row.imported) &&
    (!qs.shift || x.shift === qs.shift) &&
    (!qs.tech || x.techIds.includes(qs.tech)) &&
    (!pn || x.pnKey === pn) &&
    (!qs.asset || x.assetKey === qs.asset) &&
    (!qs.category || x.catKey === qs.category) &&
    (!qs.type || (qs.type === 'preventiva') === x.row.scheduled) &&
    (!qs.component || x.row.component === qs.component));
}

const H = (ms: number) => ms / 3600_000;
const round = (v: number | null, p = 2) => (v == null ? null : Math.round(v * 10 ** p) / 10 ** p);

/** Count, durations and stops of a group of orders, with the same rules for every chart. */
function stats(xs: Fact[]) {
  const rel = xs.filter((x) => x.reliable);
  const workMs = rel.reduce((a, x) => a + (x.workMs ?? 0), 0);
  const stops = xs.filter((x) => x.row.machine_stopped);
  const stopsDone = stops.filter((x) => x.finished && !x.review);
  const stoppedMs = stops.reduce((a, x) => a + x.stoppedMs, 0);
  return {
    n: xs.length,
    finished: xs.filter((x) => x.finished).length,
    timed: rel.length,
    workH: round(H(workMs)),
    avgMin: rel.length ? round(workMs / rel.length / 60_000, 1) : null,
    stops: stops.length,
    stoppedH: round(H(stoppedMs)),
    mttrH: stopsDone.length ? round(H(stopsDone.reduce((a, x) => a + x.stoppedMs, 0) / stopsDone.length)) : null,
  };
}

function groupBy(xs: Fact[], key: (x: Fact) => string, label: (x: Fact) => string) {
  const m = new Map<string, { key: string; label: string; xs: Fact[] }>();
  for (const x of xs) {
    const k = key(x);
    const g = m.get(k) ?? { key: k, label: label(x), xs: [] };
    g.xs.push(x);
    m.set(k, g);
  }
  return [...m.values()];
}
const top = <T>(xs: T[], val: (x: T) => number) => xs.reduce<T | null>((b, x) => (b == null || val(x) > val(b) ? x : b), null);
const mostCommon = (xs: Fact[], key: (x: Fact) => string, label: (x: Fact) => string) => {
  const g = top(groupBy(xs, key, label), (y) => y.xs.length);
  return g ? { key: g.key, label: g.label, n: g.xs.length } : null;
};

export async function orderAnalyticsRoutes(app: FastifyInstance) {
  for (const d of WO_DOMAINS) domainAnalytics(app, d);
}

function domainAnalytics(app: FastifyInstance, d: WoDomain) {
  const D = WO_DOMAIN[d];
  const guard = (u: SessionUser) => {
    if (u.role !== 'admin') throw forbidden('O novo dashboard está em teste e por enquanto só o administrador vê.');
  };
  const load = async (req: FastifyRequest, schema: typeof filtersSchema | typeof recordsSchema) => {
    const u = requireUser(req);
    guard(u);
    const qs = parse(schema, req.query) as z.infer<typeof recordsSchema>;
    const { timezone: zone, shifts } = await getConfig();
    const to = qs.to ? DateTime.fromISO(qs.to, { zone }) : DateTime.now().setZone(zone);
    const from = qs.from ? DateTime.fromISO(qs.from, { zone }) : to.startOf('month');
    const f = from.startOf('day'), t = to.endOf('day');
    const all = await loadFacts(d, f.toJSDate(), t.toJSDate(), zone, shifts);
    return { qs, zone, shifts, from: f, to: t, all, xs: applyFilters(all, qs) };
  };

  app.get(`${D.api}/analytics`, async (req) => {
    const { qs, zone, shifts, from, to, all, xs } = await load(req, filtersSchema);
    const s = stats(xs);
    const app_ = xs.filter((x) => !x.row.imported);
    const waits = app_.map((x) => x.waitMs).filter((v): v is number => v != null);

    // ---- groups (every chart reads from these, so the numbers always agree)
    // what happens in each shift: its numbers, the machines and problems it has most, and who works on it
    const byShift = shiftRanges(shifts).map((r) => {
      const sx = xs.filter((x) => x.shift === r.name);
      const ranked = (key: (x: Fact) => string, label: (x: Fact) => string) =>
        groupBy(sx, key, label).map((g) => ({ key: g.key, label: g.label, n: g.xs.length, stoppedH: stats(g.xs).stoppedH })).sort((a, b) => b.n - a.n).slice(0, 5);
      const people = new Map<string, { id: string; name: string; n: number }>();
      for (const x of sx) x.techIds.forEach((id, i) => { const c = people.get(id) ?? { id, name: x.techNames[i], n: 0 }; c.n++; people.set(id, c); });
      const waits = sx.map((x) => x.waitMs).filter((v): v is number => v != null);
      return {
        key: r.name, label: r.name, start: r.start, end: r.end, ...stats(sx),
        avgWaitMin: waits.length ? round(waits.reduce((a, b) => a + b, 0) / waits.length / 60_000, 1) : null,
        topAssets: ranked((x) => x.assetKey, (x) => x.assetLabel), topCategories: ranked((x) => x.catKey, (x) => x.catLabel),
        techs: [...people.values()].sort((a, b) => b.n - a.n),
      };
    });
    const noShift = xs.filter((x) => x.shift == null).length;
    const byAsset = groupBy(xs, (x) => x.assetKey, (x) => x.assetLabel)
      .map((g) => ({ key: g.key, label: g.label, ...stats(g.xs), topCategory: mostCommon(g.xs, (x) => x.catKey, (x) => x.catLabel) }))
      .sort((a, b) => b.n - a.n || (b.workH ?? 0) - (a.workH ?? 0));
    const byPn = groupBy(xs, (x) => x.pnKey, (x) => x.pnLabel)
      .map((g) => ({ key: g.key, label: g.label, ...stats(g.xs), topAsset: g.key === '-' ? null : mostCommon(g.xs, (x) => x.assetKey, (x) => x.assetLabel) }))
      .sort((a, b) => (a.key === '-' ? 1 : 0) - (b.key === '-' ? 1 : 0) || b.n - a.n);
    const byCategory = groupBy(xs, (x) => x.catKey, (x) => x.catLabel).map((g) => ({ key: g.key, label: g.label, ...stats(g.xs) })).sort((a, b) => b.n - a.n);
    let acc = 0;
    const pareto = byCategory.map((c) => ({ key: c.key, label: c.label, n: c.n, cumPct: s.n ? round(((acc += c.n) / s.n) * 100, 1) : 0 }));
    const byComponent = d === 'manutencao'
      ? groupBy(app_.filter((x) => x.row.component), (x) => x.row.component!, (x) => WO_COMPONENT_LABELS[x.row.component!]).map((g) => ({ key: g.key, label: g.label, ...stats(g.xs) })).sort((a, b) => b.n - a.n)
      : [];
    const byTool = d === 'manutencao'
      ? groupBy(app_.filter((x) => x.row.tool_code), (x) => x.row.tool_code!, (x) => x.row.tool_code!).map((g) => ({ key: g.key, label: g.label, n: g.xs.length })).sort((a, b) => b.n - a.n).slice(0, 10)
      : [];

    // technicians: interventions as responsible or as helper, and their own hours (man-hours)
    const techs = new Map<string, { id: string; name: string; lead: number; helped: number; manMs: number; leadFacts: Fact[] }>();
    for (const x of xs) {
      const pauses: Interval[] = x.row.pauses.map((p) => ({ from: p.from, to: p.to }));
      for (const st of x.row.stints) {
        const cur = techs.get(st.user_id) ?? { id: st.user_id, name: st.name, lead: 0, helped: 0, manMs: 0, leadFacts: [] };
        cur.manMs += workedMs({ from: st.joined_at, to: st.left_at }, pauses);
        techs.set(st.user_id, cur);
      }
      for (const id of x.techIds) {
        const cur = techs.get(id)!;
        if (id === x.lead) { cur.lead++; cur.leadFacts.push(x); } else cur.helped++;
      }
    }
    const byTech = [...techs.values()].map((t) => {
      const st = stats(t.leadFacts);
      return { id: t.id, name: t.name, n: t.lead + t.helped, lead: t.lead, helped: t.helped, manH: round(H(t.manMs)), avgMin: st.avgMin, timed: st.timed, workH: st.workH };
    }).sort((a, b) => b.n - a.n || (b.manH ?? 0) - (a.manH ?? 0));

    // evolution: by day up to 2 months, by week up to 6 months, by month beyond
    const days = to.diff(from, 'days').days;
    const bucket: 'dia' | 'semana' | 'mes' = days <= 62 ? 'dia' : days <= 190 ? 'semana' : 'mes';
    const unit = bucket === 'dia' ? 'day' : bucket === 'semana' ? 'week' : 'month';
    const keyOf = (x: Date) => DateTime.fromJSDate(x).setZone(zone).startOf(unit).toISODate()!;
    const series = [];
    for (let m = from.startOf(unit); m <= to; m = m.plus({ [`${unit}s`]: 1 })) {
      const k = m.toISODate()!;
      const b = xs.filter((x) => keyOf(x.start) === k);
      series.push({ key: k, ...stats(b), preventive: b.filter((x) => x.row.scheduled).length, corrective: b.filter((x) => !x.row.scheduled).length });
    }

    // recurrence: the same problem (category) on the same asset again within 7 days
    const recurrence = groupBy(xs, (x) => `${x.assetKey}#${x.catKey}`, (x) => x.assetLabel).map((g) => {
      const ts = g.xs.map((x) => x.start.getTime()).sort((a, b) => a - b);
      const gaps = ts.slice(1).map((v, i) => v - ts[i]);
      const repeats = gaps.filter((v) => v <= RECURRENCE_DAYS * 86_400_000);
      const x0 = g.xs[0];
      return { asset: x0.assetKey, assetLabel: x0.assetLabel, category: x0.catKey, categoryLabel: x0.catLabel, n: g.xs.length, repeats: repeats.length,
        avgGapH: repeats.length ? round(H(repeats.reduce((a, b) => a + b, 0) / repeats.length), 1) : null, stoppedH: stats(g.xs).stoppedH };
    }).filter((r) => r.repeats > 0).sort((a, b) => b.repeats - a.repeats || b.n - a.n).slice(0, 15);

    // weekday × hour of the openings (app records only: the imported history has no reliable hour)
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    for (const x of app_) { const z_ = DateTime.fromJSDate(x.start).setZone(zone); heat[z_.weekday - 1][z_.hour]++; }

    // data quality: what was kept out of the averages, and possible duplicates (never changed, only shown)
    const dups: [string, string][] = [];
    const sorted = [...app_].sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].start.getTime() - sorted[i].start.getTime() > DUP_MINUTES * 60_000) break;
      if (sorted[i].assetKey === sorted[j].assetKey && (sorted[i].row.component ?? '') === (sorted[j].row.component ?? '')) dups.push([sorted[i].row.code, sorted[j].row.code]);
    }

    const topAsset = byAsset[0] ?? null;
    const topStop = top(byAsset.filter((a) => (a.stoppedH ?? 0) > 0), (a) => a.stoppedH ?? 0);
    const topPn = byPn.find((p) => p.key !== '-') ?? null;
    const topShift = top(byShift, (r) => r.n);
    return {
      domain: d, from: from.toISODate(), to: to.toISODate(), bucket,
      criteria: {
        duration: 'Do aceite até finalizar, menos as pausas. Fora da média: ordens com mais de 24 h entre abertura e fim e ordens finalizadas menos de 1 min depois do aceite.',
        stopped: 'Ordens abertas com máquina parada, da abertura até a finalização (o app não registra a hora em que a máquina voltou a produzir).',
        shift: `Pela hora de abertura e os turnos de Configurações: ${shiftRanges(shifts).map((r) => `${r.name} ${r.start}–${r.end}`).join(', ')}.`,
        mtbf: 'MTBF não é calculado: falta o calendário de produção (turnos e dias trabalhados) de cada máquina.',
      },
      kpis: {
        ...s,
        open: xs.filter((x) => !x.finished).length,
        corrective: xs.filter((x) => !x.row.scheduled).length,
        preventive: xs.filter((x) => x.row.scheduled).length,
        assets: new Set(xs.map((x) => x.assetKey)).size,
        pns: new Set(xs.filter((x) => x.pnKey !== '-').map((x) => x.pnKey)).size,
        withPn: xs.filter((x) => x.pnKey !== '-').length,
        avgWaitMin: waits.length ? round(waits.reduce((a, b) => a + b, 0) / waits.length / 60_000, 1) : null,
        imported: xs.filter((x) => x.row.imported).length,
        topAsset: topAsset && { key: topAsset.key, label: topAsset.label, n: topAsset.n },
        topStopAsset: topStop && { key: topStop.key, label: topStop.label, stoppedH: topStop.stoppedH },
        topPn: topPn && { key: topPn.key, label: topPn.label, n: topPn.n },
        topShift: topShift && topShift.n ? { key: topShift.key, label: topShift.label, n: topShift.n, pct: round((topShift.n / Math.max(1, xs.length - noShift)) * 100, 0) } : null,
        topCategory: byCategory[0] ? { key: byCategory[0].key, label: byCategory[0].label, n: byCategory[0].n } : null,
      },
      byShift, noShift, byAsset, byPn, byCategory, pareto, byComponent, byTool, byTech, series, recurrence, heat,
      quality: {
        excluded: xs.filter((x) => x.review).length,
        long: xs.filter((x) => x.review?.startsWith('Mais')).length,
        instant: xs.filter((x) => x.review?.startsWith('Finalizada')).length,
        duplicates: dups.slice(0, 50),
      },
      // filter options come from the whole period, so choosing one never hides the others
      options: {
        shifts: shiftRanges(shifts).map((r) => r.name),
        techs: [...new Map(all.flatMap((x) => x.row.stints.map((st) => [st.user_id, { id: st.user_id, name: st.name }] as const))).values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
        pns: [...new Map(all.map((x) => [x.pnKey, { key: x.pnKey, label: x.pnLabel }])).values()].sort((a, b) => (a.key === '-' ? 1 : b.key === '-' ? -1 : a.key.localeCompare(b.key, 'pt-BR', { numeric: true }))),
        assets: [...new Map(all.map((x) => [x.assetKey, { key: x.assetKey, label: x.assetLabel }])).values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true })),
        categories: [...new Map(all.map((x) => [x.catKey, { key: x.catKey, label: x.catLabel }])).values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true })),
        // most frequent first over the whole period: the dashboard gives each category a fixed color from this order
        categoryOrder: [...all.reduce((m, x) => m.set(x.catKey, (m.get(x.catKey) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([k]) => k),
        components: d === 'manutencao' ? WO_COMPONENTS.map((c) => ({ key: c, label: WO_COMPONENT_LABELS[c] })) : [],
        hasImported: all.some((x) => x.row.imported),
      },
      filters: qs,
    };
  });

  // the records behind the charts: same filters, plus a text search, sorting and pages of 50
  app.get(`${D.api}/analytics/records`, async (req) => {
    const { qs, zone, xs } = await load(req, recordsSchema);
    const term = qs.q?.toLowerCase();
    let list = xs.filter((x) => (qs.review !== '1' || x.review) && (!term || [
      x.row.code, x.row.legacy_number, x.assetLabel, x.pnLabel, x.catLabel, x.techNames.join(' '), x.row.description, x.row.service_done, x.row.material, x.row.area_name, x.row.opened_by_name,
    ].join(' ').toLowerCase().includes(term)));
    const val = (x: Fact): string | number => {
      switch (qs.sort) {
        case 'code': return x.row.code;
        case 'shift': return x.shift ?? '';
        case 'techs': return x.techNames.join(', ');
        case 'pn': return x.pnKey;
        case 'asset': return x.assetLabel;
        case 'category': return x.catLabel;
        case 'duration': return x.workMs ?? -1;
        case 'stopped': return x.stoppedMs;
        case 'status': return x.row.status;
        default: return x.start.getTime();
      }
    };
    const dir = qs.dir === 'asc' ? 1 : -1;
    list = [...list].sort((a, b) => { const va = val(a), vb = val(b); return (va < vb ? -1 : va > vb ? 1 : 0) * dir; });
    const page = qs.page ?? 1;
    const size = 50;
    return {
      total: list.length, page, size,
      rows: list.slice((page - 1) * size, page * size).map((x) => ({
        id: x.row.id, code: x.row.code, imported: x.row.imported, legacy: x.row.legacy_number,
        openedAt: DateTime.fromJSDate(x.start).setZone(zone).toISO(), shift: x.shift, techs: x.techNames,
        pn: x.pnKey === '-' ? null : x.pnKey, asset: x.assetLabel, category: x.catLabel, type: x.row.scheduled ? 'preventiva' : 'corretiva',
        durationMin: x.workMs == null ? null : round(x.workMs / 60_000, 1), reliable: x.reliable, review: x.review,
        stopped: x.row.machine_stopped, stoppedH: x.row.machine_stopped ? round(H(x.stoppedMs)) : null,
        // what was reported, and what the technician did on the machine
        description: x.row.description, serviceDone: x.row.service_done, notes: x.row.material, openedBy: x.row.opened_by_name, area: x.row.area_name,
        status: x.row.status, statusLabel: WO_STATUS_LABELS[x.row.status as keyof typeof WO_STATUS_LABELS] ?? x.row.status,
      })),
    };
  });
}
