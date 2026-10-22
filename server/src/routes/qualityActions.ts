import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { PRIORITIES } from '../../../shared/constants.js';
import { can, type IssueRef } from '../../../shared/permissions.js';
import {
  addDays, daysBetween, evaluate, ORIGIN_LABELS, PARTNER_LABELS, STEP_KEYS, STEP_LABELS, SUGGESTION_HORIZON_DAYS, type StepKey,
} from '../../../shared/quality.js';
import { audit } from '../audit.js';
import { withTx } from '../context.js';
import { one, pool, q, type Db } from '../db.js';
import { conflict, unprocessable } from '../errors.js';
import { createIssue } from '../services/issues.js';
import { norm } from '../services/quality.js';
import { getConfig } from '../settings.js';
import { optText, parse, uuid } from '../validation.js';
import { COLS, FROM, fromDb, qualityGuard, today, type Row } from './quality.js';

export interface Suggestion {
  ncId: number;
  number: string;
  origin: Row['origin'];
  partner: string | null;
  product: string | null;
  problem: string | null;
  safety: boolean;
  step: StepKey;
  stepLabel: string;
  plan: string;
  daysLate: number;
  leader: string | null;
  areaId: number;
  assigneeId: string | null;
  title: string;
  description: string;
  priority: 'alta' | 'media';
}

type UserLite = { id: string; name: string; area_id: number | null };

/** Spreadsheet leaders are first names ("Leonardo"): match an active user only when it is unambiguous. */
export function matchLeader(leader: string | null, users: UserLite[], preferAreaId: number | null): UserLite | null {
  if (!leader) return null;
  const l = norm(leader);
  const first = (n: string) => norm(n.trim().split(/\s+/)[0] ?? '');
  let hits = users.filter((u) => norm(u.name) === l);
  if (!hits.length) hits = users.filter((u) => first(u.name) === first(leader) && (l === first(leader) || norm(u.name).startsWith(l)));
  if (hits.length > 1 && preferAreaId) {
    const inArea = hits.filter((u) => u.area_id === preferAreaId);
    if (inArea.length === 1) return inArea[0];
  }
  return hits.length === 1 ? hits[0] : null;
}

function describe(nc: Row, step: StepKey, plan: string) {
  const d = (s: string) => s.split('-').reverse().join('/');
  return [
    `Ação gerada pela Resposta Rápida da Qualidade — ${ORIGIN_LABELS[nc.origin]} ${nc.number}.`,
    `Etapa: ${STEP_LABELS[step]} (prazo da etapa ${d(plan)}).`,
    `${PARTNER_LABELS[nc.origin]}: ${nc.partner ?? '—'} · Produto: ${nc.product ?? '—'}${nc.internal_code ? ` (${nc.internal_code})` : ''}`,
    `Problema: ${nc.description ?? '—'}${nc.primary_problem ? ` · ${nc.primary_problem}` : ''}`,
    nc.action_plan ? `Plano de ação: ${nc.action_plan}` : '',
    `Ao concluir, a Qualidade registra a data realizada da etapa na Resposta Rápida.`,
  ].filter(Boolean).join('\n');
}

export async function suggestions(db: Db, horizon = SUGGESTION_HORIZON_DAYS): Promise<Suggestion[]> {
  const t = await today();
  const qualityArea = (await one<{ id: number }>(`SELECT id FROM areas WHERE slug = 'qualidade'`, [], db))?.id ?? null;
  const users = await q<UserLite>('SELECT id, name, area_id FROM users WHERE active', [], db);
  const decided = new Set((await q<{ nc_id: number; step: string }>('SELECT nc_id, step FROM quality_actions', [], db)).map((r) => `${r.nc_id}|${r.step}`));
  const rows = (await q(`SELECT ${COLS} FROM ${FROM} WHERE n.procedente = 'SIM'`, [], db)).map(fromDb);
  const out: Suggestion[] = [];
  for (const nc of rows) {
    const ev = evaluate(nc, t);
    if (ev.status !== 'atrasado' && ev.status !== 'no_prazo') continue;
    const step = ev.currentStep;
    if (!step || decided.has(`${nc.id}|${step}`)) continue;
    const plan = nc.steps[step].plan ?? nc.due_on;
    if (plan > addDays(t, horizon)) continue;
    const user = matchLeader(nc.leader, users, qualityArea);
    const late = daysBetween(plan, t);
    out.push({
      ncId: nc.id, number: nc.number, origin: nc.origin, partner: nc.partner, product: nc.product, problem: nc.description ?? nc.primary_problem,
      safety: nc.safety, step, stepLabel: STEP_LABELS[step], plan, daysLate: late, leader: nc.leader,
      areaId: user?.area_id ?? qualityArea!, assigneeId: user?.id ?? null,
      title: `RR ${nc.number} · ${STEP_LABELS[step]} · ${nc.partner ?? ORIGIN_LABELS[nc.origin]}`.slice(0, 200),
      description: describe(nc, step, plan),
      priority: late > 0 || nc.safety ? 'alta' : 'media',
    });
  }
  return out.sort((a, b) => b.daysLate - a.daysLate || a.number.localeCompare(b.number, 'pt-BR', { numeric: true }));
}

const item = z.object({ ncId: z.number().int().positive(), step: z.enum(STEP_KEYS as [StepKey, ...StepKey[]]) });

export async function qualityActionRoutes(app: FastifyInstance) {
  app.get('/api/quality/suggestions', async (req) => {
    await qualityGuard(req);
    const { horizon } = parse(z.object({ horizon: z.coerce.number().int().min(0).max(60).default(SUGGESTION_HORIZON_DAYS) }), req.query);
    const decided = await q(
      `SELECT qa.id, qa.step, qa.decision, qa.decided_at, qa.note, n.id AS nc_id, n.number, n.origin, n.partner, u.name AS decided_by_name,
              i.id AS issue_id, i.code AS issue_code, i.status AS issue_status, a.name AS area_name, au.name AS assignee_name
         FROM quality_actions qa JOIN quality_ncs n ON n.id = qa.nc_id JOIN users u ON u.id = qa.decided_by
         LEFT JOIN issues i ON i.id = qa.issue_id LEFT JOIN areas a ON a.id = i.area_id LEFT JOIN users au ON au.id = i.assignee_id
        ORDER BY qa.decided_at DESC LIMIT 50`);
    return { horizon, pending: await suggestions(pool, horizon), decided };
  });

  /** Approve: each selected step becomes an issue in the chosen area (one per NC step). */
  app.post('/api/quality/suggestions/approve', async (req) => {
    const u = await qualityGuard(req);
    const { items } = parse(z.object({
      items: z.array(item.extend({
        areaId: z.number().int().positive(),
        assigneeId: uuid.nullish(),
        title: z.string().trim().min(1).max(200),
        priority: z.enum(PRIORITIES),
        description: optText(4000),
      })).min(1).max(100),
    }), req.body);
    const cfg = await getConfig();
    const t = await today();
    return withTx(u, req.ip, async (ctx) => {
      const current = new Map((await suggestions(ctx.db, 3650)).map((s) => [`${s.ncId}|${s.step}`, s]));
      const created: { ncId: number; step: string; issueId: string; code: string; assigned: boolean }[] = [];
      for (const it of items) {
        const s = current.get(`${it.ncId}|${it.step}`);
        if (!s) throw conflict(`A etapa ${STEP_LABELS[it.step]} da ocorrência já foi decidida, concluída ou não está mais pendente. Atualize a lista.`);
        const probe: IssueRef = { areaId: it.areaId, originAreaId: it.areaId, assigneeId: null, openedById: u.id };
        // without permission to assign in that area, the issue waits for the area leader to assign it
        const assigneeId = it.assigneeId && (it.assigneeId === u.id || can.assign(u, probe)) ? it.assigneeId : null;
        const futurePlan = s.plan > t && can.changeDeadline(u, probe, cfg.workflow.deadlineChangeRequiresApprovalFor);
        const issue = await createIssue(ctx, {
          title: it.title,
          description: it.description ?? s.description,
          areaId: it.areaId,
          assigneeId,
          priority: it.priority,
          expectedAction: `Concluir a etapa "${s.stepLabel}" da ocorrência ${s.number} e informar a Qualidade.`,
          source: 'direto',
          customDueAt: futurePlan ? DateTime.fromISO(s.plan, { zone: cfg.timezone }).set({ hour: 23, minute: 59 }).toJSDate() : null,
          customDueReason: futurePlan ? `Prazo da etapa ${s.stepLabel} na Resposta Rápida ${s.number}` : null,
        });
        try {
          await q(`INSERT INTO quality_actions (nc_id, step, decision, issue_id, area_id, decided_by) VALUES ($1,$2,'criada',$3,$4,$5)`,
            [it.ncId, it.step, issue.id, it.areaId, u.id], ctx.db);
        } catch (e: any) {
          if (e.code === '23505') throw conflict('Esta ação já foi decidida por outra pessoa. Atualize a lista.');
          throw e;
        }
        await audit(ctx.db, { actorId: u.id, action: 'quality.action_create', entityType: 'quality_nc', entityId: it.ncId, ip: req.ip,
          data: { numero: s.number, etapa: s.stepLabel, pendencia: issue.code, alteracoes: [`Etapa ${s.stepLabel} virou a pendência ${issue.code}`] } });
        created.push({ ncId: it.ncId, step: it.step, issueId: issue.id, code: issue.code, assigned: !!assigneeId });
      }
      ctx.events.push({ type: 'quality.changed' });
      return { created };
    });
  });

  app.post('/api/quality/suggestions/dismiss', async (req) => {
    const u = await qualityGuard(req);
    const { items, note } = parse(z.object({ items: z.array(item).min(1).max(100), note: optText(500) }), req.body);
    return withTx(u, req.ip, async (ctx) => {
      for (const it of items) {
        const nc = await one<{ number: string }>('SELECT number FROM quality_ncs WHERE id = $1', [it.ncId], ctx.db);
        if (!nc) throw unprocessable('Ocorrência não encontrada.');
        try {
          await q(`INSERT INTO quality_actions (nc_id, step, decision, note, decided_by) VALUES ($1,$2,'descartada',$3,$4)`, [it.ncId, it.step, note, u.id], ctx.db);
        } catch (e: any) {
          if (e.code === '23505') throw conflict('Esta ação já foi decidida. Atualize a lista.');
          throw e;
        }
        await audit(ctx.db, { actorId: u.id, action: 'quality.action_dismiss', entityType: 'quality_nc', entityId: it.ncId, ip: req.ip,
          data: { numero: nc.number, etapa: STEP_LABELS[it.step], alteracoes: [`Sugestão de ação da etapa ${STEP_LABELS[it.step]} descartada${note ? `: ${note}` : ''}`] } });
      }
      ctx.events.push({ type: 'quality.changed' });
      return { ok: true };
    });
  });
}
