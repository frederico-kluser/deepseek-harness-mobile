/**
 * O TRANSPORTE do adaptador discord: o auto-retry do 429 do REST.
 *
 * Port do `transporte.ts` do telegram (fronteira D4). Aqui o transporte nao
 * sao transformers do grammY — e um wrapper em volta do cliente `fetch`
 * (`./cliente.ts`).
 *
 * ===========================================================================
 * PORQUE NAO RETRY CEGO
 * ===========================================================================
 * So se repete quando o servidor DIZ quanto esperar (`retry_after` do corpo do
 * 429), e espera-se exatamente esse tempo pelo relogio injetado (TG-043,
 * `04-TESTES.md` 8.1). Repetir sem o servidor mandar e transformar um ritmo
 * errado numa martelada no servidor.
 *
 * ===========================================================================
 * E A REDE (status 0)? — NAO SE REPETE AQUI, DE PROPOSITO
 * ===========================================================================
 * `POST /channels/{id}/messages` NAO e idempotente: uma queda de rede pode
 * ter deixado a mensagem a caminho, e repetir cegamente DUPLICA a mensagem.
 * Quem precisa de resiliencia de rede tem dono proprio: o loop do gateway
 * (`./gateway.ts`) reconecta com backoff, e o sender do adaptador loga e
 * devolve o erro ao nucleo (S4 — o nucleo nao derruba o canal por uma falha
 * de envio).
 */

import { DiscordApiError } from './cliente.ts'
import type { Sleeper, WorkerLogger } from './interno.ts'
import { systemTime } from './interno.ts'

/** Uma repeticao. Se a segunda tentativa tambem leva 429, o problema nao e ritmo. */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 1

/** Acima disto nao se espera: devolve-se o erro e deixa-se o chamador decidir. */
export const DEFAULT_MAX_DELAY_SECONDS = 60

/** O unico codigo HTTP que traz `retry_after` na API do Discord. */
export const TOO_MANY_REQUESTS = 429

export interface AutoRetryOptions {
  readonly maxRetryAttempts?: number
  readonly maxDelaySeconds?: number
  readonly time?: Sleeper
  readonly log?: WorkerLogger
}

/**
 * Repete a chamada enquanto o servidor pedir espera (429 com `retry_after`).
 *
 * Devolve o resultado da primeira tentativa que nao for um 429 com espera
 * conhecida. NUNCA repete erro de rede (status 0) nem 429 sem `retry_after`
 * (o servidor nao disse quanto esperar — repetir seria retry cego).
 */
export async function comAutoRetry<T>(
  fazer: () => Promise<T>,
  options: AutoRetryOptions = {},
): Promise<T> {
  const maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS
  const maxDelayMs = (options.maxDelaySeconds ?? DEFAULT_MAX_DELAY_SECONDS) * 1000
  const time = options.time ?? systemTime
  const log = options.log

  let attempts = 0
  for (;;) {
    try {
      return await fazer()
    } catch (error) {
      if (!(error instanceof DiscordApiError)) throw error
      if (error.status !== TOO_MANY_REQUESTS || error.retryAfterMs === undefined) throw error
      if (attempts >= maxRetryAttempts) {
        log?.warn('429 persistente: orcamento de repeticoes esgotado', {
          retry_after_ms: error.retryAfterMs,
          attempts,
        })
        throw error
      }
      if (error.retryAfterMs > maxDelayMs) {
        log?.warn('429 com retry_after acima do tecto: nao se espera', {
          retry_after_ms: error.retryAfterMs,
          max_delay_ms: maxDelayMs,
        })
        throw error
      }
      attempts += 1
      log?.warn('429: a esperar o retry_after indicado pelo servidor', {
        retry_after_ms: error.retryAfterMs,
        attempt: attempts,
      })
      await time.sleep(error.retryAfterMs)
    }
  }
}
