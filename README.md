# Fast Response — Gestão Corporativa de Pendências

Sistema web para registrar, distribuir, acompanhar, validar e medir pendências industriais das áreas
Produção, Logística, Manutenção, Qualidade, Processos, Ferramentaria e Segurança, com reunião diária de
Fast Response, ranking mensal, notificações reais e trilha de auditoria imutável.

- **Servidor:** Node.js 22 + Fastify + PostgreSQL 16 (SQL puro, migrações versionadas)
- **Interface:** React 19 + Vite + Tailwind (responsiva, pt-BR, fuso da fábrica)
- **Tempo real:** Server-Sent Events + `LISTEN/NOTIFY` do PostgreSQL
- **Notificações:** no sistema (sempre) e por e-mail via SMTP corporativo (quando configurado)

## Subir em produção (Docker)

```bash
cp .env.example .env        # defina POSTGRES_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD, APP_URL
docker compose up -d --build
# acesse http://SERVIDOR:3000 e entre com ADMIN_EMAIL / ADMIN_PASSWORD (troca de senha obrigatória)
```

Detalhes (HTTPS, SMTP, backup, atualização): [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md).

## Desenvolvimento local

Pré-requisitos: Node.js ≥ 20.12 e PostgreSQL 16.

```bash
npm ci
cp .env.example .env                 # ajuste DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD
npm run dev:server                   # API em http://localhost:3000 (aplica migrações ao iniciar)
npm run dev:web                      # interface em http://localhost:5173 (proxy para a API)
```

Build de produção sem Docker: `npm run build && npm start` (a API serve a interface compilada).

## Comandos

| Comando | O que faz |
|---|---|
| `npm run build` | Compila interface e servidor |
| `npm start` | Inicia o servidor compilado |
| `npm run migrate` | Aplica migrações pendentes |
| `npm run create-admin -w server` | Cria um administrador pelo terminal |
| `npm test` | Testes de servidor (unitários + integração; usa o banco `fastresponse_test`) |
| `scripts/e2e-local.sh` | Testes de navegador (Playwright) em banco descartável |
| `npm run typecheck` | Verificação de tipos |
| `scripts/backup.sh` / `scripts/restore.sh` | Backup e restauração (banco + anexos) |

## Documentação

- [Implantação e configuração](docs/IMPLANTACAO.md)
- [Arquitetura e decisões](docs/ARQUITETURA.md)
- [Regras de negócio (prazos, fluxo, pontuação)](docs/REGRAS.md)
- [Qualidade · Resposta Rápida (importação da planilha e painel)](docs/QUALIDADE.md)
- [Ordens de Manutenção (perfil Manutentor, fluxo e indicadores)](docs/MANUTENCAO.md)
- [Testes automatizados e roteiro de teste manual](docs/TESTES.md)
- [Limitações e integrações pendentes](docs/LIMITACOES.md)
