import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productionAccess } from '../../shared/production.js';
import { q } from '../src/db.js';
import { runProductionRoundNotice, shiftOfHour } from '../src/routes/productionRound.js';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { setSetupFetcher, toRow } from '../src/services/setups.js';
import { writeXlsx } from '../src/services/xlsx.js';
import { areaId, Client, createUser, setup } from './helpers.js';

const ZONE = 'America/Sao_Paulo';
const SHIFTS = [
  { name: '1º turno', start: '06:00', days: [1, 2, 3, 4, 5], saturday: { start: '06:00', end: '11:00' } },
  { name: '2º turno', start: '14:00', days: [1, 2, 3, 4, 5], saturday: { start: '11:00', end: '16:00' } },
  { name: '3º turno', start: '22:00', days: [1, 2, 3, 4, 5] },
];

/** the last Wednesday 10:00 before now (1º turno) */
const wed = (() => {
  let d = DateTime.now().setZone(ZONE).startOf('day').set({ hour: 10 });
  while (d.weekday !== 3 || d > DateTime.now()) d = d.minus({ days: 1 });
  return d;
})();

const c = (v: string | number | null) => ({ v });
const planXlsx = () => writeXlsx([{
  name: 'PLANEJAMENTO', rows: [
    [c('Planejamento Diário')],
    ['Máquinas', 'T1', 'T2', 'T3', 'PART NUMBER', 'Tempo \nCiclo', 'CAV', 'PEÇAS\nPOR HORA', 'MOD\nT1', 'MOD\nT2', 'MOD\nT3', 'HRS\nT1', 'HRS\nT2', 'HRS\nT3', 'Numero\nda OP'].map(c),
    ['MC-12', 2, 2, 2, 10007770001, 60, 1, 60, 1, 1, 1, 7, 7, 7, 79001].map(c),
    ['MC-04', 4, 'X', 'X', 10007770002, 60, 1, 60, 1, 1, 1, 7, 0, 0, 79002].map(c),
    ['MC-04', 4, 'X', 'X', 10007770003, 30, 2, 240, 1, 1, 1, 7, 0, 0, 79003].map(c),
    ['MC-03', 'X', 'X', 'X', 10007770004, 60, 1, 60, 0, 0, 0, 0, 0, 0, 79004].map(c),
    ['MC-20', 3, 3, 3, 10007770005, 60, 1, 60, 1, 1, 1, 7, 7, 7, 79005].map(c),
    ['MONT', 5, 5, 5, 10007770006, 60, 1, 60, 1, 1, 1, 7, 7, 7, null].map(c),
    ['ZONA 01 (GRUPO 1)', null, null].map(c),
  ],
}]);

describe('rodada da hora', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let admin: Client, lider: Client, operador: Client;

  const upload = async (cl: Client, commit: 0 | 1, date: string) => {
    const boundary = '----frtest' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="PLANEJAMENTO APONTAMENTO 01012026 QUA.xlsm"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      planXlsx(), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await ctx.app.inject({ method: 'POST', url: `/api/producao/planejamento?commit=${commit}&date=${date}`, payload: body,
      headers: { cookie: cl.cookie, 'x-requested-with': 'fast-response', 'content-type': `multipart/form-data; boundary=${boundary}` } });
    return { status: r.statusCode, body: r.json() };
  };

  beforeAll(async () => {
    ctx = await setup();
    resetMaintenanceAreaCache();
    admin = await ctx.c('admin');
    lider = await ctx.c('liderProd');
    operador = await ctx.c('operador');
    await createUser('Gestor Producao R', 'gestor', 'producao');
    productionAccess.adminOnly = false;
    setSetupFetcher(async () => []);
  });
  afterAll(async () => { productionAccess.adminOnly = true; setSetupFetcher(null); await ctx.app.close(); });

  it('turno e data do turno de cada hora (o 3º turno é do dia em que começou)', () => {
    const mon = DateTime.fromISO('2026-11-23T02:00', { zone: ZONE }); // segunda 02:00 = nada (domingo à noite não tem turno)
    expect(shiftOfHour(mon, SHIFTS as any, ZONE)).toBeNull();
    const tue2 = DateTime.fromISO('2026-11-24T02:00', { zone: ZONE });
    expect(shiftOfHour(tue2, SHIFTS as any, ZONE)).toMatchObject({ index: 3, date: '2026-11-23' });
    const sat = DateTime.fromISO('2026-11-28T12:00', { zone: ZONE });
    expect(shiftOfHour(sat, SHIFTS as any, ZONE)).toMatchObject({ index: 2, date: '2026-11-28' });
  });

  it('o PCP sobe o planejamento: confere e depois grava (ciclos e cavidades junto)', async () => {
    expect((await upload(operador, 0, wed.toISODate()!)).status).toBe(403);
    const pre = await upload(lider, 0, wed.toISODate()!);
    expect(pre.status).toBe(200);
    expect(pre.body).toMatchObject({ date: wed.toISODate(), machinesPerShift: [3, 2, 2], stopped: ['3'], outside: ['MONT'] });
    expect((await q('SELECT 1 FROM production_plans'))).toHaveLength(0);
    expect((await upload(lider, 1, wed.toISODate()!)).status).toBe(200);
    const [std] = await q<any>(`SELECT cycle_seconds::float AS c, cavities FROM production_standards WHERE machine = '4' AND pn = '10007770003'`);
    expect(std).toEqual({ c: 30, cavities: 2 });
    const p = (await lider.get(`/api/producao/planejamento?date=${wed.toISODate()}`)).body;
    expect(p.plan).toMatchObject({ date: wed.toISODate(), sameDay: true, by: 'Lider Producao' });
  });

  it('a hora já vem com máquina, PN e meta; duas peças na mesma máquina viram duas linhas', async () => {
    const r = (await lider.get(`/api/producao/rodada?end=${encodeURIComponent(wed.plus({ hours: 1 }).toISO()!)}`)).body;
    expect(r.shift).toMatchObject({ index: 1, name: '1º turno' });
    expect(r.rows.map((x: any) => [x.machine, x.pn, x.source, x.perHour])).toEqual([
      ['4', '10007770002', 'plano', 60], ['4', '10007770003', 'plano', 240], ['12', '10007770001', 'plano', 60], ['20', '10007770005', 'plano', 60],
    ]);
    expect(r.pending).toBe(4);
  });

  it('o setup do Controle de Setup troca o PN da máquina', async () => {
    setSetupFetcher(async () => [
      toRow({ id: 'x1', maquina: '20', pn: '10007779999', usuario: 'Setupista', status: 'Finalizado', inicio_timestamp: wed.minus({ hours: 3 }).toMillis(), fim_timestamp: wed.minus({ hours: 2 }).toMillis() })!,
      toRow({ id: 'x2', maquina: '12', pn: '10007770001', status: 'Em andamento', inicio_timestamp: wed.plus({ minutes: 30 }).toMillis() })!,
    ]);
    const r = (await lider.get(`/api/producao/rodada?end=${encodeURIComponent(wed.plus({ hours: 1 }).toISO()!)}`)).body;
    expect(r.rows.find((x: any) => x.machine === '20')).toMatchObject({ pn: '10007779999', source: 'setup' });
    expect(r.rows.find((x: any) => x.machine === '12')).toMatchObject({ pn: '10007770001', source: 'plano', setup: { status: 'Em andamento' } });
    setSetupFetcher(async () => []);
  });

  it('salvar a hora devolve meta × real e as paradas de cada máquina', async () => {
    const prod = await areaId('producao');
    const os = await operador.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '12', component: 'maquina', kind: 'mecanica', machineStopped: true, description: 'Travou' });
    await q(`UPDATE work_orders SET opened_at = $2, finished_at = $3, status = 'finalizada' WHERE id = $1`, [os.body.id, wed.plus({ minutes: 10 }).toJSDate(), wed.plus({ minutes: 25 }).toJSDate()]);
    const start = wed.toISO(), end = wed.plus({ hours: 1 }).toISO();
    const r = await lider.post('/api/producao/rodada', { start, end, items: [
      { machine: '12', pn: '10007770001', quantity: 45 }, // 15 min stopped: justified
      { machine: '4', pn: '10007770002', quantity: 30, breakMinutes: 30 }, // half an hour of lunch: on target
      { machine: '4', pn: '10007770003', quantity: 120 }, // 30 min lost, no stop
      { machine: 'X99', pn: '1', quantity: 1 },
    ] });
    expect(r.status).toBe(201);
    expect(r.body.saved).toBe(3);
    expect(r.body.errors).toMatchObject([{ machine: 'X99' }]);
    const by = (m: string, pn: string) => r.body.entries.find((e: any) => e.machine === m && e.pn === pn);
    expect(by('12', '10007770001')).toMatchObject({ expected: 60, quantity: 45, lossMin: 15, stopMin: 15, unjustifiedMin: 0, status: 'justificada' });
    expect(by('4', '10007770002')).toMatchObject({ expected: 30, status: 'meta', breakMin: 30 });
    expect(by('4', '10007770003')).toMatchObject({ expected: 240, lossMin: 30, unjustifiedMin: 30, unjustifiedPieces: 120, status: 'divergencia' });

    const again = (await lider.get(`/api/producao/rodada?end=${encodeURIComponent(end!)}`)).body;
    expect(again.pending).toBe(1);
    // the stops of the hour come with the row, so the tablet compares while the leader types
    expect(again.rows.find((x: any) => x.machine === '12').stops).toMatchObject([{ source: 'manutencao' }]);
    expect(again.rows.find((x: any) => x.machine === '20').stops).toEqual([]);
    expect(again.rows.find((x: any) => x.machine === '12').entry).toMatchObject({ quantity: 45, status: 'justificada' });
    // the same machine + PN cannot be reported twice for the hour
    const dup = await lider.post('/api/producao/rodada', { start, end, items: [{ machine: '12', pn: '10007770001', quantity: 1 }] });
    expect(dup.status).toBe(200);
    expect(dup.body.saved).toBe(0);
    expect(dup.body.errors[0].erro).toMatch(/já tem apontamento/);
  });

  it('aviso de hora fechada vai para quem aponta, uma vez por hora', async () => {
    // a plan for today makes the hour that just closed have machines, if it is a working hour
    const now = DateTime.now().setZone(ZONE);
    const end = now.startOf('hour');
    const sh = shiftOfHour(end.minus({ hours: 1 }), SHIFTS as any, ZONE);
    if (!sh) return; // outside the shifts right now: nothing to notify
    await upload(lider, 1, sh.date);
    const at = end.plus({ minutes: 3 }).toJSDate();
    expect(await runProductionRoundNotice(at)).toMatchObject({ sent: true });
    await runProductionRoundNotice(at);
    const n = await q<any>(`SELECT u.name FROM notifications x JOIN users u ON u.id = x.user_id WHERE x.type = 'producao_hora' ORDER BY u.name`);
    expect(n.map((x) => x.name)).toEqual(['Admin Teste', 'Gestor Producao R', 'Lider Producao']);
    expect(await runProductionRoundNotice(end.plus({ minutes: 30 }).toJSDate())).toMatchObject({ sent: false });
  });
});
