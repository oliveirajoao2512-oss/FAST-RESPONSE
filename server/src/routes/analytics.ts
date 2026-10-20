import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '../../../shared/permissions.js';
import { currentMonth } from '../../../shared/deadline.js';
import { audit } from '../audit.js';
import { requireUser } from '../auth.js';
import { withTx } from '../context.js';
import { one, pool, q, tx } from '../db.js';
import { badRequest, forbidden, notFound, unprocessable } from '../errors.js';
import * as analytics from '../services/analytics.js';
import * as svc from '../services/issues.js';
import { getConfig } from '../settings.js';
import { optText, parse, uuid } from '../validation.js';
import { readFilters, toCsv } from './issues.js';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use AAAA-MM');

export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', async (req) => {
    requireUser(req);
    const cfg = await getConfig();
    const { from, to } = parse(z.object({ from: z.string().optional(), to: z.string().optional() }).passthrough(), req.query);
    return analytics.dashboard(readFilters(req), analytics.resolvePeriod(cfg, from, to), cfg);
  });

  app.get('/api/reports', async (req) => {
    const u = requireUser(req);
    if (!can.viewReports(u)) throw forbidden('Relatórios disponíveis para líderes, gestores e administradores.');
    const cfg = await getConfig();
    const { from, to } = parse(z.object({ from: z.string().optional(), to: z.string().optional() }).passthrough(), req.query);
    const now = new Date();
    const defFrom = from ?? new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().slice(0, 10);
    return analytics.reports(readFilters(req), analytics.resolvePeriod(cfg, defFrom, to), cfg);
  });

  app.get('/api/reports/export.csv', async (req, reply) => {
    const u = requireUser(req);
    if (!can.viewReports(u)) throw forbidden();
    const cfg = await getConfig();
    const qs = parse(z.object({ from: z.string().optional(), to: z.string().optional(), table: z.enum(['areas', 'collaborators', 'months', 'categories']) }).passthrough(), req.query);
    const r = await analytics.reports(readFilters(req), analytics.resolvePeriod(cfg, qs.from, qs.to), cfg);
    const n = (v: any) => (v == null ? '' : String(v).replace('.', ','));
    const tables: Record<string, unknown[][]> = {
      areas: [['Área', 'Abertas no período', 'Concluídas no período', '% no prazo', 'Tempo médio (h)', 'Tempo mediano (h)', 'Em aberto agora', 'Atrasadas agora'],
        ...r.areas.map((a: any) => [a.name, a.opened, a.completed, n(a.on_time_pct), n(a.avg_hours), n(a.median_hours), a.open_now, a.overdue_now])],
      collaborators: [['Colaborador', 'Área', 'Em aberto', 'Atrasadas', 'Concluídas', '% no prazo', 'Tempo médio (h)'],
        ...r.collaborators.map((c: any) => [c.name, c.area_name ?? '', c.open_now, c.overdue_now, c.completed, n(c.on_time_pct), n(c.avg_hours)])],
      months: [['Mês', 'Abertas', 'Concluídas', 'Canceladas', '% no prazo'], ...r.openedVsClosed.map((m: any) => [m.month, m.opened, m.completed, m.cancelled, n(m.on_time_pct)])],
      categories: [['Categoria', 'Pendências', 'Reincidentes'], ...r.categories.map((c: any) => [c.name, c.count, c.recurrent])],
    };
    await audit(pool, { actorId: u.id, action: 'report.export', entityType: 'report', entityId: qs.table, ip: req.ip });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="relatorio-${qs.table}.csv"`);
    return '﻿' + toCsv(tables[qs.table]);
  });

  app.get('/api/ranking', async (req) => {
    requireUser(req);
    const cfg = await getConfig();
    const { month } = parse(z.object({ month: monthSchema.optional() }), req.query);
    const m = month ?? currentMonth(cfg.timezone);
    return tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(727002)');
      const ranking = await analytics.computeRanking(m, cfg, db);
      const history = await analytics.rankingHistory(cfg, 12, db);
      return { ...ranking, history };
    });
  });

  app.post('/api/ranking/:month/finalize', async (req) => {
    const u = requireUser(req);
    if (!can.recomputeRanking(u)) throw forbidden('Somente gestores e administradores fecham o ranking.');
    const { month } = parse(z.object({ month: monthSchema }), req.params);
    const cfg = await getConfig();
    if (month >= currentMonth(cfg.timezone)) throw unprocessable('Só é possível fechar meses encerrados.');
    await tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(727002)');
      await analytics.finalizeMonth(month, u.id, cfg, db);
      await audit(db, { actorId: u.id, action: 'ranking.finalize', entityType: 'ranking', entityId: month, data: { criterios: cfg.scoring }, ip: req.ip });
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ Fast Response

  app.get('/api/fast-response', async (req) => {
    requireUser(req);
    const { areaId } = parse(z.object({ areaId: z.coerce.number().int().positive().optional() }), req.query);
    return analytics.fastResponseBoard(areaId ?? null, await getConfig());
  });

  app.post('/api/meetings', async (req) => {
    const u = requireUser(req);
    if (!can.manageMeeting(u)) throw forbidden('Somente líderes, gestores e administradores conduzem a reunião.');
    const cfg = await getConfig();
    return tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(727004)');
      const open = await one<any>('SELECT * FROM meetings WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [], db);
      if (open) return open;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(new Date());
      const m = await one<any>('INSERT INTO meetings (meeting_date, started_by) VALUES ($1,$2) RETURNING *', [today, u.id], db);
      await audit(db, { actorId: u.id, action: 'meeting.start', entityType: 'meeting', entityId: m.id, ip: req.ip });
      return m;
    });
  });

  app.post('/api/meetings/:id/end', async (req) => {
    const u = requireUser(req);
    if (!can.manageMeeting(u)) throw forbidden();
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { notes } = parse(z.object({ notes: optText(4000) }), req.body);
    const m = await one('UPDATE meetings SET ended_at = now(), notes = coalesce($2, notes) WHERE id = $1 AND ended_at IS NULL RETURNING id', [id, notes]);
    if (!m) throw notFound('Reunião não encontrada ou já encerrada.');
    await audit(pool, { actorId: u.id, action: 'meeting.end', entityType: 'meeting', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/meetings', async (req) => {
    requireUser(req);
    const meetings = await q(
      `SELECT m.*, u.name AS started_by_name, (SELECT count(*)::int FROM meeting_decisions d WHERE d.meeting_id = m.id) AS decisions
         FROM meetings m JOIN users u ON u.id = m.started_by ORDER BY m.started_at DESC LIMIT 60`);
    return meetings;
  });

  app.get('/api/meetings/:id', async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const m = await one('SELECT m.*, u.name AS started_by_name FROM meetings m JOIN users u ON u.id = m.started_by WHERE m.id = $1', [id]);
    if (!m) throw notFound();
    return { meeting: m, decisions: await analytics.meetingDecisions(id) };
  });

  /**
   * Records a meeting decision on an EXISTING issue (no duplicate task is created) and
   * optionally applies the decided owner, deadline and new step through the regular rules.
   */
  app.post('/api/meetings/:id/decisions', async (req) => {
    const u = requireUser(req);
    if (!can.manageMeeting(u)) throw forbidden('Somente líderes, gestores e administradores registram decisões da reunião.');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({
      issueId: uuid,
      decision: z.string().trim().min(3, 'descreva a decisão').max(2000),
      ownerId: uuid.nullish(),
      dueAt: z.coerce.date().nullish(),
      stepTitle: optText(200),
      nextAction: optText(500),
    }), req.body);
    const meeting = await one<any>('SELECT * FROM meetings WHERE id = $1', [id]);
    if (!meeting) throw notFound('Reunião não encontrada.');
    if (meeting.ended_at) throw unprocessable('Reunião encerrada.');
    await withTx(u, req.ip, async (rawCtx) => {
      // Decisions are taken collectively in the cross-area meeting; whoever conducts it (leader/manager)
      // records them with meeting authority for any area. Every change stays audited under their name.
      const ctx = { ...rawCtx, actor: { ...rawCtx.actor, role: 'gestor' as const } };
      const issue = await svc.lockIssue(ctx, b.issueId);
      await q(`INSERT INTO meeting_decisions (meeting_id, issue_id, decision, owner_id, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, b.issueId, b.decision, b.ownerId ?? null, b.dueAt ?? null, u.id], ctx.db);
      await svc.addComment(ctx, b.issueId, `Decisão do Fast Response: ${b.decision}`, null, 'decisao_reuniao');
      if (b.nextAction) await svc.updateIssue(ctx, b.issueId, (await svc.lockIssue(ctx, b.issueId)).version, { nextAction: b.nextAction });
      if (b.ownerId && b.ownerId !== issue.assignee_id) await svc.assign(ctx, b.issueId, null, b.ownerId, 'Definido na reunião de Fast Response');
      if (b.dueAt) await svc.requestDeadlineChange(ctx, b.issueId, b.dueAt, `Decisão da reunião: ${b.decision}`, null);
      if (b.stepTitle) await svc.addSteps(ctx, b.issueId, [{ title: b.stepTitle, assigneeId: b.ownerId ?? null, dueAt: null }]);
    });
    return { ok: true };
  });

  app.get('/api/areas/:slug/summary', async (req) => {
    requireUser(req);
    const { slug } = parse(z.object({ slug: z.string().max(40) }), req.params);
    const area = await one<any>('SELECT * FROM areas WHERE slug = $1', [slug]);
    if (!area) throw notFound('Área não encontrada.');
    const cfg = await getConfig();
    const people = await q(
      `SELECT u.id, u.name, u.role,
              count(i.id) FILTER (WHERE i.status IN ('aberta','aguardando_responsavel','planejada','em_andamento','bloqueada','aguardando_validacao'))::int AS open,
              count(i.id) FILTER (WHERE i.status IN ('aberta','aguardando_responsavel','planejada','em_andamento','bloqueada') AND i.due_at < now())::int AS overdue,
              count(i.id) FILTER (WHERE i.status = 'em_andamento')::int AS in_progress,
              count(i.id) FILTER (WHERE i.status = 'bloqueada')::int AS blocked
         FROM users u LEFT JOIN issues i ON i.assignee_id = u.id AND (i.area_id = $1 OR i.origin_area_id = $1)
        WHERE u.active AND (u.area_id = $1 OR i.id IS NOT NULL)
        GROUP BY u.id ORDER BY overdue DESC, open DESC, u.name`, [area.id]);
    const dash = await analytics.dashboard({ areaId: area.id }, analytics.resolvePeriod(cfg), cfg);
    return { area, people, kpi: dash.kpi, weekly: dash.weekly };
  });

  void badRequest;
}
