/**
 * =============================================================================
 * Lado HOST do canal JSONL host <-> worker. Especificacao: `../contracts/ipc.ts`.
 * =============================================================================
 *
 * NEUTRO POR NATUREZA: este canal transporta apenas mensagens do contrato IPC e
 * nao conhece o provedor de mensageria (telegram hoje, outros no futuro). Este
 * ficheiro foi extirpado da antiga pasta `src/telegram/` (onde se chamava
 * `ipc.ts`) para `src/ipc/channel.ts` no desacoplamento do bot -> provedores
 * (Onda 5b) — o "telegram" no nome era legado da altura em que o canal era o
 * transporte do bot do Telegram.
 *
 * TRES CAMADAS, e a separacao e o que torna S4 testavel:
 *
 *   1. CODEC   -- `serializeIpcMessage` / `parseIpcLine`: uma linha <-> uma
 *                 mensagem. Sem I/O, sem estado.
 *   2. FRAMING -- `createIpcLineDecoder`: o acumulador que reconstroi uma linha
 *                 partida entre dois `data`, e que corta uma linha sem fim.
 *   3. CANAL   -- `createHostIpcChannel`: liga as duas ao `stdout`/`stdin` do
 *                 filho, com backpressure LIMITADA e disposer sincrono.
 *
 * -----------------------------------------------------------------------------
 * PORQUE ESTE CODEC ESTA DUPLICADO EM `worker/ipc.ts` — e porque isso NAO e a
 * duplicacao que `proc/retry.ts` proibe.
 * -----------------------------------------------------------------------------
 * `05-QUALIDADE-CODIGO.md` 5.5 autoriza o worker a importar de `src/` UMA coisa
 * e so uma: `src/contracts/ipc.ts`. Importar ESTE ficheiro arrastaria
 * `src/logging/**` e `src/errors.ts` para dentro do grafo de modulos do processo
 * que fala com a internet — exatamente o acoplamento que a separacao de
 * processos existe para impedir. A duplicacao e imposta pela fronteira, nao
 * escolhida.
 *
 * O que a torna segura e um GATE e nao uma promessa: `test/unit/worker/ipc.test.ts`
 * corre a MESMA tabela de linhas malformadas pelos DOIS analisadores e assere
 * veredito identico. No dia em que um divergir, o teste fica vermelho.
 *
 * -----------------------------------------------------------------------------
 * S4 E UM TIPO DE RETORNO, NAO UMA EXCECAO — e o codigo obedece.
 * -----------------------------------------------------------------------------
 * Nada no caminho de LEITURA lanca: linha malformada vira `{ ok: false, reason }`,
 * o canal regista e continua. A razao esta no contrato — a outra ponta pode ter
 * sido reiniciada a meio de uma escrita, e derrubar o canal por um byte perdido
 * transforma um glitch numa queda de servico. O caminho de ESCRITA lanca, porque
 * ali um erro e defeito NOSSO e o silencio seria pior.
 */

import { StringDecoder } from 'node:string_decoder'

import type { Readable, Writable } from 'node:stream'

import {
  IPC_PROTOCOL_VERSION,
  type ControlAction,
  type IpcAckMessage,
  type IpcErrorCode,
  type IpcErrorMessage,
  type IpcIntentMessage,
  type IpcIntentName,
  type IpcMessage,
  type IpcMessageToWorker,
  type IpcNonceIssuedMessage,
  type IpcNonceRequestMessage,
  type IpcNotifyMessage,
  type IpcPairingChallengeMessage,
  type IpcPairingOwnerMessage,
  type IpcPairingSuccessMessage,
  type IpcParseResult,
  type IpcStateMessage,
} from '../contracts/ipc.ts'
import { PLUGIN_NAME } from '../errors.ts'
import type { GuardLogger } from '../logging/logger.ts'
import { redact } from '../logging/redact.ts'

/* ========================================================================== */
/* Limites                                                                    */
/* ========================================================================== */

/**
 * Teto de UMA linha. Acima disto a linha e cortada e o analisador RESSINCRONIZA
 * no `\n` seguinte.
 *
 * PORQUE EXISTE: sem teto, uma ponta que escreve bytes e nunca escreve `\n`
 * (defeito, ou outra coisa qualquer no lugar do worker) faz o acumulador crescer
 * ate o host ficar sem memoria. E a imagem ao espelho do `stderr` sem leitor que
 * a Onda 3 mediu: ali congelava o FILHO, aqui morria o PAI. 64 KiB e ~16x a
 * maior mensagem legal (um `error` com 4096 carateres).
 */
export const IPC_MAX_LINE_BYTES = 64 * 1024

/**
 * Teto do que pode ficar POR ESCREVER no `stdin` do filho.
 *
 * MEDIDO (`test/integration/proc/ipc-backpressure.test.ts`): um worker que para
 * de ler NAO bloqueia o host — `Writable.write()` sobre um pipe e assincrono e
 * devolve `false`; o que cresce sem limite e a fila INTERNA do stream. Crescer
 * ali ate ao OOM seria um plugin que mata o DSH inteiro por causa de um filho
 * preguicoso. Acima deste teto a mensagem e DESCARTADA com aviso: perder uma
 * difusao de estado e recuperavel (a proxima traz `seq` novo), perder o processo
 * hospedeiro nao e.
 */
export const IPC_MAX_PENDING_BYTES = 256 * 1024

/**
 * Teto DURO: acima dele o canal declara-se INVIAVEL.
 *
 * PORQUE UM SEGUNDO TETO. O primeiro governa so as difusoes de `state`, porque
 * so elas podem ser coalescidas sem violar o contrato -- `ack` e `error` sao "a
 * unica resposta que aquele `requestId` vai ter" e escrevem sempre. Mas "sempre"
 * sem limite nenhum reabre exatamente o OOM que o primeiro teto fechou: um filho
 * que nunca le e continua a mandar intencoes faz crescer a fila um `ack` de cada
 * vez.
 *
 * Este teto nao descarta em silencio: ele torna a condicao TERMINAL e
 * OBSERVAVEL (`log.error` uma vez + `stats.overwhelmed`), que e a mesma forma
 * que `../proc/retry.ts` usa para o orcamento esgotado -- e pela mesma razao,
 * "continuar a tentar contra uma coisa que nao esta a responder nao e
 * resiliencia, e ruido".
 *
 * 4 MiB = 16x o teto suave: e preciso que o worker esteja MESMO parado.
 */
export const IPC_OVERWHELMED_BYTES = 4 * 1024 * 1024

/** Teto da `message` de um `error`: e o limite de um texto do Telegram. */
const MAX_MESSAGE_CHARS = 4096
/** Teto de um identificador opaco (um ULID tem 26; a folga evita fragilidade). */
const MAX_ID_CHARS = 64
/** Teto do `nonce` em transito. NAO e validacao de nonce (S5): e higiene de transporte. */
const MAX_NONCE_CHARS = 128
/** Teto da URL do tunel. */
const MAX_URL_CHARS = 2048

/* ========================================================================== */
/* Erro tipado                                                                */
/* ========================================================================== */

/**
 * Codigos estaveis do canal.
 *
 * VIVEM AQUI e nao em `src/errors.ts` por fronteira de onda: `GuardErrorCode` e
 * uma uniao partilhada e quatro sub-tarefas escrevem em paralelo nesta onda. A
 * FORMA e a de `GuardError` (nome, `code`, mensagem prefixada pelo plugin), que
 * e o que `05-QUALIDADE-CODIGO.md` 6.1 exige.
 */
export type IpcChannelErrorCode =
  /** A mensagem nao respeita o contrato (ex.: `url` fora de `READY`). */
  | 'IPC_MESSAGE_INVALID'
  /** `JSON.stringify` recusou o valor (ciclo, `BigInt`). */
  | 'IPC_SERIALIZE_FAILED'

export class IpcChannelError extends Error {
  override readonly name = 'IpcChannelError'
  readonly code: IpcChannelErrorCode

  // Campo a mao, nao "parameter property": `node --test` corre `.ts` em
  // strip-only mode e essa sintaxe emite codigo.
  constructor(code: IpcChannelErrorCode, detail: string) {
    super(`[${PLUGIN_NAME}] ${code}: ${detail}`)
    this.code = code
  }
}

/* ========================================================================== */
/* Vocabularios FECHADOS                                                      */
/* ========================================================================== */

const STATES: readonly IpcStateMessage['state'][] = [
  'STOPPED',
  'STARTING',
  'READY',
  'DEGRADED',
  'STOPPING',
  'FAILED',
]
const RESULTS: readonly IpcAckMessage['result'][] = ['accepted', 'noop', 'rejected']
const ERROR_CODES: readonly IpcErrorCode[] = [
  'SHUTDOWN_IN_PROGRESS',
  'EXPOSURE_DISABLED',
  'RESTRICTED_MODE',
  'PROBE_FAILED',
  'TUNNEL_FAILED',
  'NOT_PAIRED',
  'NONCE_INVALID',
  'RATE_LIMITED',
  'INTERNAL',
]
const INTENTS: readonly IpcIntentName[] = [
  'tunnel.up',
  'tunnel.down',
  'tunnel.status',
  'session.issue',
  'secret.rotate',
  'emergency',
]

/**
 * As acoes de controlo (EMENDA-COSTURA-5): vocabulario do campo `acao` de
 * `nonce.request`/`nonce.issued`. Espelha `ControlAction` de
 * `src/contracts/control.ts` (frozen no PREP 5).
 */
const ACTIONS: readonly ControlAction[] = ['start', 'stop', 'reset']

/**
 * Que tipos sao legais em CADA SENTIDO. Sao chaves de {@link HANDLERS} e nada
 * mais: acrescentar um tipo e acrescenta-lo aqui, ao sentido em que ele viaja.
 * Um `state` a chegar ao HOST e violacao de protocolo, nao mensagem futura.
 *
 * EMENDA-COSTURA-5: `nonce.request` viaja worker -> host; `nonce.issued`
 * host -> worker.
 */
const LEGAL_TYPES: Readonly<Record<IpcDirection, readonly string[]>> = {
  'to-host': ['intent', 'nonce.request', 'pairing.success'],
  'to-worker': ['state', 'ack', 'error', 'notify', 'pairing.challenge', 'nonce.issued', 'pairing.owner'],
}

/** Sentido em que a linha viaja. `to-host` = o que o worker pode enviar. */
export type IpcDirection = 'to-host' | 'to-worker'

/** As razoes de recusa, extraidas do contrato para poderem ser nomeadas. */
export type IpcParseFailureReason = Extract<IpcParseResult, { ok: false }>['reason']

/* ========================================================================== */
/* Predicados                                                                 */
/* ========================================================================== */

/**
 * Ha carater de controlo? Varrimento por CODIGO e nao regex: a regra
 * `no-control-regex` recusa a classe `[\\u0000-\\u001F\\u007F]` mesmo escapada, e
 * suprimi-la aqui seria esconder a unica coisa que este predicado faz.
 *
 * PORQUE IMPORTA: um `\n` cru dentro de um campo partia o enquadramento de
 * linha (S1) se alguma vez ele escapasse ao `JSON.stringify`, e um `\r` ou um
 * `\u0007` a caminho de uma mensagem do Telegram e ruido de terminal a viajar
 * para fora da maquina.
 */
function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function fail(reason: IpcParseFailureReason): IpcParseResult {
  return { ok: false, reason }
}

function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

/** Texto de UMA linha: nao vazio, dentro do teto e sem carateres de controlo. */
function isCleanText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    !hasControlChar(value)
  )
}

/**
 * Texto MOSTRADO ao dono (`IpcErrorMessage.message`).
 *
 * Aqui o `\n` E legitimo — uma mensagem de erro para o Telegram pode ter mais
 * de uma linha, e o `JSON.stringify` escapa-o, pelo que S1 continua de pe: a
 * quebra viaja como `\\n` e nao parte o enquadramento. O que continua PROIBIDO e
 * todo o resto: `\r`, `\u0000`, e as sequencias de escape de terminal que um
 * texto vindo do outro lado do pipe poderia levar para dentro do log.
 */
function isDisplayText(value: unknown, maxChars: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x0a) continue
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Ids do Telegram sao INTEIROS. Um `from` fracionario nao designa ninguem. */
function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * sha256 em hex, 64 caracteres. Usado pelo `pairing.challenge` (S3-b): o
 * digest e o campo mais sensivel do contrato — espaco 10^6 reversivel em
 * milissegundos — e aceitar outra forma aqui seria aceitar lixo que um
 * codigo mau poderia querer esconder atras de um "digest" falso.
 */
function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/* ========================================================================== */
/* Validacao / reconstrucao                                                   */
/* ========================================================================== */

/**
 * Tratador de UM tipo: valida a forma e devolve a mensagem RECONSTRUIDA.
 * NUNCA lanca -- o veredito e sempre o valor de retorno (S4).
 */
type IpcTypeHandler = (bag: Record<string, unknown>) => IpcParseResult

/**
 * ===========================================================================
 * O VOCABULARIO E DADO, NAO ESTRUTURA: uma TABELA `type -> tratador`.
 * ===========================================================================
 * Nao ha `switch` nem cadeia de `if` a despachar por `type` em lado nenhum
 * deste ficheiro, e isso e deliberado.
 *
 * PORQUE: `src/contracts/ipc.ts` esta congelado com QUATRO tipos, e ja se sabe
 * que vai crescer -- o COMMIT PREP 5 acrescenta-lhe `notify` e (registado pela
 * revisao de T4.4) uma mensagem de PAREAMENTO, porque o codigo de pareamento e
 * gerado no host e verificado no worker e hoje NAO TEM POR ONDE ATRAVESSAR o
 * canal. Acrescentar um quinto tipo daqui a duas ondas tem de ser UMA ENTRADA
 * NESTA TABELA mais o seu validador, e nada mais: nem uma linha de despacho a
 * editar, nem um `switch` esquecido no outro lado do canal.
 *
 * E O DESCONHECIDO JA TEM COMPORTAMENTO CERTO, dado por S4: um `type` que a
 * tabela nao conhece devolve `{ ok: false, reason: 'tipo-desconhecido' }` e o
 * canal SOBREVIVE. Isso e o que faz uma ponta ANTIGA a receber uma mensagem
 * NOVA degradar em silencio em vez de partir -- e host e worker PODEM estar em
 * versoes diferentes: durante um reinicio do plugin, o processo filho vivo
 * ainda e o do binario anterior.
 *
 * A tabela e a fonte unica do vocabulario; {@link LEGAL_TYPES} diz apenas QUAL
 * DELES e legal em cada sentido.
 */
const HANDLERS: Readonly<Record<string, IpcTypeHandler>> = {
  intent: buildIntent,
  state: buildState,
  ack: buildAck,
  error: buildError,
  notify: buildNotify,
  'pairing.challenge': buildPairingChallenge,
  'nonce.request': buildNonceRequest,
  'nonce.issued': buildNonceIssued,
  'pairing.owner': buildPairingOwner,
  'pairing.success': buildPairingSuccess,
}

/**
 * Valida um valor ja desserializado e RECONSTROI a mensagem.
 *
 * >>> RECONSTROI, e e isso o controlo. <<< O que sai daqui e um objeto NOVO com
 * exatamente os campos do contrato: um campo a mais na linha (injetado por quem
 * escreve do outro lado) nao chega ao consumidor, e um `"__proto__"` vindo do
 * `JSON.parse` fica no objeto descartado em vez de viajar para dentro do host.
 */
export function validateIpcMessage(value: unknown, direction: IpcDirection): IpcParseResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('forma-invalida')
  }

  const bag = value as Record<string, unknown>

  // A VERSAO PRIMEIRO: o envelope decide antes do conteudo, e uma versao
  // desconhecida nao autoriza sequer a ler o `type`.
  if (bag['v'] !== IPC_PROTOCOL_VERSION) return fail('versao-desconhecida')

  const type = bag['type']
  if (typeof type !== 'string') return fail('tipo-desconhecido')

  /**
   * DUAS CONDICOES, UM SO VEREDITO: o tipo tem de existir na tabela E ser legal
   * NESTE SENTIDO. Um `state` a chegar ao HOST e violacao de protocolo tanto
   * quanto um `type` inventado, e ambos caem em S4 -- descartar e seguir.
   */
  const handler = LEGAL_TYPES[direction].includes(type) ? HANDLERS[type] : undefined
  if (handler === undefined) return fail('tipo-desconhecido')

  return handler(bag)
}

function buildIntent(bag: Record<string, unknown>): IpcParseResult {
  const { intent, requestId, from, chat, nonce } = bag
  if (!isMember(INTENTS, intent)) return fail('forma-invalida')
  if (!isCleanText(requestId, MAX_ID_CHARS)) return fail('forma-invalida')
  if (!isId(from) || !isId(chat)) return fail('forma-invalida')
  if (nonce !== undefined && !isCleanText(nonce, MAX_NONCE_CHARS)) return fail('forma-invalida')

  // S5: o `nonce` viaja OPACO. Nada aqui o interpreta -- quem o emite e consome
  // e o HOST (`src/control/confirm.ts`), e o worker so o transporta.
  const message: IpcIntentMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'intent',
    intent,
    requestId,
    from,
    chat,
    ...(nonce === undefined ? {} : { nonce }),
  }
  return { ok: true, message }
}

function buildState(bag: Record<string, unknown>): IpcParseResult {
  const { state, seq, url, expiresAt } = bag
  if (!isMember(STATES, state)) return fail('forma-invalida')
  if (!isFiniteNumber(seq)) return fail('forma-invalida')

  /**
   * `url` e `expiresAt` presentes SSE `state === 'READY'` — e o "so se" e o que
   * importa: e ele que torna IMPOSSIVEL divulgar a URL a partir de `STARTING` ou
   * `DEGRADED`, pela mesma razao que `TunnelSnapshot.info` o faz.
   */
  const pronto = state === 'READY'
  if (pronto !== (url !== undefined) || pronto !== (expiresAt !== undefined)) {
    return fail('forma-invalida')
  }
  if (!pronto) {
    return { ok: true, message: { v: IPC_PROTOCOL_VERSION, type: 'state', state, seq } }
  }
  // `https://` obrigatorio: a URL acaba numa mensagem do Telegram, e um esquema
  // arbitrario vindo do outro lado do pipe nao vai ser renderizado ao dono.
  if (!isCleanText(url, MAX_URL_CHARS) || !url.startsWith('https://')) return fail('forma-invalida')
  if (!isFiniteNumber(expiresAt)) return fail('forma-invalida')

  const message: IpcStateMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'state',
    state,
    seq,
    url,
    expiresAt,
  }
  return { ok: true, message }
}

function buildAck(bag: Record<string, unknown>): IpcParseResult {
  const { requestId, result, state, code } = bag
  if (!isCleanText(requestId, MAX_ID_CHARS)) return fail('forma-invalida')
  if (!isMember(RESULTS, result)) return fail('forma-invalida')
  if (!isMember(STATES, state)) return fail('forma-invalida')

  // `code` presente SSE `result === 'rejected'`: um `accepted` com codigo de erro
  // e uma contradicao, e o worker renderiza texto POR CODIGO.
  const recusado = result === 'rejected'
  if (recusado !== (code !== undefined)) return fail('forma-invalida')
  if (!recusado) {
    return { ok: true, message: { v: IPC_PROTOCOL_VERSION, type: 'ack', requestId, result, state } }
  }
  if (!isMember(ERROR_CODES, code)) return fail('forma-invalida')

  const message: IpcAckMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'ack',
    requestId,
    result,
    state,
    code,
  }
  return { ok: true, message }
}

function buildError(bag: Record<string, unknown>): IpcParseResult {
  const { requestId, code, message: text } = bag
  if (!isMember(ERROR_CODES, code)) return fail('forma-invalida')
  if (!isDisplayText(text, MAX_MESSAGE_CHARS)) return fail('forma-invalida')
  if (requestId !== undefined && !isCleanText(requestId, MAX_ID_CHARS)) {
    return fail('forma-invalida')
  }

  const message: IpcErrorMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'error',
    code,
    message: text,
    ...(requestId === undefined ? {} : { requestId }),
  }
  return { ok: true, message }
}

/**
 * `notify` (host -> worker): texto proativo composto por T5.4, renderizado
 * por T5.2. O `\n` e legitimo (mensagem de varias linhas); controlo nao.
 * Limite: o proprio limite de mensagem do Telegram.
 */
function buildNotify(bag: Record<string, unknown>): IpcParseResult {
  const { texto } = bag
  if (!isDisplayText(texto, MAX_MESSAGE_CHARS)) return fail('forma-invalida')

  const message: IpcNotifyMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'notify',
    texto,
  }
  return { ok: true, message }
}

/**
 * `pairing.challenge` (host -> worker): o desafio de pareamento COMO DIGEST,
 * nunca o codigo em claro. O digest e sha256 hex de 64 caracteres (S3-b:
 * NUNCA em log, NUNCA para o Telegram).
 */
function buildPairingChallenge(bag: Record<string, unknown>): IpcParseResult {
  const { digest, expiresAt } = bag
  if (!isSha256Hex(digest)) return fail('forma-invalida')
  if (!isFiniteNumber(expiresAt)) return fail('forma-invalida')

  const message: IpcPairingChallengeMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'pairing.challenge',
    digest,
    expiresAt,
  }
  return { ok: true, message }
}

/**
 * `nonce.request` (EMENDA-COSTURA-5, worker -> host): o worker pede um nonce
 * para a acao de controlo. O `acao` tem de ser uma `ControlAction` real — um
 * valor inventado nao designa nenhuma acao do contrato (PREP 5).
 */
function buildNonceRequest(bag: Record<string, unknown>): IpcParseResult {
  const { acao, requestId } = bag
  if (!isMember(ACTIONS, acao)) return fail('forma-invalida')
  if (!isCleanText(requestId, MAX_ID_CHARS)) return fail('forma-invalida')

  const message: IpcNonceRequestMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'nonce.request',
    acao,
    requestId,
  }
  return { ok: true, message }
}

/**
 * `nonce.issued` (EMENDA-COSTURA-5, host -> worker): o nonce emitido pelo
 * `ConfirmService` do host. O `nonce` e OPACO (S5) e o worker so o
 * transporta; o teto de transporte e o mesmo do campo `nonce` do intent.
 * `expiresAt` tem de ser um numero finito (o prazo do nonce).
 */
function buildNonceIssued(bag: Record<string, unknown>): IpcParseResult {
  const { acao, requestId, nonce, expiresAt } = bag
  if (!isMember(ACTIONS, acao)) return fail('forma-invalida')
  if (!isCleanText(requestId, MAX_ID_CHARS)) return fail('forma-invalida')
  if (!isCleanText(nonce, MAX_NONCE_CHARS)) return fail('forma-invalida')
  if (!isFiniteNumber(expiresAt)) return fail('forma-invalida')

  const message: IpcNonceIssuedMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'nonce.issued',
    acao,
    requestId,
    nonce,
    expiresAt,
  }
  return { ok: true, message }
}

/**
 * `pairing.owner` (EMENDA-COSTURA-5, host -> worker): o dono persistido no
 * boot. Os DOIS EIXOS sao inteiros (a mesma regra do `from`/`chat` do intent)
 * e `pairedAt` e um epoch finito.
 */
function buildPairingOwner(bag: Record<string, unknown>): IpcParseResult {
  const { from, chat, pairedAt } = bag
  if (!isId(from) || !isId(chat)) return fail('forma-invalida')
  if (!isFiniteNumber(pairedAt)) return fail('forma-invalida')

  const message: IpcPairingOwnerMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'pairing.owner',
    from,
    chat,
    pairedAt,
  }
  return { ok: true, message }
}

/**
 * `pairing.success` (EMENDA ONDA-1-PAREAR-VIA-PAINEL, worker -> host): o
 * pareamento concluido NO WORKER. Os DOIS EIXOS sao inteiros (como `pairing.owner`)
 * e `pairedAt` e um epoch finito. O reply do host a esta mensagem e `pairing.owner`,
 * que fecha o handshake e liberta a allowlist no ato.
 */
function buildPairingSuccess(bag: Record<string, unknown>): IpcParseResult {
  const { from, chat, pairedAt } = bag
  if (!isId(from) || !isId(chat)) return fail('forma-invalida')
  if (!isFiniteNumber(pairedAt)) return fail('forma-invalida')

  const message: IpcPairingSuccessMessage = {
    v: IPC_PROTOCOL_VERSION,
    type: 'pairing.success',
    from,
    chat,
    pairedAt,
  }
  return { ok: true, message }
}

/* ========================================================================== */
/* CODEC                                                                      */
/* ========================================================================== */

/**
 * Le UMA linha (ja sem o `\n`). NUNCA lanca (S4): o veredito e o retorno.
 */
export function parseIpcLine(line: string, direction: IpcDirection): IpcParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
    // Excecao MITIGADA e convertida em veredito -- ver o cabecalho. O selector de
    // `no-restricted-syntax` conta statements e nao ve comentarios.
  } catch {
    return fail('json-invalido')
  }
  return validateIpcMessage(parsed, direction)
}

/**
 * Escreve UMA linha: JSON compacto + `\n` (S1).
 *
 * LANCA quando a mensagem viola o contrato, e e deliberado — do lado da ESCRITA
 * um erro e defeito nosso, e `createHostIpcChannel` converte-o em `log.error` +
 * `false`. Deixar passar uma mensagem invalida seria entregar ao worker
 * exatamente o ruido que S2 existe para impedir.
 *
 * `JSON.stringify` escapa `\n` e `\r` DENTRO de qualquer string, pelo que o
 * enquadramento nao pode ser partido por conteudo. A guarda final confirma-o em
 * vez de o assumir.
 */
export function serializeIpcMessage(message: IpcMessage, direction: IpcDirection): string {
  const verdict = validateIpcMessage(message, direction)
  if (!verdict.ok) {
    const tipo = String((message as { type?: unknown }).type)
    throw new IpcChannelError(
      'IPC_MESSAGE_INVALID',
      `mensagem '${tipo}' recusada pelo contrato (${verdict.reason}).`,
    )
  }

  let line: string
  try {
    line = JSON.stringify(verdict.message)
  } catch (error) {
    throw new IpcChannelError(
      'IPC_SERIALIZE_FAILED',
      error instanceof Error ? error.message : String(error),
    )
  }

  if (line.includes('\n') || line.includes('\r')) {
    throw new IpcChannelError('IPC_MESSAGE_INVALID', 'a linha serializada contem uma quebra.')
  }
  return `${line}\n`
}

/* ========================================================================== */
/* FRAMING -- o acumulador                                                    */
/* ========================================================================== */

export interface IpcLineDecoder {
  /** Consome um chunk e devolve o veredito de CADA linha que ele fechou. */
  push(chunk: Buffer | string): readonly IpcParseResult[]
  /** Bytes retidos a espera do `\n` (observabilidade). */
  readonly pending: number
}

/**
 * Acumulador de linhas sobre um fluxo de chunks.
 *
 * DUAS COISAS QUE UM `chunk.toString().split('\n')` INGENUO ERRA:
 *
 *   1. UMA LINHA PARTIDA ENTRE DOIS `data`. O `stdout` de um filho e um pipe e o
 *      SO parte onde quiser. Sem acumulador, metade das mensagens vira
 *      `json-invalido` sob carga — e de forma INTERMITENTE, que e o pior modo de
 *      falha possivel.
 *   2. UM CARATER UTF-8 PARTIDO ENTRE DOIS `data`. `Buffer.toString()` sobre
 *      metade de uma sequencia multibyte produz U+FFFD e corrompe a linha; o
 *      `StringDecoder` retem o resto da sequencia ate ela fechar (S1 diz UTF-8).
 */
export function createIpcLineDecoder(options: {
  readonly direction: IpcDirection
  readonly maxLineBytes?: number | undefined
}): IpcLineDecoder {
  const { direction } = options
  const maxLineBytes = options.maxLineBytes ?? IPC_MAX_LINE_BYTES
  const utf8 = new StringDecoder('utf8')
  let buffer = ''
  /** `true` depois de cortar uma linha gigante: descarta ate ao `\n` seguinte. */
  let resyncing = false

  return {
    get pending(): number {
      return Buffer.byteLength(buffer, 'utf8')
    },
    push(chunk: Buffer | string): readonly IpcParseResult[] {
      buffer += typeof chunk === 'string' ? chunk : utf8.write(chunk)
      const results: IpcParseResult[] = []

      let cut = buffer.indexOf('\n')
      while (cut !== -1) {
        const line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 1)

        if (resyncing) {
          // Cauda da linha cortada: ja foi reportada uma vez, e reportar a cauda
          // outra vez transformava um erro em N.
          resyncing = false
        } else if (line.trim() !== '') {
          // Linha em branco nao carrega mensagem e nao e violacao (um `\n` extra
          // no fim de um fluxo e normal). Silencio deliberado.
          results.push(parseIpcLine(line, direction))
        }
        cut = buffer.indexOf('\n')
      }

      if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
        buffer = ''
        if (!resyncing) {
          resyncing = true
          results.push(fail('forma-invalida'))
        }
      }
      return results
    },
  }
}

/* ========================================================================== */
/* CANAL                                                                      */
/* ========================================================================== */

export interface HostIpcChannelOptions {
  /** `stdout` do filho: EXCLUSIVAMENTE JSONL (S2). */
  readonly input: Readable | undefined
  /** `stdin` do filho. Ausente = o `stdio` regrediu para `'ignore'`. */
  readonly output: Writable | undefined
  readonly log: GuardLogger
  /**
   * Decide UMA intencao e devolve a resposta a enviar.
   *
   * SINCRONO e obrigatorio, e os dois adjetivos sao contrato:
   *
   *   - OBRIGATORIO porque o contrato diz que o `ack` e "sempre emitido —
   *     inclusive nos caminhos de erro"; sem ele o cliente do Telegram fica com
   *     a barra de progresso eterna e o dono nao sabe se o comando chegou.
   *     Devolver a resposta (em vez de a mandar por um `send` opcional) poe essa
   *     obrigacao no TIPO.
   *   - SINCRONO por Q-5: o trabalho lento (subir tunel, sondar) responde
   *     `accepted` JA e difunde o resto depois por {@link HostIpcChannel.send}.
   */
  readonly onIntent: (intent: IpcIntentMessage) => IpcMessageToWorker
  /**
   * Decide UM pedido de nonce (EMENDA-COSTURA-5) e devolve a resposta.
   *
   * AUSENTE, o canal responde `error INTERNAL` ao pedido — fail-closed: um
   * nonce que nao chega ao worker nao autoriza nada (CTL-023). Em producao a
   * fiacao (`src/index.ts`) liga-o ao `ConfirmService` de T5.1 via
   * `criarRespondedorDeNonce`; o nonce NUNCA e logado (S3).
   */
  readonly onNonceRequest?: ((request: IpcNonceRequestMessage) => IpcMessageToWorker) | undefined
  /**
   * Decide UM `pairing.success` (EMENDA ONDA-1-PAREAR-VIA-PAINEL) e devolve a
   * resposta — tipicamente `pairing.owner`, que fecha o handshake e liberta a
   * allowlist no ato (a costura tambem grava o dono no `state.json`).
   *
   * AUSENTE, o canal responde `error INTERNAL` ao aviso — o pareamento ainda
   * fica valido no worker (ele ja autorizou), mas o host nao aprende o dono e
   * a allowlist nao liberta ate reiniciar. Fail-closed: o host NUNCA persiste
   * um dono que nao confirmou.
   */
  readonly onPairingSuccess?: ((msg: IpcPairingSuccessMessage) => IpcMessageToWorker) | undefined
  /**
   * Segredos a mascarar em TUDO o que este canal escreve no log.
   *
   * >>> FORNECEDOR, avaliado a cada linha -- nao uma lista capturada aqui. <<<
   * E a mesma superficie de `SupervisedProcess.secrets` e pela mesma razao: o
   * conjunto muda depois do arranque.
   *
   * PORQUE E OBRIGATORIO E NAO OPCIONAL. Este canal regista `error.message` de
   * codigo de TERCEIROS -- o decisor de intencoes, o serializador, o absorvedor
   * de `'error'` do stream. A API do Telegram poe o token DENTRO do caminho do
   * URL, pelo que um `ECONNRESET em https://api.telegram.org/bot<n>:<token>/...`
   * escapa por qualquer `throw` que passe por aqui.
   *
   * A ASSIMETRIA QUE ISTO FECHA: `attachStreamLogging` ja aplicava `redact()` a
   * cada linha de `stderr` do FILHO. O mesmo token impresso pelo HOST ficava em
   * claro. Um campo opcional com valor por omissao reproduziria o buraco no
   * primeiro chamador que se esquecesse dele; obrigatorio, o `tsc` recusa.
   */
  readonly secrets: () => readonly string[]
  readonly maxLineBytes?: number | undefined
  readonly maxPendingBytes?: number | undefined
  /** Teto DURO. Ver {@link IPC_OVERWHELMED_BYTES}. */
  readonly overwhelmedBytes?: number | undefined
}

/**
 * Resposta do canal quando NENHUM tratador de nonce esta montado (EMENDA-
 * COSTURA-5). Fail-closed e visivel: um `error INTERNAL` a pedido de nonce —
 * sem nonce nao ha confirmacao, e sem confirmacao nao ha intent que aumente
 * exposicao (CTL-023). O `requestId` e o do pedido, para o worker correlacionar.
 */
function responderSemNonce(pedido: IpcNonceRequestMessage): IpcMessageToWorker {
  return {
    v: IPC_PROTOCOL_VERSION,
    type: 'error',
    requestId: pedido.requestId,
    code: 'INTERNAL',
    message: 'Nao foi possivel processar o pedido. Tente novamente.',
  }
}

/**
 * Resposta do canal quando NENHUM tratador de `pairing.success` esta montado
 * (EMENDA ONDA-1-PAREAR-VIA-PAINEL). Fail-closed e visivel: um `error INTERNAL`
 * — o host NAO persiste um dono que nao confirmou, e o worker continua com o
 * pareamento valido na sua sessao ate reiniciar.
 */
function responderSemPairing(): IpcMessageToWorker {
  return {
    v: IPC_PROTOCOL_VERSION,
    type: 'error',
    code: 'INTERNAL',
    message: 'O pareamento nao foi gravado. Reinicie o plugin e tente de novo.',
  }
}

export interface HostIpcChannel {
  /**
   * Envia host -> worker.
   *
   * `false` significa "nao vai ser entregue": canal ausente, mensagem invalida,
   * ou canal declarado INVIAVEL. Uma difusao de `state` COALESCIDA devolve
   * `true` -- ela vai ser entregue, so que a proxima substitui-a.
   */
  send(message: IpcMessageToWorker): boolean
  /** Desarme SINCRONO e IDEMPOTENTE: 3 chamadas = 1 desarme. */
  dispose(): void
  readonly stats: IpcChannelStats
}

export interface IpcChannelStats {
  readonly sent: number
  readonly dropped: number
  readonly received: number
  readonly malformed: number
  /** Difusoes de `state` substituidas por uma mais recente (nunca `ack`/`error`). */
  readonly coalesced: number
  /** `true` depois de o teto DURO ser ultrapassado: estado observavel, nao silencio. */
  readonly overwhelmed: boolean
}

/**
 * Liga o codec aos pipes do filho.
 *
 * NAO E ELE QUE MATA O PROCESSO. O ciclo de vida (abort, tree-kill, orcamento) e
 * do supervisor; este objeto so fala e ouve. Um segundo dono do kill seria a
 * forma mais rapida de partir a garantia LIFO do disposer.
 *
 * ---------------------------------------------------------------------------
 * A POLITICA DE SATURACAO, E PORQUE ELA NAO PODE SER UMA SO
 * ---------------------------------------------------------------------------
 * Um teto unico que descartasse tudo por igual estaria a violar o contrato. Ele
 * diz de `IpcAckMessage`: *"Sempre emitida -- inclusive nos caminhos de erro.
 * Sem `ack`, o cliente do Telegram fica com a barra de progresso eterna, e o
 * dono nao sabe se o comando chegou."*
 *
 * E a justificacao de descartar -- "perde-se uma difusao, a proxima traz `seq`
 * novo" -- so vale para `state`. Para um `ack` NAO EXISTE "a proxima": ele e a
 * unica resposta que aquele `requestId` vai ter. Descarta-lo significa
 * `/emergencia` a executar no host e o dono a nunca saber, exatamente no estado
 * degradado para o qual o teto existe.
 *
 * Por isso ha TRES regimes, e nenhum deles e silencioso:
 *
 *   1. `state` acima do teto SUAVE -> COALESCE. Nao se descarta a mais recente:
 *      guarda-se, e a difusao seguinte substitui-a. `state` e idempotente por
 *      construcao (o worker e uma PROJECCAO e ja descarta `seq` fora de ordem),
 *      pelo que entregar so a ultima e a entrega CERTA, nao uma degradacao.
 *   2. `ack` e `error` -> ESCREVEM SEMPRE. Nao ha teto suave para eles.
 *   3. Acima do teto DURO -> o canal declara-se INVIAVEL. Deixar `ack`/`error`
 *      crescerem sem limite nenhum reabria o OOM que mediu o teto em primeiro
 *      lugar (um filho que nunca le e continua a mandar intencoes). O que se faz
 *      nao e calar: e `log.error` uma vez, `stats.overwhelmed` a `true`, e
 *      `send` a devolver `false` -- um estado TERMINAL OBSERVAVEL, na mesma
 *      forma que `./retry.ts` usa para o orcamento esgotado.
 */
export function createHostIpcChannel(options: HostIpcChannelOptions): HostIpcChannel {
  const { input, output, log, onIntent, onNonceRequest, onPairingSuccess, secrets } = options
  const maxPendingBytes = options.maxPendingBytes ?? IPC_MAX_PENDING_BYTES
  const overwhelmedBytes = options.overwhelmedBytes ?? IPC_OVERWHELMED_BYTES
  const decoder = createIpcLineDecoder({
    direction: 'to-host',
    maxLineBytes: options.maxLineBytes,
  })

  let sent = 0
  let dropped = 0
  let received = 0
  let malformed = 0
  let coalesced = 0
  let overwhelmed = false
  let disposed = false

  /** A difusao de `state` a espera de espaco. NO MAXIMO UMA -- e esse o ponto. */
  let difusaoPendente: string | undefined
  /** Ja ha um `'drain'` a espera? Sem isto empilhavam-se milhares de ouvintes. */
  let drenoArmado = false
  /** Estamos DENTRO de um episodio de saturacao? Governa o log (uma linha, nao N). */
  let saturado = false

  /** Mascara TUDO o que va para o log. Ver `HostIpcChannelOptions.secrets`. */
  const limpar = (texto: string): string => redact(texto, secrets())
  const descrever = (error: unknown): string =>
    limpar(error instanceof Error ? error.message : String(error))

  if (output === undefined) {
    // Nao ha caminho que "deixe passar": sem `stdin` o sentido host->worker
    // simplesmente nao existe, e isso e um defeito de composicao que tem de ser
    // gritado uma vez, ao ligar, e nao descoberto num `/ligar` de madrugada.
    log.error(
      'Canal IPC SEM sentido host->worker: o filho nao tem `stdin`. ' +
        "Verifique que o `stdio` do spec declara `stdin: 'pipe'`.",
    )
  }

  const porEscrever = (): number => output?.writableLength ?? 0

  /** Escreve JA. Nao consulta teto nenhum -- quem chama e que decidiu. */
  const escrever = (line: string): void => {
    output?.write(line)
    sent += 1
  }

  /**
   * Entra em estado terminal. UMA vez, e ruidosa: um limite silencioso e um
   * defeito por descobrir.
   */
  const declararInviavel = (): void => {
    if (overwhelmed) return
    overwhelmed = true
    log.error(
      `Canal IPC INVIAVEL: ${String(porEscrever())} bytes por escrever ultrapassam o teto ` +
        `duro de ${String(overwhelmedBytes)}. O worker nao le ha demasiado tempo; ` +
        'nenhuma mensagem sera entregue ate ele ser reiniciado.',
    )
  }

  const armarDreno = (): void => {
    if (drenoArmado || output === undefined) return
    drenoArmado = true
    output.once('drain', (): void => {
      drenoArmado = false
      esvaziar()
    })
  }

  /** Entrega a difusao retida, se ja houver espaco. */
  const esvaziar = (): void => {
    if (difusaoPendente === undefined || disposed || overwhelmed) return
    if (output === undefined || !output.writable) return
    if (porEscrever() > maxPendingBytes) {
      armarDreno()
      return
    }
    const line = difusaoPendente
    difusaoPendente = undefined
    escrever(line)

    if (saturado) {
      saturado = false
      // F6: o fim do episodio e UMA linha com o TOTAL, e nao N linhas iguais.
      log.info(
        `Canal IPC drenou; ${String(coalesced)} difusoes de estado foram coalescidas ` +
          'enquanto o worker nao lia (nenhum `ack` ou `error` foi perdido).',
      )
    }
  }

  const send = (message: IpcMessageToWorker): boolean => {
    if (disposed || overwhelmed || output === undefined || !output.writable) {
      dropped += 1
      return false
    }

    let line: string
    try {
      line = serializeIpcMessage(message, 'to-worker')
      // Excecao NAO engolida: e registada com o codigo estavel e vira `false`.
    } catch (error) {
      dropped += 1
      log.error(`Mensagem IPC recusada antes de sair: ${descrever(error)}`)
      return false
    }

    // Teto DURO primeiro: acima dele nem o `ack` sai, porque nao ha para onde.
    if (porEscrever() > overwhelmedBytes) {
      declararInviavel()
      difusaoPendente = undefined
      dropped += 1
      return false
    }

    /**
     * `ack` e `error` NUNCA sao retidos nem descartados pelo teto suave. Sao a
     * resposta a uma intencao concreta e nao tem "a proxima".
     */
    if (message.type !== 'state') {
      escrever(line)
      return true
    }

    if (porEscrever() > maxPendingBytes) {
      if (!saturado) {
        saturado = true
        // F6: UMA linha por EPISODIO de saturacao. A versao anterior emitia uma
        // por mensagem -- medido, 14 771 linhas (~1,6 MB) num so burst, que e
        // trocar um problema de memoria por um problema de log.
        log.warn(
          `Canal IPC saturado (${String(porEscrever())} bytes por escrever): o worker parou ` +
            'de ler. As difusoes de estado passam a COALESCER; `ack` e `error` continuam a sair.',
        )
      }
      if (difusaoPendente !== undefined) coalesced += 1
      difusaoPendente = line
      armarDreno()
      // `true`: a difusao VAI ser entregue -- so que substituida pela seguinte,
      // que e o comportamento certo para uma projeccao com `seq` monotonico.
      return true
    }

    escrever(line)
    return true
  }

  const onData = (chunk: Buffer): void => {
    for (const verdict of decoder.push(chunk)) {
      if (!verdict.ok) {
        // S4: regista e SEGUE. Nunca derrubar o canal.
        malformed += 1
        log.warn(`Linha IPC descartada (${verdict.reason}); o canal continua aberto.`)
        continue
      }
      received += 1
      const message = verdict.message
      const intent = message.type === 'intent' ? message : undefined

      let reply: IpcMessageToWorker
      try {
        if (intent !== undefined) {
          reply = onIntent(intent)
        } else if (message.type === 'pairing.success') {
          // EMENDA ONDA-1-PAREAR-VIA-PAINEL: o pareamento concluiu no worker.
          // O host responde `pairing.owner` (fecha o handshake e liberta a
          // allowlist) — a costura em src/index.ts aproveita o aviso para
          // persisir o dono no state.json. Sem tratador, fail-closed.
          reply = (onPairingSuccess ?? responderSemPairing)(message as IpcPairingSuccessMessage)
        } else {
          // EMENDA-COSTURA-5: `nonce.request` (a unica outra mensagem legal
          // neste sentido) e respondido pelo `ConfirmService` do host. Sem
          // tratador, fail-closed: um `error INTERNAL` — um nonce que nao
          // chega não autoriza nada (CTL-023).
          const pedido = message as IpcNonceRequestMessage
          reply = (onNonceRequest ?? responderSemNonce)(pedido)
        }
        // Um defeito no decisor nao pode deixar a intencao sem resposta: o
        // contrato diz `ack` SEMPRE. Regista-se o defeito (mascarado -- este e o
        // caminho por onde um `ECONNRESET em .../bot<token>/getUpdates` entrava
        // em claro no log do plano de controlo) e responde-se `INTERNAL`, que e
        // o codigo cuja `message` nao denuncia topologia.
      } catch (error) {
        log.error(`O decisor de intencoes lancou em '${message.type}': ${descrever(error)}`)
        reply = {
          v: IPC_PROTOCOL_VERSION,
          type: 'error',
          requestId:
            message.type === 'intent'
              ? (message as IpcIntentMessage).requestId
              : message.type === 'nonce.request'
                ? (message as IpcNonceRequestMessage).requestId
                : undefined,
          code: 'INTERNAL',
          message: 'Nao foi possivel processar o pedido. Tente novamente.',
        }
      }
      send(reply)
    }
  }

  /**
   * Absorvedor de `'error'` que NAO se remove no disposer -- mesma razao de
   * `attachStreamLogging`: um `EventEmitter` que emite `'error'` sem ouvinte
   * LANCA no processo hospedeiro, e um EPIPE no `stdin` de um filho ja morto
   * derrubaria o DSH inteiro. Mascarado: um `error.message` de stream pode
   * transportar o comando ou o URL que o produziu.
   */
  const absorb = (error: Error): void => {
    log.debug(`[worker IPC]: ${descrever(error)}`)
  }

  input?.on('data', onData)
  input?.on('error', absorb)
  output?.on('error', absorb)

  return {
    send,
    dispose: (): void => {
      if (disposed) return
      disposed = true
      difusaoPendente = undefined
      input?.removeListener('data', onData)
    },
    get stats(): IpcChannelStats {
      return { sent, dropped, received, malformed, coalesced, overwhelmed }
    },
  }
}
