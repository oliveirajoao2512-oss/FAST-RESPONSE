import { q, type Db } from '../db.js';

/**
 * Permanent deletion (administrators only) for test records: removes the record and everything
 * linked to it, including its history. Must run inside a transaction.
 * Returns the storage paths of attachments, to be removed after commit.
 */
export async function purgeIssue(db: Db, id: string): Promise<string[]> {
  await q(`SET LOCAL fr.purge = 'on'`, [], db);
  const files = (await q<{ storage_path: string }>('SELECT storage_path FROM attachments WHERE issue_id = $1', [id], db)).map((r) => r.storage_path);
  await q('DELETE FROM notification_deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE issue_id = $1)', [id], db);
  await q('DELETE FROM notifications WHERE issue_id = $1', [id], db);
  await q('DELETE FROM meeting_decisions WHERE issue_id = $1', [id], db);
  // the NC step it came from can be suggested again
  await q('DELETE FROM quality_actions WHERE issue_id = $1', [id], db);
  for (const t of ['attachments', 'comments', 'impediments', 'deadline_changes', 'transfers', 'validations', 'reopenings', 'issue_status_history']) {
    await q(`DELETE FROM ${t} WHERE issue_id = $1`, [id], db);
  }
  await q('DELETE FROM steps WHERE issue_id = $1', [id], db);
  await q(`DELETE FROM audit_events WHERE issue_id = $1 OR (entity_type = 'issue' AND entity_id = $1::text)`, [id], db);
  await q('UPDATE issues SET recurrence_of_id = NULL WHERE recurrence_of_id = $1', [id], db);
  await q('DELETE FROM issues WHERE id = $1', [id], db);
  return files;
}

export async function purgeQualityNc(db: Db, id: number, withIssues: boolean): Promise<string[]> {
  await q(`SET LOCAL fr.purge = 'on'`, [], db);
  const issues = (await q<{ issue_id: string }>('SELECT issue_id FROM quality_actions WHERE nc_id = $1 AND issue_id IS NOT NULL', [id], db)).map((r) => r.issue_id);
  await q('DELETE FROM quality_actions WHERE nc_id = $1', [id], db);
  const files: string[] = [];
  if (withIssues) for (const i of issues) files.push(...(await purgeIssue(db, i)));
  await q(`DELETE FROM audit_events WHERE entity_type = 'quality_nc' AND entity_id = $1::text`, [id], db);
  await q('DELETE FROM quality_ncs WHERE id = $1', [id], db);
  return files;
}
