---
name: dsh-provider-bot
description: >-
  Use ao adicionar um novo provedor de mensageria a este repo
  (dsh-guarded-bot-orchestrator) — WhatsApp, Discord, Matrix, Signal, Slack,
  X/Telegram alternativo, ou qualquer canal com comandos e cliques/teclado.
  Cobre a arquitectura de provedores (entry→registry→adapter→core→bridge→IPC),
  o CONTRATO neutro tipo-a-tipo em worker/surface/contract.ts, o passo-a-passo
  para implementar um ProviderAdapter concreto em worker/providers/<id>/**, o
  registo no registry, a allowlist de ambiente do host (src/proc/env.ts), a
  checklist de aceite e os invariantes de segurança (ids-string na fronteira,
  token opaco S5, limite por provider, cone de import). NÃO duplica o contrato:
  para detalhes telegram-específicos, carregue dsh-telegram-provider.
---

# Adicionar um provedor de mensageria (dsh-provider-bot)

Guia **genérico** para acrescentar um canal de mensageria a este repo. Para o
adaptador Telegram existente (referência concreta de implementação), carregue a
skill **`dsh-telegram-provider`** — ela cobre só o telegram-específico e
referencia este ficheiro para a arquitectura/contrato.

- Língua do repo: **PT-BR** (identificadores e comentários ficam em PT-BR).
- Raiz do repo onde há código (chamada aqui de `$REPO`):
  - Worker (processo que fala com a internet): `$REPO/worker/**`
  - Host (plano de controlo DSH, Cordis plugin): `$REPO/src/**`
  - Contrato IPC compartilhado: `$REPO/src/contracts/ipc.ts`
  - Testes: `$REPO/test/**` · Config do worker: `$REPO/src/config/schema.ts` e
    `$REPO/cordis.patch.yml`

> **Este repo é uma skill de código-fonte.** As skills vivem em
> `.agents/skills/<nome>/SKILL.md`; o contrato de verdade mora no CÓDIGO
> e nos testes estruturais — leia a árvore antes de descrever qualquer tipo.
> Os ficheiros abaixo são a fonte; os trechos deste guia são resumo.

---

## 1. A arquitectura (quem é dono do quê)

```
UPDATE do canal (long polling / webhook / socket do PROVEDOR)
   │
   ▼
[1] worker/telegram-bot.ts            ENTRYPOINT do processo (boot genérico)
   │   `runTelegramWorker`: resolve o provedor → token → adaptador →
   │   canal IPC → bridge → núcleo → adapter.start(...) → publishCommands
   │   exit codes: 10 config · 11 conflict · 12 unauthorized · 13 polling ·
   │   14 boot-timeout · 0 ok
   ▼
[2] worker/providers/registry.ts      REGISTRY + PONTES REAL
   │   `resolverProvedor(env)` lê DSH_GUARD_PROVIDER (fail-closed; ausente/vazio
   │   → `telegram`; desconhecido → ProvedorDesconhecidoError). Tabela
   │   `PROVIDERS` (provider → { create, lerToken, assertTokenNaoEmArgv }).
   │   `criarSurfaceIpcBridge(ipc)` monta o envelope NUMÉRICO via
   │   `montarEnvelopeDeIntent(IntencaoNeutra)` (String → Number na ponte).
   │   `criarPonteDeNonce` (nonce.request/nonce.issued, timeout 5 s fail-closed).
   ▼
[3] worker/providers/<id>/**          ADAPTADOR CONCRETO (DONO do seu loop)
   │   implementa ProviderAdapter: id, limits, start(handleEvent), stop,
   │   publishCommands, sender(). MAPEIA updates do canal restantes em
   │   SurfaceEvent (comando | acao | acao-invalida). Todo o segredo/provider-
   │   específico (SDK do provedor) vive AQUI — nunca fora.
   ▼
[4] worker/surface/core.ts            NÚCLEO NEUTRO (roteador de eventos)
   │   `criarNucleo`, `tratarEvento(event)`, allowlist de DOIS eixos, receptor
   │   de pareamento, outbox (TG-048), comandos neutros. NÃO conhece o canal.
   ▼
[5] worker/surface/contract.ts        O CONTRATO NEUTRO (self-contained)
       tipa o que entra (SurfaceEvent) e o que sai (SurfaceSender/IntencaoNeutra).
       Importa APENAS IpcIntentName/IpcIntentMessage de src/contracts/ipc.ts.
   ▼
[6] worker/ipc.ts  →  [7] src/ipc/channel.ts   CANAL JSONL host ↔ worker
       envelope IPC V1: from/chat NUMÉRICOS (herança Telegram). A conversão
       String→Number é feita NA PONTE ([2]), nunca no núcleo nem nos comandos.
```

Regras de propriedade:

- **O adaptador é DONO do seu próprio loop de consumo** (long polling/webhook/
  socket). O núcleo não sabe o que é polling — só recebe `SurfaceEvent`.
- **ENTRADA** = o que o provedor produz (`SurfaceEvent`); **SAÍDA** = o que o
  provedor entrega (`SurfaceSender`). A divisão é o coração do desacoplamento.
- **O host valida, o worker só transporta os tokens (S5).** `SurfaceAction`
  carrega um token OPACO: o worker não gera, não valida, não guarda nonce do
  host (com exceção do token opaco local das acções `emergency`, que o worker
  GERIA via `gerarTokenOpaque`). O token NUNCA vai ao log (S3).
- **Ids STRING na fronteira (D4).** O contrato é `userKey`/`chatKey: string`.
  O número (`from.id`/`chat.id` do Telegram) é convertido FOTO-a-foto no
  adaptador (`String(...)`), e de volta para o envelope numérico na ponte.

---

## 2. O contrato tipo-a-tipo (`$REPO/worker/surface/contract.ts`)

`SurfaceEvent` é a união discriminada `acao-invalida | comando | acao`. Todos
os eventos `acao`/`acao-invalida` carregam `answerTarget` — **o núcleo responde
SEMPRE** (protocolo TG-027), inclusive na negação da forma.

| Tipo | Forma essencial | Papel |
|---|---|---|
| `SurfaceIdentity` | `{ userKey: string, chatKey: string }` (nunca vazios) | os dois eixos allowlistados em cada update |
| `SurfaceEvent` | `SurfaceActionRejectedEvent \| SurfaceCommandEvent \| SurfaceActionEvent` | o que o adaptador produz |
| `SurfaceCommandEvent` | `{ kind:'comando', identity, text }` | mensagem de texto crua (comando ou texto livre) |
| `SurfaceActionEvent` | `{ kind:'acao', identity, action, token, answerTarget, messageTarget? }` | clique num botão (forma já validada) |
| `SurfaceActionRejectedEvent` | `{ kind:'acao-invalida', identity?, answerTarget, reason? }` | clique malformado/descartável: responder + contar, nada mais |
| `SurfaceAction` | `= IpcIntentName` (vocabulário FECHADO) | a intenção de controlo |
| `SurfaceActionData` | `{ action, token }` | payload serializado do botão (espelho neutro do `callback_data`) |
| `ActionRow` | `{ label, action, token, kind? }` | um botão renderizável; `token` opaco S5 |
| `ActionRowLayout` | `readonly (readonly ActionRow[])[]` | um teclado/balao inteiro |
| `SurfaceLimits` | `{ maxTextLength, maxActionRows, maxActionPerRow, maxActionDataBytes, supportsEditing }` | tetos do canal; `maxActionDataBytes` em **BYTES UTF-8** |
| `SurfaceSendOptions` | `{ actionRows?, disableWebPagePreview? }` | opções de envio/edição neutras |
| `SurfaceSender` | `send / edit / answer` | a superfície de saída; `reply` nunca lança |
| `SurfaceEditOutcome` | `'edited' \| 'unchanged' \| 'failed'` | veredito de edição in-place (nunca lança) |
| `SurfaceCommandContext` | `{ log, time, ipc, emitirNonce, parar, enviar, editar, mostrarEstado, responder, pendente, projecao, dono }` | o contexto que os comandos neutros consomem |
| `IntencaoNeutra` | `{ intent, requestId, userKey, chatKey, nonce? }` | a intent que atravessa a ponte (chaves STRING) |
| `SurfaceIpcBridge` | `{ send(IntencaoNeutra): boolean }` | a ponte que o núcleo usa para produzir intents |
| `ProviderAdapter` | `{ id, limits, start(handleEvent), stop, publishCommands, sender }` | **o contrato que CADA provedor implementa** |
| `SurfaceSenderFactory` | `(adapter) => adapter.sender()` | injeta o sender (ou duplo de teste) |
| `SurfaceProjectionState` | `{ state, seq, url?, expiresAt?, readyDesde? }` | projeção de estado que o núcleo mantém |

### O fluxo de 2 etapas e o token opaco (S5)

A confirmação de acções sensíveis é sempre em **duas etapas**, com o token a
viajar opaco do host até ao clique e de volta:

1. **Comando** chega (`/ligar`, `/parear` …) → o núcleo chama
   `emitirNonce(action)` → o host emite um `nonce` pelo canal (`nonce.issued`);
2. O núcleo renderiza uma `ActionRow { action, token: nonce }` → o adaptador
   serializa o token no formato do canal (`g1:<acao>:<token>` no Telegram) →
   o clique devolve o token → o host **valida o valor** (S5).

O token é **opaco S5**: o worker não o gera para acções que aumentam exposição,
não o valida, não o compara, não o guarda — só o anexa ao botão e o
re-transporta de volta. Nunca logado (S3). A forma do token verifica-se
(alfabeto seguro, sem separadores); o valor não.

### O que fornecer para o boot (`worker/providers/registry.ts`)

`ProvedorDescrito` é tudo o que o boot genérico (`worker/telegram-bot.ts`)
precisa de saber de um provedor:

```ts
import type { WorkerLogger } from '../lib/log.ts'
import type { TelegramAdapter } from './telegram/adapter.ts'

export interface ProvedorCreateDeps {
  readonly token: string
  readonly apiRoot?: string   // raiz da API (duplo de teste)
  readonly log: WorkerLogger
  readonly time?: TimeSource
}

export interface ProvedorDescrito {
  readonly id: ProviderId
  readonly create: (deps: ProvedorCreateDeps) => TelegramAdapter
  readonly lerToken: (env: NodeJS.ProcessEnv) => string
  readonly assertTokenNaoEmArgv: (argv: readonly string[], token?: string) => void
}
```

---

## 3. Passo-a-passo: criar um provedor novo `worker/providers/<id>/**`

> Todo o código é escrito DENTRO de um subdiretório novo, de um provedor por
> vez. Nunca edite ficheiros de outro provedor nem o núcleo neutro de propósito.

### 3.1 Não duplique o contrato

O núcleo (`worker/surface/core.ts`), o contrato
(`worker/surface/contract.ts`) já estão prontos. Você implementa **só** o
adaptador concreto e o registo. Se o contrato precisar de um campo novo
(ex.: nova forma de update), mude-o com cuidado e rode o
`test/unit/worker/surface/contract.structural.test.ts` (o cone de import).

### 3.2 Estrutura do diretório (espelha o telegram)

```
worker/providers/<id>/
  interno.ts      # tipos estruturais locais (relogio/espera/logger/erro tipado/
                  #   mascaramento/codigos de saida) — port dos `worker/lib/*`
                  #   que o provedor precisa, SEM importar de worker/lib/*
  token.ts        # lerTokenDoAmbiente / assertTokenNaoEmArgv (nunca token em argv)
  parse.ts        # update cru do canal -> SurfaceEvent (comando|acao|acao-invalida)
  teclado.ts      # ActionRowLayout -> marcação visual + answer + edição in-place
  polling.ts      # (se for long polling/webhook) o loop e a classificação de saída
  cliente.ts      # o cliente do SDK do provedor + error handler
  transporte.ts   # (se o SDK expuser) transporte HTTP + auto-retry do 429
  adapter.ts      # create<Provider>Provider(deps) -> ProviderAdapter  ← o CONTRATO
```

A divisão exata é livre; o obrigatório é o **adapter.ts** expor o
`ProviderAdapter`. O adaptador NÃO importa de `worker/lib/*` (nem de qualquer
outro módulo do processo fora do próprio `worker/providers/<id>/**` e do
contrato neutro de `worker/surface/*`) — PORTEIA os auxiliares estruturais
(relógio, espera, logger, mascaramento, erro tipado, códigos de saída) para um
`interno.ts` próprio.

### 3.3 Implemente o `ProviderAdapter` concreto

```ts
import type {
  ProviderAdapter,
  SurfaceEvent,
  SurfaceLimits,
  SurfacePublishedCommand,
  SurfaceSender,
  SurfaceSendOptions,
  SurfaceEditOutcome,
} from '../../surface/contract.ts'

export const PROVIDER_LIMITS: SurfaceLimits = {
  maxTextLength: 4096,            // teto de caracteres (code points)
  maxActionRows: 5,               // quantas linhas de teclado/balao
  maxActionPerRow: 2,             // quantas acoes por linha
  maxActionDataBytes: 64,         // **BYTES UTF-8** (um acento = 2 bytes)
  supportsEditing: true,          // editMessageText existe? senao false
}

export function createProviderProvider(deps: ProviderDeps): ProviderAdapter {
  return {
    id: '<id>',
    limits: PROVIDER_LIMITS,
    async start(handleEvent: (event: SurfaceEvent) => Promise<void>) {
      // DONO do seu próprio loop: recebe updates e manda cada um por
      //   handleEvent(parse.mapear(update))  — mesmo quando aquele vira undefined
      // Um erro de entrega NAO pode matar o loop (regra S4).
    },
    async stop() { /* para o loop e liberta recursos */ },
    async publishCommands(comandos: readonly SurfacePublishedCommand[]) {
      // setMyCommands do canal; best-effort. Falha logada, NAO derruba boot.
    },
    sender(): SurfaceSender {
      return { send, edit, answer } // send resolve com id STRING; edit/answer nunca lancam
    },
  }
}
```

**Regras no `sender()`:**
- `send` resolve com o id da mensagem nova como **string** (`String(msgId)`).
- `edit` devolve o veredito `'edited' | 'unchanged' | 'failed'` — nunca lança.
  `unchanged` quando o canal recusa edição idêntica (ex.: "message is not modified").
- `answer` responde ao clique (`answerTarget`); nunca lança, devolve `boolean`.

### 3.4 Mapeie updates → `SurfaceEvent`

O `parse.ts` de cada provedor transforma o update cru do canal num
`SurfaceEvent`. Pontos-chave:

- **Comando**: `{ kind:'comando', identity:{userKey,chatKey}, text }`. O texto é
  cru (sem normalização de comando); `worker/surface/core.ts`
  `extrairNomeDeComando` decide se é comando.
- **Ação**: `{ kind:'acao', identity, action, token, answerTarget, messageTarget? }`.
  A forma do payload foi validada; o `token` é opaco (a forma sim, o valor não).
- **Ação inválida / descartável**: `{ kind:'acao-invalida', identity?, answerTarget, reason? }`.
  **Se o canal tem análogo de callback, responda SEMPRE (TG-027)** mesmo na
  negação — o núcleo precisa do `answerTarget` para parar o girador do clique.
  Nunca forje `action`/`token`: inventá-los seria forjar uma acção que o host
  nunca validou (S5).
- **Não-accionável** (edited/channel_post/inline_query/unknown): mapeie para
  `undefined` e ignore SEM exceção (regra TG-012..015). Conte nos `descartados`.

```ts
// Stub do event-mapping (em PT-BR):
function mapear(update: unknown): SurfaceEvent | undefined {
  if (!isObj(update)) { descartados++; return undefined }
  const identidade = extrairIdentity(update)          // {userKey,chatKey}? (STRING)
  if (update.tipoComando) {
    if (!identidade) { descartados++; return undefined }
    return { kind:'comando', identity: identidade, text: String(update.tipoComando.texto) }
  }
  if (update.tipoClique) {
    const answerTarget = readCliqueId(update.tipoClique)   // obrigatorio (TG-027)
    if (!answerTarget) { descartados++; return undefined }
    const parse = parsePayload(update.tipoClique.data)     // valida a FORMA, nao o valor
    if (!parse.ok) {
      descartados++
      return { kind:'acao-invalida', ...(identidade?{identity:identidade}:{}), answerTarget, reason: parse.reason }
    }
    if (!identidade) { descartados++; return undefined }
    return { kind:'acao', identity: identidade, action: parse.action, token: parse.token, answerTarget, ...(msgId?{messageTarget:msgId}:{}) }
  }
  return undefined  // superficie nao accionavel
}
```

### 3.5 Limites corretos do provedor

Preencha `SurfaceLimits` a partir do que o **canal específico** aceita, lendo a
documentação do canal — nunca use os números do Telegram por engano:
- `maxTextLength` — teto de caracteres de UMA mensagem (o núcleo corta AQUI).
- `maxActionRows` / `maxActionPerRow` — forma do teclado/balao.
- `maxActionDataBytes` — **em BYTES UTF-8** do payload serializado de UMA
  acção; `0` = o canal não tem botões (mas o contrato exige ≥ 1 por linha se
  usar botoes).
- `supportsEditing` — `true` sse o canal permite edição in-place; `false`
  obriga o núcleo a enviar mensagem nova.

### 3.6 Segredo via ambiente allowlist (host)

O token/segredo do provedor entra no worker **por ambiente**, conforme a
allowlist do host — NUNCA por `argv` (`/proc/<pid>/cmdline` é legível por
qualquer processo local; token em argv é falha TG-069).

1. Em `src/proc/env.ts`:
   - acrescente o literal ao enum/tipo `ProviderId` (hoje `'telegram'`);
   - adicione a linha a **`PROVIDER_ENV`**:
     ````ts
     export const PROVIDER_ENV: Readonly<Record<ProviderId, { readonly tokenVar: string }>> = {
       telegram: { tokenVar: 'TELEGRAM_BOT_TOKEN' },
       whatsapp: { tokenVar: 'WHATSAPP_TOKEN' },   // ← novo provedor
     }
     ````
   - `buildWorkerEnv(source, token, provider)` pisa `PROVIDER_ENV[provider].tokenVar`,
     `DSH_GUARD_PROVIDER = provider` e `DSH_GUARD_IPC = '1'` no ambiente do worker.
2. Em `src/config/schema.ts`: alargue `worker.provider?: 'telegram'` para incluir
   o mesmo literal (`worker.token` passa a ser "o token do provedor ativo").
3. Em `cordis.patch.yml`: acrescente o literal na linha `provider:`.
4. **Nunca reescreva uma variável existente** em `PROVIDER_ENV`: mudaria em
   silêncio o token de um bot já emparelhado.

### 3.7 Registre no registry

`worker/providers/registry.ts`:

```ts
// 1) Alargue o tipo (na tabela já fechada):
export type ProviderId = 'telegram' | 'whatsapp'
export const DEFAULT_PROVIDER_ID: ProviderId = 'telegram'

// 2) Importe o `create` do novo provedor:
import { createWhatsAppProvider } from './whatsapp/adapter.ts'

// 3) Acrescente a DESCRICAO e a linha na tabela PROVIDERS:
const DESCRICAO_WHATSAPP: ProvedorDescrito = {
  id: 'whatsapp',
  create: (deps) => createWhatsAppProvider(deps),
  lerToken: (env) => lerTokenDoAmbiente(env),          // de ./whatsapp/token.ts
  assertTokenNaoEmArgv: (argv, token) => assertTokenNotInArgv(argv, token),
}
export const PROVIDERS: Readonly<Record<ProviderId, ProvedorDescrito>> = Object.freeze({
  telegram: DESCRICAO_TELEGRAM,
  whatsapp: DESCRICAO_WHATSAPP,
})
```

O `resolverProvedor(env)` já resolve por `DSH_GUARD_PROVIDER` e falha-closed em
valor desconhecido (`ProvedorDesconhecidoError`). Não altere essa semântica:
degradar em silêncio para o default seria nascer com o token de outro provedor.

### 3.8 Testes (duplo local + e2e)

- **Duplo local do canal**: espelhe o padrão
  `test/support/telegram-server.mjs` (servidor HTTP mínimo que responde aos
  métodos do canal, pela `apiRoot`/token no path). Provê
  `calls`, `queueError(method, err)`, `CANONICAL_ERRORS`, e long-polling que
  segura a resposta. O grammY/adaptador aponta para ele via `apiRoot`.
- **Testes unitários** do parse/limites/token/polling (padrão
  `test/unit/worker/providers/telegram/*.test.ts`).
- **E2E** do boot (padrão `test/e2e/telegram-*.test.ts` e
  `test/unit/worker/telegram-bot.test.ts`): boot feliz, 409→11, 401→12,
  boot-timeout→14, token nunca em `argv`.

### 3.9 O boot GRÁTIS (não mude nada aqui)

O `worker/telegram-bot.ts` já é genérico: não edite a sequência para suportar um
provedor novo — basta o registry e o adaptador existirem. A sequência é 100% do
boot, sem tocar no provedor: resolver → token → `assertTokenNaoEmArgv` → criar
adaptador → `sender`/`limits` → canal IPC → `criarSurfaceIpcBridge` →
`criarPonteDeNonce` → `criarAuthDeSuperficie` → `criarNucleo` →
`adapter.start(tratarEvento)` → `adapter.publishCommands(COMANDOS_PUBLICADOS)`.

---

## 4. Checklist de aceite

Um provedor só é **"suportado"** quando TODA a checklist fechar:

- [ ] `ProviderAdapter` implementa os 6 membros (`id`, `limits`, `start`,
      `stop`, `publishCommands`, `sender`) e `start(handleEvent)` é DONO do loop.
- [ ] Todos os updates mapeiam para `SurfaceEvent` (`comando`/`acao`/
      `acao-invalida`); os não-accionáveis → `undefined` sem exceção.
- [ ] **`answerTarget` preenchido em todo `acao`/`acao-invalida`** quando o
      canal tem análogo de callback (resposta SEMPRE, protocolo TG-027).
- [ ] `SurfaceLimits` medido no canal real: `maxTextLength`/`maxActionRows`/
      `maxActionPerRow`/`maxActionDataBytes` (BYTES)/`supportsEditing`.
- [ ] Segredo via `PROVIDER_ENV` + `buildWorkerEnv`; token NUNCA em `argv`
      (`assertTokenNaoEmArgv`) e NUNCA logado.
- [ ] Registado no registry (`ProviderId` + `PROVIDERS` + `resolverProvedor`
      fail-closed intacto).
- [ ] Literal em `config.worker.provider` (schema) e `cordis.patch.yml`
      `provider:`.
- [ ] Testes: duplo local do canal; unitários do parse/limits/token/polling;
      e2e do boot (feliz, 4XX terminais, boot-timeout, token-em-argv).
- [ ] Invariantes de segurança e lint em ordem (abaixo).

---

## 4.5 Como plugar OUTROS provedores (WhatsApp, Discord, iMessage, Signal, Slack…)

Esta secção é o **receituário concreto** por provedor, sobre o esqueleto da §3
e da §4. Para cada canal apontamos: o **estilo de entrega** (long-polling vs
webhook vs socket vs ponte não-oficial), o **SDK** que vive SÓ no
`worker/providers/<id>/**`, os **limites reais** para `SurfaceLimits`, o
**update → `SurfaceEvent`** esperado, e o **mini-mapa "arquivo antigo →
arquivo novo"** para os casos-limite (sem edição, webhook, id não-numérico).

> A regra absoluta é a mesma para todos: **todo segredo/provider-específico
> fica DENTRO de `worker/providers/<id>/**`**, e o núcleo
> `worker/surface/**` **nunca** importa grammY/discord.js/whatsapp-web.js nem
> `worker/lib/*`. Os factos externos citados abaixo vêm das fontes oficiais
> ligadas; confirme na data de implementação (APIs mudam).

### 4.5.1 Matriz-resumo

| Provedor | Entrega | SDK (vive no adapter) | `maxTextLength` | `supportsEditing` | id é numérico? | Feasible? |
|---|---|---|---|---|---|---|
| WhatsApp Cloud API | webhook | `participants.js`/HTTP próprio (sem SDK oficial Node) | 4096 | `true` (vonage) / parcial | string `${phone}` | ✅ recomendado |
| WhatsApp (whatsapp-web.js / Baileys) | socket próprio | `whatsapp-web.js`/`baileys` (não-oficiais) | ~4096 | parcial | string | ⚠️ razão (segurança/sessão) |
| Discord | WebSocket gateway + interactions | `discord.js` | 2000 (default) | `true` (message edit) | string (snowflake) | ✅ recomendado |
| Slack | WebSocket / HTTP + slash | `@slack/*` (bolt) | ~40 000 (blocos) | `true` (chat.update) | string (team/user) | ✅ recomendado |
| Matrix | webhook/sync | `matrix-bot-sdk` | varia | `true` (edit) | string (`@user:server`) | ✅ |
| Signal | — | `signal-cli` (ponte não-oficial) | — | n/d | string | ⚠️ sem API oficial de bot |
| iMessage | — | BlueBubbles / DB privado | — | parcial | string (handle) | ❌ não recomendado |

### 4.5.2 WhatsApp (Cloud API) — o caminho oficial

1. **Entrega:** webhook (Meta). O `worker/providers/whatsapp/**` expõe um
   handler de `POST /webhook` (ou consuma o payload) e verifica `X-Hub-Signature-256`
   contra o app secret — **nunca** confie no payload sem assinar. Não há long-polling.
2. **`SurfaceLimits`:** `maxTextLength: 4096` (mensagem de texto da Cloud API);
   `supportsEditing: true` (botões interativos podem ser re-enviados; a edição
   de mensagens enviadas depende do perfil). Use botões interativos
   (`interactive.buttons`) como `ActionRowLayout`; o `callback_data` do Telegram
   vira o payload do botão (≤ tamanho do campo `id` do botão interativo).
3. **Identidade:** o `phone` do remetente vem como string (`waid`). Já é
   `userKey: string` no contrato — **não** faça `Number(...)` como no Telegram:
   os ids do WhatsApp são string e o adaptador tem de **resistir ao cast
   numérico** (D4 nota: ids não-numéricos são resolvidos na fase 5 do IPC).
4. **Testes:** duplo local estilo `test/support/telegram-server.mjs` que responde
   aos endpoints da Cloud API (webhooks e `graph.facebook.com/v*/.../messages`).

Fontes: [WhatsApp Business API — tipos e limites de mensagem](https://clickatell.netlify.app/help-center/whatsapp/sending-receiving-messages/message-types-media-formats-supported/),
[whatsapp-cloud-api — parâmetros de texto](https://gist.github.com/dani139/16d4c4ea272af8fe75cd28b89ab77ddb#2).

### 4.5.3 Discord — bot por aplicação

1. **Entrega:** WebSocket gateway + **interactions** (slash commands). Use
   `discord.js` como SDK **só dentro** de `worker/providers/discord/**`.
2. **Intents:** para ler *mensagens* precisa do **`MessageContent` que é Intent
   PRIVILEGIADO** (tem de ser ativado no portal). Prefira **slash interactions**
   (permissão por default) em vez de ler texto livre, para não subir os privilégios.
3. **`SurfaceLimits`:** `maxTextLength: 2000` (limite default de uma mensagem,
   sem Nitro/nil; com embeds cada embed é 6000 chars/25 campos). Use
   `supportsEditing: true` (`PATCH /channels/{id}/messages/{id}`).
4. **Identidade:** o `id` de user/channel é uma **snowflake (string)**. `userKey`
   = `${guildId}:${userId}` e `chatKey = ${channelId}` — **nunca** o `username`
   (TG-008) nem `Number(userKey)` (snowflake estoura um int de 53 bits; é string).
5. **Botões:** use `ActionRow` → `components[].button` (`custom_id` carrega o
   `token` opaco S5; limite de `custom_id` ≤ 100 caracteres). `answerTarget` =
   `interaction.id`/token para `interaction.update`/`deferUpdate` (resposta SEMPRE, TG-027).

Fontes: [RESTPostAPIChannelMessageJSONBody (discord.js/discord-api-types)](https://discord.js.org/docs/packages/discord.js/14.18.0/RESTPostAPIChannelMessageJSONBody:Interface),
[GatewayMessageCreateDispatchData](https://discord.js.org/docs/packages/discord-api-types/0.38.31/v10/APIBaseMessageNoChannel:Interface),
[Discord API Reference — send/embeds](https://zernio.com/discord-api).

### 4.5.4 Slack — app com slash commands

1. **Entrega:** Socket Mode (WebSocket) ou HTTP. Use `@slack/bolt` como SDK SÓ no
   adapter `worker/providers/slack/**`. Roteie mensagens por `/comando` e por
   `block_actions` (cliques).
2. **`SurfaceLimits`:** `maxTextLength` ~ **40 000 chars (blocos)** — mas a leitura
   do `text` de um `message` é pequena; use `supportsEditing: true` (`chat.update`).
   `block_actions` é o análogo dos botões; `action_id`/`value` carrega o token opaco.
3. **Identidade:** `user`/`channel` são strings (`U…`/`C…`); `userKey` =
   `${teamId}:${userId}`, `chatKey = ${channelId}`. Nunca o `username`.
4. **Cuidado:** a API de blocos tem limite prático; mensagens MUITO longas são
   truncadas (ver [Truncating really long messages](https://docs.slack.dev/changelog/2018-truncating-really-long-messages/)
   e o [issue bolt-js #2509 — “Blocks too long”](https://github.com/slackapi/bolt-js/issues/2509#1)).
   Configure o `maxTextLength` do teu `SurfaceLimits` NE abaixo do teto real.

### 4.5.5 WhatsApp não-oficial (whatsapp-web.js / Baileys) e iMessage

- **WhatsApp não-oficial:** `whatsapp-web.js` e `Baileys` são **engenharia
  reversa** do WhatsApp Web — exigem **uma sessão real de número de telefone**,
  um browser/QR, e quebram com atualizações. O `maxTextLength` ainda é ~4096 e o
  `supportsEditing` parcial, mas o **token opaco S5** e a allowlist do host
  tornam-se mais difíceis (o "token" é uma **sessão de dispositivo**, não um
  token de API opaco). **Avalie Cloud API primeiro**; se for ainda assim
  não-oficial, **isole toda a sessão** dentro de `worker/providers/whatsapp/**`
  e **nunca** cole o fingerprint da sessão em disco como se fosse o `tokenVar`.
  Fontes: [Baleys vs whatsapp-web.js](https://whatsapp.checkleaked.cc/fa/blog/baileys-vs-whatsapp-web-js),
  [guia whatsapp-web.js](https://whatsapp.checkleaked.cc/zh/blog/whatsapp-web-js-guide).
- **iMessage:** **não há API pública/oficial para bots** da Apple; só ponte
  não-oficial (BlueBubbles, DB privado do macOS) ou contas de terceiros. **Não
  recomendado oficialmente** — e o modelo de segurança aqui (token opaco do
  host + allowlist) pressupõe que o worker fala com uma API de bot, o que a
  Apple não oferece. Se mesmo assim for explorado, fica 100% em
  `worker/providers/imessage/**` (ponte BlueBubbles) e exige um host/macOS
  local — não cabe no modelo de túnel deste repo sem reescrita do transporte.
  Fontes: [@oneworks/channel-imessage (ponte não-oficial)](https://www.npmjs.com/package/@oneworks/channel-imessage?activeTab=code#1).
- **Signal:** **não existe API oficial de bots** do Signal; a via comum é a
  ponte **signal-cli** (e `signal-cli-rest-api`). Funciona sobre um número real
  e por D-Bus/HTTP REST, mas não é a API de bot oficial. **Não recomendado** como
  primeiro provedor; se usado, td a ponte fica em `worker/providers/signal/**`.
  Fontes: [signal-cli-rest-api (DeepWiki)](https://deepwiki.com/bbernhard/signal-cli-rest-api/4-api-reference#1).

### 4.5.6 Mini-mapa "antigo → novo" para os casos-limite

| Caso | O que muda no **teu** adaptador | O que NÃO muda (núcleo) |
|---|---|---|
| **Sem edição de mensagem** (`supportsEditing:false`) | `send` sempre emite mensagem nova; `edit` devolve `'failed'`/`'unchanged'` sem lançar | núcleo manda `send`/`edit`; quem decide é `SurfaceLimits.supportsEditing` |
| **Webhook em vez de long-polling** | `start(handleEvent)` registra um handler HTTP (ou consome `apiRoot`), em vez do loop `getUpdates`; `stop` desliga o listener | `ProviderAdapter.start(handleEvent)/stop`; a interface é a mesma |
| **Id é username puro** (ex.: sem id numérico estável) | **RECUSAR** o provedor: a allowlist de 2 eixos exige `userKey`/`chatKey` **estáveis e não-identificáveis**; `username` muda e é TG-008. Alternativa: usar um id estável do provider (ex.: phone/snowflake) e NUNCA o nome de ecrã | contrato `SurfaceIdentity` (string, nunca username) |
| **Sem analogo de callback/bottom** (`maxActionDataBytes:0`) | `answerTarget` pode ser o id do update; responde por mensagem/editação ou aceita não responder (mas mantenha a regra TG-027 o melhor possível) | `SurfaceEvent` com `answerTarget`; o `núcleo` responde sempre que houver |
| **Payload de botão maior que o limite** | cortar/condensar o token no `teclado.ts`; se o driver estourar, marcar como `acao-invalida` | `SurfaceLimits.maxActionDataBytes` (BYTES UTF-8) |
| **Id não-numérico** (WhatsApp/Discord/Slack) | **NÃO** fazer `Number(userKey)` no adaptador; o `Number(...)` só existe na ponte Telegram | `IntencaoNeutra` (chaves STRING); ponte IPC converte |
| **Novo `tokenVar`** | nova linha em `src/proc/env.ts::PROVIDER_ENV` + literal em `ProviderId` (host e worker) + schema `worker.provider` + `cordis.patch.yml` | `buildWorkerEnv` injeta `DSH_GUARD_PROVIDER` + `tokenVar`; allowlist 2 eixos |

> **Checklist por provedor novo:** siga §4 contra este mini-mapa. O que destoa
> (ex.: um provedor com `username` como único id, ou sem edição e sem botões)
> é **decisão do adaptador**, nunca do núcleo.

---

## 5. Invariantes de segurança e lint

- **Allowlist de 2 eixos, default deny.** O núcleo revalida `userKey` **e**
  `chatKey` em cada update; um evento sem um dos dois não existe.
- **Ids STRING na fronteira (D4).** O contrato é `userKey`/`chatKey: string`.
  Nunca propague `number` no contrato; a conversão numérica mora no adaptador
  (na entrada) e na ponte (na saída). **NUNCA use `username`** do provedor como
  eixo de autorização (a allowlist é numérica, TG-008) — e o teste estrutural
  assere que nenhuma leitura de `.username` existe no parse.
- **Token opaco (S5).** O worker não gera (para acções que aumentam exposição),
  não valida, não guarda, não loga nonces do host. A FORMA sim (alfabeto seguro,
  sem separadores), o VALOR não. Nunca em `argv` (TG-069).
- **`supportsEditing: false`** → o núcleo envia mensagem nova; os sender
  `edit`/`answer` NUNCA lançam.
- **Cone de import (§5.5 do `05-QUALIDADE-CODIGO.md`).** O `worker/surface/**`
  só importa de `node:*` | `./` | `src/contracts/ipc.ts`. **NUNCA** `grammy`
  nem `worker/lib/*` no contrato. O adaptador de cada provedor PORTEIA os
  `worker/lib/*` para um `interno.ts` próprio (não importa deles).
- **Lint:** `eslint` com 0 erros; **SEM `import()` com type annotations**
  (`verbatimModuleSyntax`); `oxlint`; e o teste estrutural do cone
  (`test/unit/worker/surface/contract.structural.test.ts`) obrigatoriamente
  VERDE.
- **`stdout` do worker é exclusivamente JSONL.** Todo log humano vai para
  `stderr`. O dead-man's switch do canal (EOF no `stdin`) termina o processo.