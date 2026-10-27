# Ordens de Manutenção (OS)

Abertura de ordens de manutenção corretiva pelo sistema, no lugar da OS em papel. Menu **Ordens de Manutenção**
(rota `/os`). Funciona em computador, tablet e celular.

## Quem faz o quê

| Ação | Qualquer usuário | Manutentor | Gerente / líder de manutenção | Administrador |
|---|---|---|---|---|
| Abrir OS e ver todas as OS | ✓ | ✓ | ✓ | ✓ |
| Aceitar, entrar, pausar, passar, devolver, finalizar | — | ✓ | ✓ | ✓ |
| Prioridade, fixar no topo, indicar manutentor | — | — | ✓ | ✓ |
| Dashboard e exportação Excel | — | — | ✓ (somente da Manutenção) | ✓ |
| Excluir definitivamente (OS de teste) | — | — | — | ✓ |
| Resto do sistema (pendências, painéis, etc.) | como hoje | **sem acesso** | como hoje | como hoje |

- **Manutentor** é um perfil próprio, criado em Gestão → Usuários. Ele entra com o próprio e-mail ou matrícula e cai
  direto na fila de OS. O servidor recusa qualquer outra rota para esse perfil, não é só o menu escondido.
- **Gerente e líder de manutenção** são identificados pelo cargo: todo gestor ou líder cadastrado na área
  Manutenção. Não é preciso cadastrar nomes.
- Manutentores não podem ser responsáveis por pendências.

## Abertura

**Onde é?** Máquina ou Montagem (a Ordem de Ajuste só existe em máquina). Em seguida aparece a lista correspondente,
na ordem da planta. As listas ficam em Gestão → Cadastros (tipos "Máquina" e "Montagem"): para incluir ou desativar
uma máquina ou montagem, basta editar lá. Não é possível digitar um local fora da lista.

Campos: setor (já vem a área de quem abre), máquina ou montagem da lista,
tipo (mecânica, elétrica, hidráulica, pneumática, outros), **part number** (opcional; reconhecido na base de PNs enquanto é digitado, ver abaixo),
se a máquina está parada, descrição e foto opcional. O PN é gravado padronizado (maiúsculas, sem espaços sobrando), então
"pn 4471" e "PN 4471" contam como o mesmo produto.
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

## Dashboard (OS e Ajustes)

Aba **Dashboard** dentro de cada módulo. A de OS é exclusiva do gestor e do líder de Manutenção; a de Ajustes, do
gestor e do líder de Processos. O administrador vê as duas. O servidor recusa o acesso de qualquer outro perfil.

- Filtros: período (30 dias, 3, 6 ou 12 meses, ou datas), setor que abriu, tipo/motivo, part number e máquina (clicando no gráfico).
- Números: fila agora, em atendimento, abertas e finalizadas no período, espera média até o aceite (e % aceitas em até
  30 min), tempo médio de atendimento/ajuste sem pausas, horas de máquina parada.
- Gráficos: abertas × finalizadas e tempos médios por dia, semana ou mês (conforme o período), tipos/motivos mais
  frequentes, máquinas com mais horas paradas, horas por técnico, setores que mais abrem, tempo pausado por motivo e
  mapa de dia da semana × hora em que os chamados acontecem.
- **Part numbers com mais ordens**: quantidade, horas de máquina parada e tempo médio por PN, e a % das ordens que têm
  PN informado. Clicar num PN filtra o dashboard inteiro e mostra o **histórico daquele PN**.
- Histórico das ordens finalizadas (com a coluna PN) com os mesmos filtros e busca; clicar abre a ordem completa.
- Exportação Excel do período filtrado.

# Ordens de Ajuste - Processo (OA)

Mesmo fluxo das OS (fila, aceitar, várias pessoas, pausar, passar, devolver, finalizar, prioridade, fotos, tempos
automáticos), no menu **Ordens de Ajuste** (rota `/ajustes`), substituindo a folha "Ordem de Ajuste - Processo".

- Quem atua: perfil **Processista** (vê somente as Ordens de Ajuste) e gestor/líder da área Processos.
- Abertura: setor, máquina, **motivo** (os 21 motivos numerados da folha), part number, máquina parada e descrição
  (motivo/problema da parada). No motivo 21 o sistema pede a % de material virgem e a % de moído.
- Hora da chamada, hora inicial (aceite), hora final e tempo de ajuste são registrados automaticamente.
- Ao finalizar: **ação tomada** (obrigatória) e observações.
- Códigos `OA-AAAA-00001`, numeração própria.

# Comprovante em PDF

Toda OS e toda OA tem o botão **Comprovante (PDF)** desde o momento em que é aberta. O PDF traz os dados da abertura,
horários e tempos, quem atuou, ação/serviço, o histórico completo e as fotos (JPEG/PNG). Cada página tem um
**código de verificação** calculado a partir do conteúdo da ordem: se o papel for alterado, o código não confere com o
que o sistema gera para a mesma ordem. Cada emissão fica registrada na auditoria.

# Painel da planta (estilo Power BI)

Menu **Painel da planta** (rota `/painel-planta`), visível somente para o **administrador** e o **Plant Manager**.
Segue o padrão visual dos relatórios em Power BI da empresa: duas janelas (Manutenção e Processos) na barra lateral do
painel e filtros no topo (ano, mês, local, máquina/montagem, part number). Clicar em um mês, máquina ou PN filtra o painel.

Indicadores: dias sem máquina parada, disponibilidade, MTBF, MTTR (ou tempo de ajuste), espera, abertas × finalizadas
por mês, horas paradas por mês, disponibilidade por mês, tipos/motivos, máquinas e montagens com mais ordens, part numbers
com mais ordens, horas
por técnico, máquina × montagem e setores que abrem.

Disponibilidade e MTBF são estimados considerando 24 h por dia e todos os equipamentos cadastrados no filtro; a parada
conta da abertura ao fim de cada ordem aberta com máquina parada.

# Perfil Plant Manager

Tem as permissões de um gestor na planta inteira (pendências, relatórios, ranking, cadastros, auditoria), vê o
dashboard dos dois módulos (sem comandar as filas) e o Painel da planta.

## Base de part numbers

Em **Gestão → Cadastros → Part numbers** fica a lista de PNs da empresa (código, descrição, cliente e máquina padrão).
O botão **Importar planilha** lê a planilha de cadastro do PCP (.xlsx/.xlsm, abas com coluna "PART NUMBER" ou "PN"), mostra
quantos PNs são novos e só grava depois de confirmar. A importação adiciona PNs novos e completa campos vazios; não apaga nem
sobrescreve o que foi editado à mão. PN que sai de linha é desativado (não é excluído).

Na abertura de OS e OA, o campo de PN compara o que é digitado com a base a cada tecla: mostra os PNs que começam com o texto,
que contêm o trecho, que batem pela descrição e os parecidos (1 dígito errado, faltando, sobrando ou dois trocados de lugar; 2 a
partir de 8 caracteres). PNs da máquina escolhida aparecem primeiro. Com o PN certo o campo fica verde com a descrição; com um PN
fora da base aparece "Você quis dizer …?" e a ordem não é aberta até escolher um PN da lista ou deixar em branco. O servidor faz a
mesma conferência. Enquanto a base estiver vazia, o PN continua livre.

## Manutenção programada

Ao abrir uma OS, escolha **Programada** no topo do formulário e informe a data e a hora, quantas horas a máquina vai ficar
parada e o que será feito. A OS fica **Em análise na Logística**: o gestor e o líder da área Logística são avisados e veem
a OS no topo da fila (o número no menu inclui as que aguardam a análise deles). Eles podem:

- **Aprovar**, na data pedida ou em outra, ajustando as horas e deixando uma observação. A OS passa a **Programada**, a equipe
  de manutenção e quem pediu são avisados, e ela aparece em "Manutenções programadas" na fila, por data. A equipe aceita
  ("Iniciar a manutenção") e o fluxo segue igual ao da corretiva. A espera conta a partir da data aprovada.
- **Recusar**, com o motivo. A OS sai da fila, aparece em Finalizadas como "Recusada pela Logística" e quem pediu é avisado.

OS em análise ou recusadas não entram nos indicadores. O comprovante em PDF mostra a data pedida, a análise e a data aprovada.
