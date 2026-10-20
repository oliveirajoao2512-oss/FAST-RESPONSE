import { q, type Db } from './db.js';

export interface AuditInput {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  issueId?: string | null;
  data?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(db: Db, e: AuditInput) {
  await q(
    `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, issue_id, data, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.actorId, e.action, e.entityType, e.entityId == null ? null : String(e.entityId), e.issueId ?? null, JSON.stringify(e.data ?? {}), e.ip ?? null],
    db,
  );
}
