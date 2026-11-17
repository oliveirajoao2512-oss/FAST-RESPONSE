import type { NotificationType } from '../../shared/constants.js';
import { q, type Db } from './db.js';
import { emailEnabled } from './mailer.js';
import { kickPush } from './push.js';
import type { RealtimeEvent } from './realtime.js';

export interface NotifyInput {
  userIds: (string | null | undefined)[];
  type: NotificationType;
  title: string;
  body?: string;
  issueId?: string | null;
  workOrderId?: string | null;
  /** Prevents duplicate notifications of the same fact to the same user. */
  dedupeKey?: string;
  /** Do not notify the user who caused the event. */
  exceptUserId?: string | null;
}

/** Persists in-app notifications, queues the phone/tablet push and, when SMTP is configured, the e-mail. */
export async function notify(db: Db, events: RealtimeEvent[], n: NotifyInput) {
  const ids = [...new Set(n.userIds.filter((u): u is string => Boolean(u) && u !== n.exceptUserId))];
  if (ids.length === 0) return;
  const rows = await q<{ id: number; user_id: string }>(
    `INSERT INTO notifications (user_id, type, title, body, issue_id, dedupe_key, work_order_id)
     SELECT u.id, $2, $3, $4, $5, $6, $7 FROM users u WHERE u.id = ANY($1::uuid[]) AND u.active
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, user_id`,
    [ids, n.type, n.title, n.body ?? null, n.issueId ?? null, n.dedupeKey ?? null, n.workOrderId ?? null],
    db,
  );
  if (rows.length && emailEnabled()) {
    await q(
      // users without e-mail only get the in-app notification
    `INSERT INTO notification_deliveries (notification_id, channel, status)
     SELECT n.id, 'email', 'pendente' FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.id = ANY($1::bigint[]) AND u.email IS NOT NULL`,
      [rows.map((r) => r.id)],
      db,
    );
  }
  if (rows.length) {
    // phones and tablets the users registered for notifications
    const queued = await q(
      `INSERT INTO notification_deliveries (notification_id, channel, status)
       SELECT n.id, 'push', 'pendente' FROM notifications n
        WHERE n.id = ANY($1::bigint[]) AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = n.user_id) RETURNING id`,
      [rows.map((r) => r.id)],
      db,
    );
    if (queued.length) kickPush();
  }
  for (const r of rows) events.push({ type: 'notification', userId: r.user_id });
}

export async function areaLeaders(db: Db, areaIds: (number | null | undefined)[]): Promise<string[]> {
  const ids = areaIds.filter((a): a is number => typeof a === 'number');
  if (!ids.length) return [];
  return (await q<{ id: string }>(`SELECT id FROM users WHERE active AND role = 'lider' AND area_id = ANY($1)`, [ids], db)).map((r) => r.id);
}

export async function managers(db: Db): Promise<string[]> {
  return (await q<{ id: string }>(`SELECT id FROM users WHERE active AND role = 'gestor'`, [], db)).map((r) => r.id);
}
