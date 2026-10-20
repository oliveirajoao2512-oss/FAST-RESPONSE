# Testes

## 1. Automatizados

### Servidor (unitários + integração) — 57 testes

```bash
createdb fastresponse_test          # uma vez; o nome precisa conter "test" (o banco é recriado a cada execução)
npm test
```

Para outro banco: `DATABASE_URL=postgresql://…/fastresponse_test npm test`.
Os testes de integração sobem a API real contra PostgreSQL real (sem mocks), com 8 usuários de perfis diferentes.

### Navegador (Playwright) — 4 cenários

```bash
scripts/e2e-local.sh                # cria o banco descartável fastresponse_e2e, sobe a aplicação na porta 3100 e executa
```

Requer o Chromium do Playwright (`npx playwright install chromium`) ou `CHROMIUM_PATH` apontando para um Chrome.
Capturas de tela ficam em `test-results/screens/`.

### Cobertura dos critérios de aceite

| # | Critério | Automatizado |
|---|---|---|
| 1 | Cadastro, atribuição e notificação | integração §1 + navegador (2 usuários simultâneos) |
| 2 | Vencimento D+1 calculado no servidor; prazo justificado | unitários (prazos, fins de semana, fuso) + integração §2 |
| 3 | Atrasada automática, notificação e escalonamento | integração §3 (processo automático real) |
| 4 | Etapas, dependências, progresso, complexidade | integração §4 + navegador (modelo de etapas) |
| 5 | Transferência mantendo área de origem | integração §5 |
| 6 | Impedimento e retomada | integração §6 + navegador |
| 7 | Validação, rejeição, reabertura, evidência obrigatória | integração §7 + navegador |
| 8 | Permissões por perfil | integração §8 + navegador (botões ocultos para colaborador) |
| 9 | Auditoria imutável (inclusive no banco) | integração §9 |
| 10 | Ranking somente com concluídas validadas, regras antimanipulação | unitários (pontuação) + integração §10 + navegador |
| 11 | Acesso simultâneo sem sobrescrita | integração §11 + navegador (atualização em tempo real) |
| 12 | Persistência após reinício | integração §12 + navegador (recarregar página) |
| 13 | Falhas e entradas inválidas | integração §13 + navegador (modo offline) |
| 14 | Responsividade | navegador (tablet 820 px e celular 390 px, sem rolagem horizontal) |
| — | Fast Response, reincidência, relatórios/CSV | integração + navegador |

## 2. Roteiro de teste manual (homologação)

Prepare: 1 admin, 1 gestor, líderes de Manutenção, Ferramentaria e Segurança, 1 técnico de Manutenção e
1 operador de Produção. Use dois navegadores (ou uma janela anônima) para ver duas pessoas ao mesmo tempo.

| # | Passo | Resultado esperado |
|---|---|---|
| 1 | Admin entra com a senha inicial | Sistema exige troca de senha antes de qualquer tela |
| 2 | Admin cria os usuários | Cada um recebe senha provisória e precisa trocá-la no 1º acesso |
| 3 | Operador abre pendência em Manutenção, sem responsável (tecla **N**) | Código FR-AAAA-NNNNN; status “Aguardando responsável”; prazo amanhã 23:59 |
| 4 | Com a tela do líder de Manutenção aberta | A pendência aparece sozinha (sem recarregar) e o sino mostra notificação |
| 5 | Líder atribui ao técnico | Técnico é notificado; histórico registra a atribuição |
| 6 | Técnico tenta mudar o prazo | Só consegue solicitar; o líder vê em **Aprovações** e aprova/rejeita |
| 7 | Técnico aplica o modelo “Manutenção de molde” | 7 etapas, progresso 0%, complexidade passa a “complexa” |
| 8 | Técnico tenta iniciar etapa dependente | Bloqueado até a etapa anterior ser concluída |
| 9 | Técnico registra impedimento para Ferramentaria | Status “Bloqueada”; líder de Ferramentaria notificado. Ao resolver, volta ao status anterior |
| 10 | Técnico tenta concluir com etapas pendentes | Mensagem clara listando o que falta |
| 11 | Conclui etapas e a pendência, com solução | Vai para “Aguardando validação”; o técnico não vê botão de validar |
| 12 | Líder rejeita a validação | Volta para “Em andamento” com o motivo no histórico |
| 13 | Técnico conclui de novo; operador (quem abriu) valida | “Concluída”; aparece no ranking do técnico com o detalhamento dos pontos |
| 14 | Líder reabre por solução ineficaz | Pontuação do técnico recebe −15 no ranking |
| 15 | Operador abre “prioridade crítica” em Segurança | Prazo = agora + 4 h; líderes de Segurança e gestores notificados na hora |
| 16 | Líder abre uma pendência com prazo específico daqui a 5 min (justificando) e aguarda | Pendência mostra ATRASADA, responsável e líder notificados; após 24 h, gestores |
| 17 | Líder transfere a pendência para Ferramentaria | Continua aparecendo na página de Manutenção (origem) e agora na de Ferramentaria |
| 18 | Abra a mesma pendência em dois navegadores e salve nos dois | O segundo recebe aviso de que a pendência foi alterada e precisa recarregar |
| 19 | **Fast Response:** líder inicia a reunião e registra decisão com novo responsável | Decisão aparece na pendência existente; nenhuma pendência nova é criada |
| 20 | Painel: clique em cada indicador | Abre a lista exata correspondente; filtros funcionam por área, responsável, prioridade, status e datas |
| 21 | Relatórios: exporte o CSV e abra no Excel | Acentos corretos, colunas separadas por ponto e vírgula |
| 22 | Admin → Auditoria | Todas as ações acima listadas com usuário, data e IP; não há opção de editar ou apagar |
| 23 | Desligue a rede do navegador e tente salvar | Aviso de conexão; ao religar, sincroniza sozinho |
| 24 | Repita 3, 5 e 11 em celular e tablet | Telas utilizáveis, sem rolagem horizontal; lista vira cartões no celular |
| 25 | Reinicie o servidor (`docker compose restart app`) | Todos os dados permanecem |
| 26 | Com SMTP configurado, repita 5 | O técnico recebe também o e-mail, com link para a pendência |
