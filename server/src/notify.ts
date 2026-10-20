import type { NotificationType } from '../../shared/constants.js';
import { q, type Db } from './db.js';
import { emailEnabled } from './mailer.js';
import type { RealtimeEvent } from './realtime.js';

export interface NotifyInput {
  userIds: (string | null | undefined)[];
  type: NotificationType;
  title: string;
  body?: string;
  issueId?: string | null;
  /** Prevents duplicate notifications of the same fact to the same user. */
  dedupeKey?: string;
  /** Do not notify the user who caused the event. */
  exceptUserId?: string | null;
}

/** Persists in-app notifications (and queues e-mail when SMTP is configured). */
export async function notify(db: Db, events: RealtimeEvent[], n: NotifyInput) {
  const ids = [...new Set(n.userIds.filter((u): u is string => Boolean(u) && u !== n.exceptUserId))];
  if (ids.length === 0) return;
  const rows = await q<{ id: number; user_id: string }>(
    `INSERT INTO notifications (user_id, type, title, body, issue_id, dedupe_key)
     SELECT u.id, $2, $3, $4, $5, $6 FROM users u WHERE u.id = ANY($1::uuid[]) AND u.active
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, user_id`,
    [ids, n.type, n.title, n.body ?? null, n.issueId ?? null, n.dedupeKey ?? null],
    db,
  );
  if (rows.length && emailEnabled()) {
    await q(
      `INSERT INTO notification_deliveries (notification_id, channel, status) SELECT unnest($1::bigint[]), 'email', 'pendente'`,
      [rows.map((r) => r.id)],
      db,
    );
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
