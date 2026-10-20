import { DateTime } from 'luxon';
import { ACTIVE_STATUSES, OPEN_STATUSES, type Status } from '../../../shared/constants.js';
import type { AppConfig } from '../../../shared/config.js';
import { can } from '../../../shared/permissions.js';
import { pendingMandatorySteps, stepProgress } from '../../../shared/workflow.js';
import type { SessionUser } from '../context.js';
import { one, q, type Db, pool } from '../db.js';
import { notFound } from '../errors.js';
import { ref, type IssueRow } from './issues.js';

export interface IssueFilters {
  areaId?: number;
  areaScope?: 'current' | 'involved';
  assigneeId?: string;
  openedById?: string;
  stepAssigneeId?: string;
  priority?: string[];
  status?: string[];
  categoryId?: number;
  source?: string;
  openedFrom?: string;
  openedTo?: string;
  dueFrom?: string;
  dueTo?: string;
  flag?: string; // open | overdue | due_today | unassigned | blocked | awaiting_validation | safety | recurrent | closed | completed_period
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

const ACTIVE = `('${ACTIVE_STATUSES.join("','")}')`;
const OPEN = `('${OPEN_STATUSES.join("','")}')`;

export const OVERDUE_SQL = `(i.status IN ${ACTIVE} AND i.due_at < now())`;

const localDay = (d: string, tz: string, end = false) => {
  const dt = DateTime.fromISO(d, { zone: tz });
  if (!dt.isValid) return null;
  return (end ? dt.endOf('day') : dt.startOf('day')).toJSDate();
};

/** Builds WHERE clauses for the issue filters. Mutates params. */
export function issueWhere(f: IssueFilters, params: unknown[], cfg: AppConfig): string {
  const w: string[] = ['TRUE'];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.areaId) {
    const a = p(f.areaId);
    w.push(f.areaScope === 'current' ? `i.area_id = ${a}` :
      `(i.area_id = ${a} OR i.origin_area_id = ${a} OR EXISTS (SELECT 1 FROM transfers t WHERE t.issue_id = i.id AND t.from_area_id = ${a}))`);
  }
  if (f.assigneeId) w.push(`i.assignee_id = ${p(f.assigneeId)}`);
  if (f.openedById) w.push(`i.opened_by = ${p(f.openedById)}`);
  if (f.stepAssigneeId) w.push(`EXISTS (SELECT 1 FROM steps s WHERE s.issue_id = i.id AND s.assignee_id = ${p(f.stepAssigneeId)} AND s.status NOT IN ('concluida','cancelada'))`);
  if (f.priority?.length) w.push(`i.priority::text = ANY(${p(f.priority)})`);
  if (f.status?.length) w.push(`i.status::text = ANY(${p(f.status)})`);
  if (f.categoryId) w.push(`i.category_id = ${p(f.categoryId)}`);
  if (f.source) w.push(`i.source::text = ${p(f.source)}`);
  const d = (s: string | undefined, end: boolean) => (s ? localDay(s, cfg.timezone, end) : null);
  if (d(f.openedFrom, false)) w.push(`i.opened_at >= ${p(d(f.openedFrom, false))}`);
  if (d(f.openedTo, true)) w.push(`i.opened_at <= ${p(d(f.openedTo, true))}`);
  if (d(f.dueFrom, false)) w.push(`i.due_at >= ${p(d(f.dueFrom, false))}`);
  if (d(f.dueTo, true)) w.push(`i.due_at <= ${p(d(f.dueTo, true))}`);
  if (f.q?.trim()) {
    const term = f.q.trim();
    w.push(`(i.search @@ plainto_tsquery('portuguese', ${p(term)}) OR i.code ILIKE ${p('%' + term + '%')} OR i.title ILIKE ${p('%' + term + '%')} OR i.asset_ref ILIKE ${p('%' + term + '%')})`);
  }
  const now = DateTime.now().setZone(cfg.timezone);
  switch (f.flag) {
    case 'open': w.push(`i.status IN ${OPEN}`); break;
    case 'overdue': w.push(OVERDUE_SQL); break;
    case 'due_today':
      w.push(`i.status IN ${ACTIVE} AND i.due_at BETWEEN ${p(now.startOf('day').toJSDate())} AND ${p(now.endOf('day').toJSDate())}`);
      break;
    case 'unassigned': w.push(`i.status IN ${OPEN} AND i.assignee_id IS NULL`); break;
    case 'blocked': w.push(`i.status = 'bloqueada'`); break;
    case 'awaiting_validation': w.push(`i.status = 'aguardando_validacao'`); break;
    case 'safety': w.push(`i.status IN ${OPEN} AND (i.is_safety_critical OR i.priority = 'critica')`); break;
    case 'recurrent': w.push(`i.recurrence_of_id IS NOT NULL`); break;
    case 'closed': w.push(`i.status IN ('concluida','cancelada')`); break;
    case 'completed': w.push(`i.status = 'concluida'`); break;
  }
  return w.join(' AND ');
}

export const ISSUE_SELECT = `
  SELECT i.id, i.code, i.title, i.status, i.priority, i.area_id, i.origin_area_id,
         a.name AS area_name, a.slug AS area_slug, a.color AS area_color, oa.name AS origin_area_name,
         i.assignee_id, u.name AS assignee_name, i.opened_by, ob.name AS opened_by_name,
         i.opened_at, i.due_at, i.original_due_at, i.is_safety_critical, i.complexity, i.next_action,
         i.asset_type, i.asset_ref, i.category_id, c.name AS category_name, i.source, i.version, i.reopen_count,
         i.recurrence_of_id, i.completed_at, i.completed_by, i.validated_at, i.updated_at, i.status_changed_at,
         ${OVERDUE_SQL} AS is_overdue,
         st.total AS steps_total, st.done AS steps_done,
         (SELECT count(*)::int FROM impediments im WHERE im.issue_id = i.id AND im.resolved_at IS NULL) AS open_impediments,
         (SELECT im.description FROM impediments im WHERE im.issue_id = i.id AND im.resolved_at IS NULL ORDER BY im.created_at DESC LIMIT 1) AS blocker,
         (SELECT count(*)::int FROM deadline_changes dc WHERE dc.issue_id = i.id AND dc.status = 'pendente') AS pending_deadline_requests
    FROM issues i
    JOIN areas a ON a.id = i.area_id
    JOIN areas oa ON oa.id = i.origin_area_id
    LEFT JOIN users u ON u.id = i.assignee_id
    JOIN users ob ON ob.id = i.opened_by
    LEFT JOIN categories c ON c.id = i.category_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE s.status <> 'cancelada')::int AS total,
             count(*) FILTER (WHERE s.status = 'concluida')::int AS done
        FROM steps s WHERE s.issue_id = i.id) st ON TRUE`;

const SORTS: Record<string, string> = {
  due: 'i.due_at ASC',
  priority: `CASE i.priority WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, i.due_at ASC`,
  opened: 'i.opened_at DESC',
  updated: 'i.updated_at DESC',
  urgency: `${OVERDUE_SQL} DESC, CASE i.priority WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, i.due_at ASC`,
};

export async function listIssues(f: IssueFilters, cfg: AppConfig, db: Db = pool) {
  const params: unknown[] = [];
  const where = issueWhere(f, params, cfg);
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  const offset = Math.max(f.offset ?? 0, 0);
  const order = SORTS[f.sort ?? 'urgency'] ?? SORTS.urgency;
  const rows = await q(`${ISSUE_SELECT} WHERE ${where} ORDER BY ${order}, i.code LIMIT ${limit} OFFSET ${offset}`, params, db);
  const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM issues i WHERE ${where}`, params, db);
  return { items: rows, total: total!.n };
}

export async function getIssueDetail(id: string, actor: SessionUser, cfg: AppConfig, db: Db = pool) {
  const issue = await one<any>(`${ISSUE_SELECT} WHERE i.id = $1`, [id], db);
  if (!issue) throw notFound('Pendência não encontrada.');
  const full = await one<any>(
    `SELECT i.description, i.expected_action, i.solution, i.criteria_confirmed, i.completed_by, cb.name AS completed_by_name,
            i.validated_by, vb.name AS validated_by_name, i.cancel_reason, i.cancelled_at, i.overdue_since, i.complexity_approved_by,
            ro.code AS recurrence_of_code, ro.title AS recurrence_of_title
       FROM issues i LEFT JOIN users cb ON cb.id = i.completed_by LEFT JOIN users vb ON vb.id = i.validated_by
       LEFT JOIN issues ro ON ro.id = i.recurrence_of_id WHERE i.id = $1`, [id], db);
  const [steps, comments, attachments, impediments, transfers, deadlineChanges, validations, reopenings, statusHistory, timeline, recurrences] = await Promise.all([
    q(`SELECT s.*, u.name AS assignee_name, cb.name AS completed_by_name, (s.status NOT IN ('concluida','cancelada') AND s.due_at < now()) AS is_overdue
         FROM steps s LEFT JOIN users u ON u.id = s.assignee_id LEFT JOIN users cb ON cb.id = s.completed_by
        WHERE s.issue_id = $1 ORDER BY s.position`, [id], db),
    q(`SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.issue_id = $1 ORDER BY c.created_at`, [id], db),
    q(`SELECT a.id, a.step_id, a.purpose, a.filename, a.mime, a.size_bytes, a.created_at, u.name AS uploaded_by_name
         FROM attachments a JOIN users u ON u.id = a.uploaded_by WHERE a.issue_id = $1 ORDER BY a.created_at`, [id], db),
    q(`SELECT im.*, cu.name AS created_by_name, ru.name AS resolved_by_name, ar.name AS blocking_area_name
         FROM impediments im JOIN users cu ON cu.id = im.created_by LEFT JOIN users ru ON ru.id = im.resolved_by
         LEFT JOIN areas ar ON ar.id = im.blocking_area_id WHERE im.issue_id = $1 ORDER BY im.created_at`, [id], db),
    q(`SELECT t.*, fa.name AS from_area_name, ta.name AS to_area_name, fu.name AS from_user_name, tu.name AS to_user_name, bu.name AS by_name
         FROM transfers t LEFT JOIN areas fa ON fa.id = t.from_area_id LEFT JOIN areas ta ON ta.id = t.to_area_id
         LEFT JOIN users fu ON fu.id = t.from_user_id LEFT JOIN users tu ON tu.id = t.to_user_id JOIN users bu ON bu.id = t.transferred_by
        WHERE t.issue_id = $1 ORDER BY t.transferred_at`, [id], db),
    q(`SELECT d.*, s.title AS step_title, ru.name AS requested_by_name, du.name AS decided_by_name
         FROM deadline_changes d LEFT JOIN steps s ON s.id = d.step_id JOIN users ru ON ru.id = d.requested_by
         LEFT JOIN users du ON du.id = d.decided_by WHERE d.issue_id = $1 ORDER BY d.requested_at`, [id], db),
    q(`SELECT v.*, u.name AS validated_by_name FROM validations v JOIN users u ON u.id = v.validated_by WHERE v.issue_id = $1 ORDER BY v.validated_at`, [id], db),
    q(`SELECT r.*, u.name AS reopened_by_name FROM reopenings r JOIN users u ON u.id = r.reopened_by WHERE r.issue_id = $1 ORDER BY r.reopened_at`, [id], db),
    q(`SELECT h.*, u.name AS changed_by_name FROM issue_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.issue_id = $1 ORDER BY h.changed_at, h.id`, [id], db),
    q(`SELECT e.id, e.at, e.action, e.entity_type, e.data, u.name AS actor_name FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.issue_id = $1 ORDER BY e.at, e.id`, [id], db),
    q(`SELECT id, code, title, status, opened_at FROM issues WHERE recurrence_of_id = $1 ORDER BY opened_at`, [id], db),
  ]);
  const row = (await one<IssueRow>('SELECT * FROM issues WHERE id = $1', [id], db))!;
  const r = ref(row);
  const cat = issue.category_id ? await one<{ requires_evidence: boolean }>('SELECT requires_evidence FROM categories WHERE id = $1', [issue.category_id], db) : null;
  return {
    ...issue,
    ...full,
    progress: stepProgress(steps as any),
    pending_mandatory_steps: pendingMandatorySteps(steps as any),
    evidence_required: cfg.workflow.evidenceRequiredForPriorities.includes(issue.priority) || Boolean(cat?.requires_evidence) || issue.is_safety_critical,
    steps, comments, attachments, impediments, transfers, deadline_changes: deadlineChanges, validations, reopenings,
    status_history: statusHistory, timeline, recurrences,
    permissions: {
      edit: can.editIssue(actor, r),
      assign: can.assign(actor, r),
      selfAssign: can.selfAssign(actor, r),
      changeStatus: can.changeStatus(actor, r),
      block: can.block(actor, r),
      complete: can.complete(actor, r),
      validate: can.validate(actor, r, cfg.workflow.allowSelfValidation),
      reopen: can.reopen(actor, r),
      cancel: can.cancel(actor, r),
      transfer: can.transfer(actor, r),
      changeDeadline: can.changeDeadline(actor, r, cfg.workflow.deadlineChangeRequiresApprovalFor),
      requestDeadline: can.requestDeadline(actor, r),
      approveDeadline: can.approveDeadline(actor, r),
      setComplexity: can.setComplexity(actor, r),
      manageSteps: can.manageSteps(actor, r),
    },
  };
}

/** Open issues that look like the one being registered (same asset, or similar title). */
export async function findSimilar(title: string, assetRef: string | null, areaId: number | null, db: Db = pool) {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (title && title.trim().length >= 4) {
    params.push(title.trim());
    conds.push(`i.search @@ plainto_tsquery('portuguese', $${params.length})`);
  }
  if (assetRef?.trim()) {
    params.push(assetRef.trim());
    conds.push(`lower(i.asset_ref) = lower($${params.length})`);
  }
  if (!conds.length) return [];
  let areaCond = '';
  if (areaId) {
    params.push(areaId);
    areaCond = ` AND (i.area_id = $${params.length} OR i.origin_area_id = $${params.length})`;
  }
  return q(
    `SELECT i.id, i.code, i.title, i.status, i.asset_ref, i.opened_at, a.name AS area_name
       FROM issues i JOIN areas a ON a.id = i.area_id
      WHERE i.status IN ${OPEN} AND (${conds.join(' OR ')})${areaCond}
      ORDER BY i.opened_at DESC LIMIT 5`, params, db);
}

export type { Status };
