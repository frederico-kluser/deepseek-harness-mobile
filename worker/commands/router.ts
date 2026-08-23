/**
 * Roteamento comando -> intent IPC; `setMyCommands` com a lista canonica; e o
 * funil por onde TODO update passa antes de virar intent.
 *
 * DONO: T5.2.
 *
 * ===========================================================================
 * A LISTA PUBLICADA (D5, e a FORMA DE REGISTO da emenda D5 do PREP 5)
 * ===========================================================================
 * A Bot API restringe `BotCommand.command` a `[a-z0-9_]{1,32}`. Por isso se
 * registam `parear` (sem barra, sem argumento) e `emergencia` (sem acento); o
 * `<código>` e o acento vivem na `description` (1..256 caracteres). A ordem e
 * a de D5 e o teste TG-080 compara o ARRAY INTEIRO, na ordem, nao "contem".
 * `/start` continua a existir como boas-vindas inocuo (PAIR-006) e NAO aparece
 * aqui.
 *
 * ===========================================================================
 * O NONCE DE CONFIRMACAO — O PORTE `emitirNonce`
 * ===========================================================================
 * O contrato congelado do canal IPC (PREP 4/5) NAO define transporte
 * host -> worker para o nonce de confirmacao: nenhuma das cinco mensagens
 * (state/ack/error/notify/pairing.challenge) o carrega, e o vocabulario de
 * `alerta:` do notify (T5.4) nao tem tipo de confirmacao. As acoes que
 * AUMENTAM exposicao (/ligar, /rotacionar) exige-lo, e o worker NAO o gera nem
 * o valida (S5) — apenas o transporta opaco dentro do `callback_data`.
 *
 * A superficie recebe um PORTE, {@link EmitirNonce}, injetado na construcao:
 * nos testes e um duplo do host que implementa a semantica de
 * `ConfirmService` (issue/consume, uso unico); em producao a costura liga-o a
 * ponte que T5.1 fia — ver o BLOQUEIO reportado no handoff de T5.2. Sem
 * nonce, a confirmacao falha FECHADO (nenhum intent, nenhum spawn).
 *
 * O /desligar NAO usa o porte: a acao que REDUZ exposicao dispensa nonce
 * (CTL-024) e o token de confirmacao e LOCAL do worker (efemero, uso unico,
 * ligado ao emissor) — a unica forma de ter confirmacao em 2 etapas sem
 * envolver o host, e o que trava o deputado-confuso do botao forjado (TG-025).
 *
 * ===========================================================================
 * S4 NESTE FICHEIRO: OS TRATADORES DO CANAL NAO LANCAM
 * ===========================================================================
 * `worker/ipc.ts` (T4.3) ja embrulha `onMessage` em try/catch (um defeito do
 * consumidor nao mata o canal), mas os tratadores deste ficheiro seguem a
 * mesma disciplina: o que falha aqui e logado e segue, nunca derruba o canal.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type {
  IpcAckMessage,
  IpcErrorCode,
  IpcErrorMessage,
  IpcIntentMessage,
  IpcIntentName,
  IpcMessageToWorker,
  IpcNotifyMessage,
  IpcPairingChallengeMessage,
  IpcStateMessage,
} from '../../src/contracts/ipc.ts'
import type { TunnelState } from '../../src/contracts/tunnel.ts'

import { buildCallbackData, type IdentityGuard } from '../auth/guard.ts'
import type { UpdateIdentity } from '../auth/allowlist.ts'
import type { PairingChallenge, PairingReceiver } from '../auth/pairing.ts'
import type { TimeSource } from '../lib/clock.ts'
import type { WorkerLogger } from '../lib/log.ts'
import {
  answerCallbackAlways,
  buildInlineKeyboard,
  editMessageTextInPlace,
  type EditOutcome,
  type InlineButtonSpec,
} from '../lib/keyboard.ts'

import { criarAccess } from './access.ts'
import { criarOnOff } from './onoff.ts'
import { criarStatus } from './status.ts'

/* ========================================================================== */
/* 1. A LISTA CANONICA (D5) — publicada por setMyCommands                      */
/* ========================================================================== */

/** Forma minima de `BotCommand` — estrutural, para o teste. */
export interface ComandoPublicado {
  readonly command: string
  readonly description: string
}

/**
 * A lista FECHADA, na ordem de D5. TG-080 compara o array inteiro.
 *
 * Forma de registo (emenda D5 do PREP 5): `command` e `[a-z0-9_]{1,32}` — sem
 * barra, `parear` sem argumento e `emergencia` sem acento; o `<código>` e o
 * acento vivem na `description` (1..256 caracteres).
 */
export const COMANDOS_PUBLICADOS: readonly ComandoPublicado[] = Object.freeze([
  { command: 'ligar', description: 'Liga o túnel de acesso (pede confirmação)' },
  { command: 'desligar', description: 'Desliga o túnel (pede confirmação)' },
  { command: 'status', description: 'Estado atual: túnel, tempo no ar e quando expira' },
  { command: 'acessar', description: 'Envia o link com a sua chave de acesso' },
  { command: 'rotacionar', description: 'Gera chave nova e invalida a anterior (pede confirmação)' },
  { command: 'parear', description: 'Parear com o código <código> mostrado no terminal' },
  { command: 'emergencia', description: 'Emergência: desliga o túnel e este bot' },
])

/** O que `setMyCommands` precisa de receber. Estrutural, para o teste. */
export interface SetMyCommandsApi {
  setMyCommands(other: { readonly commands: readonly ComandoPublicado[] }): Promise<unknown>
}

/** Publica a lista canonica. TG-080: o array chega inteiro, na ordem. */
export async function registarComandosPublicados(api: SetMyCommandsApi): Promise<unknown> {
  return api.setMyCommands({ commands: COMANDOS_PUBLICADOS })
}

/* ========================================================================== */
/* 2. LEITURA DO COMANDO                                                      */
/* ========================================================================== */

/**
 * Extrai o nome de `/comando[ argumentos]` (aceita o sufixo `@bot` que o
 * cliente monta em grupo). Devolve `undefined` quando nao ha comando.
 *
 * Varrimento manual e nao regex pelo mesmo motivo de `worker/auth/pairing.ts`:
 * nada de `RegExp.input` com texto vindo da internet.
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
/* 3. REQUEST ID (ULID) E TOKENS OPAQUE                                         */
/* ========================================================================== */

/** Alfabeto Crockford base32 do ULID (sem I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ULID de 26 caracteres: 48 bits de timestamp (relogio INJETADO) + 80 bits de
 * CSPRNG. E a CHAVE DE IDEMPOTENCIA do `ControlIntent` (D29): repetido, o host
 * devolve o resultado da primeira execucao.
 */
export function gerarRequestId(agora: number): string {
  const tempo = BigInt(agora)
  const aleatorio = BigInt(`0x${randomBytes(10).toString('hex')}`)
  let valor = (tempo << 80n) | aleatorio
  let saida = ''
  for (let i = 0; i < 26; i += 1) {
    saida = CROCKFORD[Number(valor & 31n)] + saida
    valor >>= 5n
  }
  return saida
}

/** Token opaco com a FORMA do nonce do host (`randomBytes(8).toString('base64url')`). */
export function gerarTokenOpaque(): string {
  return randomBytes(8).toString('base64url')
}

/* ========================================================================== */
/* 4. PROJECCAO DE ESTADO                                                     */
/* ========================================================================== */

/**
 * O host e a fonte unica da verdade; o bot e uma PROJECCAO e nao mantem estado
 * proprio alem do ultimo `seq` que viu (`src/contracts/ipc.ts`). O unico campo
 * derivado localmente e `readyDesde` — o instante em que a projecao viu a
 * transicao para READY — porque TG-084 exige "ha quanto tempo" e a mensagem de
 * estado nao o carrega.
 */
export interface ProjecaoDeEstado {
  readonly state: TunnelState | undefined
  readonly seq: number
  readonly url?: string | undefined
  readonly expiresAt?: number | undefined
  readonly readyDesde?: number | undefined
}

export interface Projecao {
  readonly ler: () => ProjecaoDeEstado
  /** Aplica uma difusao. Devolve `false` quando fora de ordem (seq <= ultimo). */
  aplicarDifusao(msg: IpcStateMessage, agora: number): boolean
  /** Aplica o estado de um ack (o ack nao traz seq; o estado e autoritativo). */
  aplicarEstado(state: TunnelState, agora: number): void
}

export function criarProjecao(): Projecao {
  let state: TunnelState | undefined
  let seq = 0
  let url: string | undefined
  let expiresAt: number | undefined
  let readyDesde: number | undefined

  /**
   * Marca o instante da transicao PARA READY. O `anterior` e o estado ANTES da
   * actualizacao — comparar com o ja-actualizado nunca marcaria a transicao.
   */
  function marcarReadySe(estado: TunnelState, anterior: TunnelState | undefined, agora: number): void {
    if (estado === 'READY' && anterior !== 'READY') readyDesde = agora
    if (estado !== 'READY') readyDesde = undefined
  }

  return {
    ler: () => ({ state, seq, url, expiresAt, readyDesde }),
    aplicarDifusao(msg, agora): boolean {
      if (msg.seq <= seq) return false
      const anterior = state
      seq = msg.seq
      state = msg.state
      url = msg.url
      expiresAt = msg.expiresAt
      marcarReadySe(msg.state, anterior, agora)
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
/* 5. TEXTO DE ESTADO (TG-084)                                                 */
/* ========================================================================== */

/** Rotulos em portugues — texto de UI; codigo e payload usam o enum (tunnel.ts). */
export const ROTULOS_DE_ESTADO: Readonly<Record<TunnelState, string>> = Object.freeze({
  STOPPED: 'desligado',
  STARTING: 'ligando',
  READY: 'online',
  DEGRADED: 'instável, tentando de novo',
  STOPPING: 'desligando',
  FAILED: 'falhou — precisa de ação sua',
})

/** `ms` -> «menos de 1 min», «N min», «N h M min», «agora». Deterministico. */
export function formatarDuracao(ms: number): string {
  if (ms <= 0) return 'agora'
  if (ms < 60_000) return 'menos de 1 min'
  const minutos = Math.floor(ms / 60_000)
  if (minutos < 60) return `${String(minutos)} min`
  const horas = Math.floor(minutos / 60)
  const resto = minutos % 60
  return resto === 0 ? `${String(horas)} h` : `${String(horas)} h ${String(resto)} min`
}

/** `ms` -> «HH:MM» no fuso local. */
export function formatarHora(ms: number): string {
  const data = new Date(ms)
  const h = String(data.getHours()).padStart(2, '0')
  const m = String(data.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * O texto de /status e das difusoes de estado. NAO expoe segredo nem digest
 * (TG-084): so estado, seq, URL (sse READY), tempo no ar e expiracao do TTL.
 */
export function textoDeEstado(projecao: ProjecaoDeEstado, agora: number): string {
  if (projecao.state === undefined) {
    return 'Estado: desconhecido (o host ainda não enviou estado)'
  }
  const linhas: string[] = [
    `Estado: ${ROTULOS_DE_ESTADO[projecao.state]} (${projecao.state})`,
    `Sequência: ${String(projecao.seq)}`,
  ]
  if (projecao.state === 'READY') {
    if (projecao.url !== undefined) linhas.push(`Túnel: ${projecao.url}`)
    if (projecao.readyDesde !== undefined) {
      linhas.push(`No ar há: ${formatarDuracao(agora - projecao.readyDesde)}`)
    }
    if (projecao.expiresAt !== undefined) {
      linhas.push(
        `Expira: em ${formatarDuracao(projecao.expiresAt - agora)} (${formatarHora(projecao.expiresAt)})`,
      )
    }
  }
  return linhas.join('\n')
}

/** Teto da Bot API para `Message.text`. Nada sai daqui acima (pergunta 4 da revisao). */
export const MAX_TEXTO_MENSAGEM = 4_096

/** Corta num limite de caracteres — nunca estoura na API (TG-048). */
export function cortarTexto(texto: string, max = MAX_TEXTO_MENSAGEM): string {
  return texto.length <= max ? texto : `${texto.slice(0, max - 1)}…`
}

/* ========================================================================== */
/* 6. A API MINIMA DO BOT (estrutural — o grammY satisfaz)                    */
/* ========================================================================== */

export interface EnviarOpcoes {
  readonly reply_markup?: ReturnType<typeof buildInlineKeyboard>
  readonly disable_web_page_preview?: boolean
}

export interface ApiDoBot {
  sendMessage(
    chatId: number,
    texto: string,
    outras?: EnviarOpcoes,
  ): Promise<{ readonly message_id: number }>
  editMessageText(
    chatId: number,
    messageId: number,
    texto: string,
    outras?: { readonly reply_markup?: ReturnType<typeof buildInlineKeyboard> },
  ): Promise<unknown>
  answerCallbackQuery(
    callbackQueryId: string,
    outras?: { readonly text?: string; readonly show_alert?: boolean },
  ): Promise<true>
}

/* ========================================================================== */
/* 7. O CONTEXTO QUE A SUPERFICIE OFERECE AOS COMANDOS                        */
/* ========================================================================== */

/**
 * Nonce de confirmacao das acoes que AUMENTAM exposicao. O worker NAO o gera
 * nem o valida (S5): pede-o ao HOST pelo canal (EMENDA-COSTURA-5 —
 * `nonce.request`/`nonce.issued`) e transporta-o opaco. A resposta e
 * ASSINCRONA (o host responde pelo pipe); `undefined` = host indisponivel ou
 * timeout — o comando falha FECHADO, nenhum intent sai (CTL-023).
 */
export type EmitirNonce = (acao: IpcIntentName) => Promise<string | undefined>

/** O que a superficie oferece aos comandos (onoff/access/status). */
export interface ContextoDoComando {
  readonly api: ApiDoBot
  readonly log: WorkerLogger
  readonly time: TimeSource
  readonly ipc: { send(intent: IpcIntentMessage): boolean }
  readonly emitirNonce: EmitirNonce
  /** Derruba o worker (emergencia). Na producao, `bot.stop()`. */
  readonly parar: () => Promise<void>
  /** Envia UMA mensagem nova. Devolve o `message_id`. */
  enviar(chat: number, texto: string, opcoes?: EnviarOpcoes): Promise<number>
  /** Edita in-place. NUNCA lanca; devolve o veredito (helper de T4.2). */
  editar(
    chat: number,
    messageId: number,
    texto: string,
    opcoes?: EnviarOpcoes,
  ): Promise<EditOutcome>
  /**
   * Mostra TEXTO DE ESTADO (sem markup): edita a ultima mensagem de estado do
   * chat in-place (TG-028) ou envia uma nova. As difusoes usam a versao
   * serializada; as respostas a comandos usam esta, directa.
   */
  mostrarEstado(chat: number, texto: string): Promise<number>
  responderCallback(
    callbackQueryId: string,
    outras?: { readonly text?: string; readonly show_alert?: boolean },
  ): Promise<boolean>
  pendente: {
    registar(requestId: string, chat: number, acao: IpcIntentName, messageId: number | undefined): void
    retirar(requestId: string): PendingIntent | undefined
  }
  projecao: { ler(): ProjecaoDeEstado }
  /** Chat do dono pareado, ou `undefined` antes do pareamento. */
  dono(): number | undefined
}

export interface PendingIntent {
  readonly requestId: string
  readonly chat: number
  readonly acao: IpcIntentName
  readonly messageId: number | undefined
}

/** Teto do mapa de intents pendentes: defensivo, evita crescimento sem limite. */
const MAX_PENDENTES = 64

/* ========================================================================== */
/* 8. O ROTEADOR                                                              */
/* ========================================================================== */

export interface RoteadorDeps {
  readonly log: WorkerLogger
  readonly time: TimeSource
  readonly guard: IdentityGuard
  readonly pairing: PairingReceiver
  readonly ipc: { send(intent: IpcIntentMessage): boolean }
  readonly api: ApiDoBot
  readonly emitirNonce: EmitirNonce
  readonly parar: () => Promise<void>
}

export interface Roteador {
  /** TODO update do Telegram passa por aqui (grammY: bot.on). */
  tratarUpdate(update: unknown): Promise<void>
  /** Os cinco tipos host -> worker. NUNCA lanca (S4). */
  onState(msg: IpcStateMessage): void
  onAck(msg: IpcAckMessage): void
  onError(msg: IpcErrorMessage): void
  onNotify(msg: IpcNotifyMessage): void
  onPairingChallenge(msg: IpcPairingChallengeMessage): void
}

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

/**
 * O vocabulario de `alerta:<tipo>` do notify — CONTRATO DE T5.4 (fechado em
 * voo durante a Onda 5; ver a premissa no handoff). A primeira linha do texto
 * e o marcador; a renderizacao pode oculta-lo.
 */
export const TIPOS_DE_ALERTA = Object.freeze([
  'sessao-nova',
  'auth-falha',
  'tunel-ligar',
  'tunel-desligar',
  'ttl-expirado',
  'modo-restrito',
  'magic-suspeito',
  'relatorio',
  'link-magico',
] as const)

export type TipoDeAlerta = (typeof TIPOS_DE_ALERTA)[number]

const PREFIXO_ALERTA = 'alerta:'

/** Separa a primeira linha (o marcador) do corpo mostrado ao dono. */
export function extrairAlerta(texto: string): { tipo: TipoDeAlerta | undefined; corpo: string } {
  const quebra = texto.indexOf('\n')
  const primeira = quebra === -1 ? texto : texto.slice(0, quebra)
  const corpo = quebra === -1 ? '' : texto.slice(quebra + 1)
  if (!primeira.startsWith(PREFIXO_ALERTA)) return { tipo: undefined, corpo: texto }
  const tipo = primeira.slice(PREFIXO_ALERTA.length).trim()
  return {
    tipo: (TIPOS_DE_ALERTA as readonly string[]).includes(tipo) ? (tipo as TipoDeAlerta) : undefined,
    corpo,
  }
}

/**
 * O mapeamento texto -> botoes do notify (decisao de T5.2, documentada): os
 * tipos que oferecem acao ao dono ganham UM botao com intencao `emergency` (a
 * acao que REDUZ exposicao, sem nonce — CTL-024); `link-magico` nao ganha
 * botao mas liga `disable_web_page_preview`. O token do botao e gerado pelo
 * worker e viaja opaco (o host nao o consome para `emergency`).
 */
export function botoesDoAlerta(
  tipo: TipoDeAlerta | undefined,
): readonly (readonly InlineButtonSpec[])[] {
  switch (tipo) {
    case 'sessao-nova':
      return [[{ text: 'Não fui eu', data: buildCallbackData('emergency', gerarTokenOpaque()) }]]
    case 'auth-falha':
      return [[{ text: 'Derrubar túnel agora', data: buildCallbackData('emergency', gerarTokenOpaque()) }]]
    case 'ttl-expirado':
    case 'relatorio':
      return [[{ text: 'Encerrar', data: buildCallbackData('emergency', gerarTokenOpaque()) }]]
    case 'tunel-ligar':
    case 'tunel-desligar':
    case 'modo-restrito':
    case 'magic-suspeito':
    case 'link-magico':
    case undefined:
      return []
  }
}

/* ========================================================================== */
/* 9. A FABRICA                                                               */
/* ========================================================================== */

export function criarRoteador(deps: RoteadorDeps): Roteador {
  const { log, time } = deps
  const projecao = criarProjecao()
  const pendentes = new Map<string, PendingIntent>()
  /** A ultima mensagem de ESTADO por chat — as difusoes editam-na in-place. */
  const ultimaMensagemDeEstado = new Map<number, number>()
  /**
   * AUTOLINK (onda1): a ligacao (requestId) do /ligar do dono que pediu o link
   * da chave de acesso. Armado na confirmacao de `tunnel.up` que VAI prosseguir
   * e consumido (desarmado) quando o tunel chega a READY — UMA unica vez por
   * ligacao. CHAVEADO POR requestId: um ack (ou um tap sobreposto) de OUTRA
   * confirmacao NAO desarma este slot (o IdentityGuard nao deduplica callbacks
   * por desenho). `null` = inativo.
   */
  let autolink: { readonly requestId: string; readonly from: number; readonly chat: number } | null = null

  /**
   * Serializador de 1 msg/s POR CHAT para a DIFUSAO de estado (pergunta 5 da
   * revisao / TG-049): um flapping NAO pode gerar enxurrada e 429. A primeira
   * difusao sai logo; as seguintes dentro da janela de 1 s sao COALESCIDAS (so
   * a ultima importa — a proxima difusao traz seq novo) e entregues quando a
   * janela fecha. As respostas a comandos NAO passam por aqui: sao interativas
   * e curtas, e a coalescencia trocaria a ordem delas.
   */
  const porChat = new Map<number, { ultimoEnvio: number; pendente: string | undefined; emEspera: boolean }>()

  async function enviarPara(chat: number, texto: string, opcoes?: EnviarOpcoes): Promise<number> {
    const resposta = await deps.api.sendMessage(chat, cortarTexto(texto), opcoes)
    return resposta.message_id
  }

  async function editarPara(
    chat: number,
    messageId: number,
    texto: string,
    opcoes?: EnviarOpcoes,
  ): Promise<EditOutcome> {
    return editMessageTextInPlace(
      deps.api,
      { chatId: chat, messageId },
      cortarTexto(texto),
      log,
      opcoes?.reply_markup,
    )
  }

  async function mostrarEstado(chat: number, texto: string): Promise<number> {
    const registada = ultimaMensagemDeEstado.get(chat)
    if (registada === undefined) {
      const id = await enviarPara(chat, texto)
      ultimaMensagemDeEstado.set(chat, id)
      return id
    }
    await editarPara(chat, registada, texto)
    return registada
  }

  async function mostrarEstadoSerializado(chat: number, texto: string): Promise<void> {
    const estado =
      porChat.get(chat) ?? { ultimoEnvio: Number.NEGATIVE_INFINITY, pendente: undefined, emEspera: false }
    porChat.set(chat, estado)
    // Enquanto uma janela de coalescencia estiver aberta (`emEspera`), NENHUMA
    // difusao sai imediatamente — a janela so fecha quando o sono pedido ao
    // relogio injetado resolve e a ULTIMA difusao pendente sai.
    if (!estado.emEspera && time.now() - estado.ultimoEnvio >= 1_000) {
      estado.ultimoEnvio = time.now()
      await mostrarEstado(chat, texto)
      return
    }
    estado.pendente = texto
    if (estado.emEspera) return
    estado.emEspera = true
    const falta = Math.max(1, 1_000 - (time.now() - estado.ultimoEnvio))
    // A entrega da ultima difusao pode falhar (rede, 429): o .catch regista e
    // segue — nunca uma rejeicao nao tratada a matar o processo (S4).
    void time.sleep(falta)
      .then(async () => {
        const atual = porChat.get(chat)
        if (atual === undefined) return undefined
        atual.emEspera = false
        const porEnviar = atual.pendente
        atual.pendente = undefined
        if (porEnviar === undefined) return undefined
        atual.ultimoEnvio = time.now()
        return mostrarEstado(chat, porEnviar)
      })
      .catch((error) => {
        log.error('falha ao entregar a difusao coalescida', {
          chat,
          detail: descrever(error),
        })
      })
  }

  const contexto: ContextoDoComando = {
    api: deps.api,
    log,
    time,
    ipc: deps.ipc,
    emitirNonce: deps.emitirNonce,
    parar: deps.parar,
    enviar: enviarPara,
    editar: editarPara,
    mostrarEstado,
    responderCallback: (id, outras) => answerCallbackAlways(deps.api, id, log, outras),
    pendente: {
      registar: (requestId, chat, acao, messageId) => {
        if (pendentes.size >= MAX_PENDENTES) {
          const maisAntigo = pendentes.keys().next().value
          if (maisAntigo !== undefined) pendentes.delete(maisAntigo)
        }
        pendentes.set(requestId, { requestId, chat, acao, messageId })
      },
      retirar: (requestId) => {
        const p = pendentes.get(requestId)
        if (p !== undefined) pendentes.delete(requestId)
        return p
      },
    },
    projecao: { ler: () => projecao.ler() },
    dono: () => {
      const estado = deps.pairing.state()
      return estado.status === 'fechado' ? estado.owner.chat : undefined
    },
  }

  function auditoria(campos: Readonly<Record<string, unknown>>): void {
    log.info('auditoria', campos)
  }

  /**
   * Corre uma tarefa de renderizacao EM SEGUNDO PLANO com tratamento explicito
   * de falha. Nenhum `void` async do despacho fica sem `.catch`: uma rejeicao
   * nao tratada em Node 24 e um throw que mata o processo — exatamente no
   * cenario (rede transitoria/429 durante o flapping) que o serializador
   * existe para conter. A falha e registada e o canal segue vivo (S4).
   */
  function emSegundoPlano(chat: number | undefined, tarefa: () => Promise<unknown>): void {
    void tarefa().catch((error) => {
      log.error('falha ao renderizar para o chat', { chat, detail: descrever(error) })
    })
  }

  /* ---- os comandos por ficheiro (onoff/access/status) -------------------- */

  const comandosOnOff = criarOnOff(contexto)
  const comandosAccess = criarAccess(contexto)
  const comandosStatus = criarStatus(contexto)

  /* ---- o funil do update -------------------------------------------------- */

  async function tratarUpdate(update: unknown): Promise<void> {
    // O receptor de pareamento corre PRIMEIRO: /start e /parear sao o unico
    // caminho legitimo de um estranho ate ao worker (PAIR-006/007).
    const pareamento = deps.pairing.receive(update)
    if (pareamento.kind !== 'ignored') {
      auditoria({ ...pareamento.audit })
      if (pareamento.kind === 'paired') {
        await enviarPara(pareamento.owner.chat, pareamento.reply)
        return
      }
      if (pareamento.kind === 'welcome') {
        const chat = pareamento.audit.chat
        if (chat !== undefined) await enviarPara(chat, pareamento.reply)
        return
      }
      // refused
      if (pareamento.delayMs > 0) await time.sleep(pareamento.delayMs)
      const chat = pareamento.audit.chat
      if (pareamento.reply !== undefined && chat !== undefined) {
        await enviarPara(chat, pareamento.reply)
      }
      return
    }

    const decisao = deps.guard.admit(update)
    auditoria({ ...decisao.audit })

    if (decisao.kind === 'discarded') {
      // TG-089: silencio e contagem. O answer e obrigacao de protocolo (TG-027).
      if (decisao.answer !== undefined) {
        await answerCallbackAlways(deps.api, decisao.answer.callbackQueryId, log)
      }
      return
    }

    if (decisao.kind === 'callback') {
      await tratarCallback(decisao, lerMessageIdDoCallback(update))
      return
    }

    const texto = lerTextoDoUpdate(update)
    await tratarComando(texto === undefined ? undefined : extrairNomeDeComando(texto), decisao.identity)
  }

  function enviarIntent(
    intent: Omit<IpcIntentMessage, 'v' | 'type'>,
    messageId: number | undefined,
  ): boolean {
    const mensagem: IpcIntentMessage = { v: 1, type: 'intent', ...intent }
    const aceite = deps.ipc.send(mensagem)
    if (aceite) {
      contexto.pendente.registar(mensagem.requestId, mensagem.chat, mensagem.intent, messageId)
    } else {
      log.error('intent recusada pelo canal (host indisponivel ou fila cheia)', {
        intent: mensagem.intent,
        chat: mensagem.chat,
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
   * transporta o token de link. Best-effort: enviarIntent ja regista o
   * pendente (o ack de session.issue REGISTA o erro como mensagem propria) e
   * o autolink ja foi desarmado ANTES — um envio falho nao deixa o flag vivo.
   */
  function emitirLinkAutomatico(arma: { readonly from: number; readonly chat: number }): void {
    if (projecao.ler().state !== 'READY') return
    enviarIntent(
      { intent: 'session.issue', requestId: gerarRequestId(time.now()), from: arma.from, chat: arma.chat },
      undefined,
    )
  }

  async function tratarComando(nome: string | undefined, identidade: UpdateIdentity): Promise<void> {
    switch (nome) {
      case 'ligar':
        await comandosOnOff.ligar(identidade)
        return
      case 'desligar':
        await comandosOnOff.desligar(identidade)
        return
      case 'status':
        await comandosStatus.status(identidade)
        return
      case 'acessar':
        await comandosAccess.acessar(identidade)
        return
      case 'rotacionar':
        await comandosAccess.rotacionar(identidade)
        return
      case 'emergencia':
        await comandosStatus.emergencia(identidade)
        return
      case undefined:
      case 'start':
      case 'parear':
        // `start`/`parear` sao consumidos pelo receptor; texto sem comando nao e assunto.
        return
      default:
        // TG-081: comando morto ou desconhecido — NENHUM intent. So uma palavra ao dono.
        await enviarPara(identidade.chat, 'Não conheço este comando.')
    }
  }

  async function tratarCallback(
    decisao: Extract<ReturnType<IdentityGuard['admit']>, { kind: 'callback' }>,
    messageId: number | undefined,
  ): Promise<void> {
    switch (decisao.action) {
      case 'tunnel.up':
      case 'secret.rotate': {
        // A CONFIRMACAO. O token viaja OPACO (S5): o worker nao o valida — o
        // host consome. Um token ja consumido ou forjado e recusado LA, e o
        // ack devolve a recusa para renderizar. O answer vem sem texto: o
        // feedback do clique e a edicao in-place da mensagem (a do botao).
        await answerCallbackAlways(deps.api, decisao.answer.callbackQueryId, log)
        // AUTOLINK (onda1): o /ligar confirmado arma o envio automatico do
        // link da chave de acesso, CHAVEADO pelo requestId DESTA ligacao.
        // Quando o tunel chega a READY, o worker pede `session.issue` ao host
        // SOZINHO — o host compoe o link (`https://<url>?key=<token>`) e
        // notifica. O slot so e armado se nao houver outra ligacao em curso
        // (so a PRIMEIRA confirmacao pode vir a ser a que sobe — o host
        // serializa os starts e um segundo `tunnel.up` enquanto STARTING e
        // noop). Um tap sobreposto (double-tap) nao sobrescreve a ligacao boa.
        const requestIdUp = gerarRequestId(time.now())
        if (decisao.action === 'tunnel.up' && autolink === null) {
          autolink = {
            requestId: requestIdUp,
            from: decisao.identity.from,
            chat: decisao.identity.chat,
          }
        }
        enviarIntent(
          {
            intent: decisao.action,
            requestId: requestIdUp,
            from: decisao.identity.from,
            chat: decisao.identity.chat,
            nonce: decisao.token,
          },
          messageId,
        )
        return
      }
      case 'tunnel.down':
        await comandosOnOff.confirmarDesligar(
          decisao.identity,
          decisao.token,
          decisao.answer.callbackQueryId,
          messageId,
        )
        return
      case 'emergency':
        // Os botoes dos notify de T5.4 (sessao-nova/auth-falha/ttl/relatorio).
        await answerCallbackAlways(deps.api, decisao.answer.callbackQueryId, log)
        await comandosStatus.emergencia(decisao.identity)
        return
      case 'tunnel.status':
      case 'session.issue':
        // Nunca renderizamos botoes destas acoes.
        log.warn('callback de acao sem botao renderizado; descartado', { action: decisao.action })
        await answerCallbackAlways(deps.api, decisao.answer.callbackQueryId, log)
    }
  }

  /* ---- os cinco tratadores do canal (S4: nunca lancam) -------------------- */

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
      // primeiro READY com autolink armado; as difusoes seguintes de READY ja
      // nao o encontram). O "uma mensagem por ligacao/URL" e esta garantia.
      if (autolink !== null && projecao.ler().state === 'READY') {
        const alvo = autolink
        autolink = null
        emitirLinkAutomatico(alvo)
      }
      // AUTOLINK (onda1) — defesa terminal: se a ligacao armada desembocou num
      // estado terminal (FAILED/STOPPED) em vez de READY, o slot morre — nao
      // ha READY para onde a ligar, e um READY tardio de outra origem nao pode
      // ressuscitar um link dona de uma ligacao que nao subiu.
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
      projecao.aplicarEstado(msg.state, time.now())
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
      // MESMA ligacao (requestId igual) — nunca o de outra confirmacao
      // sobreposta. O `accepted` mantem o slot armado para o READY.
      if (pendente.acao === 'tunnel.up' && msg.result !== 'accepted' && autolink?.requestId === pendente.requestId) {
        autolink = null
      }
      if (msg.result === 'rejected') {
        const texto = textoDeRecusa(msg.code ?? 'INTERNAL')
        if (pendente.acao === 'session.issue') {
          // A resposta de /acessar — aceite OU recusa — nunca edita o painel
          // de estado: o aceite chega por notify (TG-085) e a recusa e uma
          // mensagem propria, para o painel sobreviver aos dois.
          emSegundoPlano(pendente.chat, () => enviarPara(pendente.chat, texto))
          return
        }
        if (pendente.messageId !== undefined) {
          // A mensagem do fluxo (teclado de confirmacao) e a mais precisa.
          emSegundoPlano(pendente.chat, () => editarPara(pendente.chat, pendente.messageId!, texto))
          ultimaMensagemDeEstado.set(pendente.chat, pendente.messageId)
        } else {
          emSegundoPlano(pendente.chat, () => mostrarEstado(pendente.chat, texto))
        }
        return
      }
      if (pendente.acao === 'tunnel.status') {
        // A resposta de /status: o ack trouxe o estado autoritativo.
        emSegundoPlano(pendente.chat, () =>
          mostrarEstado(pendente.chat, textoDeEstado(projecao.ler(), time.now())),
        )
        return
      }
      if (pendente.acao === 'session.issue') {
        // O aceite de /acessar e INVISIVEL de proposito: a resposta (link
        // magico ou instrucao do caminho local) chega por `notify` composto
        // pelo host (TG-085). Renderizar «Pedido aceite.» aqui EDITA a
        // ultima mensagem de estado in-place e destroi o painel — a doc de
        // access.ts promete o contrario, e a promessa e o comportamento.
        return
      }
      const texto =
        msg.result === 'noop'
          ? 'Já estava assim.'
          : acaoEmProgresso(pendente.acao)
      if (pendente.messageId !== undefined) {
        emSegundoPlano(pendente.chat, () => editarPara(pendente.chat, pendente.messageId!, texto))
        ultimaMensagemDeEstado.set(pendente.chat, pendente.messageId)
      } else {
        emSegundoPlano(pendente.chat, () => mostrarEstado(pendente.chat, texto))
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
          // nunca edicao do painel de estado (o mesmo carve-out dos acks,
          // A2): o painel sobrevive e o erro chega como mensagem nova.
          emSegundoPlano(pendente.chat, () => enviarPara(pendente.chat, msg.message))
        } else {
          emSegundoPlano(pendente.chat, () => mostrarEstado(pendente.chat, msg.message))
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
      const botoes = botoesDoAlerta(tipo)
      const opcoes: EnviarOpcoes =
        tipo === 'link-magico'
          ? { disable_web_page_preview: true }
          : botoes.length > 0
            ? { reply_markup: buildInlineKeyboard(botoes) }
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
      const desafio: PairingChallenge = {
        expiresAt: msg.expiresAt,
        verify: (candidato: string): boolean =>
          timingSafeEqual(createHash('sha256').update(candidato, 'utf8').digest(), digest),
      }
      deps.pairing.rotateChallenge(desafio)
      log.info('desafio de pareamento rotacionado', { expiresAt: msg.expiresAt })
    } catch (error) {
      log.error('falha ao rotacionar desafio de pareamento', { detail: descrever(error) })
    }
  }

  return { tratarUpdate, onState, onAck, onError, onNotify, onPairingChallenge }
}

function lerTextoDoUpdate(update: unknown): string | undefined {
  if (typeof update !== 'object' || update === null) return undefined
  const message = (update as Record<string, unknown>)['message']
  if (typeof message !== 'object' || message === null) return undefined
  const texto = (message as Record<string, unknown>)['text']
  return typeof texto === 'string' ? texto : undefined
}

/** `callback_query.message.message_id` — a mensagem onde o botao vive. */
function lerMessageIdDoCallback(update: unknown): number | undefined {
  if (typeof update !== 'object' || update === null) return undefined
  const cq = (update as Record<string, unknown>)['callback_query']
  if (typeof cq !== 'object' || cq === null) return undefined
  const message = (cq as Record<string, unknown>)['message']
  if (typeof message !== 'object' || message === null) return undefined
  const id = (message as Record<string, unknown>)['message_id']
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined
}

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

export type { IpcMessageToWorker }
