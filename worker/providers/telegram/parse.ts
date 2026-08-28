/**
 * O PARSING CRU do adaptador: do update do Telegram ao {@link SurfaceEvent}
 * neutro. O DONO desta traducao — port fiel de `worker/auth/guard.ts` e
 * `worker/auth/allowlist.ts` (decideUpdate/extractIdentity/isTelegramId,
 * parseCallbackData/buildCallbackData), nao IMPORTADOS, PORTEADOS (fronteira D4).
 *
 * ===========================================================================
 * A DIVISAO (D4): O ADAPTADOR PRODUZ EVENTOS, O NUCLEO DECIDE
 * ===========================================================================
 * Este modulo lê a FORMA do update e devolve um {@link SurfaceEvent}. NAO
 * autoriza nada: a allowlist de dois eixos e revalidada pelo nucleo neutro
 * (`worker/surface/core.ts` `admitirComando`/`admitirAcao`), com os DOIS eixos
 * como STRINGS (`userKey`/`chatKey`). Aqui os ids numericos do Telegram viram
 * strings, e o `callback_data` e validado APENAS na FORMA (`g1:<acao>:<token>`).
 *
 * ===========================================================================
 * `callback_data` NUNCA E PROVA DE AUTORIZACAO
 * ===========================================================================
 * Sao 1..64 BYTES fornecidos pelo cliente. Verificamos a FORMA, nunca o VALOR
 * (S5): `srv:off:v1` (TG-025) morre no parser; o host recebe sempre alguma
 * coisa na casa do nonce, para poder recusar e ALERTAR.
 *
 * `answerTarget` e preenchido SEMPRE que ha um `callback_query` com `id` (TG-027
 * — o nucleo responde em todos os caminhos); NUNCA se forja `action`/`token`
 * quando o payload nao os carrega validamente.
 */

import type { SurfaceAction, SurfaceEvent, SurfaceActionEvent, SurfaceActionRejectedEvent, SurfaceCommandEvent, SurfaceIdentity } from '../../surface/contract.ts'

/* ========================================================================== */
/* Ids numericos do Telegram                                                  */
/* ========================================================================== */

/**
 * `true` sse o valor e um id de Telegram utilizavel.
 *
 * `Chat.id` e `User.id` tem ate 52 bits significativos; o double do JS e
 * exacto ate 2^53, logo `Number.isSafeInteger` e o predicado certo. ACEITA
 * negativos: supergrupo e canal tem id negativo (TG-011) — o sinal e parte do
 * numero, nao um erro. Recusa `string` (TG-009), `bigint`, `NaN`, `Infinity`.
 */
export function isTelegramId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/* ========================================================================== */
/* Gramatica do `callback_data` (`g1:<acao>:<token>`)                         */
/* ========================================================================== */

/** Limite DURO da Bot API: `callback_data` tem 1..64 BYTES. */
export const CALLBACK_DATA_MAX_BYTES = 64

/** Piso da Bot API: `callback_data` vazio nao e aceite. */
export const CALLBACK_DATA_MIN_BYTES = 1

/** Prefixo de esquema. `srv:off:v1` nao tem este prefixo e morre no parser. */
export const CALLBACK_SCHEMA = 'g1'

/** Separador. Fora do alfabeto base64url de proposito: o token nunca o contem. */
const SEP = ':'

/** base64url (RFC 4648 5), que e o alfabeto do nonce do host. */
const TOKEN_ALPHABET = /^[A-Za-z0-9_-]+$/u

/**
 * O vocabulario FECHADO de accoes — o espelho de `IpcIntentName`. Num
 * `Record`, se o contrato congelado ganhar uma intencao nova este objecto
 * deixa de compilar, obrigando alguem a decidir aqui. O valor `boolean` e a
 * marca "aumenta exposicao" do guard (informativa; o host decide na mesma).
 */
export const INCREASES_EXPOSURE: Readonly<Record<SurfaceAction, boolean>> = Object.freeze({
  'tunnel.up': true,
  'tunnel.down': false,
  'tunnel.status': false,
  'session.issue': true,
  'secret.rotate': true,
  emergency: false,
  // EMENDA ONDA-4-AGENTS-HOST: dispatch executa codigo no host (aumenta);
  // status (leitura pura) e cancel (reduz) nao.
  'agent.dispatch': true,
  'agent.status': false,
  'agent.cancel': false,
  // NAVEGACAO LOCAL (Onda 3/5): o worker resolve-a; nunca chega ao host.
  menu: false,
  ajuda: false,
  inicio: false,
  cancel: false,
})

/** Bytes UTF-8. A unidade em que a Bot API conta, e a unica que nao mente. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Constroi um `callback_data` valido, ou FALHA ALTO (TG-026 — o estouro dos 64
 * bytes tem de ser detectado em teste, nao em producao).
 *
 * O `token` viaja OPACO (S5): esta funcao nao sabe nem quer saber que ele e um
 * nonce. Nao o gera, nao o guarda e nao o valida.
 */
export function buildCallbackData(action: SurfaceAction, token: string): string {
  if (token.length === 0) {
    throw new Error(`accao ${action} sem token: todo botao deste bolt carrega um token emitido pelo host (S5)`)
  }
  if (!TOKEN_ALPHABET.test(token)) {
    throw new Error(
      `token fora do alfabeto base64url para a accao ${action}: um separador dentro do token partiria o parser`,
    )
  }
  const data = `${CALLBACK_SCHEMA}${SEP}${action}${SEP}${token}`
  const bytes = utf8Bytes(data)
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `callback_data com ${bytes} bytes (limite ${CALLBACK_DATA_MAX_BYTES}); ` +
        `sao BYTES e nao caracteres — a string tem ${data.length} caracteres`,
    )
  }
  return data
}

/** Motivo de recusa especifico do `callback_data`. Nunca sai para o Telegram. */
export type CallbackDataRejection =
  | 'deny:callback-data-absent'
  | 'deny:callback-data-too-long'
  | 'deny:callback-data-unknown-schema'
  | 'deny:callback-data-unknown-action'
  | 'deny:callback-data-missing-token'
  | 'deny:callback-data-malformed-token'

export type CallbackDataParse =
  | { readonly ok: true; readonly action: SurfaceAction; readonly token: string }
  | { readonly ok: false; readonly reason: CallbackDataRejection }

/**
 * Le a FORMA do `callback_data`. **NAO decide autorizacao**, e nao pode: o
 * token e opaco e o host valida o valor.
 */
export function parseCallbackData(data: unknown): CallbackDataParse {
  if (typeof data !== 'string' || data.length < CALLBACK_DATA_MIN_BYTES) {
    return { ok: false, reason: 'deny:callback-data-absent' }
  }
  // Medido em BYTES antes de qualquer split: um payload gigante nao entra no
  // parser so porque tem poucos caracteres.
  if (utf8Bytes(data) > CALLBACK_DATA_MAX_BYTES) {
    return { ok: false, reason: 'deny:callback-data-too-long' }
  }

  const parts = data.split(SEP)
  // Exactamente tres partes. `g1:tunnel.up:AAA:BBB` e recusado.
  if (parts.length !== 3) return { ok: false, reason: 'deny:callback-data-unknown-schema' }

  const [schema, action, token] = parts
  if (schema !== CALLBACK_SCHEMA) return { ok: false, reason: 'deny:callback-data-unknown-schema' }
  if (action === undefined || !Object.hasOwn(INCREASES_EXPOSURE, action)) {
    return { ok: false, reason: 'deny:callback-data-unknown-action' }
  }
  if (token === undefined || token.length === 0) {
    return { ok: false, reason: 'deny:callback-data-missing-token' }
  }
  if (!TOKEN_ALPHABET.test(token)) return { ok: false, reason: 'deny:callback-data-malformed-token' }

  return { ok: true, action: action as SurfaceAction, token }
}

/* ========================================================================== */
/* Superficies e extracção de identidade                                      */
/* ========================================================================== */

type UpdateSurface =
  | 'message'
  | 'edited_message'
  | 'channel_post'
  | 'edited_channel_post'
  | 'callback_query'
  | 'inline_query'
  | 'my_chat_member'
  | 'chat_member'
  | 'unknown'

/** `typeof null === 'object'` — a armadilha mais velha do JavaScript. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Qual campo de topo trouxe o update. A ordem e a da Bot API, determinista. */
function detectSurface(update: unknown): UpdateSurface {
  if (!isObject(update)) return 'unknown'
  if (isObject(update.message)) return 'message'
  if (isObject(update.edited_message)) return 'edited_message'
  if (isObject(update.channel_post)) return 'channel_post'
  if (isObject(update.edited_channel_post)) return 'edited_channel_post'
  if (isObject(update.callback_query)) return 'callback_query'
  if (isObject(update.inline_query)) return 'inline_query'
  if (isObject(update.my_chat_member)) return 'my_chat_member'
  if (isObject(update.chat_member)) return 'chat_member'
  return 'unknown'
}

interface IdentidadeExtraida {
  readonly from: number
  readonly chat: number
  readonly surface: UpdateSurface
}

/**
 * Extrai `from.id` e `chat.id`, cada um do sitio certo para a sua superficie.
 * Num `callback_query`: `from` vem de `callback_query.from` (QUEM CARREGOU) e
 * `chat` de `callback_query.message.chat.id` (ONDE estava a mensagem) — TG-003.
 *
 * NO NEVER LE `username`: a allowlist e SO NUMERICA (TG-008). Nenhuma leitura
 * de `.username` existe aqui — e o teste estrutural do nucleo assere isso.
 */
function extractIdentity(update: unknown): IdentidadeExtraida | undefined {
  const surface = detectSurface(update)
  if (!isObject(update)) return undefined

  // Cada superficie le `from.id` e `chat.id` do objecto aninhado — NUNCA o
  // objecto inteiro. `from` e um `User` (`{id, ...}`); `chat` um `Chat`.
  if (surface === 'message' || surface === 'edited_message' || surface === 'channel_post' || surface === 'edited_channel_post') {
    const box = update[surface] as Record<string, unknown>
    return finish(readId(box.from), readId(box.chat), surface)
  }
  if (surface === 'callback_query') {
    const cq = update.callback_query as Record<string, unknown>
    // Num `callback_query`: `from` vem de `cq.from` (QUEM CARREGOU) e `chat`
    // de `cq.message.chat.id` (ONDE estava a mensagem) — TG-003.
    const msg = isObject(cq.message) ? cq.message : undefined
    return finish(readId(cq.from), readId(readChatDe(msg)), surface)
  }
  if (surface === 'inline_query' || surface === 'my_chat_member' || surface === 'chat_member') {
    const box = update[surface] as Record<string, unknown>
    return finish(readId(box.from), readId(box.chat), surface)
  }
  return undefined
}

/** Lê o `id` numerico de um `User`/`Chat` cru (ou `undefined`). */
function readId(objeto: unknown): unknown {
  if (!isObject(objeto)) return undefined
  return objeto.id
}

/** Lê o `chat` de uma mensagem crua (ou `undefined`). */
function readChatDe(msg: unknown): unknown {
  if (!isObject(msg)) return undefined
  return msg.chat
}

function finish(rawFrom: unknown, rawChat: unknown, surface: UpdateSurface): IdentidadeExtraida | undefined {
  if (!isTelegramId(rawFrom) || !isTelegramId(rawChat)) return undefined
  return { from: rawFrom, chat: rawChat, surface }
}

/** Converte os DOIS eixos numericos para as STRINGS neutras (D4). */
function toSurfaceIdentity(extraida: IdentidadeExtraida): SurfaceIdentity {
  return { userKey: String(extraida.from), chatKey: String(extraida.chat) }
}

/* ========================================================================== */
/* O mapeamento para SurfaceEvent                                             */
/* ========================================================================== */

/** Leitores helper dos campos crus do update (JSON vindo da internet — `unknown`). */
function readText(box: unknown): string | undefined {
  if (!isObject(box)) return undefined
  const text = box.text
  return typeof text === 'string' ? text : undefined
}

function readCqId(cq: unknown): string | undefined {
  if (!isObject(cq)) return undefined
  const id = cq.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function readMessageId(cq: unknown): string | undefined {
  if (!isObject(cq)) return undefined
  const msg = cq.message
  if (!isObject(msg)) return undefined
  const id = msg.message_id
  return typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : undefined
}

/**
 * Mapeia UM update cru para um {@link SurfaceEvent}, ou `undefined` quando a
 * superficie nao e comando nem callback (edited_message/channel_post/unknown) —
 * ignorado SEM excecao (TG-012..015).
 *
 * O contador `descartados` (TG-089 — descartado e contado) acumula os callbacks
 * malformados e as superficies nao accionaveis; o adapter expoe-o para o boot
 * reportar/auditar. O evento de recusa carrega o motivo (TG-089).
 */
export function criarParse(): {
  readonly mapear: (update: unknown) => SurfaceEvent | undefined
  readonly descartados: () => number
} {
  let descartados = 0

  function mapear(update: unknown): SurfaceEvent | undefined {
    // Nao-objecto (ou null) da internet: ignorado SEM excecao (TG-014).
    if (!isObject(update)) {
      descartados += 1
      return undefined
    }
    const identidade = extractIdentity(update)
    const surface = detectSurface(update)

    // Superficie que NAO carrega comando nem callback: ignorar sem excecao.
    if (surface === 'message') {
      if (identidade === undefined) {
        // Message sem `from`/`chat` (channel-ish) — sem identidade nao ha evento.
        descartados += 1
        return undefined
      }
      const texto = readText(update.message)
      if (texto === undefined) {
        // Mensagem sem texto (foto, sticker, ...) nao e comando. Ignorada.
        descartados += 1
        return undefined
      }
      const comando: SurfaceCommandEvent = {
        kind: 'comando',
        identity: toSurfaceIdentity(identidade),
        text: texto,
      }
      return comando
    }

    if (surface === 'callback_query') {
      const cq = update.callback_query as Record<string, unknown>
      const answerTarget = readCqId(cq)

      // TELEGRAM-019: um `callback_query` sem `id` nao existe na Bot API. Sem
      // id nao ha como cumprir TG-027, e uma accao que se executa sem poder
      // responder e uma accao invisivel — fail-closed.
      if (answerTarget === undefined) {
        descartados += 1
        return undefined
      }
      const identidadeNeutra = identidade === undefined ? undefined : toSurfaceIdentity(identidade)
      const parse = parseCallbackData(cq.data)

      // TG-027: responde-se SEMPRE — inclusive na negacao da forma.
      if (!parse.ok) {
        descartados += 1
        const rejeitado: SurfaceActionRejectedEvent = {
          kind: 'acao-invalida',
          ...(identidadeNeutra === undefined ? {} : { identity: identidadeNeutra }),
          answerTarget,
          reason: parse.reason,
        }
        return rejeitado
      }

      // A FORMA e valida. Sem identidade completa (falta from/chat) nao ha
      // quem age nem onde responder — nao se forja identidade (S5).
      if (identidadeNeutra === undefined) {
        descartados += 1
        const rejeitado: SurfaceActionRejectedEvent = {
          kind: 'acao-invalida',
          answerTarget,
          reason: 'deny:callback-data-absent',
        }
        return rejeitado
      }

      const accao: SurfaceActionEvent = {
        kind: 'acao',
        identity: identidadeNeutra,
        action: parse.action,
        token: parse.token,
        answerTarget,
        ...(readMessageId(cq) === undefined ? {} : { messageTarget: readMessageId(cq) }),
      }
      return accao
    }

    // edited_message / channel_post / edited_channel_post / inline_query /
    // my_chat_member / chat_member / unknown -> fora das superficies accionaveis.
    if (surface !== 'unknown') descartados += 1
    return undefined
  }

  return { mapear, descartados: () => descartados }
}