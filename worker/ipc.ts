/**
 * =============================================================================
 * Lado WORKER do canal JSONL sobre `stdio`. Especificacao: `../src/contracts/ipc.ts`.
 * =============================================================================
 *
 * ESTE MODULO E A UNICA COISA NO WORKER QUE PODE ESCREVER EM `process.stdout`.
 *
 * S2 e a invariante que mais se viola e a que falha em silencio: o `stdout` do
 * worker e EXCLUSIVAMENTE JSONL, e TODO o log humano vai para `stderr`. Um
 * `console.log` de depuracao esquecido num merge nao rebenta nada — faz o
 * analisador do pai ver ruido, e as mensagens somem sem erro nenhum. Por isso o
 * unico caminho de escrita para `stdout` esta aqui, e {@link WorkerIpc.log}
 * existe para que ninguem tenha desculpa para usar `console`.
 *
 * -----------------------------------------------------------------------------
 * O DEAD-MAN'S SWITCH — a razao de existir do `stdin` em `'pipe'`
 * -----------------------------------------------------------------------------
 * Se o processo `dsh` for morto com `SIGKILL`, o nucleo fecha os descritores
 * dele. O worker era o unico leitor daquele pipe: o `stdin` chega a EOF, e o
 * worker TERMINA SOZINHO.
 *
 * E a UNICA defesa que sobrevive a um `SIGKILL` no supervisor — `detached` +
 * `process.kill(-pid)` no disposer depende de o disposer CHEGAR A CORRER, e
 * `SIGKILL` nao deixa correr nada.
 *
 * >>> NAO COPIAR A DECISAO DA ONDA 3. <<< La ficou escrito que o dead-man's
 * switch por pipe "nao servia". A razao era ESPECIFICA do `cloudflared`: o
 * mecanismo exige que o filho COOPERE (detete o EOF e se mate), e um binario de
 * terceiros nao coopera. Este worker e codigo NOSSO e coopera — logo aqui o
 * controlo e exigivel, e e MEDIDO:
 * `test/integration/proc/dead-mans-switch.test.ts` mata o host com `SIGKILL` e
 * assere o worker morto em menos de 2 segundos.
 *
 * -----------------------------------------------------------------------------
 * PORQUE O CODEC ESTA DUPLICADO (e nao importado de `src/telegram/ipc.ts`)
 * -----------------------------------------------------------------------------
 * `05-QUALIDADE-CODIGO.md` 5.5: o worker importa de `src/` UMA coisa e so uma —
 * `src/contracts/ipc.ts`. Importar o codec do host arrastaria `src/logging/**` e
 * `src/errors.ts` para dentro do processo que fala com a internet, que e
 * precisamente o que a separacao de processos existe para impedir.
 *
 * O que impede as duas copias de divergirem e um GATE: `test/unit/worker/ipc.test.ts`
 * corre a MESMA tabela pelos DOIS analisadores e assere veredito identico.
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
  type IpcMessageFromWorker,
  type IpcMessageToWorker,
  type IpcNonceIssuedMessage,
  type IpcNonceRequestMessage,
  type IpcNotifyMessage,
  type IpcPairingChallengeMessage,
  type IpcPairingOwnerMessage,
  type IpcParseResult,
  type IpcStateMessage,
} from '../src/contracts/ipc.ts'

/* ========================================================================== */
/* Limites (espelham `src/telegram/ipc.ts` -- ver o gate de equivalencia)      */
/* ========================================================================== */

export const IPC_MAX_LINE_BYTES = 64 * 1024

/**
 * Teto do que pode ficar POR ESCREVER no `stdout` do worker.
 *
 * O MESMO DEFEITO, DO OUTRO LADO. A medicao que motivou o teto no host vale
 * simetricamente aqui: um HOST que pare de ler o `stdout` do filho nao bloqueia
 * o filho -- `Writable.write()` sobre um pipe e assincrono e devolve `false`, e
 * o que cresce e a fila INTERNA do stream. Medido sem teto: 20 000 `send()` com
 * o host a nao ler deixaram `process.stdout.writableLength` em 1 668 418 bytes
 * e a subir.
 *
 * O CUSTO E MENOR DO QUE DO LADO DO HOST -- quem morre e o worker, nao o DSH --
 * mas nao e zero: cada morte por OOM queima uma tentativa do orcamento de
 * reinicio, e o orcamento leva o supervisor a estado terminal. Um bot que deixa
 * de existir porque o pai ficou entupido nao e um modo de falha aceitavel.
 *
 * NAO HA COALESCENCIA DESTE LADO, e a assimetria e deliberada: o que o worker
 * envia sao INTENCOES, e uma intencao e uma accao do dono. Nao ha "a proxima
 * traz o mesmo" -- por isso `send()` devolve `false` e quem chama tem de dizer
 * ao dono que o comando nao passou, em vez de fingir que passou.
 */
export const IPC_MAX_PENDING_BYTES = 256 * 1024
const MAX_MESSAGE_CHARS = 4096
const MAX_ID_CHARS = 64
/**
 * Teto do `nonce` EM TRANSITO. Isto NAO e validacao de nonce (S5): nao ha aqui
 * verificacao de emissao, de validade nem de consumo — o worker nao sabe o que
 * um nonce significa e nao pode saber. E so a garantia de que o valor opaco cabe
 * numa linha antes de ser posto no canal.
 */
const MAX_NONCE_CHARS = 128
const MAX_URL_CHARS = 2048

/**
 * Marca que o processo foi arrancado PELO HOST, com o canal armado.
 *
 * Corrida a mao, sem esta variavel, o `stdin` do worker e um terminal ou
 * `/dev/null` — no segundo caso ele veria EOF imediato e sairia em silencio, o
 * que parece uma avaria. A marca so serve para dizer isso ao humano em `stderr`;
 * o comportamento fail-closed nao depende dela.
 *
 * Uma entrada `DSH_*` deliberada SOBREVIVE ao `scrubbedParentEnv()` do assento,
 * porque o `env` explicito do spec e mesclado DEPOIS da limpeza.
 */
export const WORKER_IPC_ENV_VAR = 'DSH_GUARD_IPC'

/** Codigo de saida do dead-man's switch. Nao e falha: e o desligamento correto. */
export const DEAD_MANS_SWITCH_EXIT_CODE = 0

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
 *
 * EMENDA-COSTURA-5: `nonce.request` viaja worker -> host; `nonce.issued`
 * host -> worker.
 */
const LEGAL_TYPES: Readonly<Record<IpcDirection, readonly string[]>> = {
  'to-host': ['intent', 'nonce.request'],
  'to-worker': ['state', 'ack', 'error', 'notify', 'pairing.challenge', 'nonce.issued', 'pairing.owner'],
}

/** Sentido em que a linha viaja. O worker LE `to-worker` e ESCREVE `to-host`. */
export type IpcDirection = 'to-host' | 'to-worker'

type FailureReason = Extract<IpcParseResult, { ok: false }>['reason']

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

function fail(reason: FailureReason): IpcParseResult {
  return { ok: false, reason }
}

function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

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
}

/**
 * Valida e RECONSTROI. O objeto devolvido e novo e tem so os campos do contrato:
 * o que o outro lado acrescentar a linha nao entra no worker.
 */
export function validateWorkerIpcMessage(value: unknown, direction: IpcDirection): IpcParseResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('forma-invalida')
  }

  const bag = value as Record<string, unknown>
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

  const pronto = state === 'READY'
  if (pronto !== (url !== undefined) || pronto !== (expiresAt !== undefined)) {
    return fail('forma-invalida')
  }
  if (!pronto) {
    return { ok: true, message: { v: IPC_PROTOCOL_VERSION, type: 'state', state, seq } }
  }
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

  const recusado = result === 'rejected'
  if (recusado !== (code !== undefined)) return fail('forma-invalida')
  if (!recusado) {
    return { ok: true, message: { v: IPC_PROTOCOL_VERSION, type: 'ack', requestId, result, state } }
  }
  if (!isMember(ERROR_CODES, code)) return fail('forma-invalida')

  return {
    ok: true,
    message: { v: IPC_PROTOCOL_VERSION, type: 'ack', requestId, result, state, code },
  }
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
 * `nonce.request` (EMENDA-COSTURA-5, worker -> host): o pedido de nonce ao
 * host. O `acao` tem de ser uma `ControlAction` real (PREP 5).
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
 * `nonce.issued` (EMENDA-COSTURA-5, host -> worker): o nonce OPACO emitido
 * pelo host. O worker NAO o le nem valida (S5); transporta-o. O teto de
 * transporte e o mesmo do campo `nonce` do intent.
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
 * boot. Os DOIS EIXOS sao inteiros e `pairedAt` e um epoch finito.
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

/* ========================================================================== */
/* CODEC                                                                      */
/* ========================================================================== */

/** Le UMA linha. NUNCA lanca (S4): o veredito e o valor de retorno. */
export function parseWorkerIpcLine(line: string, direction: IpcDirection): IpcParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
    // Excecao mitigada e convertida em veredito -- S4 exige veredito, nao throw.
  } catch {
    return fail('json-invalido')
  }
  return validateWorkerIpcMessage(parsed, direction)
}

/**
 * Escreve UMA linha: JSON compacto + `\n` (S1).
 *
 * Lanca `Error` quando a mensagem viola o contrato — do lado da escrita isso e
 * defeito nosso, e {@link WorkerIpc.send} converte-o num log em `stderr` e num
 * `false`. Emitir uma linha invalida seria por o pai a ver ruido, que e o modo
 * de falha silencioso de S2.
 */
export function serializeWorkerIpcMessage(message: IpcMessage, direction: IpcDirection): string {
  const verdict = validateWorkerIpcMessage(message, direction)
  if (!verdict.ok) {
    throw new Error(`IPC_MESSAGE_INVALID: mensagem recusada pelo contrato (${verdict.reason}).`)
  }
  const line = JSON.stringify(verdict.message)
  if (line.includes('\n') || line.includes('\r')) {
    throw new Error('IPC_MESSAGE_INVALID: a linha serializada contem uma quebra.')
  }
  return `${line}\n`
}

/* ========================================================================== */
/* FRAMING                                                                    */
/* ========================================================================== */

export interface WorkerLineDecoder {
  push(chunk: Buffer | string): readonly IpcParseResult[]
  readonly pending: number
}

/**
 * O acumulador. Ver o gemeo em `src/telegram/ipc.ts` para o PORQUE completo; em
 * resumo: uma linha pode vir partida entre dois `data` (o pipe parte onde
 * quiser) e um carater UTF-8 tambem — dai o `StringDecoder` em vez de
 * `Buffer.toString()`.
 */
export function createWorkerLineDecoder(options: {
  readonly direction: IpcDirection
  readonly maxLineBytes?: number | undefined
}): WorkerLineDecoder {
  const { direction } = options
  const maxLineBytes = options.maxLineBytes ?? IPC_MAX_LINE_BYTES
  const utf8 = new StringDecoder('utf8')
  let buffer = ''
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
          resyncing = false
        } else if (line.trim() !== '') {
          results.push(parseWorkerIpcLine(line, direction))
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

/** Porque o canal se fechou. `'eof'` e o caso normal do dead-man's switch. */
export type WorkerDisconnectReason = 'eof' | 'error'

export interface WorkerIpcOptions {
  /** `stdin` do worker. O EOF DELE e o dead-man's switch. */
  readonly input: Readable
  /** `stdout` do worker. **So** JSONL entra aqui (S2). */
  readonly output: Writable
  /** `stderr` do worker. TODO o log humano sai por aqui (S2). */
  readonly diagnostics: Writable
  /** Mensagem valida vinda do host. */
  readonly onMessage: (message: IpcMessageToWorker) => void
  /**
   * O host desapareceu. O chamador TEM de terminar o processo aqui — e o
   * dead-man's switch, e nao ha nada a decidir: sem host, o bot ficaria a falar
   * com a internet sem ninguem a supervisiona-lo.
   */
  readonly onDisconnect: (reason: WorkerDisconnectReason) => void
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly maxLineBytes?: number | undefined
  /** Ver {@link IPC_MAX_PENDING_BYTES}. */
  readonly maxPendingBytes?: number | undefined
}

export interface WorkerIpc {
  /**
   * Envia worker -> host. EMENDA-COSTURA-5: para alem do `intent`, o canal
   * tambem emite `nonce.request` (o pedido de nonce ao host).
   *
   * `false` = NAO SAIU: canal fechado, mensagem invalida, ou o host parou de ler
   * e a fila local ja passou o teto. Quem chama TEM de tratar o `false` -- e a
   * unica forma de o dono saber que o comando dele nao chegou a lado nenhum.
   */
  send(message: IpcMessageFromWorker): boolean
  /** Log HUMANO. Vai sempre para `stderr`, nunca para `stdout` (S2). */
  log(message: string): void
  /** Desarme SINCRONO e IDEMPOTENTE. */
  dispose(): void
}

/**
 * Arma o canal sobre streams INJETADOS.
 *
 * Nada aqui toca em `process`: quem faz a ponte com o processo real e
 * {@link bindWorkerIpcToProcess}. E o que torna o dead-man's switch testavel sem
 * matar o corredor de testes.
 */
export function createWorkerIpc(options: WorkerIpcOptions): WorkerIpc {
  const { input, output, diagnostics, onMessage, onDisconnect } = options
  const decoder = createWorkerLineDecoder({
    direction: 'to-worker',
    maxLineBytes: options.maxLineBytes,
  })
  const maxPendingBytes = options.maxPendingBytes ?? IPC_MAX_PENDING_BYTES

  let disposed = false
  let disconnected = false
  /** Dentro de um episodio de saturacao? Governa o log: UMA linha, nao N. */
  let saturado = false
  /** Intencoes perdidas no episodio corrente. Sai no resumo quando ele acaba. */
  let perdidas = 0
  /** Escritas de diagnostico que falharam. Ver {@link absorveDiagnostico}. */
  let falhasDeDiagnostico = 0

  const log = (message: string): void => {
    // `stderr` e o unico destino de texto humano. Se isto alguma vez apontar
    // para `output`, o pai passa a ver ruido e o canal morre em silencio (S2).
    try {
      diagnostics.write(`[worker] ${message}\n`)
      // NAO ha para onde registar a falha de registar -- ver `absorveDiagnostico`.
    } catch {
      // Escrever o log a dizer que o log falhou e recursao, nao diagnostico.
      falhasDeDiagnostico += 1
    }
  }

  const disconnect = (reason: WorkerDisconnectReason): void => {
    // UMA vez. `'end'`, `'close'` e `'error'` podem chegar todos no mesmo
    // desligamento, e o dead-man's switch tem de ser accionado uma so vez.
    if (disconnected) return
    disconnected = true
    log(
      reason === 'eof'
        ? 'EOF no stdin: o processo host desapareceu. A terminar (dead-mans switch).'
        : 'Erro no stdin: a ligacao ao host quebrou. A terminar (dead-mans switch).',
    )
    onDisconnect(reason)
  }

  const onData = (chunk: Buffer): void => {
    for (const verdict of decoder.push(chunk)) {
      if (!verdict.ok) {
        // S4: descarta e SEGUE. Nunca derrubar o canal — o pai pode ter sido
        // reiniciado a meio de uma escrita, e derrubar transforma um byte
        // perdido numa queda de servico.
        log(`linha do host descartada (${verdict.reason}); o canal continua aberto.`)
        continue
      }
      const message = verdict.message as IpcMessageToWorker
      try {
        onMessage(message)
        // Um defeito no consumidor nao pode matar o canal: e registado (nunca
        // engolido) e a mensagem seguinte continua a ser processada.
      } catch (error) {
        log(`o consumidor lancou em '${message.type}': ${describe(error)}`)
      }
    }
  }

  const onEnd = (): void => {
    disconnect('eof')
  }
  const onInputError = (error: Error): void => {
    log(`stdin: ${error.message}`)
    disconnect('error')
  }
  const onOutputError = (error: Error): void => {
    // EPIPE no `stdout` significa que o pai ja nao esta a ler. Um `EventEmitter`
    // que emite `'error'` sem ouvinte LANCA — sem este absorvedor, o worker
    // morria com um stack trace em vez de pelo caminho previsto.
    log(`stdout: ${error.message}`)
    disconnect('error')
  }

  /**
   * ===========================================================================
   * O ABSORVEDOR DO PROPRIO CANAL DE DIAGNOSTICO -- e o unico sitio deste
   * repositorio onde uma excecao e mitigada SEM ser registada.
   * ===========================================================================
   * MEDIDO, e foi um defeito a serio: quando o host morre, o lado de LEITURA do
   * pipe de `stderr` fecha. A escrita seguinte do worker da EPIPE, e um
   * `EventEmitter` que emite `'error'` sem ouvinte LANCA. O resultado era o
   * worker a morrer de excecao POR TRATAR (`EXIT=1`) em vez de sair pelo
   * `process.exit(0)` do dead-mans switch -- ou seja, o desligamento limpo
   * transformado num crash, precisamente no caminho que existe para ser limpo.
   *
   * PORQUE NAO SE REGISTA: o destino do registo E o stream que acabou de
   * falhar. Registar ali era recursao. O que sobra e contar
   * ({@link falhasDeDiagnostico}), e o teste que prova que isto e necessario e
   * `test/integration/proc/dead-mans-switch.test.ts`, que exige `EXIT=0`.
   */
  const absorveDiagnostico = (): void => {
    falhasDeDiagnostico += 1
  }

  input.on('data', onData)
  input.on('end', onEnd)
  input.on('close', onEnd)
  input.on('error', onInputError)
  output.on('error', onOutputError)
  diagnostics.on('error', absorveDiagnostico)

  if (options.env !== undefined && options.env[WORKER_IPC_ENV_VAR] !== '1') {
    log(
      `${WORKER_IPC_ENV_VAR} ausente: este processo nao foi arrancado pelo plugin. ` +
        'O canal IPC continua armado e o EOF do stdin continua a termina-lo.',
    )
  }

  return {
    log,
    send: (message: IpcMessageFromWorker): boolean => {
      if (disposed || disconnected || !output.writable) return false
      let line: string
      try {
        line = serializeWorkerIpcMessage(message, 'to-host')
        // Registada, nao engolida.
      } catch (error) {
        log(`mensagem recusada antes de sair: ${describe(error)}`)
        return false
      }
      /**
       * BACKPRESSURE, simetrica a do host. Escrever num pipe cheio nao bloqueia
       * -- acumula, e acumula sem limite. Acima do teto recusa-se, com UMA linha
       * por episodio (uma por mensagem seria trocar memoria por volume de log).
       */
      if (output.writableLength > maxPendingBytes) {
        perdidas += 1
        if (!saturado) {
          saturado = true
          log(
            `o host parou de ler (${String(output.writableLength)} bytes por escrever): ` +
              'as intencoes passam a ser RECUSADAS ate ele voltar.',
          )
        }
        return false
      }

      if (saturado) {
        saturado = false
        log(`o host voltou a ler; ${String(perdidas)} intencoes foram recusadas entretanto.`)
        perdidas = 0
      }

      // NOTA DE FLUSH: `process.stdout` ligado a um PIPE e assincrono. Quem
      // chamar `send()` e a seguir `process.exit()` no mesmo tick perde a linha.
      // O desligamento correto e deixar o event loop drenar.
      output.write(line)
      return true
    },
    dispose: (): void => {
      if (disposed) return
      disposed = true
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.removeListener('close', onEnd)
      input.removeListener('error', onInputError)
      // O absorvedor de `'error'` do `output` FICA, de proposito: ele e
      // necessario exatamente enquanto o stream esta a fechar.
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Ponte com o processo real: `stdin`/`stdout`/`stderr` e a saida no EOF.
 *
 * O `proc` e INJETADO (e nao `process` lido do modulo) por duas razoes: nao ha
 * estado global de modulo, e um teste consegue exercitar o dead-man's switch sem
 * matar o corredor de testes.
 */
export function bindWorkerIpcToProcess(
  proc: NodeJS.Process,
  options: {
    readonly onMessage: (message: IpcMessageToWorker) => void
    readonly maxLineBytes?: number | undefined
    readonly maxPendingBytes?: number | undefined
  },
): WorkerIpc {
  let terminado = false

  /**
   * Absorvedor de `'error'` do `stderr` do PROCESSO, ligado ANTES de qualquer
   * escrita. Mesmo motivo do absorvedor do canal: morto o host, o pipe de
   * `stderr` fecha, a escrita da EPIPE e um `'error'` sem ouvinte LANCA --
   * transformando a saida limpa do switch num crash (`EXIT=1`). Nao ha para
   * onde registar isto: o destino do registo e o stream que falhou.
   */
  proc.stderr.on('error', (): void => {})

  /** Termina o processo. UMA vez -- varios eventos chegam no mesmo desligamento. */
  const terminar = (motivo: string): void => {
    if (terminado) return
    terminado = true
    try {
      // `stderr` e nao `stdout`: o pai ja nao esta a ler o protocolo (S2).
      proc.stderr.write(`[worker] ${motivo} A terminar (dead-mans switch).\n`)
      // O DIAGNOSTICO E OPCIONAL; a TERMINACAO NAO. Uma falha a explicar-se
      // nunca pode impedir o worker de se ir embora. O selector de
      // `no-restricted-syntax` conta statements e nao ve comentarios, entao a
      // excecao mitigada vai explicita -- mesmo padrao de `src/proc/tree-kill.ts`.
      // eslint-disable-next-line no-restricted-syntax
    } catch {
      // Ver o absorvedor acima: escrever o erro de escrever e recursao.
    }
    // Sem host nao ha supervisao: o bot NAO fica a falar com a internet.
    proc.exit(DEAD_MANS_SWITCH_EXIT_CODE)
  }

  const ipc = createWorkerIpc({
    input: proc.stdin,
    output: proc.stdout,
    diagnostics: proc.stderr,
    env: proc.env,
    onMessage: options.onMessage,
    maxLineBytes: options.maxLineBytes,
    maxPendingBytes: options.maxPendingBytes,
    onDisconnect: (reason): void => {
      terminar(`o canal detetou o desligamento (${reason}).`)
    },
  })

  /**
   * ===========================================================================
   * O SWITCH ARMADO FORA DO CANAL, E SEM FORMA DE O DESARMAR.
   * ===========================================================================
   * Estes ouvintes NAO pertencem ao objeto {@link WorkerIpc} e `dispose()` nao
   * lhes toca. A separacao e o controlo, e nao arrumacao:
   *
   *   - `dispose()` larga o LEITOR DO PROTOCOLO. E uma operacao do canal.
   *   - O dead-man's switch e o CONTRATO DE SOBREVIVENCIA DO PROCESSO. Enquanto
   *     este processo existir, a morte do host tem de o levar junto.
   *
   * Medido antes desta separacao: com `dispose()` chamado e o supervisor morto
   * com `SIGKILL`, o worker SOBREVIVIA -- e ficava a falar com a internet sem
   * ninguem a supervisiona-lo.
   *
   * ---------------------------------------------------------------------------
   * O `'pause'` -- e porque o switch CONTRA-ATACA em vez de confiar.
   * ---------------------------------------------------------------------------
   * `'end'` so chega a um `Readable` que esta a FLUIR. Uma unica linha em
   * `worker/telegram-bot.ts` -- `process.stdin.pause()`, que e uma coisa
   * perfeitamente normal de se escrever -- desarmava a unica defesa que
   * sobrevive a um `SIGKILL` no DSH, e desarmava-a EM SILENCIO: o worker
   * continuava a parecer saudavel. Medido: com `pause()`, `SIGKILL` no host
   * deixava o worker vivo indefinidamente (8 s de observacao, sem morrer).
   *
   * Um comentario a dizer "nao facam pause" nao e um controlo. Por isso o
   * `'pause'` volta a chamar `resume()`: o `stdin` deste processo pertence ao
   * canal, e ninguem mais tem uso legitimo para ele.
   */
  const { stdin } = proc
  stdin.on('end', (): void => {
    terminar('EOF no stdin: o processo host desapareceu.')
  })
  stdin.on('close', (): void => {
    terminar('o stdin fechou: o processo host desapareceu.')
  })
  stdin.on('error', (): void => {
    terminar('erro no stdin: a ligacao ao host quebrou.')
  })
  stdin.on('pause', (): void => {
    /**
     * `process.nextTick` e NAO uma chamada sincrona, e a razao esta no fonte do
     * Node: `Readable.prototype.pause()` poe `flowing = false`, EMITE `'pause'`
     * e SO DEPOIS marca o estado interno de pausa. Um `resume()` sincrono dentro
     * do ouvinte era desfeito pela linha seguinte do proprio `pause()` --
     * medido: `isPaused()` continuava `true`. No tick seguinte, `pause()` ja
     * retornou e o `resume()` pega.
     */
    process.nextTick((): void => {
      stdin.resume()
    })
  })

  // `stdin` so emite `'end'` depois de comecar a fluir.
  stdin.resume()

  return ipc
}
