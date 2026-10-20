import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from './env.js';

// timestamptz → Date, numeric → number, bigint → number (ids/counts stay well below 2^53)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export type Db = pg.Pool | pg.PoolClient;

export let pool = new pg.Pool({ connectionString: env.databaseUrl, max: 20 });

export function setPool(p: pg.Pool) {
  pool = p;
}

/**
 * Drops parameters the statement does not reference and renumbers the placeholders, so
 * queries can share one parameter list built by filter helpers (Postgres rejects unused params).
 */
export function compactParams(sql: string, params: unknown[]): [string, unknown[]] {
  const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  if (used.length === params.length && used.every((n, i) => n === i + 1)) return [sql, params];
  const map = new Map(used.map((n, i) => [n, i + 1]));
  return [sql.replace(/\$(\d+)/g, (_, n) => `$${map.get(Number(n))}`), used.map((n) => params[n - 1])];
}

export async function q<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const [text, values] = compactParams(sql, params);
  const r = await db.query(text, values as any[]);
  return r.rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  return (await q<T>(sql, params, db))[0];
}

/** Runs fn inside a transaction. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

function migrationsDir() {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'db/migrations'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations'), // dist/cli/*.js
    path.resolve(process.cwd(), 'src/db/migrations'),
  ];
  const found = candidates.find((d) => fs.existsSync(d));
  if (!found) throw new Error('Pasta de migrações não encontrada');
  return found;
}

/** Applies pending SQL migrations in order, each in its own transaction, under an advisory lock. */
export async function migrate(log: (m: string) => void = console.log) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = migrationsDir();
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        log(`migração aplicada: ${f}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
}
