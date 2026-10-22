import type { FastifyReply } from 'fastify';
import pg from 'pg';
import { env } from './env.js';

/**
 * Real-time sync. Mutations call publish(), which goes through Postgres NOTIFY so that
 * every server instance receives it and forwards it to its connected browsers (SSE).
 */
type Client = { userId: string; reply: FastifyReply };
const clients = new Set<Client>();
let listener: pg.Client | null = null;
let publisher: pg.Pool | null = null;

export interface RealtimeEvent {
  type: string; // issue.changed | notification | config.changed | quality.changed | os.changed
  issueId?: string;
  userId?: string; // restricts delivery to one user
}

export async function startRealtime() {
  publisher = new pg.Pool({ connectionString: env.databaseUrl, max: 2 });
  const connect = async () => {
    try {
      const c = new pg.Client({ connectionString: env.databaseUrl });
      await c.connect();
      await c.query('LISTEN fr_events');
      c.on('notification', (n) => {
        if (!n.payload) return;
        try {
          fanOut(JSON.parse(n.payload));
        } catch {}
      });
      c.on('error', () => {
        listener = null;
        setTimeout(connect, 2000);
      });
      listener = c;
    } catch {
      setTimeout(connect, 2000);
    }
  };
  await connect();
}

export async function stopRealtime() {
  await listener?.end().catch(() => {});
  await publisher?.end().catch(() => {});
  listener = null;
  publisher = null;
  for (const c of clients) c.reply.raw.end();
  clients.clear();
}

export function publish(e: RealtimeEvent) {
  if (!publisher) return fanOut(e);
  publisher.query('SELECT pg_notify($1, $2)', ['fr_events', JSON.stringify(e)]).catch(() => fanOut(e));
}

function fanOut(e: RealtimeEvent) {
  const data = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) {
    if (e.userId && e.userId !== c.userId) continue;
    c.reply.raw.write(data);
  }
}

export function addClient(userId: string, reply: FastifyReply) {
  const c = { userId, reply };
  clients.add(c);
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
  reply.raw.on('close', () => {
    clearInterval(ping);
    clients.delete(c);
  });
}

export function clientCount() {
  return clients.size;
}
