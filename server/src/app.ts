import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';
import type { Role } from '../../shared/constants.js';
import { loadSessionUser } from './auth.js';
import { env } from './env.js';
import { AppError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { issueRoutes } from './routes/issues.js';
import { metaRoutes } from './routes/meta.js';
import { qualityRoutes } from './routes/quality.js';
import { qualityActionRoutes } from './routes/qualityActions.js';
import { workOrderRoutes } from './routes/workOrders.js';

/** API routes each single-module profile may call: maintainers the maintenance orders, process technicians the adjustment orders. */
const ORDER_ONLY: Partial<Record<Role, { routes: RegExp; message: string }>> = {
  manutentor: {
    routes: /^\/api\/(auth\/|os(\/|\?|$)|events(\?|$)|notifications(\/|\?|$)|health(\?|$))/,
    message: 'Seu acesso é somente às Ordens de Manutenção.',
  },
  tecnico_processo: {
    routes: /^\/api\/(auth\/|oa(\/|\?|$)|events(\?|$)|notifications(\/|\?|$)|health(\?|$))/,
    message: 'Seu acesso é somente às Ordens de Ajuste.',
  },
};

/** Cookie set by the web app while an administrator previews another profile: "role" or "role:areaId". */
const PREVIEW_COOKIE = 'fr_view_as';
const PREVIEW = /^(gestor|lider|colaborador|manutentor|tecnico_processo)(?::(\d{1,6}))?$/;

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 10 } });

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // CSRF: state-changing requests must carry a custom header, which browsers
    // never attach to cross-site requests without CORS (which is not enabled).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'fast-response') {
      return reply.code(403).send({ erro: 'Requisição recusada (cabeçalho de segurança ausente).', codigo: 'csrf' });
    }
    req.user = await loadSessionUser(req);
    // "Visualizar como": an administrator sees the system with another profile's permissions, read-only.
    const view = req.user?.role === 'admin' ? PREVIEW.exec(req.cookies[PREVIEW_COOKIE] ?? '') : null;
    if (req.user && view) {
      req.user = { ...req.user, role: view[1] as Role, areaId: view[2] ? Number(view[2]) : null, preview: true };
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.url.startsWith('/api/auth/')) {
        return reply.code(403).send({ erro: 'Modo de visualização: somente leitura. Saia da visualização para fazer alterações.', codigo: 'visualizacao' });
      }
    }
    // Maintainers and process technicians only use their order module: everything else is refused here, not just hidden.
    const only = req.user ? ORDER_ONLY[req.user.role] : undefined;
    if (only && !only.routes.test(req.url)) {
      return reply.code(403).send({ erro: only.message, codigo: 'sem_permissao' });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });

  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ erro: err.message, codigo: err.code, detalhes: err.details });
    }
    const fe = err as FastifyError & { code?: string };
    if (fe.statusCode === 429) return reply.code(429).send({ erro: 'Muitas tentativas. Aguarde alguns minutos.', codigo: 'limite' });
    if (fe.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ erro: `Arquivo maior que ${env.maxUploadMb} MB.`, codigo: 'arquivo_grande' });
    if (fe.statusCode && fe.statusCode < 500) return reply.code(fe.statusCode).send({ erro: fe.message, codigo: 'requisicao_invalida' });
    // Postgres errors raised by our immutability triggers
    if ((err as any).code === 'P0001') return reply.code(422).send({ erro: err.message, codigo: 'regra_de_negocio' });
    if ((err as any).code === '23505') return reply.code(409).send({ erro: 'Registro duplicado.', codigo: 'duplicado' });
    req.log.error(err);
    return reply.code(500).send({ erro: 'Erro interno. A operação não foi concluída; tente novamente.', codigo: 'erro_interno' });
  });

  app.get('/api/health', async () => {
    const { pool } = await import('./db.js');
    await pool.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });

  await app.register(authRoutes);
  await app.register(issueRoutes);
  await app.register(analyticsRoutes);
  await app.register(adminRoutes);
  await app.register(metaRoutes);
  await app.register(qualityRoutes);
  await app.register(qualityActionRoutes);
  await app.register(workOrderRoutes);

  app.all('/api/*', async (_req, reply) => reply.code(404).send({ erro: 'Rota não encontrada.', codigo: 'nao_encontrado' }));

  // Serve the built web app (single-page app) when available.
  if (fs.existsSync(path.join(env.webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: env.webDist, wildcard: false, index: false, maxAge: '1h',
      // hashed assets may be cached; the page, service worker and manifest must be revalidated after each deploy
      setHeaders: (res, file) => {
        if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(file)) res.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        reply.header('Cache-Control', 'no-cache');
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ erro: 'Rota não encontrada.' });
    });
    app.get('/*', (req, reply) => {
      const p = (req.params as any)['*'] as string;
      if (p && fs.existsSync(path.join(env.webDist, p)) && !p.includes('..')) return reply.sendFile(p);
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  }
  return app;
}
