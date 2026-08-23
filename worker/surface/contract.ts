/**
 * O CONTRATO NEUTRO DA SUPERFICIE DE MENSAGERIA — o que QUALQUER provedor
 * (Telegram hoje, WhatsApp/Discord/Matrix/Signal/Slack amanha) implementa, e o
 * que o nucleo neutro consome.
 *
 * DONO: onda 1 do desacoplamento parler-to-providers. LEITURA LIVRE nos
 * ficheiros de referencia (`worker/commands/router.ts` §6-8,
 * `worker/auth/{guard,allowlist,pairing}.ts`, `worker/lib/{outbox,keyboard}.ts`
 * e `src/contracts/ipc.ts`); ESCRITA PROIBIDA em qualquer outro arquivo.
 *
 * ===========================================================================
 * A FRONTEIRA (D4): TELEGRAM VIRA STRING, E NADA DE grammY AQUI DENTRO
 * ===========================================================================
 * Os ids numericos do Telegram (`from.id`, `chat.id`) viram strings na fronteira
 * neutra: {@link SurfaceIdentity}. Cada provedor normaliza as suas chaves para
 * `userKey`/`chatKey` (ver `./ids.ts`) e o nucleo neutro nunca toca um `number`.
 * Manter os campos como `string` e deliberado:
 *   - remove a dependencia do alfabeto numerico de um provedor especifico
 *     (WhatsApp usa strings, Matrix urls, Signal numeros em formato proprio);
 *   - `chatKey` guarda o id da conversa, `userKey` o id de quem age — os DOIS
 *     eixos que `worker/auth/allowlist.ts` revalida em cada update (TG-002/003)
 *     e que `worker/auth/pairing.ts` grava no dono.
 *
 * NENHUM tipo aqui importa de `grammy`, de `worker/lib/*` nem de qualquer
 * arquivo existente fora de `src/contracts/`. O contrato e self-contained:
 * importa APENAS `IpcIntentName`/`IpcIntentMessage` (tipos puros de
 * `src/contracts/ipc.ts`, a unica coisa de `src/` que o worker pode importar —
 * `05-QUALIDADE-CODIGO.md` 5.5) — e, mesmo esses, so onde a semantica os exige.
 *
 * ===========================================================================
 * O PONTE DIVIDIDO: ADAPTADOR PRODUZ EVENTOS, SENDER ENTREGA, NUCLEO DECIDE
 * ===========================================================================
 * Um `ProviderAdapter` e DONO do seu proprio loop de consumo (long polling,
 * webhook, socket...) e EMPURRA {@link SurfaceEvent} para o handler que o
 * nucleo lhe passa no `start()`. O nucleo neutro nao sabe o que e polling nem
 * webhook — sabe apenas que, por cada evento, aplica a allowlist de dois eixos e
 * o receptor de pareamento, e produz uma ou mais saidas atraves do
 * {@link SurfaceSender}. O truque da divisao:
 *
 *   - ENTRADA (o que o provedor produz):  {@link SurfaceEvent} — COMANDO ou ACAO.
 *   - SAIDA  (o que o provedor entrega):  {@link SurfaceSender} — enviar/editar/
 *     responder, com {@link SurfaceSendOptions.actionRows} para botoes.
 *
 * O adaptador e assim responsavel por TRADUZIR o clique de um botao num evento
 * de ACAO neutro ({@link SurfaceEvent}), e por RENDERIZAR as linhas de acao
 * neutras ({@link ActionRow}) no formato visual do provedor.
 *
 * ===========================================================================
 * O TOKEN VIAJA OPACO (S5) — O HOST VALIDA, O NUCLEO NEUTRO SO TRANSPORTA
 * ===========================================================================
 * {@link SurfaceAction} carrega um token OPACO: o nucleo neutro nao o gera, nao
 * o valida, nao o guarda (invariante **S5** de `src/contracts/ipc.ts`). O token
 * e emitido pelo host e consumido pelo host; o nucleo apenas o transporta do
 * clique do botao ate ao `nonce`/target do intent. {@link SurfaceActionData}, o
 * payload serializado que o adaptador coloca no botao, e o equivalente neutro do
 * `callback_data` do Telegram — e a forma verifica-se por nos, o valor nao.
 */

import type { IpcIntentName } from '../../src/contracts/ipc.ts'

/* ========================================================================== */
/* 1. IDENTIDADE NEUTRA (D4)                                                   */
/* ========================================================================== */

/**
 * Os dois eixos da identidade na fronteira neutra, como STRINGS.
 *
 * `userKey` — quem age (o `from.id` do Telegram); `chatKey` — onde (o
 * `chat.id`). Os dois sao sempre necessarios: a allowlist revalida AMBOS em
 * cada update (TG-003 — num grupo `userKey` e o do membro que carregou no
 * botao, `chatKey` o do grupo autorizado). Um evento sem um dos dois nao pode
 * existir: sem `chatKey` nao ha para onde responder, sem `userKey` o eixo que
 * distingue o dono de um estranho fica vazio.
 */
export interface SurfaceIdentity {
  /** Quem age no proveniente evento. Nunca vazio (normalizado em `./ids.ts`). */
  readonly userKey: string
  /** A conversa onde o evento acontece. Nunca vazio (normalizado). */
  readonly chatKey: string
}

/** A assembleia minima que {@link SurfaceIdentity} carrega — util para propagar. */
export type SurfaceIdentityLike = Readonly<Pick<SurfaceIdentity, 'userKey' | 'chatKey'>>

/**
 * O dono pareado, como portador do pareamento para a ponte IPC — os DOIS EIXOS
 * (D4, STRING) + o instante. Espelho estrutural do `SurfaceDono` do nucleo
 * (`worker/surface/core.ts`); declarado aqui (em vez de o importar) para o
 * contrato continuar self-contained.
 */
export type SurfacePairingOwnerLike = Readonly<{
  /** `from.id` do dono, como string (D4). */
  userKey: string
  /** `chat.id` do dono, como string (D4). */
  chatKey: string
  /** Epoch ms do pareamento. */
  pairedAt: number
}>

/* ========================================================================== */
/* 2. AS ACOES DE CONTROLO (o equivalente neutro do `callback_data`)           */
/* ========================================================================== */

/**
 * As acoes de controlo do nucleo — o espelho neutro do `callback_data` do
 * Telegram. O vocabulario e FECHADO e casa com `IpcIntentName` de
 * `src/contracts/ipc.ts`: cada acao do nucleo corresponde a uma intencao que o
 * host consome.
 *
 * `'tunnel.status'` e `'session.issue'` entram no tipo porque sao intents
 * legitimas que viajam pelo canal; MAS o roteador atual nunca RENDERIZA um botao
 * delas (`worker/commands/router.ts` `tratarCallback`: «Nunca renderizamos
 * botoes destas acoes»). O tipo preserva essa possibilidade para o proximo
 * agente decidir, sem obrigar a renderizar hoje.
 */
export type SurfaceAction = IpcIntentName

/**
 * O payload serializado que o adaptador coloca no botao de um provedor — o
 * equivalente neutro de `callback_data`. Este tipo carrega o que um botao
 * precisa: a acao e o token. O adaptador serializa o par no formato do canal
 * (o Telegram usa `g1:<acao>:<token>`; outro provedor, a sua forma).
 *
 * O `token` e OPACO (S5): o nucleo nunca valida o valor, apenas garante que
 * existe na forma. Um botao que chegue sem token e recusado na FORMA — nenhum
 * comando administrativo accionavel numa etapa (o mesmo principio de TG-025).
 */
export interface SurfaceActionData {
  readonly action: SurfaceAction
  /** Opaco. O host valida; o nucleo transporte. Nunca vazio. */
  readonly token: string
}

/* ========================================================================== */
/* 3. LIMITES DO PROVEDOR                                                      */
/* ========================================================================== */

/**
 * Os limites concretos do canal de cada provedor. O nucleo usa-os para cortar
 * texto antes de enviar e para renderizar as linhas de acao dentro do que o
 * canal aceita — a mesma disciplina de «o corte e nosso, nunca estoura na
 * rede» que `worker/lib/outbox.ts` aplica ao Telegram (TG-048).
 */
export interface SurfaceLimits {
  /**
   * Teto de caracteres de uma mensagem de texto (Unicode code points). O
   * equivalente neutro dos 4096 do Telegram — o nucleo corta AQUI, nunca apos a
   * ida a rede.
   */
  readonly maxTextLength: number
  /** Quantas linhas de acao o canal renderiza num teclado/balao. -> 0 = sem botoes. */
  readonly maxActionRows: number
  /** Quantas acoes por linha de teclado/balao o canal cabe. */
  readonly maxActionPerRow: number
  /**
   * Teto em BYTES UTF-8 do payload serializado de UMA acao (`callback_data` do
   * Telegram e 64 bytes). A medida e em bytes e nao em caracteres, identico ao
   * `worker/lib/keyboard.ts` CALLBACK_DATA_MAX_BYTES: um acento vale 2 bytes.
   */
  readonly maxActionDataBytes: number
  /**
   * `true` se o canal permite editar uma mensagem no lugar. `false` (ex. alguns
   * canais de difusos so enviam) obriga o nucleo a enviar uma mensagem nova em
   * vez de editar.
   */
  readonly supportsEditing: boolean
}

/* ========================================================================== */
/* 4. BOTOES NEUTROS E AS LINHAS DE ACAO                                       */
/* ========================================================================== */

/**
 * Uma acao renderizavel: rotulo legivel + a acao de controlo E o respectivo
 * token opaco que a dispara.
 *
 * `token` e o CERNE da confirmacao em 2 etapas (til stream real: comando ->
 * `emitirNonce('tunnel.up')` -> botao com o nonce -> tap -> intent). Sem ele
 * um botao nao transportaria o nonce/`token` e a confirmacao seria
 * inrepresentavel. O token viaja OPACO: o nucleo neutro nao o valida, nao o
 * compara e nao o gera — apenas o anexa ao botao (SAIDA) e o re-transporta no
 * evento de ACAO (ENTRADA). O HOST valida (S5); nunca logado (S3).
 *
 * `kind` anota a NATUREZA da acao para o adaptador decidir a apresentacao
 * (confirmacao vs emergencia). Nao pode anular o `action` — e meramente
 * informativo do dano.
 */
export interface ActionRow {
  /** O rotulo visivel. Carrega a semantica (emoji e texto funcionam). */
  readonly label: string
  /** A acao de controlo que esta linha dispara. */
  readonly action: SurfaceAction
  /**
   * OPACO — o nonce emitido pelo host (acoes que aumentam exposicao) ou o
   * token local do worker (acoes que reduzem). Anexa-se ao botao e viaja de
   * volta no {@link SurfaceActionEvent.token}. Nunca validado nem logado no
   * worker (S3/S5).
   */
  readonly token: string
  /** `'confirm'`/`'emergency'` quando a acao aumenta/reduz exposicao. Opcional. */
  readonly kind?: 'confirm' | 'emergency' | undefined
}

/** Um teclado/balao inteiro: uma lista de linhas, cada uma com uma ou mais acoes. */
export type ActionRowLayout = readonly (readonly ActionRow[])[]

/**
 * Opcoes de envio/edicao neutras que substituem o `reply_markup` do Telegram.
 *
 * `actionRows` chega ja DENTRO dos limites de {@link SurfaceLimits}: o nucleo
 * corta e separa em linhas/colunas antes de enviar, e o adaptador apenas
 * RENDERIZA. {@link ActionRowLayout} define a forma: linhas, cada uma com uma
 * ou mais acoes.
 */
export interface SurfaceSendOptions {
  readonly actionRows?: ActionRowLayout | undefined
  /** Impede a pre-visualizacao de link do canal (o `link-magico` do notify). */
  readonly disableWebPagePreview?: boolean | undefined
}

/* ========================================================================== */
/* 5. EVENTOS QUE O PROVEDOR PRODUZ                                           */
/* ========================================================================== */

/**
 * Evento de COMANDO — uma mensagem de texto que o nucleo deve interpretar como
 * um comando (`/ligar`, `/parear ...`, texto livre). Vem com a identidade ja
 * normalizada; o TEXTO e tratado como cru e `worker/commands/router.ts`
 * `extrairNomeDeComando` decide se e um comando.
 */
export interface SurfaceCommandEvent {
  readonly kind: 'comando'
  readonly identity: SurfaceIdentity
  /** O texto da mensagem, cru (sem normalizacao de comando). */
  readonly text: string
}

/**
 * Evento de ACAO — o clique num botao que o nucleo renderizou.
 *
 * `answerTarget` identifica o clique junto do provedor (o `callback_query.id`
 * do Telegram): o nucleo SEMPRE responde (protocolo — TG-027), inclusive na
 * negacao. `messageTarget` aponta a mensagem onde o botao vive (o
 * `message.message_id`), para o nucleo editar in-place a resposta/rejeicao.
 */
export interface SurfaceActionEvent {
  readonly kind: 'acao'
  readonly identity: SurfaceIdentity
  /** A acao de controlo disparada. */
  readonly action: SurfaceAction
  /** OPACO — o host valida. O nucleo so transporta (S5). */
  readonly token: string
  /** Identificador do clique a responder. Obrigatorio (protocolo TG-027). */
  readonly answerTarget: string
  /** Identificador da mensagem-alvo (onde o botao vive), se o canal o tiver. */
  readonly messageTarget?: string | undefined
}

/**
 * Evento de ACAO MALFORMADA/DESCARTAVEL — um clique cujo payload nao casa a
 * forma esperada (o `callback_data` que nao e `g1:<acao>:<token>`).
 *
 * No Telegram o guard DESCARTE esse update MAS o responde (faz parar o
 * girador — TG-027) E o conta (TG-089 — "descartado e contado"). Este evento
 * preserva esses dois factos para o nucleo neutro:
 *
 *   - `answerTarget` deixa o nucleo cumprir o protocolo de resposta (o
 *     equivalente a `answerCallbackQuery` silencioso) e evitar que o click do
 *     cliente fique pendurado;
 *   - `identity` (quando o provedor a leu) alimenta a contagem/auditoria do
 *     descarte — o mesmo valor forense do `decideUpdate` da allowlist.
 *
 * Nao ha `action` nem `token`: o payload nao os carregou validamente, e
 * inventa-los aqui seria forjar uma acao que o host nunca validou (S5). O
 * nucleo responde e conta, nada mais.
 */
export interface SurfaceActionRejectedEvent {
  readonly kind: 'acao-invalida'
  /** Os eixos, quando o provedor os conseguiu ler do update (para a contagem). */
  readonly identity?: SurfaceIdentity | undefined
  /** O alvo de resposta do clique. Obrigatorio: o nucleo responde SEMPRE. */
  readonly answerTarget: string
  /** Motivo de recusa, quando o provedor o tem (ex.: forma, tamanho, esquema). */
  readonly reason?: string | undefined
}

/** A uniao discriminada minima que o nucleo consome e o adaptador produz. */
export type SurfaceEvent = SurfaceActionRejectedEvent | SurfaceCommandEvent | SurfaceActionEvent

/* ========================================================================== */
/* 6. O SENDER NEUTRO                                                          */
/* ========================================================================== */

/**
 * Veredito de uma edicao in-place — o espelho de `EditOutcome` de
 * `worker/lib/keyboard.ts`.
 */
export type SurfaceEditOutcome = 'edited' | 'unchanged' | 'failed'

/**
 * A superficie de envio NEUTRA. O adaptador fornece-a ao boot e o nucleo usa-a
 * para TUDO o que sai para o chat — nada de grammY/Telegram especifico aqui.
 *
 * `send` devolve o identificador da mensagem nova (para o nucleo registar o
 * pendente e editar depois); `edit` devolve o veredito (NUNCA lanca — ver
 * `worker/lib/keyboard.ts` editMessageTextInPlace); `answer` responde ao clique
 * sem mensagem nova (o girador do Telegram).
 */
export interface SurfaceSender {
  /** Envia UMA mensagem nova. Resolve com o id da mensagem criada. */
  send(chatKey: string, texto: string, opcoes?: SurfaceSendOptions): Promise<string>
  /**
   * Edita a mensagem `messageId` no lugar. NUNCA lanca: devolve o veredito
   * (`'unchanged'` quando o canal recusa edicao identica). Sem suporte do canal,
   * o nucleo nao a chama (`supportsEditing === false`).
   */
  edit(
    chatKey: string,
    messageId: string,
    texto: string,
    opcoes?: SurfaceSendOptions,
  ): Promise<SurfaceEditOutcome>
  /**
   * Responde ao clique `answerTarget` (faz parar o girador). NUNCA lanca —
   * devolve `true` sse o canal aceitou. Chamada em TODOS os caminhos (TG-027).
   */
  answer(answerTarget: string, outras?: { readonly text?: string; readonly showAlert?: boolean }): Promise<boolean>
}

/**
 * Quem CRIA o sender a partir de um adaptador, no boot. O nucleo chama isto com
 * o adaptador concreto e recebe um {@link SurfaceSender} pronto.
 *
 * ESCOLHA DE DESENHO (D-onda-1, registada para o nucleo da onda 2): e a forma
 * mais simples — o adaptador expoe `sender()` ({@link ProviderAdapter}) e a
 * fabrica e, em pratica, `(adapter) => adapter.sender()`. Existe como tipo
 * proprio para o BOOT poder injetar um sender sintetico (um duplo de teste) sem
 * tocar no `ProviderAdapter` concreto.
 */
export type SurfaceSenderFactory = (adapter: ProviderAdapter) => SurfaceSender

/* ========================================================================== */
/* 7. O CONTEXTO DO COMANDO (o EIXO QUE O NUCLEO PRODUZ)                       */
/* ========================================================================== */

/**
 * A intent NEUTRA que atravessa a ponte — chaves STRING (D4).
 *
 * DONO unico deste tipo (onda 5a): `commands.ts` e `core.ts` produzem esta forma
 * e {@link SurfaceIpcBridge.send} aceita-a. O ENVELOPE numerico (`from`/`chat`
 * do `IpcIntentMessage` V1) e responsabilidade da PONTE, nao do chamador — a
 * `criarSurfaceIpcBridge` de `worker/providers/registry.ts` e quem monta e envia
 * o `IpcIntentMessage` completo (o cast falsa atribuicao da Onda 2 morre aqui).
 */
export interface IntencaoNeutra {
  readonly intent: IpcIntentName
  readonly requestId: string
  readonly userKey: string
  readonly chatKey: string
  /** Nas acoes que AUMENTAM exposicao. Opaco (S5) — nunca validado aqui. */
  readonly nonce?: string | undefined
}

/**
 * A ponte que o nucleo neutro precisa antes de poder produzir intents; o
 * equivalente neutro do `ipc` do `ContextoDoComando` de `worker/commands/router.ts`.
 *
 * `send` recebe a intent NEUTRA e devolve `true` sse o canal aceitou. O envelope
 * numerico do canal (`IpcIntentMessage`) e montado pela implementacao da ponte,
 * nunca pelo nucleo nem pelos comandos.
 */
export interface SurfaceIpcBridge {
  send(pedido: IntencaoNeutra): boolean
  /**
   * Comunica ao host que o pareamento CONCLUIU no worker (`/parear <codigo>`
   * valido). Best-effort e fire-and-forget: o nucleo NAO derruba nada se a
   * entrega falhar (S4); quem re-pareia depois re-envia. O host responde
   * `pairing.owner` (liberta a allowlist) e persiste o dono no `state.json`.
   * NUNCA logar ids alem do minimo.
   */
  pairingSuccess(dono: SurfacePairingOwnerLike): void
}

/**
 * Nominacao de nonce: a acao que AUMENTA exposicao pede-o ao host pelo canal
 * (S5); `undefined` = host indisponivel/timeout, e o comando falha FECHADO.
 */
export type EmitirNonce = (acao: SurfaceAction) => Promise<string | undefined>

/** Estado pendente de um intent — o registo que o ack consome depois. */
export interface SurfacePendingIntent {
  readonly requestId: string
  readonly chatKey: string
  readonly acao: SurfaceAction
  readonly messageTarget: string | undefined
}

/**
 * Estados do tunel — ESPELHO LOCAL do enum `TunnelState` de
 * `src/contracts/tunnel.ts`.
 *
 * PORQUE EXISTE: §5.5 de `05-QUALIDADE-CODIGO.md` proibe o worker de importar
 * qualquer coisa de `src/` que nao seja `src/contracts/ipc.ts` — nao se arrasta
 * codigo do HOST para dentro do processo que fala com a internet. A superficie
 * neutra re-declara aqui, como uniao fechada, os SEIS literais EXATOS do enum do
 * host; o footprint (a string em si) e idêntico, entao a projecao continua a
 * casar por estrutura com a mensagem IPC. Manter os literais sincronizados e um
 * trade-off aceite: se o enum do host crescer, o teste estrutural do contrato e
 * o typecheck denunciam a divergencia na integracao.
 */
export type SurfaceTunnelState =
  | 'STOPPED'
  | 'STARTING'
  | 'READY'
  | 'DEGRADED'
  | 'STOPPING'
  | 'FAILED'

/** Projeccao de estado que o nucleo mantem — o espelho de `ProjecaoDeEstado`. */
export interface SurfaceProjectionState {
  /**
   * Estado do tunel como STRING neutra (o contrato de `src/contracts/tunnel.ts`
   * usa o enum `TunnelState`). O nucleo da onda 2 estreita-a ao tipo concreto;
   * aqui so se garante a forma.
   */
  readonly state: string | undefined
  readonly seq: number
  readonly url?: string | undefined
  readonly expiresAt?: number | undefined
  readonly readyDesde?: number | undefined
}

/**
 * Log ESTRUTURAL que o nucleo oferece aos comandos — os QUATRO níveis de um
 * `WorkerLogger`, sem importar de `worker/lib/*`.
 *
 * Um {@link WorkerLogger} real (`worker/lib/log.ts`) satisfaz este tipo sem
 * cast: expoe exactamente `debug/info/warn/error(message, fields?)`. Aqui
 * repete-se a forma ESTRUTURAL (nao um import de `worker/lib`) porque o
 * contrato tem de continuar self-contained — mesmo que o `WorkerLogger` do
 * processo mudasse de assinatura, o nexo deste tipo é com a forma, nao com o
 * modulo. Comandos neutros usam `log.info`/`log.warn` (auditoria).
 */
export interface SurfaceCommandLog {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/**
 * O contexto que o EIXO DO NUCLEO produz e que os COMANDOS neutros consomem.
 * Espelha `ContextoDoComando` de `worker/commands/router.ts` §7, mas com
 * `chatKey: string` e SEM tipos Telegram — {@link SurfaceSender} no lugar da
 * `ApiDoBot`, {@link EmitirNonce} para o nonce, e as interfaces ipc/projection.
 */
export interface SurfaceCommandContext {
  readonly log: SurfaceCommandLog
  readonly time: {
    readonly now: () => number
    readonly sleep: (ms: number) => Promise<void>
  }
  readonly ipc: SurfaceIpcBridge
  readonly emitirNonce: EmitirNonce
  /** Derruba o worker/provedor (emergencia). */
  readonly parar: () => Promise<void>
  /** Envia UMA mensagem nova. Devolve o `messageTarget` (id da mensagem). */
  enviar(chatKey: string, texto: string, opcoes?: SurfaceSendOptions): Promise<string>
  /** Edita in-place. NUNCA lanca; devolve o veredito. */
  editar(
    chatKey: string,
    messageTarget: string,
    texto: string,
    opcoes?: SurfaceSendOptions,
  ): Promise<SurfaceEditOutcome>
  /** Mostra TEXTO DE ESTADO: edita a ultima mensagem de estado ou envia nova. */
  mostrarEstado(chatKey: string, texto: string): Promise<string>
  /** Responde ao clique. NUNCA lanca; devolve `true` sse o canal aceitou. */
  responder(
    answerTarget: string,
    outras?: { readonly text?: string; readonly showAlert?: boolean },
  ): Promise<boolean>
  pendente: {
    registar(requestId: string, chatKey: string, acao: SurfaceAction, messageTarget: string | undefined): void
    retirar(requestId: string): SurfacePendingIntent | undefined
  }
  projecao: { ler(): SurfaceProjectionState }
  /** A `chatKey` do dono pareado, ou `undefined` antes do pareamento. */
  dono(): string | undefined
}

/* ========================================================================== */
/* 8. O ADAPTADOR DE PROVEDOR                                                  */
/* ========================================================================== */

/** Uma publicacao de comando do nucleo (o `setMyCommands` do Telegram). */
export interface SurfacePublishedCommand {
  readonly command: string
  readonly description: string
}

/**
 * O contrato que CADA PROVEDOR implementa. E DONO do seu proprio loop de
 * consumo: arranca, recebe updates do canal e empurra {@link SurfaceEvent} para
 * o handler — o nucleo neutro nao sabe o que e polling nem webhook.
 */
export interface ProviderAdapter {
  /** Identificador estavel do provedor (ex.: `'telegram'`, `'discord'`). */
  readonly id: string
  /** Os limites do canal, para o nucleo cortar e renderizar. */
  readonly limits: SurfaceLimits
  /**
   * Arranca o loop de consumo. O nucleo passa-lhe o handler para onde TODO o
   * update vira um {@link SurfaceEvent}. Resolve quando o loop estiver a
   * receber, ou rejeita se o arranque falhar (token invalido, conflito).
   */
  start(handleEvent: (event: SurfaceEvent) => Promise<void>): Promise<void>
  /** Para o loop de consumo e liberta os recursos do provedor. */
  stop(): Promise<void>
  /** Publica a lista canonica de comandos junto do provedor (best-effort). */
  publishCommands(commands: readonly SurfacePublishedCommand[]): Promise<unknown>
  /**
   * O {@link SurfaceSender} que este adaptador usa para toda a saida de texto,
   * botoes e respostas ao clique. O BOOT chama {@link SurfaceSenderFactory} com
   * este adaptador para obter o sender neutro do nucleo; em pratica a fabrica
   * devolve `adapter.sender()`.
   */
  sender(): SurfaceSender
}