import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import { COMPLEXITIES, PRIORITIES, PRIORITY_LABELS, SOURCES, STATUS_LABELS, STATUSES } from '../../../shared/constants.js';
import { can } from '../../../shared/permissions.js';
import { audit } from '../audit.js';
import { requireUser } from '../auth.js';
import { withTx } from '../context.js';
import { one, q } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { addClient } from '../realtime.js';
import * as svc from '../services/issues.js';
import { findSimilar, getIssueDetail, listIssues, type IssueFilters } from '../services/queries.js';
import { getConfig } from '../settings.js';
import { storage } from '../storage.js';
import { optText, parse, uuid } from '../validation.js';

const version = z.number().int().positive().nullish().transform((v) => v ?? null);
const list = z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).filter(Boolean)));

export const filtersSchema = z.object({
  areaId: z.coerce.number().int().positive().optional(),
  areaScope: z.enum(['current', 'involved']).optional(),
  assigneeId: z.string().optional(),
  openedById: z.string().uuid().optional(),
  stepAssigneeId: z.string().uuid().optional(),
  priority: list,
  status: list,
  categoryId: z.coerce.number().int().positive().optional(),
  source: z.enum(SOURCES).optional(),
  openedFrom: z.string().optional(),
  openedTo: z.string().optional(),
  dueFrom: z.string().optional(),
  dueTo: z.string().optional(),
  flag: z.string().optional(),
  q: z.string().max(200).optional(),
  sort: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
});

export function readFilters(req: FastifyRequest): IssueFilters {
  const f = parse(filtersSchema, req.query);
  if (f.assigneeId === 'me') f.assigneeId = req.user!.id;
  else if (f.assigneeId && !uuid.safeParse(f.assigneeId).success) throw badRequest('Responsável inválido.');
  return f as IssueFilters;
}

const stepSchema = z.object({
  title: z.string().trim().min(1, 'obrigatório').max(200),
  description: optText(2000),
  mandatory: z.boolean().optional(),
  assigneeId: uuid.nullish(),
  dueAt: z.coerce.date().nullish(),
  dependsOn: z.array(uuid).optional(),
});

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf', 'video/mp4', 'video/quicktime',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export async function issueRoutes(app: FastifyInstance) {
  app.get('/api/issues', async (req) => {
    requireUser(req);
    return listIssues(readFilters(req), await getConfig());
  });

  app.get('/api/issues/export.csv', async (req, reply) => {
    const u = requireUser(req);
    const cfg = await getConfig();
    const { items } = await listIssues({ ...readFilters(req), limit: 1000 }, cfg);
    const f = (d: any) => (d ? svc.fmt(d, cfg.timezone) : '');
    const rows = [
      ['Código', 'Título', 'Área', 'Área de origem', 'Responsável', 'Aberta por', 'Prioridade', 'Status', 'Atrasada', 'Abertura', 'Prazo', 'Prazo original', 'Conclusão', 'Validação', 'Categoria', 'Referência', 'Etapas', 'Reaberturas'],
      ...items.map((i: any) => [i.code, i.title, i.area_name, i.origin_area_name, i.assignee_name ?? '', i.opened_by_name, PRIORITY_LABELS[i.priority as keyof typeof PRIORITY_LABELS],
        STATUS_LABELS[i.status as keyof typeof STATUS_LABELS], i.is_overdue ? 'Sim' : 'Não', f(i.opened_at), f(i.due_at), f(i.original_due_at), f(i.completed_at), f(i.validated_at),
        i.category_name ?? '', i.asset_ref ?? '', i.steps_total ? `${i.steps_done}/${i.steps_total}` : '', i.reopen_count]),
    ];
    await audit((await import('../db.js')).pool, { actorId: u.id, action: 'report.export', entityType: 'issues', data: { linhas: items.length }, ip: req.ip });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="pendencias-${new Date().toISOString().slice(0, 10)}.csv"`);
    return '﻿' + toCsv(rows);
  });

  app.get('/api/issues/similar', async (req) => {
    requireUser(req);
    const qs = parse(z.object({ title: z.string().max(300).default(''), assetRef: z.string().max(100).optional(), areaId: z.coerce.number().optional() }), req.query);
    return findSimilar(qs.title, qs.assetRef ?? null, qs.areaId ?? null);
  });

  app.get('/api/issues/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return getIssueDetail(id, u, await getConfig());
  });

  app.post('/api/issues', async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({
      title: z.string().trim().min(1, 'O título é obrigatório').max(200),
      description: optText(4000),
      areaId: z.number().int().positive(),
      assigneeId: uuid.nullish(),
      priority: z.enum(PRIORITIES).default('media'),
      categoryId: z.number().int().positive().nullish(),
      assetType: optText(30),
      assetRef: optText(100),
      expectedAction: optText(2000),
      nextAction: optText(500),
      source: z.enum(SOURCES).default('fast_response'),
      recurrenceOfId: uuid.nullish(),
      customDueAt: z.coerce.date().nullish(),
      customDueReason: optText(500),
      steps: z.array(stepSchema.omit({ dependsOn: true })).max(30).optional(),
    }), req.body);
    const issue = await withTx(u, req.ip, (ctx) => svc.createIssue(ctx, body));
    reply.code(201);
    return { id: issue.id, code: issue.code };
  });

  app.patch('/api/issues/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({
      version: z.number().int().positive(),
      title: z.string().max(200).optional(),
      description: optText(4000).optional(),
      priority: z.enum(PRIORITIES).optional(),
      categoryId: z.number().int().positive().nullable().optional(),
      assetType: optText(30).optional(),
      assetRef: optText(100).optional(),
      expectedAction: optText(2000).optional(),
      nextAction: optText(500).optional(),
    }), req.body);
    const { version: v, ...patch } = body;
    await withTx(u, req.ip, (ctx) => svc.updateIssue(ctx, id, v, patch));
    return { ok: true };
  });

  const action = <T extends z.ZodRawShape>(name: string, shape: T, fn: (ctx: any, id: string, b: z.infer<z.ZodObject<T>>) => Promise<unknown>) => {
    app.post(`/api/issues/:id/${name}`, async (req) => {
      const u = requireUser(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const body = parse(z.object(shape), req.body);
      const out = await withTx(u, req.ip, (ctx) => fn(ctx, id, body as any));
      return out ?? { ok: true };
    });
  };

  action('assign', { version, assigneeId: uuid.nullable(), reason: optText(500) }, (ctx, id, b) => svc.assign(ctx, id, b.version, b.assigneeId, b.reason).then(() => ({ ok: true })));
  action('transfer', { version, areaId: z.number().int().positive(), assigneeId: uuid.nullish(), reason: z.string().max(500) },
    (ctx, id, b) => svc.transfer(ctx, id, b.version, b.areaId, b.assigneeId ?? null, b.reason));
  action('status', { version, status: z.enum(STATUSES), note: optText(500) }, (ctx, id, b) => svc.changeStatus(ctx, id, b.version, b.status, b.note));
  action('block', { version, description: z.string().max(1000), blockingAreaId: z.number().int().positive().nullish(), stepId: uuid.nullish() },
    (ctx, id, b) => svc.block(ctx, id, b.version, b.description, b.blockingAreaId ?? null, b.stepId ?? null));
  action('complete', { version, solution: z.string().max(4000), criteriaConfirmed: z.boolean(), completedAt: z.coerce.date().nullish() },
    (ctx, id, b) => svc.complete(ctx, id, b.version, b));
  action('validate', { version, approved: z.boolean(), note: optText(1000) }, (ctx, id, b) => svc.validate(ctx, id, b.version, b.approved, b.note));
  action('reopen', { version, reason: z.string().max(1000) }, (ctx, id, b) => svc.reopen(ctx, id, b.version, b.reason));
  action('cancel', { version, reason: z.string().max(1000) }, (ctx, id, b) => svc.cancel(ctx, id, b.version, b.reason));
  action('deadline', { newDueAt: z.coerce.date(), reason: z.string().max(1000), stepId: uuid.nullish() },
    (ctx, id, b) => svc.requestDeadlineChange(ctx, id, b.newDueAt, b.reason, b.stepId ?? null));
  action('complexity', { complexity: z.enum(COMPLEXITIES).nullable() }, (ctx, id, b) => svc.setComplexity(ctx, id, b.complexity));
  action('steps', { steps: z.array(stepSchema).min(1).max(30) }, (ctx, id, b) => svc.addSteps(ctx, id, b.steps).then((ids) => ({ ids })));
  action('comments', { body: z.string().max(4000), stepId: uuid.nullish() }, (ctx, id, b) => svc.addComment(ctx, id, b.body, b.stepId ?? null));

  app.post('/api/impediments/:id/resolve', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ resolution: z.string().max(1000) }), req.body);
    await withTx(u, req.ip, (ctx) => svc.resolveImpediment(ctx, id, body.resolution));
    return { ok: true };
  });

  app.patch('/api/steps/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(stepSchema.partial().extend({ version, status: z.string().optional() }), req.body);
    const { version: v, ...patch } = body;
    await withTx(u, req.ip, (ctx) => svc.updateStep(ctx, id, v, patch as any));
    return { ok: true };
  });

  app.get('/api/deadline-changes', async (req) => {
    const u = requireUser(req);
    const rows = await q<any>(
      `SELECT d.*, i.code, i.title, i.area_id, i.origin_area_id, i.assignee_id, i.opened_by, a.name AS area_name, s.title AS step_title, r.name AS requested_by_name
         FROM deadline_changes d JOIN issues i ON i.id = d.issue_id JOIN areas a ON a.id = i.area_id
         LEFT JOIN steps s ON s.id = d.step_id JOIN users r ON r.id = d.requested_by
        WHERE d.status = 'pendente' ORDER BY d.requested_at`);
    return rows.filter((r) => can.approveDeadline(u, { areaId: r.area_id, originAreaId: r.origin_area_id, assigneeId: r.assignee_id, openedById: r.opened_by }) || r.requested_by === u.id);
  });

  app.post('/api/deadline-changes/:id/decide', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ approve: z.boolean(), note: optText(500) }), req.body);
    await withTx(u, req.ip, (ctx) => svc.decideDeadlineChange(ctx, id, body.approve, body.note));
    return { ok: true };
  });

  // ------------------------------------------------------------ attachments

  app.post('/api/issues/:id/attachments', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const issue = await one<any>('SELECT id, code FROM issues WHERE id = $1', [id]);
    if (!issue) throw notFound('Pendência não encontrada.');
    const saved: any[] = [];
    let purpose = 'anexo';
    let stepId: string | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'purpose' && ['anexo', 'evidencia', 'conclusao'].includes(String(part.value))) purpose = String(part.value);
        if (part.fieldname === 'stepId' && uuid.safeParse(part.value).success) stepId = String(part.value);
        continue;
      }
      const buf = await part.toBuffer();
      if (buf.length === 0) throw badRequest('Arquivo vazio.');
      const sniff = await fileTypeFromBuffer(buf);
      let mime = sniff?.mime as string | undefined;
      const ext = path.extname(part.filename).toLowerCase();
      if (!mime && ['.txt', '.csv'].includes(ext) && isUtf8Text(buf)) mime = ext === '.csv' ? 'text/csv' : 'text/plain';
      if (!mime || !(ALLOWED_MIME.has(mime) || mime.startsWith('text/'))) {
        throw badRequest(`Tipo de arquivo não permitido (${part.filename}). Envie fotos, vídeos MP4, PDF, documentos Office, TXT ou CSV.`);
      }
      if (stepId && !(await one('SELECT id FROM steps WHERE id = $1 AND issue_id = $2', [stepId, id]))) throw badRequest('Etapa inválida.');
      const fileId = crypto.randomUUID();
      const now = new Date();
      const rel = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${fileId}`;
      await storage.put(rel, buf, mime);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const filename = part.filename.replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'arquivo';
      try {
        await withTx(u, req.ip, async (ctx) => {
          await q(
            `INSERT INTO attachments (id, issue_id, step_id, purpose, filename, mime, size_bytes, sha256, storage_path, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [fileId, id, stepId, purpose, filename, mime, buf.length, sha256, rel, u.id], ctx.db);
          await audit(ctx.db, { actorId: u.id, action: 'attachment.upload', entityType: 'attachment', entityId: fileId, issueId: id, data: { arquivo: filename, tipo: mime, finalidade: purpose, bytes: buf.length }, ip: req.ip });
          ctx.events.push({ type: 'issue.changed', issueId: id });
        });
      } catch (e) {
        await storage.remove(rel);
        throw e;
      }
      saved.push({ id: fileId, filename, mime, size_bytes: buf.length, purpose });
    }
    if (!saved.length) throw badRequest('Nenhum arquivo recebido.');
    reply.code(201);
    return saved;
  });

  app.get('/api/attachments/:id', async (req, reply) => {
    requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const a = await one<any>('SELECT * FROM attachments WHERE id = $1', [id]);
    if (!a) throw notFound('Arquivo não encontrado.');
    const data = await storage.get(a.storage_path);
    if (!data) throw notFound('Arquivo indisponível no armazenamento.');
    const inline = a.mime.startsWith('image/') || a.mime === 'application/pdf' || a.mime.startsWith('video/');
    reply.header('Content-Type', a.mime);
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(data);
  });

  // ------------------------------------------------------------ realtime & notifications

  app.get('/api/events', async (req, reply) => {
    const u = requireUser(req, { allowPendingPassword: true });
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: ready\ndata: {}\n\n`);
    addClient(u.id, reply);
  });

  app.get('/api/notifications', async (req) => {
    const u = requireUser(req);
    const qs = parse(z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().max(200).default(50) }), req.query);
    return q(
      `SELECT n.*, COALESCE(i.code, w.code) AS code, w.domain AS work_order_domain FROM notifications n LEFT JOIN issues i ON i.id = n.issue_id LEFT JOIN work_orders w ON w.id = n.work_order_id
        WHERE n.user_id = $1 ${qs.unread ? 'AND n.read_at IS NULL' : ''} ORDER BY n.created_at DESC LIMIT ${qs.limit}`, [u.id]);
  });

  app.post('/api/notifications/read', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ ids: z.array(z.number().int()).optional(), all: z.boolean().optional() }), req.body);
    if (body.all) await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [u.id]);
    else if (body.ids?.length) await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [u.id, body.ids]);
    return { ok: true };
  });
}

function isUtf8Text(buf: Buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, 64 * 1024));
    return !buf.subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
}

export function toCsv(rows: unknown[][]) {
  return rows.map((r) => r.map((c) => {
    let s = c == null ? '' : String(c);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // prevents formula injection in Excel
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\r\n');
}
