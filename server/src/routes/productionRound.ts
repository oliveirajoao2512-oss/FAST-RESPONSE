import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { normalizePn } from '../../../shared/maintenance.js';
import { canEditStandards, canReportProduction, machineKey, productionAccess } from '../../../shared/production.js';
import { OFF_SHIFT, shiftOf, type Shift } from '../../../shared/shifts.js';
import { audit } from '../audit.js';
import { requireUser } from '../auth.js';
import { one, pool, q, tx, type Db } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { notify } from '../notify.js';
import { publish, type RealtimeEvent } from '../realtime.js';
import { parseDailyPlan, parsePlanCycles, planDateFromName, planMachineKey } from '../services/productionPlanImport.js';
import { setupSnapshot, type SetupRow } from '../services/setups.js';
import { getConfig } from '../settings.js';
import { parse } from '../validation.js';
import { readXlsx, XlsxError } from '../services/xlsx.js';
import { applyPlanCycles, loadStops, checkPeriod, ENTRY_SQL, evaluateEntries, findStandard, guard, readUpload, validMachine } from './production.js';
import { placeLists } from './workOrders.js';

/**
 * "Rodada da hora" (João, 27/11/2026): when an hour closes, the system already knows which machines run which PN —
 * from the PCP's daily plan, corrected by the setups finished in the Controle de Setup — so the leader only types the
 * pieces. Saving shows at once the meta × real of each machine and the stops that explain the difference.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** plans older than this many days are not used for an hour */
const PLAN_FALLBACK_DAYS = 3;

/** which shift (1, 2, 3) an hour belongs to, and the date that shift started (the 3º turno starts the day before) */
export function shiftOfHour(start: DateTime, shifts: Shift[], zone: string) {
  const name = shiftOf(start.toJSDate(), shifts, zone);
  if (!name || name === OFF_SHIFT) return null;
  const index = shifts.findIndex((s) => s.name === name) + 1;
  const sh = shifts[index - 1];
  const local = start.setZone(zone);
  const st = local.weekday === 6 && sh.saturday ? sh.saturday.start : sh.start;
  const date = local.toFormat('HH:mm') < st ? local.minus({ days: 1 }) : local;
  return { name, index, date: date.toISODate()! };
}

async function planFor(date: string, db: Db = pool) {
  return one<{ id: number; plan_date: string; uploaded_at: Date; uploaded_by: string; file_name: string | null; who: string }>(
    `SELECT p.id, to_char(p.plan_date, 'YYYY-MM-DD') AS plan_date, p.uploaded_at, p.uploaded_by, p.file_name, u.name AS who
       FROM production_plans p JOIN users u ON u.id = p.uploaded_by
      WHERE p.plan_date <= $1::date AND p.plan_date > $1::date - $2::int
      ORDER BY p.plan_date DESC, p.uploaded_at DESC LIMIT 1`, [date, PLAN_FALLBACK_DAYS], db);
}

export interface RoundRow {
  machine: string; pn: string; source: 'plano' | 'setup'; op: string | null;
  setup: { status: string; startedAt: string; user: string | null } | null;
  cycleSeconds: number | null; cavities: number | null; perHour: number | null;
}

/** the machines expected to run in the hour [start, end), with their PN */
export async function roundPlan(end: DateTime, zone: string, shifts: Shift[]) {
  const start = end.minus({ hours: 1 });
  const shift = shiftOfHour(start, shifts, zone);
  if (!shift) return { start, end, shift: null, plan: null, rows: [] as RoundRow[], setupOk: null as boolean | null };
  const plan = await planFor(shift.date);
  const { maquina } = await placeLists(['maquina']);
  const codes = new Map(maquina.map((m) => [planMachineKey(m.code), m.code]));

  const items = plan
    ? await q<any>(`SELECT machine, pn, op, cycle_seconds::float AS cycle, cavities FROM production_plan_items WHERE plan_id = $1 AND $2 = ANY(shifts) ORDER BY id`, [plan.id, shift.index])
    : [];
  const byMachine = new Map<string, RoundRow[]>();
  for (const it of items) {
    const code = codes.get(planMachineKey(it.machine));
    if (!code) continue;
    const list = byMachine.get(code) ?? [];
    if (!list.some((r) => r.pn === it.pn)) list.push({ machine: code, pn: it.pn, source: 'plano', op: it.op, setup: null, cycleSeconds: it.cycle, cavities: it.cavities, perHour: null });
    byMachine.set(code, list);
  }

  // the last setup of each machine (last 24 h) tells what it runs: a machine only changes PN through a setup
  const snap = await setupSnapshot(end.toMillis() - 24 * 3600_000, end.toMillis());
  const latest = new Map<string, SetupRow>();
  for (const s of snap?.rows ?? []) {
    const code = codes.get(planMachineKey(s.machine));
    if (!code || new Date(s.startedAt).getTime() >= end.toMillis()) continue;
    const cur = latest.get(code);
    if (!cur || cur.startedAt < s.startedAt) latest.set(code, s);
  }
  for (const [code, s] of latest) {
    const pn = normalizePn(s.pn);
    const planned = byMachine.get(code) ?? [];
    const info = { status: s.status, startedAt: s.startedAt, user: s.user };
    if (pn && !planned.some((r) => r.pn === pn)) {
      byMachine.set(code, [{ machine: code, pn, source: 'setup', op: null, setup: info, cycleSeconds: null, cavities: null, perHour: null }]);
    } else if (s.status !== 'Finalizado' && planned.length) {
      for (const r of planned) r.setup = info;
    }
  }

  const order = new Map(maquina.map((m, i) => [m.code, i]));
  const rows = [...byMachine.values()].flat().sort((a, b) => (order.get(a.machine) ?? 0) - (order.get(b.machine) ?? 0));
  for (const r of rows) {
    const std = await findStandard(r.machine, r.pn);
    if (std) { r.cycleSeconds = std.cycleSeconds; r.cavities = std.cavities; }
    r.perHour = r.cycleSeconds ? Math.round((3600 / r.cycleSeconds) * (r.cavities || 1) * 10) / 10 : null;
  }
  return { start, end, shift, plan, rows, setupOk: snap ? snap.ok : null };
}

/** the hour that closed last (or the one ending at `at`, rounded down to the hour) */
const hourEnd = (zone: string, at?: string) => (at ? DateTime.fromISO(at, { zone }) : DateTime.now().setZone(zone)).startOf('hour');

export async function productionRoundRoutes(app: FastifyInstance) {
  /** the PCP sends the day's plan (sheet PLANEJAMENTO); commit=0 shows what was read */
  app.post('/api/producao/planejamento', async (req) => {
    const u = requireUser(req);
    await guard(u);
    const f = parse(z.object({ commit: z.enum(['0', '1']).default('0'), date: day.optional() }), req.query);
    const { buf, name } = await readUpload(req);
    let wb;
    try { wb = readXlsx(buf); } catch (e) {
      if (e instanceof XlsxError) throw badRequest(e.message);
      throw e;
    }
    const plan = parseDailyPlan(wb);
    if (!plan.items.length) throw badRequest('Não encontrei a aba PLANEJAMENTO com máquinas, turnos (T1, T2, T3) e part numbers.');
    const { timezone: zone } = await getConfig();
    const date = f.date ?? planDateFromName(name) ?? DateTime.now().setZone(zone).toISODate()!;
    const { maquina } = await placeLists(['maquina']);
    const codes = new Map(maquina.map((m) => [planMachineKey(m.code), m.code]));
    const mapped = plan.items.map((i) => ({ ...i, code: codes.get(planMachineKey(i.machine)) ?? null }));
    const outside = [...new Set(mapped.filter((i) => !i.code).map((i) => i.machine))];
    const cycles = await applyPlanCycles(parsePlanCycles(wb), u.id, f.commit === '1');
    const perShift = [1, 2, 3].map((t) => new Set(mapped.filter((i) => i.code && i.shifts.includes(t)).map((i) => i.code)).size);
    const summary = {
      date, fileName: name, machinesPerShift: perShift,
      running: mapped.filter((i) => i.code && i.shifts.length).map((i) => ({ machine: i.code, pn: i.pn, shifts: i.shifts })),
      stopped: [...new Set(mapped.filter((i) => i.code && !i.shifts.length).map((i) => i.code!))],
      outside, cycles,
    };
    if (f.commit !== '1') return summary;
    await tx(async (db) => {
      const p = await one<{ id: number }>(`INSERT INTO production_plans (plan_date, file_name, uploaded_by) VALUES ($1, $2, $3) RETURNING id`, [date, name.slice(0, 200), u.id], db);
      for (const i of mapped.filter((x) => x.code)) {
        await q(`INSERT INTO production_plan_items (plan_id, machine, pn, shifts, cycle_seconds, cavities, op) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [p!.id, i.code, i.pn, i.shifts, i.cycleSeconds, i.cavities, i.op], db);
      }
      await audit(db, { actorId: u.id, action: 'producao.planejamento', entityType: 'production_plan', entityId: p!.id, data: { date, file: name, itens: mapped.length } });
    });
    return summary;
  });

  app.get('/api/producao/planejamento', async (req) => {
    const u = requireUser(req);
    await guard(u);
    const { timezone: zone } = await getConfig();
    const { date } = parse(z.object({ date: day.optional() }), req.query);
    const d = date ?? DateTime.now().setZone(zone).toISODate()!;
    const plan = await planFor(d);
    if (!plan) return { date: d, plan: null };
    const items = await q<any>(`SELECT machine, pn, shifts, op FROM production_plan_items WHERE plan_id = $1 ORDER BY id`, [plan.id]);
    return {
      date: d,
      plan: { id: plan.id, date: plan.plan_date, uploadedAt: plan.uploaded_at, by: plan.who, fileName: plan.file_name, sameDay: plan.plan_date === d },
      machinesPerShift: [1, 2, 3].map((t) => new Set(items.filter((i) => i.shifts.includes(t)).map((i) => i.machine)).size),
      items,
    };
  });

  /** the hour to report: machines and PNs already filled, and what was already reported in it */
  app.get('/api/producao/rodada', async (req) => {
    const u = requireUser(req);
    const slug = await guard(u);
    const { end: at } = parse(z.object({ end: z.string().max(40).optional() }), req.query);
    const { timezone: zone, shifts } = await getConfig();
    const now = DateTime.now().setZone(zone);
    let end = hourEnd(zone, at);
    if (end > now.startOf('hour')) end = now.startOf('hour');
    const r = await roundPlan(end, zone, shifts);
    const done = await q<any>(`${ENTRY_SQL} WHERE e.period_start < $2 AND e.period_end > $1 ORDER BY e.machine`, [r.start.toJSDate(), r.end.toJSDate()]);
    const { entries, setup } = await evaluateEntries(done, u.id, canEditStandards(u, slug));
    const key = (m: string, pn: string) => `${machineKey(m)}|${pn}`;
    const byKey = new Map(entries.map((e) => [key(e.machine, e.pn), e]));
    // the stops already registered in the hour, so the tablet compares while the leader types
    const machines = [...new Set(r.rows.map((x) => x.machine))];
    const { byMachine } = await loadStops(machines, r.start.toJSDate(), r.end.toJSDate());
    // OS/OA opened in the hour with the machine running: shown, but they do not explain lost pieces
    const running = machines.length ? await q<any>(
      `SELECT w.code, w.domain, w.asset_ref, w.opened_at, w.finished_at, left(w.description, 80) AS description
         FROM work_orders w
        WHERE NOT w.machine_stopped AND w.location_type = 'maquina' AND upper(replace(w.asset_ref, ' ', '')) = ANY($1)
          AND w.status NOT IN ('cancelada', 'recusada') AND w.opened_at < $3 AND COALESCE(w.finished_at, now()) > $2`,
      [machines.map(machineKey), r.start.toJSDate(), r.end.toJSDate()]) : [];
    // a meal told in an earlier hour (or another PN) of the machine that reaches into this hour comes filled in
    const meals = machines.length ? await q<{ machine: string; break_start: Date; break_end: Date }>(
      `SELECT DISTINCT ON (upper(replace(machine, ' ', ''))) machine, break_start, break_end FROM production_entries
        WHERE break_start IS NOT NULL AND upper(replace(machine, ' ', '')) = ANY($1) AND break_start < $3 AND break_end > $2
        ORDER BY upper(replace(machine, ' ', '')), created_at DESC`, [machines.map(machineKey), r.start.toJSDate(), r.end.toJSDate()]) : [];
    const rows = r.rows.map((row) => ({
      ...row, entry: byKey.get(key(row.machine, row.pn)) ?? null,
      meal: (() => { const m = meals.find((x) => machineKey(x.machine) === machineKey(row.machine)); return m ? { start: m.break_start.toISOString(), end: m.break_end.toISOString() } : null; })(),
      stops: byMachine.get(machineKey(row.machine)) ?? [],
      running: running.filter((o) => machineKey(o.asset_ref) === machineKey(row.machine)).map((o) => ({
        ref: o.code, source: o.domain === 'ajuste' ? 'ajuste' : 'manutencao', label: `${o.code} · ${o.description ?? ''}`.trim(),
        start: new Date(o.opened_at).getTime(), end: o.finished_at ? new Date(o.finished_at).getTime() : Date.now(),
      })),
    }));
    const extra = entries.filter((e) => !r.rows.some((row) => key(row.machine, row.pn) === key(e.machine, e.pn)));
    return {
      start: r.start.toISO(), end: r.end.toISO(), shift: r.shift,
      plan: r.plan ? { date: r.plan.plan_date, uploadedAt: r.plan.uploaded_at, by: r.plan.who, sameDay: r.plan.plan_date === r.shift?.date } : null,
      setup: setup ?? (r.setupOk == null ? null : { ok: r.setupOk, error: null }),
      rows, extra,
      pending: rows.filter((x) => !x.entry).length,
      isLatest: end.equals(now.startOf('hour')),
    };
  });

  /** saves the hour: one report per machine + PN with a quantity; each line is checked on its own */
  app.post('/api/producao/rodada', async (req, reply) => {
    const u = requireUser(req);
    const slug = await guard(u);
    const b = parse(z.object({
      start: z.coerce.date(), end: z.coerce.date(),
      items: z.array(z.object({
        machine: z.string().trim().min(1).max(40), pn: z.string().trim().min(1).max(60),
        quantity: z.coerce.number().int().min(0).max(1_000_000),
        breakMinutes: z.coerce.number().int().min(0).max(720).default(0),
        // the meal told by its times: the minutes inside the hour are counted here (they win over breakMinutes)
        breakStart: z.coerce.date().optional().nullable(),
        breakEnd: z.coerce.date().optional().nullable(),
        note: z.string().trim().max(500).optional().nullable(),
      })).min(1, 'Informe a quantidade de pelo menos uma máquina.').max(200),
    }), req.body);
    const { shifts, timezone } = await getConfig();
    const ids: string[] = [];
    const errors: { machine: string; pn: string; erro: string }[] = [];
    for (const it of b.items) {
      try {
        const machine = await validMachine(it.machine);
        const pn = normalizePn(it.pn)!;
        let breakMin = it.breakMinutes;
        if (it.breakStart || it.breakEnd) {
          if (!it.breakStart || !it.breakEnd || it.breakEnd <= it.breakStart) throw badRequest('Informe o início e o fim da refeição.');
          if (it.breakEnd.getTime() - it.breakStart.getTime() > 4 * 3600_000) throw badRequest('A refeição tem mais de 4 horas: confira os horários.');
          breakMin = Math.round(Math.max(0, Math.min(it.breakEnd.getTime(), b.end.getTime()) - Math.max(it.breakStart.getTime(), b.start.getTime())) / 60_000);
        }
        if (breakMin * 60_000 >= b.end.getTime() - b.start.getTime()) throw badRequest('A refeição precisa ser menor que o período.');
        await checkPeriod(machine, pn, b.start, b.end, null);
        const std = await findStandard(machine, pn);
        const row = await one<{ id: string }>(
          `INSERT INTO production_entries (machine, pn, shift, period_start, period_end, quantity, cycle_seconds, cavities, standard_machine, note, leader_id, break_minutes, break_start, break_end)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [machine, pn, shiftOf(b.start, shifts, timezone), b.start, b.end, it.quantity, std?.cycleSeconds ?? null, std?.cavities ?? null,
            std && !std.sameMachine ? std.machine : null, it.note || null, u.id, breakMin, it.breakStart ?? null, it.breakEnd ?? null]);
        ids.push(row!.id);
      } catch (e) {
        errors.push({ machine: it.machine, pn: it.pn, erro: e instanceof AppError ? e.message : 'Não foi possível salvar.' });
      }
    }
    if (ids.length) await audit(pool, { actorId: u.id, action: 'producao.rodada', entityType: 'production_entry', data: { inicio: b.start, fim: b.end, salvos: ids.length, erros: errors.length } });
    const rows = ids.length ? await q<any>(`${ENTRY_SQL} WHERE e.id = ANY($1::uuid[]) ORDER BY e.machine`, [ids]) : [];
    const { entries } = await evaluateEntries(rows, u.id, canEditStandards(u, slug));
    // lines that could not be saved come back in `errors`, next to the ones saved
    reply.code(ids.length ? 201 : 200);
    return { saved: ids.length, errors, entries };
  });
}

/**
 * When an hour closes, the people who report production get a notice on the phone with the number of machines to
 * report. Once per hour (dedupe key), only in the first 15 minutes after the hour, and only when a plan exists.
 */
export async function runProductionRoundNotice(now = new Date()) {
  const { timezone: zone, shifts } = await getConfig();
  const end = DateTime.fromJSDate(now).setZone(zone).startOf('hour');
  if (now.getTime() - end.toMillis() > 15 * 60_000) return { sent: false };
  const r = await roundPlan(end, zone, shifts);
  if (!r.shift || !r.plan || !r.rows.length) return { sent: false };
  const users = await q<{ id: string; role: string; slug: string | null }>(
    `SELECT u.id, u.role, a.slug FROM users u LEFT JOIN areas a ON a.id = u.area_id WHERE u.active AND u.role IN ('admin', 'plant_manager', 'lider', 'gestor')`);
  const to = users.filter((x) => canReportProduction(x, x.slug)).map((x) => x.id);
  if (!to.length) return { sent: false };
  const events: RealtimeEvent[] = [];
  const machines = new Set(r.rows.map((x) => x.machine)).size;
  await notify(pool, events, {
    userIds: to, type: 'producao_hora', dedupeKey: `producao_hora:${end.toISO()}`,
    title: `Hora fechada ${r.start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}: aponte a produção`,
    body: `${machines} máquina(s) rodando no ${r.shift.name}. Máquina e PN já estão preenchidos.`,
  });
  for (const e of events) publish(e);
  return { sent: true, machines, adminOnly: productionAccess.adminOnly };
}
