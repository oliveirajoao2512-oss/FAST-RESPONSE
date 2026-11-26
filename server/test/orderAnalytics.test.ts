import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { areaId, Client, createUser, setup } from './helpers.js';

/**
 * New analytical dashboards (OA and OS): every number is checked against orders with known times.
 * Times are São Paulo local (UTC-3): 08:00 local = 11:00Z.
 */
let ctx: Awaited<ReturnType<typeof setup>>;
let admin: Client, gestorProd: Client, gestorProc: Client, ana: Client, bruno: Client, mec: Client, operador: Client;
let anaId: string, brunoId: string;
let prod: number;
const RANGE = 'from=2026-11-01&to=2026-11-30';

async function order(cl: Client, url: string, payload: Record<string, unknown>, who: Client, at: string, acceptMin: number, workMin: number, finish = true) {
  const r = await cl.post(url, payload);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id;
  expect((await who.post(`${url}/${id}/aceitar`)).status).toBe(200);
  if (finish) expect((await who.post(`${url}/${id}/finalizar`, { servico: `Serviço da ${r.body.code}`, material: 'Trocado o retentor' })).status).toBe(200);
  const opened = new Date(at);
  const accepted = new Date(opened.getTime() + acceptMin * 60_000);
  const finished = new Date(accepted.getTime() + workMin * 60_000);
  await ctx.q(`UPDATE work_orders SET opened_at = $2, first_accepted_at = $3, finished_at = CASE WHEN status = 'finalizada' THEN $4::timestamptz END WHERE id = $1`, [id, opened, accepted, finished]);
  await ctx.q(`UPDATE work_order_workers SET joined_at = $2, left_at = CASE WHEN left_at IS NOT NULL THEN $3::timestamptz END WHERE work_order_id = $1`, [id, accepted, finished]);
  return { id, code: r.body.code as string };
}

beforeAll(async () => {
  ctx = await setup();
  resetMaintenanceAreaCache();
  [admin, operador] = await Promise.all((['admin', 'operador'] as const).map((k) => ctx.c(k)));
  const users = await Promise.all([
    createUser('Gestor Processos', 'gestor', 'processos'),
    createUser('Ana Tecnica', 'tecnico_processo', null),
    createUser('Bruno Tecnico', 'tecnico_processo', null),
    createUser('Carlos Manutentor', 'manutentor', null),
  ]);
  gestorProd = await new Client(ctx.app).login((await createUser('Gestor Producao', 'gestor', 'producao')).email);
  anaId = users[1].id;
  brunoId = users[2].id;
  [gestorProc, ana, bruno, mec] = await Promise.all(users.map((u) => new Client(ctx.app).login(u.email)));
  prod = await areaId('producao');
  const oa = (extra: Record<string, unknown>) => ({ areaId: prod, location: 'maquina', reason: 6, machineStopped: false, description: 'Peso abaixo', ...extra });
  // 1º turno, machine 5, PN, stopped: 5 min to accept, 30 min of work
  await order(operador, '/api/oa', oa({ assetRef: '5', partNumber: 'PN-1', machineStopped: true }), ana, '2026-11-10T11:00:00Z', 5, 30);
  // 2º turno, machine 5 again with the same reason two days later: a recurrence
  await order(operador, '/api/oa', oa({ assetRef: '5', partNumber: 'PN-1' }), bruno, '2026-11-12T18:00:00Z', 15, 10);
  // 3º turno, machine 17A, no PN, finished 30 s after accepting: kept out of the time averages
  await order(operador, '/api/oa', oa({ assetRef: '17A', reason: 3 }), ana, '2026-11-13T02:00:00Z', 1, 0.5);
  // a maintenance order in the same month must never appear in the adjustment dashboard
  await order(operador, '/api/os', { areaId: prod, location: 'maquina', assetRef: '5', component: 'maquina', kind: 'mecanica', machineStopped: true, description: 'Vazamento' }, mec, '2026-11-10T12:00:00Z', 2, 60);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('dashboards analíticos (administrador e gestor de Produção)', () => {
  it('só o administrador e o gestor de Produção acessam', async () => {
    expect((await gestorProd.get(`/api/oa/analytics?${RANGE}`)).status).toBe(200);
    expect((await gestorProd.get(`/api/os/analytics/records?${RANGE}`)).status).toBe(200);
    expect((await gestorProd.get(`/api/os/export.xlsx?${RANGE}`)).status).toBe(200);
    expect((await operador.get(`/api/os/analytics?${RANGE}`)).status).toBe(403);
    expect((await gestorProc.get(`/api/oa/analytics?${RANGE}`)).status).toBe(403);
    expect((await ana.get(`/api/oa/analytics?${RANGE}`)).status).toBe(403);
    expect((await admin.get(`/api/oa/analytics?${RANGE}`)).status).toBe(200);
  });

  it('cartões batem com os registros, e duração não confiável fica fora da média', async () => {
    const r = (await admin.get(`/api/oa/analytics?${RANGE}`)).body;
    expect(r.kpis.n).toBe(3);
    expect(r.kpis.finished).toBe(3);
    expect(r.kpis.timed).toBe(2);
    expect(r.kpis.avgMin).toBe(20); // (30 + 10) / 2
    expect(r.kpis.workH).toBeCloseTo(40 / 60, 2);
    expect(r.kpis.assets).toBe(2);
    expect(r.kpis.pns).toBe(1);
    expect(r.kpis.topAsset).toMatchObject({ label: 'Máquina 5', n: 2 });
    expect(r.kpis.topPn).toMatchObject({ key: 'PN-1', n: 2 });
    expect(r.quality).toMatchObject({ excluded: 1, instant: 1 });
    // stopped machine: opening → finish = 5 + 30 min
    expect(r.kpis.stops).toBe(1);
    expect(r.kpis.stoppedH).toBeCloseTo(35 / 60, 2);
  });

  it('separa o que acontece em cada turno', async () => {
    const r = (await admin.get(`/api/oa/analytics?${RANGE}`)).body;
    const s = Object.fromEntries(r.byShift.map((x: any) => [x.key, x]));
    expect(s['1º turno']).toMatchObject({ n: 1, avgMin: 30, avgWaitMin: 5 });
    expect(s['2º turno']).toMatchObject({ n: 1, avgMin: 10, avgWaitMin: 15 });
    expect(s['3º turno'].n).toBe(1);
    expect(s['1º turno'].topAssets[0]).toMatchObject({ label: 'Máquina 5', n: 1 });
    expect(s['2º turno'].techs).toEqual([{ id: brunoId, name: 'Bruno Tecnico', n: 1 }]);
  });

  it('técnicos, pareto e reincidência', async () => {
    const r = (await admin.get(`/api/oa/analytics?${RANGE}`)).body;
    const anaRow = r.byTech.find((t: any) => t.id === anaId);
    expect(anaRow).toMatchObject({ n: 2, lead: 2, helped: 0, avgMin: 30, timed: 1 });
    expect(r.pareto[0]).toMatchObject({ n: 2, cumPct: 66.7 });
    expect(r.pareto.at(-1).cumPct).toBe(100);
    expect(r.recurrence).toHaveLength(1);
    expect(r.recurrence[0]).toMatchObject({ assetLabel: 'Máquina 5', repeats: 1, n: 2 });
  });

  it('filtros combinados atualizam tudo, e sem resultado não quebra', async () => {
    const shift = (await admin.get(`/api/oa/analytics?${RANGE}&shift=${encodeURIComponent('2º turno')}`)).body;
    expect(shift.kpis.n).toBe(1);
    expect(shift.byTech.map((t: any) => t.id)).toEqual([brunoId]);
    const tech = (await admin.get(`/api/oa/analytics?${RANGE}&tech=${anaId}&pn=PN-1`)).body;
    expect(tech.kpis.n).toBe(1);
    const noPn = (await admin.get(`/api/oa/analytics?${RANGE}&pn=-`)).body;
    expect(noPn.kpis.n).toBe(1);
    const none = (await admin.get(`/api/oa/analytics?${RANGE}&tech=${brunoId}&shift=${encodeURIComponent('1º turno')}`)).body;
    expect(none.kpis).toMatchObject({ n: 0, avgMin: null, topAsset: null });
    // the filter lists come from the whole period, so choosing one does not hide the others
    expect(none.options.techs).toHaveLength(2);
  });

  it('OS e OA ficam separadas', async () => {
    const os = (await admin.get(`/api/os/analytics?${RANGE}`)).body;
    expect(os.kpis.n).toBe(1);
    expect(os.kpis.corrective).toBe(1);
    expect(os.byComponent[0]).toMatchObject({ key: 'maquina', n: 1 });
    expect((await admin.get(`/api/oa/analytics?${RANGE}`)).body.kpis.n).toBe(3);
  });

  it('tabela: o que o técnico fez, pesquisa, ordenação e páginas', async () => {
    const all = (await admin.get(`/api/oa/analytics/records?${RANGE}`)).body;
    expect(all.total).toBe(3);
    expect(all.rows[0].openedAt.startsWith('2026-11-12T23')).toBe(true); // most recent first (02:00Z on the 13th = 23:00 on the 12th)
    expect(all.rows[0]).toMatchObject({ notes: 'Trocado o retentor', review: 'Finalizada menos de 1 min depois do aceite', reliable: false });
    expect(all.rows[0].serviceDone).toMatch(/^Serviço da OA-/);
    const found = (await admin.get(`/api/oa/analytics/records?${RANGE}&q=bruno`)).body;
    expect(found.total).toBe(1);
    const byDur = (await admin.get(`/api/oa/analytics/records?${RANGE}&sort=duration&dir=desc`)).body;
    expect(byDur.rows.map((x: any) => x.durationMin)).toEqual([30, 10, 0.5]);
    const review = (await admin.get(`/api/oa/analytics/records?${RANGE}&review=1`)).body;
    expect(review.total).toBe(1);
  });

  it('nada é gravado: a consulta não altera as ordens', async () => {
    const before = await ctx.q('SELECT id, version, updated_at FROM work_orders ORDER BY id');
    await admin.get(`/api/oa/analytics?${RANGE}`);
    await admin.get(`/api/oa/analytics/records?${RANGE}`);
    expect(await ctx.q('SELECT id, version, updated_at FROM work_orders ORDER BY id')).toEqual(before);
  });
});
