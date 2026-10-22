# Regras de negócio

Os valores entre parênteses são os padrões e podem ser alterados em **Administração → Configurações**.

## Perfis

| Ação | Colaborador | Líder | Gestor | Admin |
|---|---|---|---|---|
| Abrir pendência, comentar, anexar | ✓ | ✓ | ✓ | ✓ |
| Assumir pendência sem responsável | ✓ | ✓ | ✓ | ✓ |
| Atribuir / transferir / cancelar | — | sua área* | todas | todas |
| Andamento, bloqueio, etapas, conclusão | se responsável | sua área* | todas | todas |
| Validar / reabrir | se abriu a pendência | sua área* | todas | todas |
| Alterar prazo | solicita (aprovação) | direto, justificado | direto | direto |
| Conduzir reunião Fast Response | — | ✓ | ✓ | ✓ |
| Relatórios | — | ✓ | ✓ | ✓ |
| Auditoria, catálogos, fechar ranking | — | — | ✓ | ✓ |
| Usuários e configurações | — | — | — | ✓ |

\* Área atualmente responsável **ou** área de origem da pendência. Quem concluiu não pode validar a própria
conclusão. Nenhum perfil apaga pendências; usuários são desativados, nunca excluídos.

## Prazos

- **Padrão D+1:** dia seguinte à abertura, às 23:59 no fuso da fábrica (dias e horário configuráveis;
  opcionalmente pula fins de semana e feriados). O servidor calcula o prazo; o navegador não define.
- **Segurança crítica** (prioridade crítica na área Segurança ou em categoria marcada como segurança):
  prazo = abertura + 4 h, notificação imediata aos líderes de Segurança e gestores.
- **Exceções:** líderes/gestores podem definir prazo diferente na abertura ou depois, com justificativa;
  colaboradores apenas solicitam, e um líder/gestor aprova ou rejeita. O prazo original é imutável e
  toda mudança fica no histórico.
- **Atrasada** é uma condição, não um status: qualquer pendência ativa com prazo vencido aparece como
  ATRASADA no status em que está (ex.: “Em andamento · ATRASADA”). O processo automático (a cada 60 s) registra o
  momento do atraso na auditoria, notifica responsável e líderes e, após 24 h atrasada, escalona aos gestores.
  Antes disso, avisa “vence em breve” 4 h antes do prazo.

## Fluxo de status

```
Aberta ⇄ Planejada ⇄ Em andamento ──► Aguardando validação ──► Concluída
   │  (sem responsável: Aguardando responsável)       │ rejeitada → volta a Em andamento
   └─► Bloqueada (impedimento) ─► retorna ao status anterior ao resolver
Cancelada: só líder/gestor, com motivo. Concluída pode ser reaberta (solução ineficaz).
```

Para concluir: solução descrita, critério de conclusão confirmado, todas as etapas obrigatórias concluídas,
nenhum impedimento aberto e evidência anexada quando a prioridade exige (crítica). Com validação obrigatória
(padrão), a pendência vai para “Aguardando validação”.

## Pendências complexas

Etapas com responsável, prazo próprio, status, dependências (uma etapa só inicia quando as anteriores
dependentes forem concluídas), comentários e evidências. A barra de progresso considera etapas não canceladas.
Complexidade automática: 2+ etapas obrigatórias = moderada, 5+ = complexa; líder/gestor pode reclassificar.
Modelos de etapas (ex.: “Manutenção de molde”) são cadastrados pelos gestores.

## Transferência e reincidência

Ao transferir, a área responsável muda, mas a pendência continua visível na área de origem e em todas as áreas
pelas quais passou. Uma nova pendência no mesmo ativo e categoria de outra concluída nos últimos 90 dias é
marcada automaticamente como reincidência.

## Fast Response (reunião diária)

Painel com críticas/segurança, atrasadas, vencendo hoje, bloqueadas, sem responsável, aguardando validação e
o que mudou desde a última reunião. A reunião é iniciada por um líder/gestor (uma por vez). As decisões são
registradas **na pendência existente** (comentário de decisão + responsável, prazo e etapa opcionais),
sem criar tarefa duplicada. Quem conduz a reunião registra decisões de qualquer área, e tudo fica auditado em seu nome.

## Ranking mensal

Só pontuam pendências **concluídas e validadas** no mês, creditadas a quem concluiu:

| Regra | Pontos |
|---|---|
| Base por complexidade | simples 10 · moderada 20 · complexa 35 |
| Concluída no prazo | +30% da base |
| Concluída após o prazo | −40% da base |
| Reaberta por solução ineficaz | −15 por reabertura |
| Problema reincidente | −10 |
| Etapa concluída em pendência de outra pessoa (colaboração) | +3 por etapa |

Regras antimanipulação: pendência simples aberta e concluída pela mesma pessoa em menos de 30 min não pontua;
no máximo 40 pendências simples pontuadas por pessoa no mês; canceladas e não validadas não contam; validação
por terceiro. Campeão do mês: maior pontuação com pelo menos 3 pendências validadas (desempate: % no prazo).
O detalhamento de cada pontuação (pendência por pendência, com bônus e descontos) é visível a todos. Gestores fecham meses anteriores, congelando o resultado.

## Exclusão definitiva (somente administrador)

Para limpar **registros de teste**, o administrador tem o botão **Excluir definitivamente** na pendência e na
ocorrência da Resposta Rápida. A confirmação exige digitar o código da pendência (ex.: FR-2026-00012) ou o número da
ocorrência (ex.: 108/26). A exclusão remove o registro e todo o histórico ligado a ele (comentários, anexos, etapas,
notificações e auditoria); na ocorrência, remove também as pendências criadas a partir dela. Não há como desfazer.
Fora dessa operação, o histórico continua imutável no banco. Para registros reais, use **Cancelar**.
