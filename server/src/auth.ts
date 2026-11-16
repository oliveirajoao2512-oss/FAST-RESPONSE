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

/**
 * Each browser tab (or installed app window) can hold its own login: the session token lives in an httpOnly cookie
 * named after the tab's "slot" (fr_s_<slot>), and the tab tells which slot it uses in the x-fr-slot header (or the
 * ?slot= parameter on links, images and the live-update stream, which cannot send headers). The slot is not a secret:
 * without the matching cookie it opens nothing. Tabs without a slot (a link opened in a new tab) use fr_session,
 * which always holds the most recent login of this browser.
 */
const SLOT_RE = /^[A-Za-z0-9_-]{8,32}$/;
const SLOT_PREFIX = 'fr_s_';
const MAX_SLOTS = 8;
export function requestSlot(req: FastifyRequest): string | null {
  const h = req.headers['x-fr-slot'];
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.slot;
  const s = typeof h === 'string' && h ? h : typeof fromQuery === 'string' ? fromQuery : '';
  return SLOT_RE.test(s) ? s : null;
}
/** The session token this request speaks for: the tab's own cookie when it names a slot, otherwise the browser default. */
export function sessionToken(req: FastifyRequest): string | undefined {
  // a tab that logged out says so, and stays logged out even though other windows are logged in
  if (req.headers['x-fr-slot'] === '-') return undefined;
  const slot = requestSlot(req);
  return slot ? req.cookies[SLOT_PREFIX + slot] : req.cookies[COOKIE];
}
const cookieOpts = (expires?: Date) => ({ httpOnly: true, sameSite: 'lax' as const, secure: env.cookieSecure, path: '/', ...(expires ? { expires } : {}) });

/**
 * Opens a session for the tab and returns its slot. `asDefault` (a login) also makes it the browser default that
 * new tabs start from; a tab that only adopts the default login gets its own copy, so leaving it ends only that tab.
 */
export async function createSession(userId: string, req: FastifyRequest, reply: FastifyReply, { asDefault = true } = {}): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const slot = crypto.randomBytes(9).toString('base64url');
  const expires = new Date(Date.now() + env.sessionDays * 86400_000);
  await q(`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`, [
    sha(token), userId, expires, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300),
  ]);
  reply.setCookie(SLOT_PREFIX + slot, token, cookieOpts(expires));
  if (asDefault) reply.setCookie(COOKIE, token, cookieOpts(expires));
  // tidy up: drop slot cookies of sessions that ended, and keep at most a few logins per browser
  const old = Object.entries(req.cookies).filter(([k, v]) => k.startsWith(SLOT_PREFIX) && v);
  if (old.length) {
    const alive = new Set((await q<{ id: string }>(
      'SELECT id FROM sessions WHERE id = ANY($1) AND revoked_at IS NULL AND expires_at > now()', [old.map(([, v]) => sha(v!))])).map((r) => r.id));
    const live = old.filter(([, v]) => alive.has(sha(v!)));
    const drop = [...old.filter(([, v]) => !alive.has(sha(v!))), ...live.slice(0, Math.max(0, live.length - (MAX_SLOTS - 1)))];
    for (const [k] of drop) reply.clearCookie(k, cookieOpts());
  }
  return slot;
}

/** Ends this tab's session. The browser default cookie is cleared too when it points to the same login. */
export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = sessionToken(req);
  if (!token) return;
  if (token) await q(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sha(token)]);
  const slot = requestSlot(req);
  if (slot) reply.clearCookie(SLOT_PREFIX + slot, cookieOpts());
  if (!slot || req.cookies[COOKIE] === token) reply.clearCookie(COOKIE, cookieOpts());
}

export async function revokeUserSessions(userId: string, exceptToken?: string) {
  await q(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`, [
    userId, exceptToken ? sha(exceptToken) : '',
  ]);
}

export async function loadSessionUser(req: FastifyRequest): Promise<SessionUser | null> {
  const token = sessionToken(req);
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
