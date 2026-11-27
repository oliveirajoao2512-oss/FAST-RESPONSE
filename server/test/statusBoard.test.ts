import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from '../src/db.js';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { setSetupFetcher, toRow } from '../src/services/setups.js';
import { areaId, Client, createUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let operador: Client, joao: Client, lider: Client, pm: Client;
let prod: number;

beforeAll(async () => {
  ctx = await setup();
  resetMaintenanceAreaCache();
  operador = await ctx.c('operador');
  lider = await ctx.c('liderMan');
  pm = await new Client(ctx.app).login((await createUser('Plant Manager', 'plant_manager', null)).email);
  joao = await new Client(ctx.app).login((await createUser('Joao Manutentor', 'manutentor', null)).email);
  prod = await areaId('producao');
});
afterAll(async () => { setSetupFetcher(null); await ctx.app.close(); });

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

    const r = await lider.get('/api/tela');
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
    const b = (await lider.get('/api/tela')).body;
    expect(b.queue).toHaveLength(0);
    expect(b.places.every((p: any) => p.state === 'ok')).toBe(true);
    expect(b.today).toMatchObject({ finished: 1, stoppedNow: 0 });
  });

  it('resume as pendências abertas por área', async () => {
    const b = (await lider.get('/api/tela')).body;
    const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM issues WHERE status NOT IN ('concluida','cancelada')`);
    expect(b.issues.open).toBe(n);
    expect(b.issues.areas.reduce((s: number, a: any) => s + a.open, 0)).toBe(n);
  });

  it('só gestores, líderes, plant manager e administrador', async () => {
    expect((await pm.get('/api/tela')).status).toBe(200);
    expect((await (await ctx.c('admin')).get('/api/tela')).status).toBe(200);
    const r = await operador.get('/api/tela');
    expect(r.status).toBe(403);
    expect(r.body.erro).toMatch(/gestores, líderes e plant manager/);
  });

  it('precisa estar logado; o manutentor continua só nas OS', async () => {
    expect((await new Client(ctx.app).get('/api/tela')).status).toBe(401);
    expect((await joao.get('/api/tela')).status).toBe(403);
  });

  it('Controle de Setup: máquinas em setup aparecem só para o administrador', async () => {
    const t0 = Date.now() - 50 * 60_000;
    setSetupFetcher(async () => [
      toRow({ id: 's1', maquina: '20', pn: '100.01.0778', usuario: 'Carlos', status: 'Em andamento', inicio_timestamp: t0 })!,
      toRow({ id: 's2', maquina: '8', pn: '100.01.0779', usuario: 'Ana', status: 'Aguardando Produção', inicio_timestamp: t0, fim_timestamp: t0 + 30 * 60_000 })!,
      toRow({ id: 's3', maquina: 'INJ', status: 'Em andamento', inicio_timestamp: t0 })!,
      toRow({ id: 's4', maquina: '22', status: 'Finalizado', inicio_timestamp: t0, fim_timestamp: t0 + 20 * 60_000 })!,
    ]);
    const stopped = await open('8', true, 'Vazamento');
    const b = (await (await ctx.c('admin')).get('/api/tela')).body;
    const place = (code: string) => b.places.find((p: any) => p.type === 'maquina' && p.code === code);
    expect(place('20')).toMatchObject({ state: 'setup', setup: { status: 'Em andamento', pn: '100.01.0778', user: 'Carlos' } });
    // a maintenance stop wins over the setup, but the setup is still attached
    expect(place('8')).toMatchObject({ state: 'parada', setup: { status: 'Aguardando Produção' } });
    expect(place('22').state).toBe('ok');
    expect(b.setup).toMatchObject({ ok: true, inSetup: 2, waitingProduction: 1, today: 4, finishedToday: 2, unknownMachines: ['INJ'] });
    expect(b.setup.hoursToday).toBeGreaterThan(2);

    for (const c of [lider, pm]) {
      const o = (await c.get('/api/tela')).body;
      expect(o.setup).toBeUndefined();
      expect(o.places.some((p: any) => p.state === 'setup' || p.setup)).toBe(false);
    }
    await operador.post(`/api/os/${stopped.id}/cancelar`, { motivo: 'Teste' });
  });

  it('Controle de Setup fora do ar: a tela continua, avisando', async () => {
    setSetupFetcher(async () => { throw new Error('Controle de Setup respondeu 503'); });
    const r = await (await ctx.c('admin')).get('/api/tela');
    expect(r.status).toBe(200);
    expect(r.body.setup).toMatchObject({ ok: false, error: 'Controle de Setup respondeu 503', inSetup: 0 });
  });
});
