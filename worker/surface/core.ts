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
  IpcNotifyMessage,
  IpcPairingChallengeMessage,
  IpcPairingOwnerMessage,
  IpcStateMessage,
} from '../../src/contracts/ipc.ts'

import { botoesDeAlerta, extrairAlerta } from './actions.ts'
import {
  type ActionRow,
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
import {
  cortarTexto,
  estreitarEstado,
  formatarDuracao,
  textoDeEstadoCurto,
} from './text.ts'
import { criarOutbox } from './outbox.ts'
import { gerarRequestId, gerarTokenOpaque } from './tokens.ts'
import { COMANDOS_PUBLICADOS } from './commands.ts'
import {
  LIMITES_PAREAMENTO_PADRAO,
  RESPOSTA_AGUARDANDO_CANCELADO,
  RESPOSTA_AGUARDANDO_EXPIROU,
  RESPOSTA_PEDIR_VALOR,
  RESPOSTA_PEDIR_VALOR_MALFORMADO,
} from './auth.ts'

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
      return 'Túnel a mudar de estado. Tenta de novo em alguns segundos.'
    case 'EXPOSURE_DISABLED':
      return 'A exposição remota está desligada nesta máquina. Não dá para ligar pelo bot.'
    case 'RESTRICTED_MODE':
      return 'O modo restrito está ativo nesta máquina. Usa o painel local.'
    case 'PROBE_FAILED':
      return 'A verificação de segurança falhou; o túnel não sobe. Vê o painel.'
    case 'TUNNEL_FAILED':
      return 'Túnel parado por erro. Precisa de ação tua na máquina.'
    case 'NOT_PAIRED':
      return 'Ainda não está pareado. Gera um código no painel e envia `/parear`.'
    case 'NONCE_INVALID':
      return 'Confirmação expirada. Envia o comando de novo.'
    case 'RATE_LIMITED':
      return 'Pedidos demais. Espera um pouco e tenta de novo.'
    case 'INTERNAL':
      return 'Algo falhou no meu lado. Tenta de novo.'
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
      readonly reason: string
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
  /**
   * VALIDA um CANDIDATO (o codigo) com o MESMO receptor — teto/backoff/resposta
   * uniforme (docs/ux/04-CONVERSA-INTELIGENTE.md §3). Usado na conversa "pedir
   * valor" para a proxima mensagem de texto puro do mesmo chat+user. SINCRONO
   * (PAIR-009). Devolve o resultado na forma do core (`recusado.reason` distingue
   * `refuse:malformed` do resto); o core envia a resposta.
   */
  verificarCandidato(identidade: SurfaceIdentity, candidato: string): SurfacePareamentoResultado
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

/* ========================================================================== */
/* CONVERSA INTELIGENTE ("skills pedem valores") — docs/ux/04-CONVERSA-        */
/* INTELIGENTE.md. O estado "aguardando valor" e o TEXTO de espera.            */
/* ========================================================================== */

/** TTL da espera de valor: `<= TTL do codigo` (5 min), medido no relogio. */
const ESPERA_TTL_MS = 5 * 60 * 1000

/** Teto defensivo do mapa "aguardando valor" (estilo MAX_TOKENS_DESLIGAR). */
const MAX_AGUARDANDO = 64

/**
 * Teto de re-pedidos MALFORMADOS por espera: um atacante so recebe este numero
 * de respostas "Não entendi o código…" numa janela — depois disso a espera e
 * removida e fica SILENCIO (default-deny, TG-089). Anti farm de reflexao.
 */
const MAX_MALFORMADO_POR_ESPERA = 5

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

function descrever(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * O RESULTADO de uma accao confirmada, em 1-2 linhas (CONTRATO §5 "Ações
 * destrutivas — respostas finais claras"). `accepted` apos o OK; `noop` quando
 * o tunel ja estava no estado pedido. O texto e NEUTRO/exato do contrato.
 */
function textoDeResultadoDoAck(acao: SurfaceAction, result: 'accepted' | 'noop'): string {
  switch (acao) {
    case 'tunnel.up':
      return result === 'noop' ? 'Túnel já estava ligado.' : 'Túnel ligado. Link enviado aqui.'
    case 'tunnel.down':
      return result === 'noop' ? 'Túnel já estava desligado.' : 'Túnel desligado. Nada ficou exposto.'
    case 'secret.rotate':
      return 'Chave nova gerada. O link antigo deixou de funcionar.'
    case 'tunnel.status':
    case 'session.issue':
    case 'emergency':
    case 'menu':
    case 'ajuda':
    case 'inicio':
    case 'cancel':
      // Nav e leituras nao confirmam accao destrutiva; generico. O `cancel` e
      // navegacao local que nunca gera ack (nao envia intent); cobre o tipo.
      return result === 'noop' ? 'Já estava assim.' : 'Pedido aceite.'
  }
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

  /* ---- CONVERSA INTELIGENTE ("skills pedem valores") ---------------------
   * Um `Map<chatKey, {userKey, expiresAtMs}>` no NUCLEO NEUTRO: marca que o bot
   * perguntou um valor e espera a PROXIMA mensagem de texto puro do MESMO
   * chat+user. Sem sessao de libraria, TTL lazy (no proximo evento, nunca
   * setTimeout), teto FIFO (MAX_AGUARDANDO) — docs/ux/04-CONVERSA-INTELIGENTE.md.
   * ------------------------------------------------------------------------ */
  const aguardandoValor = new Map<string, { readonly userKey: string; readonly expiresAtMs: number }>()

  /** Re-pedidos MALFORMADOS por chat, dentro de UMA espera (anti farm, rev adversarial). */
  const malformadosPorChat = new Map<string, number>()

  /**
   * Backoff dos re-pedidos malformados — o MESMO padrao do receptor (`atrasoPara`,
   * LIMITES_PAREAMENTO_PADRAO): dobra a cada falha do mesmo chat, 250ms -> 4s.
   */
  function atrasoMalformado(falhasAnteriores: number): number {
    const bruto = LIMITES_PAREAMENTO_PADRAO.baseDelayMs * 2 ** Math.min(falhasAnteriores, 32)
    return Math.min(LIMITES_PAREAMENTO_PADRAO.maxDelayMs, bruto)
  }

  /**
   * Arma (ou re-arm) a espera de valor para o chat, no MESMO tick da pergunta.
   * Reinicia o contador de re-pedidos MALFORMADOS do chat (cada fluxo comeca com
   * orcamento cheio de re-asks).
   */
  function armarEsperaDeValor(identity: SurfaceIdentity): void {
    if (aguardandoValor.size >= MAX_AGUARDANDO && !aguardandoValor.has(identity.chatKey)) {
      const maisAntigo = aguardandoValor.keys().next().value
      if (maisAntigo !== undefined) aguardandoValor.delete(maisAntigo)
    }
    aguardandoValor.set(identity.chatKey, { userKey: identity.userKey, expiresAtMs: time.now() + ESPERA_TTL_MS })
    malformadosPorChat.delete(identity.chatKey)
  }

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
    // Onda 3 / CONTRATO §4 Regra 3: com o cartao de controlo a vista, a
    // difusao de estado / /status re-renderiza o CARTAO in-place (estado +
    // teclado) em vez de gravar um texto solto por cima dele.
    if (cartaoEstaVisivel(chat)) {
      return exibirCartao(chat, time.now())
    }
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

  // ---- O CARTAO DE CONTROLO (/menu + pos-pareamento) ----------------------
  // A mensagem edit-in-place do dono: estado visivel + teclado de botoes
  // (CONTRATO §4). O id da mensagem do cartao por chat deixa distinguir um
  // clique NOS BOTOES DO CARTAO (que INICIAM o fluxo) de um clique nos botoes
  // de CONFIRMACAO (que CONFIRMAM) — e permite re-renderizar o cartao quando o
  // estado muda (Regra 3). So o dono chega aqui (o /menu passa pelo guard).
  const cartoesDoControle = new Map<string, string>()

  /** O texto do cartao na linha de estado (Regra 3). So para o DONO. */
  function linhaDeEstadoDoCartao(agora: number): string {
    const projecaoAtual = projecao.ler()
    const estado = estreitarEstado(projecaoAtual.state)
    if (estado === 'READY') {
      const duracao = formatarDuracao(agora - (projecaoAtual.readyDesde ?? agora))
      return `Túnel: ✅ Ligado · link no ar há ${duracao}`
    }
    if (estado === 'STOPPED') return 'Túnel: ⬜ Desligado — nada exposto'
    // Estados de transicao/falha — o dono ve um estado a mudar, sem segredo.
    return 'Túnel: estado a mudar…'
  }

  /** O teclado do cartao (CONTRATO §4, rotulos EXATOS). Os botoes INICIAM. */
  function tecladoDoCartao(): readonly (readonly ActionRow[])[] {
    return [
      [
        linhaDeBotao('🟢 Ligar', 'tunnel.up', 'confirm'),
        linhaDeBotao('🔴 Desligar', 'tunnel.down', 'emergency'),
      ],
      [
        linhaDeBotao('📶 Status', 'tunnel.status'),
        linhaDeBotao('🔗 Link de acesso', 'session.issue', 'confirm'),
        linhaDeBotao('⇄ Nova chave', 'secret.rotate', 'confirm'),
      ],
      [linhaDeBotao('🚨 Emergência', 'emergency', 'emergency')],
      [linhaDeBotao('🏠 Início', 'inicio')],
    ]
  }

  function linhaDeBotao(label: string, acao: SurfaceAction, kind?: 'confirm' | 'emergency'): ActionRow {
    return { label, action: acao, token: gerarTokenOpaque(), ...(kind === undefined ? {} : { kind }) }
  }

  /** Monta o texto do cartao (titulo + linha de estado). */
  function textoDoCartao(agora: number): string {
    return `🎛️ Controlo do Harness\n\n${linhaDeEstadoDoCartao(agora)}`
  }

  /**
   * Envia ou edita o cartao in-place para o chat do dono, com o teclado. A
   * primeira chamada cria a mensagem; as seguintes editam-na no lugar.
   */
  async function exibirCartao(chat: string, agora: number): Promise<string> {
    const texto = textoDoCartao(agora)
    const opcoes: Parameters<SurfaceSender['send']>[2] = { actionRows: tecladoDoCartao() }
    const registado = cartoesDoControle.get(chat)
    if (registado === undefined) {
      const id = await enviarPara(chat, texto, opcoes)
      cartoesDoControle.set(chat, id)
      // O cartao tambem passa a ser a "ultima mensagem de estado" edit-in-place:
      // a difusao de estado re-renderiza-o (Regra 3).
      ultimaMensagemDeEstado.set(chat, id)
      return id
    }
    await editarPara(chat, registado, texto, opcoes)
    return registado
  }

  /** Distingue (via `mostrarEstado`) que a difusao de estado re-renderiza o cartao. */
  function cartaoEstaVisivel(chat: string): boolean {
    return cartoesDoControle.get(chat) !== undefined
  }

  // ---- fim do bloco do cartao -----------------------------------------------

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
      case 'start':
      case 'parear':
        // `start`/`parear` sao consumidos pelo receptor (correctness: nao deviam
        // chegar aqui; manter a guarda e defensivo).
        return
      case 'menu':
        // CONTRATO §4: /menu abre o cartao de controlo do dono (guard-gated).
        await exibirCartao(identidade.chatKey, time.now())
        return
      case 'ajuda':
        // CONTRATO §2: ajuda curta (owner-only; a um estranho, silencio — aqui
        // quem chega ja passou pela allowlist).
        await enviarPara(
          identidade.chatKey,
          'ℹ️ Este bot controla o acesso ao teu Harness pelo Telegram.\n' +
            'Usa /menu para o cartão de controlo e /status para ver o túnel.',
        )
        return
      case undefined:
      default:
        // TG-081: comando morto/desconhecido OU texto livre. NENHUM intent.
        // Contrato §6: acusa + chuta + oferece saída, só ao dono (já passou a
        // allowlist; a um estranho o guard descartou antes).
        await enviarPara(identidade.chatKey, 'Não entendi. Queres fazer o quê?', {
          actionRows: [
            [
              { label: '🔘 Abrir menu', action: 'menu', token: gerarTokenOpaque() },
              { label: '📶 Estado', action: 'tunnel.status', token: gerarTokenOpaque() },
              { label: 'ℹ️ Ajuda', action: 'ajuda', token: gerarTokenOpaque() },
            ],
          ],
        })
    }
  }

  /* ---- o despacho de accoes (port fiel de `tratarCallback`) -------------- */

  async function tratarAcao(event: SurfaceActionEvent): Promise<void> {
    const chat = event.identity.chatKey
    // Distingue um clique NO CARTAO de controlo (que INICIA um fluxo, toast do
    // §4) de um clique num botao de CONFIRMACAO/tela (que CONFIRMA). Os botoes
    // do cartao vivem na mensagem que `cartoesDoControle` guarda.
    const vindaDoCartao = event.messageTarget !== undefined && event.messageTarget === cartoesDoControle.get(chat)

    // --- NAVEGACAO LOCAL (nao vai ao host; so o dono a alcanca — guard-gated).
    if (event.action === 'menu' || event.action === 'inicio' || event.action === 'ajuda') {
      // TG-027: responder ao clique SEMPRE. NAVEGACAO nao aumenta exposicao e
      // nao leva nonce — o answer e vazio (o feedback e o que se mostra).
      await deps.sender.answer(event.answerTarget)
      if (event.action === 'menu' || event.action === 'inicio') {
        await exibirCartao(chat, time.now())
      } else {
        await enviarPara(
          chat,
          'ℹ️ Este bot controla o acesso ao teu Harness pelo Telegram.\n' +
            'Usa /menu para o cartão de controlo e /status para ver o túnel.',
        )
      }
      return
    }
    if (event.action === 'cancel') {
      // CONTRATO §4 Regra 4 / Onda 5: o CANCELAMENTO das telas de confirmacao
      // destrutiva. O clique nao executa nada: responde ao botao (TG-027) e
      // EDITA a mensagem da confirmacao — in-place, SEM actionRows, o que no
      // adaptador DESTROI o teclado (anti duplo-toque, Regra 2). NAO envia
      // intent, NAO desarma/rotaciona nonce e NAO altera estado do host.
      await deps.sender.answer(event.answerTarget, { text: 'Ok, cancelado.' })
      if (event.messageTarget !== undefined) {
        await editarPara(chat, event.messageTarget, 'Cancelado. Nada foi alterado.')
      }
      return
    }

    switch (event.action) {
      case 'tunnel.up':
      case 'secret.rotate': {
        // Botao do CARTAO que INICIA (pede nonce e mostra a tela de confirmacao).
        if (vindaDoCartao) {
          await deps.sender.answer(event.answerTarget, {
            text: event.action === 'tunnel.up' ? 'Ligando…' : 'Gerando chave nova…',
          })
          if (event.action === 'tunnel.up') await comandos.ligar(event.identity)
          else await comandos.rotacionar(event.identity)
          return
        }
        // A CONFIRMACAO ([✅ ...] da tela 2 etapas). O token viaja OPACO (S5).
        // O answer vem SEM texto: o feedback e a edicao in-place (a do botao).
        await deps.sender.answer(event.answerTarget)
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
      case 'tunnel.down': {
        // Botao do CARTAO que INICIA o fluxo de /desligar (tela de confirmacao).
        if (vindaDoCartao) {
          await deps.sender.answer(event.answerTarget, { text: 'Desligando…' })
          await comandos.desligar(event.identity)
          return
        }
        await comandos.confirmarDesligar(
          event.identity,
          event.token,
          event.answerTarget,
          event.messageTarget,
        )
        return
      }
      case 'session.issue': {
        // Botao do CARTAO "Link de acesso": acusa e pede a sessao (o link real
        // chega por notify, TG-085; o toast evita o botao morto — §4).
        if (vindaDoCartao) {
          await deps.sender.answer(event.answerTarget, { text: 'A enviar o link…' })
          await comandos.acessar(event.identity)
          return
        }
        log.warn('acao de botao sem botao renderizado; descartada', { action: event.action })
        await deps.sender.answer(event.answerTarget)
        return
      }
      case 'tunnel.status':
        // So o dono a pressiona (card / fallback): estado. O answer vazio; a
        // edicao (ou o cartao re-renderizado) mostra o estado real.
        await deps.sender.answer(event.answerTarget)
        await comandos.status(event.identity)
        return
      case 'emergency':
        // Card/notify: reducer de exposicao, sem nonce (CTL-024). Toast no card.
        await deps.sender.answer(
          event.answerTarget,
          vindaDoCartao ? { text: 'A derrubar tudo…' } : undefined,
        )
        await comandos.emergencia(event.identity)
        return
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
      return continuarComando(event)
    } catch (error) {
      // S4: o que falha aqui e logado e segue — nunca derruba o canal.
      log.error('falha ao tratar evento da superficie', { detail: descrever(error) })
    }
  }

  /* ---- o funil de um COMANDO (incluindo a conversa inteligente) ---------- */

  /** O comando e um `/parear` SEM argumento (o clique no menu)? */
  function ehParearSemValor(texto: string): boolean {
    const aparado = texto.trim()
    if (!aparado.startsWith('/')) return false
    const espaco = indiceDeEspacoAscii(aparado)
    const cabeca = espaco === -1 ? aparado : aparado.slice(0, espaco)
    const arg = espaco === -1 ? '' : aparado.slice(espaco + 1).trim()
    const arroba = cabeca.indexOf('@')
    const nome = (arroba === -1 ? cabeca.slice(1) : cabeca.slice(1, arroba)).toLowerCase()
    return nome === 'parear' && arg.length === 0
  }

  /** Texto puro que aceitamos como CANCELAR a espera (`/cancelar` → texto). */
  function eIntencaoDeCancelar(texto: string): boolean {
    const normalizado = texto.trim().toLowerCase()
    return normalizado === 'cancelar' || normalizado === 'não' || normalizado === 'nao'
  }

  /**
   * Valida o valor capturado da conversa pelo MESMO receptor (`verificarCandidato`):
   * mesmos tetos/backoff/resposta uniforme. Malformado → re-pede (sem debitar),
   * SEM ecoar o texto. Os restantes caminhos consomem a espera e respondem como
   * o fluxo inline.
   */
  async function validarValorAguardado(identity: SurfaceIdentity, candidato: string): Promise<void> {
    const veredito = deps.auth.verificarCandidato(identity, candidato)

    // MALFORMADO (≠6 dígitos): re-pede com a mensagem neutra, NAO debita tentativa
    // nem conta sonda, e NAO renova o TTL da espera (a janela total continua a
    // expirar). Um teto por chat corta o farm de respostas "Não entendi o
    // código…": apos MAX_MALFORMADO_POR_ESPERA re-asks -> REMOVE a espera e fica
    // em SILENCIO (default-deny, TG-089) ate o proximo `/parear`.
    if (veredito.kind === 'recusado' && veredito.reason === 'refuse:malformed') {
      const anteriores = malformadosPorChat.get(identity.chatKey) ?? 0
      if (anteriores >= MAX_MALFORMADO_POR_ESPERA) {
        aguardandoValor.delete(identity.chatKey)
        malformadosPorChat.delete(identity.chatKey)
        auditoria({ outcome: 'descartado', motivo: 'refuse:malformed-rate-limited', chatKey: identity.chatKey })
        return
      }
      malformadosPorChat.set(identity.chatKey, anteriores + 1)
      const atraso = atrasoMalformado(anteriores)
      if (atraso > 0) await time.sleep(atraso)
      await enviarPara(identity.chatKey, veredito.reply ?? RESPOSTA_PEDIR_VALOR_MALFORMADO)
      return
    }

    // Consumido: o fluxo de valor termina (pareia, recusa uniforme, ou rate-
    // limited silencioso). A espera sai em TODOS os casos bem-formados/já-debitados.
    aguardandoValor.delete(identity.chatKey)
    malformadosPorChat.delete(identity.chatKey) // consumo com sucesso reinicia o orcamento

    if (veredito.kind === 'pareado') {
      await enviarPara(veredito.dono.chatKey, veredito.reply)
      // EMENDA ONDA-1-PAREAR-VIA-PAINEL: comunicar ao HOST que pareou (fire-and-forget).
      deps.ipc.pairingSuccess({
        userKey: veredito.dono.userKey,
        chatKey: veredito.dono.chatKey,
        pairedAt: veredito.dono.pairedAt,
      })
      return
    }
    // recusado (uniforme / silencioso). O `verificarCandidato` so devolve
    // malformado/pareado/recusado; destrinche o kind para o TS.
    if (veredito.kind !== 'recusado') return
    if (veredito.delayMs > 0) await time.sleep(veredito.delayMs)
    if (veredito.reply !== undefined && veredito.chat !== undefined) {
      await enviarPara(veredito.chat, veredito.reply)
    }
  }

  /**
   * Enquanto ha uma espera de valor ATIVA para o chat, decide o destino da
   * mensagem: um comando cancela (e roda normal), `cancelar`/`não` cancela, e a
   * proxima mensagem de texto PURO do MESMO user e capturada como valor. A
   * mensagem de comando NUNCA e capturada como valor (04 §2).
   */
  async function tratarDuranteEspera(identity: SurfaceIdentity, registo: { readonly userKey: string }, texto: string): Promise<void> {
    const nome = extrairNomeDeComando(texto)
    if (nome !== undefined) {
      if (nome === 'cancelar') {
        aguardandoValor.delete(identity.chatKey)
        await enviarPara(identity.chatKey, RESPOSTA_AGUARDANDO_CANCELADO)
        return
      }
      // `/parear` vazio durante a espera: no-op (fica a esperar; anti-bomba —
      // N cliques no menu geram UMA pergunta). Outro comando (incl. `/parear
      // <valor>` inline) CANCELA a espera e roda normal.
      if (nome === 'parear' && ehParearSemValor(texto)) return
      aguardandoValor.delete(identity.chatKey)
      return continuarComando({ kind: 'comando', identity, text: texto })
    }

    // Texto PURO. Outro user no MESMO chat: NAO e capturado (fica a esperar).
    if (registo.userKey !== identity.userKey) return
    // `cancelar`/`não` como texto puro cancela.
    if (eIntencaoDeCancelar(texto)) {
      aguardandoValor.delete(identity.chatKey)
      await enviarPara(identity.chatKey, RESPOSTA_AGUARDANDO_CANCELADO)
      return
    }
    await validarValorAguardado(identity, texto)
  }

  /**
   * O funil de um COMANDO: receptor de pareamento PRIMEIRO (PAIR-006/007), o
   * redireto "pedir valor" quando `/parear` vazio, e o guard+despacho normal.
   */
  async function continuarComando(event: SurfaceCommandEvent): Promise<void> {
    const identity = event.identity

    // (1) Espera ATIVA para este chat? Decide o destino da mensagem. O TTL da
    // espera expira em lazy (NUNCA setTimeout). Um valor tardio apos o TTL →
    // SO o aviso `O código expirou. Use /parear de novo.` E O ESTADO REMOVIDO;
    // um comando tardio cancela e roda normal (04 §5).
    const registo = aguardandoValor.get(identity.chatKey)
    if (registo !== undefined) {
      if (time.now() >= registo.expiresAtMs) {
        aguardandoValor.delete(identity.chatKey)
        const nome = extrairNomeDeComando(event.text)
        if (nome === undefined && registo.userKey === identity.userKey) {
          await enviarPara(identity.chatKey, RESPOSTA_AGUARDANDO_EXPIROU)
          return
        }
        // comando tardio (ou valor de outro user): cai no funil normal.
      } else {
        await tratarDuranteEspera(identity, registo, event.text)
        return
      }
    }

    // (2) Nao ha espera. O receptor de pareamento corre PRIMEIRO: /start e
    // /parear sao o unico caminho legitimo de um estranho ate ao worker.
    const pareamento = deps.auth.receber(event)
    if (pareamento.kind !== 'ignorado') {
      if (pareamento.kind === 'pareado') {
        await enviarPara(pareamento.dono.chatKey, pareamento.reply)
        // EMENDA ONDA-1-PAREAR-VIA-PAINEL: avisa o HOST que o pareamento
        // concluiu — ele responde `pairing.owner` (liberta a allowlist no ato
        // via auth.semearDono) e persiste o dono no state.json. Best-effort e
        // fire-and-forget (S4): NAO se derruba nada se a entrega falhar — quem
        // re-pareia depois re-envia. NUNCA logar ids alem do minimo; `pairedAt`
        // e o do dono ja autorizado pelo worker.
        deps.ipc.pairingSuccess({
          userKey: pareamento.dono.userKey,
          chatKey: pareamento.dono.chatKey,
          pairedAt: pareamento.dono.pairedAt,
        })
        return
      }
      if (pareamento.kind === 'boas-vindas') {
        // CONTRATO §3: o /start (IGUAL para todos) ganha os 2 botoes —
        // `[🔘 Abrir menu]` (/menu) e `[ℹ️ Ajuda]` (/ajuda). O botao do menu
        // so RESOLVE para o dono (guard); a um estranho, o guard descarta em
        // silencio (TG-089). O texto da boas-vindas nunca diferencia dono.
        if (pareamento.chat !== undefined) {
          await enviarPara(pareamento.chat, pareamento.reply, {
            actionRows: [
              [
                { label: '🔘 Abrir menu', action: 'menu', token: gerarTokenOpaque() },
                { label: 'ℹ️ Ajuda', action: 'ajuda', token: gerarTokenOpaque() },
              ],
            ],
          })
        }
        return
      }
      // recusado
      // 04 §2/§3: un `/parear` SEM argumento (o clique no menu) re-redireto —
      // em vez do silencio antigo, arma a espera e PERGUNTA o codigo. NUNCA
      // mais o beco sem saida. (O receptor continua a contabilizar a sonda —
      // semantica atual preservada; so a comparacao de um valor bem-formado
      // debita palpite.)
      if (pareamento.reason === 'refuse:malformed') {
        armarEsperaDeValor(identity)
        await enviarPara(identity.chatKey, pareamento.reply ?? RESPOSTA_PEDIR_VALOR)
        return
      }
      if (pareamento.delayMs > 0) await time.sleep(pareamento.delayMs)
      if (pareamento.reply !== undefined && pareamento.chat !== undefined) {
        await enviarPara(pareamento.chat, pareamento.reply)
      }
      return
    }

    // (3) Guard + despacho normal.
    const admissao = deps.auth.admitirComando(event.identity)
    if (!admissao.admitido) {
      auditoria({ outcome: 'descartado', motivo: `deny:${admissao.motivo}` })
      // TG-089: silencio e contagem. Nao ha answer a um comando de texto.
      return
    }
    auditoria({ outcome: 'permitido' })
    await tratarComando(extrairNomeDeComando(event.text), event.identity)
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
      // O que o dono ve e o CURTO (§5); o texto de estado completo (com seq e
      // codigo EN) fica na linha de debug do LOG de auditoria.
      const projecaoAtual = projecao.ler()
      log.debug('estado difundido', { seq: projecaoAtual.seq, state: projecaoAtual.state })
      emSegundoPlano(chat, () => mostrarEstadoSerializado(chat, textoDeEstadoCurto(projecaoAtual, time.now())))
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
        // A resposta de /status: o ack trouxe o estado autoritativo. Texto CURTO (§5).
        emSegundoPlano(pendente.chatKey, () =>
          mostrarEstado(pendente.chatKey, textoDeEstadoCurto(projecao.ler(), time.now())),
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
      const texto = msg.result === 'noop' ? textoDeResultadoDoAck(pendente.acao, 'noop') : textoDeResultadoDoAck(pendente.acao, 'accepted')
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