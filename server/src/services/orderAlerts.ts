import { placeLabel, WO_DOMAIN, woCategory, type WoDomain } from '../../../shared/maintenance.js';
import { audit } from '../audit.js';
import { q, tx, type Db } from '../db.js';
import { notify } from '../notify.js';
import { publish, type RealtimeEvent } from '../realtime.js';
import { domainAreaId, domainTeam } from '../routes/workOrders.js';
import { getConfig } from '../settings.js';

/** "45 min", "2 h", "1 h 30 min" */
export function waitText(minutes: number) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Gestores and líderes of the area that runs the domain's queue, and the plant managers. */
async function leadership(d: WoDomain, db: Db) {
  const areaId = await domainAreaId(d);
  return (await q<{ id: string }>(
    `SELECT id FROM users WHERE active AND (role = 'plant_manager' OR (role IN ('gestor','lider') AND area_id = $1))`, [areaId], db)).map((r) => r.id);
}

/**
 * Reminders of orders nobody accepted yet. Level 1 warns the technicians and leaders again; level 2 warns the gestores
 * of the area and the plant managers. Times differ for a stopped machine and a running one (Gestão → Configurações).
 * Each level fires once per order (work_orders.alert_level). Safe on several instances (advisory lock).
 */
export async function runOrderAlerts(now = new Date()) {
  const events: RealtimeEvent[] = [];
  const result = await tx(async (db) => {
    const got = (await db.query('SELECT pg_try_advisory_xact_lock(727004) AS ok')).rows[0].ok;
    if (!got) return { skipped: true, reminded: 0, escalated: 0 };
    const o = (await getConfig(db)).orders;
    const levelSql = (level: 1 | 2, stoppedMin: number, runningMin: number) => q<any>(
      `UPDATE work_orders w SET alert_level = $2
        WHERE w.status = 'aberta' AND w.first_accepted_at IS NULL AND NOT w.scheduled AND NOT w.imported AND w.alert_level < $2
          AND (CASE WHEN w.machine_stopped THEN $3::int ELSE $4::int END) > 0
          AND w.opened_at <= $1::timestamptz - make_interval(mins => CASE WHEN w.machine_stopped THEN $3::int ELSE $4::int END)
        RETURNING w.id, w.domain, w.code, w.asset_ref, w.location_type, w.component, w.tool_code, w.machine_stopped, w.kind, w.reason, w.description, w.opened_at`,
      [now, level, stoppedMin, runningMin], db);

    // the managers' level first: an order that already passed both times (server was asleep) warns everyone once
    const esc = await levelSql(2, o.stoppedManagerMinutes, o.runningManagerMinutes);
    const rem = await levelSql(1, o.stoppedRemindMinutes, o.runningRemindMinutes);
    const escIds = new Set(esc.map((w) => w.id));

    const send = async (w: any, level: 1 | 2) => {
      const d = w.domain as WoDomain;
      const D = WO_DOMAIN[d];
      const waited = waitText((now.getTime() - new Date(w.opened_at).getTime()) / 60000);
      const where = placeLabel(w);
      const team = (await domainTeam(d, db, await domainAreaId(d))).map((t) => t.id);
      const to = level === 2 ? [...team, ...(await leadership(d, db))] : team;
      await notify(db, events, {
        userIds: to, type: 'os_cobranca', workOrderId: w.id, dedupeKey: `cobranca:${level}:${w.id}`,
        title: w.machine_stopped
          ? `${w.code}: ${where} PARADA há ${waited} sem atendimento`
          : `${w.code}: ${where} aguardando aceite há ${waited}`,
        body: `${level === 2 ? `Ninguém aceitou ${D.short === 'OS' ? 'a OS' : 'a OA'}: gestores avisados. ` : ''}${woCategory(w)} · ${String(w.description).slice(0, 140)}`,
      });
      await audit(db, {
        actorId: null, action: `${D.short.toLowerCase()}.cobranca`, entityType: 'work_order', entityId: w.id,
        data: { codigo: w.code, nivel: level === 2 ? 'gestores' : 'equipe', espera: waited, parada: w.machine_stopped },
      });
    };
    for (const w of esc) await send(w, 2);
    for (const w of rem) if (!escIds.has(w.id)) await send(w, 1);
    return { skipped: false, reminded: rem.length, escalated: esc.length };
  });
  for (const e of events) publish(e);
  return result;
}
