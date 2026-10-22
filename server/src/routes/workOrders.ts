import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  leadsMaintenance, MAINTENANCE_AREA_SLUG, WO_KIND_LABELS, WO_KINDS, WO_PRIORITIES, WO_PRIORITY_LABELS, WO_STATUS_LABELS, woCode, workedMs,
  worksMaintenance, woTimes, type Interval, type WoKind, type WoPriority, type WoStatus,
} from '../../../shared/maintenance.js';
import { audit } from '../audit.js';
import { requireUser } from '../auth.js';
import { withTx, type Ctx, type SessionUser } from '../context.js';
import { one, pool, q, type Db } from '../db.js';
import { badRequest, forbidden, notFound, unprocessable } from '../errors.js';
import { notify } from '../notify.js';
import { purgeWorkOrder } from '../services/purge.js';
import { writeXlsx, type OutCell } from '../services/xlsx.js';
import { getConfig } from '../settings.js';
import { storage } from '../storage.js';
import { optText, parse, uuid } from '../validation.js';

const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime']);

let cachedAreaId: number | null | undefined;
async function maintenanceAreaId(): Promise<number | null> {
  if (cachedAreaId === undefined) cachedAreaId = (await one<{ id: number }>('SELECT id FROM areas WHERE slug = $1', [MAINTENANCE_AREA_SLUG]))?.id ?? null;
  return cachedAreaId;
}

/** Maintainers and maintenance leadership (who can receive an order). */
async function maintenanceTeam(db: Db, areaId: number | null) {
  return q<{ id: string; name: string; role: string }>(
    `SELECT id, name, role FROM users WHERE active AND (role = 'manutentor' OR (role IN ('gestor','lider') AND area_id = $1)) ORDER BY role = 'manutentor' DESC, name`,
    [areaId], db);
}

const LIST_COLS = `w.id, w.number, w.code, w.opened_by, w.area_id, w.asset_ref, w.kind, w.machine_stopped, w.description, w.priority, w.pinned,
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

async function loadForUpdate(ctx: Ctx, id: string) {
  const w = await one<any>('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id], ctx.db);
  if (!w) throw notFound('OS não encontrada.');
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

/** Gerente (gestor) of the maintenance area: kept informed of acceptance and finish. */
async function maintenanceManagers(db: Db, areaId: number | null) {
  return (await q<{ id: string }>(`SELECT id FROM users WHERE active AND role = 'gestor' AND area_id = $1`, [areaId], db)).map((r) => r.id);
}

function guardWorker(u: SessionUser, areaId: number | null) {
  if (!worksMaintenance(u, areaId)) throw forbidden('Somente a equipe de manutenção atua nas OS.');
}
function guardLeader(u: SessionUser, areaId: number | null) {
  if (!leadsMaintenance(u, areaId)) throw forbidden('Somente o gerente e o líder de manutenção podem fazer isso.');
}
const assertOpen = (w: any) => {
  if (w.status === 'finalizada') throw unprocessable('Esta OS já foi finalizada.');
};

const createSchema = z.object({
  areaId: z.number().int().positive(),
  assetRef: z.string().trim().min(1, 'obrigatório').max(120),
  kind: z.enum(WO_KINDS),
  machineStopped: z.boolean(),
  description: z.string().trim().min(1, 'obrigatório').max(2000),
});
const reason = z.object({ motivo: z.string().trim().min(1, 'informe o motivo').max(300) });

async function readRange(req: FastifyRequest) {
  const qs = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
  const zone = (await getConfig()).timezone;
  const to = qs.to ? DateTime.fromISO(qs.to, { zone }) : DateTime.now().setZone(zone);
  const from = qs.from ? DateTime.fromISO(qs.from, { zone }) : to.minus({ months: 5 }).startOf('month');
  return { from: from.startOf('day'), to: to.endOf('day'), zone };
}

export async function workOrderRoutes(app: FastifyInstance) {
  app.get('/api/os/options', async (req) => {
    const u = requireUser(req);
    const areaId = await maintenanceAreaId();
    const [areas, team] = await Promise.all([
      q('SELECT id, slug, name, color FROM areas WHERE active ORDER BY sort'),
      maintenanceTeam(pool, areaId),
    ]);
    return { areas, team, maintenanceAreaId: areaId, canWork: worksMaintenance(u, areaId), canLead: leadsMaintenance(u, areaId) };
  });

  /** Machines: registered assets first, then references already used in orders. */
  app.get('/api/os/assets', async (req) => {
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

  app.get('/api/os', async (req) => {
    requireUser(req);
    const qs = parse(z.object({
      view: z.enum(['abertas', 'finalizadas']).default('abertas'),
      q: z.string().max(100).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), req.query);
    const term = qs.q?.trim() ? `%${qs.q.trim()}%` : null;
    const search = `($1::text IS NULL OR w.code ILIKE $1 OR w.asset_ref ILIKE $1 OR w.description ILIKE $1 OR w.service_done ILIKE $1)`;
    if (qs.view === 'abertas') {
      const rows = await q(`SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE w.status <> 'finalizada' AND ${search} ORDER BY ${QUEUE_ORDER}`, [term]);
      return rows.map(withTimes);
    }
    const zone = (await getConfig()).timezone;
    const from = qs.from ? DateTime.fromISO(qs.from, { zone }).startOf('day').toJSDate() : null;
    const to = qs.to ? DateTime.fromISO(qs.to, { zone }).endOf('day').toJSDate() : null;
    const rows = await q(
      `SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE w.status = 'finalizada' AND ${search}
          AND ($2::timestamptz IS NULL OR w.finished_at >= $2) AND ($3::timestamptz IS NULL OR w.finished_at <= $3)
        ORDER BY w.finished_at DESC LIMIT 300`, [term, from, to]);
    return rows.map(withTimes);
  });

  app.get('/api/os/:id', async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const row = await one(`SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE w.id = $1`, [id]);
    if (!row) throw notFound('OS não encontrada.');
    const [events, stints, files] = await Promise.all([
      q(`SELECT e.id, e.action, e.data, e.created_at, u.name AS actor_name FROM work_order_events e LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.work_order_id = $1 ORDER BY e.created_at, e.id`, [id]),
      q(`SELECT x.user_id, u.name, x.joined_at, x.left_at, x.left_reason FROM work_order_workers x JOIN users u ON u.id = x.user_id
          WHERE x.work_order_id = $1 ORDER BY x.joined_at`, [id]),
      q(`SELECT id, purpose, filename, mime, size_bytes, created_at FROM work_order_attachments WHERE work_order_id = $1 ORDER BY created_at`, [id]),
    ]);
    const full = withTimes(row);
    const pauses: Interval[] = full.pauses.map((p: any) => ({ from: p.from, to: p.to }));
    // hours per maintainer, without paused time
    const byWorker = new Map<string, { id: string; name: string; ms: number }>();
    for (const s of stints) {
      const cur = byWorker.get(s.user_id) ?? { id: s.user_id, name: s.name, ms: 0 };
      cur.ms += workedMs({ from: s.joined_at, to: s.left_at }, pauses);
      byWorker.set(s.user_id, cur);
    }
    return { ...full, events, stints, attachments: files, hoursByWorker: [...byWorker.values()] };
  });

  app.post('/api/os', async (req, reply) => {
    const u = requireUser(req);
    const b = parse(createSchema, req.body);
    const areaId = await maintenanceAreaId();
    const out = await withTx(u, req.ip, async (ctx) => {
      if (!(await one('SELECT id FROM areas WHERE id = $1', [b.areaId], ctx.db))) throw badRequest('Setor inválido.');
      const year = DateTime.now().setZone((await getConfig()).timezone).year;
      const { n } = (await one<{ n: number }>(`SELECT nextval('work_order_number_seq')::int AS n`, [], ctx.db))!;
      const priority: WoPriority = b.machineStopped ? 'critica' : 'normal';
      const w = (await one<any>(
        `INSERT INTO work_orders (number, code, opened_by, area_id, asset_ref, kind, machine_stopped, description, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code`,
        [n, woCode(year, n), u.id, b.areaId, b.assetRef, b.kind, b.machineStopped, b.description, priority], ctx.db))!;
      await event(ctx, w.id, 'abriu', { maquina: b.assetRef, tipo: WO_KIND_LABELS[b.kind], parada: b.machineStopped });
      await audit(ctx.db, { actorId: u.id, action: 'os.create', entityType: 'work_order', entityId: w.id, data: { codigo: w.code, maquina: b.assetRef }, ip: ctx.ip });
      if (priority === 'critica') {
        const team = (await maintenanceTeam(ctx.db, areaId)).map((t) => t.id);
        await notify(ctx.db, ctx.events, {
          userIds: team, type: 'os_aberta', exceptUserId: u.id, workOrderId: w.id,
          title: `${w.code}: máquina parada — ${b.assetRef}`, body: `${WO_KIND_LABELS[b.kind]} · aberta por ${u.name}. ${b.description.slice(0, 160)}`,
        });
      }
      return w;
    });
    reply.code(201);
    return out;
  });

  app.post('/api/os/:id/attachments', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const w = await one<any>('SELECT id, opened_by, status FROM work_orders WHERE id = $1', [id]);
    if (!w) throw notFound('OS não encontrada.');
    const areaId = await maintenanceAreaId();
    if (w.opened_by !== u.id && !worksMaintenance(u, areaId)) throw forbidden('Somente quem abriu a OS ou a manutenção pode anexar fotos.');
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

  app.get('/api/os/files/:id', async (req, reply) => {
    requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const a = await one<any>('SELECT * FROM work_order_attachments WHERE id = $1', [id]);
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
    app.post(`/api/os/:id/${name}`, async (req) => {
      const u = requireUser(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const areaId = await maintenanceAreaId();
      await withTx(u, req.ip, async (ctx) => fn(ctx, await loadForUpdate(ctx, id), req.body, areaId));
      return { ok: true };
    });

  /** Accept (first one), join an order already being handled, or take over a hand-over addressed to me. */
  act('aceitar', async (ctx, w, _b, areaId) => {
    guardWorker(ctx.actor, areaId);
    assertOpen(w);
    const me = ctx.actor.id;
    const workers = await activeWorkers(ctx, w.id);
    if (workers.includes(me)) throw unprocessable('Você já está atuando nesta OS.');
    await q('INSERT INTO work_order_workers (work_order_id, user_id) VALUES ($1,$2)', [w.id, me], ctx.db);
    if (w.transfer_to === me) {
      await q(`UPDATE work_order_workers SET left_at = now(), left_reason = 'passou' WHERE work_order_id = $1 AND user_id = $2 AND left_at IS NULL`, [w.id, w.transfer_from], ctx.db);
      await q('UPDATE work_orders SET transfer_from = NULL, transfer_to = NULL WHERE id = $1', [w.id], ctx.db);
      const from = await one<{ name: string }>('SELECT name FROM users WHERE id = $1', [w.transfer_from], ctx.db);
      await event(ctx, w.id, 'assumiu', { de: from?.name });
      await notify(ctx.db, ctx.events, { userIds: [w.transfer_from], type: 'os_transferida', workOrderId: w.id, title: `${w.code}: ${ctx.actor.name} assumiu a OS` });
    } else {
      await event(ctx, w.id, w.status === 'aberta' ? 'aceitou' : 'entrou');
    }
    if (w.status === 'aberta') {
      await q(`UPDATE work_orders SET status = 'em_atendimento', first_accepted_at = COALESCE(first_accepted_at, now()), suggested_to = NULL WHERE id = $1`, [w.id], ctx.db);
      await notify(ctx.db, ctx.events, {
        userIds: [w.opened_by, ...(await maintenanceManagers(ctx.db, areaId))], type: 'os_aceita', exceptUserId: me, workOrderId: w.id,
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
    if (!workers.includes(me)) throw unprocessable('Você não está atuando nesta OS.');
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
    if (!workers.includes(me)) throw unprocessable('Só quem está atuando pode passar a OS.');
    if (userId === me || workers.includes(userId)) throw badRequest('Escolha alguém que ainda não está na OS.');
    const target = await one<any>('SELECT id, name, role, area_id, active FROM users WHERE id = $1', [userId], ctx.db);
    if (!target?.active || !worksMaintenance({ id: target.id, role: target.role, areaId: target.area_id }, areaId)) throw badRequest('Escolha um manutentor ativo.');
    await q('UPDATE work_orders SET transfer_from = $2, transfer_to = $3 WHERE id = $1', [w.id, me, userId], ctx.db);
    await event(ctx, w.id, 'passou', { para: target.name });
    await notify(ctx.db, ctx.events, {
      userIds: [userId], type: 'os_transferida', workOrderId: w.id,
      title: `${w.code}: ${ctx.actor.name} quer passar a OS para você`, body: `${w.asset_ref}. Abra a OS e aceite para assumir.`,
    });
  });

  /** Decline (receiver) or cancel (sender) a pending hand-over. */
  act('recusar', async (ctx, w) => {
    const me = ctx.actor.id;
    if (!w.transfer_to || (w.transfer_to !== me && w.transfer_from !== me)) throw unprocessable('Não há passagem pendente para você nesta OS.');
    await q('UPDATE work_orders SET transfer_from = NULL, transfer_to = NULL WHERE id = $1', [w.id], ctx.db);
    const declined = w.transfer_to === me;
    await event(ctx, w.id, declined ? 'recusou' : 'cancelou_passagem');
    if (declined) await notify(ctx.db, ctx.events, { userIds: [w.transfer_from], type: 'os_transferida', workOrderId: w.id, title: `${w.code}: ${ctx.actor.name} não aceitou a passagem` });
  });

  const canHandle = async (ctx: Ctx, w: any, areaId: number | null) =>
    leadsMaintenance(ctx.actor, areaId) || (await activeWorkers(ctx, w.id)).includes(ctx.actor.id);

  act('pausar', async (ctx, w, body, areaId) => {
    const { motivo } = parse(reason, body);
    if (w.status !== 'em_atendimento') throw unprocessable('Só uma OS em atendimento pode ser pausada.');
    if (!(await canHandle(ctx, w, areaId))) throw forbidden('Só quem está atuando pode pausar a OS.');
    await q('INSERT INTO work_order_pauses (work_order_id, reason, started_by) VALUES ($1,$2,$3)', [w.id, motivo, ctx.actor.id], ctx.db);
    await q(`UPDATE work_orders SET status = 'pausada' WHERE id = $1`, [w.id], ctx.db);
    await event(ctx, w.id, 'pausou', { motivo });
  });

  act('retomar', async (ctx, w, _b, areaId) => {
    if (w.status !== 'pausada') throw unprocessable('Esta OS não está pausada.');
    if (!(await canHandle(ctx, w, areaId))) throw forbidden('Só quem está atuando pode retomar a OS.');
    await endPause(ctx, w.id);
    await q(`UPDATE work_orders SET status = 'em_atendimento' WHERE id = $1`, [w.id], ctx.db);
    await event(ctx, w.id, 'retomou');
  });

  act('finalizar', async (ctx, w, body, areaId) => {
    const b = parse(z.object({ servico: z.string().trim().min(1, 'descreva o serviço realizado').max(2000), material: optText(500) }), body);
    if (w.status !== 'em_atendimento' && w.status !== 'pausada') throw unprocessable('Só uma OS em atendimento pode ser finalizada.');
    if (!(await canHandle(ctx, w, areaId))) throw forbidden('Só quem está atuando pode finalizar a OS.');
    await endPause(ctx, w.id);
    await q(`UPDATE work_order_workers SET left_at = now(), left_reason = 'finalizou' WHERE work_order_id = $1 AND left_at IS NULL`, [w.id], ctx.db);
    await q(
      `UPDATE work_orders SET status = 'finalizada', finished_at = now(), finished_by = $2, service_done = $3, material = $4,
              transfer_from = NULL, transfer_to = NULL, suggested_to = NULL, pinned = false WHERE id = $1`,
      [w.id, ctx.actor.id, b.servico, b.material], ctx.db);
    await event(ctx, w.id, 'finalizou', { servico: b.servico, material: b.material });
    await audit(ctx.db, { actorId: ctx.actor.id, action: 'os.finish', entityType: 'work_order', entityId: w.id, data: { codigo: w.code }, ip: ctx.ip });
    await notify(ctx.db, ctx.events, {
      userIds: [w.opened_by, ...(await maintenanceManagers(ctx.db, areaId))], type: 'os_finalizada', exceptUserId: ctx.actor.id, workOrderId: w.id,
      title: `${w.code} finalizada — ${w.asset_ref}`, body: b.servico.slice(0, 200),
    });
  });

  act('prioridade', async (ctx, w, body, areaId) => {
    guardLeader(ctx.actor, areaId);
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
    guardLeader(ctx.actor, areaId);
    assertOpen(w);
    const { userId } = parse(z.object({ userId: uuid.nullable() }), body);
    if (userId === w.suggested_to) return;
    let name: string | null = null;
    if (userId) {
      const t = await one<any>('SELECT id, name, role, area_id, active FROM users WHERE id = $1', [userId], ctx.db);
      if (!t?.active || !worksMaintenance({ id: t.id, role: t.role, areaId: t.area_id }, areaId)) throw badRequest('Escolha um manutentor ativo.');
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

  app.post('/api/os/:id/purge', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden('Somente o administrador pode excluir definitivamente.');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { confirm } = parse(z.object({ confirm: z.string() }), req.body);
    const w = await one<any>('SELECT code FROM work_orders WHERE id = $1', [id]);
    if (!w) throw notFound('OS não encontrada.');
    if (confirm.trim().toUpperCase() !== w.code) throw badRequest(`Digite ${w.code} para confirmar.`);
    const files = await withTx(u, req.ip, async (ctx) => {
      const f = await purgeWorkOrder(ctx.db, id);
      await audit(ctx.db, { actorId: u.id, action: 'os.purge', entityType: 'work_order_purged', data: { codigo: w.code }, ip: ctx.ip });
      ctx.events.push({ type: 'os.changed' });
      return f;
    });
    for (const f of files) await storage.remove(f);
    return { ok: true };
  });

  // ------------------------------------------------------------ indicators

  const reportRows = async (from: Date, to: Date) => {
    const rows = await q(`SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE w.opened_at <= $2 AND (w.finished_at IS NULL OR w.finished_at >= $1) ORDER BY w.opened_at`, [from, to]);
    return rows.map(withTimes);
  };

  app.get('/api/os/report', async (req) => {
    const u = requireUser(req);
    const areaId = await maintenanceAreaId();
    if (!leadsMaintenance(u, areaId) && u.role !== 'gestor' && u.role !== 'lider') throw forbidden();
    const { from, to, zone } = await readRange(req);
    const f = from.toJSDate(), t = to.toJSDate();
    const rows = await reportRows(f, t);
    const inRange = (d: string | Date | null) => d != null && new Date(d) >= f && new Date(d) <= t;
    const opened = rows.filter((r) => inRange(r.opened_at));
    const finished = rows.filter((r) => inRange(r.finished_at));
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length / 3600_000 : null);
    const now = await q<{ status: WoStatus; priority: WoPriority; n: number }>(
      `SELECT status, priority, count(*)::int AS n FROM work_orders WHERE status <> 'finalizada' GROUP BY 1, 2`);
    const count = (s: WoStatus) => now.filter((r) => r.status === s).reduce((a, r) => a + r.n, 0);

    const monthKey = (d: string | Date) => DateTime.fromJSDate(new Date(d)).setZone(zone).toFormat('yyyy-MM');
    const months: string[] = [];
    for (let m = from.startOf('month'); m <= to; m = m.plus({ months: 1 })) months.push(m.toFormat('yyyy-MM'));
    const byMonth = months.map((m) => {
      const o = opened.filter((r) => monthKey(r.opened_at) === m);
      const fin = finished.filter((r) => monthKey(r.finished_at) === m);
      return {
        month: m, opened: o.length, finished: fin.length,
        waitH: avg(o.filter((r) => r.first_accepted_at).map((r) => r.times.waitMs)),
        workH: avg(fin.map((r) => r.times.workMs ?? 0)),
      };
    });

    // stopped-machine hours: opening → finish (or now) of orders opened with the machine stopped, clipped to the range
    const clip = (a: string | Date, b: string | Date | null) => Math.max(0, Math.min(t.getTime(), b ? new Date(b).getTime() : Date.now()) - Math.max(f.getTime(), new Date(a).getTime()));
    const assets = new Map<string, { asset: string; orders: number; stoppedH: number }>();
    for (const r of rows) {
      const k = r.asset_ref.trim().toUpperCase();
      const cur = assets.get(k) ?? { asset: r.asset_ref.trim(), orders: 0, stoppedH: 0 };
      if (inRange(r.opened_at)) cur.orders++;
      if (r.machine_stopped) cur.stoppedH += clip(r.opened_at, r.finished_at) / 3600_000;
      assets.set(k, cur);
    }
    const tally = <K extends string>(key: (r: any) => K) => {
      const m = new Map<K, number>();
      for (const r of opened) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
      return [...m.entries()].map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n);
    };

    const stints = await q<any>(
      `SELECT x.work_order_id, x.user_id, u.name, x.joined_at, x.left_at FROM work_order_workers x JOIN users u ON u.id = x.user_id
        WHERE x.joined_at <= $2 AND (x.left_at IS NULL OR x.left_at >= $1)`, [f, t]);
    const pausesBy = new Map<string, Interval[]>();
    for (const p of await q<any>(`SELECT work_order_id, started_at, ended_at FROM work_order_pauses WHERE started_at <= $2 AND (ended_at IS NULL OR ended_at >= $1)`, [f, t])) {
      pausesBy.set(p.work_order_id, [...(pausesBy.get(p.work_order_id) ?? []), { from: p.started_at, to: p.ended_at }]);
    }
    const workers = new Map<string, { id: string; name: string; hours: number; orders: Set<string> }>();
    for (const s of stints) {
      const from_ = new Date(Math.max(f.getTime(), new Date(s.joined_at).getTime()));
      const to_ = new Date(Math.min(t.getTime(), s.left_at ? new Date(s.left_at).getTime() : Date.now()));
      const cur = workers.get(s.user_id) ?? { id: s.user_id, name: s.name, hours: 0, orders: new Set<string>() };
      cur.hours += workedMs({ from: from_, to: to_ }, pausesBy.get(s.work_order_id) ?? []) / 3600_000;
      cur.orders.add(s.work_order_id);
      workers.set(s.user_id, cur);
    }

    return {
      from: from.toISODate(), to: to.toISODate(),
      now: { aberta: count('aberta'), em_atendimento: count('em_atendimento'), pausada: count('pausada'), criticas: now.filter((r) => r.priority === 'critica').reduce((a, r) => a + r.n, 0) },
      totals: {
        opened: opened.length, finished: finished.length,
        waitH: avg(opened.filter((r) => r.first_accepted_at).map((r) => r.times.waitMs)),
        workH: avg(finished.map((r) => r.times.workMs ?? 0)),
        stoppedH: [...assets.values()].reduce((a, x) => a + x.stoppedH, 0),
      },
      byMonth,
      assets: [...assets.values()].filter((a) => a.orders > 0 || a.stoppedH > 0).sort((a, b) => b.stoppedH - a.stoppedH || b.orders - a.orders).slice(0, 10),
      byKind: tally((r) => r.kind as WoKind),
      byArea: tally((r) => r.area_name as string),
      workers: [...workers.values()].map((w) => ({ id: w.id, name: w.name, hours: w.hours, orders: w.orders.size })).sort((a, b) => b.hours - a.hours),
    };
  });

  app.get('/api/os/export.xlsx', async (req, reply) => {
    const u = requireUser(req);
    const areaId = await maintenanceAreaId();
    if (!leadsMaintenance(u, areaId) && u.role !== 'gestor' && u.role !== 'lider') throw forbidden();
    const { from, to, zone } = await readRange(req);
    const rows = (await reportRows(from.toJSDate(), to.toJSDate())).filter((r) => new Date(r.opened_at) >= from.toJSDate());
    const dt = (d: string | Date | null): OutCell => ({ v: d ? DateTime.fromJSDate(new Date(d)).setZone(zone).toFormat('dd/MM/yyyy HH:mm') : null });
    const h = (msv: number | null): OutCell => ({ v: msv == null ? null : Math.round((msv / 3600_000) * 100) / 100 });
    const head = ['OS', 'Status', 'Prioridade', 'Setor', 'Máquina / dispositivo', 'Tipo', 'Máquina parada', 'Problema', 'Aberta por', 'Abertura',
      'Primeiro aceite', 'Finalização', 'Finalizada por', 'Serviço realizado', 'Material', 'Espera (h)', 'Atendimento (h)', 'Pausado (h)', 'Total (h)'];
    const sheet = {
      name: 'Ordens de manutenção',
      freezeRow: 1, autoFilterRow: 1,
      widths: [15, 15, 11, 16, 24, 12, 10, 50, 22, 17, 17, 17, 22, 50, 30, 10, 12, 10, 10],
      rows: [
        head.map((v) => ({ v, s: 2 })),
        ...rows.map((r) => [
          { v: r.code }, { v: WO_STATUS_LABELS[r.status as WoStatus] }, { v: WO_PRIORITY_LABELS[r.priority as WoPriority] }, { v: r.area_name },
          { v: r.asset_ref }, { v: WO_KIND_LABELS[r.kind as WoKind] }, { v: r.machine_stopped ? 'Sim' : 'Não' }, { v: r.description },
          { v: r.opened_by_name }, dt(r.opened_at), dt(r.first_accepted_at), dt(r.finished_at), { v: r.finished_by_name }, { v: r.service_done },
          { v: r.material }, h(r.first_accepted_at ? r.times.waitMs : null), h(r.times.workMs), h(r.times.pausedMs), h(r.finished_at ? r.times.totalMs : null),
        ] as OutCell[]),
      ],
    };
    await audit(pool, { actorId: u.id, action: 'os.export', entityType: 'work_order', data: { ordens: rows.length }, ip: req.ip });
    reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="ordens-manutencao-${to.toISODate()}.xlsx"`)
      .header('cache-control', 'no-store');
    return reply.send(writeXlsx([sheet]));
  });
}

/** Test hook: the maintenance area id is cached per process. */
export function resetMaintenanceAreaCache() {
  cachedAreaId = undefined;
}
