# Implantação e configuração

## 1. Requisitos do servidor

- Linux com Docker Engine 24+ e o plugin `docker compose` (recomendado), **ou**
  Node.js ≥ 20.12 + PostgreSQL 16 instalados diretamente.
- 2 vCPU, 2 GB de RAM e 20 GB de disco atendem centenas de usuários simultâneos; o volume de anexos cresce com o uso.
- Relógio do servidor sincronizado (NTP). Os prazos são calculados no fuso configurado (padrão `America/Sao_Paulo`), independentemente do fuso do servidor.

## 2. Instalação com Docker Compose

```bash
git clone <repositório> fast-response && cd fast-response
cp .env.example .env
# edite .env: POSTGRES_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD, APP_URL (e SMTP_*, se houver)
docker compose up -d --build
docker compose logs -f app        # aguarde "Server listening"
```

No primeiro start, a aplicação:
1. aplica as migrações do banco (tabelas, gatilhos de imutabilidade, 7 áreas e categorias iniciais editáveis);
2. cria o administrador definido em `ADMIN_EMAIL`/`ADMIN_PASSWORD` **somente se não existir nenhum usuário**;
3. exige que esse administrador troque a senha no primeiro acesso.

Depois do primeiro acesso, remova `ADMIN_PASSWORD` do `.env`. Para criar outro administrador pelo terminal:
`docker compose exec app node dist/cli/create-admin.js`.

Volumes criados: `pgdata` (banco) e `uploads` (anexos, montado em `/data`).

### Atualizar para uma nova versão

```bash
scripts/backup.sh                 # sempre antes de atualizar
git pull
docker compose up -d --build      # migrações novas são aplicadas automaticamente na subida
```

## 3. HTTPS (obrigatório em produção)

A aplicação deve ficar atrás de um proxy reverso com TLS (Nginx, Traefik, IIS/ARR ou o balanceador corporativo).
Com HTTPS ativo, defina no `.env`:

```
APP_URL=https://fastresponse.suaempresa.com.br
COOKIE_SECURE=true
```

Exemplo Nginx (atenção ao trecho de SSE, que precisa de buffering desligado):

```nginx
server {
  listen 443 ssl;
  server_name fastresponse.suaempresa.com.br;
  ssl_certificate     /etc/ssl/fastresponse.crt;
  ssl_certificate_key /etc/ssl/fastresponse.key;
  client_max_body_size 20m;

  location /api/events {               # atualização em tempo real (Server-Sent Events)
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## 4. Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `POSTGRES_PASSWORD` | — | Senha do banco (Docker Compose). Obrigatória. |
| `DATABASE_URL` | — | Conexão PostgreSQL (instalação sem Docker). No Compose é montada automaticamente. |
| `PORT` / `HTTP_PORT` | 3000 | Porta interna / porta publicada pelo Compose. |
| `APP_URL` | http://localhost:3000 | Endereço público; usado nos links dos e-mails. |
| `COOKIE_SECURE` | false | `true` quando acessado por HTTPS. |
| `SESSION_DAYS` | 7 | Validade da sessão. |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | Administrador inicial (apenas com banco vazio). |
| `UPLOAD_DIR` | ./data/uploads | Pasta dos anexos (`/data/uploads` no Docker). |
| `MAX_UPLOAD_MB` | 15 | Tamanho máximo por arquivo. |
| `JOBS_ENABLED` | true | Processos automáticos: atraso, aviso de vencimento, escalonamento, envio de e-mails. |
| `JOB_INTERVAL_SECONDS` | 60 | Intervalo desses processos. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | — | E-mail corporativo. Sem `SMTP_HOST`, só há notificações dentro do sistema. |

Rodar mais de uma instância da aplicação é suportado: os processos automáticos usam *advisory locks* do PostgreSQL
(só uma instância executa por vez) e o tempo real é distribuído via `LISTEN/NOTIFY`. Os anexos, nesse caso, precisam
estar em um volume compartilhado.

## 5. E-mail (notificações reais)

Notificações dentro do sistema funcionam sempre. Para enviar também por e-mail, informe o SMTP corporativo
(Microsoft 365: `smtp.office365.com`, porta 587, `SMTP_SECURE=false`, usuário com permissão *SMTP AUTH*;
Google Workspace: `smtp.gmail.com`, 587, senha de app). Os e-mails entram em uma fila no banco
(`notification_deliveries`) e são reenviados até 5 vezes em caso de falha; o resultado de cada tentativa fica registrado.
Cada usuário precisa ter um e-mail válido cadastrado.

## 6. Configurações de negócio

Em **Administração → Configurações** (somente administradores): prazo padrão (D+N e horário), pular fins de semana
e feriados, prazo de segurança crítica, janela de “vence em breve”, validação obrigatória, prioridades que exigem
evidência, perfis que precisam de aprovação para mudar prazo, escalonamento ao gestor, critérios de complexidade,
janela de reincidência e todos os pesos do ranking. Toda alteração fica na auditoria.
Áreas, categorias, ativos (máquinas, moldes, linhas) e modelos de etapas são cadastrados na mesma tela.

## 7. Backup e restauração

```bash
scripts/backup.sh /caminho/backups                                   # banco (pg_dump) + anexos (tar.gz)
scripts/restore.sh backups/fastresponse-AAAAMMDD-HHMMSS.dump backups/uploads-AAAAMMDD-HHMMSS.tar.gz
```

Recomendação: agendar o backup diariamente no `cron` e copiar os arquivos para outro servidor
(ex.: `0 2 * * * cd /opt/fast-response && scripts/backup.sh /mnt/backup/fast-response`).
Teste a restauração periodicamente em um servidor de homologação. Ambos os scripts foram testados com a stack Docker.

Sem Docker: `pg_dump -Fc "$DATABASE_URL" > fastresponse.dump` e copie a pasta `UPLOAD_DIR`.

## 8. Instalação sem Docker

```bash
npm ci && npm run build
cp .env.example .env    # DATABASE_URL apontando para o PostgreSQL 16
cd server && node dist/index.js
```

Use um gerenciador de serviços (systemd, PM2, NSSM no Windows) para manter o processo ativo.

## 9. Banco de dados no Supabase

O Supabase fornece um PostgreSQL gerenciado (com backup automático) e funciona sem mudar o código.
As tabelas já foram criadas no projeto Supabase da organização FAST RESPONSE.

1. No painel do Supabase: **Connect → Connection string → Session pooler** (porta 5432). Não use o
   *Transaction pooler* (porta 6543): a aplicação usa `LISTEN/NOTIFY` (tempo real) e *advisory locks*, que exigem sessão.
2. Com Docker Compose: coloque essa URL (com a senha do banco) em `EXTERNAL_DATABASE_URL` no `.env` e suba só a
   aplicação: `docker compose up -d --build --no-deps app`. Sem Docker: use a URL em `DATABASE_URL`.

A migração `003_row_level_security.sql` ativa RLS em todas as tabelas, bloqueando a API REST automática do Supabase.
A aplicação conecta como dona das tabelas e não é afetada. Os anexos continuam no disco do servidor da aplicação.

### String de conexão com TLS verificado

O certificado raiz do Supabase acompanha a imagem (`server/certs/supabase-prod-ca-2021.crt`). Monte a URL assim
(dados em Supabase → Connect → Session pooler):

```
postgresql://postgres.<ref-do-projeto>:<SENHA>@<host-do-pooler>:5432/postgres?sslmode=verify-full&sslrootcert=/app/server/certs/supabase-prod-ca-2021.crt
```

Sem Docker, troque o caminho do `sslrootcert` pelo caminho local do arquivo. Se a senha tiver caracteres
especiais (`@`, `#`, `/`, `:`), codifique-os (ex.: `@` → `%40`).

## 10. Hospedagem no Render (sem servidor próprio)

O arquivo `render.yaml` descreve o serviço (Docker, disco de 1 GB para anexos, verificação de saúde, deploy
automático a cada push na `main`).

1. Crie a conta em [render.com](https://render.com) entrando com o GitHub e autorize o acesso ao repositório.
2. **New → Blueprint** → escolha o repositório `fast-response` → Apply.
3. Preencha as variáveis pedidas:
   - `DATABASE_URL`: a string do Supabase da seção anterior;
   - `ADMIN_EMAIL` e `ADMIN_PASSWORD`: o administrador inicial (senha provisória, trocada no primeiro acesso);
   - `APP_URL`: o endereço que o Render mostrar (ex.: `https://fast-response.onrender.com`).
4. Aguarde o primeiro deploy (5–10 min) e acesse o endereço. O HTTPS já vem pronto.

Custo do Render: plano Starter (US$ 7/mês) + disco (US$ 0,25/GB/mês). O plano gratuito não serve para produção:
hiberna após 15 minutos sem acesso (atrasos, escalonamentos e e-mails só rodam quando alguém abre o sistema)
e não tem disco, então os anexos seriam perdidos a cada deploy. O Supabase gratuito tem 500 MB de banco e
pausa projetos sem atividade por 7 dias; para uso diário na fábrica, o plano Pro (US$ 25/mês) inclui backups diários.

