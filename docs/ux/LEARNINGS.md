# LEARNINGS — Onda 1 "nome + botões" (dsh-guard-messenger)

Aprendizados registrados nesta onda, com a causa raiz e o fix de cada um, para
as próximas não repetirem o erro nem re-introduzirem o bug.

## 1. Bug do botão 🟢 Ligar do cartão (crítico) — diagnóstico e fix

### Sintoma (runtime real)
Com o dono pareado e o cartão de controlo (`/menu`) aberto, o botão **🟢 Ligar**
"dava erro e não ligava" e o **📶 Status** "não funcionava". O log do CLI não
recebia o stderr do worker, por isso o erro não era observável ao vivo — foi
preciso reproduzir pelo CÓDIGO/TESTES (ver o handoff da Onda 1).

### Causa raiz (reproduzida em teste — `test/unit/worker/surface/card-fluxo.test.ts`)
O cartão era renderizado/editado in-place (`mostrarEstado`/`exibirCartao`), mas
os fluxos de **2 etapas** iniciados por um botão do cartão (Ligar, Desligar,
Nova chave) **não editavam o próprio cartão**: chamavam `ctx.enviar(...)` e
mandavam uma **mensagem de confirmação NOVA e destacada**. Consequências:

- O `messageTarget` da confirmação ficava **diferente** do cartão. No ack, o
  `onAck` editava a mensagem destacada e **re-apontava**
  `ultimaMensagemDeEstado` para ela —
  `worker/surface/core.ts` (antes do fix) — deixando o **cartão "órfão"**: nunca
  era re-renderizado com o estado novo. O dono via o botão/toast mas o cartão
  não mudava → "Ligar não liga".
- O `/status` usava **answer vazio** (`sender.answer(target)` sem `text`), então
  quando o estado do túnel **não mudava** a re-renderização caía em
  `isNotModified` → o dono *não via nada acontecer* → "Status não funciona".

### Fix (mínimo necessário, `worker/surface/core.ts` + `commands.ts`)
1. **Confirm reutiliza o MESMO messageTarget (fix do Ligar):** quando um botão
   de MENU do cartão inicia um fluxo de 2 etapas, a confirmação agora é
   **editada no próprio cartão**. As assinaturas `ligar/desligar/rotacionar`
   ganharam um `alvoDeEdicao?: string` opcional; com ele o `commands.ts` usa
   `ctx.editar(chat, alvoDeEdicao, …)` (novo helper `mostrarConfirmacao`) em vez
   de `ctx.enviar`. O ack, com `messageTarget = id do cartão`, re-renderiza o
   cartão com o estado novo.
2. **Distinguir MENU × CONFIRMAÇÃO na MESMA mensagem:** um mapa
   `confirmacaoNoCartao: Map<chat, SurfaceAction>` marca, por chat, a acção cuja
   confirmação o cartão mostra agora. Enquanto ativa, uma re-renderização por
   difusão de estado **não destrói** a tela de confirmação (o cartão não é
   re-editado), e o clique do `[✅ …]` com a MESMA acção é tratado como
   CONFIRMAÇÃO (envia o intent com nonce + messageTarget = cartão). O `✕ Não`
   restaura o menu no mesmo cartão.
3. **Status responde toast e re-renderiza:** `/status` passou a responder com o
   toast `Verificando…` (feedback imediato mesmo quando o estado não mudou) e o
   ack re-renderiza o cartão com o estado autoritativo.

### Como ficou verificado
- `test/unit/worker/surface/card-fluxo.test.ts` — o caminho REAL completo:
  montar cartão → press `tunnel.up` → toast → nonce → EDICAO do cartão
  (confirm) → press confirm → intent com nonce → ack → cartão re-renderizado; e
  o mesmo para `tunnel.status`.
- `core.test.ts` §CONTRATO §4/ (botoes do cartão) actualizado: Ligar/Desligar
  EDITAM o cartão (não é nova mensagem).

### Regra que fica (preservar)
- **NUNCA** "consertar" o Ligar desligando a exigência de nonce+confirmação para
  acções que aumentam exposição (TG / CTL-023/024) — a causa era outra: o
  messageTarget do confirm não era o cartão.

## 2. Cartão: teclado 1-por-linha e remoção do botão 🏠 Início

- O cartão de controlo passou a renderizar **UMA acção por linha** (coluna
  única — respeita `maxActionPerRow: 1` dos limites) e o botão **`🏠 Início`
  foi REMOVIDO** (o cartão já é o "início"). Confirmadores destrutivos
  `[✅ …][✕ Não]` continuam 2/linha (são telas de confirmação, não o menu).

## 3. Menu publicado: remover `status` e `emergencia`

- `emergencia` e `status` saíram de `COMANDOS_PUBLICADOS` (ficam SÓ como botões
  do cartão). Os comandos digitados `/emergencia` e `/status` **continuam
  válidos** (routing intacto); só deixaram de aparecer na lista do BotFather.
  Menu privado final: `[/menu, /parear, /ajuda]`; default: `[/ajuda]`. O mapa de
  escopos do adaptador (`worker/providers/telegram/adapter.ts`) foi actualizado.

## 4. Rebrand "Remote Access"

- Nome VISÍVEL no painel: "Telegram Guard" → **"Remote Access"** (label da aba
  `settings.section`, `h2` do painel, textos correlatos). Manteve-se o logo
  `guard-brand`, o `id` da secção `telegram-guard`, o `registrant` e o pacote
  `dsh-guard-messenger` — **só o nome exibido mudou**.
- Bot: o título do cartão `🎛️ Controlo do Harness` → **`🎛 Remote Access`**.
  `/start` e ajudas mantêm PT-BR (podem citar "Remote Access" como nome).