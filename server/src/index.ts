import { buildApp } from './app.js';
import { migrate, pool } from './db.js';
import { env } from './env.js';
import { startRealtime, stopRealtime } from './realtime.js';
import { startJobs, stopJobs } from './services/jobs.js';
import { ensureBootstrapAdmin } from './cli/bootstrap.js';

const app = await buildApp({ logger: true });
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
