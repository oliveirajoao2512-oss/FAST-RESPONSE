# Ordens de Manutenção (OS)

Abertura de ordens de manutenção corretiva pelo sistema, no lugar da OS em papel. Menu **Ordens de Manutenção**
(rota `/os`). Funciona em computador, tablet e celular.

## Quem faz o quê

| Ação | Qualquer usuário | Manutentor | Gerente / líder de manutenção | Administrador |
|---|---|---|---|---|
| Abrir OS e ver todas as OS | ✓ | ✓ | ✓ | ✓ |
| Aceitar, entrar, pausar, passar, devolver, finalizar | — | ✓ | ✓ | ✓ |
| Prioridade, fixar no topo, indicar manutentor | — | — | ✓ | ✓ |
| Indicadores e exportação Excel | — | — | ✓ (e gestores/líderes de outras áreas) | ✓ |
| Excluir definitivamente (OS de teste) | — | — | — | ✓ |
| Resto do sistema (pendências, painéis, etc.) | como hoje | **sem acesso** | como hoje | como hoje |

- **Manutentor** é um perfil próprio, criado em Gestão → Usuários. Ele entra com o próprio e-mail ou matrícula e cai
  direto na fila de OS. O servidor recusa qualquer outra rota para esse perfil, não é só o menu escondido.
- **Gerente e líder de manutenção** são identificados pelo cargo: todo gestor ou líder cadastrado na área
  Manutenção. Não é preciso cadastrar nomes.
- Manutentores não podem ser responsáveis por pendências.

## Abertura

Campos: setor (já vem a área de quem abre), máquina/dispositivo (sugestões dos Cadastros e das OS anteriores),
tipo (mecânica, elétrica, hidráulica, pneumática, outros), se a máquina está parada, descrição e foto opcional.
Número, solicitante, data e hora são automáticos. Se já existe OS aberta para a mesma máquina, o formulário avisa.

Máquina parada → prioridade **crítica** e notificação na hora para manutentores, gerente e líder de manutenção.

## Fluxo

| Status | Como chega | Quem vê o quê |
|---|---|---|
| Aberta (aguardando aceite) | abertura, ou o último manutentor devolveu | posição na fila |
| Em atendimento | um manutentor aceitou | "Fulano está atuando" |
| Pausada | pausar com motivo (aguardando peça, liberação da produção, terceiro, outro) | motivo da pausa |
| Finalizada | finalizar com o serviço realizado (material e foto opcionais) | histórico de finalizadas |

- Vários manutentores podem atuar na mesma OS (**Entrar na OS**). Cada um tem seu horário de entrada e saída.
- **Passar**: o manutentor indica um colega; a OS só muda de mãos quando o colega aceita (ou ele recusa).
- **Devolver / sair**: pede motivo. Se era o último na OS, ela volta para a fila.
- Não há confirmação do solicitante: finalizou, fechou. Solicitante e gerente de manutenção são avisados no aceite e na
  finalização.
- Fila ordenada por: fixadas no topo, prioridade (crítica, alta, normal, baixa) e OS mais antiga.
- Todo passo fica no histórico da OS, que é imutável; ninguém apaga OS (exceto a exclusão de teste do administrador).

## Tempos (calculados, ninguém digita)

| Tempo | De | Até |
|---|---|---|
| Espera na fila | abertura | primeiro aceite |
| Atendimento | primeiro aceite | finalização, sem o tempo pausado |
| Pausado | cada pausa | cada retomada |
| Total | abertura | finalização |
| Horas por manutentor | entrada dele na OS | saída dele, sem o tempo pausado |
| Máquina parada | abertura de OS com máquina parada | finalização |

## Indicadores

Aba **Indicadores** (e atalho em Gestão → Relatórios → Painel de manutenção): fila agora, abertas e finalizadas por mês,
espera e atendimento médios por mês, máquinas com mais horas paradas, horas por manutentor, OS por tipo e por setor.
**Exportar Excel** gera uma planilha com todas as OS do período e os tempos em horas.

## Fora do escopo (decisão de 22/10/2026)

Checklist de bloqueio de energia, liberação da Qualidade após ajuste de ferramental e manutenção preventiva
programada. A regra é: quanto mais rápido, melhor.
