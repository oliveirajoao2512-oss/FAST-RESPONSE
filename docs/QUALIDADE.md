# Qualidade · Resposta Rápida

Área do sistema para as não conformidades de **clientes (NC Externa)**, **internas (NC Interna)** e de
**fornecedores (NC Fornecedor)**, no mesmo formato da planilha "Quadro de Resposta Rápida".
Fica no menu **Administração → Resposta Rápida**, logo abaixo de Auditoria.

## Quem acessa

Leitura e alteração: **administradores** e **líderes e gestores cadastrados na área Qualidade**.
Os demais usuários não veem o menu, e o servidor recusa o acesso (403). Para liberar alguém, edite o usuário em
Administração → Usuários e defina perfil Líder ou Gestor com área Qualidade.

## Importar a planilha

1. **Importar planilha** (ou arraste o arquivo .xlsx para a tela).
2. O sistema mostra a **prévia**: ocorrências novas, alteradas (campo a campo), sem alteração e avisos. Nada é gravado ainda.
3. **Confirmar importação**.

Regras da leitura:
- Abas reconhecidas pelo nome: contém "Externa", "Interna" ou "Fornec". A aba CADASTRO alimenta as listas de sugestões.
- O cabeçalho é localizado pela coluna "NÚMERO DA OCORRÊNCIA"; as colunas são lidas pelo título, não pela posição.
- Cada ocorrência ocupa duas linhas: **prazos** (linha do número) e **realizado** (linha de baixo). Na linha de realizado,
  "N/A" marca a etapa como não aplicável e "ON HOLD" como suspensa.
- A chave é **origem + número** (ex.: NC Externa 108/26). Ocorrências que não estão na planilha continuam no sistema.
- Se uma ocorrência foi alterada no sistema depois da última importação e está diferente na planilha, a prévia avisa.
  Por padrão o sistema **mantém** o que foi editado nele; desmarcando a opção, a planilha substitui.
- Colunas calculadas da planilha (fechamento, dias, status, fechado no prazo) não são importadas: o sistema recalcula.

## Regras de status (as mesmas da planilha)

| Etapa | Prazo padrão |
|---|---|
| Contenção | abertura + 24 h (1 dia) |
| Causa raiz | 7 dias |
| Ações corretivas, Poka-yoke | 14 dias |
| Validação da eficácia | 34 dias |
| PFMEA, Plano de controle, Trabalho padronizado, Treinamento | 35 dias |
| LPA, Lições aprendidas | 40 dias |

- **Prazo final** = abertura + 40 dias. **Fechamento** = data realizada de "Lições aprendidas".
- **Concluído no prazo / fora do prazo**: fechamento até o prazo final, ou depois.
- **On hold**: "On hold geral" marcado ou alguma etapa em ON HOLD.
- **Atrasado**: alguma etapa vencida sem data de realização, ou realizada depois do prazo dela.
- **N/A**: incidente não procedente, ou todas as etapas N/A.
- Os indicadores consideram por padrão **só incidentes procedentes** (filtro "Somente procedentes"), como no painel antigo.

## Painel

Indicadores clicáveis (abrem a lista filtrada), **o que precisa de ação agora** (próxima etapa de cada ocorrência,
mais atrasadas primeiro), **farol mensal de reclamações de clientes** (meta zero), ocorrências por mês e origem,
**Pareto** dos problemas (80% destacado), **gargalos por etapa**, clientes/fornecedores e líderes.
Botões: **Copiar resumo** (texto pronto para e-mail/Teams/WhatsApp), **Apresentar** (tela cheia para reunião) e
**Imprimir / PDF**.

## Edição e histórico

Na ocorrência: aba **Etapas** (prazo, data realizada, botões "hoje", N/A e on hold), **Dados da ocorrência** e
**Histórico**. Toda alteração, manual ou por importação, fica registrada com usuário, data e o que mudou; o histórico
não pode ser editado nem apagado. Duas pessoas editando ao mesmo tempo: a segunda recebe aviso para revisar.
Não há exclusão de ocorrências: um incidente não procedente é marcado como "NÃO" em procedente.

## Exportar

**Exportar Excel** gera a planilha no mesmo layout (abas NC Externa, NC Interna, NC Fornecedor, duas linhas por
ocorrência), com status e dias calculados. O arquivo exportado pode ser importado de volta sem alterações.

## Ações sugeridas (viram pendências só com aprovação)

Aba **Ações sugeridas**: para cada ocorrência em aberto e procedente, o sistema sugere **apenas a próxima etapa**
(a primeira sem data realizada), quando ela está vencida ou vence nos próximos 7 dias (ajustável para 15 ou 30).
Assim a lista não acumula: quando a etapa é registrada como realizada, na planilha ou no sistema, a etapa seguinte aparece.

- **Área e responsável sugeridos** pelo nome do líder na planilha ("Leonardo" → usuário ativo cujo nome começa
  por Leonardo, se houver só um). Sem correspondência, a sugestão vai para a área Qualidade sem responsável.
- Antes de aprovar dá para mudar título, área, responsável e prioridade; aprovação individual ou em lote.
- **Criar pendência** abre a pendência na área escolhida (origem "direto"), com os dados da NC na descrição. Prazo:
  o da etapa, quando ainda está no futuro e quem aprova pode definir prazo naquela área; senão, o prazo padrão (D+1).
- Quem aprova só define o responsável onde tem permissão de atribuir (admin, gestor, líder da própria área). Nos
  outros casos a pendência fica "aguardando responsável" e o líder da área é notificado, como em qualquer pendência.
- **Descartar** registra a decisão (com motivo opcional) e a etapa não é sugerida de novo.
- Cada etapa vira no máximo uma pendência. A pendência aparece na etapa da ocorrência e no histórico dela.
