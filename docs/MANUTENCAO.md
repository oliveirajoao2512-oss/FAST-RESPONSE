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

- **Manutentor** é um perfil próprio, criado em Administração → Usuários. Ele entra com o próprio e-mail ou matrícula e cai
  direto na fila de OS. O servidor recusa qualquer outra rota para esse perfil, não é só o menu escondido.
- **Gerente e líder de manutenção** são identificados pelo cargo: todo gestor ou líder cadastrado na área
  Manutenção. Não é preciso cadastrar nomes.
- Manutentores não podem ser responsáveis por pendências.

## Abertura

**Onde é?** Máquina ou Montagem (a Ordem de Ajuste só existe em máquina). Em seguida aparece a lista correspondente,
na ordem da planta. As listas ficam em Administração → Cadastros (tipos "Máquina" e "Montagem"): para incluir ou desativar
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
| Finalizada | finalizar com o serviço realizado (material e foto opcionais) | aba Finalizadas, mês a mês |
| Cancelada | quem abriu (ou a liderança) cancelou por abertura errada, com motivo | aba Finalizadas, riscada; fora dos indicadores |

- Vários manutentores podem atuar na mesma OS (**Entrar na OS**). Cada um tem seu horário de entrada e saída.
- **Incluir manutentor**: quando o serviço é feito em dupla, quem está atuando (ou o gestor/líder de Manutenção) inclui o
  colega na OS. Ele entra na hora, sem precisar aceitar, e é avisado; as horas dele contam a partir de agora ou, marcando
  a opção, desde o início do atendimento. Ao **finalizar** também aparece "Mais alguém fez este serviço junto?": quem
  for marcado entra com as horas desde o início do atendimento. Tudo fica no histórico e no comprovante.
- **Uma ordem por vez**: quem está atuando numa OS ou OA (em atendimento ou pausada) não aceita, não entra e não assume
  outra. Também não pode ser incluído, receber uma passagem nem ser marcado como ajudante em outra ordem. Para pegar
  outra, finalize, devolva ou saia da atual. A fila mostra "Você está atuando na OS-…" e esconde o botão Aceitar; nas
  listas de colegas, quem está ocupado aparece como "(atuando na OS-…)" e não pode ser escolhido.
- **Cancelar (abertura errada)**: não é finalizar. Quem abriu a ordem, o gestor/líder da área ou o administrador cancela,
  com motivo, enquanto ninguém está atuando (aguardando aceite, programada ou aguardando aprovação). Se alguém já aceitou,
  ele precisa devolver para a fila antes. A ordem sai da fila, aparece em Finalizadas como cancelada (com quem, quando e
  por quê, também no comprovante), não conta nos indicadores, e quem tinha sido avisado recebe o aviso do cancelamento.
- **Passar**: o manutentor indica um colega; a OS só muda de mãos quando o colega aceita (ou ele recusa).
- **Devolver / sair**: pede motivo. Se era o último na OS, ela volta para a fila.
- Não há confirmação do solicitante: finalizou, fechou. Solicitante e gerente de manutenção são avisados no aceite e na
  finalização.
- Fila ordenada por: fixadas no topo, prioridade (crítica, alta, normal, baixa) e OS mais antiga.
- Todo passo fica no histórico da OS, que é imutável; ninguém apaga OS (exceto a exclusão de teste do administrador).
- **Finalizadas** abre no mês atual, com ◀ ▶ e a lista dos últimos 24 meses para trocar. A busca procura em todos os meses
  e agrupa o resultado por mês. Dentro do mês há duas formas de ver, e o app lembra a escolhida: **Lista**, separada por
  dia ("Hoje", "Ontem", "Sexta, 13/11"), e **Calendário**, com o mês em grade mostrando quantas ordens foram finalizadas
  em cada dia e quantas eram de máquina parada. Tocar no dia mostra as ordens dele (abre no último dia com ordens).

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

Aba **Indicadores** (e atalho em Administração → Relatórios → Painel de manutenção): fila agora, abertas e finalizadas por mês,
espera e atendimento médios por mês, máquinas com mais horas paradas, horas por manutentor, OS por tipo e por setor.
**Exportar Excel** gera uma planilha com todas as OS do período e os tempos em horas.

## Fora do escopo (decisão de 22/10/2026)

Checklist de bloqueio de energia, liberação da Qualidade após ajuste de ferramental e manutenção preventiva
programada. A regra é: quanto mais rápido, melhor.

## Dashboard (OS e Ajustes)

Aba **Dashboard** dentro de cada módulo. A de OS é exclusiva do gestor e do líder de Manutenção; a de Ajustes, do
gestor e do líder de Processos. O administrador vê as duas. O servidor recusa o acesso de qualquer outro perfil.

- Filtros: período (abre sempre em **este mês**; mês passado, 3, 6 ou 12 meses, ou datas), setor que abriu, tipo/motivo, part number, onde foi o problema, dispositivo/trim die, turno e máquina (clicando no gráfico). O Painel da planta e os Relatórios também abrem no mês atual.
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

Em **Administração → Cadastros → Part numbers** fica a lista de PNs da empresa (código, descrição, cliente e máquina padrão).
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
parada e o que será feito. A OS fica **Aguardando o gestor de Manutenção**: o gestor da área Manutenção (perfil Gestor) é avisado e vê
a OS no topo da fila (o número no menu inclui as que aguardam a aprovação dele). Líderes e outras áreas não aprovam;
o administrador também pode. Até 17/11/2026 quem aprovava era a Logística. O gestor pode:

- **Aprovar**, na data pedida ou em outra, ajustando as horas e deixando uma observação. A OS passa a **Programada**, a equipe
  de manutenção e quem pediu são avisados, e ela aparece em "Manutenções programadas" na fila, por data. A equipe aceita
  ("Iniciar a manutenção") e o fluxo segue igual ao da corretiva. A espera conta a partir da data aprovada.
- **Recusar**, com o motivo. A OS sai da fila, aparece em Finalizadas como "Recusada pelo gestor de Manutenção" e quem pediu é avisado.

OS em análise ou recusadas não entram nos indicadores. O comprovante em PDF mostra a data pedida, a análise e a data aprovada.

## Turnos

Cada ordem (manutenção ou ajuste) conta no **turno em que foi aberta**, pelo horário da fábrica. Os turnos são cadastrados em **Administração → Configurações → Turnos**, pelo horário em que cada um começa (padrão: 06:00, 14:00 e 22:00; o último vai até o início do primeiro, passando da meia-noite). Como o turno é calculado a partir da hora de abertura, mudar os horários recalcula também as ordens antigas.

Onde aparece: filtro "Turno de abertura" e tabela "por turno de abertura" (abertas, espera média, atendimento médio e horas de máquina parada) no Dashboard de cada módulo, coluna "Turno" no Excel exportado e quadro "abertas por turno" no Painel da planta.

## Onde foi o problema: máquina, dispositivo ou trim die

Na OS de máquina, depois de escolher a máquina aparece **"Onde está o problema na máquina X?"** com três opções: **Máquina**, **Dispositivo** ou **Trim die** (obrigatório, porque dispositivo e trim die fazem parte da máquina). Montagem e Ordem de Ajuste não têm essa pergunta. No Dashboard de manutenção há o filtro "Onde foi o problema" e o quadro "Onde foram os problemas" (clique para filtrar); no Painel da planta, o quadro "Máquina x dispositivo x trim die"; no Excel, a coluna "Onde foi o problema".

## Dispositivo (D) e trim die (T) da OS

A fábrica identifica dispositivos pelo **D** (D405) e trim dies pelo **T** (T129). Quando o problema é em dispositivo ou
trim die, a abertura pergunta **"Qual dispositivo?"** e já traz o código:

1. pelo **part number** informado (o produto que está na máquina), quando ele está ligado a algum dispositivo;
2. senão, pela **máquina**: dispositivos marcados para a máquina em Cadastros, dispositivos dos PNs que rodam na máquina
   (máquina padrão do PN) e dispositivos já usados em OS daquela máquina.

Se só existe um candidato, ele é selecionado sozinho ("encontrado automaticamente"); com vários, aparecem para tocar; e
dá para buscar qualquer outro por número (405, D-405), produto, molde ou PN. "Não sei qual" deixa em branco para o
manutentor informar. Com a base cadastrada, só códigos cadastrados e do tipo certo são aceitos.

**Um campo só para D e PN.** Na OS de dispositivo ou trim die não existe campo separado de part number: o mesmo campo
aceita os dois. Quem digita o **D** recebe o PN dele (se o dispositivo faz um produto só, ele entra sozinho; se faz
vários, aparecem para tocar, e o PN é opcional). Quem digita o **PN** recebe o D: se o PN usa um dispositivo só, ele é
selecionado; se usa mais de um, aparecem as opções e a pessoa escolhe. "Trocar produto" muda só o PN.

Para o manutentor, o código aparece em destaque (etiqueta preta **DISPOSITIVO D405**) na fila, no detalhe, no título da
OS, na notificação de máquina parada, no comprovante PDF e no Excel. Quem abriu e a equipe de manutenção podem
**informar ou trocar** o código na OS; a troca fica no histórico. Indicadores: filtro "Dispositivo / trim die", quadro
"Dispositivos e trim dies com mais OS" (clique para filtrar) e busca por código nas listas.

Cadastro em **Administração → Cadastros → Dispositivos e trim dies**: código, produto, molde, part numbers e máquinas.
**Importar planilha** lê a "Controle de Moldes e Dispositivos" (abas com coluna de part number e de dispositivo ou trim
die; cada bloco de molde liga seus D e T a todos os PNs do bloco). A importação soma PNs e completa o que falta, sem
apagar o que foi editado. Os dados da empresa ficam só no banco, nunca no código.

## Avisos no celular e cobrança por tempo

**Avisos no celular (notificação push).** Cada pessoa ativa uma vez por aparelho: no aviso "Receba as ordens e
cobranças na hora" que aparece no topo da página, ou no menu do usuário → **Avisos no celular**. Ao ativar chega uma
notificação de teste. Depois disso o aparelho toca mesmo com o app fechado: OS/OA nova para a equipe, cobranças,
pendências atribuídas, atrasos. Máquina parada e cobranças ficam na tela até a pessoa tocar. Tocar abre a ordem.

- Android (Chrome) e computador (Chrome, Edge, Firefox): funciona direto no navegador ou no app instalado.
- iPhone/iPad: só com o app instalado na tela inicial (Safari → Compartilhar → Adicionar à Tela de Início), iOS 16.4 ou
  mais novo. Depois abra pelo ícone e ative.
- Aparelho compartilhado (tablet da linha): o aparelho recebe os avisos de quem está logado. **Sair** desliga os avisos
  daquela pessoa; quem entrar depois passa a receber os dele sem precisar ativar de novo. Com duas janelas de usuários
  diferentes no mesmo navegador, vale o último que entrou.
- Bloqueou sem querer: no cadeado ao lado do endereço → Notificações → Permitir. O menu "Avisos no celular" explica.
- Não usa WhatsApp nem conta externa: o próprio navegador (Google, Apple, Mozilla) entrega, sem custo. As chaves do
  servidor são criadas sozinhas e ficam no banco (ou vêm de `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`).

**Quem é avisado ao abrir.** Máquina parada: técnicos e líderes da área (Manutenção para OS, Processos para OA), como
urgente. Máquina rodando: os mesmos, como aviso normal (pode desligar em Configurações).

**Cobrança enquanto ninguém aceita** (Gestão → Configurações → "Avisos das ordens de manutenção e de ajuste"):

| | Cobra a equipe e os líderes | Avisa gestores da área e Plant Manager |
|---|---|---|
| Máquina parada | 10 min | 30 min |
| Máquina rodando | 60 min | 240 min (4 h) |

Cada etapa avisa uma vez por ordem; 0 desliga a etapa. Quem abriu não é cobrado. Ordens já aceitas, programadas ou do
histórico importado não são cobradas. A cobrança fica registrada na auditoria (`os.cobranca`/`oa.cobranca`).

## Status da fábrica (tela de TV)

Endereço `/tela` (menu Indicadores → "Status da fábrica (TV)"). Tela só de leitura, feita para uma TV no chão de fábrica:
botão de tela cheia, relógio, atualização ao vivo (eventos do servidor e mais uma consulta a cada 30 s) e pede ao
navegador para não apagar a tela. Mostra:

- os números do dia: máquinas paradas agora, ordens aguardando aceite, em atendimento (e pausadas), abertas hoje,
  finalizadas hoje com o tempo médio de aceite, e o tempo de máquina parada no dia;
- cada máquina e montagem do cadastro: vermelha quando há ordem aberta com a máquina parada (com o tempo parado),
  amarela quando há ordem aberta com a máquina rodando, verde sem ordem aberta;
- a fila de ordens abertas (OS e OA), paradas primeiro, com quem está atendendo ou o motivo da pausa; passa de página
  sozinha quando não cabe;
- as manutenções programadas para o dia e as pendências abertas por área (atrasadas e de segurança em destaque).

Qualquer usuário logado abre a tela (tudo nela já é visível a todos); manutentor e processista continuam só nos seus
módulos. Para a TV, o ideal é um usuário próprio (ex.: "TV Produção", perfil colaborador). API: `GET /api/tela`.

## Histórico importado

As OS antigas da planilha de manutenção (outubro/2026) foram carregadas. A aba "molde" entrou como problema na própria máquina; a aba "dispositivo" entrou como problema em dispositivo, só com o código do dispositivo (a planilha não diz a máquina); esse código virou o dispositivo da OS. Elas foram carregadas como OS finalizadas, marcadas como **HISTÓRICO** com o número da OS de papel. Só a data é conhecida: a abertura foi registrada às 12:00 do dia, a espera e o tempo de reparo vêm da planilha, e essas ordens ficam fora da tabela por turno e do mapa "Quando os chamados acontecem". O manutentor é ligado pela matrícula (RA). Solicitante e setor não existiam na planilha: aparecem como o administrador e Produção.
