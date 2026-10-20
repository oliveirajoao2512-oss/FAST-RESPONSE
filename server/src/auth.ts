import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '../../shared/constants.js';
import type { SessionUser } from './context.js';
import { one, q } from './db.js';
import { env } from './env.js';
import { forbidden, unauthorized } from './errors.js';

export const COOKIE = 'fr_session';
const BCRYPT_COST = Number(process.env.BCRYPT_COST ?? 12);

export const hashPassword = (p: string) => bcrypt.hash(p, BCRYPT_COST);
export const verifyPassword = (p: string, h: string) => bcrypt.compare(p, h);

export function passwordProblem(p: string): string | null {
  if (p.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'A senha deve conter letras e números.';
  return null;
}

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export async function createSession(userId: string, req: FastifyRequest, reply: FastifyReply) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + env.sessionDays * 86400_000);
  await q(`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`, [
    sha(token), userId, expires, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300),
  ]);
  reply.setCookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: env.cookieSecure, path: '/', expires,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  if (token) await q(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sha(token)]);
  reply.clearCookie(COOKIE, { path: '/' });
}

export async function revokeUserSessions(userId: string, exceptToken?: string) {
  await q(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`, [
    userId, exceptToken ? sha(exceptToken) : '',
  ]);
}

export async function loadSessionUser(req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const row = await one<any>(
    `UPDATE sessions s SET last_seen_at = now()
       FROM users u
      WHERE s.id = $1 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active
     RETURNING u.id, u.name, u.email, u.role, u.area_id, u.must_change_password`,
    [sha(token)],
  );
  if (!row) return null;
  return {
    id: row.id, name: row.name, email: row.email, role: row.role as Role, areaId: row.area_id,
    mustChangePassword: row.must_change_password,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/** Returns the logged user or throws 401. Blocks everything but password change while a reset is pending. */
export function requireUser(req: FastifyRequest, opts: { allowPendingPassword?: boolean } = {}): SessionUser {
  if (!req.user) throw unauthorized();
  if (req.user.mustChangePassword && !opts.allowPendingPassword) throw forbidden('Altere sua senha provisória para continuar.');
  return req.user;
}
