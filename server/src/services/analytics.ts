import { DateTime } from 'luxon';
import { ACTIVE_STATUSES, OPEN_STATUSES } from '../../../shared/constants.js';
import type { AppConfig } from '../../../shared/config.js';
import { currentMonth, monthBounds } from '../../../shared/deadline.js';
import { scoreIssue, type IssueScore } from '../../../shared/scoring.js';
import { one, q, type Db, pool } from '../db.js';
import { issueWhere, OVERDUE_SQL, type IssueFilters } from './queries.js';

const OPEN = `('${OPEN_STATUSES.join("','")}')`;
const ACTIVE = `('${ACTIVE_STATUSES.join("','")}')`;

export interface Period {
  from: Date;
  to: Date;
}

/** Default period: current local month. */
export function resolvePeriod(cfg: AppConfig, from?: string, to?: string): Period {
  const tz = cfg.timezone;
  const now = DateTime.now().setZone(tz);
  const f = from ? DateTime.fromISO(from, { zone: tz }) : now.startOf('month');
  const t = to ? DateTime.fromISO(to, { zone: tz }) : now;
  return { from: f.startOf('day').toJSDate(), to: t.endOf('day').toJSDate() };
}

export async function dashboard(filters: IssueFilters, period: Period, cfg: AppConfig, db: Db = pool) {
  const params: unknown[] = [];
  const base = issueWhere({ ...filters, flag: undefined, areaScope: 'current' }, params, cfg);
  const baseParams = [...params];
  const now = DateTime.now().setZone(cfg.timezone);
  const pFrom = params.push(period.from);
  const pTo = params.push(period.to);
  const pDayStart = params.push(now.startOf('day').toJSDate());
  const pDayEnd = params.push(now.endOf('day').toJSDate());

  const kpi = await one<any>(
    `SELECT
       count(*) FILTER (WHERE i.status IN ${OPEN})::int AS open,
       count(*) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue,
       count(*) FILTER (WHERE i.status IN ${ACTIVE} AND i.due_at BETWEEN $${pDayStart} AND $${pDayEnd})::int AS due_today,
       count(*) FILTER (WHERE i.status = 'concluida' AND i.validated_at BETWEEN $${pFrom} AND $${pTo})::int AS completed_period,
       count(*) FILTER (WHERE i.status IN ${OPEN} AND i.assignee_id IS NULL)::int AS unassigned,
       count(*) FILTER (WHERE i.status = 'bloqueada')::int AS blocked,
       count(*) FILTER (WHERE i.status = 'aguardando_validacao')::int AS awaiting_validation,
       count(*) FILTER (WHERE i.status IN ${OPEN} AND (i.is_safety_critical OR i.priority = 'critica'))::int AS critical,
       round(avg(extract(epoch FROM i.completed_at - i.opened_at) / 3600) FILTER (WHERE i.status = 'concluida' AND i.validated_at BETWEEN $${pFrom} AND $${pTo})::numeric, 1) AS avg_resolution_hours,
       round(100.0 * count(*) FILTER (WHERE i.status = 'concluida' AND i.validated_at BETWEEN $${pFrom} AND $${pTo} AND i.completed_at <= i.due_at)
         / nullif(count(*) FILTER (WHERE i.status = 'concluida' AND i.validated_at BETWEEN $${pFrom} AND $${pTo}), 0), 1) AS on_time_pct
     FROM issues i WHERE ${base}`, params, db);

  const byArea = await q(
    `SELECT a.id, a.name, a.slug, a.color,
            count(i.id) FILTER (WHERE i.status IN ${OPEN})::int AS open,
            count(i.id) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue,
            count(i.id) FILTER (WHERE i.status = 'bloqueada')::int AS blocked
       FROM areas a LEFT JOIN issues i ON i.area_id = a.id AND ${base}
      WHERE a.active GROUP BY a.id ORDER BY a.sort`, baseParams, db);

  const tz = cfg.timezone;
  const evo = async (unit: 'week' | 'month', count: number) => {
    const start = DateTime.now().setZone(tz).startOf(unit).minus({ [unit + 's']: count - 1 } as any);
    const p2 = [...baseParams, start.toJSDate(), tz];
    const s = `$${p2.length - 1}`;
    const z = `$${p2.length}`;
    const rows = await q<{ bucket: string; opened: number; completed: number }>(
      `WITH b AS (SELECT generate_series(date_trunc('${unit}', ${s}::timestamptz AT TIME ZONE ${z}), date_trunc('${unit}', now() AT TIME ZONE ${z}), interval '1 ${unit}') AS bucket)
       SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket,
              (SELECT count(*)::int FROM issues i WHERE ${base} AND date_trunc('${unit}', i.opened_at AT TIME ZONE ${z}) = b.bucket) AS opened,
              (SELECT count(*)::int FROM issues i WHERE ${base} AND i.status = 'concluida' AND date_trunc('${unit}', i.validated_at AT TIME ZONE ${z}) = b.bucket) AS completed
         FROM b ORDER BY b.bucket`, p2, db);
    return rows;
  };
  const [weekly, monthly] = await Promise.all([evo('week', 12), evo('month', 12)]);
  const ranking = await computeRanking(currentMonth(cfg.timezone), cfg, db, false);
  return { kpi, byArea, weekly, monthly, rankingTop: ranking.users.slice(0, 5), period };
}

// ---------------------------------------------------------------- reports

export async function reports(filters: IssueFilters, period: Period, cfg: AppConfig, db: Db = pool) {
  const params: unknown[] = [];
  const base = issueWhere({ ...filters, flag: undefined, areaScope: filters.areaScope ?? 'current' }, params, cfg);
  const pf = params.push(period.from);
  const pt = params.push(period.to);
  const tz = params.push(cfg.timezone);
  const closedIn = `i.status = 'concluida' AND i.validated_at BETWEEN $${pf} AND $${pt}`;
  const openedIn = `i.opened_at BETWEEN $${pf} AND $${pt}`;

  const resolution = await one(
    `SELECT count(*)::int AS count,
            round(avg(h)::numeric, 1) AS avg_hours,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY h)::numeric, 1) AS median_hours,
            round(percentile_cont(0.9) WITHIN GROUP (ORDER BY h)::numeric, 1) AS p90_hours,
            round(100.0 * count(*) FILTER (WHERE on_time) / nullif(count(*), 0), 1) AS on_time_pct,
            sum(reopen_count)::int AS reopens
       FROM (SELECT extract(epoch FROM i.completed_at - i.opened_at) / 3600 AS h, i.completed_at <= i.due_at AS on_time, i.reopen_count
               FROM issues i WHERE ${base} AND ${closedIn}) x`, params, db);

  const openedVsClosed = await q(
    `WITH m AS (SELECT generate_series(date_trunc('month', $${pf}::timestamptz AT TIME ZONE $${tz}), date_trunc('month', $${pt}::timestamptz AT TIME ZONE $${tz}), interval '1 month') AS bucket)
     SELECT to_char(m.bucket, 'YYYY-MM') AS month,
            (SELECT count(*)::int FROM issues i WHERE ${base} AND date_trunc('month', i.opened_at AT TIME ZONE $${tz}) = m.bucket) AS opened,
            (SELECT count(*)::int FROM issues i WHERE ${base} AND i.status = 'concluida' AND date_trunc('month', i.validated_at AT TIME ZONE $${tz}) = m.bucket) AS completed,
            (SELECT count(*)::int FROM issues i WHERE ${base} AND i.status = 'cancelada' AND date_trunc('month', i.cancelled_at AT TIME ZONE $${tz}) = m.bucket) AS cancelled,
            (SELECT round(100.0 * count(*) FILTER (WHERE i.completed_at <= i.due_at) / nullif(count(*),0), 1) FROM issues i
              WHERE ${base} AND i.status = 'concluida' AND date_trunc('month', i.validated_at AT TIME ZONE $${tz}) = m.bucket) AS on_time_pct
       FROM m ORDER BY m.bucket`, params, db);

  const areas = await q(
    `SELECT a.id, a.name, a.color,
            count(i.id) FILTER (WHERE ${openedIn})::int AS opened,
            count(i.id) FILTER (WHERE ${closedIn})::int AS completed,
            count(i.id) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue_now,
            count(i.id) FILTER (WHERE i.status IN ${OPEN})::int AS open_now,
            round(100.0 * count(i.id) FILTER (WHERE ${closedIn} AND i.completed_at <= i.due_at) / nullif(count(i.id) FILTER (WHERE ${closedIn}), 0), 1) AS on_time_pct,
            round((avg(extract(epoch FROM i.completed_at - i.opened_at) / 3600) FILTER (WHERE ${closedIn}))::numeric, 1) AS avg_hours,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.completed_at - i.opened_at) / 3600) FILTER (WHERE ${closedIn}))::numeric, 1) AS median_hours
       FROM areas a LEFT JOIN issues i ON i.area_id = a.id AND ${base}
      WHERE a.active GROUP BY a.id ORDER BY a.sort`, params, db);

  // Time spent in each status (dwell time). This is NOT worked time.
  const statusTime = await q(
    `WITH h AS (
       SELECT h.issue_id, h.to_status AS status, h.changed_at,
              coalesce(lead(h.changed_at) OVER (PARTITION BY h.issue_id ORDER BY h.changed_at, h.id), now()) AS until
         FROM issue_status_history h JOIN issues i ON i.id = h.issue_id
        WHERE ${base} AND ${openedIn})
     SELECT status, count(DISTINCT issue_id)::int AS issues,
            round(avg(extract(epoch FROM until - changed_at) / 3600)::numeric, 1) AS avg_hours,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM until - changed_at) / 3600))::numeric, 1) AS median_hours
       FROM h WHERE status NOT IN ('concluida','cancelada') GROUP BY status`, params, db);

  const categories = await q(
    `SELECT coalesce(c.name, 'Sem categoria') AS name, count(*)::int AS count,
            count(*) FILTER (WHERE i.recurrence_of_id IS NOT NULL)::int AS recurrent
       FROM issues i LEFT JOIN categories c ON c.id = i.category_id
      WHERE ${base} AND ${openedIn} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, params, db);

  const recurrent = await q(
    `SELECT i.id, i.code, i.title, i.asset_ref, i.status, i.opened_at, a.name AS area_name, o.code AS recurrence_of_code, o.id AS recurrence_of_id
       FROM issues i JOIN areas a ON a.id = i.area_id JOIN issues o ON o.id = i.recurrence_of_id
      WHERE ${base} AND ${openedIn} ORDER BY i.opened_at DESC LIMIT 50`, params, db);

  const collaborators = await q(
    `SELECT u.id, u.name, ar.name AS area_name,
            count(i.id) FILTER (WHERE i.status IN ${OPEN})::int AS open_now,
            count(i.id) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue_now,
            count(i.id) FILTER (WHERE ${closedIn})::int AS completed,
            round(100.0 * count(i.id) FILTER (WHERE ${closedIn} AND i.completed_at <= i.due_at) / nullif(count(i.id) FILTER (WHERE ${closedIn}), 0), 1) AS on_time_pct,
            round((avg(extract(epoch FROM i.completed_at - i.opened_at) / 3600) FILTER (WHERE ${closedIn}))::numeric, 1) AS avg_hours
       FROM users u LEFT JOIN areas ar ON ar.id = u.area_id
       JOIN issues i ON i.assignee_id = u.id AND ${base}
      GROUP BY u.id, ar.name HAVING count(i.id) FILTER (WHERE i.status IN ${OPEN} OR ${closedIn}) > 0
      ORDER BY completed DESC, open_now DESC LIMIT 100`, params, db);

  return { period, resolution, openedVsClosed, areas, statusTime, categories, recurrent, collaborators };
}

// ---------------------------------------------------------------- ranking

export interface RankingResult {
  month: string;
  finalized: boolean;
  computedAt: Date;
  criteria: AppConfig['scoring'];
  users: any[];
  areas: any[];
  champion: any | null;
}

/** Computes (and stores, unless the month is finalized) the monthly ranking. */
export async function computeRanking(month: string, cfg: AppConfig, db: Db = pool, persist = true): Promise<RankingResult> {
  const fin = await one<{ finalized_at: Date | null; config_snapshot: any }>('SELECT finalized_at, config_snapshot FROM ranking_months WHERE month = $1', [month], db);
  if (fin?.finalized_at) return loadStoredRanking(month, cfg, fin.config_snapshot ?? cfg.scoring, true, db);

  const { start, end } = monthBounds(month, cfg.timezone);
  const s = cfg.scoring;
  const issues = await q<any>(
    `SELECT i.id, i.code, i.title, i.complexity, i.opened_by, i.completed_by, i.opened_at, i.completed_at, i.due_at, i.reopen_count,
            i.area_id, i.validated_at,
            EXISTS (SELECT 1 FROM issues r WHERE r.recurrence_of_id = i.id AND r.opened_at <= i.completed_at + make_interval(days => $3)) AS had_recurrence
       FROM issues i
      WHERE i.status = 'concluida' AND i.validated_at >= $1 AND i.validated_at < $2 AND i.completed_by IS NOT NULL
      ORDER BY i.validated_at`, [start, end, cfg.recurrence.windowDays], db);

  const perUser = new Map<string, { points: number; validated: number; onTime: number; reopens: number; steps: number; issues: IssueScore[]; stepItems: any[] }>();
  const u = (id: string) => {
    if (!perUser.has(id)) perUser.set(id, { points: 0, validated: 0, onTime: 0, reopens: 0, steps: 0, issues: [], stepItems: [] });
    return perUser.get(id)!;
  };
  const simpleCount = new Map<string, number>();
  const perArea = new Map<number, { points: number; validated: number; onTime: number; hours: number[] }>();
  for (const i of issues) {
    const idx = i.complexity === 'simples' ? (simpleCount.get(i.completed_by) ?? 0) : 0;
    const sc = scoreIssue({
      id: i.id, code: i.code, complexity: i.complexity, openedById: i.opened_by, creditedUserId: i.completed_by,
      openedAt: new Date(i.opened_at), completedAt: new Date(i.completed_at), dueAt: new Date(i.due_at),
      reopenCount: i.reopen_count, hadRecurrence: i.had_recurrence,
    }, s, idx);
    if (i.complexity === 'simples' && sc.counted) simpleCount.set(i.completed_by, idx + 1);
    const acc = u(i.completed_by);
    acc.issues.push({ ...sc, title: i.title } as any);
    acc.points += sc.points;
    if (sc.counted) acc.validated++;
    if (sc.counted && sc.onTime) acc.onTime++;
    acc.reopens += i.reopen_count;
    const ar = perArea.get(i.area_id) ?? { points: 0, validated: 0, onTime: 0, hours: [] };
    ar.points += sc.points;
    ar.validated++;
    if (sc.onTime) ar.onTime++;
    ar.hours.push((new Date(i.completed_at).getTime() - new Date(i.opened_at).getTime()) / 3600_000);
    perArea.set(i.area_id, ar);
  }
  // Collaboration: steps completed by someone other than the credited person.
  if (issues.length) {
    const steps = await q<any>(
      `SELECT s.id, s.title, s.completed_by, i.code, i.completed_by AS credited
         FROM steps s JOIN issues i ON i.id = s.issue_id
        WHERE s.issue_id = ANY($1::uuid[]) AND s.status = 'concluida' AND s.completed_by IS NOT NULL AND s.completed_by <> i.completed_by`,
      [issues.map((i) => i.id)], db);
    for (const st of steps) {
      const acc = u(st.completed_by);
      acc.steps++;
      acc.points += s.stepPoints;
      acc.stepItems.push({ code: st.code, title: st.title, points: s.stepPoints });
    }
  }

  const userIds = [...perUser.keys()];
  const names = userIds.length ? await q<any>('SELECT u.id, u.name, u.area_id, a.name AS area_name FROM users u LEFT JOIN areas a ON a.id = u.area_id WHERE u.id = ANY($1::uuid[])', [userIds], db) : [];
  const users = userIds.map((id) => {
    const a = perUser.get(id)!;
    const n = names.find((x) => x.id === id);
    return {
      user_id: id, name: n?.name, area_id: n?.area_id, area_name: n?.area_name,
      points: Math.round(a.points * 10) / 10, validated_count: a.validated, on_time_count: a.onTime,
      on_time_pct: a.validated ? Math.round((a.onTime / a.validated) * 1000) / 10 : null,
      reopen_count: a.reopens, steps_count: a.steps,
      breakdown: { issues: a.issues, steps: a.stepItems },
    };
  }).sort((x, y) => y.points - x.points || (y.on_time_pct ?? 0) - (x.on_time_pct ?? 0));

  const areaNames = await q<any>('SELECT id, name, color FROM areas WHERE active ORDER BY sort', [], db);
  const areas = areaNames.map((a) => {
    const v = perArea.get(a.id);
    const hours = v?.hours.sort((x, y) => x - y) ?? [];
    return {
      area_id: a.id, name: a.name, color: a.color,
      points: Math.round((v?.points ?? 0) * 10) / 10, validated_count: v?.validated ?? 0,
      on_time_pct: v?.validated ? Math.round((v.onTime / v.validated) * 1000) / 10 : null,
      avg_resolution_hours: hours.length ? Math.round((hours.reduce((x, y) => x + y, 0) / hours.length) * 10) / 10 : null,
    };
  }).sort((x, y) => y.points - x.points);

  const computedAt = new Date();
  if (persist) {
    await q('DELETE FROM monthly_scores WHERE month = $1', [month], db);
    for (const x of users) {
      await q(
        `INSERT INTO monthly_scores (month, user_id, area_id, points, validated_count, on_time_count, reopen_count, steps_count, breakdown, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [month, x.user_id, x.area_id, x.points, x.validated_count, x.on_time_count, x.reopen_count, x.steps_count, JSON.stringify(x.breakdown), computedAt], db);
    }
    await q('DELETE FROM monthly_area_scores WHERE month = $1', [month], db);
    for (const a of areas) {
      await q(`INSERT INTO monthly_area_scores (month, area_id, points, validated_count, on_time_pct, avg_resolution_hours, computed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [month, a.area_id, a.points, a.validated_count, a.on_time_pct, a.avg_resolution_hours, computedAt], db);
    }
  }
  return { month, finalized: false, computedAt, criteria: s, users, areas, champion: pickChampion(users, s) };
}

function pickChampion(users: any[], s: AppConfig['scoring']) {
  return users.find((x) => x.validated_count >= s.minIssuesForChampion && x.points > 0) ?? null;
}

async function loadStoredRanking(month: string, cfg: AppConfig, criteria: AppConfig['scoring'], finalized: boolean, db: Db): Promise<RankingResult> {
  const users = await q<any>(
    `SELECT m.user_id, u.name, m.area_id, a.name AS area_name, m.points, m.validated_count, m.on_time_count,
            CASE WHEN m.validated_count > 0 THEN round(100.0 * m.on_time_count / m.validated_count, 1) END AS on_time_pct,
            m.reopen_count, m.steps_count, m.breakdown, m.computed_at
       FROM monthly_scores m JOIN users u ON u.id = m.user_id LEFT JOIN areas a ON a.id = m.area_id
      WHERE m.month = $1 ORDER BY m.points DESC`, [month], db);
  const areas = await q<any>(
    `SELECT s.area_id, a.name, a.color, s.points, s.validated_count, s.on_time_pct, s.avg_resolution_hours
       FROM monthly_area_scores s JOIN areas a ON a.id = s.area_id WHERE s.month = $1 ORDER BY s.points DESC`, [month], db);
  return { month, finalized, computedAt: users[0]?.computed_at ?? new Date(), criteria, users, areas, champion: pickChampion(users, criteria) };
}

export async function finalizeMonth(month: string, actorId: string, cfg: AppConfig, db: Db) {
  await computeRanking(month, cfg, db, true);
  await q(
    `INSERT INTO ranking_months (month, finalized_at, finalized_by, config_snapshot) VALUES ($1, now(), $2, $3)
     ON CONFLICT (month) DO UPDATE SET finalized_at = now(), finalized_by = $2, config_snapshot = $3`,
    [month, actorId, JSON.stringify(cfg.scoring)], db);
}

/** Last N months: champion, totals and on-time evolution. */
export async function rankingHistory(cfg: AppConfig, months = 12, db: Db = pool) {
  const out = [];
  const now = DateTime.now().setZone(cfg.timezone).startOf('month');
  for (let k = months - 1; k >= 0; k--) {
    const m = now.minus({ months: k }).toFormat('yyyy-MM');
    const stored = await one<{ n: number }>('SELECT count(*)::int AS n FROM monthly_area_scores WHERE month = $1', [m], db);
    const r = k === 0 || !stored?.n ? await computeRanking(m, cfg, db) : await computeRanking(m, cfg, db, false);
    const validated = r.areas.reduce((s, a) => s + a.validated_count, 0);
    const onTime = r.users.reduce((s, u) => s + u.on_time_count, 0);
    const counted = r.users.reduce((s, u) => s + u.validated_count, 0);
    out.push({
      month: m, finalized: r.finalized, validated,
      on_time_pct: counted ? Math.round((onTime / counted) * 1000) / 10 : null,
      champion: r.champion ? { name: r.champion.name, points: r.champion.points, area_name: r.champion.area_name } : null,
      top_area: r.areas[0]?.points ? { name: r.areas[0].name, points: r.areas[0].points } : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Fast Response

export async function fastResponseBoard(areaId: number | null, cfg: AppConfig, db: Db = pool) {
  const now = DateTime.now().setZone(cfg.timezone);
  const params: unknown[] = [now.startOf('day').toJSDate(), now.endOf('day').toJSDate()];
  let areaCond = '';
  if (areaId) {
    params.push(areaId);
    areaCond = ` AND (i.area_id = $3 OR i.origin_area_id = $3)`;
  }
  const rows = await q<any>(
    `SELECT i.id, i.code, i.title, i.status, i.priority, i.is_safety_critical, i.area_id, a.name AS area_name, a.color AS area_color,
            i.assignee_id, u.name AS assignee_name, i.opened_at, i.due_at, i.original_due_at, i.next_action, i.version,
            i.recurrence_of_id, ${OVERDUE_SQL} AS is_overdue,
            (i.status IN ${ACTIVE} AND i.due_at BETWEEN $1 AND $2) AS due_today,
            (SELECT im.description FROM impediments im WHERE im.issue_id = i.id AND im.resolved_at IS NULL ORDER BY im.created_at DESC LIMIT 1) AS blocker,
            st.total AS steps_total, st.done AS steps_done
       FROM issues i JOIN areas a ON a.id = i.area_id LEFT JOIN users u ON u.id = i.assignee_id
       LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE s.status <> 'cancelada')::int AS total, count(*) FILTER (WHERE s.status = 'concluida')::int AS done FROM steps s WHERE s.issue_id = i.id) st ON TRUE
      WHERE i.status IN ${OPEN}${areaCond}
      ORDER BY i.is_safety_critical DESC, CASE i.priority WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, i.due_at`, params, db);

  const sections = {
    critical: rows.filter((r) => r.is_safety_critical || r.priority === 'critica'),
    overdue: rows.filter((r) => r.is_overdue),
    due_today: rows.filter((r) => r.due_today),
    blocked: rows.filter((r) => r.status === 'bloqueada'),
    unassigned: rows.filter((r) => !r.assignee_id),
    recurrent: rows.filter((r) => r.recurrence_of_id),
    awaiting_validation: rows.filter((r) => r.status === 'aguardando_validacao'),
  };
  const open = await one<any>('SELECT m.*, u.name AS started_by_name FROM meetings m JOIN users u ON u.id = m.started_by WHERE m.ended_at IS NULL ORDER BY m.started_at DESC LIMIT 1', [], db);
  const last = await one<any>(
    `SELECT m.* FROM meetings m WHERE m.ended_at IS NOT NULL ${open ? 'AND m.started_at < $1' : ''} ORDER BY m.started_at DESC LIMIT 1`,
    open ? [open.started_at] : [], db);
  const since = last?.started_at ?? now.minus({ days: 1 }).toJSDate();
  const updParams: unknown[] = [since];
  let updArea = '';
  if (areaId) {
    updParams.push(areaId);
    updArea = ' AND (i.area_id = $2 OR i.origin_area_id = $2)';
  }
  const updates = await q(
    `SELECT e.id, e.at, e.action, e.data, u.name AS actor_name, i.id AS issue_id, i.code, i.title, a.name AS area_name
       FROM audit_events e JOIN issues i ON i.id = e.issue_id JOIN areas a ON a.id = i.area_id LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.at >= $1${updArea}
        AND e.action IN ('issue.create','issue.status','issue.transfer','issue.assign','issue.complete','issue.validate','issue.reopen','issue.cancel',
                         'impediment.create','impediment.resolve','deadline.change','deadline.approve','deadline.request','issue.overdue','meeting.decision')
      ORDER BY e.at DESC LIMIT 100`, updParams, db);
  const decisions = open ? await meetingDecisions(open.id, db) : [];
  return { sections, total: rows.length, updates, updatesSince: since, meeting: open ?? null, lastMeeting: last ?? null, decisions };
}

export async function meetingDecisions(meetingId: string, db: Db = pool) {
  return q(
    `SELECT d.*, i.code, i.title, o.name AS owner_name, c.name AS created_by_name
       FROM meeting_decisions d LEFT JOIN issues i ON i.id = d.issue_id LEFT JOIN users o ON o.id = d.owner_id JOIN users c ON c.id = d.created_by
      WHERE d.meeting_id = $1 ORDER BY d.created_at`, [meetingId], db);
}
