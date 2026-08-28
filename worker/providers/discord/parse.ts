/**
 * O PARSING CRU do adaptador discord: do payload do Gateway ao
 * {@link SurfaceEvent} neutro. Port do `parse.ts` do telegram para a forma do
 * gateway do Discord (fronteira D4: nada de `worker/lib/*` nem outro provedor).
 *
 * ===========================================================================
 * O GATEWAY E A SUPERFICIE (o que este modulo le)
 * ===========================================================================
 * Cada payload do gateway e `{ op, t?, s?, d? }`:
 *   - `op: 0` (DISPATCH) com `t: 'MESSAGE_CREATE'` — uma mensagem de texto:
 *     `d.author.id` (quem), `d.channel_id` (onde), `d.content` (o texto);
 *   - `op: 0` com `t: 'INTERACTION_CREATE'` e `d.type: 3` (message component)
 *     — um clique num botao: `d.id`/`d.token` (a interacao a responder,
 *     TG-027), `d.data.custom_id` (o payload do botao, gramatica `g1`),
 *     `d.message.id` (a mensagem-alvo), e `d.member.user.id` (guild) ou
 *     `d.user.id` (DM) para quem clicou;
 *   - todo o resto (READY, RESUMED, HEARTBEAT_ACK, MESSAGE_UPDATE, ...) —
 *     `undefined`, ignorado SEM excecao (TG-012..015).
 *
 * ===========================================================================
 * SNOWFLAKES: STRING NA FRONTEIRA, UMA VEZ (D4)
 * ===========================================================================
 * Os ids do Discord sao snowflakes (uint64 ate 2^64-1). O servidor serializa-os
 * como STRINGS no JSON (um `Number(...)` > 2^53 trunca silenciosamente — o
 * envelope IPC V2 existe exatamente por isso). Este modulo converte NA
 * FRONTEIRA, UMA VEZ, com `String(...)`, e nunca mais toca num `number`.
 * NUNCA le `username` (TG-008): a allowlist e por id numerico, e o teste
 * estrutural vigia a ausencia de `.username` no parse.
 *
 * ===========================================================================
 * `custom_id` NUNCA E PROVA DE AUTORIZACAO
 * ===========================================================================
 * Verifica-se a FORMA (`g1:<acao>:<token>`, 1..100 bytes), nunca o VALOR (S5).
 * `answerTarget` e preenchido SEMPRE que ha uma interacao com `id` (TG-027 —
 * o nucleo responde em todos os caminhos); NUNCA se forja `action`/`token`
 * quando o payload nao os carrega validamente.
 */

import type {
  SurfaceAction,
  SurfaceActionEvent,
  SurfaceActionRejectedEvent,
  SurfaceCommandEvent,
  SurfaceEvent,
  SurfaceIdentity,
} from '../../surface/contract.ts'

/* ========================================================================== */
/* Gramatica do `custom_id` (`g1:<acao>:<token>`)                              */
/* ========================================================================== */

/** Limite DURO da API: `custom_id` de botao tem 1..100 caracteres. */
export const CUSTOM_ID_MAX_BYTES = 100

/** Piso: `custom_id` vazio nao e aceite pela API. */
export const CUSTOM_ID_MIN_BYTES = 1

/** Prefixo de esquema — o mesmo `g1` do telegram: o payload do botao e neutro. */
export const CUSTOM_ID_SCHEMA = 'g1'

/** Separador. Fora do alfabeto base64url de proposito: o token nunca o contem. */
const SEP = ':'

/** base64url (RFC 4648 5), que e o alfabeto do nonce do host. */
const TOKEN_ALPHABET = /^[A-Za-z0-9_-]+$/u

/**
 * O vocabulario FECHADO de accoes — o espelho de `IpcIntentName` (o MESMO
 * Record fechado do telegram: se o contrato congelado ganhar uma intencao
 * nova, este objecto deixa de compilar e obriga alguem a decidir aqui). O
 * valor `boolean` e a marca "aumenta exposicao" do guard (informativa; o host
 * decide na mesma).
 */
export const INCREASES_EXPOSURE: Readonly<Record<SurfaceAction, boolean>> = Object.freeze({
  'tunnel.up': true,
  'tunnel.down': false,
  'tunnel.status': false,
  'session.issue': true,
  'secret.rotate': true,
  emergency: false,
  // NAVEGACAO LOCAL (Onda 3/5): o worker resolve-a; nunca chega ao host.
  menu: false,
  ajuda: false,
  inicio: false,
  cancel: false,
})

/** Bytes UTF-8. O payload e ASCII (base64url + acoes ASCII), logo bytes == chars. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Constroi um `custom_id` valido, ou FALHA ALTO (TG-026 — o estouro dos 100
 * bytes tem de ser detectado em teste, nao em producao).
 *
 * O `token` viaja OPACO (S5): esta funcao nao sabe nem quer saber que ele e um
 * nonce. Nao o gera, nao o guarda e nao o valida.
 */
export function buildCustomId(action: SurfaceAction, token: string): string {
  if (token.length === 0) {
    throw new Error(`accao ${action} sem token: todo botao carrega um token emitido pelo host (S5)`)
  }
  if (!TOKEN_ALPHABET.test(token)) {
    throw new Error(
      `token fora do alfabeto base64url para a accao ${action}: um separador dentro do token partiria o parser`,
    )
  }
  const data = `${CUSTOM_ID_SCHEMA}${SEP}${action}${SEP}${token}`
  const bytes = utf8Bytes(data)
  if (bytes > CUSTOM_ID_MAX_BYTES) {
    throw new Error(
      `custom_id com ${bytes} bytes (limite ${CUSTOM_ID_MAX_BYTES}); ` +
        `sao BYTES e nao caracteres — a string tem ${data.length} caracteres`,
    )
  }
  return data
}

/** Motivo de recusa especifico do `custom_id`. Nunca sai para o Discord. */
export type CustomIdRejection =
  | 'deny:custom-id-absent'
  | 'deny:custom-id-too-long'
  | 'deny:custom-id-unknown-schema'
  | 'deny:custom-id-unknown-action'
  | 'deny:custom-id-missing-token'
  | 'deny:custom-id-malformed-token'

export type CustomIdParse =
  | { readonly ok: true; readonly action: SurfaceAction; readonly token: string }
  | { readonly ok: false; readonly reason: CustomIdRejection }

/**
 * Le a FORMA do `custom_id`. **NAO decide autorizacao**, e nao pode: o
 * token e opaco e o host valida o valor.
 */
export function parseCustomId(data: unknown): CustomIdParse {
  if (typeof data !== 'string' || data.length < CUSTOM_ID_MIN_BYTES) {
    return { ok: false, reason: 'deny:custom-id-absent' }
  }
  // Medido em BYTES antes de qualquer split: um payload gigante nao entra no
  // parser so porque tem poucos caracteres.
  if (utf8Bytes(data) > CUSTOM_ID_MAX_BYTES) {
    return { ok: false, reason: 'deny:custom-id-too-long' }
  }

  const parts = data.split(SEP)
  // Exactamente tres partes. `g1:tunnel.up:AAA:BBB` e recusado.
  if (parts.length !== 3) return { ok: false, reason: 'deny:custom-id-unknown-schema' }

  const [schema, action, token] = parts
  if (schema !== CUSTOM_ID_SCHEMA) return { ok: false, reason: 'deny:custom-id-unknown-schema' }
  if (action === undefined || !Object.hasOwn(INCREASES_EXPOSURE, action)) {
    return { ok: false, reason: 'deny:custom-id-unknown-action' }
  }
  if (token === undefined || token.length === 0) {
    return { ok: false, reason: 'deny:custom-id-missing-token' }
  }
  if (!TOKEN_ALPHABET.test(token)) return { ok: false, reason: 'deny:custom-id-malformed-token' }

  return { ok: true, action: action as SurfaceAction, token }
}

/* ========================================================================== */
/* O ANSWER TARGET do Discord: a interacao e {id, token}                      */
/* ========================================================================== */

/**
 * O Discord so responde a um clique com o PAR (interactionId, interactionToken)
 * — o `POST /interactions/{id}/{token}/callback`. O contrato neutro carrega
 * `answerTarget` como STRING; aqui o par e serializado em JSON (dois campos
 * curtos) na fronteira de entrada e desserializado na de saida, no sender.
 * O JSON e inequivoco e nao depende de separadores que o token (base64url)
 * pudesse conter.
 */
export interface AnswerTargetDiscord {
  readonly interactionId: string
  readonly interactionToken: string
}

/** Serializa o par num `answerTarget` STRING (D4). */
export function montarAnswerTarget(alvo: AnswerTargetDiscord): string {
  return JSON.stringify({ i: alvo.interactionId, t: alvo.interactionToken })
}

/** Le o `answerTarget` de volta. `undefined` = nao e da nossa forma. */
export function lerAnswerTarget(alvo: string): AnswerTargetDiscord | undefined {
  try {
    const lido: unknown = JSON.parse(alvo)
    if (typeof lido !== 'object' || lido === null) return undefined
    const box = lido as Record<string, unknown>
    if (typeof box.i !== 'string' || box.i === '' || typeof box.t !== 'string' || box.t === '') {
      return undefined
    }
    return { interactionId: box.i, interactionToken: box.t }
  } catch {
    return undefined
  }
}

/* ========================================================================== */
/* Extracao de identidade e superficie                                         */
/* ========================================================================== */

/** `typeof null === 'object'` — a armadilha mais velha do JavaScript. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Uma snowflake -> string NA FRONTEIRA, uma unica vez (D4). */
function snowflake(valor: unknown): string | undefined {
  if (typeof valor === 'string' && valor.length > 0) return valor
  // O Discord serializa ids como strings; se um dia chegar numerico, o
  // `String(...)` aqui e a conversao de fronteira — nunca `Number(...)`.
  if (typeof valor === 'number' && Number.isSafeInteger(valor)) return String(valor)
  return undefined
}

/** Le `d.user.id` (DM) ou `d.member.user.id` (guild) de uma interacao. */
function lerUserDaInteracao(d: Record<string, unknown>): string | undefined {
  const user = d.user
  if (isObject(user)) {
    const id = snowflake(user.id)
    if (id !== undefined) return id
  }
  const member = d.member
  if (isObject(member) && isObject(member.user)) {
    const id = snowflake(member.user.id)
    if (id !== undefined) return id
  }
  return undefined
}

/**
 * Que superficie o dispatch carrega. `dispatch-outro` = op 0 com `t` que nao
 * e MESSAGE_CREATE nem INTERACTION_CREATE (READY/RESUMED/MESSAGE_UPDATE/...):
 * e um DISPATCH de verdade, logo conta como descartado (TG-089). `outra` = o
 * protocolo (op 1/2/10/11...) e o nao-objecto — nao e superficie e nao conta.
 */
type Superficie = 'message_create' | 'interaction_create' | 'dispatch-outro' | 'outra'

function detectarSuperficie(payload: unknown): Superficie {
  if (!isObject(payload)) return 'outra'
  if (payload.op !== 0) return 'outra' // heartbeat/identify/hello nao sao superficie
  if (payload.t === 'MESSAGE_CREATE') return 'message_create'
  if (payload.t === 'INTERACTION_CREATE') return 'interaction_create'
  return 'dispatch-outro'
}

function lerIdentityDeMensagem(d: Record<string, unknown>): SurfaceIdentity | undefined {
  const author = d.author
  if (!isObject(author)) return undefined
  const userKey = snowflake(author.id)
  const chatKey = snowflake(d.channel_id)
  if (userKey === undefined || chatKey === undefined) return undefined
  return { userKey, chatKey }
}

function lerIdentityDeInteracao(d: Record<string, unknown>): SurfaceIdentity | undefined {
  const userKey = lerUserDaInteracao(d)
  const chatKey = snowflake(d.channel_id)
  if (userKey === undefined || chatKey === undefined) return undefined
  return { userKey, chatKey }
}

/**
 * Mapeia UM payload do gateway para um {@link SurfaceEvent}, ou `undefined`
 * quando a superficie nao e comando nem clique (READY/RESUMED/HEARTBEAT_ACK/
 * MESSAGE_UPDATE/...) — ignorado SEM excecao (TG-012..015).
 *
 * O contador `descartados` (TG-089 — descartado e contado) acumula os cliques
 * malformados e as superficies nao accionaveis; o adapter expoe-o para o boot
 * reportar/auditar.
 */
export function criarParse(): {
  readonly mapear: (payload: unknown) => SurfaceEvent | undefined
  readonly descartados: () => number
} {
  let descartados = 0

  function mapear(payload: unknown): SurfaceEvent | undefined {
    // Nao-objecto (ou null) da internet: ignorado SEM excecao (TG-014).
    if (!isObject(payload)) {
      descartados += 1
      return undefined
    }
    const superficie = detectarSuperficie(payload)
    const d = payload.d

    if (superficie === 'message_create') {
      if (!isObject(d)) {
        descartados += 1
        return undefined
      }
      const identidade = lerIdentityDeMensagem(d)
      if (identidade === undefined) {
        // Mensagem sem `author.id`/`channel_id` — sem identidade nao ha evento.
        descartados += 1
        return undefined
      }
      const texto = d.content
      if (typeof texto !== 'string' || texto === '') {
        // Mensagem sem texto (imagem, sticker, ...) nao e comando. Ignorada.
        descartados += 1
        return undefined
      }
      const comando: SurfaceCommandEvent = {
        kind: 'comando',
        identity: identidade,
        text: texto,
      }
      return comando
    }

    if (superficie === 'interaction_create') {
      if (!isObject(d)) {
        descartados += 1
        return undefined
      }
      // So cliques em BOTOES (type 3 = message component; component_type 2 =
      // button) — o teclado deste adaptador so renderiza botoes. Slash
      // commands (type 2) e selects sao descartados sem excecao.
      if (d.type !== 3) {
        descartados += 1
        return undefined
      }
      const data = d.data
      if (!isObject(data) || data.component_type !== 2) {
        descartados += 1
        return undefined
      }

      const interactionId = snowflake(d.id)
      const interactionToken = typeof d.token === 'string' && d.token.length > 0 ? d.token : undefined

      // DISCORD-019 (espelho de TELEGRAM-019): uma interacao sem `id` (ou sem
      // `token`, que e metade do par de resposta) nao existe na API. Sem o par
      // nao ha como cumprir TG-027, e uma accao que se executa sem poder
      // responder e uma accao invisivel — fail-closed.
      if (interactionId === undefined || interactionToken === undefined) {
        descartados += 1
        return undefined
      }
      const answerTarget = montarAnswerTarget({ interactionId, interactionToken })
      const identidadeNeutra = lerIdentityDeInteracao(d)

      const parse = parseCustomId(data.custom_id)

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

      // A FORMA e valida. Sem identidade completa nao ha quem age — nao se
      // forja identidade (S5).
      if (identidadeNeutra === undefined) {
        descartados += 1
        const rejeitado: SurfaceActionRejectedEvent = {
          kind: 'acao-invalida',
          answerTarget,
          reason: 'deny:custom-id-absent',
        }
        return rejeitado
      }

      // `messageTarget` = a mensagem onde o botao vive (o `d.message.id`).
      // O `chatKey` ja e o `channel_id`; o edit do sender usa os dois.
      const mensagem = isObject(d.message) ? d.message : undefined
      const messageTarget = mensagem === undefined ? undefined : snowflake(mensagem.id)

      const accao: SurfaceActionEvent = {
        kind: 'acao',
        identity: identidadeNeutra,
        action: parse.action,
        token: parse.token,
        answerTarget,
        ...(messageTarget === undefined ? {} : { messageTarget }),
      }
      return accao
    }

    // Todo DISPATCH (op 0) que nao e MESSAGE_CREATE nem INTERACTION_CREATE
    // (READY/RESUMED/MESSAGE_UPDATE/...) sai das superficies accionaveis e e
    // CONTADO (TG-089). O protocolo (op 1/2/10/11...) nao e superficie e nao
    // conta — heartbeat e ack sao o batimento do canal, nao updates.
    if (superficie === 'dispatch-outro') descartados += 1
    return undefined
  }

  return { mapear, descartados: () => descartados }
}
