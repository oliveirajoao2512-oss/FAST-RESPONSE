import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { COOKIE, createSession, destroySession, hashPassword, passwordProblem, requireUser, revokeUserSessions, verifyPassword } from '../auth.js';
import { one, q, pool } from '../db.js';
import { badRequest, unauthorized } from '../errors.js';
import { getConfig } from '../settings.js';
import { parse } from '../validation.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({ login: z.string().min(1).max(200), password: z.string().min(1).max(200) }), req.body);
    const login = body.login.trim().toLowerCase();
    const user = await one<any>(
      `SELECT * FROM users WHERE lower(email) = $1 OR lower(registration) = $1 LIMIT 1`, [login]);
    const fail = () => unauthorized('Usuário ou senha inválidos.');
    if (!user || !user.active) {
      await audit(pool, { actorId: null, action: 'auth.login_failed', entityType: 'user', data: { login }, ip: req.ip });
      throw fail();
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw unauthorized('Conta temporariamente bloqueada por excesso de tentativas. Tente novamente em alguns minutos.');
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      const fails = user.failed_logins + 1;
      const lock = fails >= MAX_FAILS;
      await q(`UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) END WHERE id = $1`,
        [user.id, lock ? 0 : fails, lock, LOCK_MINUTES]);
      await audit(pool, { actorId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, data: { tentativas: fails }, ip: req.ip });
      throw fail();
    }
    await q('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await createSession(user.id, req, reply);
    await audit(pool, { actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip: req.ip });
    return { ok: true, mustChangePassword: user.must_change_password };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.user) await audit(pool, { actorId: req.user.id, action: 'auth.logout', entityType: 'user', entityId: req.user.id, ip: req.ip });
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const u = requireUser(req, { allowPendingPassword: true });
    const cfg = await getConfig();
    const area = u.areaId ? await one('SELECT id, name, slug FROM areas WHERE id = $1', [u.areaId]) : null;
    const unread = await one<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [u.id]);
    return { user: { ...u, area }, timezone: cfg.timezone, unreadNotifications: unread!.n };
  });

  app.post('/api/auth/change-password', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req) => {
    const u = requireUser(req, { allowPendingPassword: true });
    const body = parse(z.object({ current: z.string().min(1), next: z.string().min(1).max(200) }), req.body);
    const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [u.id]);
    if (!(await verifyPassword(body.current, row!.password_hash))) throw badRequest('Senha atual incorreta.');
    const problem = passwordProblem(body.next);
    if (problem) throw badRequest(problem);
    if (body.next === body.current) throw badRequest('A nova senha deve ser diferente da atual.');
    await q('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [u.id, await hashPassword(body.next)]);
    await revokeUserSessions(u.id, req.cookies[COOKIE]);
    await audit(pool, { actorId: u.id, action: 'auth.password_change', entityType: 'user', entityId: u.id, ip: req.ip });
    return { ok: true };
  });
}
