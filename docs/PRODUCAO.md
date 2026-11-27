# Produção: apontamento e conferência com as paradas

Etapa 1, pedida pelo João em 27/11/2026 (branch `lancamento-producao`). Menu **Produção** (`/producao`).

## Quem usa

Em prévia desde 27/11/2026: no ar só para o administrador (`productionAccess.adminOnly` em `shared/production.ts`). Quando o João liberar, valem as regras abaixo.

- Apontar e ver a conferência: líderes e gestores da área Produção, plant manager e administrador.
- Ciclos padrão (cadastrar, corrigir, trazer do Controle de Ciclo): gestor de Produção, plant manager e administrador.
- Corrigir um apontamento: quem apontou, ou a gestão de Produção. O valor anterior fica na auditoria. Ninguém apaga.

## Rodada da hora (o jeito principal de apontar)

1. O PCP sobe a planilha "PLANEJAMENTO APONTAMENTO" do dia (botão **Planejamento do PCP**). A aba PLANEJAMENTO diz o
   PN de cada máquina em cada turno (T1, T2, T3; "X", vazio ou HRS = 0 = não roda). O dia vem do nome do arquivo
   (ddmmaaaa) e pode ser trocado. Pode subir de novo quando o plano mudar: vale o último envio do dia (sem plano do
   dia, usa o mais recente dos 3 dias anteriores e avisa). Os ciclos e cavidades da planilha também são atualizados.
2. Quando a hora fecha, quem aponta recebe no celular "Hora fechada 07:00–08:00: aponte a produção" (uma vez por hora,
   nos primeiros 15 min, só se há planejamento). A tela abre na última hora fechada; ◀ ▶ navegam pelas horas.
3. Cada máquina rodando no turno vem numa linha com PN, meta por hora e OP. Máquina com dois ou três PNs ao mesmo tempo
   (peças esquerda/direita, molde família) tem uma linha por PN. O último setup da máquina nas últimas 24 h no
   Controle de Setup troca o PN quando ele não está no plano ("PN do último setup"); setup aberto aparece como "em
   setup desde hh:mm".
4. O líder digita só as peças e marca a refeição (não / 30 / 60 min). "Salvar" grava todas de uma vez; cada linha vira
   um apontamento e já mostra meta × real, as paradas que justificam e o tempo sem justificativa. A linha com erro
   (por exemplo, já apontada) fica na tela com o motivo; as outras são salvas.

O turno de uma hora segue o calendário oficial; o 3º turno pertence ao dia em que começou (22:00).

## Apontamento avulso

O líder escolhe a máquina (botões), o PN, a data, o horário de/até e a quantidade de peças. O período já vem sugerido:
começa onde terminou o último apontamento da máquina (até 12 h atrás) e termina na hora atual. Fim antes do início
quer dizer que passou da meia-noite (3º turno). O turno é calculado pelo horário de início, com o calendário oficial.

Regras: período de até 12 h, não termina no futuro, máquina do cadastro, e a mesma máquina não pode ter dois
apontamentos do mesmo PN no mesmo horário (PNs diferentes ao mesmo tempo podem). O ciclo padrão usado fica gravado no apontamento: mudar o ciclo depois não reescreve
o histórico. Apontamento salvo sem ciclo cadastrado usa o ciclo cadastrado depois (e avisa).

## Ciclo padrão

Tabela `production_standards`: máquina + PN, segundos por ciclo e cavidades (peças por ciclo).
Meta por hora = 3600 ÷ ciclo × cavidades. Se a máquina não tem ciclo para o PN, usa o de outra máquina que roda o
mesmo PN e avisa. Sem nenhum ciclo, o apontamento é salvo como "Sem ciclo padrão", sem meta.

"Importar planilha do PCP" lê a planilha "PLANEJAMENTO APONTAMENTO …" (.xlsm): toda aba com colunas de máquina,
part number, ciclo e cavidade (hoje "BASE att …" e "PLANEJAMENTO"). O planejamento do dia vence a base, porque é a
máquina usada de fato. Primeiro mostra o que muda, depois importa. Códigos "MC-02", "MC-INJ 120", "Injeção 470T" viram
"2", "INJETORA 120 T", "INJETORA 470 T". Linhas de montagem, robôs e fornecedores ficam de fora. Avisa quando a coluna
"peças por hora" da planilha não bate com ciclo × cavidades. Ciclo digitado à mão nunca é trocado; ciclo vindo do
Controle de Ciclo é substituído pelo da planilha (que tem cavidades), e o Controle de Ciclo não sobrescreve a planilha.

"Trazer do Controle de Ciclo" lê o app Controle de Ciclo (Firestore `controleciclos-fb533`, coleção `produtos`:
`pn`, `maquinaPadrao`, `cicloPadrao`), só leitura. Nunca sobrescreve um ciclo digitado à mão. Cavidades vêm como 1.
"INJEÇÃO 120T/470T" vira "INJETORA 120 T/470 T". Produtos com máquina fora do cadastro (Montagem, Comprado,
fornecedores, Robô…) ficam de fora e são listados.

## Conferência

Para cada apontamento:

1. Deveria produzir = minutos do período × peças por minuto do ciclo padrão.
2. Perda = (deveria − produziu) em peças, convertida em minutos pelo mesmo ciclo.
3. Paradas registradas no período, lidas na hora (nada é copiado):
   - OS e OA com máquina parada, daquela máquina: da abertura à finalização (ou agora, se aberta);
   - setups do Controle de Setup: do início até o início da produção (ou o fim do setup; ou agora, se aberto).
   Cada parada conta só a parte dentro do período, e tempo simultâneo entre paradas conta uma vez.
4. Justificado = o menor entre a perda e as paradas. Sem justificativa = perda − justificado, também em peças.

Situação (tolerância de 5 min): **Meta atingida** (perda ≤ 5 min), **Diferença justificada** (sobra ≤ 5 min sem
justificativa), **Tempo não justificado** (mais que isso). Nesse caso aparece "PRODUÇÃO COM TEMPO NÃO JUSTIFICADO —
NECESSÁRIA IDENTIFICAÇÃO DO MOTIVO." e o líder escreve o motivo, que fica registrado com nome e hora. O sistema não
inventa motivo e não atribui culpa.

Avisos: produção acima do que o ciclo permite (ciclo, cavidades ou período errados) e paradas maiores que a perda
(uma ordem pode ter ficado aberta depois de a máquina voltar).

Se o Controle de Setup não responder, a conferência sai sem os setups e avisa.

## Limites conhecidos desta etapa

- Refeição: o horário não é padrão (depende da cobertura), então o líder informa os minutos de pausa no apontamento e eles saem do tempo planejado.
- A parada da OS/OA vai até a finalização da ordem, que pode ser depois de a máquina voltar a produzir.
- Refugo ainda não é apontado (a Qualidade do OEE fica para a próxima etapa).

API: `POST /api/producao/planejamento?commit&date` (multipart), `GET /api/producao/planejamento?date`,
`GET /api/producao/rodada?end`, `POST /api/producao/rodada`, `GET /api/producao/opcoes`, `POST /api/producao/apontamentos`, `PATCH /api/producao/apontamentos/:id`,
`POST /api/producao/apontamentos/:id/motivo`, `GET /api/producao/conferencia?from&to&machine&status`,
`PUT /api/producao/padroes`, `POST /api/producao/padroes/importar-ciclo`.


## Tela do tablet (27/11/2026)

A aba **Apontar** mostra uma máquina + PN por vez, sem lista: o sistema traz a máquina e o PN da hora (planejamento do PCP ou último setup), o líder digita as peças no teclado numérico, e a tela já compara com a meta e com as paradas registradas na hora (OS/OA com máquina parada e setups). OS/OA abertas com a máquina rodando aparecem, mas não contam como parada. Ao salvar, aparece o resultado; se houver tempo não justificado, o líder informa o motivo antes de seguir para a próxima máquina. **Pular** deixa a máquina para o fim. No computador dá para digitar pelo teclado: Enter salva e, no resultado, Enter vai para a próxima máquina. O apontamento avulso foi para a aba **Conferência**; a importação do planejamento e os ciclos ficam na aba **Planejamento**.

## Refugo e OEE (27/11/2026)

Quando faltam peças e nenhuma parada registrada explica (tempo não justificado), o líder informa o que aconteceu antes de seguir:
- **Foi refugo**: quantas peças (vem preenchido com as peças que faltaram, pode alterar) e o defeito (Rebarba, Falha de injeção, Chupado, Mancha / contaminação, Bolha, Dimensional, Quebrada / trincada, Partida de máquina, ou texto livre).
- **Não foram produzidas**: o motivo (Falta de M.O, Falta de embalagem, Falta de componente, Microparadas, Ciclo acima do padrão, Refeição, ou texto livre).

Gravado em `production_entries.gap_kind` / `scrap_pieces` (migração 023), com o histórico na auditoria.

A aba **OEE** (GET /api/producao/oee?from&to&shift&machine) mostra, por período, turno e máquina:
- **Disponibilidade** = (tempo planejado − paradas registradas) / tempo planejado. O tempo planejado é o período menos a refeição. As paradas são OS/OA com máquina parada e setups, sem contar sobreposição duas vezes.
- **Performance** = (peças boas + refugo) no ciclo padrão / tempo rodando.
- **Qualidade** = peças boas / (boas + refugo).
- **OEE** = D × P × Q = peças boas no ciclo padrão / tempo planejado, limitado a 100% (apontamentos acima do ciclo aparecem num aviso). Meta da planta: 85% (`OEE_TARGET`), marcada no gráfico; máquinas abaixo da meta ficam em vermelho.

O painel mostra para onde foi o tempo planejado (produção boa, paradas por origem, refugo, ritmo, sem motivo), a evolução hora a hora ou dia a dia, um gráfico por máquina e por turno, o refugo por defeito, as peças não produzidas por motivo e os PNs que mais perderam tempo. Apontamentos sem ciclo padrão ficam fora do OEE e são contados no aviso.

### Ajuste 27/11/2026 (tarde)
- O tempo sem parada registrada vira **refugo automaticamente**: os minutos são convertidos em peças pelo ciclo padrão (ex.: 16 min = 19 pç) e o líder só informa o defeito antes de seguir. Antes da resposta, essas peças já contam no OEE como "Refugo sem motivo informado".
- **Refeição por horário**: o líder marca "Sim" e informa início e fim (ex.: 11:40–12:10). Cada hora conta só os minutos que caem nela; a hora seguinte da mesma máquina já vem com a refeição preenchida (migração 024: `break_start`, `break_end`).
- **Paradas informadas (códigos da planta)**: ao lançar a hora, ou depois no tempo sem justificativa, o líder pode dizer que a máquina parou parte da hora por um código de **Áreas de apoio** (09 Falta energia, 11 Falta MP, 13 Falta embalagem, 15 Ajuste no Injet, 22 Falta componente, 26 Aguardando processo, 32 Falta água/ar, 34 Falta peça de reposição, 41 Falta rebitadeira, 42 Falta dispositivo) ou de **Ajustes** sem OA (06, 16, 20, 31, 37), com os minutos. Esses minutos entram como parada (Disponibilidade) e só o que sobra vira refugo, com o código de defeito (01–29). Migração 025: `other_stop_minutes`, `other_stop_reason`.
