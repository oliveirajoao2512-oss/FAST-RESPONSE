import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { areaId, Client, createUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let operador: Client, liderMan: Client, liderProc: Client, gestorProc: Client, tec: Client, tec2: Client, manutentor: Client;
let prod: number;
let tec2Id: string;

beforeAll(async () => {
  ctx = await setup();
  resetMaintenanceAreaCache();
  [operador, liderMan] = await Promise.all((['operador', 'liderMan'] as const).map((k) => ctx.c(k)));
  const users = await Promise.all([
    createUser('Lider Processos', 'lider', 'processos'),
    createUser('Gestor Processos', 'gestor', 'processos'),
    createUser('Ana Tecnica', 'tecnico_processo', null),
    createUser('Bruno Tecnico', 'tecnico_processo', null),
    createUser('Carlos Manutentor', 'manutentor', null),
  ]);
  tec2Id = users[3].id;
  [liderProc, gestorProc, tec, tec2, manutentor] = await Promise.all(users.map((u) => new Client(ctx.app).login(u.email)));
  prod = await areaId('producao');
});
afterAll(async () => {
  await ctx.app.close();
});

const open = (cl: Client, extra: Record<string, unknown> = {}) =>
  cl.post('/api/oa', { areaId: prod, assetRef: 'SOP-03', reason: 6, partNumber: 'PN-4471', machineStopped: true, description: 'Peso abaixo do especificado', ...extra });

describe('acesso do técnico de processo', () => {
  it('vê só as Ordens de Ajuste: o resto do sistema é recusado no servidor', async () => {
    expect((await tec.get('/api/oa')).status).toBe(200);
    expect((await tec.get('/api/notifications')).status).toBe(200);
    for (const url of ['/api/os', '/api/issues', '/api/dashboard', '/api/meta', '/api/admin/users']) {
      const r = await tec.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.erro).toMatch(/somente às Ordens de Ajuste/);
    }
  });

  it('o manutentor não entra nas Ordens de Ajuste', async () => {
    expect((await manutentor.get('/api/oa')).status).toBe(403);
  });
});

describe('fluxo da Ordem de Ajuste', () => {
  let id: string;

  it('qualquer pessoa abre; motivo da folha é obrigatório; máquina parada avisa os técnicos', async () => {
    expect((await open(operador, { reason: undefined })).status).toBe(400);
    expect((await open(operador, { reason: 99 })).status).toBe(400);
    // reason 21 asks for the material percentages
    expect((await open(operador, { reason: 21 })).status).toBe(400);
    const m = await open(operador, { reason: 21, virginPct: 70, regrindPct: 30, machineStopped: false });
    expect(m.status).toBe(201);
    expect(m.body.code).toMatch(/^OA-\d{4}-\d{5}$/);
    const r = await open(operador);
    expect(r.status).toBe(201);
    id = r.body.id;
    const n = (await tec.get('/api/notifications')).body;
    expect(n.some((x: any) => x.work_order_id === id && x.type === 'os_aberta' && x.work_order_domain === 'ajuste')).toBe(true);
    const d = (await operador.get(`/api/oa/${id}`)).body;
    expect(d).toMatchObject({ domain: 'ajuste', reason: 6, part_number: 'PN-4471', priority: 'critica', kind: null });
    const mm = (await operador.get(`/api/oa/${m.body.id}`)).body;
    expect(mm).toMatchObject({ virgin_pct: 70, regrind_pct: 30 });
  });

  it('não aparece na fila de manutenção, nem a OS na fila de ajuste', async () => {
    expect((await operador.get('/api/os')).body.some((o: any) => o.id === id)).toBe(false);
    expect((await operador.get(`/api/os/${id}`)).status).toBe(404);
    const os = await operador.post('/api/os', { areaId: prod, assetRef: 'INJ-01', kind: 'eletrica', machineStopped: false, description: 'x' });
    expect((await operador.get('/api/oa')).body.some((o: any) => o.id === os.body.id)).toBe(false);
  });

  it('só técnicos de processo e a liderança de Processos atuam', async () => {
    expect((await operador.post(`/api/oa/${id}/aceitar`)).status).toBe(403);
    expect((await liderMan.post(`/api/oa/${id}/aceitar`)).status).toBe(403);
    expect((await liderMan.post(`/api/oa/${id}/prioridade`, { priority: 'baixa' })).status).toBe(403);
    expect((await liderProc.post(`/api/oa/${id}/indicar`, { userId: tec2Id })).status).toBe(200);
    expect((await tec.post(`/api/oa/${id}/aceitar`)).status).toBe(200);
    expect((await tec.post(`/api/oa/${id}/passar`, { userId: tec2Id })).status).toBe(200);
    expect((await tec2.post(`/api/oa/${id}/aceitar`)).status).toBe(200);
    expect((await tec2.post(`/api/oa/${id}/finalizar`, { servico: 'Ajustado tempo de sopro', material: 'Conferido com a Qualidade' })).status).toBe(200);
    const d = (await operador.get(`/api/oa/${id}`)).body;
    expect(d.status).toBe('finalizada');
    expect(d.hoursByWorker.map((w: any) => w.name).sort()).toEqual(['Ana Tecnica', 'Bruno Tecnico']);
  });

  it('comprovante em PDF', async () => {
    const x = await ctx.app.inject({ method: 'GET', url: `/api/oa/${id}/comprovante.pdf`, headers: { cookie: operador.cookie } });
    expect(x.statusCode).toBe(200);
    expect(x.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('painel: somente gestor e líder de Processos (e administrador)', async () => {
    expect((await operador.get('/api/oa/report')).status).toBe(403);
    expect((await liderMan.get('/api/oa/report')).status).toBe(403);
    expect((await tec.get('/api/oa/report')).status).toBe(403);
    const r = await gestorProc.get('/api/oa/report');
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ opened: 2, finished: 1, stoppedOpened: 1 });
    expect(r.body.byCategory.map((c: any) => c.label)).toContain('6. Ajuste de peso');
    expect(r.body.workers.map((w: any) => w.name)).toContain('Bruno Tecnico');
    const only6 = await gestorProc.get('/api/oa/report?category=6');
    expect(only6.body.totals.opened).toBe(1);
    const x = await ctx.app.inject({ method: 'GET', url: '/api/oa/export.xlsx', headers: { cookie: liderProc.cookie } });
    expect(x.statusCode).toBe(200);
  });
});
