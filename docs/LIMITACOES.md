# Limitações e integrações pendentes

Lista transparente do que **não** está implementado ou depende de configuração externa.

## Dependem de configuração da empresa

| Item | Situação | O que é preciso |
|---|---|---|
| E-mail | Implementado (SMTP com fila e reenvio), desativado até configurar | Servidor SMTP corporativo e e-mail cadastrado para cada usuário (`SMTP_*` no `.env`) |
| HTTPS | Não embutido na aplicação | Proxy reverso com certificado (exemplo Nginx em IMPLANTACAO.md) e `COOKIE_SECURE=true` |
| Backup automático | Scripts prontos e testados; agendamento não | Agendar `scripts/backup.sh` no cron e copiar para outro local |
| Feriados | Suportado, lista vazia | Cadastrar feriados em Configurações e ativar “pular fins de semana e feriados”, se a regra da fábrica for por dias úteis |
| Usuários, ativos e modelos de etapas | Cadastro manual pelo admin/gestor | Cadastrar a estrutura real (há 7 áreas, 12 categorias editáveis e 1 modelo de etapas de exemplo; nenhum dado fictício de produção) |

## Não implementado nesta versão

- **WhatsApp, Teams, SMS e notificação push no celular:** os canais disponíveis são o sistema (tempo real) e e-mail.
  A fila `notification_deliveries` já tem o campo de canal, então um novo canal exige apenas um novo enviador.
- **Login corporativo (Active Directory / Microsoft Entra / SSO):** autenticação própria com e-mail e senha.
- **Recuperação de senha por e-mail:** o administrador redefine a senha (provisória, com troca obrigatória).
- **Integração com ERP/MES** (ordens de produção, cadastro de máquinas): OP e ativo são digitados, com sugestões
  a partir do cadastro e do histórico.
- **Armazenamento de anexos em nuvem (S3/Azure Blob):** anexos ficam em disco local/volume Docker.
  Para várias instâncias, o volume precisa ser compartilhado.
- **Apontamento de horas trabalhadas:** os tempos medidos são de calendário (abertura → conclusão, tempo em cada status).
- **Relatórios agendados por e-mail e exportação em Excel/PDF:** há exportação CSV (abre no Excel) e telas de relatório.
- **Aplicativo instalável (PWA) e uso offline:** sem conexão, o sistema avisa e reconecta sozinho, mas não grava offline.

## Limitações conhecidas

- Algumas confirmações (motivo de rejeição, resolução de impedimento, observações ao encerrar a reunião,
  fechamento do ranking) usam a caixa de diálogo padrão do navegador em vez de uma janela própria do sistema.
- A interface é carregada em um único pacote (~850 kB, ~250 kB compactado); a primeira abertura em rede lenta
  pode levar alguns segundos.
- Os processos automáticos rodam a cada 60 s: atraso e escalonamento podem aparecer com até 1 min de diferença.
- O teste de carga não foi executado; o dimensionamento indicado na implantação é estimativa.
- Testes de navegador foram executados em Chromium; Firefox, Safari e Edge não foram testados automaticamente.
