/**
 * O TRANSPORTE: os DOIS transformers do cliente grammY — o auto-retry do 429
 * (lendo `parameters.retry_after` no relogio injetado) e o transporte-log
 * (testemunha a queda de rede, amostrada por potencia de dois).
 *
 * Ports fieis de `worker/lib/auto-retry.ts` e `worker/lib/transport-log.ts`
 * (DONO de referencia). NADA e importado de `worker/lib/*`; esta e a copia
 * declarada pela fronteira D4.
 *
 * ===========================================================================
 * PORQUE NAO RETRY CEGO
 * ===========================================================================
 * So se repete quando o servidor DIZ quanto esperar (`retry_after`), espera-se
 * exatamente esse tempo pelo relogio injetado (TG-043, `04-TESTES.md` 8.1), e
 * `getUpdates` sai daqui para o grammY: o grammY ja dorme `retry_after` no
 * ciclo de polling, e repetir dos DOIS lados dobra a indisponibilidade pedida
 * pelo servidor (ate 2x — medido na referencia).
 */

import type { ApiResponse } from 'grammy/types'
import type { Transformer } from 'grammy'

import { describeForLog, systemTime, type Sleeper, type WorkerLogger } from './interno.ts'

/* ========================================================================== */
/* Auto-retry do 429                                                          */
/* ========================================================================== */

/** Uma repeticao. Se a segunda tentativa tambem leva 429, o problema nao e ritmo. */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 1

/** Acima disto nao se espera: devolve-se o erro e deixa-se o chamador decidir. */
export const DEFAULT_MAX_DELAY_SECONDS = 60

/** O unico codigo que traz `retry_after` na Bot API. */
export const TOO_MANY_REQUESTS = 429

/**
 * Metodos cujo 429 NAO e repetido aqui. So `getUpdates`, e a razao esta no
 * cabecalho: o grammY ja dorme `retry_after` no ciclo de polling.
 */
export const METODOS_SEM_RETRY: readonly string[] = ['getUpdates']

export interface AutoRetryOptions {
  readonly maxRetryAttempts?: number
  readonly maxDelaySeconds?: number
  readonly time?: Sleeper
  readonly log?: WorkerLogger
}

/**
 * Quantos segundos o servidor mandou esperar, ou `undefined` se ele nao mandou.
 */
export function retryAfterSeconds(response: ApiResponse<unknown>): number | undefined {
  if (response.ok) return undefined
  if (response.error_code !== TOO_MANY_REQUESTS) return undefined
  const value = response.parameters?.retry_after
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  // Um `retry_after` negativo e lixo; trata-se como "ja podes", nao como erro.
  return value < 0 ? 0 : value
}

export function createAutoRetryTransformer(options: AutoRetryOptions = {}): Transformer {
  const maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS
  const maxDelaySeconds = options.maxDelaySeconds ?? DEFAULT_MAX_DELAY_SECONDS
  const time = options.time ?? systemTime
  const log = options.log

  return async (prev, method, payload, signal) => {
    let attempts = 0
    for (;;) {
      const response = await prev(method, payload, signal)

      // O polling tem dono, e nao e este.
      if (METODOS_SEM_RETRY.includes(method)) return response

      const seconds = retryAfterSeconds(response)

      // Sucesso, ou um erro que nao diz quanto esperar: devolve-se como esta.
      // NAO se lanca — quem lanca e o grammY, uma camada acima.
      if (seconds === undefined) return response

      if (attempts >= maxRetryAttempts) {
        log?.warn('429 persistente: orcamento de repeticoes esgotado', {
          method,
          retry_after: seconds,
          attempts,
        })
        return response
      }
      if (seconds > maxDelaySeconds) {
        log?.warn('429 com retry_after acima do tecto: nao se espera', {
          method,
          retry_after: seconds,
          max_delay_seconds: maxDelaySeconds,
        })
        return response
      }

      attempts += 1
      log?.warn('429: a esperar o retry_after indicado pelo servidor', {
        method,
        retry_after: seconds,
        attempt: attempts,
      })
      await time.sleep(seconds * 1000, signal)

      // A espera pode ter sido encurtada por um `abort` (o worker esta a fechar).
      if (signal?.aborted === true) {
        log?.debug('espera do 429 abortada: nao se repete a chamada', { method })
        return response
      }
    }
  }
}

/* ========================================================================== */
/* Transporte-log (testemunha da rede)                                        */
/* ========================================================================== */

/**
 * A partir daqui a falha deixa de ser "um blip" e passa a `error`.
 * Cinco tentativas com o retry de 3 s do grammY sao ~15 s sem rede.
 */
export const ESCALATE_AFTER = 5

export interface TransportLogOptions {
  readonly log: WorkerLogger
  /** Segredos literais a mascarar. FUNCAO, para acompanhar rotacao. */
  readonly secrets?: () => readonly string[]
}

/** `true` para 1, 2, 4, 8, 16... (amostragem por potencia de dois). */
export function isSamplePoint(consecutive: number): boolean {
  return consecutive > 0 && (consecutive & (consecutive - 1)) === 0
}

export function createTransportLogTransformer(options: TransportLogOptions): Transformer {
  const secretsOf = options.secrets ?? ((): readonly string[] => [])
  // Estado do CLOSURE, nao do modulo: duas instancias de bot contam as suas
  // proprias falhas, que e o que torna o teste honesto.
  let consecutive = 0

  return async (prev, method, payload, signal) => {
    try {
      const response = await prev(method, payload, signal)
      if (consecutive > 0) {
        options.log.info('transporte recuperado: a Bot API voltou a responder', {
          method,
          falhas_seguidas: consecutive,
        })
        consecutive = 0
      }
      return response
    } catch (error) {
      consecutive += 1
      if (isSamplePoint(consecutive)) {
        const mensagem =
          'o pedido HTTP a Bot API falhou (rede). O bot continua vivo e volta a tentar.'
        const campos = {
          method,
          falhas_seguidas: consecutive,
          detail: describeForLog(error, secretsOf()),
        }
        if (consecutive >= ESCALATE_AFTER) options.log.error(mensagem, campos)
        else options.log.warn(mensagem, campos)
      }
      // RELANCA. O grammY precisa do erro para decidir dormir e repetir.
      throw error
    }
  }
}