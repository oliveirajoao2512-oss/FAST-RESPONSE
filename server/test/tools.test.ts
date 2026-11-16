import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { machineKey, pnDigits, toolCodesIn, toolMatches } from '../../shared/tools.js';
import { normalizeToolCode, placeLabel } from '../../shared/maintenance.js';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { parseTools } from '../src/services/toolImport.js';
import type { Workbook } from '../src/services/xlsx.js';
import { areaId, Client, createUser, PASSWORD, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: Client, operador: Client, liderMan: Client, joao: Client, pedro: Client, ana: Client;
let prod: number;
let pedroId: string, anaId: string;

beforeAll(async () => {
  ctx = await setup();
  resetMaintenanceAreaCache();
  [admin, operador, liderMan] = await Promise.all((['admin', 'operador', 'liderMan'] as const).map((k) => ctx.c(k)));
  const [j, p, a] = await Promise.all(['Joao Manutentor', 'Pedro Manutentor', 'Ana Manutentora'].map((n) => createUser(n, 'manutentor', null)));
  pedroId = p.id;
  anaId = a.id;
  [joao, pedro, ana] = await Promise.all([j, p, a].map((u) => new Client(ctx.app).login(u.email)));
  prod = await areaId('producao');
});
afterAll(async () => {
  await ctx.app.close();
});

const open = (cl: Client, extra: Record<string, unknown> = {}) =>
  cl.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '17A', component: 'dispositivo', kind: 'mecanica', machineStopped: false, description: 'Dispositivo não fecha', ...extra });

describe('códigos de dispositivo e trim die', () => {
  it('normaliza do jeito que a fábrica escreve', () => {
    expect(normalizeToolCode('D-405')).toBe('D405');
    expect(normalizeToolCode(' d 29 ')).toBe('D029');
    expect(normalizeToolCode('405', 'dispositivo')).toBe('D405');
    expect(normalizeToolCode('129', 'trim_die')).toBe('T129');
    expect(normalizeToolCode('T129', 'dispositivo')).toBeNull();
    expect(normalizeToolCode('X12')).toBeNull();
    expect(toolCodesIn('D-074\nD-016 / d118', 'dispositivo')).toEqual(['D074', 'D016', 'D118']);
  });

  it('compara máquinas e part numbers escritos de formas diferentes', () => {
    expect(machineKey('Injeção 120T')).toBe(machineKey('INJETORA 120 T'));
    expect(machineKey('08')).toBe('8');
    expect(machineKey('17A')).toBe('17A');
    expect(pnDigits('10001025301B')).toBe('10001025301');
    expect(pnDigits('100.01.0290.03')).toBe('10001029003');
  });

  it('busca por número, produto ou part number', () => {
    const t = { code: 'D405', description: 'Duto ar ICS', molds: 'M425', part_numbers: ['10001049801'] };
    for (const s of ['405', 'd-405', 'duto', 'm425', '1000104980']) expect(toolMatches(t, s), s).toBe(true);
    expect(toolMatches(t, '406')).toBe(false);
  });

  it('o local mostra o código', () => {
    expect(placeLabel({ location_type: 'maquina', asset_ref: '17A', component: 'dispositivo', tool_code: 'D405' })).toBe('Máquina 17A · dispositivo D405');
    expect(placeLabel({ location_type: null, asset_ref: 'D464', component: 'dispositivo', tool_code: 'D464' })).toBe('Dispositivo D464');
  });
});

describe('importação da planilha de moldes e dispositivos', () => {
  const sheet = (name: string, rows: (string | number | null)[][]): Workbook['sheets'][number] => ({
    name, rows: new Map(rows.map((r, i) => [i + 1, new Map(r.map((v, c) => [c, v] as const).filter(([, v]) => v != null))] as const)),
  });
  it('liga os dispositivos e trim dies do bloco do molde a todos os PNs do bloco', () => {
    const wb = { sheets: [
      sheet('Moldes e Dispositivos (Atual)', [
        [], [],
        [null, 'Molde', 'Codigo Ferr. Molde', 'Trindie', 'Codigo Ferr. Trindie', 'Descrição produto', 'Codigo Produto', 'Cliente', 'Dispositivo', 'Codigo Ferr. Disp.'],
        [null, 'M-067', '600.01', '67', '600.03', 'Container A', '10001016701', 'GM', 'D-118', '600.02'],
        [null, null, null, null, null, 'Container B', '10001025301', null, null, null],
        [null, 'M-076', '600.01', 'NA', null, 'Reservatório', '10001017101', null, 'D-074\nD-016', null],
        [null, 'M-999', null, 'NA', null, 'Sem dispositivo', '10001099901', null, 'NA', null],
      ]),
      sheet('Outra aba', [['Qualquer coisa'], ['x']]),
    ] } as Workbook;
    const r = parseTools(wb);
    expect(r.sheets).toEqual(['Moldes e Dispositivos (Atual)']);
    const by = Object.fromEntries(r.items.map((t) => [t.code, t]));
    expect(Object.keys(by).sort()).toEqual(['D016', 'D074', 'D118', 'T067']);
    expect(by.D118).toMatchObject({ type: 'dispositivo', part_numbers: ['10001016701', '10001025301'], molds: 'M-067' });
    expect(by.T067).toMatchObject({ type: 'trim_die', part_numbers: ['10001016701', '10001025301'] });
    expect(by.D016.part_numbers).toEqual(['10001017101']);
  });
});

describe('dispositivo na OS', () => {
  it('sem cadastro, aceita qualquer código bem escrito', async () => {
    const r = await open(operador, { toolCode: 'd-7' });
    expect(r.status).toBe(201);
    expect((await operador.get(`/api/os/${r.body.id}`)).body.tool_code).toBe('D007');
  });

  it('cadastro: só o gestor do cadastro mexe', async () => {
    expect((await operador.post('/api/admin/tools', { code: 'D405' })).status).toBe(403);
    expect((await admin.post('/api/admin/tools', { code: 'X1' })).status).toBe(400);
    const r = await admin.post('/api/admin/tools', { code: 'd-405', description: 'Duto ar ICS', partNumbers: ['10001049801'], machines: [] });
    expect(r.status).toBe(200);
    expect((await admin.post('/api/admin/tools', { code: 'D405' })).status).toBe(409);
    expect((await admin.post('/api/admin/tools', { code: 'D406', partNumbers: ['10001050901'] })).status).toBe(200);
    expect((await admin.post('/api/admin/tools', { code: 'T129', partNumbers: ['10001049801'] })).status).toBe(200);
    expect((await admin.post('/api/admin/tools', { code: 'D500', machines: ['24'] })).status).toBe(200);
    expect((await admin.post('/api/admin/part-numbers', { code: '10001049801B', machine: '17A' })).status).toBe(200);
    expect((await admin.post('/api/admin/part-numbers', { code: '10001050901', machine: 'Máquina 17A' })).status).toBe(200);
    const list = (await admin.get('/api/admin/tools')).body;
    expect(list.find((t: any) => t.code === 'D405')).toMatchObject({ type: 'dispositivo', part_numbers: ['10001049801'] });
  });

  it('sugere pela máquina e, com o part number, só os dele', async () => {
    const m = (await operador.get('/api/os/tools?asset=17A')).body;
    expect(m.suggested).toEqual(expect.arrayContaining([{ code: 'D405', why: 'pn_maquina' }, { code: 'D406', why: 'pn_maquina' }, { code: 'T129', why: 'pn_maquina' }]));
    expect(m.tools.length).toBeGreaterThanOrEqual(4);
    const p = (await operador.get('/api/os/tools?asset=17A&pn=10001049801B')).body;
    expect(p.suggested.filter((s: any) => s.why === 'pn').map((s: any) => s.code).sort()).toEqual(['D405', 'T129']);
    expect((await operador.get('/api/os/tools?asset=24')).body.suggested).toEqual([{ code: 'D500', why: 'maquina' }]);
  });

  let id: string;
  it('com cadastro, só aceita código cadastrado e do tipo certo', async () => {
    expect((await open(operador, { toolCode: 'D999' })).body.erro).toMatch(/não está cadastrado/);
    expect((await open(operador, { component: 'trim_die', toolCode: 'D405' })).status).toBe(400);
    const r = await open(operador, { toolCode: '405' });
    expect(r.status).toBe(201);
    id = r.body.id;
    const d = (await joao.get(`/api/os/${id}`)).body;
    expect(d).toMatchObject({ tool_code: 'D405', tool_description: 'Duto ar ICS' });
    expect(d.events[0].data).toMatchObject({ dispositivo: 'D405' });
    // the code is only kept for device / trim die orders
    const mq = await open(operador, { component: 'maquina', toolCode: 'D405' });
    expect((await joao.get(`/api/os/${mq.body.id}`)).body.tool_code).toBeNull();
    // "não sei qual"
    const ns = await open(operador, { toolCode: null });
    expect((await joao.get(`/api/os/${ns.body.id}`)).body.tool_code).toBeNull();
  });

  it('o manutentor corrige o dispositivo e fica no histórico; a máquina passa a sugerir', async () => {
    expect((await liderMan.post(`/api/os/${id}/dispositivo`, { toolCode: 'D406' })).status).toBe(200);
    expect((await ctx.c('liderProd').then((c) => c.post(`/api/os/${id}/dispositivo`, { toolCode: 'D405' }))).status).toBe(403);
    expect((await joao.post(`/api/os/${id}/dispositivo`, { toolCode: 'D500' })).status).toBe(200);
    const d = (await joao.get(`/api/os/${id}`)).body;
    expect(d.tool_code).toBe('D500');
    expect(d.events.filter((e: any) => e.action === 'dispositivo').map((e: any) => [e.data.de, e.data.para])).toEqual([['D405', 'D406'], ['D406', 'D500']]);
    const s = (await operador.get('/api/os/tools?asset=17A')).body.suggested;
    expect(s).toContainEqual({ code: 'D500', why: 'historico' });
  });

  it('busca, indicadores e Excel mostram o dispositivo', async () => {
    expect((await operador.get('/api/os?q=D500')).body.map((o: any) => o.id)).toContain(id);
    const rep = (await admin.get('/api/os/report?tool=D500')).body;
    expect(rep.totals.opened).toBe(1);
    expect(rep.byTool[0]).toMatchObject({ key: 'D500', n: 1 });
    expect(rep.filters.tools).toContain('D500');
    const x = await ctx.app.inject({ method: 'GET', url: '/api/os/export.xlsx', headers: { cookie: admin.cookie } });
    expect(x.statusCode).toBe(200);
  });

  it('não troca o código de um dispositivo que já está em OS', async () => {
    expect((await admin.put('/api/admin/tools/D500', { code: 'D501' })).status).toBe(400);
    expect((await admin.put('/api/admin/tools/D406', { code: 'D407', partNumbers: [] })).status).toBe(200);
  });
});

describe('dois manutentores na mesma OS', () => {
  let id: string;
  it('quem está atuando inclui um colega; as horas dele contam', async () => {
    id = (await open(operador, { component: 'maquina' })).body.id;
    expect((await joao.post(`/api/os/${id}/incluir`, { userId: pedroId })).body.erro).toMatch(/Aceite/);
    expect((await joao.post(`/api/os/${id}/aceitar`)).status).toBe(200);
    expect((await pedro.post(`/api/os/${id}/incluir`, { userId: anaId })).status).toBe(403);
    const r = await joao.post(`/api/os/${id}/incluir`, { userId: pedroId, desdeInicio: true });
    expect(r.status).toBe(200);
    expect((await joao.post(`/api/os/${id}/incluir`, { userId: pedroId })).status).toBe(400);
    const d = (await joao.get(`/api/os/${id}`)).body;
    expect(d.workers.map((w: any) => w.name).sort()).toEqual(['Joao Manutentor', 'Pedro Manutentor']);
    expect(d.events.at(-1)).toMatchObject({ action: 'incluiu', data: { quem: 'Pedro Manutentor' } });
    const n = (await pedro.get('/api/notifications')).body;
    expect(JSON.stringify(n)).toMatch(/incluiu você/);
  });

  it('ao finalizar, quem fez junto entra com as horas do atendimento', async () => {
    expect((await joao.post(`/api/os/${id}/finalizar`, { servico: 'Troca do retentor', ajudantes: [anaId, pedroId] })).status).toBe(200);
    const d = (await joao.get(`/api/os/${id}`)).body;
    expect(d.hoursByWorker.map((w: any) => w.name).sort()).toEqual(['Ana Manutentora', 'Joao Manutentor', 'Pedro Manutentor']);
    expect(d.stints.every((s: any) => s.left_reason === 'finalizou')).toBe(true);
    expect(d.events.filter((e: any) => e.action === 'incluiu').map((e: any) => e.data.quem)).toEqual(['Pedro Manutentor', 'Ana Manutentora']);
  });

  it('não aceita ajudante de fora da equipe', async () => {
    const other = (await open(operador, { component: 'maquina' })).body.id;
    await joao.post(`/api/os/${other}/aceitar`);
    const op = (await ctx.q<{ id: string }>(`SELECT id FROM users WHERE email = 'operador.producao@teste.local'`))[0].id;
    expect((await joao.post(`/api/os/${other}/finalizar`, { servico: 'x', ajudantes: [op] })).status).toBe(400);
    expect((await joao.post(`/api/os/${other}/incluir`, { userId: op })).status).toBe(400);
  });
});

describe('várias janelas com usuários diferentes no mesmo computador', () => {
  /** A browser: one cookie jar shared by its tabs. */
  class Browser {
    jar = new Map<string, string>();
    cookie = () => [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    take(r: { cookies: { name: string; value: string; expires?: Date }[] }) {
      for (const c of r.cookies) {
        if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.jar.delete(c.name);
        else this.jar.set(c.name, c.value);
      }
    }
    async login(email: string) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: email, password: PASSWORD }, headers: { 'x-requested-with': 'fast-response', cookie: this.cookie() } });
      expect(r.statusCode).toBe(200);
      this.take(r);
      return r.json().slot as string;
    }
    async req(method: 'GET' | 'POST', url: string, slot?: string) {
      const r = await ctx.app.inject({ method, url, headers: { 'x-requested-with': 'fast-response', cookie: this.cookie(), ...(slot ? { 'x-fr-slot': slot } : {}) } });
      this.take(r);
      return r;
    }
    me = async (slot?: string) => {
      const r = await this.req('GET', '/api/auth/me', slot);
      return r.statusCode === 200 ? r.json().user?.name ?? r.json().name : null;
    };
  }

  it('cada janela fica com o seu usuário, e sair de uma não derruba a outra', async () => {
    const b = new Browser();
    const tabA = await b.login('joao.manutentor@teste.local');
    const tabB = await b.login('pedro.manutentor@teste.local');
    expect(tabA).not.toBe(tabB);
    expect(await b.me(tabA)).toBe('Joao Manutentor');
    expect(await b.me(tabB)).toBe('Pedro Manutentor');
    // a tab without its own login (a link opened in a new tab) gets the latest login
    expect(await b.me()).toBe('Pedro Manutentor');
    // the live-update stream and downloads carry the tab in the URL
    const pdfOk = await b.req('GET', `/api/auth/me?slot=${tabA}`);
    expect(pdfOk.json().user?.name ?? pdfOk.json().name).toBe('Joao Manutentor');

    expect((await b.req('POST', '/api/auth/logout', tabA)).statusCode).toBe(200);
    expect(await b.me(tabA)).toBeNull();
    expect(await b.me(tabB)).toBe('Pedro Manutentor');
    expect(await b.me()).toBe('Pedro Manutentor');

    // a slot that is not this browser's opens nothing
    expect(await new Browser().me(tabB)).toBeNull();
  });

  it('uma janela nova pega uma cópia do último login; sair dela não derruba as outras', async () => {
    const b = new Browser();
    const tabA = await b.login('joao.manutentor@teste.local');
    // new window: no slot of its own yet
    const r = await b.req('POST', '/api/auth/adopt');
    expect(r.statusCode).toBe(200);
    const tabNew = r.json().slot as string;
    expect(tabNew).not.toBe(tabA);
    expect(await b.me(tabNew)).toBe('Joao Manutentor');
    expect((await b.req('POST', '/api/auth/adopt', tabA)).statusCode).toBe(400);
    // leaves the new window to log in as someone else: the first one stays
    expect((await b.req('POST', '/api/auth/logout', tabNew)).statusCode).toBe(200);
    expect(await b.me(tabNew)).toBeNull();
    expect(await b.me(tabA)).toBe('Joao Manutentor');
    // a window that logged out stays on the login screen, even with other windows logged in
    expect(await b.me('-')).toBeNull();
    expect((await b.req('POST', '/api/auth/logout', '-')).statusCode).toBe(200);
    expect(await b.me()).toBe('Joao Manutentor');
    const tabB = await b.login('pedro.manutentor@teste.local');
    expect(await b.me(tabB)).toBe('Pedro Manutentor');
    expect(await b.me(tabA)).toBe('Joao Manutentor');
  });

  it('sair da janela padrão desconecta só ela', async () => {
    const b = new Browser();
    const tabA = await b.login('ana.manutentora@teste.local');
    expect((await b.req('POST', '/api/auth/logout')).statusCode).toBe(200);
    expect(await b.me()).toBeNull();
    expect(await b.me(tabA)).toBeNull(); // same login as the default one
  });
});
