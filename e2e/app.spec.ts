import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * End-to-end flow against a FRESH database whose only user is the bootstrap admin
 * (ADMIN_EMAIL=admin@e2e.local / ADMIN_PASSWORD=Admin12345).
 */
const ADMIN = { login: 'admin@e2e.local', password: 'Admin12345', newPassword: 'AdminNova2026' };
const PW = 'Senha12345';
const SHOTS = process.env.SHOTS_DIR ?? 'test-results/screens';
const H = { 'x-requested-with': 'fast-response' };

test.describe.configure({ mode: 'serial' });

let adminApi: APIRequestContext;
const users: Record<string, { email: string; id?: string }> = {
  lider: { email: 'lider.man@e2e.local' },
  tecnico: { email: 'tecnico.man@e2e.local' },
  operador: { email: 'operador.prod@e2e.local' },
  manutentor: { email: 'joao.manutentor@e2e.local' },
  liderProc: { email: 'lider.proc@e2e.local' },
  tecProc: { email: 'ana.processo@e2e.local' },
};

async function login(page: Page, email: string, password = PW) {
  await page.goto('/');
  await page.getByLabel('E-mail ou matrícula').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

async function closeIssue(page: Page) {
  await page.getByRole('dialog', { name: 'Pendência' }).getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByRole('dialog', { name: 'Pendência' })).toHaveCount(0);
}

async function newUserPage(browser: Browser, email: string, viewport = { width: 1366, height: 860 }) {
  const ctx = await browser.newContext({ viewport, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  await login(page, email);
  await expect(page.getByRole('heading', { name: 'Painel geral' })).toBeVisible();
  return page;
}

test('1. primeiro acesso do administrador exige troca de senha', async ({ page, playwright }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await expect(page.getByRole('heading', { name: 'Defina sua senha' })).toBeVisible();
  await page.getByLabel('Senha atual').fill(ADMIN.password);
  await page.getByLabel('Nova senha', { exact: true }).fill(ADMIN.newPassword);
  await page.getByLabel('Confirme a nova senha').fill(ADMIN.newPassword);
  await page.getByRole('button', { name: 'Salvar senha' }).click();
  await expect(page.getByRole('heading', { name: 'Painel geral' })).toBeVisible();

  // set up the team through the admin API (same rules as the Users screen)
  adminApi = await playwright.request.newContext({ baseURL: page.url().replace(/\/$/, ''), extraHTTPHeaders: H });
  await adminApi.post('/api/auth/login', { data: { login: ADMIN.login, password: ADMIN.newPassword } });
  const meta = await (await adminApi.get('/api/meta')).json();
  const area = (slug: string) => meta.areas.find((a: any) => a.slug === slug).id;
  const mk = async (key: string, name: string, role: string, slug: string) => {
    const r = await adminApi.post('/api/admin/users', { data: { name, email: users[key].email, role, areaId: area(slug), password: 'Provisoria1' } });
    expect(r.status()).toBe(201);
    users[key].id = (await r.json()).id;
  };
  await mk('lider', 'Lider Manutencao', 'lider', 'manutencao');
  await mk('tecnico', 'Tecnico Manutencao', 'colaborador', 'manutencao');
  await mk('operador', 'Operador Producao', 'colaborador', 'producao');
  await mk('manutentor', 'Joao Manutentor', 'manutentor', 'manutencao');
  await mk('liderProc', 'Lider Processos', 'lider', 'processos');
  await mk('tecProc', 'Ana Tecnica', 'tecnico_processo', 'processos');
  for (const k of Object.keys(users)) {
    const c = await playwright.request.newContext({ baseURL: page.url().replace(/\/$/, ''), extraHTTPHeaders: H });
    await c.post('/api/auth/login', { data: { login: users[k].email, password: 'Provisoria1' } });
    expect((await c.post('/api/auth/change-password', { data: { current: 'Provisoria1', next: PW } })).status()).toBe(200);
  }
});

test('2-12. fluxo completo entre usuários simultâneos', async ({ browser }) => {
  test.setTimeout(240_000);
  const operador = await newUserPage(browser, users.operador.email);
  const lider = await newUserPage(browser, users.lider.email);
  const tecnico = await newUserPage(browser, users.tecnico.email);

  // líder deixa a página da área aberta (para verificar sincronização sem recarregar)
  await lider.getByRole('link', { name: 'Pendências', exact: true }).click();
  await lider.getByRole('tab', { name: 'Por área' }).click();
  await lider.getByRole('link', { name: /^Manutenção/ }).click();
  await expect(lider.getByRole('heading', { name: 'Manutenção' })).toBeVisible();

  // --- cadastro rápido pelo operador
  await operador.getByRole('button', { name: 'Nova pendência' }).click();
  const dlg = operador.getByRole('dialog', { name: 'Nova pendência' });
  await dlg.getByRole('button', { name: 'Registrar pendência' }).click();
  await expect(dlg.getByText('Informe o título do problema.')).toBeVisible();
  await dlg.getByLabel('Título do problema').fill('Falha no molde da injetora 07');
  await dlg.getByLabel('Área responsável').selectOption({ label: 'Manutenção' });
  await dlg.getByRole('radio', { name: 'Alta' }).click();
  await dlg.getByLabel('Tipo de referência').selectOption('molde');
  await dlg.getByLabel('Máquina, molde, item ou OP').fill('M-07');
  await expect(dlg.getByText(/Prazo automático: Amanhã às 23:59/)).toBeVisible();
  await dlg.getByRole('button', { name: 'Registrar pendência' }).click();
  await expect(operador.getByText(/Pendência FR-\d{4}-\d{5} registrada/)).toBeVisible();
  const detail = operador.getByRole('dialog', { name: 'Pendência' });
  await expect(detail.getByRole('heading', { name: 'Falha no molde da injetora 07' })).toBeVisible();
  await expect(detail.getByText('Aguardando responsável').first()).toBeVisible();
  const code = (await detail.locator('span.font-mono').first().textContent())!.trim();
  await operador.screenshot({ path: `${SHOTS}/desktop-detalhe-nova.png` });

  // --- sincronização: aparece para o líder sem recarregar
  await expect(lider.getByText('Falha no molde da injetora 07').first()).toBeVisible({ timeout: 10_000 });
  await lider.screenshot({ path: `${SHOTS}/desktop-area-kanban.png` });

  // --- líder atribui ao técnico
  await lider.getByText('Falha no molde da injetora 07').first().click();
  const ld = lider.getByRole('dialog', { name: 'Pendência' });
  await ld.getByRole('button', { name: 'Responsável' }).click();
  const assign = lider.getByRole('dialog', { name: /Responsável — / });
  await assign.getByLabel('Responsável pela execução').selectOption({ label: 'Tecnico Manutencao' });
  await assign.getByRole('button', { name: 'Salvar' }).click();
  await expect(lider.getByText('Responsável atualizado')).toBeVisible();
  await expect(ld.getByText('Aberta', { exact: true }).first()).toBeVisible();

  // --- técnico recebe notificação e trabalha com etapas
  await expect(tecnico.getByRole('button', { name: /Notificações \([1-9]/ })).toBeVisible({ timeout: 10_000 });
  await tecnico.getByRole('button', { name: /Notificações/ }).click();
  await tecnico.getByText(`${code} atribuída a você`).click();
  const td = tecnico.getByRole('dialog', { name: 'Pendência' });
  await td.getByLabel('Aplicar modelo de etapas').selectOption('Manutenção de molde');
  await expect(tecnico.getByText('Modelo "Manutenção de molde" aplicado')).toBeVisible();
  await expect(td.getByText('Diagnosticar o problema')).toBeVisible();
  await expect(td.getByText('Complexa', { exact: true })).toBeVisible();

  // tentar concluir sem as etapas: servidor recusa e explica
  await td.getByRole('button', { name: 'Concluir' }).click();
  let complete = tecnico.getByRole('dialog', { name: `Concluir ${code}` });
  await expect(complete.getByText(/etapa\(s\) obrigatória\(s\) pendente/)).toBeVisible();
  await complete.getByRole('button', { name: 'Voltar' }).click();

  // impedimento e retomada
  await td.getByRole('button', { name: 'Impedimento' }).click();
  const blk = tecnico.getByRole('dialog', { name: /Registrar impedimento/ });
  await blk.getByLabel('O que está impedindo a execução?').fill('Aguardando pino extrator do almoxarifado');
  await blk.getByLabel('Depende de outra área?').selectOption({ label: 'Logística' });
  await blk.getByRole('button', { name: 'Registrar impedimento' }).click();
  await expect(td.getByText('Bloqueada').first()).toBeVisible();
  tecnico.once('dialog', (d) => d.accept('Pino entregue pela logística'));
  await td.getByRole('button', { name: 'Resolver' }).click();
  await expect(tecnico.getByText('Impedimento resolvido')).toBeVisible();

  // concluir todas as etapas
  const selects = td.getByLabel(/Status da etapa/);
  const n = await selects.count();
  expect(n).toBe(7);
  for (let k = 0; k < n; k++) {
    await td.getByLabel(/Status da etapa/).nth(k).selectOption('concluida');
    await expect(td.locator('[role=progressbar]').first()).toHaveAttribute('aria-valuenow', String(Math.round(((k + 1) / n) * 100)), { timeout: 10_000 });
  }
  await tecnico.screenshot({ path: `${SHOTS}/desktop-etapas.png` });

  await td.getByRole('button', { name: 'Concluir' }).click();
  complete = tecnico.getByRole('dialog', { name: `Concluir ${code}` });
  await complete.getByLabel('Solução aplicada').fill('Substituído pino extrator e ajustada a refrigeração do molde');
  await complete.getByRole('button', { name: 'Enviar para validação' }).click();
  await expect(complete.getByText('Confirme que o critério de conclusão foi atendido.').last()).toBeVisible();
  await complete.getByRole('checkbox').check();
  await complete.getByRole('button', { name: 'Enviar para validação' }).click();
  await expect(td.getByText('Aguardando validação').first()).toBeVisible();
  await expect(td.getByRole('button', { name: 'Validar' })).toHaveCount(0); // quem concluiu não valida

  // --- operador (quem abriu) valida pela tela de aprovações
  await closeIssue(operador);
  await operador.getByRole('link', { name: 'Pendências', exact: true }).click();
  await operador.getByRole('tab', { name: 'Aprovações' }).click();
  await expect(operador.getByText('Falha no molde da injetora 07')).toBeVisible({ timeout: 10_000 });
  await operador.getByRole('button', { name: 'Validar' }).click();
  await operador.getByRole('dialog', { name: /Validar solução/ }).getByRole('button', { name: 'Aprovar' }).click();
  await expect(operador.getByText(`${code} validada e concluída`)).toBeVisible();

  // --- persistência após recarregar
  await closeIssue(lider);
  await lider.reload();
  await lider.getByRole('button', { name: 'Concluídas' }).first().click();
  await expect(lider.getByText('Falha no molde da injetora 07').first()).toBeVisible();

  // --- ranking reflete a conclusão validada
  await closeIssue(tecnico);
  await tecnico.getByRole('link', { name: 'Indicadores' }).click();
  await expect(tecnico.getByText('Como a pontuação é calculada')).toBeVisible();
  await expect(tecnico.getByRole('cell', { name: /Tecnico Manutencao/ })).toBeVisible();
  await tecnico.screenshot({ path: `${SHOTS}/desktop-ranking.png`, fullPage: true });

  // --- Fast Response: reunião e decisão sem duplicar
  await operador.getByRole('button', { name: 'Nova pendência' }).click();
  const d2 = operador.getByRole('dialog', { name: 'Nova pendência' });
  await d2.getByLabel('Título do problema').fill('Piso escorregadio próximo à prensa 3');
  await d2.getByLabel('Área responsável').selectOption({ label: 'Segurança' });
  await d2.getByRole('radio', { name: 'Crítica' }).click();
  await expect(d2.getByText(/Imediato: 4 h após a abertura/)).toBeVisible();
  await d2.getByRole('button', { name: 'Registrar pendência' }).click();
  await expect(operador.getByText('Segurança crítica — tratamento imediato')).toBeVisible();

  await lider.getByRole('link', { name: 'Fast Response' }).click();
  await lider.getByRole('button', { name: 'Iniciar reunião' }).click();
  await expect(lider.getByText('Reunião em andamento')).toBeVisible();
  const critical = lider.locator('section', { hasText: 'Críticas e segurança' });
  await expect(critical.getByText('Piso escorregadio próximo à prensa 3')).toBeVisible();
  await critical.getByRole('button', { name: 'Decisão' }).first().click();
  const dec = lider.getByRole('dialog', { name: /Decisão da reunião/ });
  await dec.getByLabel('Decisão / encaminhamento').fill('Isolar a área e aplicar piso antiderrapante hoje');
  await dec.getByLabel('Próxima ação').fill('Isolar a área com fita zebrada');
  await dec.getByRole('button', { name: 'Registrar decisão' }).click();
  await expect(lider.getByText('Decisão registrada na pendência')).toBeVisible();
  await expect(lider.getByText('Decisões desta reunião (1)')).toBeVisible();
  await lider.screenshot({ path: `${SHOTS}/desktop-fast-response.png`, fullPage: true });

  // --- dashboard com drill-down
  await lider.getByRole('link', { name: 'Painel geral' }).click();
  await lider.getByRole('button', { name: /Críticas/ }).click();
  await expect(lider.getByRole('dialog', { name: /Críticas \/ segurança/ }).getByText('Piso escorregadio próximo à prensa 3').first()).toBeVisible();
  await lider.getByRole('dialog', { name: /Críticas \/ segurança/ }).getByRole('button', { name: 'Fechar' }).click();
  await lider.screenshot({ path: `${SHOTS}/desktop-dashboard.png`, fullPage: true });

  // --- falha de comunicação
  await lider.context().setOffline(true);
  await expect(lider.getByText(/Sem conexão|Reconectando/)).toBeVisible({ timeout: 15_000 });
  await lider.getByRole('button', { name: 'Nova pendência' }).click();
  const d3 = lider.getByRole('dialog', { name: 'Nova pendência' });
  await d3.getByLabel('Título do problema').fill('Teste sem rede');
  await d3.getByRole('button', { name: 'Registrar pendência' }).click();
  await expect(d3.getByText(/Sem conexão com o servidor/)).toBeVisible();
  await lider.context().setOffline(false);
  await d3.getByRole('button', { name: 'Registrar pendência' }).click();
  await expect(lider.getByText(/Pendência FR-\d{4}-\d{5} registrada/)).toBeVisible();
  await expect(lider.getByText(/Sem conexão|Reconectando/)).toHaveCount(0, { timeout: 15_000 });

  // --- permissões na interface
  await expect(operador.getByRole('link', { name: 'Administração' })).toHaveCount(0);
  await closeIssue(lider);
  await lider.getByRole('link', { name: 'Indicadores' }).click();
  await lider.getByRole('tab', { name: 'Relatórios' }).click();
  await expect(lider.getByRole('heading', { name: 'Indicadores gerenciais' })).toBeVisible();
  await expect(lider.getByText('Comparativo entre áreas')).toBeVisible();
});

for (const [name, viewport] of [['tablet', { width: 820, height: 1180 }], ['celular', { width: 390, height: 844 }]] as const) {
  test(`14. responsividade — ${name}`, async ({ browser }) => {
    const page = await newUserPage(browser, users.lider.email, viewport);
    const noHorizontalScroll = async () => {
      const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(sw).toBeLessThanOrEqual(iw);
    };
    await noHorizontalScroll();
    await page.screenshot({ path: `${SHOTS}/${name}-dashboard.png`, fullPage: true });
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await page.getByRole('link', { name: 'Pendências', exact: true }).click();
    await page.getByRole('tab', { name: 'Por área' }).click();
    await page.getByRole('link', { name: /^Manutenção/ }).click();
    await expect(page.getByRole('heading', { name: 'Manutenção' })).toBeVisible();
    await noHorizontalScroll();
    await page.screenshot({ path: `${SHOTS}/${name}-area.png` });
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await page.getByRole('link', { name: 'Fast Response' }).click();
    await expect(page.getByRole('heading', { name: 'Fast Response diário' })).toBeVisible();
    await noHorizontalScroll();
    await page.screenshot({ path: `${SHOTS}/${name}-fast-response.png`, fullPage: true });
    await page.getByText('Piso escorregadio próximo à prensa 3').first().click();
    await expect(page.getByRole('dialog', { name: 'Pendência' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${name}-detalhe.png` });
    await page.getByRole('dialog', { name: 'Pendência' }).getByText('Isolar a área com fita zebrada').first().waitFor();
    await closeIssue(page);
    await page.getByRole('button', { name: 'Nova pendência' }).click();
    await expect(page.getByRole('dialog', { name: 'Nova pendência' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${name}-nova.png` });
  });
}

test('15. ordem de manutenção: abrir, aceitar, acompanhar e finalizar', async ({ browser }) => {
  const operador = await newUserPage(browser, users.operador.email);
  // the maintainer lands straight on the work orders, on a phone
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const man = await mctx.newPage();
  await login(man, users.manutentor.email);
  await expect(man.getByRole('heading', { name: 'Ordens de Manutenção' })).toBeVisible();
  await expect(man.getByRole('link', { name: 'Pendências', exact: true })).toHaveCount(0);
  await man.goto('/pendencias');
  await expect(man).toHaveURL(/\/os$/);

  // anyone opens an order in a few taps
  await operador.getByRole('link', { name: 'Ordens de Manutenção' }).click();
  await operador.getByRole('button', { name: 'Abrir OS' }).click();
  const dlg = operador.getByRole('dialog', { name: 'Abrir ordem de manutenção' });
  await dlg.getByLabel('Setor').selectOption({ label: 'Produção' });
  await dlg.getByRole('radio', { name: 'Máquina', exact: true }).click();
  await dlg.getByRole('radio', { name: '17A', exact: true }).click();
  await dlg.getByRole('radio', { name: 'Mecânica' }).click();
  await dlg.getByRole('radio', { name: 'Sim, parada' }).click();
  await dlg.getByLabel('O que está acontecendo e onde é o problema?').fill('Vazamento de óleo no cilindro do molde');
  await operador.screenshot({ path: `${SHOTS}/os-abrir.png` });
  await dlg.getByRole('button', { name: 'Abrir OS' }).click();
  await expect(operador.getByText(/OS-\d{4}-\d{5} aberta como crítica/)).toBeVisible();
  // evidence of the opening: a PDF is available right away
  await expect(operador.getByRole('dialog', { name: /OS-\d{4}-\d{5} · 17A/ }).getByRole('button', { name: 'Comprovante (PDF)' })).toBeVisible();
  const detail = operador.getByRole('dialog', { name: /OS-\d{4}-\d{5} · 17A/ });
  await expect(detail.getByText(/Aguardando aceite/).first()).toBeVisible();

  // the maintainer sees it at once (critical, first in the queue) and accepts
  await expect(man.getByText('Vazamento de óleo no cilindro do molde')).toBeVisible({ timeout: 10_000 });
  await expect(man.getByText('MÁQUINA PARADA')).toBeVisible();
  await man.screenshot({ path: `${SHOTS}/os-fila-celular.png`, fullPage: true });
  await man.getByRole('button', { name: 'Aceitar', exact: true }).click();

  // the requester sees who is working, without reloading
  await expect(detail.getByText('Joao Manutentor está atuando')).toBeVisible({ timeout: 10_000 });
  await operador.screenshot({ path: `${SHOTS}/os-detalhe-solicitante.png` });

  // pause and finish on the phone
  await man.getByText('Vazamento de óleo no cilindro do molde').click();
  const md = man.getByRole('dialog', { name: /OS-\d{4}-\d{5} · 17A/ });
  await md.getByRole('button', { name: 'Pausar' }).click();
  await man.getByRole('dialog', { name: 'Pausar OS' }).getByRole('button', { name: 'Pausar' }).click();
  await expect(md.getByText('Pausada: Aguardando peça')).toBeVisible();
  await md.getByRole('button', { name: 'Retomar' }).click();
  await expect(md.getByText('Pausada: Aguardando peça')).toHaveCount(0);
  await man.screenshot({ path: `${SHOTS}/os-detalhe-celular.png`, fullPage: true });
  await md.getByRole('button', { name: 'Finalizar' }).click();
  const fin = man.getByRole('dialog', { name: /Finalizar OS-/ });
  await fin.getByLabel('O que foi feito?').fill('Troca do retentor do cilindro');
  await fin.getByRole('button', { name: 'Finalizar' }).click();
  await expect(man.getByText(/finalizada\. Quem abriu foi avisado/)).toBeVisible();

  await expect(detail.getByText('Troca do retentor do cilindro')).toBeVisible({ timeout: 10_000 });
  await expect(detail.getByText(/Joao Manutentor finalizou a ordem/)).toBeVisible();
  const pdfHref = await detail.getByRole('link', { name: 'Comprovante (PDF)' }).getAttribute('href');
  const pdf = await operador.request.get(pdfHref!);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await detail.getByRole('button', { name: 'Fechar' }).click();
  await operador.getByRole('tab', { name: 'Finalizadas' }).click();
  await expect(operador.getByText('Troca do retentor do cilindro')).toBeVisible();
  await operador.screenshot({ path: `${SHOTS}/os-finalizadas.png` });

  // the dashboard is only for the maintenance leadership
  await expect(operador.getByRole('tab', { name: 'Dashboard' })).toHaveCount(0);
  const lider = await newUserPage(browser, users.lider.email);
  await expect(lider.getByRole('link', { name: 'Painel da planta' })).toHaveCount(0);
  await lider.goto('/os?tab=dashboard');
  await expect(lider.getByText('Máquinas com mais horas paradas')).toBeVisible();
  await expect(lider.getByRole('button', { name: /17A/ }).first()).toBeVisible();
  await expect(lider.getByRole('cell', { name: /17A/ })).toBeVisible();
  await lider.screenshot({ path: `${SHOTS}/os-dashboard.png`, fullPage: true });
});

test('17. ordem de ajuste: processista atende e só Processos vê o dashboard', async ({ browser }) => {
  const operador = await newUserPage(browser, users.operador.email);
  const tctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const tec = await tctx.newPage();
  await login(tec, users.tecProc.email);
  await expect(tec.getByRole('heading', { name: 'Ordens de Ajuste' })).toBeVisible();
  await expect(tec).toHaveURL(/\/ajustes$/);
  await tec.goto('/os');
  await expect(tec).toHaveURL(/\/ajustes$/);

  await operador.getByRole('link', { name: 'Ordens de Ajuste' }).click();
  await operador.getByRole('button', { name: 'Abrir OA' }).click();
  const dlg = operador.getByRole('dialog', { name: 'Abrir ordem de ajuste' });
  await dlg.getByLabel('Setor').selectOption({ label: 'Produção' });
  // adjustments happen only on machines: the machine list opens straight away
  await expect(dlg.getByRole('radio', { name: 'Montagem' })).toHaveCount(0);
  await dlg.getByRole('radio', { name: '5', exact: true }).click();
  await dlg.getByRole('radio', { name: /Ajuste devido a % incorreta de material/ }).click();
  await dlg.getByLabel('% de material virgem').fill('70');
  await dlg.getByLabel('% de moído').fill('30');
  await dlg.getByLabel('Part number').fill('PN-4471');
  await dlg.getByRole('radio', { name: 'Sim, parada' }).click();
  await dlg.getByLabel('Motivo / problema da parada').fill('Frasco com parede fina');
  await operador.screenshot({ path: `${SHOTS}/oa-abrir.png` });
  await dlg.getByRole('button', { name: 'Abrir OA' }).click();
  const detail = operador.getByRole('dialog', { name: /OA-\d{4}-\d{5} · 5/ });
  await expect(detail.getByText('70%')).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Comprovante (PDF)' })).toBeVisible();

  await expect(tec.getByText('Frasco com parede fina')).toBeVisible({ timeout: 10_000 });
  await tec.getByRole('button', { name: 'Aceitar', exact: true }).click();
  await expect(detail.getByText('Ana Tecnica está atuando')).toBeVisible({ timeout: 10_000 });
  await tec.getByText('Frasco com parede fina').click();
  const td = tec.getByRole('dialog', { name: /OA-\d{4}-\d{5} · 5/ });
  await td.getByRole('button', { name: 'Finalizar' }).click();
  const fin = tec.getByRole('dialog', { name: /Finalizar OA-/ });
  await fin.getByLabel('Ação tomada').fill('Corrigida a dosagem de moído');
  await fin.getByRole('button', { name: 'Finalizar' }).click();
  await expect(detail.getByText('Corrigida a dosagem de moído')).toBeVisible({ timeout: 10_000 });

  // the maintenance leader does not see the adjustment dashboard; the process leader does
  const liderMan = await newUserPage(browser, users.lider.email);
  await liderMan.goto('/ajustes?tab=dashboard');
  await expect(liderMan.getByRole('tab', { name: 'Dashboard' })).toHaveCount(0);
  const liderProc = await newUserPage(browser, users.liderProc.email);
  await liderProc.goto('/ajustes?tab=dashboard');
  await expect(liderProc.getByText('Motivos mais frequentes')).toBeVisible();
  await expect(liderProc.getByRole('button', { name: /21\. Ajuste devido/ })).toBeVisible();
  await expect(liderProc.getByRole('cell', { name: 'Corrigida a dosagem de moído' })).toBeVisible();
  await liderProc.screenshot({ path: `${SHOTS}/oa-dashboard.png`, fullPage: true });
});

test('16. administrador visualiza como outro perfil (somente leitura)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  await login(page, ADMIN.login, ADMIN.newPassword);
  await expect(page.getByRole('heading', { name: 'Painel geral' })).toBeVisible();
  await page.getByRole('button', { name: 'Menu do usuário' }).click();
  await page.getByRole('button', { name: 'Visualizar como…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Visualizar como outro perfil' });
  await dlg.getByRole('radio', { name: 'Manutentor' }).click();
  await page.screenshot({ path: `${SHOTS}/visualizar-como.png` });
  await dlg.getByRole('button', { name: 'Visualizar' }).click();
  await expect(page.getByText(/Visualizando como/)).toContainText('Manutentor');
  await expect(page.getByRole('heading', { name: 'Ordens de Manutenção' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pendências', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/visualizar-como-manutentor.png` });
  await page.getByRole('button', { name: 'Sair da visualização' }).click();
  await expect(page.getByRole('heading', { name: 'Painel geral' })).toBeVisible();
  await expect(page.getByText(/Visualizando como/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Pendências', exact: true })).toBeVisible();

  // plant panel (Power BI style): administrator and plant manager only
  await page.getByRole('link', { name: 'Indicadores' }).click();
  await expect(page.getByRole('tab', { name: 'Painel da planta' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Dias sem máquina parada')).toBeVisible();
  await page.getByRole('button', { name: 'Processos', exact: true }).click();
  await expect(page.getByText('Motivos - todos')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/painel-planta.png` });
});
