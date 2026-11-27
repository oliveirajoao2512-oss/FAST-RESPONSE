import webpush from 'web-push';
import { one, q, tx, type Db, pool } from './db.js';
import { env } from './env.js';

/**
 * Phone, tablet and computer notifications (Web Push): they arrive with the app closed, like a message.
 * Free and with no outside account: the browser's own push service (Google, Apple, Mozilla) carries them.
 * The server keys (VAPID) come from the environment or are created once and kept in the settings table.
 */
let keys: { publicKey: string; privateKey: string } | null = null;

export async function vapidKeys(db: Db = pool) {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const fresh = webpush.generateVAPIDKeys();
    // the first instance to boot wins; the others read what it stored
    await q(`INSERT INTO settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(fresh)], db);
    const row = await one<{ value: { publicKey: string; privateKey: string } }>(`SELECT value FROM settings WHERE key = 'vapid'`, [], db);
    keys = row!.value;
  }
  return keys;
}

/** Contact the push services may use about this server: the app address (no personal e-mail). */
const subject = () => [env.appUrl, process.env.RENDER_EXTERNAL_URL].find((u) => u && /^https:\/\/[^/]*\.[a-z]{2,}/i.test(u) && !/localhost/.test(u))
  ?? 'mailto:fastresponse@example.com';

export interface PushMessage {
  title: string;
  body?: string | null;
  /** page to open when the notification is touched */
  url: string;
  /** same tag replaces the previous notification of the same order */
  tag?: string;
  /** urgent: stays on screen until touched, and the push service delivers at once */
  urgent?: boolean;
}

export interface PushResult { sent: number; gone: number; failed: number }

/** Sends one message to every registered device of a user. Devices the push service no longer knows are removed. */
export async function pushToUser(userId: string, msg: PushMessage): Promise<PushResult> {
  const subs = await q<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
  const r: PushResult = { sent: 0, gone: 0, failed: 0 };
  if (!subs.length) return r;
  const k = await vapidKeys();
  const payload = JSON.stringify({ title: msg.title, body: msg.body ?? '', url: msg.url, tag: msg.tag, urgent: !!msg.urgent });
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
        vapidDetails: { subject: subject(), publicKey: k.publicKey, privateKey: k.privateKey },
        // always "high": with "normal" Android holds the message while the phone is idle (Doze) and it arrives late or
        // only when the screen is turned on, which looked like notifications that "do not arrive every time"
        TTL: msg.urgent ? 2 * 60 * 60 : 12 * 60 * 60,
        urgency: 'high',
        timeout: 10_000,
      });
      await q('UPDATE push_subscriptions SET last_ok_at = now(), failures = 0 WHERE id = $1', [s.id]);
      r.sent++;
    } catch (e: any) {
      const status = e?.statusCode;
      if (status === 404 || status === 410) {
        await q('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        r.gone++;
      } else {
        // a device that keeps failing (bad keys, uninstalled browser) is dropped after a while
        await q('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [s.id]);
        await q('DELETE FROM push_subscriptions WHERE id = $1 AND failures >= 20', [s.id]);
        r.failed++;
      }
    }
  }
  return r;
}

const URGENT_TYPES = new Set(['os_aberta', 'os_cobranca', 'seguranca_critica', 'escalonamento']);

/** Sends the queued push deliveries (one per notification). */
export async function deliverPush(limit = 50) {
  const rows = await tx(async (db) => q<{ id: number; notification_id: number }>(
    `UPDATE notification_deliveries d SET attempts = attempts + 1
      WHERE d.id IN (SELECT id FROM notification_deliveries WHERE channel = 'push' AND status = 'pendente' AND attempts < 3
                     ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.notification_id`, [limit], db));
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const n = (await q<any>(
      `SELECT n.user_id, n.type, n.title, n.body, n.issue_id, n.work_order_id, w.domain
         FROM notifications n LEFT JOIN work_orders w ON w.id = n.work_order_id WHERE n.id = $1`, [r.notification_id]))[0];
    try {
      if (!n) throw new Error('notificação não encontrada');
      const url = n.type === 'producao_hora' ? '/producao' : n.work_order_id ? `${n.domain === 'ajuste' ? '/ajustes' : '/os'}?id=${n.work_order_id}` : n.issue_id ? `/pendencias/${n.issue_id}` : '/notificacoes';
      const res = await pushToUser(n.user_id, {
        title: n.title, body: n.body, url, tag: n.work_order_id ?? n.issue_id ?? (n.type === 'producao_hora' ? 'producao_hora' : undefined), urgent: URGENT_TYPES.has(n.type),
      });
      const ok = res.sent > 0 || res.failed === 0;
      await q(`UPDATE notification_deliveries SET status = $2, sent_at = now(), last_error = $3 WHERE id = $1`,
        [r.id, res.sent ? 'enviado' : ok ? 'sem_aparelho' : 'falhou', res.failed ? `${res.failed} aparelho(s) falharam` : null]);
      if (res.sent) sent++; else if (!ok) failed++;
    } catch (e: any) {
      await q(`UPDATE notification_deliveries SET status = 'falhou', last_error = $2 WHERE id = $1`, [r.id, String(e?.message ?? e).slice(0, 500)]);
      failed++;
    }
  }
  return { sent, failed };
}

// A notification is sent right after the request that created it finishes (its transaction is committed by then);
// anything missed is picked up by the periodic job.
let kickTimer: NodeJS.Timeout | null = null;
let running: Promise<unknown> | null = null;
export function kickPush() {
  if (!env.jobsEnabled || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    running = (running ?? Promise.resolve()).then(() => deliverPush()).catch(() => {}).finally(() => { running = null; });
  }, 400);
}
