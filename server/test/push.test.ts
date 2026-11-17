import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// the push services (Google, Apple, Mozilla) are outside the test: the library is replaced by a recorder
const sent: { endpoint: string; payload: any; urgency?: string }[] = [];
const gone = new Set<string>();
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'BPublicKeyForTests', privateKey: 'privateKeyForTests' }),
    sendNotification: async (sub: { endpoint: string }, payload: string, opts: { urgency?: string }) => {
      if (gone.has(sub.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), urgency: opts.urgency });
      return { statusCode: 201 };
    },
  },
}));

const { q } = await import('../src/db.js');
const { deliverPush } = await import('../src/push.js');
const { runOrderAlerts, waitText } = await import('../src/services/orderAlerts.js');
const { resetMaintenanceAreaCache } = await import('../src/routes/workOrders.js');
const { areaId, Client, createUser, setup } = await import('./helpers.js');

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: InstanceType<typeof Client>, operador: InstanceType<typeof Client>, liderMan: InstanceType<typeof Client>, joao: InstanceType<typeof Client>, pm: InstanceType<typeof Client>;
let joaoId: string, pmId: string, liderId: string, operadorId: string;
let prod: number;

const sub = (n: string) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'BKeyKeyKeyKeyKeyKeyKey', auth: 'authauth' }, device: 'Android · Chrome' });
const open = (stopped: boolean, extra: Record<string, unknown> = {}) =>
  operador.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '17A', component: 'maquina', kind: 'mecanica', machineStopped: stopped, description: 'Vazamento de óleo', ...extra });
const notes = (userId: string, type: string) => q<{ title: string; body: string | null; work_order_id: string }>(
  'SELECT title, body, work_order_id FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY id', [userId, type]);
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

beforeAll(async () => {
  ctx = await setup();
  resetMaintenanceAreaCache();
  [admin, operador, liderMan] = await Promise.all((['admin', 'operador', 'liderMan'] as const).map((k) => ctx.c(k)));
  const j = await createUser('Joao Manutentor', 'manutentor', null);
  const p = await createUser('Plant Manager', 'plant_manager', null);
  joaoId = j.id; pmId = p.id; liderId = ctx.users.liderMan.id; operadorId = ctx.users.operador.id;
  joao = await new Client(ctx.app).login(j.email);
  pm = await new Client(ctx.app).login(p.email);
  prod = await areaId('producao');
});
afterAll(async () => { await ctx.app.close(); });
beforeEach(() => { sent.length = 0; gone.clear(); });

describe('avisos no celular (push)', () => {
  it('cadastra o aparelho de quem está logado, inclusive o manutentor', async () => {
    expect((await joao.get('/api/push/key')).body.publicKey).toBeTruthy();
    expect((await joao.post('/api/push/subscribe', sub('joao'))).status).toBe(200);
    expect((await joao.post('/api/push/status', { endpoint: sub('joao').endpoint })).body).toEqual({ here: true, devices: 1 });
    expect((await joao.post('/api/push/subscribe', { ...sub('x'), endpoint: 'http://inseguro' })).status).toBe(400);
  });

  it('a OS nova chega no celular da equipe; máquina parada é urgente', async () => {
    await open(true);
    await deliverPush();
    const m = sent.find((s) => s.endpoint === sub('joao').endpoint)!;
    expect(m.payload.title).toMatch(/máquina parada — 17A/);
    expect(m.payload.url).toMatch(/^\/os\?id=/);
    expect(m.payload.urgent).toBe(true);
    expect(m.urgency).toBe('high');
    // delivered once
    sent.length = 0;
    await deliverPush();
    expect(sent).toHaveLength(0);
  });

  it('OS com a máquina rodando também avisa a equipe (configurável), sem urgência', async () => {
    const r = await open(false, { description: 'Barulho no redutor' });
    await deliverPush();
    expect(sent.find((s) => s.payload.url.endsWith(r.body.id))?.payload).toMatchObject({ urgent: false });
    expect((await notes(joaoId, 'os_nova')).some((n) => n.work_order_id === r.body.id)).toBe(true);
    const cfg = (await admin.get('/api/admin/settings')).body.config;
    await admin.put('/api/admin/settings', { config: { ...cfg, orders: { ...cfg.orders, notifyTeamOnEveryOpen: false } } });
    const r2 = await open(false, { description: 'Outro barulho' });
    expect((await notes(joaoId, 'os_nova')).some((n) => n.work_order_id === r2.body.id)).toBe(false);
    await admin.put('/api/admin/settings', { config: cfg });
  });

  it('um aparelho compartilhado segue quem entrou por último, e Sair desliga', async () => {
    await liderMan.post('/api/push/subscribe', sub('joao'));
    expect((await joao.post('/api/push/status', { endpoint: sub('joao').endpoint })).body.here).toBe(false);
    // someone else cannot turn off the device of another person
    expect((await joao.post('/api/push/unsubscribe', { endpoint: sub('joao').endpoint })).body.removed).toBe(0);
    expect((await liderMan.post('/api/push/unsubscribe', { endpoint: sub('joao').endpoint })).body.removed).toBe(1);
    await joao.post('/api/push/subscribe', sub('joao'));
  });

  it('aparelho que o serviço de push não conhece mais é removido', async () => {
    await pm.post('/api/push/subscribe', sub('pm-velho'));
    gone.add(sub('pm-velho').endpoint);
    expect((await pm.post('/api/push/test')).body).toMatchObject({ sent: 0, gone: 1 });
    expect((await pm.post('/api/push/status', {})).body.devices).toBe(0);
  });

  it('o manutentor, com acesso só às OS, usa os avisos', async () => {
    expect((await joao.get('/api/os')).status).toBe(200);
    expect((await joao.post('/api/push/test')).status).toBe(200);
  });
});

describe('cobrança por tempo das ordens sem aceite', () => {
  it('mostra a espera de forma curta', () => {
    expect(waitText(9.6)).toBe('10 min');
    expect(waitText(60)).toBe('1 h');
    expect(waitText(95)).toBe('1 h 35 min');
  });

  it('máquina parada: cobra a equipe aos 10 min e os gestores e o Plant Manager aos 30, uma vez cada', async () => {
    await q(`UPDATE work_orders SET status = 'finalizada', finished_at = now() WHERE status <> 'finalizada'`);
    const r = await open(true, { description: 'Prensa travada' });
    const id = r.body.id;
    expect((await runOrderAlerts(at(5))).reminded).toBe(0);

    expect(await runOrderAlerts(at(11))).toMatchObject({ reminded: 1, escalated: 0 });
    const j = (await notes(joaoId, 'os_cobranca')).filter((n) => n.work_order_id === id);
    expect(j).toHaveLength(1);
    expect(j[0].title).toMatch(/Máquina 17A PARADA há 11 min sem atendimento/);
    expect((await notes(liderId, 'os_cobranca')).filter((n) => n.work_order_id === id)).toHaveLength(1);
    expect((await notes(pmId, 'os_cobranca')).filter((n) => n.work_order_id === id)).toHaveLength(0);
    // the person who opened it is not charged
    expect((await notes(operadorId, 'os_cobranca'))).toHaveLength(0);
    expect((await runOrderAlerts(at(12))).reminded).toBe(0);

    expect(await runOrderAlerts(at(31))).toMatchObject({ escalated: 1 });
    const p = (await notes(pmId, 'os_cobranca')).filter((n) => n.work_order_id === id);
    expect(p).toHaveLength(1);
    expect(p[0].body).toMatch(/gestores avisados/);
    expect((await runOrderAlerts(at(60))).escalated).toBe(0);

    // it reaches the phone as urgent
    await deliverPush();
    expect(sent.some((s) => s.payload.title.includes('PARADA há') && s.payload.urgent)).toBe(true);
  });

  it('máquina rodando espera mais; ordem aceita não é cobrada', async () => {
    const running = (await open(false, { description: 'Ruído' })).body.id;
    const accepted = (await open(false, { description: 'Outro ruído' })).body.id;
    expect((await joao.post(`/api/os/${accepted}/aceitar`)).status).toBe(200);
    expect((await runOrderAlerts(at(30))).reminded).toBe(0);
    await runOrderAlerts(at(61));
    const titles = (await notes(joaoId, 'os_cobranca')).filter((n) => [running, accepted].includes(n.work_order_id));
    expect(titles).toHaveLength(1);
    expect(titles[0].work_order_id).toBe(running);
    expect(titles[0].title).toMatch(/aguardando aceite há 1 h 1 min/);
  });

  it('os tempos são configuráveis e 0 desliga', async () => {
    const cfg = (await admin.get('/api/admin/settings')).body.config;
    expect((await admin.put('/api/admin/settings', { config: { ...cfg, orders: { ...cfg.orders, stoppedManagerMinutes: 5 } } })).status).toBe(400);
    await admin.put('/api/admin/settings', { config: { ...cfg, orders: { ...cfg.orders, stoppedRemindMinutes: 0, stoppedManagerMinutes: 0 } } });
    await q(`UPDATE work_orders SET status = 'finalizada', finished_at = now() WHERE status <> 'finalizada'`);
    await open(true, { description: 'Sem cobrança' });
    expect(await runOrderAlerts(at(500))).toMatchObject({ reminded: 0, escalated: 0 });
    await admin.put('/api/admin/settings', { config: cfg });
  });
});
