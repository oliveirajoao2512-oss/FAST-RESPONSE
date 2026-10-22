import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, normalizeSteps, nextNumber } from '../../shared/quality.js';
import { one, q } from '../src/db.js';
import { parseRespostaRapida } from '../src/services/quality.js';
import { dateToSerial, readXlsx, writeXlsx, type OutCell } from '../src/services/xlsx.js';
import { Client, createUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: Client, gestor: Client, liderMan: Client, operador: Client, liderQual: Client, gestorQual: Client, tecQual: Client;

beforeAll(async () => {
  ctx = await setup();
  [admin, gestor, liderMan, operador] = await Promise.all((['admin', 'gestor', 'liderMan', 'operador'] as const).map((k) => ctx.c(k)));
  const lq = await createUser('Lider Qualidade', 'lider', 'qualidade');
  const gq = await createUser('Gestor Qualidade', 'gestor', 'qualidade');
  const tq = await createUser('Inspetor Qualidade', 'colaborador', 'qualidade');
  [liderQual, gestorQual, tecQual] = await Promise.all([lq, gq, tq].map((u) => new Client(ctx.app).login(u.email)));
});
afterAll(async () => {
  await ctx.app.close();
});

// ---------------------------------------------------------------- synthetic spreadsheet in the company layout

const HEAD_EXT = ['NÚMERO DA OCORRÊNCIA', 'DATA DE ABERTURA', 'TIPO', 'CLIENTE', 'RECLAMAÇÃO', 'DESCRIÇÃO DO PRODUTO', 'CÓDIGO INTERNO', 'CÓDIGO CLIENTE',
  'NÚMERO DA RECLAMAÇÃO CLIENTE', 'DESCRIÇÃO DO PROBLEMA', 'PROBLEMA PRIMÁRIO', 'SEGURANÇA / REGULATÓRIO?', 'REINCIDENTE', 'LÍDER', 'CONTENÇÃO',
  'CAUSA RAIZ', 'AÇÕES CORRETIVAS', 'POKA-YOKE', 'VALIDAÇÃO DA EFICÁCIA DA AÇÕES', 'PFMEA', 'PLANO DE CONTROLE', 'TRABALHO PADRONIZADO',
  'TREINAMENTO', 'LPA', 'LIÇÕES APRENDIDAS', 'PLANO DE AÇÃO/CONTRAMEDIDAS', 'PRAZO', 'FECHAMENTO', 'DIAS TOTAIS', 'DIAS ACIMA DO PRAZO',
  'STATUS GERAL', 'ON HOLD GERAL?', 'MOTIVO DE ON HOLD', 'INCIDENTE PROCEDENTE?', 'FECHADO NO PRAZO?'];
const OFFSETS = [1, 7, 14, 14, 34, 35, 35, 35, 35, 40, 40];
const day = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const c = (v: string | number | null): OutCell => ({ v });
const d = (iso: string): OutCell => ({ v: dateToSerial(iso) });

interface Nc { n: string; opened: string; client: string; problem: string; done: (string | number | null)[]; procedente?: string; onHold?: string }
function externa(list: Nc[]) {
  const rows: (OutCell | null)[][] = [[c('QUADRO DE RESPOTA RÁPIDA')]];
  while (rows.length < 9) rows.push([]);
  rows.push(HEAD_EXT.map(c));
  for (const x of list) {
    rows.push([c(x.n), x.opened ? d(x.opened) : c(null), c('Qualidade'), c(x.client), c('Oficial'), c('Reservatório'), c('100.01.0516.01B'), c(52173878), c('-'),
      c('Vazamento na solda'), c(x.problem), c('NÃO'), c('NÃO'), c('Leonardo'), ...OFFSETS.map((o) => (x.opened ? d(day(x.opened, o)) : c(null))), c(null),
      x.opened ? d(day(x.opened, 40)) : c(null), c(null), c(0), c(0), c('IGNORADO'), c(x.onHold ?? 'N/A'), c(null), c(x.procedente ?? 'SIM'), c(null)]);
    rows.push([...Array(14).fill(null), ...x.done.map((v) => (typeof v === 'string' && /^\d{4}-/.test(v) ? d(v) : c(v)))]);
  }
  return rows;
}
const cadastro = [[c('Tipo'), c('Cliente'), c('Fornecedores'), c('Problema Primário')], [c('Qualidade'), c('GM-SCS'), c('Planmar'), c('Contaminação')]];

const ALL_DONE = (opened: string) => OFFSETS.map((o) => day(opened, o - 1));
function workbook(list: Nc[]) {
  return writeXlsx([
    { name: 'NC Externa', rows: externa(list) },
    { name: 'NC Interna', rows: externa([]) },
    { name: 'CADASTRO', rows: cadastro },
  ]);
}
const BASE: Nc[] = [
  { n: '108/26', opened: '2026-01-05', client: 'GM-SCS', problem: 'Falha na região da solda', done: ALL_DONE('2026-01-05') },
  { n: '109/26', opened: '2026-01-10', client: 'GM-SCS', problem: 'Deformação', done: ['2026-01-10', '2026-01-17'] },
  { n: '118/26', opened: '2026-02-01', client: 'Forvia-SBC', problem: 'Falha de injeção', done: ['2026-02-01', '2026-02-07', 'On Hold'], onHold: 'NÃO' },
  { n: '120/26', opened: '2026-02-02', client: 'Forvia-SBC', problem: 'Deformação', done: ['2026-02-03', 'N/A', 'N/A'], procedente: 'NÃO' },
  { n: 'XX', opened: '', client: 'Sem data', problem: 'x', done: [] },
];

function multipart(name: string, buf: Buffer) {
  const boundary = '----frtest' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}
async function upload(cl: Client, buf: Buffer, query = '', name = 'Resposta Rápida.xlsx') {
  const m = multipart(name, buf);
  const r = await ctx.app.inject({ method: 'POST', url: `/api/quality/import${query}`, payload: m.body, headers: { cookie: cl.cookie, 'x-requested-with': 'fast-response', 'content-type': m.type } });
  return { status: r.statusCode, body: r.json() };
}
const byNumber = async (n: string) => (await liderQual.get('/api/quality/ncs')).body.ncs.find((x: any) => x.number === n);

describe('Qualidade — regras de status (mesmas da planilha)', () => {
  const nc = (steps: any, extra: any = {}) => ({ opened_on: '2026-01-01', due_on: '2026-02-10', steps, on_hold: false, procedente: 'SIM' as const, ...extra });
  it('pendente no prazo, atrasado, concluído no prazo e fora do prazo', () => {
    expect(evaluate(nc({ contencao: { done: '2026-01-02' } }), '2026-01-05').status).toBe('no_prazo');
    expect(evaluate(nc({}), '2026-01-03').status).toBe('atrasado'); // contenção vencia em 02/01
    expect(evaluate(nc({ contencao: { done: '2026-01-03' } }), '2026-01-04').status).toBe('atrasado'); // feita depois do prazo
    expect(evaluate(nc({ licoes: { done: '2026-02-10' } }), '2026-03-01')).toMatchObject({ status: 'concluido_no_prazo', closedOnTime: 'SIM', totalDays: 40 });
    expect(evaluate(nc({ licoes: { done: '2026-02-15' } }), '2026-03-01')).toMatchObject({ status: 'concluido_fora', closedOnTime: 'NÃO', daysOver: 5 });
  });
  it('on hold suspende, N/A não conta atraso, não procedente fica N/A', () => {
    expect(evaluate(nc({ causa_raiz: { mark: 'hold' } }), '2026-03-01')).toMatchObject({ status: 'on_hold', closedOnTime: 'ITEM SUSPENSO' });
    const allNa = Object.fromEntries(Object.keys(normalizeSteps('2026-01-01', {})).map((k) => [k, { mark: 'na' }]));
    expect(evaluate(nc(allNa), '2026-03-01').status).toBe('na');
    expect(evaluate(nc({ contencao: { done: '2026-01-02' } }, { procedente: 'NÃO' }), '2026-03-01')).toMatchObject({ status: 'na', totalDays: 1 });
  });
  it('próximo número no padrão NNN/AA', () => {
    expect(nextNumber(['108/26', '136/26', '12/25'], '2026-10-22')).toBe('137/26');
    expect(nextNumber([], '2027-01-02')).toBe('1/27');
  });
  it('leitor do Excel lê o layout da planilha (duas linhas por ocorrência)', () => {
    const p = parseRespostaRapida(readXlsx(workbook(BASE)), '2026-10-22');
    expect(p.records.map((r) => r.number)).toEqual(['108/26', '109/26', '118/26', '120/26']);
    expect(p.warnings.some((w) => w.includes('XX'))).toBe(true);
    expect(p.records[0].customer_code).toBe('52173878');
    expect(p.records[0].customer_claim).toBeNull(); // "-"
    expect(p.records[2].steps.acoes_corretivas.mark).toBe('hold');
    expect(p.catalog).toContainEqual({ kind: 'fornecedor', value: 'Planmar' });
  });
});

describe('Qualidade — acesso', () => {
  it('somente admin e líderes/gestores da Qualidade', async () => {
    for (const cl of [operador, liderMan, gestor, tecQual]) expect((await cl.get('/api/quality/ncs')).status).toBe(403);
    for (const cl of [admin, liderQual, gestorQual]) expect((await cl.get('/api/quality/ncs')).status).toBe(200);
    expect((await upload(operador, workbook(BASE))).status).toBe(403);
  });
});

describe('Qualidade — importação', () => {
  it('prévia não grava; confirmação cria as ocorrências com o status calculado', async () => {
    const prev = await upload(liderQual, workbook(BASE));
    expect(prev.status).toBe(200);
    expect(prev.body.committed).toBe(false);
    expect(prev.body.created).toHaveLength(4);
    expect(prev.body.warnings.length).toBeGreaterThan(0);
    expect((await one('SELECT count(*)::int AS n FROM quality_ncs'))!.n).toBe(0);

    const ok = await upload(liderQual, workbook(BASE), '?commit=1');
    expect(ok.body.committed).toBe(true);
    expect((await one('SELECT count(*)::int AS n FROM quality_ncs'))!.n).toBe(4);
    expect((await byNumber('108/26')).eval.status).toBe('concluido_no_prazo');
    expect((await byNumber('109/26')).eval.status).toBe('atrasado');
    expect((await byNumber('118/26')).eval.status).toBe('on_hold');
    expect((await byNumber('120/26')).eval.status).toBe('na');
    const imp = await one<any>('SELECT * FROM quality_imports ORDER BY id DESC LIMIT 1');
    expect(imp).toMatchObject({ created_count: 4, updated_count: 0 });
    expect((await q(`SELECT 1 FROM audit_events WHERE action = 'quality.import'`)).length).toBe(1);
    // CADASTRO tab feeds the suggestions
    const opts = (await liderQual.get('/api/quality/options')).body;
    expect(opts.catalog.fornecedor).toContain('Planmar');
    expect(opts.catalog.lider).toContain('Leonardo');
    expect(opts.nextNumber).toMatch(/^121\/\d\d$/);
  });

  it('reimportar a mesma planilha não altera nada', async () => {
    const r = await upload(liderQual, workbook(BASE), '?commit=1');
    expect(r.body).toMatchObject({ unchanged: 4, kept: 0 });
    expect(r.body.created).toHaveLength(0);
    expect(r.body.updated).toHaveLength(0);
  });

  it('alteração feita no sistema é preservada por padrão e pode ser substituída pela planilha', async () => {
    const nc = await byNumber('109/26');
    const e = await liderQual.patch(`/api/quality/ncs/${nc.id}`, { version: nc.version, steps: { acoes_corretivas: { done: '2026-01-20' } } });
    expect(e.status).toBe(200);
    const changed = BASE.map((x) => (x.n === '109/26' ? { ...x, client: 'GM-GRA' } : x));
    const prev = await upload(liderQual, workbook(changed));
    const u = prev.body.updated.find((x: any) => x.number === '109/26');
    expect(u.edited).toBe(true);
    expect(u.changes).toContain('Cliente/fornecedor: GM-SCS → GM-GRA');
    expect(u.changes.some((c: string) => c.startsWith('Ações corretivas: realizado'))).toBe(true);

    await upload(liderQual, workbook(changed), '?commit=1');
    expect((await byNumber('109/26')).partner).toBe('GM-SCS'); // kept
    await upload(liderQual, workbook(changed), '?commit=1&keepEdited=0');
    const after = await byNumber('109/26');
    expect(after.partner).toBe('GM-GRA');
    expect(after.steps.acoes_corretivas.done).toBeNull();
  });

  it('arquivo que não é Excel é recusado com mensagem clara', async () => {
    const r = await upload(liderQual, Buffer.from('não sou excel'), '', 'planilha.xlsx');
    expect(r.status).toBe(400);
    expect(r.body.erro).toMatch(/Excel/);
    expect((await upload(liderQual, workbook(BASE), '', 'planilha.csv')).status).toBe(400);
  });
});

describe('Qualidade — edição e cadastro', () => {
  it('registra etapa realizada com histórico; conflito de versão e data futura são recusados', async () => {
    const nc = await byNumber('118/26');
    const r = await gestorQual.patch(`/api/quality/ncs/${nc.id}`, {
      version: nc.version, on_hold: false, steps: { acoes_corretivas: { done: '2026-02-14' } }, action_plan: 'Ajustar parâmetros de injeção',
    });
    expect(r.status).toBe(200);
    const stale = await liderQual.patch(`/api/quality/ncs/${nc.id}`, { version: nc.version, leader: 'Marcos' });
    expect(stale.status).toBe(409);
    const future = await liderQual.patch(`/api/quality/ncs/${nc.id}`, { version: r.body.version, steps: { causa_raiz: { done: '2099-01-01' } } });
    expect(future.status).toBe(422);
    const det = (await liderQual.get(`/api/quality/ncs/${nc.id}`)).body;
    expect(det.nc.steps.acoes_corretivas).toMatchObject({ done: '2026-02-14', mark: null });
    expect(det.nc.eval.status).toBe('atrasado');
    const upd = det.history.find((h: any) => h.action === 'quality.update');
    expect(upd.actor_name).toBe('Gestor Qualidade');
    expect(upd.data.alteracoes).toContain('Ações corretivas: realizado ON HOLD → 14/02/2026');
    expect(upd.data.alteracoes).toContain('Plano de ação: — → Ajustar parâmetros de injeção');
  });

  it('nova ocorrência manual calcula os prazos das etapas; número duplicado é recusado', async () => {
    const r = await liderQual.post('/api/quality/ncs', { origin: 'fornecedor', number: '200/26', opened_on: '2026-10-01', partner: 'Planmar', primary_problem: 'Contaminação' });
    expect(r.status).toBe(201);
    const nc = (await liderQual.get(`/api/quality/ncs/${r.body.id}`)).body.nc;
    expect(nc.steps.contencao.plan).toBe('2026-10-02');
    expect(nc.steps.validacao.plan).toBe('2026-11-04');
    expect(nc.due_on).toBe('2026-11-10');
    expect(nc.procedente).toBe('SIM');
    expect((await liderQual.post('/api/quality/ncs', { origin: 'fornecedor', number: '200/26', opened_on: '2026-10-01' })).status).toBe(409);
    expect((await tecQual.post('/api/quality/ncs', { origin: 'fornecedor', number: '201/26', opened_on: '2026-10-01' })).status).toBe(403);
  });

  it('mudar a abertura move os prazos que seguem o critério padrão', async () => {
    const nc = await byNumber('200/26');
    await liderQual.patch(`/api/quality/ncs/${nc.id}`, { version: nc.version, opened_on: '2026-10-05' });
    const after = await byNumber('200/26');
    expect(after.steps.contencao.plan).toBe('2026-10-06');
    expect(after.due_on).toBe('2026-11-14');
  });

  it('exporta no formato da planilha e a exportação pode ser importada de volta sem alterações', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/quality/export.xlsx', headers: { cookie: liderQual.cookie, 'x-requested-with': 'fast-response' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const back = await upload(liderQual, r.rawPayload, '?keepEdited=0', 'export.xlsx');
    expect(back.status).toBe(200);
    expect(back.body.created).toHaveLength(0);
    expect(back.body.updated).toHaveLength(0);
    expect(back.body.unchanged).toBe(5);
  });
});

describe('Qualidade — ações sugeridas com aprovação', () => {
  const todaySP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  let jef: { id: string };
  let MAN: number;
  beforeAll(async () => {
    jef = await createUser('Jeferson Souza', 'colaborador', 'manutencao');
    MAN = (await one<{ id: number }>(`SELECT id FROM areas WHERE slug = 'manutencao'`))!.id;
  });
  const pending = async (cl: Client) => (await cl.get('/api/quality/suggestions')).body.pending as any[];

  it('sugere só a próxima etapa, com área e responsável pelo nome do líder', async () => {
    const r = await liderQual.post('/api/quality/ncs', { origin: 'externa', number: '300/26', opened_on: day(todaySP, -3), partner: 'GM-SCS', leader: 'Jeferson', description: 'Rebarba' });
    expect(r.status).toBe(201);
    await liderQual.post('/api/quality/ncs', { origin: 'interna', number: '301/26', opened_on: day(todaySP, -3), leader: 'Fulano' });
    const p = await pending(liderQual);
    const s = p.find((x) => x.number === '300/26');
    expect(s).toMatchObject({ step: 'contencao', areaId: MAN, assigneeId: jef.id, priority: 'alta' });
    expect(p.filter((x) => x.number === '300/26')).toHaveLength(1);
    const unknown = p.find((x) => x.number === '301/26');
    expect(unknown.assigneeId).toBeNull(); // líder não cadastrado: fica na área Qualidade, sem responsável
    expect((await operador.get('/api/quality/suggestions')).status).toBe(403);
  });

  it('aprovar cria a pendência na área; não duplica; a próxima etapa aparece depois', async () => {
    const s = (await pending(gestorQual)).find((x) => x.number === '300/26');
    const ok = await gestorQual.post('/api/quality/suggestions/approve', { items: [{ ncId: s.ncId, step: s.step, areaId: s.areaId, assigneeId: s.assigneeId, title: s.title, priority: s.priority }] });
    expect(ok.status).toBe(200);
    const issue = await one<any>('SELECT * FROM issues WHERE id = $1', [ok.body.created[0].issueId]);
    expect(issue).toMatchObject({ area_id: MAN, assignee_id: jef.id, status: 'aberta', priority: 'alta' });
    expect(issue.description).toContain('300/26');
    expect((await gestorQual.post('/api/quality/suggestions/approve', { items: [{ ncId: s.ncId, step: s.step, areaId: s.areaId, title: s.title, priority: 'media' }] })).status).toBe(409);
    expect((await pending(gestorQual)).some((x) => x.number === '300/26')).toBe(false);
    const det = (await liderQual.get(`/api/quality/ncs/${s.ncId}`)).body;
    expect(det.actions[0]).toMatchObject({ decision: 'criada', issue_code: issue.code, area_name: 'Manutenção' });
    expect(det.history.some((h: any) => h.action === 'quality.action_create')).toBe(true);
    // registering the step done brings the next step (causa raiz, due in 4 days)
    await liderQual.patch(`/api/quality/ncs/${s.ncId}`, { version: det.nc.version, steps: { contencao: { done: todaySP } } });
    expect((await pending(liderQual)).find((x) => x.number === '300/26')?.step).toBe('causa_raiz');
  });

  it('líder da Qualidade sem permissão na outra área cria sem responsável (o líder da área atribui)', async () => {
    const s = (await pending(liderQual)).find((x) => x.number === '300/26');
    const ok = await liderQual.post('/api/quality/suggestions/approve', { items: [{ ncId: s.ncId, step: s.step, areaId: MAN, assigneeId: jef.id, title: s.title, priority: 'media' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.created[0].assigned).toBe(false);
    expect((await one<any>('SELECT status, assignee_id FROM issues WHERE id = $1', [ok.body.created[0].issueId]))).toMatchObject({ status: 'aguardando_responsavel', assignee_id: null });
  });

  it('descartar tira da fila e fica registrado', async () => {
    const s = (await pending(liderQual)).find((x) => x.number === '301/26');
    expect((await liderQual.post('/api/quality/suggestions/dismiss', { items: [{ ncId: s.ncId, step: s.step }], note: 'tratado na reunião' })).status).toBe(200);
    const r = (await liderQual.get('/api/quality/suggestions')).body;
    expect(r.pending.some((x: any) => x.number === '301/26')).toBe(false);
    expect(r.decided.find((d: any) => d.number === '301/26')).toMatchObject({ decision: 'descartada', note: 'tratado na reunião' });
  });
});

describe('Exclusão definitiva (somente administrador)', () => {
  it('pendência de teste: some com todo o histórico; histórico continua imutável fora disso', async () => {
    const r = await admin.post('/api/issues', { title: 'Pendência de teste', areaId: (await one<{ id: number }>(`SELECT id FROM areas WHERE slug = 'producao'`))!.id, priority: 'media' });
    const id = r.body.id;
    await admin.post(`/api/issues/${id}/comments`, { body: 'teste' });
    expect((await gestorQual.post(`/api/admin/issues/${id}/purge`, { confirm: r.body.code })).status).toBe(403);
    expect((await admin.post(`/api/admin/issues/${id}/purge`, { confirm: 'errado' })).status).toBe(400);
    expect((await admin.post(`/api/admin/issues/${id}/purge`, { confirm: r.body.code.toLowerCase() })).status).toBe(200);
    expect(await one('SELECT 1 FROM issues WHERE id = $1', [id])).toBeUndefined();
    expect((await q(`SELECT 1 FROM audit_events WHERE issue_id = $1::uuid OR entity_id = $1::text`, [id])).length).toBe(0);
    await expect(q('DELETE FROM audit_events WHERE id = (SELECT min(id) FROM audit_events)')).rejects.toThrow(/imutáveis/);
  });

  it('ocorrência de teste: some com o histórico e as pendências geradas; gestor da Qualidade não pode', async () => {
    const nc = await byNumber('300/26');
    const linked = (await q<{ issue_id: string }>('SELECT issue_id FROM quality_actions WHERE nc_id = $1 AND issue_id IS NOT NULL', [nc.id])).map((x) => x.issue_id);
    expect(linked.length).toBeGreaterThan(0);
    expect((await gestorQual.post(`/api/quality/ncs/${nc.id}/purge`, { confirm: '300/26' })).status).toBe(403);
    expect((await admin.post(`/api/quality/ncs/${nc.id}/purge`, { confirm: '300/26', withIssues: true })).status).toBe(200);
    expect(await byNumber('300/26')).toBeUndefined();
    expect((await q('SELECT 1 FROM issues WHERE id = ANY($1)', [linked])).length).toBe(0);
    expect((await q(`SELECT 1 FROM audit_events WHERE entity_type = 'quality_nc' AND entity_id = $1`, [String(nc.id)])).length).toBe(0);
  });
});
