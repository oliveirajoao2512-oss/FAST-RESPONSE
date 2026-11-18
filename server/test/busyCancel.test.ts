import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from '../src/db.js';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { areaId, Client, createUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let operador: Client, liderMan: Client, tecFerr: Client, gerenteMan: Client, joao: Client, pedro: Client, ana: Client;
let prod: number;
let joaoId: string, pedroId: string, anaId: string;

beforeAll(async () => {
  ctx = await setup();
  resetMaintenanceAreaCache();
  [operador, liderMan, tecFerr] = await Promise.all((['operador', 'liderMan', 'tecFerr'] as const).map((k) => ctx.c(k)));
  const gm = await createUser('Gerente Manutencao', 'gestor', 'manutencao');
  const [j, p, a] = await Promise.all(['Joao Manutentor', 'Pedro Manutentor', 'Ana Manutentora'].map((n) => createUser(n, 'manutentor', null)));
  joaoId = j.id; pedroId = p.id; anaId = a.id;
  [gerenteMan, joao, pedro, ana] = await Promise.all([gm, j, p, a].map((u) => new Client(ctx.app).login(u.email)));
  prod = await areaId('producao');
});
afterAll(async () => { await ctx.app.close(); });

const open = async (description: string, cl = operador) => {
  const r = await cl.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '17A', component: 'maquina', kind: 'mecanica', machineStopped: false, description });
  expect(r.status).toBe(201);
  return r.body as { id: string; code: string };
};
const status = async (id: string) => (await operador.get(`/api/os/${id}`)).body.status;

describe('uma ordem por vez', () => {
  it('quem está atuando numa OS não aceita outra, nem com ela pausada', async () => {
    const a = await open('Primeira');
    const b = await open('Segunda');
    expect((await joao.post(`/api/os/${a.id}/aceitar`)).status).toBe(200);
    const r = await joao.post(`/api/os/${b.id}/aceitar`);
    expect(r.status).toBe(422);
    expect(r.body.erro).toContain(`Você já está atuando na ${a.code}`);
    expect((await joao.post(`/api/os/${a.id}/pausar`, { motivo: 'Aguardando peça' })).status).toBe(200);
    expect((await joao.post(`/api/os/${b.id}/aceitar`)).status).toBe(422);
    // the screen knows who is busy, and where
    expect((await joao.get('/api/os/options')).body.busy[joaoId]).toMatchObject({ code: a.code, id: a.id });
    // leaving the first one frees the person
    expect((await joao.post(`/api/os/${a.id}/devolver`, { motivo: 'Sem peça hoje' })).status).toBe(200);
    expect((await joao.post(`/api/os/${b.id}/aceitar`)).status).toBe(200);
    expect(await status(b.id)).toBe('em_atendimento');
  });

  it('não dá para incluir, passar ou marcar como ajudante quem está em outra OS', async () => {
    const c = await open('Terceira');
    expect((await pedro.post(`/api/os/${c.id}/aceitar`)).status).toBe(200);
    const busyJoao = (await joao.get('/api/os/options')).body.busy[joaoId].code;
    const inc = await pedro.post(`/api/os/${c.id}/incluir`, { userId: joaoId });
    expect(inc.status).toBe(422);
    expect(inc.body.erro).toBe(`Joao Manutentor já está atuando na ${busyJoao}. Uma ordem por vez.`);
    expect((await pedro.post(`/api/os/${c.id}/passar`, { userId: joaoId })).status).toBe(422);
    expect((await pedro.post(`/api/os/${c.id}/finalizar`, { servico: 'Feito', ajudantes: [joaoId] })).status).toBe(422);
    // a free colleague is fine
    expect((await pedro.post(`/api/os/${c.id}/incluir`, { userId: anaId })).status).toBe(200);
    expect((await ana.post(`/api/os/${(await open('Quarta')).id}/aceitar`)).status).toBe(422);
    expect((await pedro.post(`/api/os/${c.id}/finalizar`, { servico: 'Feito' })).status).toBe(200);
    // finishing frees everyone who was on it
    expect((await ana.post(`/api/os/${(await open('Quinta')).id}/aceitar`)).status).toBe(200);
  });
});

describe('cancelar ordem aberta por engano', () => {
  it('quem abriu cancela com motivo; vai para Finalizadas e sai dos indicadores', async () => {
    const x = await open('Aberta na máquina errada');
    expect((await tecFerr.post(`/api/os/${x.id}/cancelar`, { motivo: 'x' })).status).toBe(403);
    expect((await operador.post(`/api/os/${x.id}/cancelar`, { motivo: '' })).status).toBe(400);
    expect((await operador.post(`/api/os/${x.id}/cancelar`, { motivo: 'Era a máquina 17B' })).status).toBe(200);
    const d = (await operador.get(`/api/os/${x.id}`)).body;
    expect(d).toMatchObject({ status: 'cancelada', cancel_reason: 'Era a máquina 17B', cancelled_by_name: 'Operador Producao' });
    expect(d.events.map((e: any) => e.action)).toContain('cancelou');
    expect((await operador.get('/api/os?view=abertas')).body.some((o: any) => o.id === x.id)).toBe(false);
    expect((await operador.get('/api/os?view=finalizadas')).body.some((o: any) => o.id === x.id)).toBe(true);
    const rep = (await gerenteMan.get('/api/os/report')).body;
    expect(JSON.stringify(rep)).not.toContain(x.id);
    // the team that had been warned learns it was cancelled
    const n = await q(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'os_cancelada' AND work_order_id = $2`, [pedroId, x.id]);
    expect(n).toHaveLength(1);
    // nothing else can happen to it
    expect((await pedro.post(`/api/os/${x.id}/aceitar`)).status).toBe(422);
    expect((await operador.post(`/api/os/${x.id}/cancelar`, { motivo: 'de novo' })).status).toBe(422);
    const pdf = await operador.req('GET', `/api/os/${x.id}/comprovante.pdf`);
    expect(pdf.status).toBe(200);
  });

  it('com alguém atuando não cancela; a liderança cancela por quem abriu', async () => {
    const y = await open('Em atendimento');
    expect((await pedro.post(`/api/os/${y.id}/aceitar`)).status).toBe(200);
    const r = await operador.post(`/api/os/${y.id}/cancelar`, { motivo: 'Engano' });
    expect(r.status).toBe(422);
    expect(r.body.erro).toMatch(/devolver para a fila/);
    const z = await open('Duplicada');
    expect((await liderMan.post(`/api/os/${z.id}/cancelar`, { motivo: 'Duplicada da anterior' })).status).toBe(200);
    expect(await status(z.id)).toBe('cancelada');
  });
});
