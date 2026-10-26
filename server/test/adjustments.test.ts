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
  cl.post('/api/oa', { areaId: prod, location: 'maquina', assetRef: '5', reason: 6, partNumber: 'PN-4471', machineStopped: true, description: 'Peso abaixo do especificado', ...extra });

describe('acesso do processista', () => {
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
    const os = await operador.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '3', kind: 'eletrica', machineStopped: false, description: 'x' });
    expect((await operador.get('/api/oa')).body.some((o: any) => o.id === os.body.id)).toBe(false);
  });

  it('só processistas e a liderança de Processos atuam', async () => {
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

describe('local da ordem: máquina ou montagem, da lista cadastrada', () => {
  it('aceita só itens da lista e ajuste só em máquina', async () => {
    expect((await open(operador, { assetRef: 'MAQ-INEXISTENTE' })).status).toBe(400);
    expect((await open(operador, { location: 'montagem', assetRef: '0013.01' })).status).toBe(400);
    const os = await operador.post('/api/os', { areaId: prod, location: 'montagem', assetRef: '492 / 493.01', kind: 'mecanica', machineStopped: true, description: 'Dispositivo travando' });
    expect(os.status).toBe(201);
    expect((await operador.get(`/api/os/${os.body.id}`)).body).toMatchObject({ location_type: 'montagem', asset_ref: '492 / 493.01' });
    // case-insensitive, stored as registered
    const r = await open(operador, { assetRef: 'injetora 120 t', machineStopped: false });
    expect((await operador.get(`/api/oa/${r.body.id}`)).body.asset_ref).toBe('INJETORA 120 T');
    const opts = (await operador.get('/api/os/options')).body;
    expect(opts.places.maquina[0].code).toBe('1A');
    expect(opts.places.montagem).toHaveLength(9);
    expect((await operador.get('/api/oa/options')).body.places.montagem).toBeUndefined();
  });
});

describe('painel da planta (estilo Power BI) e plant manager', () => {
  let pm: Client;
  beforeAll(async () => {
    pm = await new Client(ctx.app).login((await createUser('Paula Plant', 'plant_manager', null)).email);
  });

  it('somente administrador e plant manager', async () => {
    expect((await gestorProc.get('/api/painel')).status).toBe(403);
    expect((await liderMan.get('/api/painel')).status).toBe(403);
    const r = await pm.get('/api/painel?domain=ajuste');
    expect(r.status).toBe(200);
    expect(r.body.months).toHaveLength(12);
    expect(r.body.period.opened).toBeGreaterThanOrEqual(3);
    expect(r.body.byCategory.length).toBeGreaterThan(0);
    const m = await pm.get('/api/painel?domain=manutencao&location=montagem');
    expect(m.body.byAsset.map((a: any) => a.label)).toEqual(['492 / 493.01']);
    expect(m.body.now.stopped).toBe(1);
    expect(m.body.units).toBe(9);
    const one = await pm.get(`/api/painel?domain=ajuste&asset=5&month=${new Date().getMonth() + 1}`);
    expect(one.body.units).toBe(1);
  });

  it('plant manager vê os dashboards dos dois módulos e tem permissões de gestor', async () => {
    expect((await pm.get('/api/os/report')).status).toBe(200);
    expect((await pm.get('/api/oa/report')).status).toBe(200);
    expect((await pm.get('/api/os/options')).body).toMatchObject({ canLead: false, canSeeDashboard: true });
    expect((await pm.get('/api/admin/audit')).status).toBe(200);
  });
});

describe('part number nas duas ordens e histórico por PN', () => {
  it('OS também guarda o PN, padronizado; dashboard, histórico e painel filtram por PN', async () => {
    const os = await operador.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '10', kind: 'hidraulica', partNumber: '  pn  7788 ', machineStopped: true, description: 'Vazamento' });
    expect(os.status).toBe(201);
    expect((await operador.get(`/api/os/${os.body.id}`)).body.part_number).toBe('PN 7788');
    const other = await operador.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '10', kind: 'eletrica', machineStopped: false, description: 'Sem PN' });
    expect((await operador.get(`/api/os/${other.body.id}`)).body.part_number).toBeNull();
    expect((await operador.get('/api/os/options')).body.partNumbers).toContain('PN 7788');
    expect((await manutentor.post(`/api/os/${os.body.id}/aceitar`)).status).toBe(200);
    expect((await manutentor.post(`/api/os/${os.body.id}/finalizar`, { servico: 'Trocada mangueira' })).status).toBe(200);

    const r = (await liderMan.get('/api/os/report')).body;
    expect(r.byPn.map((p: any) => p.label)).toContain('PN 7788');
    expect(r.filters.partNumbers).toContain('PN 7788');
    expect(r.pnCoverage).toBeLessThan(1);
    const only = (await liderMan.get('/api/os/report?pn=pn%207788')).body;
    expect(only.totals.opened).toBe(1);
    const hist = (await liderMan.get('/api/os?view=finalizadas&pn=PN%207788')).body;
    expect(hist.map((o: any) => o.id)).toEqual([os.body.id]);
    const x = await ctx.app.inject({ method: 'GET', url: `/api/os/${os.body.id}/comprovante.pdf`, headers: { cookie: operador.cookie } });
    expect(x.statusCode).toBe(200);

    const pm = await new Client(ctx.app).login((await createUser('Pedro Plant', 'plant_manager', null)).email);
    const p = (await pm.get('/api/painel?domain=manutencao&pn=PN%207788')).body;
    expect(p.period.opened).toBe(1);
    expect(p.byPn.map((b: any) => b.label)).toEqual(['PN 7788']);
    expect(p.partNumbers).toContain('PN 7788');
  });
});
