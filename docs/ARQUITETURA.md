# Arquitetura e decisões

## Visão geral

```
navegador (React SPA) ──HTTPS──► Fastify (API + arquivos da SPA) ──► PostgreSQL 16
        ▲                              │  processos automáticos (60 s)       │
        └──── SSE /api/events ◄────────┴──── LISTEN/NOTIFY ◄──────────────────┘
                                       └──► SMTP corporativo (fila com reenvio)
```

```
shared/   regras puras usadas por servidor e interface: status, permissões, prazos, fluxo, pontuação
server/   API Fastify, serviços de negócio, migrações SQL, processos automáticos, CLI
web/      interface React (Vite + Tailwind)
e2e/      testes de navegador (Playwright)
```

## Decisões

**PostgreSQL relacional em vez de banco de documentos.** O domínio é fortemente relacional (pendências, etapas,
dependências, transferências, validações, ranking por mês) e precisa de transações, restrições e gatilhos.
A imutabilidade da auditoria é garantida no próprio banco: gatilhos bloqueiam `UPDATE`/`DELETE`/`TRUNCATE` em
`audit_events` e `UPDATE`/`DELETE` nos históricos (status, transferências, validações, reaberturas, comentários).
Não existe rota de exclusão de pendências; `original_due_at` e `origin_area_id` não podem ser alterados.

**Regras em um só lugar.** `shared/permissions.ts`, `workflow.ts`, `deadline.ts` e `scoring.ts` são as mesmas
funções no servidor (que decide) e na interface (que apenas esconde botões). Toda validação é refeita no servidor.

**“Atrasada” é condição derivada**, calculada como `status ativo AND due_at < agora`. Assim uma pendência
“Em andamento” atrasada continua mostrando em que etapa do fluxo está, e não há como “esquecer” de marcar o atraso.
O processo automático registra `overdue_since`, gera a auditoria `issue.overdue` e dispara notificações e escalonamento.

**Concorrência.** Cada alteração usa `SELECT … FOR UPDATE` e verifica a coluna `version`; se outro usuário
alterou antes, a API devolve 409 e a interface pede para recarregar, sem sobrescrever. Códigos `FR-AAAA-00001`
vêm de sequência por ano dentro da transação. Eventos de tempo real só são publicados após o commit.

**Processos automáticos dentro da aplicação**, protegidos por `pg_try_advisory_xact_lock`: com várias instâncias,
apenas uma executa a rodada. Notificações têm chave de deduplicação, então reexecutar não duplica avisos.

**Notificações reais.** No sistema: gravadas no banco e entregues na hora por SSE. E-mail: fila
`notification_deliveries` enviada por SMTP com até 5 tentativas; sem SMTP configurado, nenhum e-mail é
“fingido” — a tela de configurações informa que o canal está desativado.

**Autoridade da reunião.** Decisões do Fast Response são coletivas e cruzam áreas; quem conduz (líder/gestor)
registra decisões em qualquer pendência, auditadas em seu nome. Colaboradores não registram decisões.

**Hora de conclusão.** O responsável informa quando a solução foi aplicada (até 24 h para trás), pois o registro no
sistema pode acontecer depois do trabalho no chão de fábrica. O prazo é avaliado por essa hora; valores
fora da janela são rejeitados.

**Segurança.** Senhas com bcrypt; sessão em cookie `httpOnly`/`SameSite=Lax` (token guardado só como hash);
cabeçalho anti-CSRF obrigatório em requisições de escrita; bloqueio após 5 senhas erradas por 15 min; limite de
requisições no login; troca obrigatória da senha provisória; anexos validados pelo conteúdo (não pela extensão),
gravados fora da pasta pública e servidos com `Content-Security-Policy: sandbox`; exportação CSV protegida contra
injeção de fórmulas.

## Modelo de dados (principais tabelas)

`settings`, `areas`, `users`, `sessions`, `categories`, `assets`, `issues`, `issue_status_history`, `steps`
(com dependências), `comments`, `attachments`, `impediments`, `transfers`, `deadline_changes`, `validations`,
`reopenings`, `meetings`, `meeting_decisions`, `notifications`, `notification_deliveries`, `monthly_scores`,
`monthly_area_scores`, `ranking_months`, `audit_events`. Modelos de etapas ficam em `settings`.
Definição completa em `server/src/db/migrations/001_initial.sql`.
