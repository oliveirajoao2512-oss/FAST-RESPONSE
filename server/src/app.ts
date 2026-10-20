import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';
import { loadSessionUser } from './auth.js';
import { env } from './env.js';
import { AppError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { issueRoutes } from './routes/issues.js';
import { metaRoutes } from './routes/meta.js';

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

  app.all('/api/*', async (_req, reply) => reply.code(404).send({ erro: 'Rota não encontrada.', codigo: 'nao_encontrado' }));

  // Serve the built web app (single-page app) when available.
  if (fs.existsSync(path.join(env.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: env.webDist, wildcard: false, index: false, maxAge: '1h' });
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
