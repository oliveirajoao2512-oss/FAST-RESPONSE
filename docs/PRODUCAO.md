# Produção: apontamento e conferência com as paradas

Etapa 1, pedida pelo João em 27/11/2026 (branch `lancamento-producao`). Menu **Produção** (`/producao`).

## Quem usa

Em prévia desde 27/11/2026: no ar só para o administrador (`productionAccess.adminOnly` em `shared/production.ts`). Quando o João liberar, valem as regras abaixo.

- Apontar e ver a conferência: líderes e gestores da área Produção, plant manager e administrador.
- Ciclos padrão (cadastrar, corrigir, trazer do Controle de Ciclo): gestor de Produção, plant manager e administrador.
- Corrigir um apontamento: quem apontou, ou a gestão de Produção. O valor anterior fica na auditoria. Ninguém apaga.

## Apontamento

O líder escolhe a máquina (botões), o PN, a data, o horário de/até e a quantidade de peças. O período já vem sugerido:
começa onde terminou o último apontamento da máquina (até 12 h atrás) e termina na hora atual. Fim antes do início
quer dizer que passou da meia-noite (3º turno). O turno é calculado pelo horário de início, com o calendário oficial.

Regras: período de até 12 h, não termina no futuro, máquina do cadastro, e a mesma máquina não pode ter dois
apontamentos no mesmo horário. O ciclo padrão usado fica gravado no apontamento: mudar o ciclo depois não reescreve
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

API: `GET /api/producao/opcoes`, `POST /api/producao/apontamentos`, `PATCH /api/producao/apontamentos/:id`,
`POST /api/producao/apontamentos/:id/motivo`, `GET /api/producao/conferencia?from&to&machine&status`,
`PUT /api/producao/padroes`, `POST /api/producao/padroes/importar-ciclo`.
