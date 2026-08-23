# PROVIDERS.md — Provedores de mensageria: arquitetura e manual completo

Este documento é o **manual oficial dos provedores de mensageria** do worker.
Explica a arquitetura de provedores plugáveis (desacoplamento que retirou o
acoplamento blocado ao Telegram), os contratos neutros que **qualquer** provedor
implementa e, no §4, o **checklist passo-a-passo para adicionar um provedor novo**.

Dois públicos leem este ficheiro com intenções diferentes:

- **Quem audita o codebase** — usa o §2 (onde vive cada camada) e o §5 (segurança e invariantes).
- **Quem adiciona um provedor novo** — usa o §3 (o contrato), o §4 (o checklist) e o §5 (o que não pode violar).

Para o mapa geral de módulos e as costuras Cordis ver [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).
Para o modelo de ameaça e o regime de allowlist ver [`docs/THREAT-MODEL.md`](THREAT-MODEL.md).
Para os níveis de teste e o gate ver [`docs/TESTING.md`](TESTING.md).

> **Verdade-a-dia-da-escrita:** as secções seguintes descrevem a árvore **real** —
> `worker/surface/**` (contrato e núcleo neutro), `worker/providers/**` (adaptadores e
> registry), `worker/telegram-bot.ts` (boot genérico) e o lado host em `src/**`. Nenhum nome
> de ficheiro aqui é projeto futuro: ou existe já, ou está explicitamente marcado como
> trabalho futuro no §7.

---

## 1. Visão

Hoje o worker do bot suporta **um único provedor de mensageria: o Telegram**, via a
biblioteca `grammY`. O objetivo da arquitetura de provedores é que **WhatsApp, Discord,
Matrix, Signal, Slack e outros** entrem como unidades independentes atrás de um **contrato
neutro comum** — **sem quebrar nada do que funciona hoje**.

A separação é dupla:

- **O núcleo é neutro ao provedor.** O roteador de comandos, a allowlist de dois eixos, o
  pareamento, o enfileiramento (outbox), a coerência de 1 msg/s por chat e a emissão de
  intents IPC vivem em `worker/surface/**` e não conhecem Telegram nem grammY.
- **O Telegram vive num adaptador.** Todo o conhecimento do grammY — long polling, parsing
  do update, teclados, cliente, transporte, token — está isolado em
  `worker/providers/telegram/**`. `grammY` é a única dependência de runtime do pacote e só é
  carregada dentro desse diretório.

O que **não muda** (invariantes da refatoração, preservados em qualquer provedor):

- o modelo de **segurança**: default deny, allowlist de dois eixos (`userKey`/`chatKey`),
  segredos só via allowlist de ambiente do processo (`src/proc/env.ts`);
- o **canal IPC JSONL** versão 1 entre host e worker (`worker/ipc.ts` ⇄ `src/ipc/channel.ts`);
- os **exit codes** do worker (10 a 14) e o contrato `WorkerRuntime` do boot.

Honestidade: na data desta escrita só existe o adaptador Telegram. "Suportado" tem um
significado preciso — ver o fecho da checklist no §4.

---

## 2. Arquitetura de provedores

```
                    ┌────────────────────────────────────────────────────────────┐
 ENTRY (worker)     │                                                            │
                    ▼                                                            │
   worker/telegram-bot.ts          (boot genérico — nome preservado por D1)      │
        │  resolve o provedor por DSH_GUARD_PROVIDER                             │
        ▼                                                                        │
   worker/providers/registry.ts    (tabela fechada de provedores + a ponte IPC)  │
        │  PROVEDORES['telegram'].create(deps) → ProviderAdapter                │
        ▼                                                                        │
   worker/providers/telegram/**    (ADAPTADOR — dono do grammY)                  │
        │  start(handleEvent) empurra SurfaceEvent; sender() devolve SurfaceSender
        ▼                                                                        │
   worker/surface/core.ts          (NÚCLEO NEUTRO — roteador comando→intent)     │
        │  pareamento → allowlist; envia intents pela ponte; outbox 1 msg/s      │
        ▼                                                                        │
   worker/surface/ipc bridge + src/contracts/ipc.ts  (envelope numérico na ponte)│
        ▼                                                                        │
   worker/ipc.ts ⇄ src/ipc/channel.ts   (canal JSONL host ⇄ worker)              │
        ▼                                                                        │
   src/** (HOST — supervisor, configuração, painel, UI contribuída)              │
                    └────────────────────────────────────────────────────────────┘
```

Camadas e quem é dono do quê:

| Camada | Ficheiro(s) | Dona de | Proibida de |
| --- | --- | --- | --- |
| **Adaptador** | `worker/providers/<id>/**` | o próprio loop de consumo (polling/webhook), o parsing cru do update, o token, o teclado, o transporte; sabe a identidade **numérica** do canal | tocar no núcleo, na allowlist, no IPC — importar de `worker/surface/*` só os **tipos** do contrato |
| **Registry** | `worker/providers/registry.ts` | a **tabela** provedor→descrição, a resolução `DSH_GUARD_PROVIDER`, a **ponte de intent** do núcleo (conversão string→número na fronteira) e a **ponte de nonce** | instanciar nenhum provedor em concreto fora da sua própria linha |
| **Núcleo neutro** | `worker/surface/{core,auth,commands,outbox,text,actions,tokens,ids}.ts` | o roteador comando→intent, o funil pareamento→allowlist, a coalescência, o autolink, os pendentes, os textos — tudo em `SurfaceIdentity`/`SurfaceEvent` neutros | conhecer grammY, saber o que é polling/webhook, importar de `worker/lib/*` |
| **Contrato** | `worker/surface/contract.ts` | os **tipos** que o adaptador e o núcleo partilham; único ficheiro do worker que importa de `src/` (e só `src/contracts/ipc.ts`) | importar de grammY ou de `worker/lib/*` |
| **Boot** | `worker/telegram-bot.ts` | a sequência de arranque (resolver provedor → token → adaptador → núcleo → start → publish); os exit codes; o canal IPC do processo | conhecer o provedor em concreto (consome `ProvedorDescrito` do registry) |
| **Host** | `src/**` | a seleção do provedor (`config.worker.provider`), o ambiente do filho (`src/proc/env.ts`), o canal JSONL, o estado persistido, a UI | importar do worker |

> **Regra de ouro da camada:** o **adaptador produz eventos** (`SurfaceEvent`), o **sender entrega**
> (`SurfaceSender`), o **núcleo decide** (authorize + roteia). O núcleo nunca decide "é polling ou
> webhook" e o adaptador nunca decide "quem é o dono".

---

## 3. O contrato da superfície (tipo a tipo)

A especificação completa e autoritativa vive em `worker/surface/contract.ts` — cada tipo está
documentado inline. Aqui está a leitura essencial de cada um, na ordem em que a fronteira os usa.

### 3.1 `SurfaceIdentity` — os dois eixos, como strings

```ts
interface SurfaceIdentity { readonly userKey: string; readonly chatKey: string }
```

- `userKey` = **quem age** (o `from.id` do Telegram, em string); `chatKey` = **onde** (o `chat.id`).
- Os dois são **sempre** necessários: a allowlist revalida **ambos** em cada update (TG-003 — num
  grupo, `userKey` é o membro que carregou no botão e `chatKey` o grupo autorizado).
- **Ids viram strings na fronteira** (D4): remover o `number` do Telegram é o que torna o
  contrato neutro (WhatsApp usa strings, Matrix usa urls, Signal inteiros próprios).
- A normalização (`normalizeKey`/`normalizeIdentity`) vive em `worker/surface/ids.ts` — `trim` +
  não-vazio, a política comum mínima (não valida o formato de nenhum provedor específico).

### 3.2 `SurfaceEvent` — o que o adaptador produz

A união discriminada de entrada, já normalizada:

| `kind` | Significado | Campos essenciais |
| --- | --- | --- |
| `comando` | uma mensagem de texto a interpretar | `identity`, `text` (cru — quem decide se é comando é o núcleo, `extrairNomeDeComando`) |
| `acao` | um clique num botão renderizado | `identity`, `action`, `token` (opaco), `answerTarget` (obrigatório, TG-027), `messageTarget?` |
| `acao-invalida` | um clique cujo payload não casa a forma | `answerTarget` (obrigatório — o núcleo responde **sempre**), `identity?` (para a contagem TG-089), `reason?` |

Regras de ouro do evento:

- **`answerTarget` é obrigatório** em toda ação/callback com análogo de botão (TG-027): o núcleo
  responde ao clique em **todo** os caminhos, inclusive na negativa — do contrário o girador do
  cliente fica pendurado.
- **Nunca se forja `action`/`token`** quando o payload não os carrega validamente (S5): um
  `acao-invalida` preserva os dois factos — o alvo a responder e a contagem — sem inventar um
  controle que o host nunca validou.

### 3.3 `SurfaceAction` e `SurfaceActionData` — o vocabulário fechado e o payload do botão

```ts
type SurfaceAction = IpcIntentName   // espelho do vocabulário fechado de src/contracts/ipc.ts
interface SurfaceActionData { readonly action: SurfaceAction; readonly token: string }
```

- O vocabulário de ações **é fechado** e casa com `IpcIntentName` (`tunnel.up`, `tunnel.down`,
  `tunnel.status`, `session.issue`, `secret.rotate`, `emergency`). Se `IpcIntentName` ganhar um
  membro, os objetos tipo `Record<SurfaceAction, boolean>` em `worker/surface/auth.ts`
  (`AUMENTA_EXPOSICAO`) e o `INCREASES_EXPOSURE` do adaptador deixam de compilar — **forçando** a
  decidir o aumenta/reduz.
- `SurfaceActionData` é o **equivalente neutro do `callback_data`**: o par `acao`+`token` que o
  adaptador serializa na forma do canal (o Telegram usa `g1:<acao>:<token>`, outro provedor usa a
  sua). Um botão **sem token é recusado na forma** — nenhum comando administrativo é accionável
  numa única etapa.

### 3.4 `SurfaceLimits` — os limites declarados pelo canal

```ts
interface SurfaceLimits {
  maxTextLength: number        // code points máximos de uma mensagem (Telegram: 4096)
  maxActionRows: number        // linhas de botão por teclado (Telegram: 1)
  maxActionPerRow: number      // ações por linha (Telegram: 1)
  maxActionDataBytes: number   // bytes UTF-8 de UMA ação (Telegram: 64 — o callback_data)
  supportsEditing: boolean     // o canal edita in-place? (Telegram: true)
}
```

- O núcleo **corta o texto aqui** (`cortarTexto`, `particionarTexto`), nunca após a ida à rede
  (TG-048), e renderiza as linhas de ação **dentro** destes limites.
- Medidos em **bytes** (não em caracteres) para a ação — um acento vale 2 bytes; o Telegram
  conca `callback_data` a 1..64 **bytes**.

### 3.5 `ActionRow` e `ActionRowLayout` — os botões neutros

```ts
interface ActionRow { readonly label: string; readonly action: SurfaceAction;
                      readonly token: string; readonly kind?: 'confirm' | 'emergency' }
type ActionRowLayout = readonly (readonly ActionRow[])[]
```

- Uma linha carrega o **rótulo** legível e **o token opaco que a dispara**. O `token` é o cerne da
  **confirmação em duas etapas**: comando → `emitirNonce(...)` → botão com o nonce → tap → intent.
- O `kind` anota a natureza (confirmação vs emergência) para o adaptador escolher a apresentação;
  **não** anula o `action`.
- O token viaja **opaco** (S5): o núcleo não o valida, não o guarda, não o gera (vem do host ou é
  um token local do `/desligar`) — apenas o anexa ao botão na saída e o re-transporta na entrada.
- **O corte é do núcleo**: as `actionRows` chegam ao adaptador já dentro de `SurfaceLimits`;
  o adaptador só **renderiza** na forma visual do canal.

### 3.6 `SurfaceSender` — a saída neutra

```ts
interface SurfaceSender {
  send(chatKey, texto, opcoes?): Promise<string>              // resolve o id da mensagem nova
  edit(chatKey, messageId, texto, opcoes?): Promise<SurfaceEditOutcome>  // 'edited'|'unchanged'|'failed'
  answer(answerTarget, outras?): Promise<boolean>             // responde ao clique; nunca lança
}
```

- O **boot** obtém o sender do adaptador: `adapter.sender()` (a `SurfaceSenderFactory`), e o núcleo
  usa-o para **tudo** o que sai — nada de grammY/Telegram no núcleo.
- `edit` **nunca lança** e devolve o veredito (o canal recusa edição idêntica → `'unchanged'`, e
  isso não é falha); sem `supportsEditing`, o núcleo nem o chama.
- `answer` responde ao clique sem mensagem nova (faz parar o girador do Telegram); **nunca lança**.

### 3.7 `IntencaoNeutra` e `SurfaceIpcBridge` — o eixo de saída

```ts
interface IntencaoNeutra { intent: IpcIntentName; requestId: string;
                           userKey: string; chatKey: string; nonce?: string }
interface SurfaceIpcBridge { send(pedido: IntencaoNeutra): boolean }
```

- Os comandos e o núcleo produzem **intents neutras** com chaves **string**. O **envelope numérico**
  (`from`/`chat` do `IpcIntentMessage` V1 do host) é responsabilidade da **ponte** — a
  `criarSurfaceIpcBridge` de `worker/providers/registry.ts` monta o envelope completo via
  `montarEnvelopeDeIntent` (o `Number(userKey)`/`Number(chatKey)` mora ali, na fonte do envio) e
  chama o canal `worker/ipc.ts`.
- `nonce` só existe nas ações que **aumentam** a exposição; opaco (S5) — o host valida.
- A **neutralização completa** do envelope numérico é trabalho futuro documentado no §7.

### 3.8 `SurfaceCommandContext` — o contexto que o núcleo passa aos comandos

O contexto neutro que os comandos consomem (`worker/surface/commands.ts`): `log` estrutural,
`time` (relógio injetado), `ipc` (a ponte), `emitirNonce`, `parar`, `enviar`/`editar`/
`mostrarEstado`/`responder`, `pendente` (regista/retira o intent pendente para o ack), `projecao`
(leitura do estado do túnel) e `dono()` (a `chatKey` pareada). É o substituto do `Context` do
grammY — sem qualquer tipo Telegram.

### 3.9 `ProviderAdapter` — o contrato que cada provedor implementa

```ts
interface ProviderAdapter {
  id: string                       // 'telegram' hoje; um rótulo estável por provedor
  limits: SurfaceLimits            // o núcleo corta/renderiza por aqui
  start(handleEvent): Promise<void>  // dono do loop; resolve quando a receber | rejeita se falhar
  stop(): Promise<void>            // para o loop e liberta recursos
  publishCommands(commands): Promise<unknown>  // best-effort (o setMyCommands do Telegram)
  sender(): SurfaceSender          // a saída neutra do núcleo
}
```

### 3.10 O fluxo de entrada em duas etapas (com o token opaco S5)

O caminho de um clique de confirmação, ponta a ponta:

1. O dono manda `/ligar` → o núcleo `tratarEvento` recebe um `SurfaceCommandEvent`.
2. O **receptor de pareamento** corre primeiro (PAIR-006); depois a **allowlist de dois eixos**
   (TG-007). Admitido, o comando `ligar` chama `ctx.emitirNonce('tunnel.up')` — via **ponte de
   nonce** do registry, que pede `nonce.request` ao host e espera `nonce.issued` (timeout
   5 s, fail-closed → sem nonce, sem confirmação possível, CTL-023).
3. O comando monta um `ActionRow` com o **nonce opaco** e o núcleo renderiza o teclado pelo sender.
4. O dono carrega no botão → o adaptador traduz o clique num `SurfaceActionEvent` (parsing do
   `callback_data` **na forma** `g1:<acao>:<token>`) com `answerTarget` preenchido.
5. O núcleo **responde ao clique sempre** (`sender.answer`, TG-027), revalida a identidade
   (TG-024), e só então emite a intent com o **token transportado opaco** (S5) — o **host** é quem
   valida o nonce e devolve o ack que o núcleo edita in-place na mensagem do botão.

O token **nunca** é validado, interpretado nem logado no worker — nem na ponte de nonce, cuja
única responsabilidade é o prazo.

---

## 4. Checklist — COMO ADICIONAR UM PROVEDOR NOVO

Um fornecedor só é **suportado** quando **toda** esta checklist fecha; uma entrada incompleta não
deve ser anunciada como suportada. Siga pela ordem.

### Passo 1 — criar `worker/providers/<id>/**`

Crie um diretório por provedor (ex.: `worker/providers/discord/**`). Como o Telegram
(`worker/providers/telegram/`), organize por responsabilidade:

- `cliente.<ext>` — constrói o client do fornecedor a partir do token/secreto;
- `polling.ts` **ou** `webhook.ts` — o loop de consumo / a montagem do endpoint (o adaptador é o
  **dono do próprio loop**; o núcleo não conhece polling nem webhook);
- `parse.ts` — o **parsing cru** do update do canal para um `SurfaceEvent` neutro;
- `teclado.ts` — renderiza as `ActionRowLayout` neutras na forma visual do canal e responde/edita;
- `token.ts` — lê o segredo do ambiente e recusa-o em `argv` (o análogo de TG-069);
- `transporte.ts` — auto-retry e observação da rede, quando o canal tiver equivalentes;
- `adapter.ts` — `create<Nome>Provider(deps) → ProviderAdapter` (o ponto de entrada).

Regras de fronteira do adaptador (D4):

- **importa só tipos** de `worker/surface/contract.ts` (e `src/contracts/ipc.ts` para os tipos de
  mensagem); **nada** de `worker/lib/*` nem do núcleo (`core.ts`/`auth.ts`/`commands.ts`).
- **nunca** importa de outro provedor.
- o grammY (ou o equivalente do seu canal) **vive só aqui** — nenhum outro ficheiro do worker o
  carrega.

### Passo 2 — implementar `ProviderAdapter` concreto

O objecto devolvido pelo `create<Nome>Provider` tem de fornecer:

- **`id`** — um rótulo estável e único (string);
- **`limits`** — o `SurfaceLimits` real do canal (veja Passo 4);
- **`start(handleEvent)`** — arranca o loop próprio e empurra `SurfaceEvent` para o handler;
  resolve quando estiver a receber, **rejeita** se o arranque falhar (o boot classifica e sai);
- **`stop()`** — para o loop e liberta recursos;
- **`publishCommands(commands)`** — publica a lista neutra (`COMANDOS_PUBLICADOS`) junto do canal
  (best-effort; falha logada, não derruba o boot);
- **`sender()`** — o `SurfaceSender` neutro (envia/edita/responde).

Se o canal tiver um análogo de *callback* (botão/inline), o `SurfaceEvent` de `acao`/`acao-invalida`
tem de carregar **`answerTarget` sempre** — o equivalente a responder ao clique para o girador não
ficar pendurado (TG-027). Sem isso o evento é semanticamente inválido.

### Passo 3 — eventos correctos

- **`comando`** — mensagens de texto; `identity` normalizada; `text` cru.
- **`acao`** — o clique num botão: `action` do vocabulário fechado + `token` opaco + `answerTarget`
  (obrigatório) + `messageTarget?` quando existir id de mensagem.
- **`acao-invalida`** — payload que não casa a forma do canal: `answerTarget` (obrigatório),
  `identity?` (para a contagem de descartes TG-089), `reason?`. **Nunca** forje `action`/`token`.

Não autorize **nada** no adaptador: entra como `SurfaceEvent`, o **núcleo** revalida a allowlist.

### Passo 4 — limites correctos

Declare em `SurfaceLimits` os valores **reais** do canal:

| Campo | O que preencher |
| --- | --- |
| `maxTextLength` | o teto de caracteres da mensagem (Telegram: 4096) |
| `maxActionRows` / `maxActionPerRow` | quantas linhas/colunas o teclado do canal renderiza |
| `maxActionDataBytes` | o teto **em bytes UTF-8** do payload de UMA ação (Telegram: 64) |
| `supportsEditing` | o canal edita mensagem in-place? (senão `false`) |

O núcleo corta o texto e raramente cada botão **dentro** destes limites — nunca estoura na rede.

### Passo 5 — token/segredo via allowlist de ambiente do host

- O segredo do provedor entra **só por ambiente**, no `tokenVar` certo, e **nunca** por `argv`
  (análogo de TG-069).
- No **host**, `src/proc/env.ts` tem a tabela `PROVIDER_ENV: Record<ProviderId, { tokenVar }>` —
  acrescente a sua linha (ex.: `whatsapp: { tokenVar: 'WHATSAPP_TOKEN' }`). `buildWorkerEnv` já
  coloca o token no `tokenVar` do provedor ativo e injeta `DSH_GUARD_PROVIDER` no filho — só
  precisa de mais uma entrada na tabela.
- O lado worker lê a env no `token.ts` do provedor (`lerTokenDoAmbiente`, `assertToken*EmArgv`).

### Passo 6 — registar no registry

Em `worker/providers/registry.ts`, acrescente **uma entrada** em `PROVIDERS` (a tabela fechada):

```ts
const DESCRICAO_<NOME>: ProvedorDescrito = {
  id: '<id>',
  create: (deps) => create<Nome>Provider(deps),
  lerToken: (env) => lerTokenDoAmbiente(env),
  assertTokenNaoEmArgv: (argv, token) => assertTokenNaoEmArgv(argv, token),
}
```

- Alargue o tipo `ProviderId` (`'telegram' | '<id>'`) em `worker/providers/registry.ts` **e** no
  tipo espelho em `src/proc/env.ts`.
- **Não** reescreva a entrada do Telegram: cada provedor é uma linha, nunca edita a do outro.

O registry resolve por `DSH_GUARD_PROVIDER` com **fail-closed**: ausente/vazio → `telegram` (único
que o host conhece hoje); **desconhecido → `ProvedorDesconhecidoError`**, nunca degrada em silêncio
(um provedor digitado mal seria um bot a nascer com o token de outro).

### Passo 7 — config `worker.provider` no host

Em `src/config/schema.ts`, o campo opcional `provider?: '<id> | 'telegram'` (ausente = default
`telegram`). A costura em `src/index.ts` lê `config.worker.provider ?? DEFAULT_PROVIDER`, escolhe o
`tokenVar` em `PROVIDER_ENV` e rotula o filho com `DSH_GUARD_PROVIDER`. Um provedor novo = o campo
ganha o literal e a linha em `PROVIDER_ENV`.

### Passo 8 — testes do adaptador com duble local

- Testes de **unidade** do adaptador isolado com um **duble local** (as fixtures e o servidor
  duplo do Telegram — `test/support/fixtures/telegram/` e `test/support/telegram-server.mjs` —
  mostram o padrão; um provedor novo teria o seu próprio `test/support/fixtures/<id>/`): parsing
  do update, limites, `answer` em todos os caminhos, token fora de `argv`.
- O teste **estrutural do cone de import** (ver §6) garante que o adaptador não puxa coisa proibida.
- Testes de **integração/e2e** com o duble do provedor (o padrão e2e offline do repo não toca rede).
- Um teste em `test/unit/worker/providers/registry.test.ts` para a nova entrada.

### Passo 9 — docs

- Uma **secção própria no manual** (ou §1 do README do provedor) com: instalação, configuração
  (incluindo o `tokenVar` e o nome da env), comandos suportados e limites declarados.
- Referencie o manual de provedores aqui e, na tabela do registry, a linha correspondente.

### O que significa "suportado"

**Todos os 9 passos fechados** — contrato implementado e semânticamente correcto (Passo 2/3),
limites reais (4), segredo por allowlist (5), registado e configurável (6/7), testado com duble
(8) e documentado (9). Um provedor sem docs (9) ou sem testes (8) **não** é suportado.

---

## 5. Segurança e invariantes

O regime de segurança é o mesmo para qualquer provedor — são os invariantes que o desacoplamento
**não** alterou:

- **Allowlist de dois eixos, default deny** — `worker/surface/auth.ts`: `autorizar` exige
  `hasUser(userKey) && hasChat(chatKey)` (TG-003, `&&` nunca `||`); lista vazia **nega até o dono**
  (TG-007); ausência de eixo = negação (TG-004). O dono pareado só é admitido porque `semearDono`
  o acrescenta aos **dois** conjuntos.
- **Ids como strings na fronteira** (D4) — `SurfaceIdentity` nunca carrega um `number`; o número do
  Telegram é `String(...)` no parser do adaptador e `Number(...)` devolve na ponte do registry.
- **NUNCA por `username`** — a allowlist é **só numérica** (`from.id`/`chat.id` → `userKey`/
  `chatKey`); nenhum adaptador lê `.username` (o teste estrutural assere isso).
- **NUNCA `RegExp` em texto de terceiros** — `RegExp.input`/`RegExp.lastMatch` são globais e
  sobrevivem ao retorno; o pareamento e a extração de comando varrem por `charCodeAt`, não por
  regex sobre texto da internet.
- **Limites 64 B/4096** — `callback_data` a 1..64 **bytes** (um acento vale 2) e mensagem a 4096;
  o corte é do núcleo, **antes** de ir à rede (TG-048).
- **Exit codes 10–14** (`worker/providers/telegram/interno.ts`, `WORKER_EXIT`) — preservados pelo
  boot genérico: `10` config/token, `11` conflito 409, `12` não-autorizado 401, `13` polling, `14`
  boot timeout, `0` OK.
- **S4 / S5** — nenhum tratador lança (o que falha é logado e segue); o nonce/token viaja **opaco**
  (S5): o worker não o gera (fora o token local do `/desligar`), não o valida, não o guarda — o
  host valida. O valor do nonce **nunca** é logado (S3).
- **Resposta ao clique sempre** (TG-027) — `answerTarget` é obrigatório em toda `acao`; no
  `acao-invalida` o núcleo responde mesmo assim (e conta, TG-089).

### 5.5 O cone de import do worker

O worker só pode importar de `src/` uma coisa: **`src/contracts/ipc.ts`** (tipos puros).
Nenhum ficheiro de `worker/**` importa `src/proc/*`, `src/logging/*`, `src/errors.ts` etc. — isso
arrastaria o código do host para dentro do processo que fala com a Internet. A superfície neutra
re-declara os literais de estado do túnel (`SurfaceTunnelState`) como união fechada; os espelhos
estruturais (`TimeSource`, `WorkerLogger`) satisfazem-se sem cast (ver `worker/surface/contract.ts`
e `worker/providers/telegram/interno.ts`). O **teste estrutural** deste cone está em
`test/unit/worker/surface/contract.structural.test.ts`.

---

## 6. Testes

Como rodar a suíte relevante (o gate completo está em [`docs/TESTING.md`](TESTING.md)):

```sh
pnpm test -- --test-name-pattern "worker/surface"      # núcleo e contrato neutros
pnpm test -- --test-name-pattern "worker/providers"    # registry + adaptador telegram
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:security && pnpm test:e2e  # gate
```

- **Teste estrutural do cone** — `test/unit/worker/surface/contract.structural.test.ts` assere
  que `worker/surface/**` não importa grammY, `worker/lib/*` nem `src/**` fora de
  `src/contracts/ipc.ts`; o `contract.test.ts` cobre o tipo-a-tipo do contrato.
- **Núcleo** — `test/unit/worker/surface/{core,auth,commands,outbox,text,actions,ids}.test.ts`.
- **Adaptador telegram** — `test/unit/worker/providers/telegram/**` (parse, teclado, token,
  transporte, cliente, polling, adapter) com o **duble local** (`test/support/`); o
  `adapter.test.ts` cobre `answerTarget`/TG-027 e o `descartados`/TG-089.
- **Registry e boot** — `test/unit/worker/providers/registry.test.ts`,
  `test/unit/worker/telegram-bot.test.ts` (com `WorkerRuntime` injectável, sem subprocesso).
- **E2E com o duble** — `test/e2e/**` sobe o worker contra os dublês locais; a re-confirmação
  **através** da borda real é a suíte `test/live/**`, opt-in e fora do gate.

---

## 7. Trabalho futuro

- **Neutralização do envelope IPC numérico → string.** O contrato neutro carrega `userKey`/
  `chatKey` como strings, mas o corpo do `IpcIntentMessage` V1 do canal ainda tipa `from`/`chat`
  como `number` (herança Telegram). Hoje a conversão `Number(...)` vive **na ponte**
  (`montarEnvelopeDeIntent` + `criarSurfaceIpcBridge` em `worker/providers/registry.ts`) e na
  fronteira do adaptador telegram (`sender()`); ela é fiel **porque** o alfabeto do id do Telegram
  é `[0-9]+`. Um id **não-numérico** de um provedor futuro (ex.: uma string de WhatsApp) exige a
  neutralização do corpo do canal em `src/ipc/channel.ts` + `src/contracts/ipc.ts` (a mesma lógica
  está documentada no cabeçalho de `worker/providers/registry.ts` e na doc inline de
  `worker/surface/contract.ts`).
- Procurar o restante do caminho de consumo do provedor no host: `src/index.ts` resolve o
  `tokenVar` por `provider`, `src/ui-contrib/bot-state.ts` já é provider-agnóstico e o estado
  persistido tem o campo aditivo `provider?` (`src/contracts/state.ts`).

---

## 8. Referências

- Contrato neutro: `worker/surface/contract.ts` (documentação inline tipo-a-tipo).
- Núcleo neutro: `worker/surface/core.ts` (§3.1 a §3.10 descrevem o fluxo real).
- Registry + ponte IPC + ponte de nonce: `worker/providers/registry.ts`.
- Adaptador telegram: `worker/providers/telegram/**`; boot genérico: `worker/telegram-bot.ts`.
- Host provedor-aware: `src/proc/env.ts` (allowlist + `PROVIDER_ENV` + `DSH_GUARD_PROVIDER`),
  `src/config/schema.ts` (`worker.provider`), `src/contracts/state.ts` (`provider?`).
- Habilidades de apoio (skills): `.agents/skills/dsh-provider-bot` e `.agents/skills/`
  `dsh-telegram-provider`.