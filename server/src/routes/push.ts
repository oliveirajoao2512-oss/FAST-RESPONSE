import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth.js';
import { pool, q } from '../db.js';
import { badRequest } from '../errors.js';
import { pushToUser, vapidKeys } from '../push.js';
import { parse } from '../validation.js';

const subscription = z.object({
  endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'endereço inválido'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
  device: z.string().trim().max(120).optional(),
});

/** Phone/tablet notifications: the browser registers here, per user. */
export async function pushRoutes(app: FastifyInstance) {
  app.get('/api/push/key', async (req) => {
    requireUser(req);
    return { publicKey: (await vapidKeys()).publicKey };
  });

  /** Registers this device for the logged user. A device shared by several people follows whoever activated it last. */
  app.post('/api/push/subscribe', async (req) => {
    const u = requireUser(req);
    if (u.preview) throw badRequest('Na visualização como outro perfil não dá para ativar avisos.');
    const b = parse(subscription, req.body);
    const prev = await q<{ user_id: string }>('SELECT user_id FROM push_subscriptions WHERE endpoint = $1', [b.endpoint]);
    await q(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4, device = $5, failures = 0`,
      [u.id, b.endpoint, b.keys.p256dh, b.keys.auth, b.device ?? null]);
    if (prev[0]?.user_id !== u.id) await audit(pool, { actorId: u.id, action: 'push.subscribe', entityType: 'user', entityId: u.id, data: { aparelho: b.device ?? null }, ip: req.ip });
    return { ok: true };
  });

  /** Stops the notifications of this device for the logged user (on "Sair" or when turned off). */
  app.post('/api/push/unsubscribe', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
    const r = await q('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2 RETURNING id', [b.endpoint, u.id]);
    return { ok: true, removed: r.length };
  });

  /** Whether this device is registered for the logged user, and how many devices the user has. */
  app.post('/api/push/status', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ endpoint: z.string().max(1000).optional() }), req.body ?? {});
    const rows = await q<{ endpoint: string }>('SELECT endpoint FROM push_subscriptions WHERE user_id = $1', [u.id]);
    return { here: !!b.endpoint && rows.some((r) => r.endpoint === b.endpoint), devices: rows.length };
  });

  /** Sends a test notification to the user's devices. */
  app.post('/api/push/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const r = await pushToUser(u.id, { title: 'Fast Response: avisos ativados', body: 'É assim que as ordens e pendências vão chegar neste aparelho.', url: '/', tag: 'teste' });
    return r;
  });
}
