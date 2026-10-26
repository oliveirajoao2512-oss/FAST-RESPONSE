import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  ADJ_MATERIAL_REASON, ADJ_REASON_CODES, eventText, leadsDomain, WO_DOMAIN, WO_DOMAINS, WO_KINDS, WO_PRIORITIES, WO_PRIORITY_LABELS,
  WO_LOCATION_LABELS, WO_LOCATIONS, WO_STATUS_LABELS, domainLocations, seesDomainDashboard, woCategory, woCode, workedMs, worksDomain, woTimes, normalizePn, type Interval, type WoDomain, type WoLocation, type WoPriority, type WoStatus,
} from '../../../shared/maintenance.js';
import { can } from '../../../shared/permissions.js';
import { audit } from '../audit.js';
import { requireUser } from '../auth.js';
import { withTx, type Ctx, type SessionUser } from '../context.js';
import { one, pool, q, type Db } from '../db.js';
import { badRequest, forbidden, notFound, unprocessable } from '../errors.js';
import { notify } from '../notify.js';
import { purgeWorkOrder } from '../services/purge.js';
import { workOrderPdf } from '../services/workOrderPdf.js';
import { writeXlsx, type OutCell } from '../services/xlsx.js';
import { getConfig } from '../settings.js';
import { storage } from '../storage.js';
import { optText, parse, uuid } from '../validation.js';

const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime']);

const cachedAreaId = new Map<WoDomain, number | null>();
/** Area whose gestores and líderes run the domain's queue (Manutenção, Processos). */
async function domainAreaId(d: WoDomain): Promise<number | null> {
  if (!cachedAreaId.has(d)) cachedAreaId.set(d, (await one<{ id: number }>('SELECT id FROM areas WHERE slug = $1', [WO_DOMAIN[d].areaSlug]))?.id ?? null);
  return cachedAreaId.get(d)!;
}

/** Machines and assembly cells registered in Cadastros, in the plant's order. */
async function placeLists(types: WoLocation[]) {
  const rows = await q<{ type: WoLocation; code: string; description: string | null }>(
    `SELECT type, code, description FROM assets WHERE active AND type = ANY($1) ORDER BY sort, code`, [types]);
  return Object.fromEntries(types.map((t) => [t, rows.filter((r) => r.type === t).map(({ code, description }) => ({ code, description }))])) as Record<WoLocation, { code: string; description: string | null }[]>;
}

/** Technicians and leadership of the domain (who can receive an order). */
async function domainTeam(d: WoDomain, db: Db, areaId: number | null) {
  return q<{ id: string; name: string; role: string }>(
    `SELECT id, name, role FROM users WHERE active AND (role = $2 OR (role IN ('gestor','lider') AND area_id = $1)) ORDER BY role = $2 DESC, name`,
    [areaId, WO_DOMAIN[d].workerRole], db);
}

const LIST_COLS = `w.id, w.domain, w.number, w.code, w.opened_by, w.area_id, w.asset_ref, w.location_type, w.kind, w.reason, w.part_number, w.virgin_pct::float AS virgin_pct, w.regrind_pct::float AS regrind_pct, w.machine_stopped, w.description, w.priority, w.pinned,
  w.status, w.suggested_to, w.transfer_from, w.transfer_to, w.service_done, w.material, w.opened_at, w.first_accepted_at, w.finished_at,
  w.finished_by, w.updated_at, w.version,
  ob.name AS opened_by_name, a.name AS area_name, a.color AS area_color, sg.name AS suggested_name, tf.name AS transfer_from_name,
  tt.name AS transfer_to_name, fb.name AS finished_by_name,
  COALESCE((SELECT json_agg(json_build_object('id', x.user_id, 'name', xu.name, 'since', x.joined_at) ORDER BY x.joined_at)
     FROM work_order_workers x JOIN users xu ON xu.id = x.user_id WHERE x.work_order_id = w.id AND x.left_at IS NULL), '[]') AS workers,
  COALESCE((SELECT json_agg(json_build_object('from', p.started_at, 'to', p.ended_at, 'reason', p.reason) ORDER BY p.started_at)
     FROM work_order_pauses p WHERE p.work_order_id = w.id), '[]') AS pauses,
  (SELECT count(*) FROM work_order_attachments f WHERE f.work_order_id = w.id)::int AS files`;
const LIST_FROM = `work_orders w JOIN users ob ON ob.id = w.opened_by JOIN areas a ON a.id = w.area_id
  LEFT JOIN users sg ON sg.id = w.suggested_to LEFT JOIN users tf ON tf.id = w.transfer_from
  LEFT JOIN users tt ON tt.id = w.transfer_to LEFT JOIN users fb ON fb.id = w.finished_by`;
const QUEUE_ORDER = `w.pinned DESC, CASE w.priority WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.opened_at`;

const withTimes = (r: any) => {
  const pauses: Interval[] = r.pauses.map((p: any) => ({ from: p.from, to: p.to }));
  return { ...r, times: woTimes(r, pauses) };
};

async function loadForUpdate(ctx: Ctx, d: WoDomain, id: string) {
  const w = await one<any>('SELECT * FROM work_orders WHERE id = $1 AND domain = $2 FOR UPDATE', [id, d], ctx.db);
  if (!w) throw notFound(`${WO_DOMAIN[d].short} não encontrada.`);
  return w;
}
const activeWorkers = async (ctx: Ctx, id: string) =>
  (await q<{ user_id: string }>('SELECT user_id FROM work_order_workers WHERE work_order_id = $1 AND left_at IS NULL', [id], ctx.db)).map((r) => r.user_id);

async function event(ctx: Ctx, id: string, action: string, data: Record<string, unknown> = {}) {
  await q('INSERT INTO work_order_events (work_order_id, actor_id, action, data) VALUES ($1,$2,$3,$4)', [id, ctx.actor.id, action, JSON.stringify(data)], ctx.db);
  await q('UPDATE work_orders SET updated_at = now(), version = version + 1 WHERE id = $1', [id], ctx.db);
  ctx.events.push({ type: 'os.changed' });
}

async function endPause(ctx: Ctx, id: string) {
  await q('UPDATE work_order_pauses SET ended_at = now(), ended_by = $2 WHERE work_order_id = $1 AND ended_at IS NULL', [id, ctx.actor.id], ctx.db);
}

/** Gerente (gestor) of the domain's area: kept informed of acceptance and finish. */
async function areaManagers(db: Db, areaId: number | null) {
  return (await q<{ id: string }>(`SELECT id FROM users WHERE active AND role = 'gestor' AND area_id = $1`, [areaId], db)).map((r) => r.id);
}

function guardWorker(d: WoDomain, u: SessionUser, areaId: number | null) {
  if (!worksDomain(d, u, areaId)) throw forbidden(`Somente a equipe de ${WO_DOMAIN[d].team} atua nas ${WO_DOMAIN[d].short}.`);
}
function guardLeader(d: WoDomain, u: SessionUser, areaId: number | null) {
  if (!leadsDomain(u, areaId)) throw forbidden(`Somente o gestor e o líder de ${WO_DOMAIN[d].team} podem fazer isso.`);
}
const assertOpen = (w: any) => {
  if (w.status === 'finalizada') throw unprocessable(`Esta ${w.domain === 'ajuste' ? 'OA' : 'OS'} já foi finalizada.`);
};

const pct = z.number().min(0).max(100).nullable().optional();
const createSchema = z.object({
  areaId: z.number().int().positive(),
  location: z.enum(WO_LOCATIONS),
  assetRef: z.string().trim().min(1, 'obrigatório').max(120),
  kind: z.enum(WO_KINDS).optional(),
  reason: z.number().int().refine((n) => ADJ_REASON_CODES.includes(n), 'motivo inválido').optional(),
  partNumber: optText(60),
  virginPct: pct,
  regrindPct: pct,
  machineStopped: z.boolean(),
  description: z.string().trim().min(1, 'obrigatório').max(2000),
});
const categoryOf = woCategory;
const reason = z.object({ motivo: z.string().trim().min(1, 'informe o motivo').max(300) });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reportQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  areaId: z.coerce.number().int().positive().optional(),
  /** kind (maintenance) or reason number (adjustment) */
  category: z.string().max(20).optional(),
  asset: z.string().trim().max(120).optional(),
  location: z.enum(WO_LOCATIONS).optional(),
  pn: z.string().trim().max(60).optional(),
});

/** Dashboard filters: period (default: last 6 months), requesting area, type/reason, machine and part number. */
async function readFilters(req: FastifyRequest) {
  const qs = parse(reportQuery, req.query);
  const zone = (await getConfig()).timezone;
  const to = qs.to ? DateTime.fromISO(qs.to, { zone }) : DateTime.now().setZone(zone);
  const from = qs.from ? DateTime.fromISO(qs.from, { zone }) : to.minus({ months: 5 }).startOf('month');
  const match = (r: any) =>
    (!qs.areaId || r.area_id === qs.areaId) &&
    (!qs.category || String(r.kind ?? r.reason) === qs.category) &&
    (!qs.asset || r.asset_ref.trim().toUpperCase() === qs.asset.toUpperCase()) &&
    (!qs.location || r.location_type === qs.location) &&
    (!qs.pn || r.part_number === normalizePn(qs.pn));
  return { from: from.startOf('day'), to: to.endOf('day'), zone, match };
}

export async function workOrderRoutes(app: FastifyInstance) {
  for (const d of WO_DOMAINS) domainRoutes(app, d);
  plantPanelRoutes(app);
}

function domainRoutes(app: FastifyInstance, d: WoDomain) {
  const D = WO_DOMAIN[d];
  const api = D.api;
  const notFoundMsg = `${D.short} não encontrada.`;

  app.get(`${api}/options`, async (req) => {
    const u = requireUser(req);
    const areaId = await domainAreaId(d);
    const [areas, team] = await Promise.all([
      q('SELECT id, slug, name, color FROM areas WHERE active ORDER BY sort'),
      domainTeam(d, pool, areaId),
    ]);
    return {
      areas, team, teamAreaId: areaId, canWork: worksDomain(d, u, areaId), canLead: leadsDomain(u, areaId),
      canSeeDashboard: seesDomainDashboard(u, areaId), places: await placeLists(domainLocations(d)),
      // part numbers already used in any order, most recent first, to suggest while typing
      partNumbers: (await q<{ pn: string }>(
        `SELECT part_number AS pn FROM work_orders WHERE part_number IS NOT NULL GROUP BY 1 ORDER BY max(opened_at) DESC LIMIT 500`)).map((r) => r.pn),
    };
  });

  /** Machines: registered assets first, then references already used in orders. */
  app.get(`${api}/assets`, async (req) => {
    requireUser(req);
    const { q: text } = parse(z.object({ q: z.string().max(60).default('') }), req.query);
    const term = `%${text}%`;
    return q(
      `SELECT code, description FROM (
         SELECT code, description, 0 AS rank FROM assets WHERE active AND type IN ('maquina','equipamento','molde') AND (code ILIKE $1 OR description ILIKE $1)
         UNION
         SELECT DISTINCT asset_ref, NULL, 1 FROM work_orders WHERE asset_ref ILIKE $1
       ) x ORDER BY rank, code LIMIT 12`, [term]);
  });

  app.get(api, async (req) => {
    requireUser(req);
    const qs = parse(z.object({
      view: z.enum(['abertas', 'finalizadas']).default('abertas'),
      q: z.string().max(100).optional(),
      from: day.optional(),
      to: day.optional(),
      asset: z.string().trim().max(120).optional(),
      pn: z.string().trim().max(60).optional(),
    }), req.query);
    const term = qs.q?.trim() ? `%${qs.q.trim()}%` : null;
    const search = `w.domain = $2 AND ($1::text IS NULL OR w.code ILIKE $1 OR w.asset_ref ILIKE $1 OR w.description ILIKE $1 OR w.service_done ILIKE $1 OR w.part_number ILIKE $1)`;
    if (qs.view === 'abertas') {
      const rows = await q(`SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE w.status <> 'finalizada' AND ${search} ORDER BY ${QUEUE_ORDER}`, [term, d]);
      return rows.map(withTimes);
    }
    const zone = (await getConfig()).timezone;
    const from = qs.from ? DateTime.fromISO(qs.from, { zone }).startOf('day').toJSDate() : null;
    const to = qs.to ? DateTime.fromISO(qs.to, { zone }).endOf('day').toJSDate() : null;
    const rows = await q(
      `SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE w.status = 'finalizada' AND ${search}
          AND ($3::timestamptz IS NULL OR w.finished_at >= $3) AND ($4::timestamptz IS NULL OR w.finished_at <= $4)
          AND ($5::text IS NULL OR upper(trim(w.asset_ref)) = upper($5))
          AND ($6::text IS NULL OR w.part_number = $6)
        ORDER BY w.finished_at DESC LIMIT 300`, [term, d, from, to, qs.asset || null, normalizePn(qs.pn)]);
    return rows.map(withTimes);
  });

  app.get(`${api}/:id`, async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const o = await detail(id);
    return { ...o, attachments: o.attachments.map(({ storage_path: _, ...f }: any) => f) };
  });

  /** Evidence of the order as a PDF, available from the moment it is opened. */
  app.get(`${api}/:id/comprovante.pdf`, async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const o = await detail(id);
    const photos = await Promise.all(o.attachments.slice(0, 12).map(async (f: any) => ({
      ...f, data: f.mime === 'image/jpeg' || f.mime === 'image/png' ? await storage.get(f.storage_path) : null,
    })));
    const pdf = await workOrderPdf({
      domain: d, order: o, category: categoryOf(o), zone: (await getConfig()).timezone, issuedBy: u.name,
      events: o.events.map((e: any) => ({ ...e, text: eventText(e) })), hoursByWorker: o.hoursByWorker, photos,
    });
    await audit(pool, { actorId: u.id, action: `${D.short.toLowerCase()}.pdf`, entityType: 'work_order', entityId: id, data: { codigo: o.code }, ip: req.ip });
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${o.code}.pdf"`)
      .header('cache-control', 'no-store');
    return reply.send(pdf);
  });

  async function detail(id: string): Promise<any> {
    const row = await one(`SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE w.id = $1 AND w.domain = $2`, [id, d]);
    if (!row) throw notFound(notFoundMsg);
    const [events, stints, files] = await Promise.all([
      q(`SELECT e.id, e.action, e.data, e.created_at, u.name AS actor_name FROM work_order_events e LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.work_order_id = $1 ORDER BY e.created_at, e.id`, [id]),
      q(`SELECT x.user_id, u.name, x.joined_at, x.left_at, x.left_reason FROM work_order_workers x JOIN users u ON u.id = x.user_id
          WHERE x.work_order_id = $1 ORDER BY x.joined_at`, [id]),
      q(`SELECT id, purpose, filename, mime, size_bytes, created_at, storage_path FROM work_order_attachments WHERE work_order_id = $1 ORDER BY created_at`, [id]),
    ]);
    const full = withTimes(row);
    const pauses: Interval[] = full.pauses.map((p: any) => ({ from: p.from, to: p.to }));
    // hours per technician, without paused time
    const byWorker = new Map<string, { id: string; name: string; ms: number }>();
    for (const s of stints) {
      const cur = byWorker.get(s.user_id) ?? { id: s.user_id, name: s.name, ms: 0 };
      cur.ms += workedMs({ from: s.joined_at, to: s.left_at }, pauses);
      byWorker.set(s.user_id, cur);
    }
    return { ...full, events, stints, attachments: files as any[], hoursByWorker: [...byWorker.values()] };
  }

  app.post(api, async (req, reply) => {
    const u = requireUser(req);
    const b = parse(createSchema, req.body);
    if (d === 'manutencao' && !b.kind) throw badRequest('Informe o tipo de manutenção.', { kind: 'obrigatório' });
    if (d === 'ajuste' && !b.reason) throw badRequest('Informe o motivo do ajuste.', { reason: 'obrigatório' });
    if (!domainLocations(d).includes(b.location)) throw badRequest('Ordens de ajuste são abertas somente em máquinas.');
    const place = await one<{ code: string }>('SELECT code FROM assets WHERE active AND type = $1 AND lower(code) = lower($2)', [b.location, b.assetRef]);
    if (!place) throw badRequest(`Escolha ${b.location === 'montagem' ? 'a montagem' : 'a máquina'} da lista.`, { assetRef: 'fora da lista' });
    const material = d === 'ajuste' && b.reason === ADJ_MATERIAL_REASON;
    if (material && (b.virginPct == null || b.regrindPct == null)) throw badRequest('Informe a % de material virgem e a % de moído.');
    const areaId = await domainAreaId(d);
    const out = await withTx(u, req.ip, async (ctx) => {
      if (!(await one('SELECT id FROM areas WHERE id = $1', [b.areaId], ctx.db))) throw badRequest('Setor inválido.');
      const year = DateTime.now().setZone((await getConfig()).timezone).year;
      const seq = d === 'ajuste' ? 'adjustment_order_number_seq' : 'work_order_number_seq';
      const { n } = (await one<{ n: number }>(`SELECT nextval('${seq}')::int AS n`, [], ctx.db))!;
      const priority: WoPriority = b.machineStopped ? 'critica' : 'normal';
      const row = {
        kind: d === 'manutencao' ? b.kind! : null,
        reason: d === 'ajuste' ? b.reason! : null,
        part_number: normalizePn(b.partNumber),
        virgin_pct: material ? b.virginPct : null,
        regrind_pct: material ? b.regrindPct : null,
      };
      const w = (await one<any>(
        `INSERT INTO work_orders (domain, number, code, opened_by, area_id, asset_ref, kind, reason, part_number, virgin_pct, regrind_pct, machine_stopped, description, priority, location_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, code`,
        [d, n, woCode(year, n, d), u.id, b.areaId, place.code, row.kind, row.reason, row.part_number, row.virgin_pct, row.regrind_pct,
          b.machineStopped, b.description, priority, b.location], ctx.db))!;
      const category = categoryOf(row);
      await event(ctx, w.id, 'abriu', {
        local: WO_LOCATION_LABELS[b.location], maquina: place.code, [d === 'ajuste' ? 'motivo' : 'tipo']: category, parada: b.machineStopped,
        ...(row.part_number ? { part_number: row.part_number } : {}),
        ...(material ? { virgem: row.virgin_pct, moido: row.regrind_pct } : {}),
      });
      await audit(ctx.db, { actorId: u.id, action: `${D.short.toLowerCase()}.create`, entityType: 'work_order', entityId: w.id, data: { codigo: w.code, maquina: b.assetRef }, ip: ctx.ip });
      if (priority === 'critica') {
        const team = (await domainTeam(d, ctx.db, areaId)).map((t) => t.id);
        await notify(ctx.db, ctx.events, {
          userIds: team, type: 'os_aberta', exceptUserId: u.id, workOrderId: w.id,
          title: `${w.code}: máquina parada — ${b.assetRef}`, body: `${category} · aberta por ${u.name}. ${b.description.slice(0, 160)}`,
        });
      }
      return w;
    });
    reply.code(201);
    return out;
  });

  app.post(`${api}/:id/attachments`, async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const w = await one<any>('SELECT id, opened_by, status FROM work_orders WHERE id = $1 AND domain = $2', [id, d]);
    if (!w) throw notFound(notFoundMsg);
    const areaId = await domainAreaId(d);
    if (w.opened_by !== u.id && !worksDomain(d, u, areaId)) throw forbidden(`Somente quem abriu a ${D.short} ou a equipe de ${D.team} pode anexar fotos.`);
    const saved: any[] = [];
    let purpose: 'abertura' | 'servico' = 'abertura';
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'purpose' && String(part.value) === 'servico') purpose = 'servico';
        continue;
      }
      const buf = await part.toBuffer();
      if (buf.length === 0) throw badRequest('Arquivo vazio.');
      const mime = (await fileTypeFromBuffer(buf))?.mime as string | undefined;
      if (!mime || !PHOTO_MIME.has(mime)) throw badRequest(`Envie fotos ou vídeos (${part.filename}).`);
      const fileId = crypto.randomUUID();
      const now = new Date();
      const rel = `os/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${fileId}`;
      await storage.put(rel, buf, mime);
      const filename = part.filename.replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'foto';
      try {
        await withTx(u, req.ip, async (ctx) => {
          await q(
            `INSERT INTO work_order_attachments (id, work_order_id, purpose, filename, mime, size_bytes, sha256, storage_path, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [fileId, id, purpose, filename, mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), rel, u.id], ctx.db);
          await event(ctx, id, 'anexou', { arquivo: filename, finalidade: purpose });
        });
      } catch (e) {
        await storage.remove(rel);
        throw e;
      }
      saved.push({ id: fileId, filename, mime, purpose });
    }
    if (!saved.length) throw badRequest('Nenhum arquivo recebido.');
    reply.code(201);
    return saved;
  });

  app.get(`${api}/files/:id`, async (req, reply) => {
    requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const a = await one<any>('SELECT f.* FROM work_order_attachments f JOIN work_orders w ON w.id = f.work_order_id WHERE f.id = $1 AND w.domain = $2', [id, d]);
    if (!a) throw notFound('Arquivo não encontrado.');
    const data = await storage.get(a.storage_path);
    if (!data) throw notFound('Arquivo indisponível no armazenamento.');
    reply.header('Content-Type', a.mime);
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(data);
  });

  // ------------------------------------------------------------ actions

  const act = (name: string, fn: (ctx: Ctx, w: any, body: unknown, areaId: number | null) => Promise<void>) =>
    app.post(`${api}/:id/${name}`, async (req) => {
      const u = requireUser(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const areaId = await domainAreaId(d);
      await withTx(u, req.ip, async (ctx) => fn(ctx, await loadForUpdate(ctx, d, id), req.body, areaId));
      return { ok: true };
    });
  const isTeamMember = (t: any, areaId: number | null) => t?.active && worksDomain(d, { id: t.id, role: t.role, areaId: t.area_id }, areaId);

  /** Accept (first one), join an order already being handled, or take over a hand-over addressed to me. */
  act('aceitar', async (ctx, w, _b, areaId) => {
    guardWorker(d, ctx.actor, areaId);
    assertOpen(w);
    const me = ctx.actor.id;
    const workers = await activeWorkers(ctx, w.id);
    if (workers.includes(me)) throw unprocessable(`Você já está atuando nesta ${D.short}.`);
    await q('INSERT INTO work_order_workers (work_order_id, user_id) VALUES ($1,$2)', [w.id, me], ctx.db);
    if (w.transfer_to === me) {
      await q(`UPDATE work_order_workers SET left_at = now(), left_reason = 'passou' WHERE work_order_id = $1 AND user_id = $2 AND left_at IS NULL`, [w.id, w.transfer_from], ctx.db);
      await q('UPDATE work_orders SET transfer_from = NULL, transfer_to = NULL WHERE id = $1', [w.id], ctx.db);
      const from = await one<{ name: string }>('SELECT name FROM users WHERE id = $1', [w.transfer_from], ctx.db);
      await event(ctx, w.id, 'assumiu', { de: from?.name });
      await notify(ctx.db, ctx.events, { userIds: [w.transfer_from], type: 'os_transferida', workOrderId: w.id, title: `${w.code}: ${ctx.actor.name} assumiu a ${D.short}` });
    } else {
      await event(ctx, w.id, w.status === 'aberta' ? 'aceitou' : 'entrou');
    }
    if (w.status === 'aberta') {
      await q(`UPDATE work_orders SET status = 'em_atendimento', first_accepted_at = COALESCE(first_accepted_at, now()), suggested_to = NULL WHERE id = $1`, [w.id], ctx.db);
      await notify(ctx.db, ctx.events, {
        userIds: [w.opened_by, ...(await areaManagers(ctx.db, areaId))], type: 'os_aceita', exceptUserId: me, workOrderId: w.id,
        title: `${w.code}: ${ctx.actor.name} está atuando`, body: w.asset_ref,
      });
    } else if (w.suggested_to === me) {
      await q('UPDATE work_orders SET suggested_to = NULL WHERE id = $1', [w.id], ctx.db);
    }
  });

  /** Leave the order. The last one to leave returns it to the queue. */
  act('devolver', async (ctx, w, body) => {
    const { motivo } = parse(reason, body);
    assertOpen(w);
    const me = ctx.actor.id;
    const workers = await activeWorkers(ctx, w.id);
    if (!workers.includes(me)) throw unprocessable(`Você não está atuando nesta ${D.short}.`);
    const last = workers.length === 1;
    await q(`UPDATE work_order_workers SET left_at = now(), left_reason = $3 WHERE work_order_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [w.id, me, last ? 'devolveu' : 'saiu'], ctx.db);
    if (w.transfer_from === me) await q('UPDATE work_orders SET transfer_from = NULL, transfer_to = NULL WHERE id = $1', [w.id], ctx.db);
    if (last) {
      await endPause(ctx, w.id);
      await q(`UPDATE work_orders SET status = 'aberta', transfer_from = NULL, transfer_to = NULL WHERE id = $1`, [w.id], ctx.db);
      await notify(ctx.db, ctx.events, {
        userIds: [w.opened_by], type: 'os_devolvida', exceptUserId: me, workOrderId: w.id,
        title: `${w.code} voltou para a fila`, body: `${ctx.actor.name}: ${motivo}`,
      });
    }
    await event(ctx, w.id, last ? 'devolveu' : 'saiu', { motivo });
  });

  /** Hand the order over to a colleague; effective only when they accept. */
  act('passar', async (ctx, w, body, areaId) => {
    const { userId } = parse(z.object({ userId: uuid }), body);
    assertOpen(w);
    const me = ctx.actor.id;
    const workers = await activeWorkers(ctx, w.id);
    if (!workers.includes(me)) throw unprocessable(`Só quem está atuando pode passar a ${D.short}.`);
    if (userId === me || workers.includes(userId)) throw badRequest(`Escolha alguém que ainda não está na ${D.short}.`);
    const target = await one<any>('SELECT id, name, role, area_id, active FROM users WHERE id = $1', [userId], ctx.db);
    if (!isTeamMember(target, areaId)) throw badRequest(`Escolha um ${D.worker} ativo.`);
    await q('UPDATE work_orders SET transfer_from = $2, transfer_to = $3 WHERE id = $1', [w.id, me, userId], ctx.db);
    await event(ctx, w.id, 'passou', { para: target.name });
    await notify(ctx.db, ctx.events, {
      userIds: [userId], type: 'os_transferida', workOrderId: w.id,
      title: `${w.code}: ${ctx.actor.name} quer passar a ${D.short} para você`, body: `${w.asset_ref}. Abra a ${D.short} e aceite para assumir.`,
    });
  });

  /** Decline (receiver) or cancel (sender) a pending hand-over. */
  act('recusar', async (ctx, w) => {
    const me = ctx.actor.id;
    if (!w.transfer_to || (w.transfer_to !== me && w.transfer_from !== me)) throw unprocessable(`Não há passagem pendente para você nesta ${D.short}.`);
    await q('UPDATE work_orders SET transfer_from = NULL, transfer_to = NULL WHERE id = $1', [w.id], ctx.db);
    const declined = w.transfer_to === me;
    await event(ctx, w.id, declined ? 'recusou' : 'cancelou_passagem');
    if (declined) await notify(ctx.db, ctx.events, { userIds: [w.transfer_from], type: 'os_transferida', workOrderId: w.id, title: `${w.code}: ${ctx.actor.name} não aceitou a passagem` });
  });

  const canHandle = async (ctx: Ctx, w: any, areaId: number | null) =>
    leadsDomain(ctx.actor, areaId) || (await activeWorkers(ctx, w.id)).includes(ctx.actor.id);

  act('pausar', async (ctx, w, body, areaId) => {
    const { motivo } = parse(reason, body);
    if (w.status !== 'em_atendimento') throw unprocessable(`Só uma ${D.short} em atendimento pode ser pausada.`);
    if (!(await canHandle(ctx, w, areaId))) throw forbidden(`Só quem está atuando pode pausar a ${D.short}.`);
    await q('INSERT INTO work_order_pauses (work_order_id, reason, started_by) VALUES ($1,$2,$3)', [w.id, motivo, ctx.actor.id], ctx.db);
    await q(`UPDATE work_orders SET status = 'pausada' WHERE id = $1`, [w.id], ctx.db);
    await event(ctx, w.id, 'pausou', { motivo });
  });

  act('retomar', async (ctx, w, _b, areaId) => {
    if (w.status !== 'pausada') throw unprocessable(`Esta ${D.short} não está pausada.`);
    if (!(await canHandle(ctx, w, areaId))) throw forbidden(`Só quem está atuando pode retomar a ${D.short}.`);
    await endPause(ctx, w.id);
    await q(`UPDATE work_orders SET status = 'em_atendimento' WHERE id = $1`, [w.id], ctx.db);
    await event(ctx, w.id, 'retomou');
  });

  act('finalizar', async (ctx, w, body, areaId) => {
    const b = parse(z.object({ servico: z.string().trim().min(1, d === 'ajuste' ? 'descreva a ação tomada' : 'descreva o serviço realizado').max(2000), material: optText(500) }), body);
    if (w.status !== 'em_atendimento' && w.status !== 'pausada') throw unprocessable(`Só uma ${D.short} em atendimento pode ser finalizada.`);
    if (!(await canHandle(ctx, w, areaId))) throw forbidden(`Só quem está atuando pode finalizar a ${D.short}.`);
    await endPause(ctx, w.id);
    await q(`UPDATE work_order_workers SET left_at = now(), left_reason = 'finalizou' WHERE work_order_id = $1 AND left_at IS NULL`, [w.id], ctx.db);
    await q(
      `UPDATE work_orders SET status = 'finalizada', finished_at = now(), finished_by = $2, service_done = $3, material = $4,
              transfer_from = NULL, transfer_to = NULL, suggested_to = NULL, pinned = false WHERE id = $1`,
      [w.id, ctx.actor.id, b.servico, b.material], ctx.db);
    await event(ctx, w.id, 'finalizou', { servico: b.servico, material: b.material });
    await audit(ctx.db, { actorId: ctx.actor.id, action: `${D.short.toLowerCase()}.finish`, entityType: 'work_order', entityId: w.id, data: { codigo: w.code }, ip: ctx.ip });
    await notify(ctx.db, ctx.events, {
      userIds: [w.opened_by, ...(await areaManagers(ctx.db, areaId))], type: 'os_finalizada', exceptUserId: ctx.actor.id, workOrderId: w.id,
      title: `${w.code} finalizada — ${w.asset_ref}`, body: b.servico.slice(0, 200),
    });
  });

  act('prioridade', async (ctx, w, body, areaId) => {
    guardLeader(d, ctx.actor, areaId);
    assertOpen(w);
    const b = parse(z.object({ priority: z.enum(WO_PRIORITIES).optional(), pinned: z.boolean().optional() }), body);
    const data: Record<string, unknown> = {};
    if (b.priority && b.priority !== w.priority) {
      await q('UPDATE work_orders SET priority = $2 WHERE id = $1', [w.id, b.priority], ctx.db);
      data.prioridade = `${WO_PRIORITY_LABELS[w.priority as WoPriority]} → ${WO_PRIORITY_LABELS[b.priority]}`;
    }
    if (b.pinned !== undefined && b.pinned !== w.pinned) {
      await q('UPDATE work_orders SET pinned = $2 WHERE id = $1', [w.id, b.pinned], ctx.db);
      data.topo = b.pinned ? 'fixada no topo da fila' : 'saiu do topo da fila';
    }
    if (Object.keys(data).length) await event(ctx, w.id, 'priorizou', data);
  });

  act('indicar', async (ctx, w, body, areaId) => {
    guardLeader(d, ctx.actor, areaId);
    assertOpen(w);
    const { userId } = parse(z.object({ userId: uuid.nullable() }), body);
    if (userId === w.suggested_to) return;
    let name: string | null = null;
    if (userId) {
      const t = await one<any>('SELECT id, name, role, area_id, active FROM users WHERE id = $1', [userId], ctx.db);
      if (!isTeamMember(t, areaId)) throw badRequest(`Escolha um ${D.worker} ativo.`);
      name = t.name;
    }
    await q('UPDATE work_orders SET suggested_to = $2 WHERE id = $1', [w.id, userId], ctx.db);
    await event(ctx, w.id, 'indicou', { para: name ?? 'ninguém' });
    if (userId) {
      await notify(ctx.db, ctx.events, {
        userIds: [userId], type: 'os_indicada', exceptUserId: ctx.actor.id, workOrderId: w.id,
        title: `${w.code} foi indicada para você`, body: `${w.asset_ref} · ${WO_PRIORITY_LABELS[w.priority as WoPriority]}. Indicada por ${ctx.actor.name}.`,
      });
    }
  });

  app.post(`${api}/:id/purge`, async (req) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden('Somente o administrador pode excluir definitivamente.');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { confirm } = parse(z.object({ confirm: z.string() }), req.body);
    const w = await one<any>('SELECT code FROM work_orders WHERE id = $1 AND domain = $2', [id, d]);
    if (!w) throw notFound(notFoundMsg);
    if (confirm.trim().toUpperCase() !== w.code) throw badRequest(`Digite ${w.code} para confirmar.`);
    const files = await withTx(u, req.ip, async (ctx) => {
      const f = await purgeWorkOrder(ctx.db, id);
      await audit(ctx.db, { actorId: u.id, action: `${D.short.toLowerCase()}.purge`, entityType: 'work_order_purged', data: { codigo: w.code }, ip: ctx.ip });
      ctx.events.push({ type: 'os.changed' });
      return f;
    });
    for (const f of files) await storage.remove(f);
    return { ok: true };
  });

  // ------------------------------------------------------------ dashboard (leadership of the domain's area only)

  const guardDashboard = async (u: SessionUser) => {
    if (!seesDomainDashboard(u, await domainAreaId(d))) throw forbidden(`O painel de ${D.title} é exclusivo dos gestores e líderes de ${D.team}.`);
  };
  const reportRows = async (from: Date, to: Date) => {
    const rows = await q(`SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE w.domain = $3 AND w.opened_at <= $2 AND (w.finished_at IS NULL OR w.finished_at >= $1) ORDER BY w.opened_at`, [from, to, d]);
    return rows.map(withTimes);
  };

  app.get(`${api}/report`, async (req) => {
    const u = requireUser(req);
    await guardDashboard(u);
    const { from, to, zone, match } = await readFilters(req);
    const f = from.toJSDate(), t = to.toJSDate();
    const all = await reportRows(f, t);
    const rows = all.filter(match);
    const ids = new Set(rows.map((r) => r.id));
    const inRange = (x: string | Date | null) => x != null && new Date(x) >= f && new Date(x) <= t;
    const opened = rows.filter((r) => inRange(r.opened_at));
    const finished = rows.filter((r) => inRange(r.finished_at));
    const hours = (msv: number) => msv / 3600_000;
    const avg = (xs: number[]) => (xs.length ? hours(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const now = await q<{ status: WoStatus; priority: WoPriority; machine_stopped: boolean; n: number }>(
      `SELECT status, priority, machine_stopped, count(*)::int AS n FROM work_orders WHERE domain = $1 AND status <> 'finalizada' GROUP BY 1, 2, 3`, [d]);
    const count = (p: (r: (typeof now)[number]) => boolean) => now.filter(p).reduce((a, r) => a + r.n, 0);
    // stopped-machine hours: opening → finish (or now) of orders opened with the machine stopped, clipped to the range
    const clip = (a: string | Date, b: string | Date | null) => Math.max(0, Math.min(t.getTime(), b ? new Date(b).getTime() : Date.now()) - Math.max(f.getTime(), new Date(a).getTime()));
    const stoppedMs = (r: any) => (r.machine_stopped ? clip(r.opened_at, r.finished_at) : 0);

    // time series: by day up to ~2 months, by week up to ~6 months, by month beyond
    const days = to.diff(from, 'days').days;
    const bucket: 'dia' | 'semana' | 'mes' = days <= 62 ? 'dia' : days <= 190 ? 'semana' : 'mes';
    const unit = bucket === 'dia' ? 'day' : bucket === 'semana' ? 'week' : 'month';
    const keyOf = (x: string | Date) => DateTime.fromJSDate(new Date(x)).setZone(zone).startOf(unit).toISODate()!;
    const keys: string[] = [];
    for (let m = from.startOf(unit); m <= to; m = m.plus({ [`${unit}s`]: 1 })) keys.push(m.toISODate()!);
    const series = keys.map((k) => {
      const o = opened.filter((r) => keyOf(r.opened_at) === k);
      const fin = finished.filter((r) => keyOf(r.finished_at) === k);
      return {
        key: k, opened: o.length, finished: fin.length,
        waitH: avg(o.filter((r) => r.first_accepted_at).map((r) => r.times.waitMs)),
        workH: avg(fin.map((r) => r.times.workMs ?? 0)),
      };
    });

    const group = (key: (r: any) => string, label: (r: any) => string) => {
      const m = new Map<string, { key: string; label: string; n: number; stoppedH: number; workMs: number[]; finished: number }>();
      for (const r of rows) {
        const k = key(r);
        const cur = m.get(k) ?? { key: k, label: label(r), n: 0, stoppedH: 0, workMs: [] as number[], finished: 0 };
        if (inRange(r.opened_at)) cur.n++;
        cur.stoppedH += hours(stoppedMs(r));
        if (inRange(r.finished_at)) { cur.finished++; cur.workMs.push(r.times.workMs ?? 0); }
        m.set(k, cur);
      }
      return [...m.values()].filter((x) => x.n || x.stoppedH || x.finished)
        .map(({ workMs, ...x }) => ({ ...x, workH: avg(workMs) }))
        .sort((a, b) => b.n - a.n || b.stoppedH - a.stoppedH);
    };
    const assets = group((r) => r.asset_ref.trim().toUpperCase(), (r) => r.asset_ref.trim())
      .sort((a, b) => b.stoppedH - a.stoppedH || b.n - a.n).slice(0, 12);
    const byCategory = group((r) => String(r.kind ?? r.reason), (r) => categoryOf(r));
    const byArea = group((r) => String(r.area_id), (r) => r.area_name);
    const byPn = group((r) => r.part_number ?? '', (r) => r.part_number ?? '').filter((x) => x.key).slice(0, 15);
    const withPn = opened.filter((r) => r.part_number).length;

    // when problems appear: openings by weekday × hour
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    for (const r of opened) {
      const x = DateTime.fromJSDate(new Date(r.opened_at)).setZone(zone);
      heat[x.weekday - 1][x.hour]++;
    }

    const stints = (await q<any>(
      `SELECT x.work_order_id, x.user_id, u.name, x.joined_at, x.left_at FROM work_order_workers x JOIN users u ON u.id = x.user_id
        JOIN work_orders w ON w.id = x.work_order_id
        WHERE w.domain = $3 AND x.joined_at <= $2 AND (x.left_at IS NULL OR x.left_at >= $1)`, [f, t, d])).filter((s) => ids.has(s.work_order_id));
    const pausesBy = new Map<string, Interval[]>();
    const pauseReasons = new Map<string, { reason: string; n: number; hours: number }>();
    for (const p of await q<any>(
      `SELECT p.work_order_id, p.reason, p.started_at, p.ended_at FROM work_order_pauses p JOIN work_orders w ON w.id = p.work_order_id
        WHERE w.domain = $3 AND p.started_at <= $2 AND (p.ended_at IS NULL OR p.ended_at >= $1)`, [f, t, d])) {
      if (!ids.has(p.work_order_id)) continue;
      pausesBy.set(p.work_order_id, [...(pausesBy.get(p.work_order_id) ?? []), { from: p.started_at, to: p.ended_at }]);
      const cur = pauseReasons.get(p.reason) ?? { reason: p.reason, n: 0, hours: 0 };
      cur.n++;
      cur.hours += hours(clip(p.started_at, p.ended_at));
      pauseReasons.set(p.reason, cur);
    }
    const finishedBy = new Map<string, number>();
    for (const r of finished) if (r.finished_by) finishedBy.set(r.finished_by, (finishedBy.get(r.finished_by) ?? 0) + 1);
    const workers = new Map<string, { id: string; name: string; hours: number; orders: Set<string> }>();
    for (const s of stints) {
      const from_ = new Date(Math.max(f.getTime(), new Date(s.joined_at).getTime()));
      const to_ = new Date(Math.min(t.getTime(), s.left_at ? new Date(s.left_at).getTime() : Date.now()));
      const cur = workers.get(s.user_id) ?? { id: s.user_id, name: s.name, hours: 0, orders: new Set<string>() };
      cur.hours += hours(workedMs({ from: from_, to: to_ }, pausesBy.get(s.work_order_id) ?? []));
      cur.orders.add(s.work_order_id);
      workers.set(s.user_id, cur);
    }

    const waits = opened.filter((r) => r.first_accepted_at).map((r) => r.times.waitMs);
    return {
      from: from.toISODate(), to: to.toISODate(), bucket,
      now: {
        aberta: count((r) => r.status === 'aberta'), em_atendimento: count((r) => r.status === 'em_atendimento'), pausada: count((r) => r.status === 'pausada'),
        criticas: count((r) => r.priority === 'critica'), paradas: count((r) => r.machine_stopped),
      },
      totals: {
        opened: opened.length, finished: finished.length,
        stoppedOpened: opened.filter((r) => r.machine_stopped).length,
        waitH: avg(waits),
        workH: avg(finished.map((r) => r.times.workMs ?? 0)),
        totalH: avg(finished.map((r) => r.times.totalMs)),
        stoppedH: rows.reduce((a, r) => a + hours(stoppedMs(r)), 0),
        // share of orders accepted within 30 minutes of opening
        quickPct: waits.length ? waits.filter((x) => x <= 30 * 60_000).length / waits.length : null,
      },
      series,
      assets,
      byCategory,
      byArea,
      byPn,
      pnCoverage: opened.length ? withPn / opened.length : null,
      heat,
      pauses: [...pauseReasons.values()].sort((a, b) => b.hours - a.hours),
      workers: [...workers.values()].map((w) => ({ id: w.id, name: w.name, hours: w.hours, orders: w.orders.size, finished: finishedBy.get(w.id) ?? 0 }))
        .sort((a, b) => b.hours - a.hours),
      filters: {
        areas: [...new Map(all.map((r) => [r.area_id, { id: r.area_id, name: r.area_name }])).values()],
        categories: [...new Map(all.map((r) => [String(r.kind ?? r.reason), { key: String(r.kind ?? r.reason), label: categoryOf(r) }])).values()],
        partNumbers: [...new Set(all.map((r) => r.part_number).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })),
      },
    };
  });

  app.get(`${api}/export.xlsx`, async (req, reply) => {
    const u = requireUser(req);
    await guardDashboard(u);
    const { from, to, zone, match } = await readFilters(req);
    const rows = (await reportRows(from.toJSDate(), to.toJSDate())).filter((r) => match(r) && new Date(r.opened_at) >= from.toJSDate());
    const dt = (x: string | Date | null): OutCell => ({ v: x ? DateTime.fromJSDate(new Date(x)).setZone(zone).toFormat('dd/MM/yyyy HH:mm') : null });
    const h = (msv: number | null): OutCell => ({ v: msv == null ? null : Math.round((msv / 3600_000) * 100) / 100 });
    const adj = d === 'ajuste';
    const head = [D.short, 'Status', 'Prioridade', 'Setor', 'Local', 'Máquina / montagem', adj ? 'Motivo' : 'Tipo', 'Part number', ...(adj ? ['% virgem', '% moído'] : []),
      'Máquina parada', 'Problema', 'Aberta por', adj ? 'Hora da chamada' : 'Abertura', adj ? 'Hora inicial' : 'Primeiro aceite', adj ? 'Hora final' : 'Finalização',
      'Finalizada por', adj ? 'Ação tomada' : 'Serviço realizado', adj ? 'Observações' : 'Material', 'Espera (h)', adj ? 'Tempo de ajuste (h)' : 'Atendimento (h)', 'Pausado (h)', 'Total (h)'];
    const sheet = {
      name: D.title,
      freezeRow: 1, autoFilterRow: 1,
      widths: [15, 15, 11, 16, 11, 24, adj ? 40 : 12, 16, ...(adj ? [9, 9] : []), 10, 50, 22, 17, 17, 17, 22, 50, 30, 10, 12, 10, 10],
      rows: [
        head.map((v) => ({ v, s: 2 })),
        ...rows.map((r) => [
          { v: r.code }, { v: WO_STATUS_LABELS[r.status as WoStatus] }, { v: WO_PRIORITY_LABELS[r.priority as WoPriority] }, { v: r.area_name },
          { v: r.location_type ? WO_LOCATION_LABELS[r.location_type as WoLocation] : null }, { v: r.asset_ref }, { v: categoryOf(r) }, { v: r.part_number }, ...(adj ? [{ v: r.virgin_pct }, { v: r.regrind_pct }] : []),
          { v: r.machine_stopped ? 'Sim' : 'Não' }, { v: r.description },
          { v: r.opened_by_name }, dt(r.opened_at), dt(r.first_accepted_at), dt(r.finished_at), { v: r.finished_by_name }, { v: r.service_done },
          { v: r.material }, h(r.first_accepted_at ? r.times.waitMs : null), h(r.times.workMs), h(r.times.pausedMs), h(r.finished_at ? r.times.totalMs : null),
        ] as OutCell[]),
      ],
    };
    await audit(pool, { actorId: u.id, action: `${D.short.toLowerCase()}.export`, entityType: 'work_order', data: { ordens: rows.length }, ip: req.ip });
    reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${adj ? 'ordens-ajuste' : 'ordens-manutencao'}-${to.toISODate()}.xlsx"`)
      .header('cache-control', 'no-store');
    return reply.send(writeXlsx([sheet]));
  });
}

/** Test hook: the domain area ids are cached per process. */
export function resetMaintenanceAreaCache() {
  cachedAreaId.clear();
}

// ------------------------------------------------------------ plant panel (Power BI style), administrator and plant manager

const panelQuery = z.object({
  domain: z.enum(WO_DOMAINS).default('manutencao'),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  location: z.enum(WO_LOCATIONS).optional(),
  asset: z.string().trim().max(120).optional(),
  pn: z.string().trim().max(60).optional(),
});

function plantPanelRoutes(app: FastifyInstance) {
  app.get('/api/painel', async (req) => {
    const u = requireUser(req);
    if (!can.viewPlantPanel(u)) throw forbidden('O painel da planta é exclusivo do administrador e do plant manager.');
    const qs = parse(panelQuery, req.query);
    const d = qs.domain;
    const zone = (await getConfig()).timezone;
    const nowDt = DateTime.now().setZone(zone);
    const year = qs.year ?? nowDt.year;
    const yStart = DateTime.fromObject({ year, month: 1, day: 1 }, { zone });
    const yEnd = yStart.endOf('year');
    const nowMs = Date.now();
    const types = qs.location ? [qs.location] : domainLocations(d);
    const places = await placeLists(domainLocations(d));
    const match = (r: any) =>
      (!qs.location || r.location_type === qs.location) &&
      (!qs.asset || r.asset_ref.trim().toUpperCase() === qs.asset.toUpperCase()) &&
      (!qs.pn || r.part_number === normalizePn(qs.pn));

    const rows = (await q(
      `SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE w.domain = $3 AND w.opened_at <= $2 AND (w.finished_at IS NULL OR w.finished_at >= $1) ORDER BY w.opened_at`,
      [yStart.toJSDate(), yEnd.toJSDate(), d])).map(withTimes).filter(match);
    const ids = new Set(rows.map((r) => r.id));
    const hours = (msv: number) => msv / 3600_000;
    const avg = (xs: number[]) => (xs.length ? hours(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const within = (x: string | Date | null, a: number, b: number) => x != null && new Date(x).getTime() >= a && new Date(x).getTime() <= b;
    const clip = (from: string | Date, to: string | Date | null, a: number, b: number) =>
      Math.max(0, Math.min(b, to ? new Date(to).getTime() : nowMs) - Math.max(a, new Date(from).getTime()));
    const downtime = (a: number, b: number) => rows.reduce((t, r) => t + (r.machine_stopped ? clip(r.opened_at, r.finished_at, a, b) : 0), 0);
    // equipment considered for availability: the chosen one, or every registered machine/assembly of the filter
    const units = qs.asset ? 1 : types.reduce((n, t) => n + (places[t]?.length ?? 0), 0) || 1;

    const stats = (a: number, b: number) => {
      const end = Math.min(b, nowMs);
      const opened = rows.filter((r) => within(r.opened_at, a, b));
      const finished = rows.filter((r) => within(r.finished_at, a, b));
      const stops = opened.filter((r) => r.machine_stopped).length;
      const down = downtime(a, end);
      const span = Math.max(0, end - a) * units;
      return {
        opened: opened.length, finished: finished.length, stops,
        downtimeH: hours(down),
        mttrH: avg(finished.map((r) => r.times.workMs ?? 0)),
        waitH: avg(opened.filter((r) => r.first_accepted_at).map((r) => r.times.waitMs)),
        // 24 h/day assumption: share of time the equipment was not stopped by an order
        availability: span > 0 ? Math.max(0, 1 - down / span) : null,
        mtbfH: stops ? hours(Math.max(0, span - down)) / stops : null,
        opened_rows: opened, finished_rows: finished,
      };
    };

    const months = Array.from({ length: 12 }, (_, i) => {
      const m = yStart.plus({ months: i });
      const a = m.toMillis(), b = m.endOf('month').toMillis();
      if (a > nowMs) return { month: i + 1, future: true, opened: 0, finished: 0, stops: 0, downtimeH: null, mttrH: null, waitH: null, availability: null };
      const { opened_rows: _o, finished_rows: _f, mtbfH: _m, ...x } = stats(a, b);
      return { month: i + 1, future: false, ...x };
    });

    const pStart = qs.month ? yStart.plus({ months: qs.month - 1 }) : yStart;
    const pEnd = qs.month ? pStart.endOf('month') : yEnd;
    const a = pStart.toMillis(), b = pEnd.toMillis();
    const { opened_rows, finished_rows, ...period } = stats(a, b);

    const tally = (key: (r: any) => string, label: (r: any) => string, list: any[]) => {
      const m = new Map<string, { key: string; label: string; n: number; downtimeH: number }>();
      for (const r of list) {
        const k = key(r);
        const cur = m.get(k) ?? { key: k, label: label(r), n: 0, downtimeH: 0 };
        cur.n++;
        m.set(k, cur);
      }
      for (const r of rows) {
        const cur = m.get(key(r));
        if (cur && r.machine_stopped) cur.downtimeH += hours(clip(r.opened_at, r.finished_at, a, Math.min(b, nowMs)));
      }
      return [...m.values()].sort((x, y) => y.n - x.n || y.downtimeH - x.downtimeH);
    };

    const stints = (await q<any>(
      `SELECT x.work_order_id, x.user_id, u.name, x.joined_at, x.left_at FROM work_order_workers x JOIN users u ON u.id = x.user_id
        JOIN work_orders w ON w.id = x.work_order_id WHERE w.domain = $3 AND x.joined_at <= $2 AND (x.left_at IS NULL OR x.left_at >= $1)`,
      [new Date(a), new Date(b), d])).filter((x) => ids.has(x.work_order_id));
    const pausesBy = new Map<string, Interval[]>();
    for (const p of await q<any>(
      `SELECT p.work_order_id, p.started_at, p.ended_at FROM work_order_pauses p JOIN work_orders w ON w.id = p.work_order_id
        WHERE w.domain = $1 AND p.started_at <= $3 AND (p.ended_at IS NULL OR p.ended_at >= $2)`, [d, new Date(a), new Date(b)])) {
      pausesBy.set(p.work_order_id, [...(pausesBy.get(p.work_order_id) ?? []), { from: p.started_at, to: p.ended_at }]);
    }
    const workers = new Map<string, { name: string; hours: number; orders: Set<string> }>();
    for (const x of stints) {
      const from_ = new Date(Math.max(a, new Date(x.joined_at).getTime()));
      const to_ = new Date(Math.min(b, x.left_at ? new Date(x.left_at).getTime() : nowMs));
      const cur = workers.get(x.user_id) ?? { name: x.name, hours: 0, orders: new Set<string>() };
      cur.hours += hours(workedMs({ from: from_, to: to_ }, pausesBy.get(x.work_order_id) ?? []));
      cur.orders.add(x.work_order_id);
      workers.set(x.user_id, cur);
    }

    const openNow = rows.filter((r) => r.status !== 'finalizada');
    const lastStop = (await one<{ at: Date | null }>(
      `SELECT max(opened_at) AS at FROM work_orders WHERE domain = $1 AND machine_stopped AND ($2::text IS NULL OR location_type = $2)
          AND ($3::text IS NULL OR upper(trim(asset_ref)) = upper($3))`, [d, qs.location ?? null, qs.asset || null]))?.at ?? null;
    const years = (await q<{ y: number }>(`SELECT DISTINCT extract(year FROM opened_at AT TIME ZONE $1)::int AS y FROM work_orders ORDER BY 1`, [zone])).map((r) => r.y);

    return {
      domain: d, year, month: qs.month ?? null,
      years: [...new Set([...years, nowDt.year])].sort(),
      places,
      units,
      period,
      now: {
        open: openNow.length,
        waiting: openNow.filter((r) => r.status === 'aberta').length,
        stopped: openNow.filter((r) => r.machine_stopped).length,
        daysSinceStop: lastStop ? Math.floor((nowMs - new Date(lastStop).getTime()) / 86_400_000) : null,
      },
      months,
      byCategory: tally((r) => String(r.kind ?? r.reason), (r) => categoryOf(r), opened_rows),
      byAsset: tally((r) => r.asset_ref.trim().toUpperCase(), (r) => r.asset_ref.trim(), opened_rows).slice(0, 12),
      byLocation: tally((r) => r.location_type ?? 'sem', (r) => (r.location_type ? WO_LOCATION_LABELS[r.location_type as WoLocation] : 'Sem local'), opened_rows),
      byArea: tally((r) => String(r.area_id), (r) => r.area_name, opened_rows),
      byPn: tally((r) => r.part_number ?? '', (r) => r.part_number ?? '', opened_rows).filter((x) => x.key).slice(0, 12),
      partNumbers: (await q<{ pn: string }>(`SELECT DISTINCT part_number AS pn FROM work_orders WHERE domain = $1 AND part_number IS NOT NULL`, [d]))
        .map((r) => r.pn).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })),
      byWorker: [...workers.values()].map((w) => ({ name: w.name, hours: w.hours, orders: w.orders.size })).sort((x, y) => y.hours - x.hours),
      finishedCount: finished_rows.length,
    };
  });
}
