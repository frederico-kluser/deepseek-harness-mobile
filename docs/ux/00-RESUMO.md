# 00 — RESUMO DA SÍNTESE DE UX (Onda 2)

> **Papel:** contrato de design que as Ondas 3 (bot) e 4 (painel) seguem à letra.
> **Escopo:** SÓ este `docs/ux/` — nenhum código é tocado aqui.

---

## As reclamações do usuário e o que cada uma vira

| Reclamação | Decisão de UX (onde está detalhada) |
|---|---|
| "Muita informação, não entendo nada" | Mensagens ≤ 5 linhas, 1 ação por mensagem, um menu curto (5 cmds), painel por **estado** com um CTA por vez. Docs `01`/`02`. |
| "No bot aperto os botões e nada acontece" | **feedback em todo clique** (answerCallbackQuery na 1ª linha + edição in-place + teclado destruído ao concluir). Docs `01` §4-§5. |
| "Não sei onde pôr o código" | Fluxo de pareamento em **um passo** no painel: código em caixa espaçada + "Copiar" + UMA instrução + countdown. Docs `02` §Checkpoint 2. |
| "Muitos botões no menu" | Menu de 7 → **5 comandos**; ações de controle viram **botões do cartão** (os comandos digitados continuam válidos). Docs `01` §2. |
| "Textos melhores; mude tudo" | Reescrita PT-BR de todas as respostas do bot + todos os rótulos do painel. Docs `01`/`02`, o guia de estilo em `03`. |

---

## Decisões-chave (o essencial)

### 1. Menu final (setMyCommands) — 5 comandos
`/menu`, `/status`, `/parear`, `/emergencia`, `/ajuda`.

`/ligar`, `/desligar`, `/acessar` e `/rotacionar` **saem do menu** e viram
**botões do cartão de controle** (`/menu`); os comandos **digitados continuam a
funcionar** (routing intacto — a lista publicada é só o menu). `/start` continua
**de fora** do menu (PAIR-006). Detalhes em `01` §2.

### 2. `/start` — boas-vindas IGUAL para toda a gente
Invariante **mantida** (PAIR-006): a mensagem é a mesma para quem é dono e quem
não é. Ela é um herói curto + o passo 1 para parear, e nunca revela estado do
túnel nem capacidade sensível. Detalhes em `01` §3.

### 3. Fluxo de pareamento — respostas uniformes, código nunca sai da máquina
Errado/inexistente/expirado respondem a **mesma frase genérica**; teto de
tentativas e atraso exponencial **preservados**; o código só existe no painel e
no worker. Detalhes em `01` §7.

### 4. Painel — trilha por ESTADO (3 checkpoints)
A aba "Telegram Guard" passa a mostrar **só o passo atual**: (1) Criar o bot,
(2) Parear, (3) Usar. Progresso indicado por checkpoints ✓; detalhes/avançado
dobrados em `<details>`. Um **CTA primário por estado**. Detalhes em `02`.

### 5. Decisão `/start`-igual-**vs**-só-dono (a mais sensível)
**DECISÃO: `/start` fica 100% igual para todos.** O painel de controle fica em
`/menu`, que **só o dono alcança** (passa pelo guard de allowlist; a um estranho
o `/menu` é descartado em silêncio — TG-089 — sem resposta, sem contagem visual).
**Justificativa de segurança:** diferenciar `/start` por "é dono ou não" daria a
quem ainda não pareou (ou a um estranho) um **oráculo** sobre o estado — p.ex.
"você já pareou" vs "você não pareou" desbloqueia informação sobre o túnel. Como
a instrução de parear (revelar que existe `/parear <código>`) é aceitável para
todos (o código é o segredo), o `/start` aponta para o pareamento sem afirmar
nada sobre o estado do túnel. Quem já é dono usa `/menu` para comandar. → Decisão
documentada com risco/leak no final de `01` §3.

---

## Invariantes de segurança preservadas (como cada decisão as respeita)

- **Allowlist default-DENY (TG-007) + identidade revalidada (TG-024):** todos os
  comandos e cliques continuam a passar pelo guard de dois eixos. O **cartão de
  controle só é renderizado para o dono**; a um estranho, qualquer comando é
  descartado em silêncio e contado.
- **Estranho descartado em silêncio (TG-089):** nenhuma resposta nova a estranho
  diz se há túnel ligado nem lista capacidades sensíveis. O **answerCallbackQuery
  pode ser vazio** ou genérico (TG-027) — nunca carrega estado.
- **`/start` não pareia (PAIR-006):** invariante mantida e documentada.
- **Pareamento uniforme (sem oráculo):** código errado/inexistente/expirado → a
  mesma frase; teto por chat/global e atraso exponencial **preservados**.
- **Código nunca sai da máquina:** só no painel; nenhuma resposta do bot ecoa o
  código (PAIR-010).
- **Uma única parelha (PAIR-005):** mantida — uma segunda parelha é recusada.
- **Texto nunca carrega token, código real, endereço ou instrução que revele o
  estado do túnel a estranhos.**

---

## O que as Ondas 3 e 4 mudarão em código (sinalização)

Ver "Log dos arquivos-alvo" no final de cada contrato; em `03` §4 a lista por
arquivo e por texto. Nenhuma invariante de segurança é relaxada: só texto/layout/
feedback mudam.

---

## Índice dos contratos

- `01-CONTRATO-BOT.md` — menu, `/start`, cartão de controle, respostas a todos os
  comandos, respostas de pareamento, BotFather; invariantes de segurança do bot.
- `02-CONTRATO-PAINEL.md` — a trilha de 3 checkpoints da aba "Telegram Guard",
  cada estado com CTA, rótulos e textos EXATOS; invariantes de segurança do painel.
- `03-MICROCOPY.md` — guia de estilo consolidado (13 regras), banco de frases e o
  glossário para as Ondas 3-4 não criarem texto inconsistente.