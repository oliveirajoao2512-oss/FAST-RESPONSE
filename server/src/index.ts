import { buildApp } from './app.js';
import { migrate, pool } from './db.js';
import { env } from './env.js';
import { startRealtime, stopRealtime } from './realtime.js';
import { startJobs, stopJobs } from './services/jobs.js';
import { ensureBootstrapAdmin } from './cli/bootstrap.js';

/** Connection target without the password, to diagnose misconfigured DATABASE_URL values. */
function describeDatabaseUrl(url: string) {
  try {
    const u = new URL(url);
    return `host=${u.hostname} porta=${u.port || 5432} usuario=${decodeURIComponent(u.username)} banco=${u.pathname.slice(1)} ssl=${u.searchParams.get('sslmode') ?? 'nao'}`;
  } catch {
    return `DATABASE_URL inválida (começa com "${url.slice(0, 14)}…", ${url.length} caracteres)`;
  }
}

const app = await buildApp({ logger: true });
app.log.info(`banco de dados: ${describeDatabaseUrl(env.databaseUrl)}`);
await migrate((m) => app.log.info(m));
await ensureBootstrapAdmin((m) => app.log.warn(m));
await startRealtime();
startJobs(app.log);
await app.listen({ port: env.port, host: env.host });

const shutdown = async () => {
  stopJobs();
  await app.close();
  await stopRealtime();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
