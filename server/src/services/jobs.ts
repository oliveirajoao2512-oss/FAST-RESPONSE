import { audit } from '../audit.js';
import { pool, q, tx } from '../db.js';
import { env } from '../env.js';
import { sendEmail, emailEnabled } from '../mailer.js';
import { areaLeaders, managers, notify } from '../notify.js';
import { publish, type RealtimeEvent } from '../realtime.js';
import { getConfig } from '../settings.js';
import { fmt } from './issues.js';

const ACTIVE = `('aberta','aguardando_responsavel','planejada','em_andamento','bloqueada')`;

/**
 * Periodic deadline processing. Safe to run on several instances at once:
 * work is serialized by a transaction-level advisory lock.
 */
export async function runDeadlineJobs(now = new Date()) {
  const events: RealtimeEvent[] = [];
  const result = await tx(async (db) => {
    const got = (await db.query('SELECT pg_try_advisory_xact_lock(727003) AS ok')).rows[0].ok;
    if (!got) return { skipped: true, overdue: 0, dueSoon: 0, escalated: 0 };
    const cfg = await getConfig(db);

    // 1. Overdue: not finished by the deadline → ATRASADA.
    const overdue = await q<any>(
      `UPDATE issues SET overdue_since = due_at, updated_at = now()
        WHERE status IN ${ACTIVE} AND due_at < $1 AND overdue_since IS NULL
        RETURNING id, code, title, assignee_id, area_id, due_at, priority`, [now], db);
    for (const i of overdue) {
      await audit(db, { actorId: null, action: 'issue.overdue', entityType: 'issue', entityId: i.id, issueId: i.id, data: { prazo: i.due_at } });
      const leaders = cfg.escalation.notifyLeadersOnOverdue ? await areaLeaders(db, [i.area_id]) : [];
      await notify(db, events, {
        userIds: [i.assignee_id, ...leaders], type: 'atrasada', issueId: i.id, dedupeKey: `atrasada:${i.id}:${new Date(i.due_at).toISOString()}`,
        title: `${i.code} está ATRASADA`, body: `${i.title} — venceu em ${fmt(i.due_at, cfg.timezone)}`,
      });
      events.push({ type: 'issue.changed', issueId: i.id });
    }

    // 2. Due soon warning.
    const soon = await q<any>(
      `UPDATE issues SET due_soon_notified_at = now()
        WHERE status IN ${ACTIVE} AND due_soon_notified_at IS NULL AND due_at >= $1 AND due_at <= $1::timestamptz + make_interval(hours => $2)
        RETURNING id, code, title, assignee_id, area_id, due_at`, [now, cfg.deadline.dueSoonHours], db);
    for (const i of soon) {
      const to = i.assignee_id ? [i.assignee_id] : await areaLeaders(db, [i.area_id]);
      await notify(db, events, {
        userIds: to, type: 'prazo_proximo', issueId: i.id, dedupeKey: `prazo_proximo:${i.id}:${new Date(i.due_at).toISOString()}`,
        title: `${i.code} vence em breve`, body: `${i.title} — prazo ${fmt(i.due_at, cfg.timezone)}`,
      });
    }

    // 3. Escalation to managers after N hours overdue.
    const esc = await q<any>(
      `UPDATE issues SET manager_escalated_at = now()
        WHERE status IN ${ACTIVE} AND manager_escalated_at IS NULL AND overdue_since IS NOT NULL
          AND overdue_since < $1::timestamptz - make_interval(hours => $2)
        RETURNING id, code, title, area_id, due_at`, [now, cfg.escalation.managerAfterOverdueHours], db);
    const mgrs = esc.length ? await managers(db) : [];
    for (const i of esc) {
      await audit(db, { actorId: null, action: 'issue.escalate', entityType: 'issue', entityId: i.id, issueId: i.id, data: { para: 'gestores', horas_atraso: cfg.escalation.managerAfterOverdueHours } });
      await notify(db, events, {
        userIds: mgrs, type: 'escalonamento', issueId: i.id, dedupeKey: `escalonamento:${i.id}`,
        title: `Escalonamento: ${i.code} atrasada há mais de ${cfg.escalation.managerAfterOverdueHours}h`, body: i.title,
      });
    }

    // 4. Overdue steps → notify step owner once per deadline.
    const steps = await q<any>(
      `SELECT s.id, s.title, s.assignee_id, s.due_at, i.id AS issue_id, i.code FROM steps s JOIN issues i ON i.id = s.issue_id
        WHERE s.status IN ('pendente','em_andamento','bloqueada') AND s.due_at < $1 AND s.assignee_id IS NOT NULL AND i.status IN ${ACTIVE}`, [now], db);
    for (const s of steps) {
      await notify(db, events, {
        userIds: [s.assignee_id], type: 'atrasada', issueId: s.issue_id, dedupeKey: `etapa_atrasada:${s.id}:${new Date(s.due_at).toISOString()}`,
        title: `${s.code}: etapa atrasada`, body: s.title,
      });
    }

    await db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`);
    return { skipped: false, overdue: overdue.length, dueSoon: soon.length, escalated: esc.length };
  });
  for (const e of events) publish(e);
  return result;
}

/** Sends queued e-mails. Failures are retried up to 5 times and recorded. */
export async function deliverEmails(limit = 50) {
  if (!emailEnabled()) return { sent: 0, failed: 0 };
  const rows = await tx(async (db) =>
    q<any>(
      `UPDATE notification_deliveries d SET attempts = attempts + 1
        WHERE d.id IN (SELECT id FROM notification_deliveries WHERE status = 'pendente' AND attempts < 5 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.notification_id, d.attempts`, [limit], db));
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const n = (await q<any>(
      `SELECT n.title, n.body, n.issue_id, u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.id = $1`, [r.notification_id]))[0];
    try {
      const link = n.issue_id ? `\n\nAbrir: ${env.appUrl}/pendencias/${n.issue_id}` : '';
      await sendEmail(n.email, `[Fast Response] ${n.title}`, `${n.title}\n\n${n.body ?? ''}${link}`);
      await q(`UPDATE notification_deliveries SET status = 'enviado', sent_at = now(), last_error = NULL WHERE id = $1`, [r.id]);
      sent++;
    } catch (e: any) {
      await q(`UPDATE notification_deliveries SET status = CASE WHEN attempts >= 5 THEN 'falhou' ELSE 'pendente' END, last_error = $2 WHERE id = $1`, [r.id, String(e?.message ?? e).slice(0, 500)]);
      failed++;
    }
  }
  return { sent, failed };
}

let timer: NodeJS.Timeout | null = null;

export function startJobs(log: { error: (o: unknown, m: string) => void }) {
  if (!env.jobsEnabled) return;
  const tick = async () => {
    try {
      await runDeadlineJobs();
      await deliverEmails();
    } catch (e) {
      log.error(e, 'falha no processamento automático de prazos');
    }
  };
  setTimeout(tick, 2000);
  timer = setInterval(tick, env.jobIntervalSeconds * 1000);
}

export function stopJobs() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { pool };
