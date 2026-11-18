import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from '../src/db.js';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { areaId, Client, createUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let operador: Client, joao: Client;
let prod: number;

beforeAll(async () => {
  ctx = await setup();
  resetMaintenanceAreaCache();
  operador = await ctx.c('operador');
  joao = await new Client(ctx.app).login((await createUser('Joao Manutentor', 'manutentor', null)).email);
  prod = await areaId('producao');
});
afterAll(async () => { await ctx.app.close(); });

const open = async (assetRef: string, stopped: boolean, description = 'Teste') => {
  const r = await operador.post('/api/os', { areaId: prod, location: 'maquina', assetRef, component: 'maquina', kind: 'mecanica', machineStopped: stopped, description });
  expect(r.status).toBe(201);
  return r.body as { id: string; code: string };
};

describe('status da fábrica (tela de TV)', () => {
  it('mostra cada máquina com o que está acontecendo nela agora', async () => {
    const stopped = await open('17A', true, 'Prensa travada');
    const running = await open('1A', false, 'Ruído no redutor');
    expect((await joao.post(`/api/os/${running.id}/aceitar`)).status).toBe(200);

    const r = await operador.get('/api/tela');
    expect(r.status).toBe(200);
    const b = r.body;
    const place = (code: string) => b.places.find((p: any) => p.type === 'maquina' && p.code === code);
    expect(place('17A')).toMatchObject({ state: 'parada', orders: [{ code: stopped.code, status: 'aberta', stopped: true }] });
    expect(place('1A')).toMatchObject({ state: 'atencao', orders: [{ code: running.code, status: 'em_atendimento', workers: ['Joao Manutentor'] }] });
    expect(b.places.filter((p: any) => p.state === 'ok').length).toBe(b.places.length - 2);
    // stopped machines first in the queue
    expect(b.queue.map((o: any) => o.code)).toEqual([stopped.code, running.code]);
    expect(b.queue[0]).toMatchObject({ place: 'Máquina 17A', description: 'Prensa travada' });
    expect(b.today).toMatchObject({ opened: 2, stops: 1, stoppedNow: 1, waiting: 1, working: 1, paused: 0, finished: 0 });
    expect(b.today.acceptMin).toBeGreaterThanOrEqual(0);
  });

  it('ordem finalizada ou cancelada sai da tela e conta no dia', async () => {
    const [o] = await q<{ id: string }>(`SELECT id FROM work_orders WHERE status = 'em_atendimento' LIMIT 1`);
    expect((await joao.post(`/api/os/${o.id}/finalizar`, { servico: 'Trocado o rolamento' })).status).toBe(200);
    const [a] = await q<{ id: string }>(`SELECT id FROM work_orders WHERE status = 'aberta' LIMIT 1`);
    expect((await operador.post(`/api/os/${a.id}/cancelar`, { motivo: 'Aberta por engano' })).status).toBe(200);
    const b = (await operador.get('/api/tela')).body;
    expect(b.queue).toHaveLength(0);
    expect(b.places.every((p: any) => p.state === 'ok')).toBe(true);
    expect(b.today).toMatchObject({ finished: 1, stoppedNow: 0 });
  });

  it('resume as pendências abertas por área', async () => {
    const b = (await operador.get('/api/tela')).body;
    const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM issues WHERE status NOT IN ('concluida','cancelada')`);
    expect(b.issues.open).toBe(n);
    expect(b.issues.areas.reduce((s: number, a: any) => s + a.open, 0)).toBe(n);
  });

  it('precisa estar logado; o manutentor continua só nas OS', async () => {
    expect((await new Client(ctx.app).get('/api/tela')).status).toBe(401);
    expect((await joao.get('/api/tela')).status).toBe(403);
  });
});
