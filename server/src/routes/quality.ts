import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { can } from '../../../shared/permissions.js';
import {
  addDays, defaultPlan, evaluate, isIsoDate, nextNumber, normalizeSteps, PROCEDENTE, QUALITY_DUE_DAYS, QUALITY_ORIGINS, STEP_KEYS,
  type QSteps,
} from '../../../shared/quality.js';
import { audit } from '../audit.js';
import { requireUser } from '../auth.js';
import { withTx } from '../context.js';
import { one, pool, q, type Db } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import {
  buildExport, describeStepChanges, diffRecords, FIELD_LABELS, parseRespostaRapida, RECORD_FIELDS, type QualityRecord, type RecordField,
} from '../services/quality.js';
import { readXlsx, writeXlsx, XlsxError } from '../services/xlsx.js';
import { getConfig } from '../settings.js';
import { optText, parse } from '../validation.js';

export const COLS = `n.id, n.origin, n.number, n.opened_on::text AS opened_on, n.kind, n.partner, n.claim_type, n.product, n.internal_code,
  n.customer_code, n.customer_claim, n.description, n.primary_problem, n.safety, n.recurrent, n.leader, n.steps, n.action_plan,
  n.due_on::text AS due_on, n.on_hold, n.on_hold_reason, n.procedente, n.source, n.version, n.created_at, n.updated_at,
  u.name AS updated_by_name`;
export const FROM = 'quality_ncs n LEFT JOIN users u ON u.id = n.updated_by';

export type Row = QualityRecord & { id: number; version: number; source: string; updated_at: Date; created_at: Date; updated_by_name: string | null };

export const fromDb = (r: any): Row => ({ ...r, steps: normalizeSteps(r.opened_on, r.steps) });

export async function today(): Promise<string> {
  return DateTime.now().setZone((await getConfig()).timezone).toISODate()!;
}

const fmt = (f: RecordField, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if ((f === 'opened_on' || f === 'due_on') && typeof v === 'string') return v.split('-').reverse().join('/');
  const s = String(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};
/** Human-readable changes for the audit trail and the import preview. */
function describeChanges(before: QualityRecord, after: QualityRecord, fields: RecordField[]): string[] {
  return fields.flatMap((f) => f === 'steps'
    ? describeStepChanges(before.steps, after.steps)
    : [`${FIELD_LABELS[f]}: ${fmt(f, before[f])} → ${fmt(f, after[f])}`]);
}

const dateStr = z.string().refine(isIsoDate, 'data inválida');
const stepPatch = z.object({
  plan: dateStr.nullish(),
  done: dateStr.nullish(),
  mark: z.enum(['na', 'hold']).nullish(),
});
const stepsPatch = z.object(Object.fromEntries(STEP_KEYS.map((k) => [k, stepPatch.optional()])) as Record<(typeof STEP_KEYS)[number], z.ZodOptional<typeof stepPatch>>);
const short = optText(200);
const fieldsSchema = z.object({
  number: z.string().trim().min(1, 'informe o número').max(30),
  opened_on: dateStr,
  kind: short,
  partner: short,
  claim_type: short,
  product: optText(500),
  internal_code: optText(500),
  customer_code: optText(500),
  customer_claim: short,
  description: optText(4000),
  primary_problem: short,
  safety: z.boolean(),
  recurrent: z.boolean(),
  leader: short,
  action_plan: optText(4000),
  due_on: dateStr,
  on_hold: z.boolean(),
  on_hold_reason: optText(1000),
  procedente: z.enum(PROCEDENTE).nullable(),
  steps: stepsPatch,
});
const createSchema = fieldsSchema.partial().extend({
  origin: z.enum(QUALITY_ORIGINS),
  number: fieldsSchema.shape.number,
  opened_on: dateStr,
});
const patchSchema = fieldsSchema.partial().extend({ version: z.number().int().positive() });

/** Applies a step patch: a realized date clears N/A / on hold; a mark clears the realized date. */
function applySteps(current: QSteps, patch: z.infer<typeof stepsPatch> | undefined, openedOn: string): QSteps {
  const out = normalizeSteps(openedOn, current);
  for (const k of STEP_KEYS) {
    const p = patch?.[k];
    if (!p) continue;
    const s = { ...out[k] };
    if (p.plan !== undefined) s.plan = p.plan ?? defaultPlan(openedOn, k);
    if (p.done !== undefined) {
      s.done = p.done ?? null;
      if (p.done && p.mark === undefined) s.mark = null;
    }
    if (p.mark !== undefined) s.mark = p.mark ?? null;
    if (s.mark) s.done = null;
    out[k] = s;
  }
  return out;
}

function checkDates(r: QualityRecord, todayIso: string) {
  for (const k of STEP_KEYS) {
    const d = r.steps[k].done;
    if (!d) continue;
    if (d > addDays(todayIso, 1)) throw unprocessable('Data de realização no futuro. Registre a etapa quando ela for concluída.');
    if (d < r.opened_on) throw unprocessable('Data de realização anterior à abertura da ocorrência.');
  }
  if (r.due_on < r.opened_on) throw unprocessable('O prazo não pode ser anterior à abertura.');
}

async function writeRecord(db: Db, id: number, r: QualityRecord, userId: string, importId: number | null) {
  await q(
    `UPDATE quality_ncs SET opened_on=$2, kind=$3, partner=$4, claim_type=$5, product=$6, internal_code=$7, customer_code=$8,
       customer_claim=$9, description=$10, primary_problem=$11, safety=$12, recurrent=$13, leader=$14, steps=$15, action_plan=$16,
       due_on=$17, on_hold=$18, on_hold_reason=$19, procedente=$20, number=$21, updated_by=$22, updated_at=now(), version=version+1,
       last_import_id=COALESCE($23, last_import_id)
     WHERE id=$1`,
    [id, r.opened_on, r.kind, r.partner, r.claim_type, r.product, r.internal_code, r.customer_code, r.customer_claim, r.description,
      r.primary_problem, r.safety, r.recurrent, r.leader, JSON.stringify(r.steps), r.action_plan, r.due_on, r.on_hold, r.on_hold_reason,
      r.procedente, r.number, userId, importId],
    db);
}

async function insertRecord(db: Db, r: QualityRecord, userId: string, source: 'manual' | 'importacao', importId: number | null) {
  return (await one<{ id: number }>(
    `INSERT INTO quality_ncs (origin, number, opened_on, kind, partner, claim_type, product, internal_code, customer_code, customer_claim,
       description, primary_problem, safety, recurrent, leader, steps, action_plan, due_on, on_hold, on_hold_reason, procedente, source,
       last_import_id, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24) RETURNING id`,
    [r.origin, r.number, r.opened_on, r.kind, r.partner, r.claim_type, r.product, r.internal_code, r.customer_code, r.customer_claim,
      r.description, r.primary_problem, r.safety, r.recurrent, r.leader, JSON.stringify(r.steps), r.action_plan, r.due_on, r.on_hold,
      r.on_hold_reason, r.procedente, source, importId, userId],
    db))!.id;
}

export async function qualityGuard(req: FastifyRequest) {
  const u = requireUser(req);
  const area = await one<{ id: number }>(`SELECT id FROM areas WHERE slug = 'qualidade'`);
  if (!can.manageQuality(u, area?.id)) throw forbidden('A área de Qualidade é restrita aos líderes e gestores da Qualidade.');
  return u;
}

export async function qualityRoutes(app: FastifyInstance) {
  const guard = qualityGuard;

  app.get('/api/quality/ncs', async (req) => {
    await guard(req);
    const t = await today();
    const rows = (await q(`SELECT ${COLS} FROM ${FROM} ORDER BY n.opened_on DESC, n.id DESC`)).map(fromDb);
    const lastImport = await one(`SELECT i.id, i.filename, i.imported_at, i.created_count, i.updated_count, i.unchanged_count, u.name AS imported_by_name
                                    FROM quality_imports i JOIN users u ON u.id = i.imported_by ORDER BY i.id DESC LIMIT 1`);
    return { today: t, lastImport: lastImport ?? null, ncs: rows.map((r) => ({ ...r, eval: evaluate(r, t) })) };
  });

  app.get('/api/quality/ncs/:id', async (req) => {
    await guard(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const row = await one(`SELECT ${COLS} FROM ${FROM} WHERE n.id = $1`, [id]);
    if (!row) throw notFound('Ocorrência não encontrada.');
    const r = fromDb(row);
    const history = await q(
      `SELECT a.id, a.at, a.action, a.data, u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.entity_type = 'quality_nc' AND a.entity_id = $1 ORDER BY a.at DESC, a.id DESC LIMIT 200`, [String(id)]);
    const actions = await q(
      `SELECT qa.step, qa.decision, qa.decided_at, qa.note, u.name AS decided_by_name, i.id AS issue_id, i.code AS issue_code, i.status AS issue_status,
              a.name AS area_name, au.name AS assignee_name
         FROM quality_actions qa JOIN users u ON u.id = qa.decided_by
         LEFT JOIN issues i ON i.id = qa.issue_id LEFT JOIN areas a ON a.id = i.area_id LEFT JOIN users au ON au.id = i.assignee_id
        WHERE qa.nc_id = $1 ORDER BY qa.decided_at DESC`, [id]);
    return { nc: { ...r, eval: evaluate(r, await today()) }, history, actions };
  });

  app.get('/api/quality/options', async (req) => {
    await guard(req);
    const catalog: Record<string, string[]> = { tipo: [], cliente: [], fornecedor: [], problema: [], lider: [] };
    const rows = await q<{ kind: string; value: string }>(
      `SELECT kind, value FROM quality_catalog
       UNION SELECT 'tipo', kind FROM quality_ncs WHERE kind IS NOT NULL
       UNION SELECT CASE WHEN origin = 'fornecedor' THEN 'fornecedor' ELSE 'cliente' END, partner FROM quality_ncs WHERE partner IS NOT NULL
       UNION SELECT 'problema', primary_problem FROM quality_ncs WHERE primary_problem IS NOT NULL
       UNION SELECT 'lider', leader FROM quality_ncs WHERE leader IS NOT NULL`);
    for (const r of rows) catalog[r.kind]?.push(r.value);
    for (const k of Object.keys(catalog)) catalog[k].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const numbers = (await q<{ number: string }>('SELECT number FROM quality_ncs')).map((r) => r.number);
    return { catalog, nextNumber: nextNumber(numbers, await today()) };
  });

  app.post('/api/quality/ncs', async (req, reply) => {
    const u = await guard(req);
    const b = parse(createSchema, req.body);
    const t = await today();
    const rec: QualityRecord = {
      origin: b.origin,
      number: b.number,
      opened_on: b.opened_on,
      kind: b.kind ?? null,
      partner: b.partner ?? null,
      claim_type: b.claim_type ?? null,
      product: b.product ?? null,
      internal_code: b.internal_code ?? null,
      customer_code: b.customer_code ?? null,
      customer_claim: b.customer_claim ?? null,
      description: b.description ?? null,
      primary_problem: b.primary_problem ?? null,
      safety: b.safety ?? false,
      recurrent: b.recurrent ?? false,
      leader: b.leader ?? null,
      steps: applySteps(normalizeSteps(b.opened_on, null), b.steps, b.opened_on),
      action_plan: b.action_plan ?? null,
      due_on: b.due_on ?? addDays(b.opened_on, QUALITY_DUE_DAYS),
      on_hold: b.on_hold ?? false,
      on_hold_reason: b.on_hold_reason ?? null,
      procedente: b.procedente === undefined ? 'SIM' : b.procedente,
    };
    checkDates(rec, t);
    try {
      const id = await withTx(u, req.ip, async (ctx) => {
        const id = await insertRecord(ctx.db, rec, u.id, 'manual', null);
        await audit(ctx.db, { actorId: u.id, action: 'quality.create', entityType: 'quality_nc', entityId: id, data: { numero: rec.number, origem: rec.origin }, ip: req.ip });
        ctx.events.push({ type: 'quality.changed' });
        return id;
      });
      reply.code(201);
      return { id };
    } catch (e: any) {
      if (e.code === '23505') throw conflict(`Já existe a ocorrência ${rec.number} nesta origem.`);
      throw e;
    }
  });

  app.patch('/api/quality/ncs/:id', async (req) => {
    const u = await guard(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const b = parse(patchSchema, req.body);
    const t = await today();
    try {
      return await withTx(u, req.ip, async (ctx) => {
        const row = await one(`SELECT ${COLS} FROM ${FROM} WHERE n.id = $1 FOR UPDATE OF n`, [id], ctx.db);
        if (!row) throw notFound('Ocorrência não encontrada.');
        if (row.version !== b.version) throw conflict('Esta ocorrência foi alterada por outra pessoa enquanto você editava. Os dados foram atualizados; revise e salve de novo.', 'versao');
        const before = fromDb(row);
        const after: QualityRecord = { ...before };
        for (const f of RECORD_FIELDS) {
          if (f === 'steps' || (b as any)[f] === undefined) continue;
          (after as any)[f] = (b as any)[f];
        }
        if (b.number !== undefined) after.number = b.number;
        // moving the opening date moves the planned dates that still follow the exit criteria
        let steps = before.steps;
        if (after.opened_on !== before.opened_on) {
          steps = normalizeSteps(after.opened_on, Object.fromEntries(STEP_KEYS.map((k) => [k, {
            ...before.steps[k], plan: before.steps[k].plan === defaultPlan(before.opened_on, k) ? null : before.steps[k].plan,
          }])) as QSteps);
          if (b.due_on === undefined && before.due_on === addDays(before.opened_on, QUALITY_DUE_DAYS)) after.due_on = addDays(after.opened_on, QUALITY_DUE_DAYS);
        }
        after.steps = applySteps(steps, b.steps, after.opened_on);
        checkDates(after, t);
        const fields = diffRecords(before, after);
        if (after.number !== before.number) fields.unshift('number' as RecordField);
        if (!fields.length) return { ok: true, version: before.version };
        await writeRecord(ctx.db, id, after, u.id, null);
        const changes = fields.flatMap((f) => ((f as string) === 'number' ? [`Número: ${before.number} → ${after.number}`] : describeChanges(before, after, [f])));
        await audit(ctx.db, { actorId: u.id, action: 'quality.update', entityType: 'quality_nc', entityId: id, data: { numero: after.number, alteracoes: changes }, ip: req.ip });
        ctx.events.push({ type: 'quality.changed' });
        return { ok: true, version: before.version + 1 };
      });
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Já existe outra ocorrência com este número nesta origem.');
      throw e;
    }
  });

  /** Import the "Resposta Rápida" spreadsheet. Without ?commit=1 it only returns the preview. */
  app.post('/api/quality/import', async (req) => {
    const u = await guard(req);
    const { commit, keepEdited } = parse(z.object({ commit: z.enum(['0', '1']).default('0'), keepEdited: z.enum(['0', '1']).default('1') }), req.query);
    let file: { name: string; buf: Buffer } | null = null;
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (file) throw badRequest('Envie um arquivo por vez.');
      file = { name: part.filename.replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'planilha.xlsx', buf: await part.toBuffer() };
    }
    if (!file) throw badRequest('Selecione a planilha (.xlsx).');
    if (!['.xlsx', '.xlsm'].includes(path.extname(file.name).toLowerCase())) throw badRequest('Envie a planilha no formato Excel .xlsx.');
    const t = await today();
    let parsed;
    try {
      parsed = parseRespostaRapida(readXlsx(file.buf), t);
    } catch (e) {
      if (e instanceof XlsxError) throw badRequest(e.message);
      throw e;
    }
    if (!parsed.sheets.length) throw unprocessable('Nenhuma aba "NC Externa", "NC Interna" ou "NC Fornecedor" encontrada na planilha.');

    const existing = new Map((await q(`SELECT ${COLS} FROM ${FROM}`)).map((r) => [`${r.origin}|${r.number}`, fromDb(r)]));
    const editedIds = new Set((await q<{ id: number }>(
      `SELECT DISTINCT n.id FROM quality_ncs n
         JOIN audit_events a ON a.entity_type = 'quality_nc' AND a.entity_id = n.id::text AND a.action IN ('quality.update', 'quality.create')
         LEFT JOIN quality_imports i ON i.id = n.last_import_id
        WHERE i.id IS NULL OR a.at > i.imported_at`)).map((r) => r.id));

    const created: QualityRecord[] = [];
    const updated: { id: number; before: Row; after: QualityRecord; fields: RecordField[]; edited: boolean }[] = [];
    let unchanged = 0;
    for (const rec of parsed.records) {
      const cur = existing.get(`${rec.origin}|${rec.number}`);
      if (!cur) { created.push(rec); continue; }
      const fields = diffRecords(cur, rec);
      if (!fields.length) { unchanged++; continue; }
      updated.push({ id: cur.id, before: cur, after: rec, fields, edited: editedIds.has(cur.id) });
    }
    const keep = keepEdited === '1';
    const apply = updated.filter((x) => !(keep && x.edited));
    const preview = {
      filename: file.name,
      sheets: parsed.sheets,
      warnings: parsed.warnings,
      created: created.map((r) => ({ origin: r.origin, number: r.number, partner: r.partner, opened_on: r.opened_on, description: r.description })),
      updated: updated.map((x) => ({ origin: x.after.origin, number: x.after.number, partner: x.after.partner, edited: x.edited, changes: describeChanges(x.before, x.after, x.fields) })),
      unchanged,
      kept: updated.length - apply.length,
    };
    if (commit !== '1') return { ...preview, committed: false };

    const sha256 = crypto.createHash('sha256').update(file.buf).digest('hex');
    const importId = await withTx(u, req.ip, async (ctx) => {
      const imp = await one<{ id: number }>(
        `INSERT INTO quality_imports (filename, sha256, imported_by, created_count, updated_count, unchanged_count, warnings)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [file.name, sha256, u.id, created.length, apply.length, unchanged + preview.kept, JSON.stringify(parsed.warnings.slice(0, 200))], ctx.db);
      for (const rec of created) {
        const id = await insertRecord(ctx.db, rec, u.id, 'importacao', imp!.id);
        await audit(ctx.db, { actorId: u.id, action: 'quality.import_create', entityType: 'quality_nc', entityId: id, data: { numero: rec.number, origem: rec.origin, arquivo: file.name }, ip: req.ip });
      }
      for (const x of apply) {
        await writeRecord(ctx.db, x.id, x.after, u.id, imp!.id);
        await audit(ctx.db, { actorId: u.id, action: 'quality.import_update', entityType: 'quality_nc', entityId: x.id, data: { numero: x.after.number, arquivo: file.name, alteracoes: describeChanges(x.before, x.after, x.fields) }, ip: req.ip });
      }
      const catalog = [...parsed.catalog, ...parsed.records.filter((r) => r.leader).map((r) => ({ kind: 'lider', value: r.leader! }))];
      for (const c of catalog) await q('INSERT INTO quality_catalog (kind, value) VALUES ($1,$2) ON CONFLICT DO NOTHING', [c.kind, c.value], ctx.db);
      await audit(ctx.db, { actorId: u.id, action: 'quality.import', entityType: 'quality_import', entityId: imp!.id, data: { arquivo: file.name, sha256, novas: created.length, atualizadas: apply.length, sem_alteracao: unchanged, preservadas: preview.kept, avisos: parsed.warnings.length }, ip: req.ip });
      ctx.events.push({ type: 'quality.changed' });
      return imp!.id;
    });
    return { ...preview, committed: true, importId };
  });

  app.get('/api/quality/imports', async (req) => {
    await guard(req);
    return q(`SELECT i.id, i.filename, i.imported_at, i.created_count, i.updated_count, i.unchanged_count, jsonb_array_length(i.warnings) AS warnings, u.name AS imported_by_name
                FROM quality_imports i JOIN users u ON u.id = i.imported_by ORDER BY i.id DESC LIMIT 30`);
  });

  /** Same layout as the company spreadsheet, so it can be sent, edited and imported again. */
  app.get('/api/quality/export.xlsx', async (req, reply) => {
    const u = await guard(req);
    const t = await today();
    const rows = (await q(`SELECT ${COLS} FROM ${FROM}`)).map(fromDb);
    const buf = writeXlsx(buildExport(rows, t));
    await audit(pool, { actorId: u.id, action: 'quality.export', entityType: 'quality_nc', data: { ocorrencias: rows.length }, ip: req.ip });
    reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="resposta-rapida-${t}.xlsx"`)
      .header('cache-control', 'no-store');
    return reply.send(buf);
  });
}
