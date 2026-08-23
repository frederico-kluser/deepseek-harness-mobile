/**
 * O NUCLEO NEUTRO DA SUPERFICIE (onda 2 — nucleo): o roteador comando -> intent
 * IPC, REescrito 100% neutro — nao conhece o Telegram, o grammY nem o update cru.
 *
 * Port FIEL de `worker/commands/router.ts` (DONO de referencia: T5.2). Nenhuma
 * semantica muda: projeccao de estado, coalescencia de 1 msg/s por chat, autolink
 * (`/ligar` -> READY -> `session.issue` uma vez), mapa de intents pendentes
 * (MAX_PENDENTES = 64, FIFO), o funil pareamento -> allowlist (PAIR-006/007) e os
 * cinco/seis tratadores do canal (S4: nunca lancam). O que muda e a FRONTEIRA:
 * tudo o que era `chatId: number` + `ApiDoBot` vira `chatKey: string` +
 * {@link SurfaceSender} (do contrato); o update cru vira {@link SurfaceEvent}.
 *
 * ===========================================================================
 * O QUE ESTE MODULO IMPORTE (e por que)
 * ===========================================================================
 *   - do CONTRATO (`worker/surface/contract.ts`): os TIPOS neutros que definem a
 *     fronteira — {@link SurfaceEvent}, {@link SurfaceCommandContext},
 *     {@link SurfaceSender}, {@link SurfaceIpcBridge}, {@link SurfaceLimits}, etc.,
 *     incluindo o espelho local {@link SurfaceTunnelState} do vocabulario de estado
 *     do tunel (`src/contracts/tunnel.ts` NAO pode ser importado aqui — §5.5).
 *   - de `src/contracts/ipc.ts`: os TIPOS das mensagens host -> worker (state/ack/
 *     error/notify/pairing.challenge/pairing.owner) e o `IpcIntentMessage` que o
 *     `ipc.send` produz — e a UNICA coisa de `src/` que o worker pode importar
 *     (`05-QUALIDADE-CODIGO.md` 5.5).
 *   - `node:crypto` (builtin): para construir o VERIFICADOR do codigo de
 *     pareamento a partir do digest (S3-b) em {@link onPairingChallenge} — port fiel.
 *   - do NUCLEO: `text.ts`, `actions.ts`, `tokens.ts`.
 *
 * NAO importa de `worker/auth/**`, `worker/lib/**` nem `worker/commands/**`: esses
 * ficheiros sao donos de outras ondas e o nucleo fica self-contained.

 * ===========================================================================
 * AS DUAS DEPENDENCIAS INJETADAS QUE A ONDA 4 LIGA (O CONTRATO DE SAIDA)
 * ===========================================================================
 * O nucleo NAO implementa a allowlist nem os comandos — sao os donos paralelos da
 * onda 2 (`worker/surface/auth.ts`, `worker/surface/commands.ts`). Este ficheiro
 * define as INTERFACES estruturais que eles satisfazem, para a onda 4 as ligar:
 *
 *   - {@link SurfaceAuth} — o funil NEUTRO: receptor de pareamento (sobre
 *     `SurfaceCommandEvent`) + guard de identidade (dois eixos string) + o estado
 *     do dono e a semeadura por `pairing.owner`. A ordem PARAR -> ALLOWLIST (PAIR-
 *     006/007) vive AQUI, no nucleo, como no router antigo.
 *   - {@link SurfaceComandos} — o despacho neutro dos comandos (port de
 *     onoff/access/status), que consomem o {@link SurfaceCommandContext} que este
 *     nucleo produz.
 *
 * O que chega pronto por fora (a costura da onda 4 obtе́m do adaptador):
 * {@link SurfaceSender} (de `adapter.sender()`), {@link SurfaceIpcBridge} (o canal
 * IPC), `emitirNonce` (a ponte de nonce host), `parar` (derruba o worker).
 *
 * ===========================================================================
 * S4 / S5 / TG-0xx NESTE FICHEIRO
 * ===========================================================================
 * - S4: nenhum tratador lanca. Cada `on*` embrulha o corpo em try/catch e o que
 *   falha e logado e segue. As tarefas de renderizacao em segundo plano ganham
 *   `.catch` explicito (uma rejeicao nao tratada em Node 24 mata o processo).
 * - S5: o nonce/token viaja OPACO — nunca validado, nunca logado. O token do
 *   {@link SurfaceActionEvent} e re-enviado no `nonce` do `IpcIntentMessage`; o
 *   HOST valida.
 * - TG-027: responde-se ao clique em TODOS os caminhos (inclusive na negacao).
 * - TG-089: o descarte e silencioso E contado.
 * - TG-028: as respostas editam a mensagem in-place a partir de `messageTarget`.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import type {
  IpcAckMessage,
  IpcErrorCode,
  IpcErrorMessage,
  IpcIntentName,
  IpcNotifyMessage,
  IpcPairingChallengeMessage,
  IpcPairingOwnerMessage,
  IpcStateMessage,
} from '../../src/contracts/ipc.ts'

import { botoesDeAlerta, extrairAlerta } from './actions.ts'
import {
  type EmitirNonce,
  type IntencaoNeutra,
  type SurfaceAction,
  type SurfaceActionEvent,
  type SurfaceCommandContext,
  type SurfaceCommandEvent,
  type SurfaceEditOutcome,
  type SurfaceEvent,
  type SurfaceIdentity,
  type SurfaceIpcBridge,
  type SurfaceLimits,
  type SurfacePendingIntent,
  type SurfaceProjectionState,
  type SurfacePublishedCommand,
  type SurfaceSender,
  type SurfaceTunnelState,
} from './contract.ts'
import { cortarTexto, textoDeEstado } from './text.ts'
import { criarOutbox } from './outbox.ts'
import { gerarRequestId } from './tokens.ts'
import { COMANDOS_PUBLICADOS } from './commands.ts'

// Re-export da lista canonica (dono unico em commands.ts, onda 5a): o nucleo
// publica-a por `setMyCommands` e o ponto de entrada tipado re-expõe-a aqui.
export { COMANDOS_PUBLICADOS } from './commands.ts'

/* ========================================================================== */
/* 1. A LISTA CANONICA (D5) — publicada por setMyCommands                       */
/* ========================================================================== */

/**
 * Forma minima de um comando publicado — estrutural, para o teste (TG-080).
 * Espelha {@link SurfacePublishedCommand} do contrato; mantem-se como alias para
 * nao partir o cone de import dos testes do nucleo.
 */
export type ComandoPublicado = SurfacePublishedCommand

/**
 * A lista FECHADA, na ordem de D5. TG-080 compara o array inteiro. DONO unico:
 * `worker/surface/commands.ts` (onda 5a) — SEM duplicacao; este nucleo importa-a
 * e re-exporta-a para o teste/publish.
 */

/** O que `setMyCommands` precisa de receber. Estrutural, para o teste. */
export interface SetMyCommandsApi {
  setMyCommands(other: { readonly commands: readonly ComandoPublicado[] }): Promise<unknown>
}

/** Publica a lista canonica. TG-080: o array chega inteiro, na ordem. */
export async function registarComandosPublicados(api: SetMyCommandsApi): Promise<unknown> {
  return api.setMyCommands({ commands: COMANDOS_PUBLICADOS })
}

/* ========================================================================== */
/* 2. LEITURA DO COMANDO                                                       */
/* ========================================================================== */

/**
 * Extrai o nome de `/comando[ argumentos]` (aceita o sufixo `@bot` que o cliente
 * monta em grupo). Devolve `undefined` quando nao ha comando. Varrimento manual e
 * nao regex, pela mesma razao de `worker/auth/pairing.ts`: nada de `RegExp.input`
 * com texto vindo da internet.
 */
export function extrairNomeDeComando(texto: string): string | undefined {
  const aparado = texto.trim()
  if (!aparado.startsWith('/')) return undefined
  const espaco = indiceDeEspacoAscii(aparado)
  const cabeca = espaco === -1 ? aparado : aparado.slice(0, espaco)
  const arroba = cabeca.indexOf('@')
  const nome = (arroba === -1 ? cabeca.slice(1) : cabeca.slice(1, arroba)).toLowerCase()
  return nome.length === 0 ? undefined : nome
}

function indiceDeEspacoAscii(valor: string): number {
  for (let i = 0; i < valor.length; i += 1) {
    const c = valor.charCodeAt(i)
    if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) return i
  }
  return -1
}

/* ========================================================================== */
/* 3. TEXTO DE RECUSA (o vocabulario FECHADO de `ipc.ts`)                      */
/* ========================================================================== */

/** Texto de recusa por codigo (o vocabulario e FECHADO — ipc.ts). */
export function textoDeRecusa(codigo: IpcErrorCode): string {
  switch (codigo) {
    case 'SHUTDOWN_IN_PROGRESS':
      return 'O túnel está a desligar. Mande o comando de novo em alguns segundos.'
    case 'EXPOSURE_DISABLED':
      return 'A exposição está desligada na configuração (exposure.mode não é "tunnel").'
    case 'RESTRICTED_MODE':
      return 'O modo restrito está ativo; não é possível ligar pelo bot.'
    case 'PROBE_FAILED':
      return 'A barreira de segurança não passou no teste; o túnel não sobe.'
    case 'TUNNEL_FAILED':
      return 'O túnel está em estado de falha; é preciso ação sua na máquina.'
    case 'NOT_PAIRED':
      return 'Este bot ainda não está pareado.'
    case 'NONCE_INVALID':
      return 'Confirmação inválida ou expirada. Mande o comando de novo.'
    case 'RATE_LIMITED':
      return 'Demasiados pedidos; tente mais tarde.'
    case 'INTERNAL':
      return 'Ocorreu um erro interno.'
  }
}

/* ========================================================================== */
/* 4. PROJECCAO DE ESTADO                                                      */
/* ========================================================================== */

/**
 * O host e a fonte unica da verdade; o bot e uma PROJECCAO e nao mantem estado
 * proprio alem do ultimo `seq` que viu (`src/contracts/ipc.ts`). O unico campo
 * derivado localmente e `readyDesde` — o instante em que a projecao viu a
 * transicao para READY — porque TG-084 exige "ha quanto tempo".
 */
export interface Projecao {
  readonly ler: () => SurfaceProjectionState
  /** Aplica uma difusao. Devolve `false` quando fora de ordem (seq <= ultimo). */
  aplicarDifusao(msg: IpcStateMessage, agora: number): boolean
  /** Aplica o estado de um ack (o ack nao traz seq; o estado e autoritativo). */
  aplicarEstado(estado: SurfaceTunnelState, agora: number): void
}

export function criarProjecao(): Projecao {
  let state: SurfaceTunnelState | undefined
  let seq = 0
  let url: string | undefined
  let expiresAt: number | undefined
  let readyDesde: number | undefined

  /**
   * Marca o instante da transicao PARA READY. O `anterior` e o estado ANTES da
   * actualizacao — comparar com o ja-actualizado nunca marcaria a transicao.
   */
  function marcarReadySe(estado: SurfaceTunnelState, anterior: SurfaceTunnelState | undefined, agora: number): void {
    if (estado === 'READY' && anterior !== 'READY') readyDesde = agora
    if (estado !== 'READY') readyDesde = undefined
  }

  return {
    ler: () => ({ state, seq, url, expiresAt, readyDesde }),
    aplicarDifusao(msg, agora): boolean {
      if (msg.seq <= seq) return false
      const anterior = state
      seq = msg.seq
      state = msg.state as SurfaceTunnelState
      url = msg.url
      expiresAt = msg.expiresAt
      marcarReadySe(state, anterior, agora)
      return true
    },
    aplicarEstado(estado, agora): void {
      const anterior = state
      state = estado
      marcarReadySe(estado, anterior, agora)
    },
  }
}

/* ========================================================================== */
/* 5. AS DEPENDENCIAS INJETADAS (O CONTRATO DE SAIDA PARA A ONDA 4)            */
/* ========================================================================== */

/** Dono pareado, com os dois eixos ja em STRING na fronteira (D4). */
export interface SurfaceDono {
  readonly userKey: string
  readonly chatKey: string
  readonly pairedAt: number
}

export type SurfaceEstadoPareamento =
  | { readonly status: 'aberto' }
  | { readonly status: 'fechado'; readonly dono: SurfaceDono }

/** O resultado de processar um comando pelo RECEPTOR DE PAREAMENTO (port fiel). */
export type SurfacePareamentoResultado =
  | { readonly kind: 'pareado'; readonly dono: SurfaceDono; readonly reply: string }
  | { readonly kind: 'boas-vindas'; readonly reply: string; readonly chat: string | undefined }
  | {
      readonly kind: 'recusado'
      /** `undefined` = descarte silencioso (TG-089). */
      readonly reply: string | undefined
      /** O chamador espera este tempo ANTES de responder. Nunca dormimos aqui. */
      readonly delayMs: number
      readonly chat: string | undefined
    }
  | { readonly kind: 'ignorado' }

/** Veredito de admitir uma identidade (allowlist de dois eixos). */
export type SurfaceAdmissao = { readonly admitido: true } | { readonly admitido: false; readonly motivo: string }

/** O desafio de pareamento, como o nucleo o recebe do host (S3-b, digest). */
export interface SurfaceDesafio {
  /** `true` sse o candidato e o codigo. Comparacao em tempo constante. */
  verify(candidate: string): boolean
  /** Epoch ms em que o codigo deixa de valer. TTL de 5 min, decidido no host. */
  readonly expiresAt: number
}

/**
 * O funil NEUTRO de autorizacao — implementado por `worker/surface/auth.ts`
 * (onda 2, dono paralelo) e LIGADO pela onda 4. Port fiel de
 * `worker/auth/{pairing,guard}.ts`, com os dois eixos em STRING.
 *
 * A ORDEM (pareamento PRIMEIRO, allowlist DEPOIS — PAIR-006/007) e do NUCLEO: este
 * e o contrato de saída que a onda 4 consome e que a auth deve satisfazer.
 */
export interface SurfaceAuth {
  /**
   * Processa um comando pelo receptor de pareamento. SINCRONO, pelo contrato de
   * PAIR-009 (dois `/parear` no mesmo tick produzem UM dono). `ignorado` quando
   * o comando nao e `/parear` nem `/start`.
   */
  receber(evento: SurfaceCommandEvent): SurfacePareamentoResultado
  /** Allowlist de dois eixos para uma MENSAGEM/COMANDO (default deny — TG-007). */
  admitirComando(identidade: SurfaceIdentity): SurfaceAdmissao
  /** Revalidacao de identidade para uma ACCAO (botao) — S6. */
  admitirAcao(identidade: SurfaceIdentity, action: SurfaceAction): SurfaceAdmissao
  /** O estado do pareamento (para `dono()`). */
  estado(): SurfaceEstadoPareamento
  /** Troca o desafio quando o host gera outro codigo (TG-064). */
  rotacionarDesafio(desafio: SurfaceDesafio): void
  /** Semeadura do dono persistido no boot (`pairing.owner` — re-montagem). */
  semearDono(dono: SurfaceDono): void
}

/** O despacho neutro dos comandos — implementado por `worker/surface/commands.ts`. */
export interface SurfaceComandos {
  ligar(identidade: SurfaceIdentity): Promise<void>
  desligar(identidade: SurfaceIdentity): Promise<void>
  /** O clique no botao de confirmacao. Responde SEMPRE ao clique (TG-027). */
  confirmarDesligar(
    identidade: SurfaceIdentity,
    token: string,
    answerTarget: string,
    messageTarget: string | undefined,
  ): Promise<void>
  status(identidade: SurfaceIdentity): Promise<void>
  acessar(identidade: SurfaceIdentity): Promise<void>
  rotacionar(identidade: SurfaceIdentity): Promise<void>
  emergencia(identidade: SurfaceIdentity): Promise<void>
}

/**
 * Quem fabrica os comandos a partir do {@link SurfaceCommandContext}: o nucleo
 * constroi o contexto e passa-o aqui (o port de `criarOnOff/criarAccess/criarStatus
 * (contexto)` de `worker/commands/router.ts`). A onda 4 liga `(ctx) =>
 * criarComandos(ctx)` de `worker/surface/commands.ts`.
 */
export type SurfaceComandosFactory = (contexto: SurfaceCommandContext) => SurfaceComandos

/* ========================================================================== */
/* 6. O NUCLEO                                                                */
/* ========================================================================== */

/** Teto do mapa de intents pendentes: defensivo, evita crescimento sem limite. */
const MAX_PENDENTES = 64

export interface NucleoDeps {
  readonly log: SurfaceCommandContext['log']
  readonly time: SurfaceCommandContext['time']
  readonly ipc: SurfaceIpcBridge
  readonly sender: SurfaceSender
  readonly limites: SurfaceLimits
  readonly emitirNonce: EmitirNonce
  /** Derruba o worker (emergencia). */
  readonly parar: () => Promise<void>
  readonly auth: SurfaceAuth
  readonly comandos: SurfaceComandosFactory
}

export interface Nucleo {
  /** TODO evento da superficie passa por aqui (o adaptador produz). */
  tratarEvento(event: SurfaceEvent): Promise<void>
  /** Os tipos host -> worker. NUNCA lanca (S4). */
  onState(msg: IpcStateMessage): void
  onAck(msg: IpcAckMessage): void
  onError(msg: IpcErrorMessage): void
  onNotify(msg: IpcNotifyMessage): void
  onPairingChallenge(msg: IpcPairingChallengeMessage): void
  /** `pairing.owner` (host -> worker): re-montagem do dono persistido no boot. */
  onOwner(msg: IpcPairingOwnerMessage): void
}

/** `ms` -> texto do "em progresso" por intent (o mesmo vocabulario do router). */
function acaoEmProgresso(acao: IpcIntentName): string {
  switch (acao) {
    case 'tunnel.up':
      return 'A ligar o túnel…'
    case 'tunnel.down':
      return 'A desligar o túnel…'
    case 'secret.rotate':
      return 'A gerar chave nova…'
    case 'tunnel.status':
    case 'session.issue':
    case 'emergency':
      return 'Pedido aceite.'
  }
}

function descrever(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function criarNucleo(deps: NucleoDeps): Nucleo {
  const { log, time, limites } = deps
  const projecao = criarProjecao()
  const pendentes = new Map<string, SurfacePendingIntent>()
  /** A ultima mensagem de ESTADO por chat — as difusoes editam-na in-place. */
  const ultimaMensagemDeEstado = new Map<string, string>()
  /**
   * AUTOLINK (onda1): a ligacao (requestId) do /ligar do dono que pediu o link
   * da chave de acesso. Armado na confirmacao de `tunnel.up` que VAI prosseguir
   * e consumido (desarmado) quando o tunel chega a READY — UMA unica vez por
   * ligacao. CHAVEADO POR requestId: um ack (ou um tap sobreposto) de OUTRA
   * confirmacao NAO desarma este slot. `null` = inativo.
   */
  let autolink: { readonly requestId: string; readonly from: string; readonly chat: string } | null = null

  /**
   * Serializador de 1 msg/s POR CHAT para a DIFUSAO de estado (TG-049): um
   * flapping NAO pode gerar enxurrada e 429. A primeira difusao sai logo; as
   * seguintes dentro da janela de 1 s sao COALESCIDAS (so a ultima importa — a
   * proxima difusao traz seq novo) e entregues quando a janela fecha. As
   * respostas a comandos NAO passam por aqui: sao interativas e curtas.
   */
  const porChat = new Map<string, { ultimoEnvio: number; pendente: string | undefined; emEspera: boolean }>()

  function enviarPara(chat: string, texto: string, opcoes?: Parameters<SurfaceSender['send']>[2]): Promise<string> {
    return deps.sender.send(chat, cortarTexto(texto, limites.maxTextLength), opcoes)
  }

  async function editarPara(
    chat: string,
    messageId: string,
    texto: string,
    opcoes?: Parameters<SurfaceSender['edit']>[3],
  ): Promise<SurfaceEditOutcome> {
    return deps.sender.edit(chat, messageId, cortarTexto(texto, limites.maxTextLength), opcoes)
  }

  async function mostrarEstado(chat: string, texto: string): Promise<string> {
    const registada = ultimaMensagemDeEstado.get(chat)
    if (registada === undefined) {
      const id = await enviarPara(chat, texto)
      ultimaMensagemDeEstado.set(chat, id)
      return id
    }
    await editarPara(chat, registada, texto)
    return registada
  }

  /**
   * O EMISSOR de difusao de estado — o modulo PORTADO `criarOutbox`
   * (`./outbox.ts`, TG-048/049) ligado ao mostrador de estado do nucleo:
   * `sendText = mostrarEstado` (edita a mensagem de estado in-place ou envia
   * nova) e as chaves sao `chatKey` (string). O outbox garante a PARTICAO do
   * texto e ROCIA 1 msg/s POR CHAT (TG-049) — a serializacao de entrega e daqui,
   * nao inline. O nucleo mantem apenas a DECISAO de coalescencia (qual estado
   * mostrar quando ha flapping: o ultimo dentro da janela vence).
   */
  const estadoOutbox = criarOutbox(
    (chat, texto) => mostrarEstado(chat, texto).then(() => undefined),
    { maxLength: limites.maxTextLength, time, log },
  )

  /**
   * Difusao de estado serializada: a decisao de COALESCENCIA (1 msg/s por chat,
   * so a ultima importa quando ha flapping — TG-049 no espirito) fica aqui, mas
   * a ENTREGA real passa pelo {@link estadoOutbox} portado. A primeira difusao
   * de uma rajada sai logo; as seguintes dentro da janela de 1 s sao penduradas
   * como "so a ultima" e entregues quando a janela fecha.
   */
  async function mostrarEstadoSerializado(chat: string, texto: string): Promise<void> {
    const estado =
      porChat.get(chat) ?? { ultimoEnvio: Number.NEGATIVE_INFINITY, pendente: undefined, emEspera: false }
    porChat.set(chat, estado)
    if (!estado.emEspera && time.now() - estado.ultimoEnvio >= 1_000) {
      estado.ultimoEnvio = time.now()
      await estadoOutbox.send(chat, texto)
      return
    }
    estado.pendente = texto
    if (estado.emEspera) return
    estado.emEspera = true
    const falta = Math.max(1, 1_000 - (time.now() - estado.ultimoEnvio))
    // A entrega da ultima difusao pode falhar (rede, 429): o .catch regista e
    // segue — nunca uma rejeicao nao tratada a matar o processo (S4).
    void time
      .sleep(falta)
      .then(async () => {
        const atual = porChat.get(chat)
        if (atual === undefined) return undefined
        atual.emEspera = false
        const porEnviar = atual.pendente
        atual.pendente = undefined
        if (porEnviar === undefined) return undefined
        atual.ultimoEnvio = time.now()
        return estadoOutbox.send(chat, porEnviar)
      })
      .catch((error) => {
        log.error('falha ao entregar a difusao coalescida', {
          chat,
          detail: descrever(error),
        })
      })
  }

  const contexto: SurfaceCommandContext = {
    log,
    time,
    ipc: deps.ipc,
    emitirNonce: deps.emitirNonce,
    parar: deps.parar,
    enviar: (chat, texto, opcoes) => enviarPara(chat, texto, opcoes),
    editar: (chat, messageId, texto, opcoes) => editarPara(chat, messageId, texto, opcoes),
    mostrarEstado,
    responder: (answerTarget, outras) => deps.sender.answer(answerTarget, outras),
    pendente: {
      registar: (requestId, chat, acao, messageTarget) => {
        if (pendentes.size >= MAX_PENDENTES) {
          const maisAntigo = pendentes.keys().next().value
          if (maisAntigo !== undefined) pendentes.delete(maisAntigo)
        }
        pendentes.set(requestId, { requestId, chatKey: chat, acao, messageTarget })
      },
      retirar: (requestId) => {
        const p = pendentes.get(requestId)
        if (p !== undefined) pendentes.delete(requestId)
        return p
      },
    },
    projecao: { ler: () => projecao.ler() },
    dono: () => {
      const estado = deps.auth.estado()
      return estado.status === 'fechado' ? estado.dono.chatKey : undefined
    },
  }

  // Os comandos NEUTROS consomem o contexto que este nucleo acabou de produzir
  // (a facao da onda 4 liga a factory de `worker/surface/commands.ts`).
  const comandos = deps.comandos(contexto)

  function auditoria(campos: Readonly<Record<string, unknown>>): void {
    log.info('auditoria', campos)
  }

  /**
   * Corre uma tarefa de renderizacao EM SEGUNDO PLANO com tratamento explicito
   * de falha. Nenhum `void` async do despacho fica sem `.catch`: uma rejeicao
   * nao tratada em Node 24 e um throw de que mata o processo — exatamente no
   * cenario (rede transitoria/429 durante o flapping) que o serializador existe
   * para conter. A falha e registada e o canal segue vivo (S4).
   */
  function emSegundoPlano(chat: string | undefined, tarefa: () => Promise<unknown>): void {
    void tarefa().catch((error) => {
      log.error('falha ao renderizar para o chat', { chat, detail: descrever(error) })
    })
  }

  /**
   * Envia a intent NEUTRA pela ponte e regista o ponto pendente PARA o ack.
   *
   * O envelope NUMERICO (`from`/`chat` do `IpcIntentMessage` V1) e responsabilidade
   * da ponte (`criarSurfaceIpcBridge`, `worker/providers/registry.ts`), NAO deste
   * nucleo: aqui so se constroi a {@link IntencaoNeutra} com as chaves STRING.
   *
   * Devolve `false` quando o canal recusa (host indisponivel/fila cheia). O
   * `messageTarget` e o id da mensagem a editar in-place com a resposta do ack.
   */
  function enviarIntent(
    intent: Omit<IntencaoNeutra, 'userKey' | 'chatKey'>,
    identidade: SurfaceIdentity,
    messageTarget: string | undefined,
  ): boolean {
    const pedido: IntencaoNeutra = {
      ...intent,
      userKey: identidade.userKey,
      chatKey: identidade.chatKey,
    }
    const aceite = deps.ipc.send(pedido)
    if (aceite) {
      contexto.pendente.registar(pedido.requestId, pedido.chatKey, pedido.intent, messageTarget)
    } else {
      log.error('intent recusada pelo canal (host indisponivel ou fila cheia)', {
        intent: pedido.intent,
        chat: pedido.chatKey,
      })
    }
    return aceite
  }

  /**
   * AUTOLINK (onda1): pede o link da CHAVE DE ACESSO ao HOST (`session.issue`)
   * quando o tunel que o dono mandou ligar fica READY. A identidade vem do
   * /ligar que armou o autolink (o dono e 1:1 por construcao, mas a revalidacao
   * de identidade continua a ser feita pelo HOST no intent, S6). O host compoe e
   * notifica o link (`https://<url>?key=<token>`); este worker NUNCA compoe nem
   * transporta o token de link. Best-effort: enviarIntent ja regista o pendente
   * (o ack de session.issue REGISTA o erro como mensagem propria) e o autolink
   * ja foi desarmado ANTES — um envio falho nao deixa o flag vivo.
   */
  function emitirLinkAutomatico(arma: { readonly from: string; readonly chat: string }): void {
    if (projecao.ler().state !== 'READY') return
    enviarIntent(
      { intent: 'session.issue', requestId: gerarRequestId(time.now()) },
      { userKey: arma.from, chatKey: arma.chat },
      undefined,
    )
  }

  /* ---- o despacho de comandos (port fiel de `tratarComando`) -------------- */

  async function tratarComando(nome: string | undefined, identidade: SurfaceIdentity): Promise<void> {
    switch (nome) {
      case 'ligar':
        await comandos.ligar(identidade)
        return
      case 'desligar':
        await comandos.desligar(identidade)
        return
      case 'status':
        await comandos.status(identidade)
        return
      case 'acessar':
        await comandos.acessar(identidade)
        return
      case 'rotacionar':
        await comandos.rotacionar(identidade)
        return
      case 'emergencia':
        await comandos.emergencia(identidade)
        return
      case undefined:
      case 'start':
      case 'parear':
        // `start`/`parear` sao consumidos pelo receptor; texto sem comando nao e assunto.
        return
      default:
        // TG-081: comando morto ou desconhecido — NENHUM intent. So uma palavra ao dono.
        await enviarPara(identidade.chatKey, 'Não conheço este comando.')
    }
  }

  /* ---- o despacho de accoes (port fiel de `tratarCallback`) -------------- */

  async function tratarAcao(event: SurfaceActionEvent): Promise<void> {
    switch (event.action) {
      case 'tunnel.up':
      case 'secret.rotate': {
        // A CONFIRMACAO. O token viaja OPACO (S5): o worker nao o valida — o
        // host consome. Um token ja consumido ou forjado e recusado LA, e o
        // ack devolve a recusa para renderizar. O answer vem sem texto: o
        // feedback do clique e a edicao in-place da mensagem (a do botao).
        await deps.sender.answer(event.answerTarget)
        // AUTOLINK (onda1): o /ligar confirmado arma o envio automatico do
        // link da chave de acesso, CHAVEADO pelo requestId DESTA ligacao. O
        // slot so e armado se nao houver outra ligacao em curso (so a PRIMEIRA
        // confirmacao pode vir a ser a que sobe — o host serializa os starts).
        // Um tap sobreposto (double-tap) nao sobrescreve a ligacao boa.
        const requestIdUp = gerarRequestId(time.now())
        if (event.action === 'tunnel.up' && autolink === null) {
          autolink = {
            requestId: requestIdUp,
            from: event.identity.userKey,
            chat: event.identity.chatKey,
          }
        }
        enviarIntent(
          {
            intent: event.action,
            requestId: requestIdUp,
            nonce: event.token,
          },
          event.identity,
          event.messageTarget,
        )
        return
      }
      case 'tunnel.down':
        await comandos.confirmarDesligar(
          event.identity,
          event.token,
          event.answerTarget,
          event.messageTarget,
        )
        return
      case 'emergency':
        // Os botoes dos notify de T5.4 (sessao-nova/auth-falha/ttl/relatorio).
        await deps.sender.answer(event.answerTarget)
        await comandos.emergencia(event.identity)
        return
      case 'tunnel.status':
      case 'session.issue':
        // Nunca renderizamos botoes destas acoes.
        log.warn('acao de botao sem botao renderizado; descartada', { action: event.action })
        await deps.sender.answer(event.answerTarget)
    }
  }

  /* ---- o funil do evento (port fiel de `tratarUpdate`, em eventos neutros) */

  async function tratarEvento(event: SurfaceEvent): Promise<void> {
    try {
      // `acao-invalida`: o ADAPTADOR ja rejeitou a FORMA do callback_data. O
      // nucleo responde SEMPRE (TG-027) — ate aqui — e NAO forja accao nem token
      // (S5). A CONTAGEM do descarte (TG-089: descartado E contado) fica no
      // nucleo, na auditoria; a identidade (quando o provedor a leu) alimenta a
      // contagem do lado do adaptador — nao ha `action` nem `token` para forjar.
      if (event.kind === 'acao-invalida') {
        auditoria({ outcome: 'descartado', motivo: 'deny:acao-invalida', surface: event.kind })
        await deps.sender.answer(event.answerTarget)
        return
      }

      if (event.kind === 'acao') {
        const admissao = deps.auth.admitirAcao(event.identity, event.action)
        if (!admissao.admitido) {
          auditoria({ outcome: 'descartado', motivo: `deny:${admissao.motivo}`, action: event.action })
          // TG-089: silencio e contagem. O answer e obrigacao de protocolo (TG-027).
          await deps.sender.answer(event.answerTarget)
          return
        }
        auditoria({ outcome: 'permitido', action: event.action })
        await tratarAcao(event)
        return
      }

      // ---- SurfaceCommandEvent ----
      // O receptor de pareamento corre PRIMEIRO: /start e /parear sao o unico
      // caminho legitimo de um estranho ate ao worker (PAIR-006/007).
      const pareamento = deps.auth.receber(event)
      if (pareamento.kind !== 'ignorado') {
        if (pareamento.kind === 'pareado') {
          await enviarPara(pareamento.dono.chatKey, pareamento.reply)
          return
        }
        if (pareamento.kind === 'boas-vindas') {
          if (pareamento.chat !== undefined) await enviarPara(pareamento.chat, pareamento.reply)
          return
        }
        // recusado
        if (pareamento.delayMs > 0) await time.sleep(pareamento.delayMs)
        if (pareamento.reply !== undefined && pareamento.chat !== undefined) {
          await enviarPara(pareamento.chat, pareamento.reply)
        }
        return
      }

      const admissao = deps.auth.admitirComando(event.identity)
      if (!admissao.admitido) {
        auditoria({ outcome: 'descartado', motivo: `deny:${admissao.motivo}` })
        // TG-089: silencio e contagem. Nao ha answer a um comando de texto.
        return
      }
      auditoria({ outcome: 'permitido' })
      await tratarComando(extrairNomeDeComando(event.text), event.identity)
    } catch (error) {
      // S4: o que falha aqui e logado e segue — nunca derruba o canal.
      log.error('falha ao tratar evento da superficie', { detail: descrever(error) })
    }
  }

  /* ---- os tratadores do canal (S4: nunca lancam) -------------------------- */

  function onState(msg: IpcStateMessage): void {
    try {
      if (!projecao.aplicarDifusao(msg, time.now())) {
        log.debug('difusao fora de ordem descartada', { seq: msg.seq })
        return
      }
      const chat = contexto.dono()
      if (chat === undefined) return
      // AUTOLINK (onda1): o tunel que o dono /ligar ficou READY — sai o link
      // da chave de acesso UMA vez por ligacao (o desarme acontece aqui, no
      // primeiro READY com autolink armado).
      if (autolink !== null && projecao.ler().state === 'READY') {
        const alvo = autolink
        autolink = null
        emitirLinkAutomatico(alvo)
      }
      // AUTOLINK (onda1) — defesa terminal: se a ligacao armada desembocou num
      // estado terminal (FAILED/STOPPED) em vez de READY, o slot morre.
      else if (autolink !== null && (projecao.ler().state === 'FAILED' || projecao.ler().state === 'STOPPED')) {
        autolink = null
      }
      emSegundoPlano(chat, () => mostrarEstadoSerializado(chat, textoDeEstado(projecao.ler(), time.now())))
    } catch (error) {
      log.error('falha ao renderizar difusao de estado', { detail: descrever(error) })
    }
  }

  function onAck(msg: IpcAckMessage): void {
    try {
      projecao.aplicarEstado(msg.state as SurfaceTunnelState, time.now())
      const pendente = contexto.pendente.retirar(msg.requestId)
      if (pendente === undefined) {
        log.debug('ack sem intent pendente (duplicado ou orfao)', {
          requestId: msg.requestId,
          result: msg.result,
        })
        return
      }
      // AUTOLINK (onda1): o ack de `tunnel.up` NAO-accepted (noop = ja READY,
      // CTL-003; ou rejected = nonce/modo-restrito) so desarma o autolink da
      // MESMA ligacao (requestId igual) — nunca o de outra confirmacao.
      if (pendente.acao === 'tunnel.up' && msg.result !== 'accepted' && autolink?.requestId === pendente.requestId) {
        autolink = null
      }
      if (msg.result === 'rejected') {
        const texto = textoDeRecusa(msg.code ?? 'INTERNAL')
        if (pendente.acao === 'session.issue') {
          // A resposta de /acessar — aceite OU recusa — nunca edita o painel
          // de estado: o aceite chega por notify (TG-085) e a recusa e uma
          // mensagem propria, para o painel sobreviver aos dois.
          emSegundoPlano(pendente.chatKey, () => enviarPara(pendente.chatKey, texto))
          return
        }
        if (pendente.messageTarget !== undefined) {
          // A mensagem do fluxo (teclado de confirmacao) e a mais precisa.
          emSegundoPlano(pendente.chatKey, () => editarPara(pendente.chatKey, pendente.messageTarget!, texto))
          ultimaMensagemDeEstado.set(pendente.chatKey, pendente.messageTarget)
        } else {
          emSegundoPlano(pendente.chatKey, () => mostrarEstado(pendente.chatKey, texto))
        }
        return
      }
      if (pendente.acao === 'tunnel.status') {
        // A resposta de /status: o ack trouxe o estado autoritativo.
        emSegundoPlano(pendente.chatKey, () =>
          mostrarEstado(pendente.chatKey, textoDeEstado(projecao.ler(), time.now())),
        )
        return
      }
      if (pendente.acao === 'session.issue') {
        // O aceite de /acessar e INVISIVEL de proposito: a resposta (link
        // magico ou instrucao do caminho local) chega por `notify` composto
        // pelo host (TG-085). Renderizar «Pedido aceite.» aqui EDITA a
        // ultima mensagem de estado in-place e destroi o painel.
        return
      }
      const texto =
        msg.result === 'noop' ? 'Já estava assim.' : acaoEmProgresso(pendente.acao)
      if (pendente.messageTarget !== undefined) {
        emSegundoPlano(pendente.chatKey, () => editarPara(pendente.chatKey, pendente.messageTarget!, texto))
        ultimaMensagemDeEstado.set(pendente.chatKey, pendente.messageTarget)
      } else {
        emSegundoPlano(pendente.chatKey, () => mostrarEstado(pendente.chatKey, texto))
      }
    } catch (error) {
      log.error('falha ao tratar ack', { requestId: msg.requestId, detail: descrever(error) })
    }
  }

  function onError(msg: IpcErrorMessage): void {
    try {
      // Com requestId, o erro pertence ao intent pendente (que se retira);
      // sem requestId, o erro e do sistema e vai ao dono (o contrato diz:
      // «message e mostrada ao dono no Telegram»).
      if (msg.requestId !== undefined) {
        const pendente = contexto.pendente.retirar(msg.requestId)
        if (pendente === undefined) {
          log.debug('erro sem intent pendente (duplicado ou orfao)', {
            requestId: msg.requestId,
          })
        } else if (pendente.acao === 'session.issue') {
          // O erro de /acessar E uma resposta do intent — mensagem PROPIA,
          // nunca edicao do painel de estado (o mesmo carve-out dos acks, A2).
          emSegundoPlano(pendente.chatKey, () => enviarPara(pendente.chatKey, msg.message))
        } else {
          emSegundoPlano(pendente.chatKey, () => mostrarEstado(pendente.chatKey, msg.message))
        }
      } else {
        const chat = contexto.dono()
        if (chat !== undefined) {
          emSegundoPlano(chat, () => mostrarEstado(chat, msg.message))
        }
      }
      log.warn('erro do host', { code: msg.code })
    } catch (error) {
      log.error('falha ao tratar erro do host', { detail: descrever(error) })
    }
  }

  function onNotify(msg: IpcNotifyMessage): void {
    try {
      const { tipo, corpo } = extrairAlerta(msg.texto)
      const chat = contexto.dono()
      if (chat === undefined) return
      if (corpo.length === 0) {
        log.warn('notify sem corpo (so o marcador); nada a mostrar', { tipo: tipo ?? 'ausente' })
        return
      }
      const botoes = botoesDeAlerta(tipo)
      const opcoes: Parameters<SurfaceSender['send']>[2] =
        tipo === 'link-magico'
          ? { disableWebPagePreview: true }
          : botoes.length > 0
            ? { actionRows: botoes }
            : {}
      // Best-effort: a falha de entrega NAO derruba o canal (contrato notify).
      void enviarPara(chat, corpo, opcoes).catch((error) => {
        log.warn('notify nao entregue (best-effort)', { detail: descrever(error) })
      })
    } catch (error) {
      log.error('falha ao renderizar notify', { detail: descrever(error) })
    }
  }

  function onPairingChallenge(msg: IpcPairingChallengeMessage): void {
    try {
      // S3-b: o digest NUNCA sai deste ramo — nem em log, nem em payload.
      const digest = Buffer.from(msg.digest, 'hex')
      const desafio: SurfaceDesafio = {
        expiresAt: msg.expiresAt,
        verify: (candidato: string): boolean =>
          timingSafeEqual(createHash('sha256').update(candidato, 'utf8').digest(), digest),
      }
      deps.auth.rotacionarDesafio(desafio)
      log.info('desafio de pareamento rotacionado', { expiresAt: msg.expiresAt })
    } catch (error) {
      log.error('falha ao rotacionar desafio de pareamento', { detail: descrever(error) })
    }
  }

  function onOwner(msg: IpcPairingOwnerMessage): void {
    try {
      // `pairing.owner` (host -> worker): o dono PERSISTIDO no boot. Re-monta a
      // autorizacao (auth.semearDono) — nao ha segredo (NAO autoriza por si: quem
      // valida intents e o HOST, S6), e o nucleo interno (projecao, pendentes)
      // sobrevive intacto.
      deps.auth.semearDono({ userKey: String(msg.from), chatKey: String(msg.chat), pairedAt: msg.pairedAt })
      log.info('dono persistido re-montado', { pairedAt: msg.pairedAt })
    } catch (error) {
      log.error('falha ao re-montar dono persistido', { detail: descrever(error) })
    }
  }

  return { tratarEvento, onState, onAck, onError, onNotify, onPairingChallenge, onOwner }
}