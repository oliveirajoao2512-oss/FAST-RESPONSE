import type pg from 'pg';
import type { Actor } from '../../shared/permissions.js';
import { pool } from './db.js';
import { publish, type RealtimeEvent } from './realtime.js';

export interface SessionUser extends Actor {
  name: string;
  email: string;
  mustChangePassword: boolean;
}

/** A unit of work: one transaction + the realtime events to publish after it commits. */
export interface Ctx {
  db: pg.PoolClient;
  actor: SessionUser;
  ip: string | null;
  events: RealtimeEvent[];
}

export async function withTx<T>(actor: SessionUser, ip: string | null, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  const ctx: Ctx = { db, actor, ip, events: [] };
  try {
    await db.query('BEGIN');
    const out = await fn(ctx);
    await db.query('COMMIT');
    for (const e of dedupe(ctx.events)) publish(e);
    return out;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

function dedupe(events: RealtimeEvent[]) {
  const seen = new Set<string>();
  return events.filter((e) => {
    const k = JSON.stringify(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
