# 01 — CONTRATO DO BOT (Telegram)

> **Implementação de referência (Onda 3):** `worker/surface/commands.ts`,
> `worker/surface/auth.ts`, `worker/surface/core.ts`, `worker/surface/text.ts`,
> `worker/surface/actions.ts`, `worker/providers/telegram/adapter.ts`,
> `worker/providers/telegram/teclado.ts`, `worker/surface/index.ts`.
> Este documento define **o texto EXATO final** (PT-BR) e **o comportamento de
> feedback** de cada resposta do bot, com o mapeamento OLD → NEW.
>
> As descrições seguem o padrão: **Decisão → Porquê (fonte) → Texto final exato.**

FONTES DE PESQUISA citadas aqui:
- **Bot UX**: `/start` herói ≤3 linhas + ≤4 botões; mensagens ≤5 linhas; 1 ação /
  mensagem; edit-in-place; answerCallbackQuery na 1ª linha; breadcrumb/voltar;
  comandos = descoberta, botões = navegação; fallback que acusa + chuta + oferece
  saída; nunca "Invalid command".
- **Menu**: ≤5-8 comandos; descrição 1-4 palavras sem ponto/parênteses; ordem
  principal → status → ações → ajuda; scopes private (tudo) × default (só
  `/start` `/ajuda`); 78 comandos quebram setMyCommands em silêncio (menu vazio);
  rótulo de botão = verbo do resultado; destrua o teclado no 1º clique (anti
  duplo-toque); 3-4 botões/linha; callback_data curtos.
- **Pareamento (RFC 8628)**: código num aparelho, digitado noutro; UMA instrução
  por passo; countdown visível; "gerar novo" sem reiniciar o fluxo; status ao
  vivo aguardando→✓; resposta guiada p/ `/parear` vazio; pós-pareamento = 2
  primeiras ações + aviso de segurança; erros uniformes.
- **Microcopy**: frases curtas, 1 ideia/frase, imperativo com verbo, confirmação
  destrutiva específica, erro que guia à correção sem culpa; bot ≤2 linhas/
  parágrafo + emoji leve.

---

## INVARIANTES DE SEGURANÇA DO BOT (o design PRESERVA)

| # | Invariante | Como o design a respeita |
|---|---|---|
| TG-007 | Allowlist default-DENY | Todo comando/clique passa pelo guard de 2 eixos. O **cartão de controle** só é renderizado ao dono. |
| TG-024 | Identidade revalidada a cada evento | Cada clique revalida `userKey` + `chatKey`. |
| TG-089 | Estranho descartado em silêncio E contado | A um estranho, comando → nenhuma resposta visível (só o girador parado, via answer vazio); clique → answer **vazio**. Contado em auditoria. |
| TG-027 | answerCallbackQuery em TODO caminho | O clique **sempre** responde (mesmo ao negar): empty ou toast genérico, **nunca** estado do túnel. |
| PAIR-006 | `/start` não pareia; boas-vindas IGUAL p/ todos | Mensagem única, nunca diferencia dono × estranho. |
| PAIR-005 | Uma única parelha | Segunda parelha recusada (só o dono recebe explicação). |
| PAIR-007/010 | Teto de tentativas + atraso exponencial; código nunca ecoado | Respostas de erro uniformes; o código NÃO sai do worker/painel. |
| — | Nenhum texto carrega token/código real/endereço/instrução que revele estado a estranho | Auditado em cada string do contrato. |

**O que MUDOU (não de segurança, mas de UX) — para a Onda 3 registrar:**
- A lista publicada (`COMANDOS_PUBLICADOS`) cai de **7 → 5** comandos.
- `answerCallbackQuery` passa a carregar **toast de ação** nas ações do dono
  ("Ligando…", "Desligando…") — a um estranho o answer continua **vazio**.
- O fluxo ganha um **novo comando `/menu`** (cartão de controle, owner-only) e o
  `/start` ganha **botões** (mas só o de /menu resolve para o dono).

---

## 1. O que muda estruturalmente (visão geral)

- **MENU (setMyCommands):** 7 → 5 comandos. `/ligar`, `/desligar`, `/acessar` e
  `/rotacionar` saem do menu e viram **botões do cartão de controle** (`/menu`).
- **NOVO `/menu`:** abre o cartão de controle edit-in-place com o teclado de
  botões. Só o dono alcança (guard); a um estranho é descarte silencioso.
- **NOVO `/ajuda`:** comando de ajuda (owner-only; a um estranho, silêncio).
- **`/start`:** mesmo herói para todos + botão `/menu` (que só resolve ao dono)
  + botão de parear.
- **`/parear`:** sem código → guia o formato (uniforme para todos); já pareado →
  só o dono recebe explicação.

> Os comandos digitados `/ligar`, `/desligar`, `/acessar`, `/rotacionar`,
> `/emergencia` **continuam válidos** (routing intacto). A lista publicada é só
> o menu — não é um fecho do roteador.

---

## 2. MENU publicados (setMyCommands)

### Decisão
Reduzir a lista publicada de 7 para **5 comandos**, na ordem
`/menu` → `/status` → `/parear` → `/emergencia` → `/ajuda`. Ações de manutenção
(`/ligar`, `/desligar`, `/acessar`, `/rotacionar`) saem do menu e viram botões
do cartão de controle, mas continuam funcionando como comandos digitados.

### Porquê (fonte)
Menu curto (≤5-8 comandos); ordem **principal → status → ações → ajuda**; menu
com muita coisa faz o usuário se perder ("muitos botões"). Comandos são para
**descoberta**; botões são para **ação frequente** — as ações de manter o túnel
são ações, logo botões. `/emergencia` permanece para o dono encontrar o pânico
sem pensar (a lista publicada não vaza estado: qualquer um a vê, mas só o dono
executa — o guard barra o resto).

### Texto EXATO final — `COMANDOS_PUBLICADOS` (Onda 3)

**OLD (7):**
```
/ligar      — Liga o túnel de acesso (pede confirmação)
/desligar   — Desliga o túnel (pede confirmação)
/status     — Estado atual: túnel, tempo no ar e quando expira
/acessar    — Envia o link com a sua chave de acesso
/rotacionar — Gera chave nova e invalida a anterior (pede confirmação)
/parear     — Parear com o código <código> mostrado no terminal
/emergencia — Emergência: desliga o túnel e este bot
```

**NEW (5):** descrições imperativas, 1-4 palavras, sem ponto nem parênteses.
```
/menu       — Abrir o painel de controlo
/status     — Ver estado do túnel
/parear     — Parear com um código
/emergencia — Derrubar tudo de imediato
/ajuda      — Ver como usar
```

> **Nota de implementação para a Onda 3:** o teste em
> `test/unit/worker/surface/commands.test.ts:41` assere `length === 7` e a ordem
> `['ligar','desligar','status','acessar','rotacionar','parear','emergencia']`.
> Ele **precisa ser atualizado** para 5 e a nova ordem/`/menu`/`/ajuda`, e o caso
> de `não publicar /start` permanece.

### Escopo do menu (private × default) — documentação

- **`/start`, `/ajuda`** → publicados no escopo `default` (grupos e privado):
  são a única descoberta segura para toda a gente e não vazam estado.
- **`/menu`, `/status`, `/parear`, `/emergencia`** → publicados no escopo
  `private` (só DM com o bot): são acções/estado; em grupos qualquer comando é
  barrado pelo guard, então restringir a descoberta ao privado reduz o "porquê
  não funciona" em grupo.
- **Viável hoje?** `setMyCommands` do grammY aceita `scope` e `language_code`
  (Bot API `BotCommandScope`). O `publishCommands` atual do adaptador chama
  `setMyCommands(lista)` **sem escopo** (default = tudo). Para aplicar scopes, a
  Onda 3 publica `setMyCommands` DUAS vezes: uma `default` (start/ajuda) e uma
  `private` (menu/status/parear/emergencia). **Se o gancho host não expuser
  escopos, prioridade:** enviar a lista de private num `setMyCommands` único e
  documentar a limitação — NUNCA mais de 6 comandos por escopo (caso real: 78
  quebram em silêncio).

---

## 3. `/start` — boas-vindas (IGUAL para todos)

### DECISÃO (a mais sensível): `/start` 100% igual para toda a gente.

Mantém-se a invariante PAIR-006 **byte a byte em intenção**: a mesma mensagem a
quem é dono e a quem não é, sem nunca afirmar nada sobre o estado do túnel nem
sobre quem já pareou.

**Porquê (fonte + segurança):** o Device-Flow e o bot UX pedem um `/start`
"herói" que orienta (≤3 linhas + ≤4 botões). Porém IP, diferenciar a resposta
por `é dono?` transformaria o `/start` num **oráculo de estado**: "você já está
pareado" vs "pares primeiro" vaza ao estranho que existe um túnel ligado/parado.
Como revelar que **existe** `/parear <código>` é aceitável (o código é o
segredo), o `/start` é o mesmo para todos e aponta para o pareamento. O
**controle** fica em `/menu` (guard-gated, silêncio a estranho) — o dono chega
lá pelo botão, o estranho não recebe nada.

**Risco residual (documentado e aceite):** a um estranho que aperte o botão
`/menu` do `/start`, o guard descarta em silêncio (TG-089) — ver §4 nota de
estranho. Não há resposta que revele estado.

### Texto EXATO final — `RESPOSTA_BOAS_VINDAS` (auth.ts)

**OLD:**
```
Olá. Este bot é privado e responde apenas ao dono da máquina onde está instalado.
```

**NEW (herói ≤3 linhas + botões; 1 ação por passo):**
```
👋 Olá. Este bot controla o acesso ao teu Harness pelo Telegram.

Antes de mais nada, pareie-o: gere um código no painel e envie:
   /parear 123456

Depois, abra o menu para ligar e desligar o túnel.
```

- **Botões do `/start`** (apenas 2, um deles de acção): `[🔘 Abrir menu]` →
  `/menu`; `[ℹ️ Ajuda]` → `/ajuda`. A um estranho, o `[🔘 Abrir menu]` não abre
  nada (silêncio) — o rótulo é genérico, não vaza.
- **Sem token/jargão:** "Harness" é o nome do produto; sem "túnel" pesado no herói.

> **Implementação:** `RESPOSTA_BOAS_VINDAS` em `worker/surface/auth.ts`. Os
> botões do `/start` renderizam via `actionRows` (2 botões `/menu` e `/ajuda`).

---

## 4. Cartão de CONTROLE (`/menu` + pós-pareamento)

O **cartão de controle** é a mensagem edit-in-place que concentra as acções do
dono: estado visível (✅/⬜) + teclado de botões. Abre via **`/menu`** e, na
primeira parelha, vem já na resposta de sucesso (pós-pareamento).

### Estrutura da mensagem do cartão

```
🎛️ Controlo do Harness

Túnel: ✅ Ligado · link no ar há 3 h
        (ou: ⬜ Desligado — nada exposto)

[🟢 Ligar]        [🔴 Desligar]
[📶 Status]      [🔗 Link de acesso]   [⇄ Nova chave]
[🚨 Emergência]
[🏠 Início]
```

### Decisões do teclado do cartão — Porquê & Texto

| Botão | Label EXATO | Acção | Nota de feedback |
|---|---|---|---|
| Ligar | `🟢 Ligar` | `tunnel.up` (2 etapas: tela de confirmação) | toast "Ligando…" |
| Desligar | `🔴 Desligar` | `tunnel.down` (2 etapas: tela de confirmação destrutiva) | toast "Desligando…" |
| Estado | `📶 Status` | `tunnel.status` (edita o cartão com o estado) | toast vazio (a edição mostra) |
| Link de acesso | `🔗 Link de acesso` | `session.issue` (vem por notify) | toast "A enviar o link…" |
| Nova chave | `⇄ Nova chave` | `secret.rotate` (2 etapas: confirmação) | toast "Gerando chave nova…" |
| Emergência | `🚨 Emergência` | `emergency` (2 etapas: confirmação destrutiva) | toast "A derrubar tudo…" |
| Início | `🏠 Início` | re-abre o cartão / mensagem inicial | — |

- **Regra 1 (feedback na 1ª linha, TG-027):** todo clique de botão no cartão
  chama `answerCallbackQuery` na **primeira instrução** de tratamento, com o
  toast da coluna Nota (a um estranho, **vazio**). Sem isso o girador fica ~30 s
  e o botão parece "morto" — a reclamação nº2 do usuário. Fonte: bot UX /
  teclados.
- **Regra 2 (anti duplo-toque):** o teclado é destruído no 1º clique
  (`editMessageReplyMarkup([])` vazio) para um duplo-toque não disparar duas
  acções. Fonte: teclados — "destrua o teclado no 1º clique".
- **Regra 3 (estado visível):** o cartão mostra `✅ Ligado` / `⬜ Desligado` como
  primeira linha, editada pela difusão de estado (o mecanismo `mostrarEstado`
  existente).
- **Regra 4 (ações destrutivas — tela de confirmação):** ações que derrubam/%
  rotacionam pedem confirmação explícita:

  **Desligar:**
  ```
  🔴 Desligar o túnel derruba o acesso remoto. Continuar?
  [✅ Sim, desligar]  [✕ Não]
  ```
  **Emergência:**
  ```
  🚨 Emergência derruba o túnel E desliga este bot. Não dá para desfazer. Continuar?
  [✅ Sim, emergência]  [✕ Cancelar]
  ```
  **Nova chave:**
  ```
  ⇄ Gerar chave nova invalida a atual e as sessões abertas. Continuar?
  [✅ Sim, gerar]  [✕ Não]
  ```
  - O botão `[✕ Não]` faz `answerCallbackQuery('Ok, cancelado.')` e **edita a
    mensagem no lugar** para `Cancelado. Nada foi alterado.` com o **teclado
    destruído** (voltar sem efeito — anti duplo-toque, Regra 2; **sem** executar a
    acção nem enviar intent/de armazenar nonce — Onda 5); o botão `[✅ …]` executa.
    Fonte: teclados + microcopy (confirmação destrutiva específica "isto vai…",
    "não dá para desfazer").

- **Regra 5 (pós-ação destrói e resume):** após qualquer acção, a mensagem vira
  um **resultado claro em 1-2 linhas sem botões** (teclado removido). Ex.
  desligado: `Túnel desligado. Nada ficou exposto. Envie /menu para reabrir.`

### Toast EXATO do answerCallbackQuery (dono)

| Ação | toast (`text`) |
|---|---|
| `tunnel.up` confirmado | `Ligando…` |
| `tunnel.down` confirmado | `Desligando…` |
| `secret.rotate` confirmado | `Gerando chave nova…` |
| `session.issue` | `A enviar o link…` |
| `emergency` confirmado | `A derrubar tudo…` |
| botão de confirmação `[✅ …]` | vazio (a edição mostra) |
| botão `[✕ Não]` (cancelamento) | `Ok, cancelado.` + edita a mensagem para `Cancelado. Nada foi alterado.` (teclado destruído) |
| **estranho / inseguro** | **vazio (sem texto)** |

> **Mapa OLD → NEW dos rótulos atuais (Onda 3):**
> - `✅ Sim, ligar` → mantém-se (tela de confirmação do Ligar).
> - `⛔ Sim, desligar` → `✅ Sim, desligar` (consistência: o ✅ confirma; o 🔴 é do
>   botão-mãe). `worker/providers/telegram/teclado.ts` não guarda rótulos (só
>   renderiza `ActionRow.label`); quem define labels é `worker/surface/commands.ts`
>   e `actions.ts`.
> - `✅ Sim, rodar` → `✅ Sim, gerar` (rótulo = verbo do resultado).
> - Alertas de notify (`actions.ts`): `Não fui eu`/`Derrubar túnel agora`/
>   `Encerrar` → mantidos (são emergência, verb-first, curtos).

---

## 5. Respostas dos comandos (todas reescritas — 1-3 linhas)

### `/status` — `textoDeEstado` (text.ts) + `/menu`

**OLD** (formato técnico, com `Sequência:`, códigos EN):
```
Estado: online (READY)
Sequência: 42
Túnel: https://...
No ar há: 3 h
Expira: em 30 min (12:34)
```

**NEW** — Estado em 1-2 linhas + resultado, PT-BR, sem "Sequência":
```
📶 Túnel *online* há 3 h.
Link: https://…
Expira daqui a 30 min.
```
- Desligado: `Túnel desligado. Nada ficou exposto.`
- Falha: `Túnel parado por um erro. Precisa de ação tua — vê o painel.`
- Estado desconhecido: `Estado ainda desconhecido do host. Tenta de novo em
  alguns segundos.`

> **Implementação nova (Onda 3):** criar um `textoDeEstadoCurto` que some `seq`/
  código EN à linha de debug (log) e mostre só o essencial; `textoDeEstado`
  atual mantém-se no log de auditoria. `/status` pode editar o cartão de
  controle (se existir) em vez de mandar mensagem nova.

### `/acessar` (link de acesso)

**OLD (sem resposta local; vem por notify):** hoje o aceite é invisível
(TG-085). **NEW:** acusa o pedido para o botão não parecer morto:
```
🔗 A enviar-te o link de acesso por aqui…
```
(o link real chega por notify, como hoje — TG-085 preservado).

### `/rotacionar` — tela de confirmação
**OLD:** `Gerar uma chave de acesso nova? A anterior será revogada e as sessões atuais invalidadas.`
**NEW:** `⇄ Gerar chave nova invalida a atual e as sessões abertas. Continuar?`
→ botões `[✅ Sim, gerar] [✕ Não]`. (Consistência com o cartão, §4.)

### `/desligar` — tela de confirmação
**OLD:** `Desligar o túnel?` `[⛔ Sim, desligar]`
**NEW:** `🔴 Desligar o túnel derruba o acesso remoto. Continuar?`
→ botões `[✅ Sim, desligar] [✕ Não]`.

### `/ligar` — tela de confirmação
**OLD:** `Ligar o túnel de acesso? Quando abrir, o link... será enviado aqui automaticamente.`
**NEW:**
```
🟢 Ligar o túnel agora? Quando abrir, o link de acesso chega aqui por si só.
```
→ botões `[✅ Sim, ligar] [✕ Não]`.

### `/emergencia`
**OLD:** `Emergência: a desligar o túnel e este bot.`
**NEW:** `🚨 Emergência disparada. Túnel a desligar e este bot vai encerrar.`

### Ações destrutivas — respostas finais claras

- Ligado OK: `Túnel ligado. Link enviado aqui.` / no-op: `Túnel já estava ligado.`
- Desligado OK: `Túnel desligado. Nada ficou exposto.` / no-op: `Túnel já estava desligado.`
- Chave nova OK: `Chave nova gerada. O link antigo deixou de funcionar.`

### Recusas de segurança — `textoDeRecusa` (core.ts) OLD→NEW

| Código | OLD | NEW |
|---|---|---|
| `SHUTDOWN_IN_PROGRESS` | O túnel está a desligar. Mande o comando de novo em alguns segundos. | Túnel a mudar de estado. Tenta de novo em alguns segundos. |
| `EXPOSURE_DISABLED` | A exposição está desligada na configuração (exposure.mode não é "tunnel"). | A exposição remota está desligada nesta máquina. Não dá para ligar pelo bot. |
| `RESTRICTED_MODE` | O modo restrito está ativo; não é possível ligar pelo bot. | O modo restrito está ativo nesta máquina. Usa o painel local. |
| `PROBE_FAILED` | A barreira de segurança não passou no teste; o túnel não sobe. | A verificação de segurança falhou; o túnel não sobe. Vê o painel. |
| `TUNNEL_FAILED` | O túnel está em estado de falha; é preciso ação sua na máquina. | Túnel parado por erro. Precisa de ação tua na máquina. |
| `NOT_PAIRED` | Este bot ainda não está pareado. | Ainda não está pareado. Gera um código no painel e envia `/parear`. |
| `NONCE_INVALID` | Confirmação inválida ou expirada. Mande o comando de novo. | Confirmação expirada. Envia o comando de novo. |
| `RATE_LIMITED` | Demasiados pedidos; tente mais tarde. | Pedidos demais. Espera um pouco e tenta de novo. |
| `INTERNAL` | Ocorreu um erro interno. | Algo falhou no meu lado. Tenta de novo. |

---

## 6. Fallback e comandos desconhecidos

**OLD:** `Não conheço este comando.`
**NEW (acusa + chuta + oferece saída — fonte bot UX):**
```
Não entendi. Queres fazer o quê?
[🔘 Abrir menu]  [📶 Estado]  [ℹ️ Ajuda]
```
- **Só o dono recebe isto** (um estranho é descartado em silêncio, TG-089). Para
  texto livre (não-comando) com o dono, mesma resposta + botões.
- Mapear: `worker/surface/core.ts:624` (`enviarPara(..., 'Não conheço este comando.')`).

---

## 7. Respostas de PAREAMENTO (auth.ts)

### `/parear <código>` — CERTO
**OLD:** `Pareado. Este chat passa a ser o único autorizado a comandar este bot.`
**NEW:**
```
✓ Pareado com sucesso! Agora:
  • /menu — painel de controlo
  • /status — estado do túnel

Segurança: só este chat pode comandar o bot.
```
(2 primeiras ações + aviso de segurança numa linha — fonte pareamento/microcopy.)

### `/parear <código>` — ERRADO ou inexistente (UNIFORME)
**OLD:** `Nao foi possivel parear. Confirme o codigo no terminal da maquina e tente de novo.` (`RESPOSTA_PAREAMENTO_RECUSADO`)
**NEW (mesma frase para qualquer código errado/inexistente/expirado — sem oráculo):**
```
Código errado ou expirado. Confere no painel e tenta de novo.
```
> A mesma string para `refuse:wrong-code` e `refuse:expired` (PAIR-003, sem
> oráculo). Mantém o atraso exponencial e o teto de tentativas intactos.

### `/parear` SEM código (sonda)
**HOJE:** silêncio total (`refuse:malformed`, reply `undefined`). **DECISÃO:**
manter o **silêncio para estranho**, mas **ao dono-pareado em `/menu`** o roteador
pode orientar (via fallback, §6). Um `/parear` vazio de um estranho segue
descarte silencioso + contagem (TG-089) — responder orientaria quem não pareou a
procurar o fluxo e é aceitável (o código é o segredo), **mas manter silêncio
evita dar pistas de que `/parear` existe**. **Resolução da Onda 3:** ao dono já
pareado, `/parear` vazio → "Ainda não usas códigos — este chat já está pareado.";
a um estranho, silêncio. (Ver "já pareado" abaixo.)

### Já pareado (PAIR-005)
**OLD:** `Este bot ja esta pareado. Para trocar de dono, rode --reset-pairing...` (`RESPOSTA_JA_PAREADO`)
**NEW — só ao dono recebe explicação; estranho, silêncio:**
```
Este bate-papo já é o dono deste bot. Para trocar o dono, reset na máquina.
```

### Fallback de `/parear` sem código para quem ainda "tenta" — resposta guiada (fonte pareamento)
Ao dono (quando ainda não há parelha, num estado seguro de pareamento): o
comando `/parear` vazio responde:
```
Envia /parear seguido do código de 6 dígitos que aparece no painel, assim:
   /parear 123456
```

---

## 8. BotFather — perfil recomendado (o dono aplica)

| Campo | Valor recomendado |
|---|---|
| name | `DSH Messenger` (nome curto, sem "bot" no fim obrigatório aqui; ver abaixo) |
| short_description | `Controle o acesso ao teu Harness pelo Telegram.` |
| about | `Bot privado do dono. Ligue, desligue e acompanhe o túnel do DeepSeek Harness.` |

> **Nota:** name em BotFather não pode ser `...bot` (o sufixo fica no @username).
> Sugestão de @username: `seu_dsh_messenger_bot`. A documentação de BotFather
> recomenda descrição em 1 frase e about curta; isto é texto que o DONO aplica
> manualmente no Telegram/BotFather, não código.

---

## 9. Índice dos arquivos-alvo da Onda 3 (log)

- `worker/surface/commands.ts` — `COMANDOS_PUBLICADOS` (7→5), rótulos de botão de
  `ligar`/`desligar`/`rotacionar` (§4/§5), novo `/menu` e `/ajuda`.
- `worker/surface/auth.ts` — `RESPOSTA_BOAS_VINDAS`, `RESPOSTA_PAREAMENTO_RECUSADO`,
  `RESPOSTA_JA_PAREADO`, novo "parear sem código" guiado.
- `worker/surface/core.ts` — fallback (`Não conheço...`→§6), `textoDeRecusa`
  (§5), `/menu` como novo slot de navegação, toasts de answer (§4).
- `worker/surface/text.ts` — novo `textoDeEstadoCurto` (§5); `textoDeEstado`
  mantido no log.
- `worker/surface/actions.ts` — toasts/`kind` de botões do cartão (§4).
- `worker/providers/telegram/adapter.ts` / `teclado.ts` — suporte a destruir
  teclado (editMessageReplyMarkup) e a `setMyCommands` com escopo (§2).
- `test/unit/worker/surface/commands.test.ts` — atualizar lista (5) e ordem.