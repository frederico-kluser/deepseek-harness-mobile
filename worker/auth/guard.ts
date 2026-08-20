/**
 * Revalidacao de identidade em **todo** `callback_query`, e o funil unico por
 * onde qualquer update tem de passar antes de virar intencao.
 *
 * DONO: T4.4.
 *
 * ===========================================================================
 * O QUE ESTE FICHEIRO **NAO** VALIDA, E PORQUE ISSO E ESTRUTURAL
 * ===========================================================================
 * **NENHUM NONCE.** Invariante **S5** de `src/contracts/ipc.ts`: o nonce de
 * confirmacao de duas etapas e emitido e consumido no **HOST**
 * (`src/control/confirm.ts`, T5.1). O worker **transporta-o opaco** dentro do
 * `callback_data` e nunca o le, nunca o compara, nunca o guarda.
 *
 * > Um nonce validado no processo que fala com a internet **nao e um controlo,
 * > e uma variavel.**
 *
 * O worker e o processo exposto: e ele que faz o parsing de bytes vindos da
 * internet, e e ele que cai primeiro se houver uma falha de memoria num parser.
 * Um controlo cuja fonte da verdade vive dentro do alvo cai junto com o alvo.
 * Por isso o worker guarda **zero estado de autorizacao por accao** — e
 * `guard.test.ts` prova-o comportamentalmente: o MESMO `callback_data`
 * apresentado duas vezes e autorizado a seguir as **duas** vezes. Se algum dia
 * esse teste ficar vermelho, alguem acrescentou validacao de nonce aqui e o
 * controlo mudou de lado.
 *
 * ===========================================================================
 * `callback_data` NUNCA E PROVA DE AUTORIZACAO
 * ===========================================================================
 * Sao **1-64 BYTES** (nao caracteres — `docs/spikes/telegram.md` 10 mediu que
 * 33 caracteres acentuados sao 66 bytes) **fornecidos pelo cliente**. Um cliente
 * modificado manda a string que quiser, e a propria documentacao do Telegram
 * avisa que a mensagem de origem pode nem conter aquele botao.
 *
 * O que este ficheiro faz com o `callback_data` e verificar a **FORMA**, nunca
 * o **VALOR**:
 *   - a forma tem de ser `g1:<accao conhecida>:<token opaco>`;
 *   - a accao tem de estar no vocabulario fechado de `IpcIntentName`;
 *   - o token tem de EXISTIR e ser base64url.
 *
 * Isto **nao** e validacao de nonce, e a distincao e o cerne do desenho:
 * qualquer atacante consegue fabricar 11 caracteres base64url e passar a forma.
 * O que a forma garante e outra coisa — que um payload administrativo DIRECTO
 * como `srv:off:v1` (TG-025) nunca chega ao canal, e que o host recebe **sempre**
 * alguma coisa na casa do nonce, para poder recusar e **alertar** ("botao nao
 * emitido por mim", `02-SEGURANCA.md` 7.3). As duas camadas sao deliberadas:
 * a forma e do worker, o valor e do host.
 *
 * ===========================================================================
 * `answerCallbackQuery` EM TODOS OS CAMINHOS — INCLUSIVE NA NEGACAO (TG-027)
 * ===========================================================================
 * Ha uma tensao aparente com "descartado em silencio", e ela resolve-se
 * separando **protocolo** de **conteudo**:
 *   - o `answerCallbackQuery` e obrigacao de PROTOCOLO. Sem ele o cliente do
 *     Telegram fica com a barra de progresso a girar ate expirar;
 *   - o SILENCIO e sobre CONTEUDO. Na negacao a resposta vai com `text`
 *     ausente e `showAlert: false` — para o girador e nao diz nada. Nao ha
 *     mensagem no chat, nao ha motivo, nao ha oraculo.
 * Responder "nao autorizado" seria confirmar ao estranho que o bot existe, que
 * esta vivo e que ele tocou em algo real. Nao responder nada seria deixar o
 * cliente do proprio dono pendurado em cada erro.
 */

import type { IpcIntentName } from '../../src/contracts/ipc.ts'

import {
  decideUpdate,
  WorkerAuthError,
  type Allowlist,
  type DenyReason,
  type UpdateIdentity,
  type UpdateSurface,
  type UpdateVerdict,
} from './allowlist.ts'

// ---------------------------------------------------------------------------
// `callback_data`: a gramatica, e o limite que a producao nao pode descobrir
// ---------------------------------------------------------------------------

/**
 * Limite DURO da Bot API: `callback_data` tem 1..64 **bytes**.
 *
 * Referencia medida em `docs/spikes/telegram.md` 10: `#inlinekeyboardbutton` diz
 * *"Data to be sent in a callback query to the bot when the button is pressed,
 * 1-64 bytes"*. A armadilha esta na unidade — validar por `.length` aprova 33
 * caracteres acentuados (66 bytes) e o Telegram recusa o envio em producao.
 * Aqui mede-se com `TextEncoder`, que conta bytes UTF-8.
 */
export const CALLBACK_DATA_MAX_BYTES = 64

/** Piso da Bot API: `callback_data` vazio nao e aceite. */
export const CALLBACK_DATA_MIN_BYTES = 1

/**
 * Prefixo de esquema. Existe por duas razoes concretas:
 *
 * 1. **Rejeita payloads de outra origem por construcao.** `srv:off:v1` — o
 *    payload administrativo directo de TG-025, e o formato que circulou nos
 *    spikes — nao tem este prefixo e morre no parser, antes de qualquer accao.
 * 2. **Da caminho de migracao.** Um botao velho ainda no ecra do telemovel do
 *    dono, emitido por uma versao anterior, sera reconhecivel como tal em vez de
 *    ser interpretado pela gramatica nova.
 */
export const CALLBACK_SCHEMA = 'g1'

/** Separador. Fora do alfabeto base64url de proposito: o token nunca o contem. */
const SEP = ':'

/** base64url (RFC 4648 5), que e o alfabeto do nonce do host (`randomBytes(8).toString('base64url')`). */
const TOKEN_ALPHABET = /^[A-Za-z0-9_-]+$/u

/**
 * Accao -> exige confirmacao de duas etapas?
 *
 * `Record<IpcIntentName, boolean>` e o ponto todo: se o **contrato congelado**
 * ganhar uma intencao nova, este objecto deixa de compilar e alguem e OBRIGADO a
 * decidir, aqui, se ela aumenta ou reduz exposicao. Um `Set` ou um array nao
 * daria esse erro — a intencao nova nasceria sem decisao e sem confirmacao.
 *
 * A ASSIMETRIA e deliberada e fail-safe na direccao certa (`02-SEGURANCA.md`
 * 7.3): o que **aumenta** exposicao confirma; o que **reduz** executa a
 * primeira, porque em panico o botao tem de funcionar de imediato.
 *
 * NOTA DE FRONTEIRA: quem decide o FLUXO de cada comando e T5.2
 * (`worker/commands/**`). Esta tabela nao encomenda teclados; ela so diz, para o
 * audit e para quem le, o que cada accao significa em termos de exposicao.
 */
export const INCREASES_EXPOSURE: Readonly<Record<IpcIntentName, boolean>> = Object.freeze({
  'tunnel.up': true,
  'tunnel.down': false,
  'tunnel.status': false,
  'session.issue': true,
  'secret.rotate': true,
  emergency: false,
})

/**
 * Constroi um `callback_data` valido, ou **falha alto**.
 *
 * TG-026 e sobre isto: o estouro dos 64 bytes tem de ser detectado **em teste,
 * nao em producao**. Em producao o sintoma seria uma chamada de `sendMessage`
 * recusada pela Bot API com um erro generico, no exacto momento em que o dono
 * precisa do teclado — e um `try`/`catch` que "ignorasse e enviasse sem botao"
 * transformaria o defeito num silencio. Falhar aqui poe o erro no ficheiro de
 * quem construiu a string.
 *
 * O `token` viaja **OPACO**: esta funcao nao sabe nem quer saber que ele e um
 * nonce. Nao o gera (o host gera), nao o guarda e nao o valida.
 *
 * NOTA HONESTA SOBRE A MEDICAO EM BYTES **NESTA FUNCAO**: como o alfabeto do
 * token e base64url e o vocabulario de accoes e fechado — ambos ASCII puro —
 * para todo o input que esta funcao ACEITA, `utf8Bytes(data) === data.length`.
 * Medido: 200 000 tokens gerados, 170 003 aceites, ZERO divergencias. Ou seja,
 * **aqui o caso fecha por construcao e nao por medicao**, e trocar `utf8Bytes`
 * por `.length` seria um mutante equivalente. A medicao em bytes fica na mesma
 * porque o mesmo helper corre em {@link parseCallbackData}, onde a entrada vem
 * do cliente e NAO tem alfabeto garantido — e la a diferenca e real e ha teste
 * a prova-la. Escrever isto e mais honesto do que um teste que finge medir.
 */
export function buildCallbackData(action: IpcIntentName, token: string): string {
  if (token.length === 0) {
    throw new WorkerAuthError(
      'CALLBACK_DATA_EMPTY',
      `accao ${action} sem token: todo botao deste bot carrega um token emitido pelo host (S5)`,
    )
  }
  if (!TOKEN_ALPHABET.test(token)) {
    throw new WorkerAuthError(
      'CALLBACK_DATA_EMPTY',
      `token fora do alfabeto base64url para a accao ${action}: um separador dentro do token partiria o parser`,
    )
  }
  const data = `${CALLBACK_SCHEMA}${SEP}${action}${SEP}${token}`
  const bytes = utf8Bytes(data)
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new WorkerAuthError(
      'CALLBACK_DATA_TOO_LONG',
      `callback_data com ${bytes} bytes (limite ${CALLBACK_DATA_MAX_BYTES}); ` +
        `sao BYTES e nao caracteres — a string tem ${data.length} caracteres`,
    )
  }
  return data
}

/** Bytes UTF-8. A unidade em que a Bot API conta, e a unica que nao mente. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/** O que um `callback_data` bem formado carrega. O token continua opaco. */
export interface ParsedCallbackData {
  readonly action: IpcIntentName
  /** Opaco. O worker nao sabe o que e; o host sabe. */
  readonly token: string
}

/** Motivo de recusa especifico do `callback_data`. Nunca sai para o Telegram. */
export type CallbackDataRejection =
  /** Nao veio `data` nenhum, ou nao e string. */
  | 'deny:callback-data-absent'
  /** Acima dos 64 bytes: nao pode ter saido daqui. */
  | 'deny:callback-data-too-long'
  /** Prefixo de esquema errado — e aqui que `srv:off:v1` morre (TG-025). */
  | 'deny:callback-data-unknown-schema'
  /** Accao fora do vocabulario fechado do contrato IPC. */
  | 'deny:callback-data-unknown-action'
  /**
   * Accao conhecida, mas sem token: seria um comando administrativo accionavel
   * numa etapa. **Recusado** (TG-025).
   */
  | 'deny:callback-data-missing-token'
  /** Token presente mas fora do alfabeto base64url. */
  | 'deny:callback-data-malformed-token'

export type CallbackDataParse =
  | { readonly ok: true; readonly parsed: ParsedCallbackData }
  | { readonly ok: false; readonly reason: CallbackDataRejection }

/**
 * Le a FORMA do `callback_data`. **Nao decide autorizacao**, e nao pode.
 *
 * Repare no que esta funcao devolve quando corre bem: uma accao e uma string
 * opaca. Nao devolve "autorizado". A autorizacao ja foi decidida antes, pela
 * allowlist, sobre `from.id` e `chat.id` — que sao os unicos campos do update
 * que o cliente NAO controla.
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
  // Exactamente tres partes. `g1:tunnel.up:AAA:BBB` e recusado: uma gramatica
  // que aceita "e o resto" e uma gramatica onde o atacante escolhe o resto.
  if (parts.length !== 3) return { ok: false, reason: 'deny:callback-data-unknown-schema' }

  const [schema, action, token] = parts
  if (schema !== CALLBACK_SCHEMA) return { ok: false, reason: 'deny:callback-data-unknown-schema' }
  if (action === undefined || !isKnownAction(action)) {
    return { ok: false, reason: 'deny:callback-data-unknown-action' }
  }
  if (token === undefined || token.length === 0) {
    return { ok: false, reason: 'deny:callback-data-missing-token' }
  }
  if (!TOKEN_ALPHABET.test(token)) return { ok: false, reason: 'deny:callback-data-malformed-token' }

  return { ok: true, parsed: { action, token } }
}

/**
 * `Object.hasOwn` e nao `action in ...`: `in` percorre o prototipo, e
 * `'constructor'` ou `'toString'` responderiam `true`. Seria uma accao
 * "conhecida" que nao existe.
 */
function isKnownAction(action: string): action is IpcIntentName {
  return Object.hasOwn(INCREASES_EXPOSURE, action)
}

// ---------------------------------------------------------------------------
// Intencoes de saida
// ---------------------------------------------------------------------------

/**
 * Intencao de `answerCallbackQuery`. **Obrigatoria em todos os caminhos**
 * (TG-027).
 *
 * `text` ausente = nada e mostrado ao utilizador (a doc: *"Text of the
 * notification. If not specified, nothing will be shown to the user,
 * 0-200 characters."*). E exactamente o que se quer numa negacao: para o
 * girador, nao diz nada.
 */
export interface AnswerCallbackQueryIntent {
  /** `callback_query.id` — STRING na Bot API. */
  readonly callbackQueryId: string
  /** 0..200 caracteres. Ausente na negacao, sempre. */
  readonly text?: string | undefined
  readonly showAlert: boolean
}

/**
 * Registo de auditoria a escrever pelo chamador.
 *
 * PORQUE E UM VALOR DEVOLVIDO E NAO UM `sink` INJETADO: um sink chamado aqui
 * dentro obrigaria a decidir o que fazer quando ELE falha, e as duas saidas
 * seriam mas — engolir a excecao (proibido) ou deixar uma falha de escrita de
 * log derrubar o bot. Devolver a intencao poe essa decisao em quem tem contexto
 * para a tomar, e mantem esta camada pura.
 *
 * PORQUE `from`/`chat` VAO NO REGISTO: e o valor forense do descarte. "Contado"
 * sem "quem" nao diz ao dono se sao 300 tentativas de uma pessoa ou 3 de cem.
 */
export interface AuthAuditIntent {
  readonly evento: 'telegram.update.admitido' | 'telegram.update.descartado'
  readonly resultado: 'permitido' | 'negado'
  readonly motivo: DenyReason | CallbackDataRejection | 'ok'
  readonly surface: UpdateSurface
  readonly from?: number | undefined
  readonly chat?: number | undefined
}

/**
 * A decisao do funil. Uniao discriminada com TRES saidas e nenhuma quarta.
 *
 * Nao existe caminho "nao sei": um update ou vira comando, ou vira callback
 * autorizado a seguir para o host, ou e **descartado**. Nenhum ramo de erro
 * termina em "deixa passar".
 */
export type GuardDecision =
  | {
      readonly kind: 'command'
      readonly identity: UpdateIdentity
      readonly audit: AuthAuditIntent
    }
  | {
      readonly kind: 'callback'
      readonly identity: UpdateIdentity
      readonly action: IpcIntentName
      /** OPACO. Vai tal e qual para o host, que o valida (S5). */
      readonly token: string
      /** Se a accao aumenta exposicao. Informativo; o host decide na mesma. */
      readonly increasesExposure: boolean
      readonly answer: AnswerCallbackQueryIntent
      readonly audit: AuthAuditIntent
    }
  | {
      readonly kind: 'discarded'
      readonly reason: DenyReason | CallbackDataRejection
      readonly surface: UpdateSurface
      /**
       * Presente sempre que o update era um `callback_query` com `id` legivel —
       * inclusive na negacao (TG-027). `undefined` quando nao ha a quem
       * responder: nao havia `callback_query`, ou ele veio sem `id`.
       */
      readonly answer?: AnswerCallbackQueryIntent | undefined
      readonly audit: AuthAuditIntent
    }

// ---------------------------------------------------------------------------
// O funil
// ---------------------------------------------------------------------------

export interface GuardStats {
  readonly admitted: number
  readonly discarded: number
  /** Contagem por motivo. E o que o relatorio horario ao dono usa. */
  readonly byReason: Readonly<Record<string, number>>
}

export interface IdentityGuard {
  /**
   * O UNICO ponto de entrada. Todo update passa por aqui antes de virar
   * qualquer coisa.
   */
  admit(update: unknown): GuardDecision
  /** Contadores acumulados. `04-TESTES.md`: descartado **e contado**. */
  stats(): GuardStats
}

export interface IdentityGuardDeps {
  readonly allowlist: Allowlist
  /** Injetavel so para teste; o valor de producao vem de `allowlist.ts`. */
  readonly actionableSurfaces?: readonly UpdateSurface[] | undefined
}

/**
 * Constroi o funil.
 *
 * O UNICO estado que este objecto guarda sao CONTADORES. Nenhum nonce, nenhum
 * token consumido, nenhuma sessao. Se um dia aparecer aqui um `Map` de tokens,
 * a fronteira do S5 mudou de sitio e a revisao adversarial reprova.
 */
export function createIdentityGuard(deps: IdentityGuardDeps): IdentityGuard {
  let admitted = 0
  let discarded = 0
  const byReason = new Map<string, number>()

  function count(reason: string, allowed: boolean): void {
    if (allowed) {
      admitted += 1
    } else {
      discarded += 1
    }
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }

  return {
    admit(update: unknown): GuardDecision {
      const verdict: UpdateVerdict = decideUpdate(update, {
        allowlist: deps.allowlist,
        actionableSurfaces: deps.actionableSurfaces,
      })

      // Extrai o `id` da consulta MESMO quando o veredito e negativo: TG-027
      // exige responder em todos os caminhos, e nao ha como responder sem ele.
      const answerTarget = readCallbackQueryId(update)

      if (verdict.outcome === 'deny') {
        count(verdict.reason, false)
        return {
          kind: 'discarded',
          reason: verdict.reason,
          surface: verdict.surface,
          answer: silentAnswer(answerTarget),
          audit: {
            evento: 'telegram.update.descartado',
            resultado: 'negado',
            motivo: verdict.reason,
            surface: verdict.surface,
            from: verdict.from,
            chat: verdict.chat,
          },
        }
      }

      const { identity } = verdict

      if (identity.surface !== 'callback_query') {
        count('ok', true)
        return {
          kind: 'command',
          identity,
          audit: {
            evento: 'telegram.update.admitido',
            resultado: 'permitido',
            motivo: 'ok',
            surface: identity.surface,
            from: identity.from,
            chat: identity.chat,
          },
        }
      }

      // ---------------------------------------------------------------
      // A PARTIR DAQUI, A IDENTIDADE JA FOI REVALIDADA.
      // `decideUpdate` acabou de comparar `callback_query.from.id` (quem
      // carregou) E `callback_query.message.chat.id` (onde estava a mensagem)
      // contra a allowlist. Num grupo, sao numeros diferentes; em DM sao
      // iguais. E por isso que TG-003 existe.
      // ---------------------------------------------------------------
      const parse = parseCallbackData(readCallbackData(update))
      if (!parse.ok) {
        count(parse.reason, false)
        return {
          kind: 'discarded',
          reason: parse.reason,
          surface: identity.surface,
          answer: silentAnswer(answerTarget),
          audit: {
            evento: 'telegram.update.descartado',
            resultado: 'negado',
            motivo: parse.reason,
            surface: identity.surface,
            from: identity.from,
            chat: identity.chat,
          },
        }
      }

      if (answerTarget === undefined) {
        // Um `callback_query` sem `id` nao existe na Bot API. Se chegou assim, e
        // forjado ou o parser esta errado — em qualquer dos casos, NAO se
        // executa. Fail-closed: sem `id` nao ha como cumprir TG-027, e uma accao
        // que se executa sem poder responder e uma accao invisivel.
        count('deny:callback-data-absent', false)
        return {
          kind: 'discarded',
          reason: 'deny:callback-data-absent',
          surface: identity.surface,
          answer: undefined,
          audit: {
            evento: 'telegram.update.descartado',
            resultado: 'negado',
            motivo: 'deny:callback-data-absent',
            surface: identity.surface,
            from: identity.from,
            chat: identity.chat,
          },
        }
      }

      count('ok', true)
      return {
        kind: 'callback',
        identity,
        action: parse.parsed.action,
        token: parse.parsed.token,
        increasesExposure: INCREASES_EXPOSURE[parse.parsed.action],
        answer: { callbackQueryId: answerTarget, showAlert: false },
        audit: {
          evento: 'telegram.update.admitido',
          resultado: 'permitido',
          motivo: 'ok',
          surface: identity.surface,
          from: identity.from,
          chat: identity.chat,
        },
      }
    },

    stats(): GuardStats {
      return { admitted, discarded, byReason: Object.fromEntries(byReason) }
    },
  }
}

/**
 * A resposta da NEGACAO: para o girador e nao diz nada.
 *
 * Sem `text` e sem `showAlert`. Quem carregou no botao ve o girador parar e mais
 * nada — nao ve "nao autorizado", que confirmaria que o bot existe, esta vivo e
 * que ele tocou em algo real.
 */
function silentAnswer(callbackQueryId: string | undefined): AnswerCallbackQueryIntent | undefined {
  if (callbackQueryId === undefined) return undefined
  return { callbackQueryId, showAlert: false }
}

/** `callback_query.id`, quando existe e e string nao vazia. */
function readCallbackQueryId(update: unknown): string | undefined {
  if (typeof update !== 'object' || update === null) return undefined
  const cq = (update as Record<string, unknown>)['callback_query']
  if (typeof cq !== 'object' || cq === null) return undefined
  const id = (cq as Record<string, unknown>)['id']
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** `callback_query.data`, cru. Fornecido pelo cliente; tratado como tal. */
function readCallbackData(update: unknown): unknown {
  if (typeof update !== 'object' || update === null) return undefined
  const cq = (update as Record<string, unknown>)['callback_query']
  if (typeof cq !== 'object' || cq === null) return undefined
  return (cq as Record<string, unknown>)['data']
}
