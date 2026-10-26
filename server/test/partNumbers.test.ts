import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPn, matchPn, typoDistance, type PartNumber } from '../../shared/partNumbers.js';
import { resetMaintenanceAreaCache } from '../src/routes/workOrders.js';
import { parsePartNumbers } from '../src/services/partNumberImport.js';
import { readXlsx, writeXlsx, type OutCell } from '../src/services/xlsx.js';
import { areaId, Client, createUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: Client, operador: Client, liderMan: Client, tec: Client;
let prod: number;

beforeAll(async () => {
  ctx = await setup();
  resetMaintenanceAreaCache();
  [admin, operador, liderMan] = await Promise.all((['admin', 'operador', 'liderMan'] as const).map((k) => ctx.c(k)));
  tec = await new Client(ctx.app).login((await createUser('Processista PN', 'tecnico_processo', null)).email);
  prod = await areaId('producao');
});
afterAll(async () => {
  await ctx.app.close();
});

const pn = (code: string, description: string | null = null, machine: string | null = null): PartNumber => ({ code, description, customer: null, machine });
const LIST = [pn('10001060542', 'TANQUE COMBUSTIVEL', 'MC-05'), pn('10001060543', 'RESERVATORIO AGUA', 'MC-1C'), pn('20004070011A', 'DUTO DE AR'), pn('30001234567')];

describe('reconhecimento do PN enquanto digita', () => {
  it('exato ignora espaços, traços e maiúsculas', () => {
    expect(findPn(LIST, ' 10001-060 542 ')?.code).toBe('10001060542');
    expect(findPn(LIST, '20004070011a')?.code).toBe('20004070011A');
    expect(findPn(LIST, '1000106054')).toBeNull();
  });
  it('lista primeiro os que começam com o que foi digitado, depois os que contêm', () => {
    expect(matchPn(LIST, '1000106').map((m) => m.code)).toEqual(['10001060542', '10001060543']);
    const r = matchPn(LIST, '0605');
    expect(r.every((m) => m.how === 'trecho')).toBe(true);
    expect(matchPn(LIST, '10001060542')[0]).toMatchObject({ code: '10001060542', how: 'exato' });
  });
  it('acha o PN mais próximo quando há erro de digitação', () => {
    expect(typoDistance('10001060542', '10001065042')).toBe(1); // dígitos trocados de lugar
    const swapped = matchPn(LIST, '10001065042');
    expect(swapped[0]).toMatchObject({ code: '10001060542', how: 'parecido', distance: 1 });
    expect(matchPn(LIST, '3000123467')[0]).toMatchObject({ code: '30001234567', how: 'parecido' }); // um dígito faltando
    expect(matchPn(LIST, '99999999999')).toEqual([]);
  });
  it('busca pela descrição e prioriza os PNs da máquina escolhida', () => {
    expect(matchPn(LIST, 'reservat')[0]).toMatchObject({ code: '10001060543', how: 'descricao' });
    expect(matchPn(LIST, '1000106', { machine: '1C' })[0].code).toBe('10001060543');
    expect(matchPn(LIST, '', { machine: '5' }).map((m) => m.code)).toEqual(['10001060542']);
  });
});

describe('planilha de cadastro do PCP', () => {
  const c = (v: string | number | null): OutCell => ({ v });
  it('lê as abas com PN, junta descrição, cliente e máquina, e ignora linhas sem código', () => {
    const buf = writeXlsx([
      { name: 'PLANILHA DE CADASTRO', rows: [[c('CADASTRO')], [], [c('ITEM'), c('PART NUMBER NEO POLÍMEROS')], [c(1), c(10001060542)], [c(2), c('20004070011a')], [c(3), c('TOTAL')]] },
      { name: 'BASE', rows: [[c('DESCRIÇÃO'), c('PN NEO'), c('CLIENTE'), c('MÁQUINA PADRÃO')], [c('TANQUE'), c('10001060542'), c('GM'), c('MC-05')], [c('NOVO'), c('30001234567'), c(null), c(null)]] },
    ]);
    const r = parsePartNumbers(readXlsx(buf));
    expect(r.items.map((p) => p.code).sort()).toEqual(['10001060542', '20004070011A', '30001234567']);
    expect(r.items.find((p) => p.code === '10001060542')).toMatchObject({ description: 'TANQUE', customer: 'GM', machine: 'MC-05' });
  });
});

describe('cadastro de PNs e validação na abertura das ordens', () => {
  const openOs = (partNumber: string) => operador.post('/api/os', { areaId: prod, location: 'maquina', assetRef: '5', kind: 'hidraulica', partNumber, machineStopped: false, description: 'Teste PN' });

  it('com a base vazia o PN é livre', async () => {
    expect((await openOs('QUALQUER 1')).status).toBe(201);
  });
  it('só o cadastro mexe na base', async () => {
    expect((await operador.post('/api/admin/part-numbers', { code: '1' })).status).toBe(403);
    const r = await admin.post('/api/admin/part-numbers', { code: ' 10001060542 ', description: 'TANQUE COMBUSTIVEL', machine: 'MC-05' });
    expect(r.status).toBe(200);
    expect((await admin.post('/api/admin/part-numbers', { code: '10001060542' })).status).toBe(409);
    await admin.post('/api/admin/part-numbers', { code: '10001060543', description: 'RESERVATORIO' });
    const off = await admin.post('/api/admin/part-numbers', { code: '55555555555', active: false });
    expect(off.status).toBe(200);
  });
  it('o catálogo ativo chega a quem abre OS e OA', async () => {
    const os = (await operador.get('/api/os/part-numbers')).body;
    expect(os.map((p: any) => p.code)).toEqual(['10001060542', '10001060543']);
    expect((await tec.get('/api/oa/part-numbers')).status).toBe(200);
  });
  it('PN fora da base é recusado com a sugestão mais próxima; o cadastrado entra com o código padrão', async () => {
    const bad = await openOs('10001065042');
    expect(bad.status).toBe(400);
    expect(bad.body.erro).toMatch(/não está cadastrado.*10001060542/);
    expect((await openOs('55555555555')).status).toBe(400); // inativo
    const ok = await openOs('10001-060542');
    expect(ok.status).toBe(201);
    const d = (await operador.get(`/api/os/${ok.body.id}`)).body;
    expect(d).toMatchObject({ part_number: '10001060542', part_description: 'TANQUE COMBUSTIVEL' });
    expect((await openOs('')).status).toBe(201); // continua opcional
  });
  it('lista do cadastro conta as ordens de cada PN', async () => {
    const list = (await admin.get('/api/admin/part-numbers')).body;
    expect(list.find((p: any) => p.code === '10001060542').orders).toBe(1);
    expect((await liderMan.get('/api/admin/part-numbers')).status).toBe(403);
  });
});
