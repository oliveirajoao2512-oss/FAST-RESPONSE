import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkProduction, clipStops, UNJUSTIFIED_MESSAGE } from '../../shared/production.js';
import { q } from '../src/db.js';
import { setCycleProducts } from '../src/routes/production.js';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { setSetupFetcher, toRow } from '../src/services/setups.js';
import { areaId, Client, createUser, setup } from './helpers.js';

const MIN = 60_000;
const H = 3_600_000;

describe('cálculo da conferência (exemplos do João)', () => {
  const hour = { start: 0, end: H, cycleSeconds: 60, cavities: 1 };
  const maint = (min: number, at = 0) => ({ source: 'manutencao' as const, ref: 'OS-1', label: 'OS-1', start: at, end: at + min * MIN });

  it('60 peças em 1 h com ciclo de 60 s: meta atingida', () => {
    const r = checkProduction({ ...hour, quantity: 60, stops: [] });
    expect(r).toMatchObject({ status: 'meta', expected: 60, ratePerHour: 60, lossPieces: 0, lossMin: 0, unjustifiedMin: 0 });
  });

  it('50 peças e 10 min de manutenção: a conta fecha', () => {
    const r = checkProduction({ ...hour, quantity: 50, stops: [maint(10)] });
    expect(r).toMatchObject({ status: 'justificada', lossPieces: 10, lossMin: 10, stopMin: 10, justifiedMin: 10, unjustifiedMin: 0 });
  });

  it('20 peças e 10 min de manutenção: 30 min sem justificativa', () => {
    const r = checkProduction({ ...hour, quantity: 20, stops: [maint(10)] });
    expect(r).toMatchObject({ status: 'divergencia', lossMin: 40, justifiedMin: 10, unjustifiedMin: 30, unjustifiedPieces: 30 });
  });

  it('a mesma perda em minutos vale peças diferentes conforme ciclo e cavidades', () => {
    const r = checkProduction({ start: 0, end: H, cycleSeconds: 30, cavities: 2, quantity: 200, stops: [] });
    expect(r).toMatchObject({ ratePerHour: 240, expected: 240, lossPieces: 40, lossMin: 10 });
  });

  it('paradas simultâneas contam uma vez só', () => {
    const stops = [maint(20, 0), { source: 'setup' as const, ref: 's', label: 'Setup', start: 10 * MIN, end: 30 * MIN }, maint(5, 50 * MIN)];
    const c = clipStops(stops, 0, H);
    expect(c.totalMin).toBe(35);
    expect(c.stops.map((s) => s.overlapMinutes)).toEqual([0, 10, 0]);
    const r = checkProduction({ ...hour, quantity: 25, stops });
    expect(r).toMatchObject({ stopMin: 35, lossMin: 35, unjustifiedMin: 0, status: 'justificada' });
  });

  it('parada fora do período não conta; a que atravessa conta só a parte de dentro', () => {
    const r = checkProduction({ ...hour, quantity: 50, stops: [maint(30, -40 * MIN), maint(10, 2 * H)] });
    expect(r.stopMin).toBe(0);
    expect(r.stops).toHaveLength(0);
    const r2 = checkProduction({ ...hour, quantity: 50, stops: [maint(15, -5 * MIN)] });
    expect(r2.stopMin).toBe(10);
  });

  it('sinaliza produção acima do padrão e paradas maiores que a perda', () => {
    expect(checkProduction({ ...hour, quantity: 80, stops: [] }).aboveStandard).toBe(true);
    const r = checkProduction({ ...hour, quantity: 60, stops: [maint(30)] });
    expect(r).toMatchObject({ status: 'meta', stopsExceedLoss: true });
  });

  it('sem ciclo padrão não inventa meta', () => {
    const r = checkProduction({ start: 0, end: H, cycleSeconds: null, cavities: null, quantity: 10, stops: [maint(10)] });
    expect(r).toMatchObject({ status: 'sem_padrao', expected: null, stopMin: 10 });
  });
});

describe('apontamento e conferência (API)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let lider: Client, admin: Client, operador: Client, liderMan: Client, gestorProd: Client, mec: Client;
  let prod: number;
  const base = Math.floor((Date.now() - 6 * H) / H) * H; // a whole hour, six hours ago

  beforeAll(async () => {
    ctx = await setup();
    resetMaintenanceAreaCache();
    lider = await ctx.c('liderProd');
    admin = await ctx.c('admin');
    operador = await ctx.c('operador');
    liderMan = await ctx.c('liderMan');
    gestorProd = await new Client(ctx.app).login((await createUser('Gestor Producao', 'gestor', 'producao')).email);
    mec = await new Client(ctx.app).login((await createUser('Mecanico Um', 'manutentor', null)).email);
    prod = await areaId('producao');
    setSetupFetcher(async () => []);
  });
  afterAll(async () => { setSetupFetcher(null); await ctx.app.close(); });

  const iso = (ms: number) => new Date(ms).toISOString();
  const report = (c: Client, machine: string, pn: string, from: number, to: number, quantity: number) =>
    c.post('/api/producao/apontamentos', { machine, pn, start: iso(from), end: iso(to), quantity });

  it('só liderança de Produção, plant manager e administrador', async () => {
    expect((await lider.get('/api/producao/opcoes')).status).toBe(200);
    expect((await admin.get('/api/producao/opcoes')).status).toBe(200);
    for (const c of [operador, liderMan, mec]) expect((await c.get('/api/producao/opcoes')).status).toBe(403);
  });

  it('ciclo padrão: gestor de Produção cadastra, líder não', async () => {
    expect((await lider.put('/api/producao/padroes', { machine: '12', pn: 'pn-a', cycleSeconds: 60, cavities: 1 })).status).toBe(403);
    expect((await gestorProd.put('/api/producao/padroes', { machine: '12', pn: 'pn-a', cycleSeconds: 60, cavities: 1 })).status).toBe(200);
    expect((await gestorProd.put('/api/producao/padroes', { machine: 'X99', pn: 'pn-a', cycleSeconds: 60 })).status).toBe(400);
    const o = (await lider.get('/api/producao/opcoes')).body;
    expect(o.standards).toMatchObject([{ machine: '12', pn: 'PN-A', cycleSeconds: 60, cavities: 1, source: 'manual' }]);
    expect(o.canEditStandards).toBe(false);
  });

  it('confronta com a OS de máquina parada e aponta o tempo sem justificativa', async () => {
    // OS with the machine stopped for 10 minutes inside the hour
    const os = await operador.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '12', component: 'maquina', kind: 'mecanica', machineStopped: true, description: 'Vazamento' });
    expect(os.status).toBe(201);
    await q(`UPDATE work_orders SET opened_at = $2, finished_at = $3, status = 'finalizada' WHERE id = $1`, [os.body.id, new Date(base + 20 * MIN), new Date(base + 30 * MIN)]);

    expect((await report(lider, '12', 'PN-A', base, base + H, 20)).status).toBe(201);
    const r = (await lider.get(`/api/producao/conferencia?from=${new Date(base).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).body;
    const e = r.entries.find((x: any) => x.machine === '12');
    expect(e).toMatchObject({
      pn: 'PN-A', leader: 'Lider Producao', expected: 60, quantity: 20, lossMin: 40, stopMin: 10, justifiedMin: 10, unjustifiedMin: 30,
      unjustifiedPieces: 30, status: 'divergencia', message: UNJUSTIFIED_MESSAGE, standardFrom: 'maquina',
    });
    expect(e.stops).toMatchObject([{ source: 'manutencao', ref: os.body.code, minutes: 10 }]);
    expect(r.totals).toMatchObject({ entries: 1, pendingReason: 1 });

    // the leader explains it; the alert stays in the numbers but no longer asks for a reason
    expect((await lider.post(`/api/producao/apontamentos/${e.id}/motivo`, { reason: 'Falta de operador no começo do turno' })).status).toBe(200);
    const r2 = (await lider.get(`/api/producao/conferencia?from=${new Date(base).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).body;
    expect(r2.entries[0]).toMatchObject({ status: 'divergencia', reason: 'Falta de operador no começo do turno', reasonBy: 'Lider Producao', message: null });
    expect(r2.totals.pendingReason).toBe(0);
  });

  it('não aceita dois apontamentos da mesma máquina no mesmo período', async () => {
    const r = await report(lider, '12', 'PN-A', base + 30 * MIN, base + 90 * MIN, 10);
    expect(r.status).toBe(409);
    expect(r.body.erro).toMatch(/já tem apontamento/);
    expect((await report(lider, '12', 'PN-A', base + H, base + 2 * H, 60)).status).toBe(201);
  });

  it('valida período e máquina', async () => {
    expect((await report(lider, '12', 'PN-A', base + 3 * H, base + 2 * H, 10)).status).toBe(400);
    expect((await report(lider, '12', 'PN-A', base - 20 * H, base - 3 * H, 10)).status).toBe(400);
    expect((await report(lider, '12', 'PN-A', Date.now() + H, Date.now() + 2 * H, 10)).status).toBe(400);
    expect((await report(lider, 'X99', 'PN-A', base - 2 * H, base - H, 10)).status).toBe(400);
  });

  it('setup do Controle de Setup justifica; sobreposição com OS conta uma vez', async () => {
    await gestorProd.put('/api/producao/padroes', { machine: '20', pn: 'PN-B', cycleSeconds: 30, cavities: 2 });
    setSetupFetcher(async () => [toRow({ id: 'st1', maquina: '20', pn: 'PN-B', status: 'Finalizado', inicio_timestamp: base + 2 * H, fim_timestamp: base + 2 * H + 20 * MIN, inicio_producao_timestamp: base + 2 * H + 30 * MIN })!]);
    const os = await operador.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '20', component: 'maquina', kind: 'eletrica', machineStopped: true, description: 'Sensor' });
    await q(`UPDATE work_orders SET opened_at = $2, finished_at = $3, status = 'finalizada' WHERE id = $1`, [os.body.id, new Date(base + 2 * H + 20 * MIN), new Date(base + 2 * H + 40 * MIN)]);
    // 1 h at 240 pc/h (4 per minute): 80 pieces = 160 short = 40 min lost; setup 30 min + OS 20 min overlapping 10 = 40 min
    expect((await report(lider, '20', 'PN-B', base + 2 * H, base + 3 * H, 80)).status).toBe(201);
    const r = (await admin.get(`/api/producao/conferencia?machine=20&from=${new Date(base).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).body;
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ expected: 240, lossMin: 40, stopMin: 40, unjustifiedMin: 0, status: 'justificada' });
    expect(r.entries[0].stops.map((s: any) => [s.source, s.minutes, s.overlapMinutes])).toEqual([['setup', 30, 0], ['manutencao', 20, 10]]);
    expect(r.setup).toEqual({ ok: true, error: null });
  });

  it('PN sem ciclo na máquina usa o de outra máquina e avisa; sem ciclo nenhum, não calcula meta', async () => {
    expect((await report(lider, '22', 'PN-B', base + 3 * H, base + 4 * H, 200)).status).toBe(201);
    expect((await report(lider, '23', 'PN-Z', base + 3 * H, base + 4 * H, 50)).status).toBe(201);
    const r = (await lider.get(`/api/producao/conferencia?from=${new Date(base).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).body;
    expect(r.entries.find((e: any) => e.machine === '22')).toMatchObject({ standardFrom: 'outra_maquina', standardMachine: '20', expected: 240 });
    expect(r.entries.find((e: any) => e.machine === '23')).toMatchObject({ status: 'sem_padrao', expected: null });
    // once the standard exists the old report uses it, and says so
    await gestorProd.put('/api/producao/padroes', { machine: '23', pn: 'PN-Z', cycleSeconds: 60 });
    const r2 = (await lider.get(`/api/producao/conferencia?machine=23&from=${new Date(base).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).body;
    expect(r2.entries[0]).toMatchObject({ standardFrom: 'atual', expected: 60, status: 'divergencia' });
  });

  it('mudar o ciclo depois não reescreve o histórico', async () => {
    await gestorProd.put('/api/producao/padroes', { machine: '12', pn: 'PN-A', cycleSeconds: 30, cavities: 1 });
    const r = (await lider.get(`/api/producao/conferencia?machine=12&from=${new Date(base).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).body;
    expect(r.entries.every((e: any) => e.cycleSeconds === 60)).toBe(true);
  });

  it('correção: quem apontou corrige, outro líder não; o valor anterior fica na auditoria', async () => {
    const [e] = await q<{ id: string }>(`SELECT id FROM production_entries WHERE machine = '22'`);
    const body = { machine: '22', pn: 'PN-B', start: iso(base + 3 * H), end: iso(base + 4 * H), quantity: 230 };
    const outro = await new Client(ctx.app).login((await createUser('Lider Prod Dois', 'lider', 'producao')).email);
    expect((await outro.patch(`/api/producao/apontamentos/${e.id}`, body)).status).toBe(403);
    expect((await lider.patch(`/api/producao/apontamentos/${e.id}`, body)).status).toBe(200);
    const [a] = await q<any>(`SELECT data FROM audit_events WHERE action = 'producao.corrigir' AND entity_id = $1`, [e.id]);
    expect(a.data.antes.quantity).toBe(200);
  });

  it('Controle de Setup fora do ar: a conferência sai sem os setups e avisa', async () => {
    setSetupFetcher(async () => { throw new Error('Controle de Setup respondeu 503'); });
    const r = await lider.get(`/api/producao/conferencia?machine=20&from=${new Date(base).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`);
    expect(r.status).toBe(200);
    expect(r.body.setup).toMatchObject({ ok: false });
    setSetupFetcher(async () => []);
  });

  it('importa os ciclos do Controle de Ciclo sem sobrescrever os digitados', async () => {
    setCycleProducts(async () => [
      { pn: 'PN-A', machine: '12', cycle: 45 }, // typed by hand above: kept
      { pn: 'PN-C', machine: '8', cycle: 50 },
      { pn: 'PN-D', machine: 'INJ', cycle: 20 }, // machine not registered
      { pn: 'PN-E', machine: '8', cycle: 0 },
      { pn: 'PN-F', machine: 'INJEÇÃO 120T', cycle: 40 },
    ]);
    const r = await gestorProd.post('/api/producao/padroes/importar-ciclo');
    expect(r.body).toMatchObject({ total: 5, added: 2, kept: 1, skipped: ['PN-D (máq. INJ)', 'PN-E (máq. 8)'] });
    const [a] = await q<any>(`SELECT cycle_seconds::float AS c, source FROM production_standards WHERE pn = 'PN-A' AND machine = '12'`);
    expect(a).toEqual({ c: 30, source: 'manual' });
    expect((await q<any>(`SELECT machine FROM production_standards WHERE pn = 'PN-F'`))[0].machine).toBe('INJETORA 120 T');
    expect((await lider.post('/api/producao/padroes/importar-ciclo')).status).toBe(403);
  });
});
