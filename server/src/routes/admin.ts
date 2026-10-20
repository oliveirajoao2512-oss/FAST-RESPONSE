import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_CONFIG, mergeConfig } from '../../../shared/config.js';
import { ROLES } from '../../../shared/constants.js';
import { can } from '../../../shared/permissions.js';
import { audit } from '../audit.js';
import { hashPassword, passwordProblem, requireUser, revokeUserSessions } from '../auth.js';
import { one, pool, q } from '../db.js';
import { emailEnabled } from '../mailer.js';
import { storage } from '../storage.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { publish } from '../realtime.js';
import { getConfig, invalidateConfig } from '../settings.js';
import { optText, parse, uuid } from '../validation.js';

const userBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email('e-mail inválido').max(200),
  registration: optText(40),
  role: z.enum(ROLES),
  areaId: z.number().int().positive().nullish(),
  active: z.boolean().default(true),
});

export async function adminRoutes(app: FastifyInstance) {
  const admin = (req: any) => {
    const u = requireUser(req);
    if (!can.manageUsers(u)) throw forbidden('Somente administradores.');
    return u;
  };

  app.get('/api/admin/users', async (req) => {
    admin(req);
    return q(`SELECT u.id, u.name, u.email, u.registration, u.role, u.area_id, a.name AS area_name, u.active, u.must_change_password,
                     u.last_login_at, u.created_at, (u.locked_until > now()) AS locked
                FROM users u LEFT JOIN areas a ON a.id = u.area_id ORDER BY u.active DESC, u.name`);
  });

  app.post('/api/admin/users', async (req, reply) => {
    const me = admin(req);
    const b = parse(userBody.extend({ password: z.string().min(1).max(200) }), req.body);
    const problem = passwordProblem(b.password);
    if (problem) throw badRequest(problem);
    if ((b.role === 'lider' || b.role === 'colaborador') && !b.areaId) throw badRequest('Líderes e colaboradores precisam de uma área.');
    try {
      const row = await one<{ id: string }>(
        `INSERT INTO users (name, email, registration, role, area_id, active, password_hash, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
        [b.name, b.email, b.registration, b.role, b.areaId ?? null, b.active, await hashPassword(b.password)]);
      await audit(pool, { actorId: me.id, action: 'user.create', entityType: 'user', entityId: row!.id, data: { nome: b.name, email: b.email, perfil: b.role, area: b.areaId }, ip: req.ip });
      reply.code(201);
      return row;
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Já existe usuário com este e-mail ou matrícula.');
      throw e;
    }
  });

  app.put('/api/admin/users/:id', async (req) => {
    const me = admin(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(userBody, req.body);
    const before = await one<any>('SELECT name, email, registration, role, area_id, active FROM users WHERE id = $1', [id]);
    if (!before) throw notFound();
    if (id === me.id && (b.role !== 'admin' || !b.active)) throw badRequest('Você não pode remover seu próprio acesso de administrador.');
    if ((b.role === 'lider' || b.role === 'colaborador') && !b.areaId) throw badRequest('Líderes e colaboradores precisam de uma área.');
    try {
      await q(`UPDATE users SET name=$2, email=$3, registration=$4, role=$5, area_id=$6, active=$7, updated_at=now() WHERE id=$1`,
        [id, b.name, b.email, b.registration, b.role, b.areaId ?? null, b.active]);
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Já existe usuário com este e-mail ou matrícula.');
      throw e;
    }
    if (!b.active || b.role !== before.role) await revokeUserSessions(id);
    await audit(pool, { actorId: me.id, action: 'user.update', entityType: 'user', entityId: id, data: { antes: before, depois: b }, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-password', async (req) => {
    const me = admin(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);
    const r = await one('UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1 RETURNING id', [id, await hashPassword(password)]);
    if (!r) throw notFound();
    await revokeUserSessions(id);
    await audit(pool, { actorId: me.id, action: 'user.reset_password', entityType: 'user', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // ------------------------------------------------------------ settings

  app.get('/api/admin/settings', async (req) => {
    const u = requireUser(req);
    if (!can.manageSettings(u) && !can.viewAudit(u)) throw forbidden();
    return { config: await getConfig(), defaults: DEFAULT_CONFIG, emailEnabled: emailEnabled(), storage: storage.name };
  });

  app.put('/api/admin/settings', async (req) => {
    const u = requireUser(req);
    if (!can.manageSettings(u)) throw forbidden('Somente administradores alteram configurações.');
    const body = parse(z.object({ config: z.record(z.string(), z.any()) }), req.body);
    const cfg = mergeConfig(body.config);
    validateConfig(cfg);
    const before = await getConfig();
    await q(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('config', $1, $2, now())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`, [JSON.stringify(cfg), u.id]);
    invalidateConfig();
    await audit(pool, { actorId: u.id, action: 'settings.update', entityType: 'settings', entityId: 'config', data: { antes: before, depois: cfg }, ip: req.ip });
    publish({ type: 'config.changed' });
    return { config: cfg };
  });

  // ------------------------------------------------------------ catalogs

  const catalog = (req: any) => {
    const u = requireUser(req);
    if (!can.manageCatalog(u)) throw forbidden('Somente gestores e administradores alteram cadastros.');
    return u;
  };
  const catBody = z.object({
    name: z.string().trim().min(2).max(80), areaId: z.number().int().positive().nullish(),
    isSafety: z.boolean().default(false), requiresEvidence: z.boolean().default(false), active: z.boolean().default(true),
  });
  app.post('/api/admin/categories', async (req) => {
    const u = catalog(req);
    const b = parse(catBody, req.body);
    const r = await one(`INSERT INTO categories (name, area_id, is_safety, requires_evidence, active) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [b.name, b.areaId ?? null, b.isSafety, b.requiresEvidence, b.active]);
    await audit(pool, { actorId: u.id, action: 'category.create', entityType: 'category', entityId: (r as any).id, data: b, ip: req.ip });
    return r;
  });
  app.put('/api/admin/categories/:id', async (req) => {
    const u = catalog(req);
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    const b = parse(catBody, req.body);
    await q(`UPDATE categories SET name=$2, area_id=$3, is_safety=$4, requires_evidence=$5, active=$6 WHERE id=$1`, [id, b.name, b.areaId ?? null, b.isSafety, b.requiresEvidence, b.active]);
    await audit(pool, { actorId: u.id, action: 'category.update', entityType: 'category', entityId: id, data: b, ip: req.ip });
    return { ok: true };
  });

  const assetBody = z.object({
    type: z.enum(['maquina', 'equipamento', 'molde', 'item', 'op', 'outro']), code: z.string().trim().min(1).max(60),
    description: optText(200), areaId: z.number().int().positive().nullish(), active: z.boolean().default(true),
  });
  app.post('/api/admin/assets', async (req) => {
    const u = catalog(req);
    const b = parse(assetBody, req.body);
    const r = await one(`INSERT INTO assets (type, code, description, area_id, active) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [b.type, b.code, b.description, b.areaId ?? null, b.active]);
    await audit(pool, { actorId: u.id, action: 'asset.create', entityType: 'asset', entityId: (r as any).id, data: b, ip: req.ip });
    return r;
  });
  app.put('/api/admin/assets/:id', async (req) => {
    const u = catalog(req);
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    const b = parse(assetBody, req.body);
    await q(`UPDATE assets SET type=$2, code=$3, description=$4, area_id=$5, active=$6 WHERE id=$1`, [id, b.type, b.code, b.description, b.areaId ?? null, b.active]);
    await audit(pool, { actorId: u.id, action: 'asset.update', entityType: 'asset', entityId: id, data: b, ip: req.ip });
    return { ok: true };
  });

  app.put('/api/admin/step-templates', async (req) => {
    const u = catalog(req);
    const b = parse(z.object({ templates: z.array(z.object({ name: z.string().trim().min(2).max(80), steps: z.array(z.string().trim().min(1).max(200)).min(1).max(30) })).max(50) }), req.body);
    await q(`INSERT INTO settings (key, value, updated_by) VALUES ('step_templates', $1, $2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`,
      [JSON.stringify(b.templates), u.id]);
    await audit(pool, { actorId: u.id, action: 'step_templates.update', entityType: 'settings', entityId: 'step_templates', data: { modelos: b.templates.length }, ip: req.ip });
    return { ok: true };
  });

  // ------------------------------------------------------------ audit

  app.get('/api/admin/audit', async (req) => {
    const u = requireUser(req);
    if (!can.viewAudit(u)) throw forbidden('Somente gestores e administradores consultam a auditoria.');
    const qs = parse(z.object({
      action: z.string().max(60).optional(), actorId: uuid.optional(), issue: z.string().max(40).optional(),
      from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().max(500).default(200), offset: z.coerce.number().int().default(0),
    }), req.query);
    const p: unknown[] = [];
    const w = ['TRUE'];
    if (qs.action) { p.push(qs.action + '%'); w.push(`e.action LIKE $${p.length}`); }
    if (qs.actorId) { p.push(qs.actorId); w.push(`e.actor_id = $${p.length}`); }
    if (qs.issue) { p.push(qs.issue.toUpperCase()); w.push(`i.code = $${p.length}`); }
    if (qs.from) { p.push(qs.from); w.push(`e.at >= $${p.length}::date`); }
    if (qs.to) { p.push(qs.to); w.push(`e.at < $${p.length}::date + 1`); }
    return q(`SELECT e.id, e.at, e.action, e.entity_type, e.entity_id, e.data, e.ip, u.name AS actor_name, i.code AS issue_code, i.id AS issue_id
                FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN issues i ON i.id = e.issue_id
               WHERE ${w.join(' AND ')} ORDER BY e.at DESC, e.id DESC LIMIT ${qs.limit} OFFSET ${qs.offset}`, p);
  });
}

function validateConfig(c: ReturnType<typeof mergeConfig>) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: c.timezone });
  } catch {
    throw badRequest('Fuso horário inválido.');
  }
  if (!/^\d{2}:\d{2}$/.test(c.deadline.time)) throw badRequest('Horário de vencimento inválido (use HH:MM).');
  if (c.deadline.days < 0 || c.deadline.days > 30) throw badRequest('Prazo padrão deve estar entre 0 e 30 dias.');
  if (c.deadline.criticalSafetyHours < 1 || c.deadline.criticalSafetyHours > 72) throw badRequest('Prazo de segurança crítica deve estar entre 1 e 72 horas.');
  if (c.complexity.moderateMinSteps >= c.complexity.complexMinSteps) throw badRequest('Etapas para "complexa" devem ser maiores que para "moderada".');
  for (const v of Object.values(c.scoring.base)) if (v < 0 || v > 1000) throw badRequest('Pontuação base inválida.');
  if (c.deadline.holidays.some((h) => !/^\d{4}-\d{2}-\d{2}$/.test(h))) throw badRequest('Feriados devem estar no formato AAAA-MM-DD.');
}
