import { DateTime } from 'luxon';
import { CLOSED_STATUSES, PRIORITY_LABELS, STATUS_LABELS, type Complexity, type Priority, type Status } from '../../../shared/constants.js';
import { computeDefaultDue, computeDue } from '../../../shared/deadline.js';
import { can, type IssueRef } from '../../../shared/permissions.js';
import {
  autoComplexity,
  CAN_BLOCK_FROM,
  CAN_CANCEL_FROM,
  CAN_COMPLETE_FROM,
  canSimpleTransition,
  completionProblems,
  pendingMandatorySteps,
} from '../../../shared/workflow.js';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { one, q } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { areaLeaders, managers, notify } from '../notify.js';
import { getConfig } from '../settings.js';

export interface IssueRow {
  id: string;
  code: string;
  title: string;
  area_id: number;
  origin_area_id: number;
  assignee_id: string | null;
  opened_by: string;
  priority: Priority;
  status: Status;
  category_id: number | null;
  due_at: Date;
  original_due_at: Date;
  opened_at: Date;
  completed_by: string | null;
  completed_at: Date | null;
  complexity: Complexity;
  complexity_approved_by: string | null;
  is_safety_critical: boolean;
  overdue_since: Date | null;
  version: number;
  asset_ref: string | null;
  reopen_count: number;
}

export const ref = (i: IssueRow): IssueRef => ({
  areaId: i.area_id,
  originAreaId: i.origin_area_id,
  assigneeId: i.assignee_id,
  openedById: i.opened_by,
  completedById: i.completed_by,
});

/** Loads and row-locks an issue; checks the optimistic-lock version when given. */
export async function lockIssue(ctx: Ctx, id: string, version?: number | null): Promise<IssueRow> {
  const row = await one<IssueRow>('SELECT * FROM issues WHERE id = $1 FOR UPDATE', [id], ctx.db);
  if (!row) throw notFound('Pendência não encontrada.');
  if (version != null && version !== row.version) {
    throw conflict('Esta pendência foi alterada por outra pessoa. Os dados foram atualizados; revise e tente novamente.', 'versao_desatualizada');
  }
  return row;
}

async function bump(ctx: Ctx, id: string, set: string, params: unknown[]) {
  // set uses $2.. placeholders; $1 is the id
  await q(`UPDATE issues SET ${set}${set ? ', ' : ''}version = version + 1, updated_at = now() WHERE id = $1`, [id, ...params], ctx.db);
  ctx.events.push({ type: 'issue.changed', issueId: id });
}

async function recordStatus(ctx: Ctx, issueId: string, from: Status | null, to: Status, reason?: string | null) {
  await q(
    `INSERT INTO issue_status_history (issue_id, from_status, to_status, changed_by, reason) VALUES ($1,$2,$3,$4,$5)`,
    [issueId, from, to, ctx.actor.id, reason ?? null],
    ctx.db,
  );
}

async function setStatus(ctx: Ctx, issue: IssueRow, to: Status, reason?: string | null, extraSet = '', extraParams: unknown[] = []) {
  // extraSet uses $1..$n for extraParams; shift by one because bump() binds the id as $1.
  const shifted = extraSet.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`);
  const base = extraParams.length;
  await bump(ctx, issue.id, `status = $${base + 2}, status_changed_at = now()${shifted ? ', ' + shifted : ''}`, [...extraParams, to]);
  await recordStatus(ctx, issue.id, issue.status, to, reason);
  await audit(ctx.db, {
    actorId: ctx.actor.id, action: 'issue.status', entityType: 'issue', entityId: issue.id, issueId: issue.id,
    data: { de: issue.status, para: to, motivo: reason ?? undefined }, ip: ctx.ip,
  });
}

async function assertActiveUser(ctx: Ctx, userId: string) {
  // maintainers and process technicians only access their order module, so they cannot own issues
  const u = await one<{ id: string }>(`SELECT id FROM users WHERE id = $1 AND active AND role NOT IN ('manutentor', 'tecnico_processo')`, [userId], ctx.db);
  if (!u) throw badRequest('Responsável inválido, inativo ou sem acesso às pendências.');
}

async function assertArea(ctx: Ctx, areaId: number) {
  const a = await one('SELECT id FROM areas WHERE id = $1 AND active', [areaId], ctx.db);
  if (!a) throw badRequest('Área inválida.');
}

// ---------------------------------------------------------------- create

export interface CreateIssueInput {
  title: string;
  description?: string | null;
  areaId: number;
  assigneeId?: string | null;
  priority: Priority;
  categoryId?: number | null;
  assetType?: string | null;
  assetRef?: string | null;
  expectedAction?: string | null;
  nextAction?: string | null;
  source: 'fast_response' | 'direto';
  recurrenceOfId?: string | null;
  customDueAt?: Date | null;
  customDueReason?: string | null;
  steps?: { title: string; mandatory?: boolean; assigneeId?: string | null; dueAt?: Date | null }[];
}

export async function createIssue(ctx: Ctx, input: CreateIssueInput) {
  const cfg = await getConfig(ctx.db);
  const { actor } = ctx;
  await assertArea(ctx, input.areaId);

  if (input.assigneeId) {
    await assertActiveUser(ctx, input.assigneeId);
    const probe: IssueRef = { areaId: input.areaId, originAreaId: input.areaId, assigneeId: null, openedById: actor.id };
    if (input.assigneeId !== actor.id && !can.assign(actor, probe)) {
      throw forbidden('Apenas líderes da área, gestores e administradores podem atribuir a outra pessoa. Você pode deixar sem responsável ou assumir a pendência.');
    }
  }

  let category: { id: number; is_safety: boolean } | undefined;
  if (input.categoryId) {
    category = await one('SELECT id, is_safety FROM categories WHERE id = $1 AND active', [input.categoryId], ctx.db);
    if (!category) throw badRequest('Categoria inválida.');
  }
  const area = await one<{ slug: string; name: string }>('SELECT slug, name FROM areas WHERE id = $1', [input.areaId], ctx.db);
  const isSafetyCritical = input.priority === 'critica' && (area!.slug === 'seguranca' || Boolean(category?.is_safety));

  const openedAt = new Date();
  const defaultDue = computeDue(openedAt, isSafetyCritical, cfg);
  let dueAt = defaultDue;
  if (input.customDueAt) {
    const probe: IssueRef = { areaId: input.areaId, originAreaId: input.areaId, assigneeId: null, openedById: actor.id };
    if (!can.changeDeadline(actor, probe, cfg.workflow.deadlineChangeRequiresApprovalFor)) {
      throw forbidden('Prazos diferentes do padrão exigem aprovação. Abra com o prazo padrão e solicite a alteração.');
    }
    if (!input.customDueReason || input.customDueReason.trim().length < 5) throw badRequest('Justifique o prazo específico.');
    if (input.customDueAt.getTime() <= openedAt.getTime()) throw badRequest('O prazo deve ser posterior à abertura.');
    dueAt = input.customDueAt;
  }

  // Recurrence: explicit, or same asset + same category concluded within the window.
  let recurrenceOf = input.recurrenceOfId ?? null;
  if (recurrenceOf) {
    if (!(await one('SELECT id FROM issues WHERE id = $1', [recurrenceOf], ctx.db))) throw badRequest('Pendência de origem da reincidência não encontrada.');
  } else if (input.assetRef && input.categoryId) {
    const prev = await one<{ id: string }>(
      `SELECT id FROM issues WHERE lower(asset_ref) = lower($1) AND category_id = $2 AND status = 'concluida'
         AND completed_at > now() - make_interval(days => $3) ORDER BY completed_at DESC LIMIT 1`,
      [input.assetRef, input.categoryId, cfg.recurrence.windowDays],
      ctx.db,
    );
    recurrenceOf = prev?.id ?? null;
  }

  const seq = await one<{ n: number }>("SELECT nextval('issue_code_seq') AS n", [], ctx.db);
  const year = DateTime.fromJSDate(openedAt, { zone: cfg.timezone }).year;
  const code = `FR-${year}-${String(seq!.n).padStart(5, '0')}`;
  const status: Status = input.assigneeId ? 'aberta' : 'aguardando_responsavel';

  const issue = await one<IssueRow>(
    `INSERT INTO issues (code, title, description, area_id, origin_area_id, assignee_id, opened_by, priority, status,
        category_id, asset_type, asset_ref, expected_action, next_action, source, is_safety_critical, opened_at,
        due_at, original_due_at, recurrence_of_id)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [code, input.title.trim(), input.description ?? null, input.areaId, input.assigneeId ?? null, actor.id, input.priority, status,
      input.categoryId ?? null, input.assetType ?? null, input.assetRef?.trim() || null, input.expectedAction ?? null,
      input.nextAction ?? null, input.source, isSafetyCritical, openedAt, dueAt, defaultDue, recurrenceOf],
    ctx.db,
  );
  await recordStatus(ctx, issue!.id, null, status, 'Abertura');
  await audit(ctx.db, {
    actorId: actor.id, action: 'issue.create', entityType: 'issue', entityId: issue!.id, issueId: issue!.id, ip: ctx.ip,
    data: { codigo: code, titulo: issue!.title, area: area!.name, prioridade: input.priority, responsavel: input.assigneeId ?? null,
      prazo: dueAt.toISOString(), seguranca_critica: isSafetyCritical, reincidencia_de: recurrenceOf },
  });
  if (input.customDueAt) {
    await q(
      `INSERT INTO deadline_changes (issue_id, old_due_at, new_due_at, reason, status, requested_by, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,'aprovada',$5,$5,now())`,
      [issue!.id, defaultDue, dueAt, input.customDueReason, actor.id],
      ctx.db,
    );
  }
  for (const [idx, s] of (input.steps ?? []).entries()) {
    await insertStep(ctx, issue!.id, idx + 1, s);
  }
  if (input.steps?.length) await refreshComplexity(ctx, issue!.id);

  ctx.events.push({ type: 'issue.changed', issueId: issue!.id });

  if (input.assigneeId) {
    await notify(ctx.db, ctx.events, {
      userIds: [input.assigneeId], exceptUserId: actor.id, type: 'atribuida', issueId: issue!.id,
      title: `${code} atribuída a você`, body: `${issue!.title} — prazo ${fmt(dueAt, cfg.timezone)}`,
    });
  } else {
    await notify(ctx.db, ctx.events, {
      userIds: await areaLeaders(ctx.db, [input.areaId]), exceptUserId: actor.id, type: 'atribuida', issueId: issue!.id,
      title: `${code} sem responsável em ${area!.name}`, body: issue!.title,
    });
  }
  if (isSafetyCritical) {
    const safetyArea = await one<{ id: number }>("SELECT id FROM areas WHERE slug = 'seguranca'", [], ctx.db);
    const recipients = [
      ...(await areaLeaders(ctx.db, [input.areaId, safetyArea?.id])),
      ...(cfg.escalation.notifyManagersOnCriticalSafety ? await managers(ctx.db) : []),
    ];
    await notify(ctx.db, ctx.events, {
      userIds: recipients, type: 'seguranca_critica', issueId: issue!.id, dedupeKey: `seguranca:${issue!.id}`,
      title: `SEGURANÇA CRÍTICA: ${code}`, body: `${issue!.title} — tratamento imediato, prazo ${fmt(dueAt, cfg.timezone)}`,
    });
  }
  return issue!;
}

// ---------------------------------------------------------------- edit

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  priority?: Priority;
  categoryId?: number | null;
  assetType?: string | null;
  assetRef?: string | null;
  expectedAction?: string | null;
  nextAction?: string | null;
}

export async function updateIssue(ctx: Ctx, id: string, version: number, patch: UpdateIssueInput) {
  const issue = await lockIssue(ctx, id, version);
  if (!can.editIssue(ctx.actor, ref(issue))) throw forbidden();
  if (CLOSED_STATUSES.includes(issue.status)) throw unprocessable('Pendências encerradas não podem ser editadas. Reabra se necessário.');
  const cols: Record<string, string> = {
    title: 'title', description: 'description', priority: 'priority', categoryId: 'category_id',
    assetType: 'asset_type', assetRef: 'asset_ref', expectedAction: 'expected_action', nextAction: 'next_action',
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, unknown> = {};
  const current: any = await one('SELECT * FROM issues WHERE id = $1', [id], ctx.db);
  for (const [k, col] of Object.entries(cols)) {
    const v = (patch as any)[k];
    if (v === undefined) continue;
    if (k === 'title' && !String(v).trim()) throw badRequest('O título é obrigatório.');
    if (k === 'categoryId' && v && !(await one('SELECT id FROM categories WHERE id = $1', [v], ctx.db))) throw badRequest('Categoria inválida.');
    if (current[col] === v) continue;
    params.push(v);
    sets.push(`${col} = $${params.length + 1}`);
    changes[col] = { de: current[col], para: v };
  }
  if (!sets.length) return issue;
  await bump(ctx, id, sets.join(', '), params);
  await audit(ctx.db, { actorId: ctx.actor.id, action: 'issue.update', entityType: 'issue', entityId: id, issueId: id, data: changes, ip: ctx.ip });
  if (patch.priority === 'critica' && issue.priority !== 'critica') {
    await notify(ctx.db, ctx.events, {
      userIds: [issue.assignee_id, ...(await areaLeaders(ctx.db, [issue.area_id]))], exceptUserId: ctx.actor.id,
      type: 'escalonamento', issueId: id, title: `${issue.code} elevada para prioridade crítica`, body: issue.title,
    });
  }
  return issue;
}

// ---------------------------------------------------------------- assignment & transfer

export async function assign(ctx: Ctx, id: string, version: number | null, assigneeId: string | null, reason?: string | null) {
  const issue = await lockIssue(ctx, id, version);
  if (CLOSED_STATUSES.includes(issue.status)) throw unprocessable('Pendência encerrada.');
  const selfTake = assigneeId === ctx.actor.id && can.selfAssign(ctx.actor, ref(issue));
  if (!selfTake && !can.assign(ctx.actor, ref(issue))) throw forbidden('Somente líderes da área, gestores e administradores podem atribuir responsáveis.');
  if (assigneeId === issue.assignee_id) return issue;
  if (assigneeId) await assertActiveUser(ctx, assigneeId);

  let newStatus: Status | null = null;
  if (assigneeId && issue.status === 'aguardando_responsavel') newStatus = 'aberta';
  if (!assigneeId && ['aberta', 'planejada'].includes(issue.status)) newStatus = 'aguardando_responsavel';

  await bump(ctx, id, 'assignee_id = $2', [assigneeId]);
  await q(
    `INSERT INTO transfers (issue_id, from_area_id, to_area_id, from_user_id, to_user_id, reason, transferred_by) VALUES ($1,$2,$2,$3,$4,$5,$6)`,
    [id, issue.area_id, issue.assignee_id, assigneeId, reason ?? null, ctx.actor.id],
    ctx.db,
  );
  await audit(ctx.db, {
    actorId: ctx.actor.id, action: 'issue.assign', entityType: 'issue', entityId: id, issueId: id, ip: ctx.ip,
    data: { de: issue.assignee_id, para: assigneeId, motivo: reason ?? undefined },
  });
  if (newStatus) await setStatus(ctx, { ...issue, version: issue.version + 1 }, newStatus, assigneeId ? 'Responsável definido' : 'Responsável removido');

  const cfg = await getConfig(ctx.db);
  if (assigneeId) {
    await notify(ctx.db, ctx.events, {
      userIds: [assigneeId], exceptUserId: ctx.actor.id, type: 'atribuida', issueId: id,
      title: `${issue.code} atribuída a você`, body: `${issue.title} — prazo ${fmt(issue.due_at, cfg.timezone)}`,
    });
  }
  if (issue.assignee_id) {
    await notify(ctx.db, ctx.events, {
      userIds: [issue.assignee_id], exceptUserId: ctx.actor.id, type: 'responsavel_alterado', issueId: id,
      title: `${issue.code}: responsável alterado`, body: 'Você não é mais o responsável por esta pendência.',
    });
  }
  return issue;
}

export async function transfer(ctx: Ctx, id: string, version: number | null, toAreaId: number, toUserId: string | null, reason: string) {
  const issue = await lockIssue(ctx, id, version);
  if (!can.transfer(ctx.actor, ref(issue))) throw forbidden('Somente líderes da área, gestores e administradores podem transferir pendências.');
  if (CLOSED_STATUSES.includes(issue.status)) throw unprocessable('Pendência encerrada.');
  if (!reason || reason.trim().length < 5) throw badRequest('Informe o motivo da transferência.');
  await assertArea(ctx, toAreaId);
  if (toUserId) await assertActiveUser(ctx, toUserId);
  if (toAreaId === issue.area_id && toUserId === issue.assignee_id) throw badRequest('Nada a transferir.');

  let newStatus: Status | null = null;
  if (toUserId && issue.status === 'aguardando_responsavel') newStatus = 'aberta';
  if (!toUserId && ['aberta', 'planejada', 'em_andamento'].includes(issue.status)) newStatus = 'aguardando_responsavel';

  await bump(ctx, id, 'area_id = $2, assignee_id = $3', [toAreaId, toUserId]);
  await q(
    `INSERT INTO transfers (issue_id, from_area_id, to_area_id, from_user_id, to_user_id, reason, transferred_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, issue.area_id, toAreaId, issue.assignee_id, toUserId, reason, ctx.actor.id],
    ctx.db,
  );
  const areas = await q<{ id: number; name: string }>('SELECT id, name FROM areas WHERE id = ANY($1)', [[issue.area_id, toAreaId]], ctx.db);
  const name = (aid: number) => areas.find((a) => a.id === aid)?.name;
  await audit(ctx.db, {
    actorId: ctx.actor.id, action: 'issue.transfer', entityType: 'issue', entityId: id, issueId: id, ip: ctx.ip,
    data: { area_de: name(issue.area_id), area_para: name(toAreaId), responsavel_de: issue.assignee_id, responsavel_para: toUserId, motivo: reason },
  });
  if (newStatus) await setStatus(ctx, issue, newStatus, 'Transferência');
  await notify(ctx.db, ctx.events, {
    userIds: [toUserId, issue.assignee_id, ...(await areaLeaders(ctx.db, [toAreaId]))], exceptUserId: ctx.actor.id,
    type: 'responsavel_alterado', issueId: id,
    title: `${issue.code} transferida para ${name(toAreaId)}`, body: `${issue.title} — motivo: ${reason}`,
  });
}

// ---------------------------------------------------------------- status

export async function changeStatus(ctx: Ctx, id: string, version: number | null, to: Status, note?: string | null) {
  const issue = await lockIssue(ctx, id, version);
  if (!can.changeStatus(ctx.actor, ref(issue))) throw forbidden();
  if (to === 'em_andamento' && !issue.assignee_id) throw unprocessable('Defina um responsável antes de iniciar a execução.');
  if (!canSimpleTransition(issue.status, to)) {
    const hint: Partial<Record<Status, string>> = {
      bloqueada: 'Use "Registrar impedimento" para bloquear.',
      aguardando_validacao: 'Use "Concluir" e preencha os requisitos de encerramento.',
      concluida: 'Use "Concluir" e preencha os requisitos de encerramento.',
      cancelada: 'Use "Cancelar" e informe o motivo.',
    };
    throw unprocessable(`Transição de "${STATUS_LABELS[issue.status]}" para "${STATUS_LABELS[to]}" não permitida. ${hint[to] ?? ''}`.trim());
  }
  await setStatus(ctx, issue, to, note);
}

export async function block(ctx: Ctx, id: string, version: number | null, description: string, blockingAreaId: number | null, stepId: string | null) {
  const issue = await lockIssue(ctx, id, version);
  if (!can.block(ctx.actor, ref(issue))) throw forbidden();
  if (!description || description.trim().length < 5) throw badRequest('Descreva o impedimento.');
  if (blockingAreaId) await assertArea(ctx, blockingAreaId);
  if (stepId && !(await one('SELECT id FROM steps WHERE id = $1 AND issue_id = $2', [stepId, id], ctx.db))) throw badRequest('Etapa inválida.');
  const alreadyBlocked = issue.status === 'bloqueada';
  if (!alreadyBlocked && !CAN_BLOCK_FROM.includes(issue.status)) throw unprocessable(`Não é possível bloquear uma pendência "${STATUS_LABELS[issue.status]}".`);
  const imp = await one<{ id: string }>(
    `INSERT INTO impediments (issue_id, step_id, description, blocking_area_id, previous_status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [id, stepId, description.trim(), blockingAreaId, alreadyBlocked ? null : issue.status, ctx.actor.id],
    ctx.db,
  );
  if (stepId) await q(`UPDATE steps SET status = 'bloqueada', updated_at = now(), version = version + 1 WHERE id = $1 AND status IN ('pendente','em_andamento')`, [stepId], ctx.db);
  await audit(ctx.db, {
    actorId: ctx.actor.id, action: 'impediment.create', entityType: 'impediment', entityId: imp!.id, issueId: id, ip: ctx.ip,
    data: { descricao: description, area_bloqueadora: blockingAreaId, etapa: stepId },
  });
  if (!alreadyBlocked) await setStatus(ctx, issue, 'bloqueada', description);
  else await bump(ctx, id, '', []);
  await notify(ctx.db, ctx.events, {
    userIds: [issue.assignee_id, ...(await areaLeaders(ctx.db, [issue.area_id, blockingAreaId]))], exceptUserId: ctx.actor.id,
    type: 'bloqueada', issueId: id, title: `${issue.code} bloqueada`, body: description,
  });
  return imp!;
}

export async function resolveImpediment(ctx: Ctx, impedimentId: string, resolution: string) {
  const imp = await one<any>('SELECT * FROM impediments WHERE id = $1', [impedimentId], ctx.db);
  if (!imp) throw notFound('Impedimento não encontrado.');
  const issue = await lockIssue(ctx, imp.issue_id);
  if (!can.block(ctx.actor, ref(issue))) throw forbidden();
  if (imp.resolved_at) throw unprocessable('Impedimento já resolvido.');
  if (!resolution || resolution.trim().length < 3) throw badRequest('Descreva como o impedimento foi resolvido.');
  await q(`UPDATE impediments SET resolved_at = now(), resolved_by = $2, resolution = $3 WHERE id = $1`, [impedimentId, ctx.actor.id, resolution.trim()], ctx.db);
  if (imp.step_id) await q(`UPDATE steps SET status = 'em_andamento', updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'bloqueada'`, [imp.step_id], ctx.db);
  await audit(ctx.db, {
    actorId: ctx.actor.id, action: 'impediment.resolve', entityType: 'impediment', entityId: impedimentId, issueId: issue.id, ip: ctx.ip,
    data: { resolucao: resolution },
  });
  const stillOpen = await one<{ n: number }>('SELECT count(*)::int AS n FROM impediments WHERE issue_id = $1 AND resolved_at IS NULL', [issue.id], ctx.db);
  if (stillOpen!.n === 0 && issue.status === 'bloqueada') {
    const first = await one<{ previous_status: Status | null }>(
      `SELECT previous_status FROM impediments WHERE issue_id = $1 AND previous_status IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [issue.id], ctx.db);
    let back: Status = first?.previous_status ?? 'em_andamento';
    if (!issue.assignee_id) back = 'aguardando_responsavel';
    else if (back === 'aguardando_responsavel') back = 'aberta';
    await setStatus(ctx, issue, back, 'Impedimento resolvido: retomada');
  } else {
    await bump(ctx, issue.id, '', []);
  }
}

// ---------------------------------------------------------------- completion, validation, reopen, cancel

export async function complete(ctx: Ctx, id: string, version: number | null, input: { solution: string; criteriaConfirmed: boolean; completedAt?: Date | null }) {
  const issue = await lockIssue(ctx, id, version);
  if (!can.complete(ctx.actor, ref(issue))) throw forbidden('Somente o responsável, o líder da área, gestores e administradores podem concluir.');
  if (!CAN_COMPLETE_FROM.includes(issue.status)) throw unprocessable(`Não é possível concluir uma pendência "${STATUS_LABELS[issue.status]}".`);
  if (!issue.assignee_id) throw unprocessable('Defina o responsável antes de concluir.');
  const cfg = await getConfig(ctx.db);
  const now = new Date();
  let completedAt = input.completedAt ?? now;
  const openedMs = new Date(issue.opened_at).getTime();
  // forms send minute precision: a time within the opening minute means "right after opening"
  if (completedAt.getTime() < openedMs && openedMs - completedAt.getTime() < 60_000) completedAt = new Date(openedMs);
  if (completedAt.getTime() > now.getTime()) completedAt = completedAt.getTime() - now.getTime() < 60_000 ? now : completedAt;
  if (completedAt.getTime() > now.getTime()) throw badRequest('A data de conclusão não pode estar no futuro.');
  if (completedAt.getTime() < openedMs) throw badRequest('A data de conclusão não pode ser anterior à abertura.');
  if (now.getTime() - completedAt.getTime() > 24 * 3600_000) throw badRequest('A conclusão deve ser registrada em até 24 horas.');

  const steps = await q<{ mandatory: boolean; status: string }>('SELECT mandatory, status FROM steps WHERE issue_id = $1', [id], ctx.db);
  const ev = await one<{ n: number }>(`SELECT count(*)::int AS n FROM attachments WHERE issue_id = $1 AND purpose IN ('evidencia','conclusao')`, [id], ctx.db);
  const openImp = await one<{ n: number }>('SELECT count(*)::int AS n FROM impediments WHERE issue_id = $1 AND resolved_at IS NULL', [id], ctx.db);
  const cat = issue.category_id ? await one<{ requires_evidence: boolean }>('SELECT requires_evidence FROM categories WHERE id = $1', [issue.category_id], ctx.db) : null;
  const evidenceRequired = cfg.workflow.evidenceRequiredForPriorities.includes(issue.priority) || Boolean(cat?.requires_evidence) || issue.is_safety_critical;
  const problems = completionProblems({
    solution: input.solution, criteriaConfirmed: input.criteriaConfirmed, evidenceCount: ev!.n, evidenceRequired,
    pendingMandatorySteps: pendingMandatorySteps(steps), openImpediments: openImp!.n,
  });
  if (problems.length) throw unprocessable('Requisitos de encerramento não atendidos.', problems);

  const to: Status = cfg.workflow.requireValidation ? 'aguardando_validacao' : 'concluida';
  const extra = to === 'concluida' ? ', validated_at = $4, validated_by = $3' : ', validated_at = NULL, validated_by = NULL';
  await setStatus(ctx, issue, to, 'Conclusão registrada',
    `solution = $1, criteria_confirmed = true, completed_at = $2, completed_by = $3${extra}`,
    to === 'concluida' ? [input.solution.trim(), completedAt, issue.assignee_id, now] : [input.solution.trim(), completedAt, issue.assignee_id]);
  await audit(ctx.db, {
    actorId: ctx.actor.id, action: 'issue.complete', entityType: 'issue', entityId: id, issueId: id, ip: ctx.ip,
    data: { solucao: input.solution, concluida_em: completedAt.toISOString(), registrada_em: now.toISOString(),
      creditado_a: issue.assignee_id, dentro_do_prazo: completedAt <= new Date(issue.due_at) },
  });
  if (to === 'aguardando_validacao') {
    const validators = [issue.opened_by, ...(await areaLeaders(ctx.db, [issue.area_id]))].filter(
      (u) => cfg.workflow.allowSelfValidation || u !== issue.assignee_id,
    );
    await notify(ctx.db, ctx.events, {
      userIds: validators.length ? validators : await managers(ctx.db), exceptUserId: ctx.actor.id, type: 'validacao_solicitada', issueId: id,
      title: `${issue.code} aguarda sua validação`, body: input.solution.slice(0, 200),
    });
  }
}

export async function validate(ctx: Ctx, id: string, version: number | null, approved: boolean, note: string | null) {
  const issue = await lockIssue(ctx, id, version);
  const cfg = await getConfig(ctx.db);
  if (issue.status !== 'aguardando_validacao') throw unprocessable('A pendência não está aguardando validação.');
  if (!can.validate(ctx.actor, ref(issue), cfg.workflow.allowSelfValidation)) {
    throw forbidden(issue.completed_by === ctx.actor.id ? 'Quem concluiu a pendência não pode validá-la.' : 'Somente quem abriu a pendência, o líder da área, gestores e administradores podem validar.');
  }
  if (!approved && (!note || note.trim().length < 5)) throw badRequest('Explique por que a solução foi rejeitada.');
  await q(`INSERT INTO validations (issue_id, approved, note, validated_by) VALUES ($1,$2,$3,$4)`, [id, approved, note, ctx.actor.id], ctx.db);
  if (approved) {
    await setStatus(ctx, issue, 'concluida', note || 'Solução validada', 'validated_at = now(), validated_by = $1', [ctx.actor.id]);
    await audit(ctx.db, { actorId: ctx.actor.id, action: 'issue.validate', entityType: 'issue', entityId: id, issueId: id, data: { aprovada: true, observacao: note }, ip: ctx.ip });
  } else {
    await q(
      `INSERT INTO reopenings (issue_id, kind, reason, previous_completed_by, reopened_by) VALUES ($1,'validacao_rejeitada',$2,$3,$4)`,
      [id, note, issue.completed_by, ctx.actor.id], ctx.db,
    );
    await setStatus(ctx, issue, 'em_andamento', `Validação rejeitada: ${note}`,
      'reopen_count = reopen_count + 1, completed_at = NULL, completed_by = NULL, criteria_confirmed = false');
    await audit(ctx.db, { actorId: ctx.actor.id, action: 'issue.validate', entityType: 'issue', entityId: id, issueId: id, data: { aprovada: false, motivo: note }, ip: ctx.ip });
    await notify(ctx.db, ctx.events, {
      userIds: [issue.assignee_id, issue.completed_by], exceptUserId: ctx.actor.id, type: 'validacao_rejeitada', issueId: id,
      title: `${issue.code}: solução não validada`, body: note ?? '',
    });
  }
}

export async function reopen(ctx: Ctx, id: string, version: number | null, reason: string) {
  const issue = await lockIssue(ctx, id, version);
  if (!can.reopen(ctx.actor, ref(issue))) throw forbidden('Somente quem abriu, o líder da área, gestores e administradores podem reabrir.');
  if (issue.status !== 'concluida') throw unprocessable('Somente pendências concluídas podem ser reabertas.');
  if (!reason || reason.trim().length < 5) throw badRequest('Informe por que a solução foi ineficaz.');
  await q(
    `INSERT INTO reopenings (issue_id, kind, reason, previous_completed_by, reopened_by) VALUES ($1,'solucao_ineficaz',$2,$3,$4)`,
    [id, reason, issue.completed_by, ctx.actor.id], ctx.db,
  );
  await setStatus(ctx, issue, 'em_andamento', `Reaberta: ${reason}`,
    'reopen_count = reopen_count + 1, completed_at = NULL, completed_by = NULL, validated_at = NULL, validated_by = NULL, criteria_confirmed = false, overdue_since = CASE WHEN due_at < now() THEN now() ELSE NULL END');
  await audit(ctx.db, { actorId: ctx.actor.id, action: 'issue.reopen', entityType: 'issue', entityId: id, issueId: id, data: { motivo: reason }, ip: ctx.ip });
  await notify(ctx.db, ctx.events, {
    userIds: [issue.assignee_id, ...(await areaLeaders(ctx.db, [issue.area_id]))], exceptUserId: ctx.actor.id, type: 'reaberta', issueId: id,
    title: `${issue.code} reaberta`, body: reason,
  });
}

export async function cancel(ctx: Ctx, id: string, version: number | null, reason: string) {
  const issue = await lockIssue(ctx, id, version);
  if (!can.cancel(ctx.actor, ref(issue))) throw forbidden('Somente líderes da área, gestores e administradores podem cancelar.');
  if (!CAN_CANCEL_FROM.includes(issue.status)) throw unprocessable(`Não é possível cancelar uma pendência "${STATUS_LABELS[issue.status]}".`);
  if (!reason || reason.trim().length < 5) throw badRequest('Informe o motivo do cancelamento.');
  await setStatus(ctx, issue, 'cancelada', reason, 'cancelled_at = now(), cancelled_by = $1, cancel_reason = $2', [ctx.actor.id, reason]);
  await audit(ctx.db, { actorId: ctx.actor.id, action: 'issue.cancel', entityType: 'issue', entityId: id, issueId: id, data: { motivo: reason }, ip: ctx.ip });
}

// ---------------------------------------------------------------- deadlines

export async function requestDeadlineChange(ctx: Ctx, id: string, newDue: Date, reason: string, stepId: string | null) {
  const issue = await lockIssue(ctx, id);
  const cfg = await getConfig(ctx.db);
  if (CLOSED_STATUSES.includes(issue.status) || issue.status === 'aguardando_validacao') throw unprocessable('Pendência já concluída ou cancelada.');
  if (!reason || reason.trim().length < 5) throw badRequest('Justifique a alteração de prazo.');
  if (newDue.getTime() <= Date.now()) throw badRequest('O novo prazo deve estar no futuro.');
  let oldDue: Date | null = issue.due_at;
  if (stepId) {
    const step = await one<{ due_at: Date | null; assignee_id: string | null }>('SELECT due_at, assignee_id FROM steps WHERE id = $1 AND issue_id = $2', [stepId, id], ctx.db);
    if (!step) throw badRequest('Etapa inválida.');
    oldDue = step.due_at;
  }
  const direct = can.changeDeadline(ctx.actor, ref(issue), cfg.workflow.deadlineChangeRequiresApprovalFor);
  if (!direct && !can.requestDeadline(ctx.actor, ref(issue))) throw forbidden();
  const change = await one<{ id: string }>(
    `INSERT INTO deadline_changes (issue_id, step_id, old_due_at, new_due_at, reason, status, requested_by, decided_by, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [id, stepId, oldDue, newDue, reason.trim(), direct ? 'aprovada' : 'pendente', ctx.actor.id, direct ? ctx.actor.id : null, direct ? new Date() : null],
    ctx.db,
  );
  await audit(ctx.db, {
    actorId: ctx.actor.id, action: direct ? 'deadline.change' : 'deadline.request', entityType: 'deadline_change', entityId: change!.id, issueId: id, ip: ctx.ip,
    data: { etapa: stepId, prazo_anterior: oldDue?.toISOString() ?? null, novo_prazo: newDue.toISOString(), motivo: reason },
  });
  if (direct) await applyDeadline(ctx, issue, stepId, newDue, reason);
  else {
    await bump(ctx, id, '', []);
    await notify(ctx.db, ctx.events, {
      userIds: [...(await areaLeaders(ctx.db, [issue.area_id])), ...(await managers(ctx.db))], exceptUserId: ctx.actor.id,
      type: 'prazo_solicitado', issueId: id, title: `${issue.code}: alteração de prazo solicitada`,
      body: `Novo prazo ${fmt(newDue, cfg.timezone)} — ${reason}`,
    });
  }
  return { id: change!.id, approved: direct };
}

export async function decideDeadlineChange(ctx: Ctx, changeId: string, approve: boolean, note: string | null) {
  const ch = await one<any>('SELECT * FROM deadline_changes WHERE id = $1 FOR UPDATE', [changeId], ctx.db);
  if (!ch) throw notFound('Solicitação não encontrada.');
  if (ch.status !== 'pendente') throw unprocessable('Solicitação já decidida.');
  const issue = await lockIssue(ctx, ch.issue_id);
  if (!can.approveDeadline(ctx.actor, ref(issue))) throw forbidden('Somente líderes da área, gestores e administradores aprovam prazos.');
  if (ch.requested_by === ctx.actor.id) throw forbidden('Você não pode aprovar a própria solicitação.');
  await q(`UPDATE deadline_changes SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
    [changeId, approve ? 'aprovada' : 'rejeitada', ctx.actor.id, note], ctx.db);
  await audit(ctx.db, {
    actorId: ctx.actor.id, action: approve ? 'deadline.approve' : 'deadline.reject', entityType: 'deadline_change', entityId: changeId, issueId: issue.id, ip: ctx.ip,
    data: { novo_prazo: new Date(ch.new_due_at).toISOString(), observacao: note },
  });
  if (approve) await applyDeadline(ctx, issue, ch.step_id, new Date(ch.new_due_at), ch.reason);
  else {
    await bump(ctx, issue.id, '', []);
    await notify(ctx.db, ctx.events, {
      userIds: [ch.requested_by], type: 'prazo_alterado', issueId: issue.id,
      title: `${issue.code}: alteração de prazo rejeitada`, body: note ?? '',
    });
  }
}

async function applyDeadline(ctx: Ctx, issue: IssueRow, stepId: string | null, newDue: Date, reason: string) {
  const cfg = await getConfig(ctx.db);
  if (stepId) {
    await q(`UPDATE steps SET due_at = $2, original_due_at = coalesce(original_due_at, due_at, $2), updated_at = now(), version = version + 1 WHERE id = $1`, [stepId, newDue], ctx.db);
    await bump(ctx, issue.id, '', []);
  } else {
    // original_due_at is never touched; overdue flag follows the approved deadline.
    await bump(ctx, issue.id,
      `due_at = $2, overdue_since = CASE WHEN $2::timestamptz < now() THEN coalesce(overdue_since, now()) ELSE NULL END,
       due_soon_notified_at = NULL, manager_escalated_at = NULL`, [newDue]);
  }
  await notify(ctx.db, ctx.events, {
    userIds: [issue.assignee_id, issue.opened_by], exceptUserId: ctx.actor.id, type: 'prazo_alterado', issueId: issue.id,
    title: `${issue.code}: prazo ${stepId ? 'da etapa ' : ''}alterado para ${fmt(newDue, cfg.timezone)}`, body: reason,
  });
}

// ---------------------------------------------------------------- complexity

export async function setComplexity(ctx: Ctx, id: string, complexity: Complexity | null) {
  const issue = await lockIssue(ctx, id);
  if (!can.setComplexity(ctx.actor, ref(issue))) throw forbidden('A classificação de complexidade é aprovada por líderes, gestores ou administradores.');
  if (complexity === null) {
    await q('UPDATE issues SET complexity_approved_by = NULL WHERE id = $1', [id], ctx.db);
    await refreshComplexity(ctx, id);
  } else {
    await bump(ctx, id, 'complexity = $2, complexity_approved_by = $3', [complexity, ctx.actor.id]);
  }
  await audit(ctx.db, { actorId: ctx.actor.id, action: 'issue.complexity', entityType: 'issue', entityId: id, issueId: id, data: { de: issue.complexity, para: complexity ?? 'automática' }, ip: ctx.ip });
}

/** Recomputes the objective (step-based) complexity unless a manager approved a classification. */
export async function refreshComplexity(ctx: Ctx, issueId: string) {
  const cfg = await getConfig(ctx.db);
  const issue = await one<{ complexity_approved_by: string | null; complexity: Complexity }>('SELECT complexity_approved_by, complexity FROM issues WHERE id = $1', [issueId], ctx.db);
  if (!issue || issue.complexity_approved_by) return;
  const steps = await q<{ mandatory: boolean; status: string }>('SELECT mandatory, status FROM steps WHERE issue_id = $1', [issueId], ctx.db);
  const c = autoComplexity(steps, cfg.complexity);
  if (c !== issue.complexity) await q('UPDATE issues SET complexity = $2 WHERE id = $1', [issueId, c], ctx.db);
}

// ---------------------------------------------------------------- steps

export interface StepInput {
  title: string;
  description?: string | null;
  mandatory?: boolean;
  assigneeId?: string | null;
  dueAt?: Date | null;
  dependsOn?: string[];
}

async function insertStep(ctx: Ctx, issueId: string, position: number, s: StepInput) {
  if (s.assigneeId) await assertActiveUser(ctx, s.assigneeId);
  const row = await one<{ id: string }>(
    `INSERT INTO steps (issue_id, position, title, description, mandatory, assignee_id, due_at, original_due_at, depends_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9) RETURNING id`,
    [issueId, position, s.title.trim(), s.description ?? null, s.mandatory ?? true, s.assigneeId ?? null, s.dueAt ?? null, s.dependsOn ?? [], ctx.actor.id],
    ctx.db,
  );
  await audit(ctx.db, { actorId: ctx.actor.id, action: 'step.create', entityType: 'step', entityId: row!.id, issueId, data: { titulo: s.title, obrigatoria: s.mandatory ?? true, responsavel: s.assigneeId ?? null }, ip: ctx.ip });
  if (s.assigneeId) {
    const issue = await one<{ code: string }>('SELECT code FROM issues WHERE id = $1', [issueId], ctx.db);
    await notify(ctx.db, ctx.events, {
      userIds: [s.assigneeId], exceptUserId: ctx.actor.id, type: 'etapa_atribuida', issueId,
      title: `${issue!.code}: etapa atribuída a você`, body: s.title,
    });
  }
  return row!;
}

export async function addSteps(ctx: Ctx, issueId: string, steps: StepInput[]) {
  const issue = await lockIssue(ctx, issueId);
  if (!can.manageSteps(ctx.actor, ref(issue))) throw forbidden('Somente o responsável, o líder da área, gestores e administradores gerenciam etapas.');
  if (CLOSED_STATUSES.includes(issue.status) || issue.status === 'aguardando_validacao') throw unprocessable('Pendência encerrada.');
  const max = await one<{ m: number }>('SELECT coalesce(max(position),0)::int AS m FROM steps WHERE issue_id = $1', [issueId], ctx.db);
  const ids = [];
  for (const [i, s] of steps.entries()) {
    if (s.dependsOn?.length) await assertStepsOfIssue(ctx, issueId, s.dependsOn);
    ids.push((await insertStep(ctx, issueId, max!.m + i + 1, s)).id);
  }
  await refreshComplexity(ctx, issueId);
  await bump(ctx, issueId, '', []);
  return ids;
}

async function assertStepsOfIssue(ctx: Ctx, issueId: string, ids: string[]) {
  const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM steps WHERE issue_id = $1 AND id = ANY($2::uuid[])', [issueId, ids], ctx.db);
  if (n!.n !== new Set(ids).size) throw badRequest('Dependência inválida: as etapas devem pertencer à mesma pendência.');
}

export async function updateStep(ctx: Ctx, stepId: string, version: number | null, patch: Partial<StepInput> & { status?: string }) {
  const step = await one<any>('SELECT * FROM steps WHERE id = $1 FOR UPDATE', [stepId], ctx.db);
  if (!step) throw notFound('Etapa não encontrada.');
  if (version != null && step.version !== version) throw conflict('Esta etapa foi alterada por outra pessoa. Revise e tente novamente.', 'versao_desatualizada');
  const issue = await lockIssue(ctx, step.issue_id);
  const manager = can.manageSteps(ctx.actor, ref(issue));
  const isStepOwner = step.assignee_id === ctx.actor.id;
  if (CLOSED_STATUSES.includes(issue.status) || issue.status === 'aguardando_validacao') throw unprocessable('Pendência encerrada.');

  const changes: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: unknown[] = [];
  const put = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length + 1}`);
    changes[col] = { de: step[col], para: v };
  };

  const structural = ['title', 'description', 'mandatory', 'assigneeId', 'dependsOn'].some((k) => (patch as any)[k] !== undefined);
  if (structural && !manager) throw forbidden('Somente o responsável pela pendência, o líder da área, gestores e administradores alteram etapas.');
  if (patch.dueAt !== undefined) {
    if (step.due_at) throw unprocessable('Para alterar um prazo já definido, use "Alterar prazo" (fica registrado no histórico).');
    if (!manager) throw forbidden();
    put('due_at', patch.dueAt);
    put('original_due_at', patch.dueAt);
  }
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw badRequest('O título da etapa é obrigatório.');
    put('title', patch.title.trim());
  }
  if (patch.description !== undefined) put('description', patch.description);
  if (patch.mandatory !== undefined) put('mandatory', patch.mandatory);
  if (patch.assigneeId !== undefined) {
    if (patch.assigneeId) await assertActiveUser(ctx, patch.assigneeId);
    put('assignee_id', patch.assigneeId);
  }
  if (patch.dependsOn !== undefined) {
    if (patch.dependsOn.includes(stepId)) throw badRequest('Uma etapa não pode depender de si mesma.');
    await assertStepsOfIssue(ctx, step.issue_id, patch.dependsOn);
    put('depends_on', patch.dependsOn);
  }
  if (patch.status !== undefined && patch.status !== step.status) {
    if (!manager && !isStepOwner) throw forbidden('Somente o responsável pela etapa ou pela pendência pode alterar o status.');
    if (!['pendente', 'em_andamento', 'concluida', 'cancelada'].includes(patch.status)) {
      throw unprocessable('Para bloquear uma etapa, registre um impedimento.');
    }
    if (step.status === 'bloqueada') throw unprocessable('Resolva o impedimento da etapa antes de alterar o status.');
    if (patch.status === 'cancelada' && !manager) throw forbidden();
    if (['em_andamento', 'concluida'].includes(patch.status) && step.depends_on.length) {
      const pend = await q<{ title: string }>(`SELECT title FROM steps WHERE id = ANY($1::uuid[]) AND status NOT IN ('concluida','cancelada')`, [step.depends_on], ctx.db);
      if (pend.length) throw unprocessable(`Etapa depende de: ${pend.map((p) => p.title).join(', ')}.`);
    }
    put('status', patch.status);
    if (patch.status === 'concluida') {
      put('completed_at', new Date());
      put('completed_by', ctx.actor.id);
    } else if (step.status === 'concluida') {
      put('completed_at', null);
      put('completed_by', null);
    }
  }
  if (!sets.length) return;
  await q(`UPDATE steps SET ${sets.join(', ')}, updated_at = now(), version = version + 1 WHERE id = $1`, [stepId, ...params], ctx.db);
  await audit(ctx.db, { actorId: ctx.actor.id, action: 'step.update', entityType: 'step', entityId: stepId, issueId: step.issue_id, data: { etapa: step.title, ...changes }, ip: ctx.ip });
  if (patch.assigneeId && patch.assigneeId !== step.assignee_id) {
    await notify(ctx.db, ctx.events, {
      userIds: [patch.assigneeId], exceptUserId: ctx.actor.id, type: 'etapa_atribuida', issueId: step.issue_id,
      title: `${issue.code}: etapa atribuída a você`, body: step.title,
    });
  }
  // Starting work on a step moves a planned/open issue to "em andamento".
  if (patch.status === 'em_andamento' && ['aberta', 'planejada'].includes(issue.status) && issue.assignee_id) {
    await setStatus(ctx, issue, 'em_andamento', `Etapa iniciada: ${step.title}`);
  } else {
    await bump(ctx, step.issue_id, '', []);
  }
  await refreshComplexity(ctx, step.issue_id);
}

// ---------------------------------------------------------------- comments

export async function addComment(ctx: Ctx, issueId: string, body: string, stepId: string | null, kind: 'comentario' | 'decisao_reuniao' = 'comentario') {
  const issue = await one<{ id: string }>('SELECT id FROM issues WHERE id = $1', [issueId], ctx.db);
  if (!issue) throw notFound('Pendência não encontrada.');
  if (!body.trim()) throw badRequest('O comentário está vazio.');
  if (stepId && !(await one('SELECT id FROM steps WHERE id = $1 AND issue_id = $2', [stepId, issueId], ctx.db))) throw badRequest('Etapa inválida.');
  const c = await one<{ id: string }>(
    `INSERT INTO comments (issue_id, step_id, author_id, body, kind) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [issueId, stepId, ctx.actor.id, body.trim(), kind], ctx.db,
  );
  await q('UPDATE issues SET updated_at = now() WHERE id = $1', [issueId], ctx.db);
  await audit(ctx.db, { actorId: ctx.actor.id, action: kind === 'decisao_reuniao' ? 'meeting.decision' : 'comment.create', entityType: 'comment', entityId: c!.id, issueId, data: { texto: body.slice(0, 500), etapa: stepId }, ip: ctx.ip });
  ctx.events.push({ type: 'issue.changed', issueId });
  return c!;
}

export function fmt(d: Date | string, tz: string) {
  return DateTime.fromJSDate(new Date(d), { zone: tz }).setLocale('pt-BR').toFormat('dd/LL/yyyy HH:mm');
}

export { computeDefaultDue, PRIORITY_LABELS };
