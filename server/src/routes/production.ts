import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { normalizePn } from '../../../shared/maintenance.js';
import {
  canEditStandards, canReportProduction, checkProduction, machineKey, PRODUCTION_MAX_HOURS, STOP_SOURCE_LABEL, UNJUSTIFIED_MESSAGE,
  type StopInput,
} from '../../../shared/production.js';
import { shiftOf } from '../../../shared/shifts.js';
import { audit } from '../audit.js';
import { requireUser } from '../auth.js';
import type { SessionUser } from '../context.js';
import { one, pool, q, type Db } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { parsePlanCycles, planMachineKey } from '../services/productionPlanImport.js';
import { setupInterval, setupSnapshot } from '../services/setups.js';
import { readXlsx, XlsxError } from '../services/xlsx.js';
import { getConfig } from '../settings.js';
import { parse } from '../validation.js';
import { placeLists } from './workOrders.js';

/**
 * Conferência de produção, stage 1 (João, 27/11/2026). The leader reports pieces per machine and period; the
 * conferência compares them with the standard cycle and with the stops that already exist in the system
 * (OS and OA with the machine stopped, setups from the Controle de Setup). Nothing is copied from those modules:
 * stops are read at the moment the conferência is shown, so an order registered later still counts.
 */

const areaSlugOf = async (u: SessionUser) =>
  u.areaId == null ? null : (await one<{ slug: string }>('SELECT slug FROM areas WHERE id = $1', [u.areaId]))?.slug ?? null;
async function guard(u: SessionUser) {
  const slug = await areaSlugOf(u);
  if (!canReportProduction(u, slug)) throw forbidden('O apontamento de produção é dos líderes e gestores de Produção, do plant manager e do administrador.');
  return slug;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const entrySchema = z.object({
  machine: z.string().trim().min(1).max(40),
  pn: z.string().trim().min(1).max(60),
  start: z.coerce.date(),
  end: z.coerce.date(),
  quantity: z.coerce.number().int().min(0).max(1_000_000),
  breakMinutes: z.coerce.number().int().min(0).max(720).default(0),
  note: z.string().trim().max(500).optional().nullable(),
});
const standardSchema = z.object({
  machine: z.string().trim().min(1).max(40),
  pn: z.string().trim().min(1).max(60),
  cycleSeconds: z.coerce.number().positive().max(3600),
  cavities: z.coerce.number().int().min(1).max(64).default(1),
});

/** the standard for machine + PN; when that machine has none, the one of another machine running the same PN */
async function findStandard(machine: string, pn: string, db?: Db) {
  const rows = await q<{ machine: string; cycle_seconds: number; cavities: number }>(
    `SELECT machine, cycle_seconds::float AS cycle_seconds, cavities FROM production_standards WHERE upper(pn) = upper($1)
      ORDER BY (upper(replace(machine, ' ', '')) = $2) DESC, updated_at DESC`, [pn, machineKey(machine)], db);
  const r = rows[0];
  if (!r) return null;
  return { cycleSeconds: r.cycle_seconds, cavities: r.cavities, sameMachine: machineKey(r.machine) === machineKey(machine), machine: r.machine };
}

async function validMachine(code: string) {
  const { maquina } = await placeLists(['maquina']);
  const m = maquina.find((p) => machineKey(p.code) === machineKey(code));
  if (!m) throw badRequest('Escolha uma máquina da lista.', { machine: 'fora do cadastro' });
  return m.code;
}

async function checkPeriod(machine: string, start: Date, end: Date, exceptId: string | null) {
  if (end <= start) throw badRequest('O fim do período precisa ser depois do início.', { end: 'antes do início' });
  if (end.getTime() - start.getTime() > PRODUCTION_MAX_HOURS * 3600_000) throw badRequest(`Um apontamento cobre no máximo ${PRODUCTION_MAX_HOURS} horas.`, { end: 'período longo demais' });
  if (end.getTime() > Date.now() + 10 * 60_000) throw badRequest('O período não pode terminar no futuro.', { end: 'no futuro' });
  const clash = await one<{ pn: string; period_start: Date; period_end: Date }>(
    `SELECT pn, period_start, period_end FROM production_entries
      WHERE upper(replace(machine, ' ', '')) = $1 AND period_start < $3 AND period_end > $2 AND ($4::uuid IS NULL OR id <> $4) LIMIT 1`,
    [machineKey(machine), start, end, exceptId]);
  if (clash) {
    const { timezone: zone } = await getConfig();
    const hm = (d: Date) => DateTime.fromJSDate(d).setZone(zone).toFormat('dd/MM HH:mm');
    throw conflict(`A máquina ${machine} já tem apontamento de ${hm(clash.period_start)} a ${hm(clash.period_end)} (PN ${clash.pn}). Ajuste o período.`, 'periodo_sobreposto');
  }
}

/** every registered stop on these machines that touches [from, to] */
async function loadStops(machines: string[], from: Date, to: Date) {
  const keys = [...new Set(machines.map(machineKey))];
  const byMachine = new Map<string, StopInput[]>(keys.map((k) => [k, []]));
  if (!keys.length) return { byMachine, setup: null as null | { ok: boolean; error: string | null } };
  const now = Date.now();
  const orders = await q<any>(
    `SELECT w.code, w.domain, w.asset_ref, w.opened_at, w.finished_at, left(w.description, 80) AS description
       FROM work_orders w
      WHERE w.machine_stopped AND w.location_type = 'maquina' AND upper(replace(w.asset_ref, ' ', '')) = ANY($1)
        AND w.status NOT IN ('cancelada', 'recusada', 'em_analise', 'programada')
        AND w.opened_at < $3 AND COALESCE(w.finished_at, now()) > $2`, [keys, from, to]);
  for (const o of orders) {
    byMachine.get(machineKey(o.asset_ref))?.push({
      source: o.domain === 'ajuste' ? 'ajuste' : 'manutencao', ref: o.code,
      label: `${o.code} · ${o.description ?? ''}`.trim(),
      start: new Date(o.opened_at).getTime(), end: o.finished_at ? new Date(o.finished_at).getTime() : now,
    });
  }
  // a setup can start the day before and hold the machine into the period
  const snap = await setupSnapshot(from.getTime() - 36 * 3600_000, to.getTime());
  for (const s of snap?.rows ?? []) {
    const list = byMachine.get(machineKey(s.machine));
    if (!list) continue;
    const { start, end } = setupInterval(s, now);
    if (end <= from.getTime() || start >= to.getTime()) continue;
    list.push({ source: 'setup', ref: s.id, label: `Setup${s.pn ? ` PN ${s.pn}` : ''}${s.user ? ` · ${s.user}` : ''}${s.status !== 'Finalizado' ? ` · ${s.status.toLowerCase()}` : ''}`, start, end });
  }
  return { byMachine, setup: snap ? { ok: snap.ok, error: snap.error ?? null } : null };
}

export async function productionRoutes(app: FastifyInstance) {
  app.get('/api/producao/opcoes', async (req) => {
    const u = requireUser(req);
    const slug = await guard(u);
    const { maquina } = await placeLists(['maquina']);
    const standards = await q<any>(
      `SELECT s.machine, s.pn, s.cycle_seconds::float AS "cycleSeconds", s.cavities, s.source, s.updated_at AS "updatedAt", p.description
         FROM production_standards s LEFT JOIN part_numbers p ON upper(p.code) = upper(s.pn) ORDER BY s.machine, s.pn`);
    const { shifts, timezone } = await getConfig();
    // where the last report of each machine ended, to suggest the next period
    const last = await q<any>(
      `SELECT DISTINCT ON (upper(machine)) machine, pn, period_end AS "periodEnd" FROM production_entries
        WHERE period_end > now() - interval '24 hours' ORDER BY upper(machine), period_end DESC`);
    return {
      machines: maquina.map((m) => m.code), standards, shifts, timezone, last,
      canEditStandards: canEditStandards(u, slug),
    };
  });

  app.post('/api/producao/apontamentos', async (req, reply) => {
    const u = requireUser(req);
    await guard(u);
    const b = parse(entrySchema, req.body);
    const machine = await validMachine(b.machine);
    const pn = normalizePn(b.pn)!;
    if (b.breakMinutes * 60_000 >= b.end.getTime() - b.start.getTime()) throw badRequest('A pausa de refeição precisa ser menor que o período.', { breakMinutes: 'maior que o período' });
    await checkPeriod(machine, b.start, b.end, null);
    const std = await findStandard(machine, pn);
    const { shifts, timezone } = await getConfig();
    const row = await one<{ id: string }>(
      `INSERT INTO production_entries (machine, pn, shift, period_start, period_end, quantity, cycle_seconds, cavities, standard_machine, note, leader_id, break_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [machine, pn, shiftOf(b.start, shifts, timezone), b.start, b.end, b.quantity, std?.cycleSeconds ?? null, std?.cavities ?? null,
        std && !std.sameMachine ? std.machine : null, b.note || null, u.id, b.breakMinutes]);
    await audit(pool, { actorId: u.id, action: 'producao.apontar', entityType: 'production_entry', entityId: row!.id, data: { machine, pn, quantity: b.quantity } });
    reply.code(201);
    return { id: row!.id, standard: std };
  });

  /** correction by whoever reported it, or by the leadership; the previous values stay in the audit log */
  app.patch('/api/producao/apontamentos/:id', async (req) => {
    const u = requireUser(req);
    const slug = await guard(u);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const old = await one<any>('SELECT * FROM production_entries WHERE id = $1', [id]);
    if (!old) throw notFound();
    if (old.leader_id !== u.id && !canEditStandards(u, slug)) throw forbidden('Só quem apontou ou a gestão de Produção corrige este apontamento.');
    const b = parse(entrySchema, req.body);
    const machine = await validMachine(b.machine);
    const pn = normalizePn(b.pn)!;
    if (b.breakMinutes * 60_000 >= b.end.getTime() - b.start.getTime()) throw badRequest('A pausa de refeição precisa ser menor que o período.', { breakMinutes: 'maior que o período' });
    await checkPeriod(machine, b.start, b.end, id);
    const sameStd = machineKey(machine) === machineKey(old.machine) && pn === old.pn;
    const std = sameStd ? null : await findStandard(machine, pn);
    const { shifts, timezone } = await getConfig();
    await q(
      `UPDATE production_entries SET machine = $2, pn = $3, shift = $4, period_start = $5, period_end = $6, quantity = $7, note = $8,
              cycle_seconds = CASE WHEN $9 THEN cycle_seconds ELSE $10 END, cavities = CASE WHEN $9 THEN cavities ELSE $11 END,
              standard_machine = CASE WHEN $9 THEN standard_machine ELSE $12 END, updated_at = now(), updated_by = $13, break_minutes = $14
        WHERE id = $1`,
      [id, machine, pn, shiftOf(b.start, shifts, timezone), b.start, b.end, b.quantity, b.note || null, sameStd,
        std?.cycleSeconds ?? null, std?.cavities ?? null, std && !std.sameMachine ? std.machine : null, u.id, b.breakMinutes]);
    await audit(pool, {
      actorId: u.id, action: 'producao.corrigir', entityType: 'production_entry', entityId: id,
      data: { antes: { machine: old.machine, pn: old.pn, start: old.period_start, end: old.period_end, quantity: old.quantity, note: old.note, breakMinutes: old.break_minutes } },
    });
    return { ok: true };
  });

  /** the leader explains time that no registered stop covers */
  app.post('/api/producao/apontamentos/:id/motivo', async (req) => {
    const u = requireUser(req);
    await guard(u);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Descreva o motivo.').max(1000) }), req.body);
    const old = await one<{ gap_reason: string | null }>('SELECT gap_reason FROM production_entries WHERE id = $1', [id]);
    if (!old) throw notFound();
    await q('UPDATE production_entries SET gap_reason = $2, gap_reason_by = $3, gap_reason_at = now() WHERE id = $1', [id, reason, u.id]);
    await audit(pool, { actorId: u.id, action: 'producao.motivo', entityType: 'production_entry', entityId: id, data: { antes: old.gap_reason, motivo: reason } });
    return { ok: true };
  });

  app.get('/api/producao/conferencia', async (req) => {
    const u = requireUser(req);
    const slug = await guard(u);
    const manager = canEditStandards(u, slug);
    const f = parse(z.object({
      from: day.optional(), to: day.optional(), machine: z.string().trim().max(40).optional(),
      status: z.enum(['sem_padrao', 'meta', 'justificada', 'divergencia']).optional(),
    }), req.query);
    const { timezone: zone } = await getConfig();
    const today = DateTime.now().setZone(zone);
    const from = (f.from ? DateTime.fromISO(f.from, { zone }) : today).startOf('day');
    const to = (f.to ? DateTime.fromISO(f.to, { zone }) : from).endOf('day');
    const rows = await q<any>(
      `SELECT e.*, e.cycle_seconds::float AS cycle, l.name AS leader, r.name AS reason_by
         FROM production_entries e JOIN users l ON l.id = e.leader_id LEFT JOIN users r ON r.id = e.gap_reason_by
        WHERE e.period_start >= $1 AND e.period_start <= $2 AND ($3::text IS NULL OR upper(replace(e.machine, ' ', '')) = $3)
        ORDER BY e.period_start DESC, e.machine`,
      [from.toJSDate(), to.toJSDate(), f.machine ? machineKey(f.machine) : null]);
    // a report saved before its standard existed uses today's standard (and says so)
    const missing = rows.filter((r) => r.cycle == null);
    const late = new Map<string, Awaited<ReturnType<typeof findStandard>>>();
    for (const r of missing) late.set(r.id, await findStandard(r.machine, r.pn));

    const span = rows.length
      ? { a: new Date(Math.min(...rows.map((r) => +new Date(r.period_start)))), b: new Date(Math.max(...rows.map((r) => +new Date(r.period_end)))) }
      : null;
    const { byMachine, setup } = span ? await loadStops(rows.map((r) => r.machine), span.a, span.b) : { byMachine: new Map(), setup: null };

    const entries = rows.map((r) => {
      const lateStd = late.get(r.id) ?? null;
      const cycle = r.cycle ?? lateStd?.cycleSeconds ?? null;
      const cavities = r.cavities ?? lateStd?.cavities ?? null;
      const c = checkProduction({
        start: +new Date(r.period_start), end: +new Date(r.period_end), quantity: r.quantity,
        cycleSeconds: cycle, cavities, breakMin: r.break_minutes, stops: byMachine.get(machineKey(r.machine)) ?? [],
      });
      return {
        id: r.id, machine: r.machine, pn: r.pn, shift: r.shift, start: r.period_start, end: r.period_end,
        leader: r.leader, leaderId: r.leader_id, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at,
        cycleSeconds: cycle, cavities,
        standardFrom: r.cycle != null ? (r.standard_machine ? 'outra_maquina' : 'maquina') : lateStd ? 'atual' : null,
        standardMachine: r.standard_machine ?? (lateStd && !lateStd.sameMachine ? lateStd.machine : null),
        reason: r.gap_reason, reasonBy: r.reason_by, reasonAt: r.gap_reason_at,
        message: c.status === 'divergencia' && !r.gap_reason ? UNJUSTIFIED_MESSAGE : null,
        canEdit: r.leader_id === u.id || manager,
        ...c,
        stops: c.stops.map((s) => ({ ...s, sourceLabel: STOP_SOURCE_LABEL[s.source], start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })),
      };
    }).filter((e) => !f.status || e.status === f.status);

    const sum = (k: 'expected' | 'quantity' | 'lossMin' | 'stopMin' | 'justifiedMin' | 'unjustifiedMin' | 'unjustifiedPieces') =>
      Math.round(entries.reduce((n, e) => n + ((e[k] as number | null) ?? 0), 0) * 10) / 10;
    return {
      from: from.toISODate(), to: to.toISODate(), setup,
      totals: {
        entries: entries.length,
        expected: sum('expected'), quantity: sum('quantity'), lossMin: sum('lossMin'), stopMin: sum('stopMin'),
        justifiedMin: sum('justifiedMin'), unjustifiedMin: sum('unjustifiedMin'), unjustifiedPieces: sum('unjustifiedPieces'),
        byStatus: Object.fromEntries(['meta', 'justificada', 'divergencia', 'sem_padrao'].map((s) => [s, entries.filter((e) => e.status === s).length])),
        pendingReason: entries.filter((e) => e.status === 'divergencia' && !e.reason).length,
      },
      entries,
    };
  });

  app.put('/api/producao/padroes', async (req) => {
    const u = requireUser(req);
    const slug = await guard(u);
    if (!canEditStandards(u, slug)) throw forbidden('Os ciclos padrão são editados pelo gestor de Produção, plant manager ou administrador.');
    const b = parse(standardSchema, req.body);
    const machine = await validMachine(b.machine);
    const pn = normalizePn(b.pn)!;
    const old = await one<any>(`SELECT cycle_seconds::float AS cycle, cavities FROM production_standards WHERE upper(machine) = upper($1) AND upper(pn) = upper($2)`, [machine, pn]);
    await q(
      `INSERT INTO production_standards (machine, pn, cycle_seconds, cavities, source, updated_by) VALUES ($1,$2,$3,$4,'manual',$5)
       ON CONFLICT (upper(machine), upper(pn)) DO UPDATE SET cycle_seconds = EXCLUDED.cycle_seconds, cavities = EXCLUDED.cavities,
         source = 'manual', updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [machine, pn, b.cycleSeconds, b.cavities, u.id]);
    await audit(pool, { actorId: u.id, action: 'producao.padrao', entityType: 'production_standard', entityId: `${machine}|${pn}`, data: { antes: old ?? null, cycleSeconds: b.cycleSeconds, cavities: b.cavities } });
    return { ok: true };
  });

  /**
   * Standard cycles (with cavities) from the PCP spreadsheet. commit=0 only shows what would change. A cycle typed by
   * hand is never overwritten; one that came from the Controle de Ciclo is replaced, since the spreadsheet has cavities.
   */
  app.post('/api/producao/padroes/importar-planilha', async (req) => {
    const u = requireUser(req);
    const slug = await guard(u);
    if (!canEditStandards(u, slug)) throw forbidden('Os ciclos padrão são editados pelo gestor de Produção, plant manager ou administrador.');
    const { commit } = parse(z.object({ commit: z.enum(['0', '1']).default('0') }), req.query);
    let buf: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (!/\.(xlsx|xlsm)$/i.test(part.filename)) throw badRequest('Envie a planilha no formato Excel (.xlsx ou .xlsm).');
      buf = await part.toBuffer();
    }
    if (!buf) throw badRequest('Selecione a planilha.');
    let parsed;
    try { parsed = parsePlanCycles(readXlsx(buf)); } catch (e) {
      if (e instanceof XlsxError) throw badRequest(e.message);
      throw e;
    }
    if (!parsed.items.length) throw badRequest('Nenhuma aba com colunas de máquina, part number e ciclo foi encontrada.');
    const { maquina } = await placeLists(['maquina']);
    const codes = new Map(maquina.map((m) => [planMachineKey(m.code), m.code]));
    const current = new Map((await q<any>(`SELECT machine, pn, cycle_seconds::float AS cycle, cavities, source FROM production_standards`))
      .map((r) => [`${machineKey(r.machine)}|${r.pn}`, r]));
    const outside = new Map<string, number>();
    const changes: { machine: string; pn: string; cycleSeconds: number; cavities: number; before: { cycleSeconds: number; cavities: number; source: string } | null }[] = [];
    let same = 0, manual = 0;
    for (const it of parsed.items) {
      const machine = codes.get(planMachineKey(it.machine));
      if (!machine) { outside.set(it.machine, (outside.get(it.machine) ?? 0) + 1); continue; }
      const cur = current.get(`${machineKey(machine)}|${it.pn}`);
      if (cur?.source === 'manual') { manual++; continue; }
      if (cur && cur.cycle === it.cycleSeconds && cur.cavities === it.cavities) { same++; continue; }
      changes.push({ machine, pn: it.pn, cycleSeconds: it.cycleSeconds, cavities: it.cavities, before: cur ? { cycleSeconds: cur.cycle, cavities: cur.cavities, source: cur.source } : null });
    }
    const summary = {
      sheets: parsed.sheets, total: parsed.items.length,
      added: changes.filter((c) => !c.before).length, updated: changes.filter((c) => c.before).length, same, manual,
      outside: [...outside.entries()].map(([machine, n]) => ({ machine, n })).sort((a, b) => b.n - a.n),
      mismatches: parsed.mismatches,
      examples: changes.filter((c) => c.before).slice(0, 10),
    };
    if (commit !== '1') return summary;
    for (const c of changes) {
      await q(
        `INSERT INTO production_standards (machine, pn, cycle_seconds, cavities, source, updated_by) VALUES ($1,$2,$3,$4,'planilha_pcp',$5)
         ON CONFLICT (upper(machine), upper(pn)) DO UPDATE SET cycle_seconds = EXCLUDED.cycle_seconds, cavities = EXCLUDED.cavities,
           source = 'planilha_pcp', updated_by = EXCLUDED.updated_by, updated_at = now()
           WHERE production_standards.source <> 'manual'`, [c.machine, c.pn, c.cycleSeconds, c.cavities, u.id]);
    }
    await audit(pool, { actorId: u.id, action: 'producao.importar_planilha', entityType: 'production_standard', data: { added: summary.added, updated: summary.updated, abas: parsed.sheets } });
    return summary;
  });

  /**
   * Loads the standard cycles of the Controle de Ciclo app (Firestore controleciclos-fb533, collection produtos:
   * pn, maquinaPadrao, cicloPadrao). Read only there; here it never overwrites a cycle typed by hand.
   */
  app.post('/api/producao/padroes/importar-ciclo', async (req) => {
    const u = requireUser(req);
    const slug = await guard(u);
    if (!canEditStandards(u, slug)) throw forbidden('Os ciclos padrão são editados pelo gestor de Produção, plant manager ou administrador.');
    const products = await cycleProducts();
    const { maquina } = await placeLists(['maquina']);
    const codes = new Map(maquina.map((m) => [machineKey(m.code), m.code]));
    let added = 0, updated = 0, kept = 0;
    const skipped: string[] = [];
    for (const p of products) {
      // the Controle de Ciclo writes the injection machines as "INJEÇÃO 120T"; the plant list has "INJETORA 120 T"
      const alias = (m: string) => machineKey(m).replace(/^INJE[ÇC][ÃA]O/, 'INJETORA');
      const machine = p.machine ? codes.get(alias(p.machine)) : undefined;
      const pn = normalizePn(p.pn);
      if (!machine || !pn || !(p.cycle > 0) || p.cycle > 3600) { skipped.push(`${p.pn || '?'}${p.machine ? ` (máq. ${p.machine})` : ''}`); continue; }
      const r = await one<{ inserted: boolean } | undefined>(
        `INSERT INTO production_standards (machine, pn, cycle_seconds, cavities, source, updated_by) VALUES ($1,$2,$3,1,'controle_ciclo',$4)
         ON CONFLICT (upper(machine), upper(pn)) DO UPDATE SET cycle_seconds = EXCLUDED.cycle_seconds, updated_by = EXCLUDED.updated_by, updated_at = now()
           WHERE production_standards.source = 'controle_ciclo' AND production_standards.cycle_seconds <> EXCLUDED.cycle_seconds
         RETURNING (xmax = 0) AS inserted`, [machine, pn, p.cycle, u.id]);
      if (!r) kept++; else if (r.inserted) added++; else updated++;
    }
    await audit(pool, { actorId: u.id, action: 'producao.importar_ciclo', entityType: 'production_standard', data: { added, updated, kept, skipped: skipped.length } });
    return { total: products.length, added, updated, kept, skipped };
  });
}

/** standard cycles from the Controle de Ciclo app; tests replace it */
export let cycleProducts = async (): Promise<{ pn: string; machine: string | null; cycle: number }[]> => {
  const base = `https://firestore.googleapis.com/v1/projects/${process.env.CYCLE_FIRESTORE_PROJECT || 'controleciclos-fb533'}/databases/(default)/documents/produtos`;
  const out: { pn: string; machine: string | null; cycle: number }[] = [];
  let token = '';
  do {
    const r = await fetch(`${base}?pageSize=300${token ? `&pageToken=${token}` : ''}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw badRequest(`O Controle de Ciclo não respondeu (${r.status}).`);
    const j = (await r.json()) as any;
    for (const d of j.documents ?? []) {
      const f = d.fields ?? {};
      const num = (v: any) => (v ? Number(v.integerValue ?? v.doubleValue ?? v.stringValue) : NaN);
      out.push({ pn: f.pn?.stringValue ?? '', machine: f.maquinaPadrao?.stringValue ?? null, cycle: num(f.cicloPadrao) });
    }
    token = j.nextPageToken ?? '';
  } while (token);
  return out;
};
export function setCycleProducts(f: typeof cycleProducts) { cycleProducts = f; }
