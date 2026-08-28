---
name: dsh-telegram-provider
description: >-
  Use ao trabalhar no adaptador Telegram deste repo
  (dsh-guard-messenger) — implementar, corrigir, testar ou portar o
  `worker/providers/telegram/**`. Cobre a gramática do callback_data `g1`, os
  limites 4096/1/1/64/supportsEditing, o long polling (sequência de boot,
  409→11 / 401→12 / boot 45 s→14, retry_after do 429), answerCallback SEMPRE
  (TG-027), edição in-place (isNotModified), o token TELEGRAM_BOT_TOKEN /
  TELEGRAM_API_ROOT, o mapeamento update→evento e o duplo de teste.
  Referencia a skill `dsh-provider-bot` para a arquitectura e o contrato neutro
  — NÃO duplica o contrato.
---

# Adaptador Telegram (dsh-telegram-provider)

Referência de implementação do **adaptador Telegram** deste repo. É a
referência concreta a partir da qual qualquer outro provedor é criado.

> **Hierarquia:** a arquitectura de provedores (entry→registry→adapter→core→
> bridge→IPC), o contrato neutro tipo-a-tipo, o passo-a-passo genérico para
> criar um provedor e a checklist de aceite estão na skill
> **`dsh-provider-bot`**. Este ficheiro cobre **SÓ o telegram-específico** e
> referencia a genérica — não duplique o contrato aqui.

- Língua do repo: **PT-BR**.
- Raiz do repo (`$REPO`): worker = `$REPO/worker/**`; adaptador telegram =
  `$REPO/worker/providers/telegram/**`; contrato neutro =
  `$REPO/worker/surface/contract.ts`; contrato IPC =
  `$REPO/src/contracts/ipc.ts`; testes = `$REPO/test/**`.
- O grammY é a **única dependência de runtime** do pacote e é carregado **só**
  pelo adaptador telegram. O código fora de `worker/providers/telegram/**` não
  conhece o grammY.

---

## 1. Grafo de ficheiros — um parágrafo por ficheiro (todos em `$REPO/worker/providers/telegram/`)

Ficheiros: **`cliente.ts` · `polling.ts` · `parse.ts` · `teclado.ts` ·
`token.ts` · `transporte.ts` · `adapter.ts` · `interno.ts`**. Todos com a marca
de fronteira D4: PORTEAM (não importam de módulos de fora do próprio
`telegram/**`) os auxiliares estruturais — o `interno.ts` agrega relógio, espera,
logger, mascaramento, portados dos `worker/lib/*` que sobrevivem (`clock.ts`,
`log.ts`, `redact.ts`). **EXCEÇÃO SANCTIONADA (Onda 3-fix):** o CONTRATO DE
ERRO — `ProviderError`, `WorkerExitCode`, `WORKER_EXIT`, `exitCodeFor`,
`isWorkerExitCode` — é canônico em `worker/lib/errors.ts` (o ÚNICO
`worker/lib/*` que o adaptador importa) e o `interno.ts` RE-EXPORTA-o; o
`ProviderErrorCode` legível (as causas do telegram) continua definido AQUI.

- **`cliente.ts`** — o cliente grammY: `createTelegramBot({ token, apiRoot?,
  log, time, autoRetry? })` → `Bot<Context>`. Faz `sensitiveLogs: false`
  EXPLÍCITO (para a `toHttpError` não citar a URL com o token dentro), normaliza
  a barra final do `apiRoot` (`normalizeApiRoot`, o grammY lança com barra),
  valida o token vazio AQUI (o `Bot` do grammY aceita vazio e só falha no
  `getMe` com 404), instala os DOIS transformers (transporte-log PRIMEIRO,
  encostado à rede; auto-retry por fora) e `bot.catch` cobrindo `GrammyError` E
  `HttpError` (esquecer o `HttpError` deixa o processo morrer por queda de
  rede). O `bot.catch` NÃO cobre a rede do polling (o ciclo de `getUpdates` não
  passa por middleware) — essa testemunha é o transporte-log.

- **`polling.ts`** — o long polling: `runPolling({ bot, log, options, secrets?,
  bootTimeoutMs? })` → `PollingOutcome`. Sequência de boot do grammY
  (`getMe → deleteWebhook{drop_pending_updates:true} → getUpdates`),
  `allowed_updates: ['message','callback_query']`, `timeout: 50`
  (`LONG_POLL_MAX_TIMEOUT`), `drop_pending_updates: true` (o represado de até
  24 h não executa de uma vez). **409 (`POLLING_CONFLICT`) → exit 11** e **401
  (`POLLING_UNAUTHORIZED`) → exit 12**, ZERO reconexões (classificação terminal
  — o 409 mata a instância que já estava pendurada, nunca a que chega; reiniciar
  cegamente vira flapping). **Prazo de boot `DEFAULT_BOOT_TIMEOUT_MS` = 45 s**
  → `BOOT_TIMEOUT` → exit 14 (medido: um bug de unidades no `withRetries` do
  `getMe` pode dormir 100 s). `assertPollingOptions` lança se
  `allowed_updates` omitido/vazio (vazio = "reset para o default", abre a
  superfície fechada), `timeout` ausente/>50, ou `drop_pending_updates !== true`.

- **`parse.ts`** — o parsing cru de update → `SurfaceEvent`. Deteta a superfície
  (`detectSurface`), extrai `from.id`/`chat.id` do SÍTIO CERTO de cada superfície
  (num `callback_query`: `from` vem de `cq.from` — QUEM CARREGOU — e `chat` de
  `cq.message.chat.id` — ONDE — TG-003), converte para STRINGS (D4)
  (`toSurfaceIdentity`), valida `isTelegramId` (`Number.isSafeInteger`, aceita
  negativos de supergrupo/canal). Contém `buildCallbackData`/`parseCallbackData`
  (gramática da §2) e `INCREASES_EXPOSURE` (espelho de `IpcIntentName`).
  Mantém o contador `descartados` (TG-089 — "descartado e contado"). **NUNCA lê
  `username`** (a allowlist é numérica, TG-008) — o teste estrutural assere isso.

- **`teclado.ts`** — a saída visual: `renderActionRowLayout(ActionRowLayout) →
  InlineKeyboardMarkup` (cada `ActionRow` vira um botão com
  `callback_data = buildCallbackData(action, token)`); `assertCallbackData`
  (2ª linha de defesa dos 64 bytes); `answerCallbackAlways` (NUNCA lança);
  `editMessageTextInPlace` (`'edited' | 'unchanged' | 'failed'`); `isNotModified`
  (reconhece «Bad Request: message is not modified» como `unchanged`, não falha).

- **`token.ts`** — o token telegram: `TOKEN_ENV_VAR = 'TELEGRAM_BOT_TOKEN'` e
  `API_ROOT_ENV_VAR = 'TELEGRAM_API_ROOT'`. `lerTokenDoAmbiente(env)` lança
  `ProviderError` com `reason: 'TOKEN_MISSING'` e `code` numérico CONFIG (10)
  se ausente (a mensagem NÃO cita o valor).
  `assertTokenNotInArgv(argv, token)` (TG-069: `/proc/<pid>/cmdline` é legível
  por qualquer processo local; token NUNCA em linha de comando) — duas checagens:
  a literal (apanha o nosso token mesmo se o formato mudar) e a de forma
  (`BOT_TOKEN_SHAPE`), que apanharia o token de OUTRO bot.

- **`transporte.ts`** — os DOIS transformers do cliente: `createAutoRetryTransformer`
  (retry do 429 LENDO `parameters.retry_after` no relógio injetado —
  `retryAfterSeconds`, `DEFAULT_MAX_RETRY_ATTEMPTS = 1`, teto 60 s) e
  `createTransportLogTransformer` (testemunha a queda de rede, amostrada por
  potência de dois, `ESCALATE_AFTER = 5`). **NUNCA retry cego** e
  **`getUpdates` sai fora do auto-retry** (`METODOS_SEM_RETRY`): o grammY já
  dorme `retry_after` no ciclo de polling, repetir dos dois lados dobra a
  indisponibilidade (medido até 2×).

- **`adapter.ts`** — o `ProviderAdapter` concreto: `createTelegramProvider(deps)
  → TelegramAdapter` (com `descartados()` extra, TG-089). Define
  `TELEGRAM_LIMITS` (§3). `start(handleEvent)` cria o bot, instala handlers
  (`bot.on('message')`, `bot.on('callback_query')`), corre `runPolling` e
  devolve `fatal` rejeitado em 409/401/BOOT_TIMEOUT (a parte SÍNCRONA do `start`
  já roda, para o `publishCommands` e o handle de paragem saírem na mesma
  tickada). `sender()` fornece o `SurfaceSender` sobre a `ApiDoBot`: o antigo
  `Number(chatKey)` da fronteira de saída (herança do envelope IPC V1) foi
  REMOVIDO na EMENDA ONDA-1-IPC-ENVELOPE-STRING — `chatKey`/`userKey` viajam
  STRING (a Bot API aceita o id numérico em formato string) e o `Number(...)`
  só resta onde a API exige inteiro (`message_id`, conversão de EDGE, não de
  envelope). `publishCommands` chama `setMyCommands` do grammY (best-effort).

- **`interno.ts`** — os auxiliares estruturais locais: `TimeSource`/`Sleeper`
  (`systemTime`), `WorkerLogger` (`criarLoggerMemoria`), mascaramento de segredo
  (`redact`, `describeForLog`, `REDACTED`, `SECRET_SHAPES`), o `ProviderErrorCode`
  FECHADO (`TOKEN_MISSING`, `TOKEN_IN_ARGV`, `POLLING_CONFLICT`,
  `POLLING_UNAUTHORIZED`, `POLLING_FAILED`, `BOOT_TIMEOUT`,
  `CALLBACK_DATA_TOO_LONG` — espelho do `WorkerErrorCode` de
  `worker/lib/errors.ts`) e o RE-EXPORT do CONTRATO DE ERRO canônico (Onda
  3-fix): `ProviderError` (com `code` NUMÉRICO `WorkerExitCode` 10..14 +
  `reason` legível — o boot genérico classifica pelo `code`, sem `instanceof`),
  `WORKER_EXIT` (0/10/11/12/13/14), `exitCodeFor`, `isWorkerExitCode` — tudo de
  `worker/lib/errors.ts`, o único `worker/lib/*` importado pelo adaptador.

---

## 2. A gramática do `callback_data` (`g1:<acao>:<token>`)

Vive no `parse.ts` (é o `callback_data` do Telegram, com teto de 1..64 BYTES, e é
o caminho de entrada de decisão de autorização).

```text
g1 : <acao : IpcIntentName> : <token : opaque>

CALLBACK_SCHEMA        = 'g1'            (fora deste prefixo → morre no parser)
CALLBACK_DATA_MAX_BYTES= 64              (BYTES UTF-8, o limite DURO da Bot API)
CALLBACK_DATA_MIN_BYTES= 1               (vazio não é aceite pela API)
SEP                    = ':'             (fora do alfabeto do token de propósito)
TOKEN_ALPHABET         = /^[A-Za-z0-9_-]+$/u   (base64url, alfabeto do nonce)
```

- **Construir** — `buildCallbackData(action, token)`: lança se o `token` estiver
  vazio (todo botão carrega um token emitido pelo host, S5), lança se o `token`
  fugir ao alfabeto (um separador dentro partiria o parser), e lança
  **`CALLBACK_DATA_TOO_LONG`** se o resultado exceder os **64 BYTES** (medido em
  bytes, não caracteres — um acento vale 2). Falhar alto aqui (TG-026) faz o
  estouro ser detetado em teste, não em produção.
- **Parser** — `parseCallbackData(data) → { ok, action, token } | { ok:false,
  reason }`. Valida APENAS a FORMA (nunca o valor, S5): ausente, >64 bytes,
  ≠3 partes (split em `:`), schema ≠ `g1`, acção fora do vocabulário FECHADO
  (`INCREASES_EXPOSURE`), token ausente ou fora do alfabeto. `srv:off:v1`
  (TG-025) morre aqui sem o prefixo `g1`.
- **Token opaco (S5)** — `buildCallbackData` não sabe nem quer saber se o token
  é um nonce do host: não o gera, não o guarda, não o valida. A forma sim, o
  valor não. Nunca logado (S3).
- **Espelho do vocabulário** — `INCREASES_EXPOSURE: Record<IpcIntentName,
  boolean>` (o valor boolean é a marca "aumenta exposição", informativa; o host
  decide). É fechado: se o `IpcIntentName` ganhar uma intenção nova (ex.
  `tunnel.*`), este `Record` deixa de compilar e obriga alguém a decidir aqui.

---

## 3. Limites do provedor (4096/1/1/64/supportsEditing)

```ts
export const TELEGRAM_LIMITS: SurfaceLimits = Object.freeze({
  maxTextLength: 4096,        // mensagem (token de code points)
  maxActionRows: 1,           // os teclados deste bot são UMA linha
  maxActionPerRow: 1,         // ... de UM botão em cada confirmação
  maxActionDataBytes: 64,     // BYTES do callback_data (64 BYTES)
  supportsEditing: true,      // editMessageText existe
})
```

O núcleo corta o texto a 4096 antes de enviar (nunca estoura na rede — TG-048) e
renderiza as linhas dentro de `maxActionRows`/`maxActionPerRow`; o adaptador só
renderiza (`renderActionRowLayout`). `maxActionDataBytes` é em BYTES porque um
acento vale 2 bytes.

---

## 4. Long polling: sequência de boot, terminais e retry

- **Boot feliz** (`runPolling`): `getMe → deleteWebhook{drop_pending_updates:true}
  → getUpdates`, `allowed_updates`, `timeout: 50`, `limit: 100`.
- **409 → exit 11** (`POLLING_CONFLICT`): outro `getUpdates` com o mesmo token.
  ZERO reconexões; o processo SAI para o supervisor do host tomar a política.
- **401 → exit 12** (`POLLING_UNAUTHORIZED`): token recusado/revogado. SAI.
- **Boot 45 s → exit 14** (`BOOT_TIMEOUT`): o arranque não chegou a receber
  updates em `DEFAULT_BOOT_TIMEOUT_MS`; SAI mesmo que o `bot.start()` ainda esteja
  pendurado (causa típica: Bot API inalcançável e o retry interno dormiu).
- **429 com `retry_after`** — no `transporte.ts`: espera EXATAMENTE o
  `retry_after` indicado pelo servidor, no relógio injetado, até `maxRetryAttempts`
  (1) e teto de 60 s. **`getUpdates` fica FORA do auto-retry** (o grammY já dorme o
  `retry_after` no ciclo de polling) — repetir dos DOIS lados dobra a espera.
- **Sem retry cego**: nunca repete sem o servidor dizer quanto esperar.

**Exit codes do processo** (WF via `worker/telegram-bot.ts` — o boot genérico
classifica pelo `code` NUMÉRICO do `ProviderError` canônico
(`worker/lib/errors.ts`), sem `instanceof` de classe de provedor — o 409/401
chega do `classifyPollingError` já com 11/12):
`0` ok · `10` config (token ausente / token em argv / provedor desconhecido) ·
`11` conflict (409) · `12` unauthorized (401) · `13` polling falhou ·
`14` boot-timeout (45 s).

---

## 5. `answerCallbackQuery` SEMPRE (TG-027)

- Em TODO `callback_query` (mesmo malformado), o `parse.ts` produz um evento
  `acao` ou `acao-invalida` que **sempre carrega `answerTarget`** (o
  `callback_query.id`). Sem `id` o `callback_query` não existe na Bot API —
  falha-closed (não se responde nem se executa acção invisível).
- O núcleo responde em TODOS os caminhos via `sender.answer(answerTarget)`, que
  no adaptador chama `answerCallbackAlways` (`teclado.ts`) — **nunca lança**
  (devolve `false` se o canal recusar; uma falha cosmética não pode virar falha
  funcional).
- **Na NEGAÇÃO, responda SEM `text`**: o protocolo responde, o conteúdo cala —
  uma mensagem de recusa dita a um estranho é um ORÁCULO (a negação costuma ser
  payload sem token, TG-025).
- **"query is too old" não lança**: se o clique já expirou, `answerCallbackAlways`
  apanha o erro, loga `warn` e devolve `false` — nunca derruba o `handleEvent`.

---

## 6. Edição in-place (`editMessageText`)

- `editMessageTextInPlace` edita a mensagem-alvo no lugar em vez de mandar nova.
- O veredito **`'unchanged'`** quando a Bot API recusa uma edição que não muda
  nada («Bad Request: message is not modified»). `isNotModified` reconhece o 400
  por SUBSTRING na `description` em minúsculas, limitado a `error_code === 400`
  (a API não dá código próprio). Veredito `'failed'` nos restantes erros.
- O sender `edit` **nunca lança**: devolve o `SurfaceEditOutcome` e o núcleo
  decide (`supportsEditing: true`).

---

## 7. O token (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_API_ROOT`)

- **`TELEGRAM_BOT_TOKEN`** (`TOKEN_ENV_VAR`): o token do bot, escreve-o o host
  em `src/proc/env.ts` (`PROVIDER_ENV.telegram.tokenVar`) na allowlist do
  worker. Entra por AMBIENTE, NUNCA por `argv` (TG-069).
- **`TELEGRAM_API_ROOT`** (`API_ROOT_ENV_VAR`): raiz opcional da Bot API —
  aponta o cliente para um servidor próprio ou para o duplo de teste.
- **Forma** `BOT_TOKEN_SHAPE = (?<!\d)\d{6,12}:[A-Za-z0-9_-]{20,}` serve para
  DETETAR (testes de vazamento e rastreio de `argv`), **nunca** para VALIDAR —
  o único juiz de um token é o `getMe`.
- O token é SENHA DE CONTROLO TOTAL (sem segundo fator, sem escopo, sem IP
  allowlist, sem expiração) e **VIAJA NA URL de cada chamada** — daí o
  mascaramento em `describeForLog`/`interno.ts` e do `sensitiveLogs: false`.

---

## 8. Mapeamento update → evento (resumo do `parse.ts`)

| Update cru | Evento neutro |
|---|---|
| `message` com `from`+`chat`+`text` | `{ kind:'comando', identity:{userKey,chatKey}(STRING), text }` |
| `message` sem identidade ou sem texto (foto/sticker) | `undefined` (contado) |
| `callback_query` com payload `g1:<acao>:<token>` válido | `{ kind:'acao', identity, action, token, answerTarget, messageTarget? }` |
| `callback_query` malformado (≠ `g1`, >64B, token ausente/ruim, sem identity) | `{ kind:'acao-invalida', identity?, answerTarget, reason }` |
| `edited_message` / `channel_post` / `edited_channel_post` / `inline_query` / `my_chat_member` / `chat_member` / `unknown` | `undefined` (ignorado SEM exceção, TG-012..015) |

NUNCA se forja `action`/`token` quando o payload não os carrega validamente
(S5). `answerTarget` é preenchido em todo `acao`/`acao-invalida` (TG-027).

---

## 9. Como PORTAR para outro provedor

Separe o **telegram-específico** do **genérico**:

- **Telegram-específico** (fica no `telegram/**`, não se porta):
  grammY/Bot API, `callback_data` `g1` e os 64 BYTES, `TELEGRAM_*` env vars,
  `isTelegramId` (double JS seguro até 2^53), `setMyCommands`,
  `editMessageText`, `answerCallbackQuery`, `retry_after`, o detetor
  `BOT_TOKEN_SHAPE`, o `classifyPollingError` (mapear 409/401 do long polling
  para os códigos 11/12 do contrato).
- **Genérico** (vale para todo provedor — traga na nova cópia, SEM importar de
  `worker/lib/*`): o padrão `ProviderAdapter` de `adapter.ts` (id/limits/start/
  stop/publishCommands/sender), o formato `SurfaceEvent` de entrada, o princípio
  de responder SEMPRE ao clique (análogo de TG-027), o corte/limites por canal,
  o token via ambiente allowlist + nunca em `argv`, o duplo de teste local — e
  o CONTRATO DE ERRO canônico (`ProviderError`/`WorkerExitCode`/`WORKER_EXIT` de
  `worker/lib/errors.ts`, re-exportado pelo `interno.ts`): o erro do provedor
  novo carrega o `code` numérico 10..14 e o boot genérico classifica-o sem
  conhecer o provedor.

Para o passo-a-passo de criar um provedor novo a partir desta referência,
carregue **`dsh-provider-bot`** (§3) — não reinvente a arquitectura aqui.

---

## 10. O duplo de teste (`$REPO/test/support/telegram-server.mjs`)

- `startFakeBotApi({ port?, pending? })` → servidor HTTP mínimo (Node puro,
  ESM, zero deps). Expõe `apiRoot` (SEM barra final — o grammY lança com
  barra), `calls` (histórico `{token, method, payload}`), `state` (para
  `getUpdates`/offset), `queueError(method, err)` e `close()`.
- Contrato replicado da Bot API: `/bot<token>/<METHOD>`, sucesso
  `{ok:true,result}`, erro `{ok:false,error_code,description,parameters?}`.
  `getUpdates` com `timeout>0` e fila vazia SEGURA a resposta (long polling de
  verdade; sem isso o cliente entraria em busy loop).
- Builders: `fakeMessageUpdate(...)` (mensagem com `from`+`chat` do mesmo id —
  para os dois eixos) e `fakeChannelPostUpdate(...)` (`from` AUSENTE → negação).
- `CANONICAL_ERRORS` copiados VERBATIM de `tdlib/telegram-bot-api`: 409
  (`conflictOtherGetUpdates`), 401 (`unauthorized`), 429 (`tooManyRequests` com
  `retry_after`).
- O adaptador aponta para ele via `apiRoot` (de `TelegramProviderDeps.apiRoot`),
  que chega do boot pelo `TELEGRAM_API_ROOT`/duplo. Tests unitários/ex e2e
  usam-no para exercitar boot feliz, 409→11, 401→12, 429 com `retry_after`,
  `callback_data` (TG-025/026), sem token real nem rede externa.