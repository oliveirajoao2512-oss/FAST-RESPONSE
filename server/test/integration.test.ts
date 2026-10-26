import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { one, pool, q } from '../src/db.js';
import { invalidateConfig } from '../src/settings.js';
import { runDeadlineJobs } from '../src/services/jobs.js';
import { areaId, Client, PASSWORD, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: Client, gestor: Client, liderMan: Client, liderFerr: Client, liderProd: Client, tecMan: Client, tecFerr: Client, operador: Client;
let MAN: number, FERR: number, PROD: number, SEG: number;

beforeAll(async () => {
  ctx = await setup();
  [admin, gestor, liderMan, liderFerr, liderProd, tecMan, tecFerr, operador] = await Promise.all(
    (['admin', 'gestor', 'liderMan', 'liderFerr', 'liderProd', 'tecMan', 'tecFerr', 'operador'] as const).map((k) => ctx.c(k)));
  MAN = await areaId('manutencao');
  FERR = await areaId('ferramentaria');
  PROD = await areaId('producao');
  SEG = await areaId('seguranca');
});
afterAll(async () => {
  await ctx.app.close();
});

const notifications = async (userId: string, type?: string) =>
  q('SELECT * FROM notifications WHERE user_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY id', [userId, type ?? null]);

async function newIssue(c: Client, body: Record<string, unknown>) {
  const r = await c.post('/api/issues', { priority: 'media', ...body });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.id as string;
}

describe('1. cadastro e atribuição', () => {
  it('título é obrigatório (validação no servidor)', async () => {
    const r = await operador.post('/api/issues', { title: '   ', areaId: MAN });
    expect(r.status).toBe(400);
  });

  it('sem responsável fica "aguardando responsável"; líder atribui e o responsável é notificado', async () => {
    const id = await newIssue(operador, { title: 'Vazamento de óleo na injetora 07', areaId: MAN, assetType: 'maquina', assetRef: 'INJ-07' });
    let i = await operador.issue(id);
    expect(i.status).toBe('aguardando_responsavel');
    expect(i.origin_area_id).toBe(MAN);
    expect(i.opened_by).toBe(ctx.users.operador.id);
    expect(i.code).toMatch(/^FR-\d{4}-\d{5}$/);
    // líder da manutenção foi avisado da pendência sem responsável
    expect((await notifications(ctx.users.liderMan.id, 'atribuida')).length).toBeGreaterThan(0);

    const denied = await operador.post(`/api/issues/${id}/assign`, { version: i.version, assigneeId: ctx.users.tecMan.id });
    expect(denied.status).toBe(403);
    const otherLeader = await liderProd.post(`/api/issues/${id}/assign`, { version: i.version, assigneeId: ctx.users.tecMan.id });
    expect(otherLeader.status).toBe(403);

    const ok = await liderMan.post(`/api/issues/${id}/assign`, { version: i.version, assigneeId: ctx.users.tecMan.id });
    expect(ok.status).toBe(200);
    i = await operador.issue(id);
    expect(i.status).toBe('aberta');
    expect(i.assignee_id).toBe(ctx.users.tecMan.id);
    const n = await notifications(ctx.users.tecMan.id, 'atribuida');
    expect(n.some((x: any) => x.issue_id === id)).toBe(true);
  });

  it('colaborador pode assumir uma pendência sem responsável, mas não atribuir a outro', async () => {
    const id = await newIssue(operador, { title: 'Falta de etiqueta', areaId: MAN });
    const i = await tecMan.issue(id);
    expect((await tecMan.post(`/api/issues/${id}/assign`, { version: i.version, assigneeId: ctx.users.tecMan.id })).status).toBe(200);
    const r = await tecMan.post('/api/issues', { title: 'Outra', areaId: MAN, assigneeId: ctx.users.tecFerr.id });
    expect(r.status).toBe(403);
  });
});

describe('2. cálculo do vencimento (D+1) no servidor', () => {
  it('prazo é calculado pelo servidor e o prazo original é preservado', async () => {
    const before = new Date();
    const id = await newIssue(operador, { title: 'Prazo padrão', areaId: PROD });
    const row = await one<any>('SELECT opened_at, due_at, original_due_at FROM issues WHERE id = $1', [id]);
    const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    const opened = new Date(row.opened_at);
    expect(opened.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    const nextDay = new Date(opened.getTime() + 86400_000);
    expect(local(new Date(row.due_at))).toBe(`${local(nextDay).slice(0, 10)}, 23:59`);
    expect(new Date(row.original_due_at).getTime()).toBe(new Date(row.due_at).getTime());
  });

  it('colaborador não define prazo diferente do padrão na abertura', async () => {
    const r = await operador.post('/api/issues', { title: 'Prazo manipulado', areaId: PROD, customDueAt: new Date(Date.now() + 30 * 86400_000).toISOString(), customDueReason: 'quero mais prazo' });
    expect(r.status).toBe(403);
  });

  it('líder define prazo específico justificado; histórico registra o prazo padrão', async () => {
    const due = new Date(Date.now() + 5 * 86400_000);
    const id = await newIssue(liderMan, { title: 'Reforma do molde 12', areaId: MAN, customDueAt: due.toISOString(), customDueReason: 'Atividade complexa: depende de fornecedor' });
    const i = await liderMan.issue(id);
    expect(new Date(i.due_at).getTime()).toBe(due.getTime());
    expect(new Date(i.original_due_at).getTime()).toBeLessThan(due.getTime());
    expect(i.deadline_changes).toHaveLength(1);
    expect(i.deadline_changes[0].status).toBe('aprovada');
  });

  it('crítica de segurança: prazo imediato e escalonamento para segurança e gestores', async () => {
    const id = await newIssue(operador, { title: 'Proteção da prensa removida', areaId: SEG, priority: 'critica' });
    const row = await one<any>('SELECT is_safety_critical, opened_at, due_at FROM issues WHERE id = $1', [id]);
    expect(row.is_safety_critical).toBe(true);
    expect(new Date(row.due_at).getTime() - new Date(row.opened_at).getTime()).toBe(4 * 3600_000);
    expect((await notifications(ctx.users.gestor.id, 'seguranca_critica')).some((n: any) => n.issue_id === id)).toBe(true);
  });
});

describe('3. mudança automática para atrasada e escalonamento', () => {
  it('job marca atrasada, registra auditoria, notifica responsável e líder; depois escalona ao gestor', async () => {
    const id = await newIssue(liderMan, { title: 'Sensor de porta com defeito', areaId: MAN, assigneeId: ctx.users.tecMan.id });
    await q(`UPDATE issues SET due_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    await runDeadlineJobs();
    const i = await tecMan.issue(id);
    expect(i.is_overdue).toBe(true);
    expect(i.overdue_since).toBeTruthy();
    expect(i.timeline.some((e: any) => e.action === 'issue.overdue')).toBe(true);
    expect((await notifications(ctx.users.tecMan.id, 'atrasada')).some((n: any) => n.issue_id === id)).toBe(true);
    expect((await notifications(ctx.users.liderMan.id, 'atrasada')).some((n: any) => n.issue_id === id)).toBe(true);

    // running twice does not duplicate notifications
    await runDeadlineJobs();
    expect((await notifications(ctx.users.tecMan.id, 'atrasada')).filter((n: any) => n.issue_id === id)).toHaveLength(1);

    const list = await tecMan.get('/api/issues?flag=overdue');
    expect(list.body.items.some((x: any) => x.id === id)).toBe(true);

    await q(`UPDATE issues SET overdue_since = now() - interval '25 hours' WHERE id = $1`, [id]);
    await runDeadlineJobs();
    expect((await notifications(ctx.users.gestor.id, 'escalonamento')).some((n: any) => n.issue_id === id)).toBe(true);
  });

  it('aviso de prazo próximo', async () => {
    const id = await newIssue(liderMan, { title: 'Troca de mangueira', areaId: MAN, assigneeId: ctx.users.tecMan.id });
    await q(`UPDATE issues SET due_at = now() + interval '2 hours' WHERE id = $1`, [id]);
    await runDeadlineJobs();
    expect((await notifications(ctx.users.tecMan.id, 'prazo_proximo')).some((n: any) => n.issue_id === id)).toBe(true);
  });
});

describe('4. etapas', () => {
  it('cria etapas, respeita dependências, calcula progresso e complexidade e impede encerramento com etapas pendentes', async () => {
    const id = await newIssue(liderFerr, { title: 'Corrigir falha no molde 45', areaId: FERR, assigneeId: ctx.users.tecFerr.id, assetType: 'molde', assetRef: 'M-45' });
    const titles = ['Diagnosticar o problema', 'Definir a intervenção', 'Separar materiais', 'Executar a manutenção', 'Teste de funcionamento'];
    const r = await tecFerr.post(`/api/issues/${id}/steps`, { steps: titles.map((title) => ({ title, assigneeId: ctx.users.tecFerr.id })) });
    expect(r.status).toBe(200);
    let i = await tecFerr.issue(id);
    expect(i.steps).toHaveLength(5);
    expect(i.complexity).toBe('complexa');
    expect(i.progress).toBe(0);

    // dependency: step 2 depends on step 1
    const [s1, s2] = i.steps;
    expect((await tecFerr.patch(`/api/steps/${s2.id}`, { version: s2.version, dependsOn: [s1.id] })).status).toBe(200);
    i = await tecFerr.issue(id);
    const blocked = await tecFerr.patch(`/api/steps/${s2.id}`, { status: 'concluida' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.erro).toContain('Diagnosticar');

    // step owner from another area can update status of own step but not structure
    const step5 = i.steps[4];
    expect((await liderMan.patch(`/api/steps/${step5.id}`, { title: 'X' })).status).toBe(403);

    // starting a step moves the issue to "em andamento"
    expect((await tecFerr.patch(`/api/steps/${s1.id}`, { status: 'em_andamento' })).status).toBe(200);
    expect((await tecFerr.issue(id)).status).toBe('em_andamento');
    expect((await tecFerr.patch(`/api/steps/${s1.id}`, { status: 'concluida' })).status).toBe(200);
    i = await tecFerr.issue(id);
    expect(i.progress).toBe(20);

    const fail = await tecFerr.post(`/api/issues/${id}/complete`, { version: i.version, solution: 'Molde ajustado e testado', criteriaConfirmed: true });
    expect(fail.status).toBe(422);
    expect(fail.body.detalhes.join(' ')).toContain('etapa(s) obrigatória(s)');

    for (const s of i.steps.slice(1)) expect((await tecFerr.patch(`/api/steps/${s.id}`, { status: 'concluida' })).status).toBe(200);
    i = await tecFerr.issue(id);
    expect(i.progress).toBe(100);
    const ok = await tecFerr.post(`/api/issues/${id}/complete`, { version: i.version, solution: 'Molde ajustado e testado', criteriaConfirmed: true });
    expect(ok.status).toBe(200);
  });

  it('prazo de etapa definido separadamente do prazo da pendência e alterações vão para o histórico', async () => {
    const id = await newIssue(liderMan, { title: 'Revisão do compressor', areaId: MAN, assigneeId: ctx.users.tecMan.id, steps: [{ title: 'Comprar peça' }] });
    let i = await liderMan.issue(id);
    const stepDue = new Date(Date.now() + 3 * 86400_000);
    expect((await liderMan.patch(`/api/steps/${i.steps[0].id}`, { dueAt: stepDue.toISOString() })).status).toBe(200);
    // second change must go through the deadline-change flow
    expect((await liderMan.patch(`/api/steps/${i.steps[0].id}`, { dueAt: new Date().toISOString() })).status).toBe(422);
    const newDue = new Date(Date.now() + 6 * 86400_000);
    expect((await liderMan.post(`/api/issues/${id}/deadline`, { stepId: i.steps[0].id, newDueAt: newDue.toISOString(), reason: 'Fornecedor atrasou a entrega' })).status).toBe(200);
    i = await liderMan.issue(id);
    expect(new Date(i.steps[0].due_at).getTime()).toBe(newDue.getTime());
    expect(new Date(i.steps[0].original_due_at).getTime()).toBe(stepDue.getTime());
    expect(new Date(i.due_at).getTime()).toBe(new Date(i.original_due_at).getTime()); // issue deadline untouched
  });
});

describe('5. transferência entre áreas', () => {
  it('muda a área responsável, mantém a área de origem e o histórico', async () => {
    const id = await newIssue(liderProd, { title: 'Peça com rebarba', areaId: PROD, assigneeId: ctx.users.operador.id });
    let i = await liderProd.issue(id);
    expect((await operador.post(`/api/issues/${id}/transfer`, { version: i.version, areaId: FERR, reason: 'Problema no molde' })).status).toBe(403);
    const r = await liderProd.post(`/api/issues/${id}/transfer`, { version: i.version, areaId: FERR, assigneeId: ctx.users.tecFerr.id, reason: 'Problema no molde, não na operação' });
    expect(r.status).toBe(200);
    i = await liderProd.issue(id);
    expect(i.area_id).toBe(FERR);
    expect(i.origin_area_id).toBe(PROD);
    expect(i.assignee_id).toBe(ctx.users.tecFerr.id);
    expect(i.transfers.at(-1).reason).toContain('molde');
    // still listed in Produção (origin) and in Ferramentaria (current)
    expect((await operador.get(`/api/issues?areaId=${PROD}`)).body.items.some((x: any) => x.id === id)).toBe(true);
    expect((await operador.get(`/api/issues?areaId=${FERR}`)).body.items.some((x: any) => x.id === id)).toBe(true);
    // origin cannot be changed even directly in the database
    await expect(q('UPDATE issues SET origin_area_id = $2 WHERE id = $1', [id, FERR])).rejects.toThrow(/origem/);
    expect((await notifications(ctx.users.tecFerr.id, 'responsavel_alterado')).some((n: any) => n.issue_id === id)).toBe(true);
  });
});

describe('6. impedimento e retomada', () => {
  it('bloqueia com impedimento de outra área e retoma o status anterior ao resolver', async () => {
    const id = await newIssue(liderMan, { title: 'Motor queimado', areaId: MAN, assigneeId: ctx.users.tecMan.id });
    let i = await tecMan.issue(id);
    expect((await tecMan.post(`/api/issues/${id}/status`, { version: i.version, status: 'em_andamento' })).status).toBe(200);
    // status "bloqueada" cannot be set without an impediment
    i = await tecMan.issue(id);
    expect((await tecMan.post(`/api/issues/${id}/status`, { version: i.version, status: 'bloqueada' })).status).toBe(422);
    expect((await tecMan.post(`/api/issues/${id}/block`, { version: i.version, description: 'Aguardando compra do motor', blockingAreaId: await areaId('logistica') })).status).toBe(200);
    i = await tecMan.issue(id);
    expect(i.status).toBe('bloqueada');
    expect(i.blocker).toContain('motor');
    expect(i.assignee_id).toBe(ctx.users.tecMan.id); // main responsibility kept
    const fail = await tecMan.post(`/api/issues/${id}/complete`, { version: i.version, solution: 'Motor trocado e testado', criteriaConfirmed: true });
    expect(fail.status).toBe(422);
    const imp = i.impediments[0];
    expect((await tecMan.post(`/api/impediments/${imp.id}/resolve`, { resolution: 'Motor entregue' })).status).toBe(200);
    i = await tecMan.issue(id);
    expect(i.status).toBe('em_andamento');
    expect(i.status_history.map((h: any) => h.to_status)).toEqual(['aberta', 'em_andamento', 'bloqueada', 'em_andamento']);
  });
});

describe('7. validação e reabertura', () => {
  it('conclusão vai para validação; quem concluiu não valida; rejeição reabre; reabertura por ineficácia é registrada', async () => {
    const id = await newIssue(operador, { title: 'Esteira travando', areaId: MAN, priority: 'alta' });
    let i = await liderMan.issue(id);
    await liderMan.post(`/api/issues/${id}/assign`, { version: i.version, assigneeId: ctx.users.tecMan.id });
    i = await tecMan.issue(id);
    const incomplete = await tecMan.post(`/api/issues/${id}/complete`, { version: i.version, solution: 'ok', criteriaConfirmed: false });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.detalhes).toHaveLength(2);

    expect((await tecMan.post(`/api/issues/${id}/complete`, { version: i.version, solution: 'Rolamento substituído', criteriaConfirmed: true })).status).toBe(200);
    i = await tecMan.issue(id);
    expect(i.status).toBe('aguardando_validacao');
    expect(i.completed_by).toBe(ctx.users.tecMan.id);
    expect((await notifications(ctx.users.operador.id, 'validacao_solicitada')).some((n: any) => n.issue_id === id)).toBe(true);

    // not counted as concluded while awaiting validation
    const dash = await gestor.get('/api/dashboard');
    const rank1 = await gestor.get('/api/ranking');
    expect(rank1.body.users.find((u: any) => u.user_id === ctx.users.tecMan.id)?.breakdown.issues.some((x: any) => x.issueId === id) ?? false).toBe(false);
    expect(dash.status).toBe(200);

    expect((await tecMan.post(`/api/issues/${id}/validate`, { version: i.version, approved: true })).status).toBe(403);
    expect((await operador.post(`/api/issues/${id}/validate`, { version: i.version, approved: false })).status).toBe(400);
    expect((await operador.post(`/api/issues/${id}/validate`, { version: i.version, approved: false, note: 'Continua travando no turno B' })).status).toBe(200);
    i = await tecMan.issue(id);
    expect(i.status).toBe('em_andamento');
    expect(i.reopen_count).toBe(1);
    expect(i.reopenings[0].kind).toBe('validacao_rejeitada');

    await tecMan.post(`/api/issues/${id}/complete`, { version: i.version, solution: 'Rolamento e eixo substituídos', criteriaConfirmed: true });
    i = await operador.issue(id);
    expect((await operador.post(`/api/issues/${id}/validate`, { version: i.version, approved: true, note: 'Funcionando' })).status).toBe(200);
    i = await operador.issue(id);
    expect(i.status).toBe('concluida');
    expect(i.validated_by).toBe(ctx.users.operador.id);

    // ineffective solution: reopen
    expect((await tecMan.post(`/api/issues/${id}/reopen`, { version: i.version, reason: 'Voltou a travar' })).status).toBe(403);
    expect((await liderMan.post(`/api/issues/${id}/reopen`, { version: i.version, reason: 'Voltou a travar após 2 dias' })).status).toBe(200);
    i = await liderMan.issue(id);
    expect(i.status).toBe('em_andamento');
    expect(i.reopen_count).toBe(2);
    expect(i.validated_at).toBeNull();
    expect(i.reopenings.map((r: any) => r.kind)).toEqual(['validacao_rejeitada', 'solucao_ineficaz']);
  });

  it('evidência obrigatória para prioridade crítica', async () => {
    const id = await newIssue(liderMan, { title: 'Painel elétrico aquecendo', areaId: MAN, priority: 'critica', assigneeId: ctx.users.tecMan.id });
    let i = await tecMan.issue(id);
    expect(i.evidence_required).toBe(true);
    const r = await tecMan.post(`/api/issues/${id}/complete`, { version: i.version, solution: 'Reaperto dos bornes', criteriaConfirmed: true });
    expect(r.status).toBe(422);
    expect(r.body.detalhes.join(' ')).toContain('evidência');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up = await upload(tecMan, id, 'foto.png', png, 'evidencia');
    expect(up.statusCode).toBe(201);
    i = await tecMan.issue(id);
    expect((await tecMan.post(`/api/issues/${id}/complete`, { version: i.version, solution: 'Reaperto dos bornes', criteriaConfirmed: true })).status).toBe(200);
  });
});

async function upload(c: Client, issueId: string, filename: string, data: Buffer, purpose = 'anexo') {
  const boundary = '----frtest' + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return c.app.inject({
    method: 'POST', url: `/api/issues/${issueId}/attachments`, payload: body,
    headers: { cookie: c.cookie, 'x-requested-with': 'fast-response', 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

describe('8. permissões por perfil', () => {
  it('colaborador: sem cancelar, sem usuários, sem configurações, sem auditoria, sem relatórios', async () => {
    const id = await newIssue(operador, { title: 'Teste permissão', areaId: PROD });
    const i = await operador.issue(id);
    expect((await operador.post(`/api/issues/${id}/cancel`, { version: i.version, reason: 'não precisa mais' })).status).toBe(403);
    expect((await operador.get('/api/admin/users')).status).toBe(403);
    expect((await operador.put('/api/admin/settings', { config: {} })).status).toBe(403);
    expect((await operador.get('/api/admin/audit')).status).toBe(403);
    expect((await operador.get('/api/reports')).status).toBe(403);
    expect((await operador.get('/api/dashboard')).status).toBe(200);
    expect((await operador.get('/api/ranking')).status).toBe(200);
  });
  it('líder: atua na própria área; relatórios sim; usuários não', async () => {
    const id = await newIssue(operador, { title: 'Teste líder', areaId: PROD });
    const i = await operador.issue(id);
    expect((await liderMan.post(`/api/issues/${id}/cancel`, { version: i.version, reason: 'duplicada' })).status).toBe(403);
    expect((await liderProd.post(`/api/issues/${id}/cancel`, { version: i.version, reason: 'Duplicada da FR anterior' })).status).toBe(200);
    expect((await liderProd.get('/api/reports')).status).toBe(200);
    expect((await liderProd.get('/api/admin/users')).status).toBe(403);
  });
  it('gestor: todas as áreas, auditoria; não altera configurações; admin altera', async () => {
    expect((await gestor.get('/api/admin/audit')).status).toBe(200);
    expect((await gestor.put('/api/admin/settings', { config: {} })).status).toBe(403);
    const r = await admin.put('/api/admin/settings', { config: { deadline: { days: 2 } } });
    expect(r.status).toBe(200);
    expect(r.body.config.deadline.days).toBe(2);
    expect((await admin.put('/api/admin/settings', { config: { deadline: { time: '25h' } } })).status).toBe(400);
    await admin.put('/api/admin/settings', { config: { deadline: { days: 1 } } });
    invalidateConfig();
  });
  it('admin cria usuário com senha provisória; usuário precisa trocar a senha antes de usar', async () => {
    const r = await admin.post('/api/admin/users', { name: 'Novo Colaborador', email: 'novo@teste.local', role: 'colaborador', areaId: PROD, password: 'Provisoria1' });
    expect(r.status).toBe(201);
    const novo = await new Client(ctx.app).login('novo@teste.local', 'Provisoria1');
    expect((await novo.get('/api/issues')).status).toBe(403);
    expect((await novo.post('/api/auth/change-password', { current: 'Provisoria1', next: 'curta' })).status).toBe(400);
    expect((await novo.post('/api/auth/change-password', { current: 'Provisoria1', next: 'NovaSenha2026' })).status).toBe(200);
    expect((await novo.get('/api/issues')).status).toBe(200);
    // duplicates are rejected
    // temporary password has no rules
    const simples = await admin.post('/api/admin/users', { name: 'Senha Simples', email: 'simples@teste.local', role: 'colaborador', areaId: PROD, password: '123' });
    expect(simples.status).toBe(201);
    expect((await admin.post('/api/admin/users', { name: 'Sem Senha', email: 'semsenha@teste.local', role: 'colaborador', areaId: PROD, password: '' })).status).toBe(400);
    expect((await admin.post(`/api/admin/users/${simples.body.id}/reset-password`, { password: 'a' })).status).toBe(200);
    const simplesLogin = await new Client(ctx.app).login('simples@teste.local', 'a');
    expect((await simplesLogin.post('/api/auth/change-password', { current: 'a', next: 'b' })).status).toBe(400);
    expect((await admin.post('/api/admin/users', { name: 'Dup', email: 'NOVO@teste.local', role: 'gestor', password: 'Provisoria1' })).status).toBe(409);
  });
  it('alteração de prazo pelo colaborador exige aprovação do líder; quem pede não aprova', async () => {
    const id = await newIssue(liderMan, { title: 'Ajuste de prazo', areaId: MAN, assigneeId: ctx.users.tecMan.id });
    const newDue = new Date(Date.now() + 4 * 86400_000);
    const r = await tecMan.post(`/api/issues/${id}/deadline`, { newDueAt: newDue.toISOString(), reason: 'Aguardando peça importada' });
    expect(r.body.approved).toBe(false);
    let i = await tecMan.issue(id);
    expect(new Date(i.due_at).getTime()).not.toBe(newDue.getTime());
    expect(i.pending_deadline_requests).toBe(1);
    const pend = await liderMan.get('/api/deadline-changes');
    const change = pend.body.find((d: any) => d.issue_id === id);
    expect((await tecMan.post(`/api/deadline-changes/${change.id}/decide`, { approve: true })).status).toBe(403);
    expect((await liderMan.post(`/api/deadline-changes/${change.id}/decide`, { approve: true, note: 'ok' })).status).toBe(200);
    i = await tecMan.issue(id);
    expect(new Date(i.due_at).getTime()).toBe(newDue.getTime());
    expect(new Date(i.original_due_at).getTime()).toBeLessThan(newDue.getTime());
    expect(i.deadline_changes[0].status).toBe('aprovada');
  });
});

describe('9. auditoria', () => {
  it('registra operações e o histórico é imutável mesmo no banco', async () => {
    const events = await q<any>('SELECT action FROM audit_events');
    const actions = new Set(events.map((e) => e.action));
    for (const a of ['issue.create', 'issue.assign', 'issue.transfer', 'issue.status', 'issue.complete', 'issue.validate', 'issue.reopen', 'issue.cancel', 'impediment.create', 'deadline.approve', 'step.create', 'settings.update', 'user.create', 'auth.login', 'issue.overdue']) {
      expect(actions.has(a), a).toBe(true);
    }
    await expect(q('UPDATE audit_events SET action = $1', ['x'])).rejects.toThrow(/imutáveis/);
    await expect(q('DELETE FROM audit_events')).rejects.toThrow(/imutáveis/);
    await expect(q('TRUNCATE audit_events')).rejects.toThrow(/imutáveis/);
    await expect(q('DELETE FROM issues')).rejects.toThrow(/imutáveis/);
    await expect(q('DELETE FROM issue_status_history')).rejects.toThrow(/imutáveis/);
    await expect(q("UPDATE issues SET original_due_at = now()")).rejects.toThrow(/prazo original/);
  });
  it('não existe rota para apagar pendências', async () => {
    const id = (await one<any>('SELECT id FROM issues LIMIT 1')).id;
    expect((await admin.req('DELETE', `/api/issues/${id}`)).status).toBe(404);
  });
});

describe('10. ranking mensal', () => {
  it('pontua somente concluídas e validadas, com bônus/penalidades e colaboração em etapas', async () => {
    // Fresh users so the expected totals are exact.
    const r = await admin.post('/api/admin/users', { name: 'Rank A', email: 'ranka@teste.local', role: 'colaborador', areaId: MAN, password: PASSWORD });
    const r2 = await admin.post('/api/admin/users', { name: 'Rank B', email: 'rankb@teste.local', role: 'colaborador', areaId: MAN, password: PASSWORD });
    await q('UPDATE users SET must_change_password = false WHERE id = ANY($1)', [[r.body.id, r2.body.id]]);
    const a = await new Client(ctx.app).login('ranka@teste.local');
    const b = await new Client(ctx.app).login('rankb@teste.local');

    // Issue 1: simple, on time, validated → 10 + 30% = 13
    const i1 = await newIssue(liderMan, { title: 'Rank simples', areaId: MAN, assigneeId: r.body.id });
    let i = await a.issue(i1);
    await a.post(`/api/issues/${i1}/complete`, { version: i.version, solution: 'Feito conforme padrão', criteriaConfirmed: true });
    i = await a.issue(i1);
    await liderMan.post(`/api/issues/${i1}/validate`, { version: i.version, approved: true });

    // Issue 2: moderate (2 steps; one done by B), late → 20 - 40% = 12 ; B gets 3 for the step
    const i2 = await newIssue(liderMan, { title: 'Rank moderada', areaId: MAN, assigneeId: r.body.id, steps: [{ title: 'Etapa 1', assigneeId: r2.body.id }, { title: 'Etapa 2' }] });
    i = await a.issue(i2);
    await b.patch(`/api/steps/${i.steps[0].id}`, { status: 'concluida' });
    await a.patch(`/api/steps/${i.steps[1].id}`, { status: 'concluida' });
    await q(`UPDATE issues SET due_at = now() - interval '1 minute' WHERE id = $1`, [i2]);
    i = await a.issue(i2);
    await a.post(`/api/issues/${i2}/complete`, { version: i.version, solution: 'Feito com atraso', criteriaConfirmed: true });
    i = await a.issue(i2);
    await liderMan.post(`/api/issues/${i2}/validate`, { version: i.version, approved: true });

    // Issue 3: awaiting validation → not counted ; Issue 4: cancelled → not counted
    const i3 = await newIssue(liderMan, { title: 'Rank aguardando', areaId: MAN, assigneeId: r.body.id });
    i = await a.issue(i3);
    await a.post(`/api/issues/${i3}/complete`, { version: i.version, solution: 'Aguardando validação', criteriaConfirmed: true });
    const i4 = await newIssue(liderMan, { title: 'Rank cancelada', areaId: MAN, assigneeId: r.body.id });
    i = await a.issue(i4);
    await liderMan.post(`/api/issues/${i4}/cancel`, { version: i.version, reason: 'Aberta em duplicidade' });

    const rank = await gestor.get('/api/ranking');
    expect(rank.status).toBe(200);
    const ua = rank.body.users.find((u: any) => u.user_id === r.body.id);
    const ub = rank.body.users.find((u: any) => u.user_id === r2.body.id);
    expect(ua.points).toBe(25);
    expect(ua.validated_count).toBe(2);
    expect(ua.on_time_count).toBe(1);
    expect(ua.breakdown.issues.map((x: any) => x.issueId).sort()).toEqual([i1, i2].sort());
    expect(ub.points).toBe(3);
    expect(ub.steps_count).toBe(1);
    expect(rank.body.criteria.base.complexa).toBe(35);
    expect(rank.body.history).toHaveLength(12);
    const stored = await one<any>('SELECT points FROM monthly_scores WHERE user_id = $1', [r.body.id]);
    expect(stored.points).toBe(25);
  });

  it('não é possível fechar o mês corrente', async () => {
    const month = new Date().toISOString().slice(0, 7);
    expect((await gestor.post(`/api/ranking/${month}/finalize`)).status).toBe(422);
    expect((await operador.post(`/api/ranking/2020-01/finalize`)).status).toBe(403);
  });
});

describe('11. acesso simultâneo', () => {
  it('controle de versão impede sobrescrever alteração de outro usuário', async () => {
    const id = await newIssue(liderMan, { title: 'Concorrência', areaId: MAN, assigneeId: ctx.users.tecMan.id });
    const i = await tecMan.issue(id);
    const [r1, r2] = await Promise.all([
      tecMan.patch(`/api/issues/${id}`, { version: i.version, nextAction: 'Trocar sensor' }),
      liderMan.patch(`/api/issues/${id}`, { version: i.version, nextAction: 'Chamar fornecedor' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.codigo).toBe('versao_desatualizada');
  });
  it('aberturas simultâneas geram códigos únicos', async () => {
    const results = await Promise.all(Array.from({ length: 15 }, (_, k) => operador.post('/api/issues', { title: `Simultânea ${k}`, areaId: PROD })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.code)).size).toBe(15);
  });
});

describe('12. persistência', () => {
  it('dados permanecem após reiniciar a aplicação', async () => {
    const id = await newIssue(operador, { title: 'Persistência após reinício', areaId: PROD });
    const app2 = await buildApp();
    const c = await new Client(app2).login(ctx.users.operador.email);
    const i = await c.issue(id);
    expect(i.title).toBe('Persistência após reinício');
    await app2.close();
  });
});

describe('13. falhas e entradas inválidas', () => {
  it('sem login → 401; sem cabeçalho de segurança → 403', async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get('/api/issues')).status).toBe(401);
    const r = await ctx.app.inject({ method: 'POST', url: '/api/issues', payload: { title: 'x', areaId: 1 }, headers: { cookie: operador.cookie } });
    expect(r.statusCode).toBe(403);
  });
  it('bloqueio de conta após tentativas inválidas', async () => {
    const anon = new Client(ctx.app);
    for (let k = 0; k < 5; k++) {
      await anon.post('/api/auth/login', { login: ctx.users.liderProd.email, password: 'errada' });
    }
    const r = await anon.post('/api/auth/login', { login: ctx.users.liderProd.email, password: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.erro).toContain('bloqueada');
    await q('UPDATE users SET locked_until = NULL WHERE id = $1', [ctx.users.liderProd.id]);
  });
  it('rejeita arquivo com tipo não permitido (conteúdo verificado, não a extensão)', async () => {
    const id = await newIssue(operador, { title: 'Upload', areaId: PROD });
    const exe = Buffer.from('4d5a90000300000004000000ffff0000b8000000', 'hex');
    const r = await upload(operador, id, 'foto.png', exe);
    expect(r.statusCode).toBe(400);
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const ok = await upload(operador, id, 'foto.png', png);
    expect(ok.statusCode).toBe(201);
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/attachments/${ok.json()[0].id}`, headers: { cookie: operador.cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(png)).toBe(true);
    expect(dl.headers['content-security-policy']).toContain('sandbox');
  });
  it('id inválido → 400; inexistente → 404; transição inválida → 422 com mensagem clara', async () => {
    expect((await operador.get('/api/issues/abc')).status).toBe(400);
    expect((await operador.get('/api/issues/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    const id = await newIssue(liderMan, { title: 'Transição', areaId: MAN, assigneeId: ctx.users.tecMan.id });
    const i = await tecMan.issue(id);
    const r = await tecMan.post(`/api/issues/${id}/status`, { version: i.version, status: 'concluida' });
    expect(r.status).toBe(422);
    expect(r.body.erro).toContain('Concluir');
  });
});

describe('Fast Response', () => {
  it('reunião registra decisão na pendência existente sem duplicar e aplica responsável e etapa', async () => {
    const before = (await one<any>('SELECT count(*)::int AS n FROM issues')).n;
    const id = await newIssue(operador, { title: 'Ruído no redutor', areaId: MAN });
    const m = await liderMan.post('/api/meetings');
    expect(m.status).toBe(200);
    expect((await operador.post('/api/meetings')).status).toBe(403);
    const again = await gestor.post('/api/meetings');
    expect(again.body.id).toBe(m.body.id); // one open meeting at a time
    const d = await liderMan.post(`/api/meetings/${m.body.id}/decisions`, { issueId: id, decision: 'Manutenção avalia hoje', ownerId: ctx.users.tecMan.id, stepTitle: 'Medir vibração' });
    expect(d.status).toBe(200);
    const i = await liderMan.issue(id);
    expect(i.assignee_id).toBe(ctx.users.tecMan.id);
    expect(i.steps.map((s: any) => s.title)).toEqual(['Medir vibração']);
    expect(i.comments.some((c: any) => c.kind === 'decisao_reuniao')).toBe(true);
    expect((await one<any>('SELECT count(*)::int AS n FROM issues')).n).toBe(before + 1);
    const board = await operador.get('/api/fast-response');
    expect(board.body.meeting.id).toBe(m.body.id);
    expect(board.body.decisions).toHaveLength(1);
    expect(board.body.sections.critical.length).toBeGreaterThan(0);
    // meeting authority: a leader of another area records a decision on a Segurança issue; a collaborator cannot
    const seg = await newIssue(operador, { title: 'Proteção da prensa solta', areaId: SEG });
    expect((await operador.post(`/api/meetings/${m.body.id}/decisions`, { issueId: seg, decision: 'Tentativa sem autoridade' })).status).toBe(403);
    expect((await liderFerr.post(`/api/meetings/${m.body.id}/decisions`, { issueId: seg, decision: 'Segurança isola a área', ownerId: ctx.users.tecMan.id })).status).toBe(200);
    expect((await liderMan.issue(seg)).assignee_id).toBe(ctx.users.tecMan.id);
    const actor = await one<any>("SELECT actor_id FROM audit_events WHERE issue_id = $1 AND action LIKE 'issue.assign%' ORDER BY id DESC LIMIT 1", [seg]);
    expect(actor?.actor_id).toBe(ctx.users.liderFerr.id);
    expect((await liderMan.post(`/api/meetings/${m.body.id}/end`, { notes: 'Reunião ok' })).status).toBe(200);
  });

  it('detecta reincidência (mesmo ativo e categoria) e sugere pendências semelhantes', async () => {
    const cat = (await one<any>("SELECT id FROM categories WHERE name = 'Quebra / falha de máquina'")).id;
    const first = await newIssue(liderMan, { title: 'Bomba hidráulica falhando', areaId: MAN, assigneeId: ctx.users.tecMan.id, categoryId: cat, assetRef: 'INJ-09', assetType: 'maquina' });
    let i = await tecMan.issue(first);
    await tecMan.post(`/api/issues/${first}/complete`, { version: i.version, solution: 'Troca do selo da bomba', criteriaConfirmed: true });
    i = await tecMan.issue(first);
    await liderMan.post(`/api/issues/${first}/validate`, { version: i.version, approved: true });
    const second = await newIssue(operador, { title: 'Bomba hidráulica sem pressão', areaId: MAN, categoryId: cat, assetRef: 'inj-09', assetType: 'maquina' });
    const s = await operador.issue(second);
    expect(s.recurrence_of_id).toBe(first);
    expect((await operador.get('/api/issues?flag=recurrent')).body.items.some((x: any) => x.id === second)).toBe(true);
    const sim = await operador.get(`/api/issues/similar?title=${encodeURIComponent('bomba hidráulica')}&assetRef=INJ-09`);
    expect(sim.body.some((x: any) => x.id === second)).toBe(true);
  });
});

describe('relatórios', () => {
  it('indicadores com média, mediana, tempo em status e exportação CSV', async () => {
    const r = await gestor.get('/api/reports');
    expect(r.status).toBe(200);
    expect(r.body.resolution.count).toBeGreaterThan(0);
    expect(r.body.resolution.median_hours).not.toBeNull();
    expect(r.body.statusTime.length).toBeGreaterThan(0);
    expect(r.body.areas).toHaveLength(7);
    const csv = await gestor.get('/api/reports/export.csv?table=areas');
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('Manutenção');
    const d = await gestor.get(`/api/dashboard?areaId=${MAN}`);
    expect(d.body.kpi.open).toBeGreaterThan(0);
    expect(d.body.weekly).toHaveLength(12);
  });
});

afterAll(async () => {
  await pool.end().catch(() => {});
});
