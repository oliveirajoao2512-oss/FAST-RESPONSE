import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { woTimes, workedMs } from '../../shared/maintenance.js';
import { one, q } from '../src/db.js';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { areaId, Client, createUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: Client, gestor: Client, liderMan: Client, operador: Client, gerenteMan: Client, joao: Client, pedro: Client;
let prod: number;
let joaoId: string, pedroId: string;

beforeAll(async () => {
  ctx = await setup();
  resetMaintenanceAreaCache();
  [admin, gestor, liderMan, operador] = await Promise.all((['admin', 'gestor', 'liderMan', 'operador'] as const).map((k) => ctx.c(k)));
  const gm = await createUser('Gerente Manutencao', 'gestor', 'manutencao');
  const j = await createUser('Joao Manutentor', 'manutentor', null);
  const p = await createUser('Pedro Manutentor', 'manutentor', null);
  joaoId = j.id;
  pedroId = p.id;
  [gerenteMan, joao, pedro] = await Promise.all([gm, j, p].map((u) => new Client(ctx.app).login(u.email)));
  prod = await areaId('producao');
});
afterAll(async () => {
  await ctx.app.close();
});

const open = (cl: Client, extra: Record<string, unknown> = {}) =>
  cl.post('/api/os', { areaId: prod, assetRef: 'INJ-07', kind: 'mecanica', machineStopped: false, description: 'Vazamento de óleo no cilindro', ...extra });
const detail = async (id: string) => (await operador.get(`/api/os/${id}`)).body;

describe('tempos', () => {
  it('desconta pausas do tempo trabalhado', () => {
    const h = (n: number) => new Date(Date.UTC(2026, 9, 22, n));
    expect(workedMs({ from: h(8), to: h(12) }, [{ from: h(9), to: h(10) }])).toBe(3 * 3600_000);
    const t = woTimes({ opened_at: h(7), first_accepted_at: h(8), finished_at: h(12) }, [{ from: h(9), to: h(10) }]);
    expect(t).toEqual({ waitMs: 3600_000, workMs: 3 * 3600_000, pausedMs: 3600_000, totalMs: 5 * 3600_000 });
  });
});

describe('acesso do manutentor', () => {
  it('vê só as OS: o resto do sistema é recusado no servidor', async () => {
    expect((await joao.get('/api/auth/me')).status).toBe(200);
    expect((await joao.get('/api/os')).status).toBe(200);
    expect((await joao.get('/api/notifications')).status).toBe(200);
    for (const url of ['/api/issues', '/api/dashboard', '/api/meta', '/api/ranking', '/api/quality/ncs', '/api/assets', '/api/admin/users']) {
      const r = await joao.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.erro).toMatch(/somente às Ordens de Manutenção/);
    }
    expect((await joao.post('/api/issues', { title: 'x', areaId: prod, priority: 'media' })).status).toBe(403);
  });

  it('não pode ser responsável por pendência', async () => {
    const r = await gestor.post('/api/issues', { title: 'Teste', areaId: prod, priority: 'media', assigneeId: joaoId });
    expect(r.status).toBe(400);
  });
});

describe('fluxo da OS', () => {
  let id: string;

  it('qualquer usuário abre; número e horário são automáticos', async () => {
    const r = await open(operador);
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^OS-\d{4}-00001$/);
    id = r.body.id;
    const d = await detail(id);
    expect(d).toMatchObject({ status: 'aberta', priority: 'normal', opened_by_name: 'Operador Producao', area_name: 'Produção', workers: [] });
    expect(d.events.map((e: any) => e.action)).toEqual(['abriu']);
  });

  it('todos veem todas as OS', async () => {
    for (const cl of [operador, joao, liderMan, gestor]) expect((await cl.get('/api/os')).body.map((o: any) => o.id)).toContain(id);
  });

  it('máquina parada vira crítica e avisa a manutenção', async () => {
    const r = await open(operador, { assetRef: 'INJ-02', machineStopped: true });
    const d = await detail(r.body.id);
    expect(d.priority).toBe('critica');
    const notes = (await pedro.get('/api/notifications')).body;
    expect(notes[0]).toMatchObject({ type: 'os_aberta', work_order_id: r.body.id, code: d.code });
    // the queue puts it first
    expect((await joao.get('/api/os')).body[0].id).toBe(r.body.id);
  });

  it('quem não é da manutenção não aceita nem prioriza', async () => {
    expect((await operador.post(`/api/os/${id}/aceitar`)).status).toBe(403);
    expect((await joao.post(`/api/os/${id}/prioridade`, { priority: 'alta' })).status).toBe(403);
    expect((await gestor.post(`/api/os/${id}/prioridade`, { priority: 'alta' })).status).toBe(403); // gestor de outra área
  });

  it('gerente e líder de manutenção priorizam, fixam no topo e indicam', async () => {
    expect((await gerenteMan.post(`/api/os/${id}/prioridade`, { priority: 'alta', pinned: true })).status).toBe(200);
    expect((await joao.get('/api/os')).body[0].id).toBe(id);
    expect((await liderMan.post(`/api/os/${id}/indicar`, { userId: joaoId })).status).toBe(200);
    const d = await detail(id);
    expect(d).toMatchObject({ priority: 'alta', pinned: true, suggested_name: 'Joao Manutentor' });
    expect((await joao.get('/api/notifications')).body[0].type).toBe('os_indicada');
  });

  it('aceitar mostra quem está atuando e avisa quem abriu', async () => {
    expect((await joao.post(`/api/os/${id}/aceitar`)).status).toBe(200);
    const d = await detail(id);
    expect(d.status).toBe('em_atendimento');
    expect(d.workers.map((w: any) => w.name)).toEqual(['Joao Manutentor']);
    expect(d.first_accepted_at).toBeTruthy();
    expect(d.suggested_to).toBeNull();
    const n = (await operador.get('/api/notifications')).body[0];
    expect(n).toMatchObject({ type: 'os_aceita', title: expect.stringContaining('Joao Manutentor está atuando') });
    expect((await joao.post(`/api/os/${id}/aceitar`)).status).toBe(422);
  });

  it('mais de um manutentor atua; passar só vale quando o outro aceita', async () => {
    expect((await pedro.post(`/api/os/${id}/aceitar`)).status).toBe(200);
    expect((await detail(id)).workers).toHaveLength(2);
    expect((await pedro.post(`/api/os/${id}/devolver`, { motivo: 'Chamado em outra máquina' })).status).toBe(200);
    let d = await detail(id);
    expect(d.status).toBe('em_atendimento');
    expect(d.workers.map((w: any) => w.name)).toEqual(['Joao Manutentor']);

    expect((await joao.post(`/api/os/${id}/passar`, { userId: pedroId })).status).toBe(200);
    d = await detail(id);
    expect(d).toMatchObject({ transfer_to_name: 'Pedro Manutentor', transfer_from_name: 'Joao Manutentor' });
    expect(d.workers.map((w: any) => w.name)).toEqual(['Joao Manutentor']);
    expect((await pedro.post(`/api/os/${id}/recusar`)).status).toBe(200);
    expect((await detail(id)).transfer_to).toBeNull();

    await joao.post(`/api/os/${id}/passar`, { userId: pedroId });
    expect((await pedro.post(`/api/os/${id}/aceitar`)).status).toBe(200);
    d = await detail(id);
    expect(d.workers.map((w: any) => w.name)).toEqual(['Pedro Manutentor']);
    expect(d.transfer_to).toBeNull();
  });

  it('pausa com motivo e retoma; o tempo pausado fica à parte', async () => {
    expect((await pedro.post(`/api/os/${id}/pausar`, {})).status).toBe(400);
    expect((await pedro.post(`/api/os/${id}/pausar`, { motivo: 'Aguardando peça' })).status).toBe(200);
    let d = await detail(id);
    expect(d.status).toBe('pausada');
    expect(d.pauses[0]).toMatchObject({ reason: 'Aguardando peça', to: null });
    expect((await joao.post(`/api/os/${id}/retomar`)).status).toBe(403); // Joao already left
    expect((await pedro.post(`/api/os/${id}/retomar`)).status).toBe(200);
    d = await detail(id);
    expect(d.status).toBe('em_atendimento');
    expect(d.pauses[0].to).toBeTruthy();
  });

  it('o último a devolver volta a OS para a fila', async () => {
    const r = await open(operador, { assetRef: 'PRENSA-1' });
    await joao.post(`/api/os/${r.body.id}/aceitar`);
    expect((await joao.post(`/api/os/${r.body.id}/devolver`, { motivo: 'Precisa de eletricista' })).status).toBe(200);
    const d = await detail(r.body.id);
    expect(d.status).toBe('aberta');
    expect(d.workers).toEqual([]);
  });

  it('finalizar pede o serviço, fecha os tempos e vai para o histórico', async () => {
    expect((await pedro.post(`/api/os/${id}/finalizar`, { servico: '' })).status).toBe(400);
    expect((await pedro.post(`/api/os/${id}/finalizar`, { servico: 'Troca do retentor do cilindro', material: 'Retentor 40mm' })).status).toBe(200);
    const d = await detail(id);
    expect(d).toMatchObject({ status: 'finalizada', service_done: 'Troca do retentor do cilindro', material: 'Retentor 40mm', finished_by_name: 'Pedro Manutentor', workers: [], pinned: false });
    expect(d.times.totalMs).toBeGreaterThanOrEqual(0);
    expect(d.hoursByWorker.map((w: any) => w.name).sort()).toEqual(['Joao Manutentor', 'Pedro Manutentor']);
    expect(d.events.map((e: any) => e.action)).toEqual(
      ['abriu', 'priorizou', 'indicou', 'aceitou', 'entrou', 'saiu', 'passou', 'recusou', 'passou', 'assumiu', 'pausou', 'retomou', 'finalizou']);
    expect((await operador.get('/api/os')).body.map((o: any) => o.id)).not.toContain(id);
    expect((await operador.get('/api/os?view=finalizadas')).body.map((o: any) => o.id)).toContain(id);
    expect((await operador.get('/api/os?view=finalizadas&q=retentor')).body).toHaveLength(1);
    expect((await pedro.post(`/api/os/${id}/aceitar`)).status).toBe(422);
    const n = (await operador.get('/api/notifications')).body[0];
    expect(n.type).toBe('os_finalizada');
  });

  it('o histórico é imutável', async () => {
    await expect(q('DELETE FROM work_order_events WHERE work_order_id = $1', [id])).rejects.toThrow(/imutáveis/);
    await expect(q('DELETE FROM work_orders WHERE id = $1', [id])).rejects.toThrow(/imutáveis/);
  });

  it('indicadores e exportação para gerência', async () => {
    expect((await operador.get('/api/os/report')).status).toBe(403);
    const r = await gerenteMan.get('/api/os/report');
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ opened: 3, finished: 1 });
    expect(r.body.now).toMatchObject({ aberta: 2, criticas: 1 });
    expect(r.body.assets.map((a: any) => a.asset)).toContain('INJ-07');
    expect(r.body.workers.map((w: any) => w.name)).toContain('Pedro Manutentor');
    const x = await ctx.app.inject({ method: 'GET', url: '/api/os/export.xlsx', headers: { cookie: gerenteMan.cookie } });
    expect(x.statusCode).toBe(200);
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('somente o administrador exclui definitivamente (para testes)', async () => {
    const code = (await detail(id)).code;
    expect((await gerenteMan.post(`/api/os/${id}/purge`, { confirm: code })).status).toBe(403);
    expect((await admin.post(`/api/os/${id}/purge`, { confirm: 'errado' })).status).toBe(400);
    expect((await admin.post(`/api/os/${id}/purge`, { confirm: code })).status).toBe(200);
    expect(await one('SELECT id FROM work_orders WHERE id = $1', [id])).toBeUndefined();
    expect((await q('SELECT id FROM notifications WHERE work_order_id = $1', [id])).length).toBe(0);
  });
});
