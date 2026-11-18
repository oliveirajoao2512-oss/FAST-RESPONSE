import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { OPEN_STATUSES } from '../../../shared/constants.js';
import { placeLabel, woCategory, type WoLocation } from '../../../shared/maintenance.js';
import { requireUser } from '../auth.js';
import { q } from '../db.js';
import { getConfig } from '../settings.js';
import { placeLists } from './workOrders.js';

const ACTIVE = `('aberta','em_atendimento','pausada')`;

/**
 * "Status da fábrica": a read-only screen for a TV on the shop floor. Everything here is already visible to every
 * user (all orders and pendências), so any logged user may open it; maintainers and process technicians are kept
 * to their order module by the API allowlist.
 */
export async function statusBoardRoutes(app: FastifyInstance) {
  app.get('/api/tela', async (req) => {
    requireUser(req);
    const { timezone: zone } = await getConfig();
    const now = DateTime.now().setZone(zone);
    const dayStart = now.startOf('day').toJSDate();
    const dayEnd = now.endOf('day').toJSDate();

    const orders = await q<any>(
      `SELECT w.id, w.code, w.domain, w.status, w.priority, w.asset_ref, w.location_type, w.component, w.tool_code, w.kind, w.reason,
              w.machine_stopped, left(w.description, 160) AS description, w.opened_at, w.first_accepted_at,
              COALESCE((SELECT json_agg(u.name ORDER BY x.joined_at) FROM work_order_workers x JOIN users u ON u.id = x.user_id
                         WHERE x.work_order_id = w.id AND x.left_at IS NULL), '[]') AS workers,
              (SELECT p.reason FROM work_order_pauses p WHERE p.work_order_id = w.id AND p.ended_at IS NULL LIMIT 1) AS pause_reason,
              (SELECT p.started_at FROM work_order_pauses p WHERE p.work_order_id = w.id AND p.ended_at IS NULL LIMIT 1) AS paused_at
         FROM work_orders w WHERE w.status IN ${ACTIVE}
        ORDER BY w.machine_stopped DESC, CASE w.status WHEN 'aberta' THEN 0 WHEN 'pausada' THEN 1 ELSE 2 END, w.opened_at`);
    const queue = orders.map((o) => ({
      id: o.id, code: o.code, domain: o.domain, status: o.status, priority: o.priority, stopped: o.machine_stopped,
      place: placeLabel(o), assetRef: o.asset_ref, locationType: o.location_type, category: woCategory(o), description: o.description,
      openedAt: o.opened_at, acceptedAt: o.first_accepted_at, workers: o.workers as string[], pauseReason: o.pause_reason, pausedAt: o.paused_at,
    }));

    // every registered machine and assembly cell, with what is happening on it now
    const lists = await placeLists(['maquina', 'montagem']);
    const key = (t: string | null, code: string) => `${t ?? ''}|${code.trim().toUpperCase()}`;
    const byPlace = new Map<string, typeof queue>();
    for (const o of queue) {
      const k = key(o.locationType, o.assetRef);
      byPlace.set(k, [...(byPlace.get(k) ?? []), o]);
    }
    const places = (['maquina', 'montagem'] as WoLocation[]).flatMap((t) => lists[t].map((p) => {
      const on = byPlace.get(key(t, p.code)) ?? [];
      const stopped = on.filter((o) => o.stopped);
      return {
        type: t, code: p.code, description: p.description,
        state: stopped.length ? 'parada' : on.length ? 'atencao' : 'ok',
        since: (stopped[0] ?? on[0])?.openedAt ?? null,
        orders: on.map((o) => ({ code: o.code, domain: o.domain, status: o.status, stopped: o.stopped, workers: o.workers })),
      };
    }));

    const scheduled = await q<any>(
      `SELECT w.id, w.code, w.domain, w.asset_ref, w.location_type, w.component, w.tool_code, w.planned_start, w.planned_hours::float AS planned_hours, left(w.description, 120) AS description
         FROM work_orders w WHERE w.status = 'programada' AND w.planned_start BETWEEN $1 AND $2 ORDER BY w.planned_start`, [dayStart, dayEnd]);

    const [t] = await q<any>(
      `SELECT count(*) FILTER (WHERE opened_at >= $1 AND NOT imported)::int AS opened,
              count(*) FILTER (WHERE finished_at >= $1 AND status = 'finalizada')::int AS finished,
              count(*) FILTER (WHERE machine_stopped AND opened_at >= $1 AND NOT imported)::int AS stops,
              (avg(extract(epoch FROM first_accepted_at - opened_at)) FILTER (WHERE first_accepted_at >= $1 AND NOT scheduled AND NOT imported) / 60)::float AS accept_min,
              (sum(extract(epoch FROM LEAST(COALESCE(finished_at, now()), now()) - GREATEST(opened_at, $1)))
                 FILTER (WHERE machine_stopped AND status NOT IN ('cancelada','recusada','em_analise','programada') AND NOT imported
                           AND opened_at <= now() AND (finished_at IS NULL OR finished_at >= $1)) / 3600)::float AS downtime_h
         FROM work_orders`, [dayStart]);

    const open = `('${OPEN_STATUSES.join("','")}')`;
    const issueAreas = await q<any>(
      `SELECT a.name, a.color, count(*)::int AS open,
              count(*) FILTER (WHERE i.due_at < now())::int AS overdue,
              count(*) FILTER (WHERE i.is_safety_critical)::int AS safety
         FROM issues i JOIN areas a ON a.id = i.area_id WHERE i.status IN ${open}
        GROUP BY a.name, a.color ORDER BY overdue DESC, open DESC, a.name`);
    const sum = (k: string) => issueAreas.reduce((n, r) => n + r[k], 0);

    return {
      now: new Date().toISOString(),
      places,
      queue,
      scheduled: scheduled.map((s) => ({ id: s.id, code: s.code, domain: s.domain, place: placeLabel(s), plannedStart: s.planned_start, plannedHours: s.planned_hours, description: s.description })),
      today: {
        opened: t.opened, finished: t.finished, stops: t.stops,
        acceptMin: t.accept_min, downtimeH: t.downtime_h ?? 0,
        stoppedNow: places.filter((p) => p.state === 'parada').length,
        waiting: queue.filter((o) => o.status === 'aberta').length,
        working: queue.filter((o) => o.status === 'em_atendimento').length,
        paused: queue.filter((o) => o.status === 'pausada').length,
      },
      issues: { open: sum('open'), overdue: sum('overdue'), safety: sum('safety'), areas: issueAreas },
    };
  });
}
