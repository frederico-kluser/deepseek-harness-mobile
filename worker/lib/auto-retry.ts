/**
 * Auto-retry do 429, LENDO `parameters.retry_after`. Nunca retry cego.
 *
 * ===========================================================================
 * PORQUE UM TRANSFORMER PROPRIO E NAO `@grammyjs/auto-retry`
 * ===========================================================================
 * Duas razoes, e a primeira e um gate:
 *
 *  1. `09-DECISOES-CANONICAS.md` D23 autoriza UMA dependencia de runtime, com
 *     nome e versao: `"dependencies": { "grammy": "1.45.1" }`. O criterio de
 *     aceite da Onda 4 e literal — `diff <(pnpm ls --prod --depth 0)` contra o
 *     baseline commitado tem de mostrar `grammy` e MAIS NADA. O plugin oficial
 *     e um pacote npm separado (`@grammyjs/auto-retry`): instala-lo seria uma
 *     SEGUNDA linha nesse diff, ou seja, reprovar o gate para poupar 40 linhas.
 *
 *  2. TG-043 exige «espera exatamente 3 s PELO RELOGIO INJETADO». O plugin
 *     oficial dorme com `setTimeout` real, e mede-lo obrigaria a mockar timers
 *     globalmente — que e precisamente o que `04-TESTES.md` 8.1 proibe. Com a
 *     espera injetada, o teste e uma igualdade, nao uma tolerancia.
 *
 * O ALGORITMO e o mesmo do plugin oficial, e isso e deliberado: um transformer
 * ve a `ApiResponse` ANTES de o grammY a converter em `GrammyError`
 * (`out/core/client.js:97-100`), portanto o 429 chega aqui como dado — com
 * `parameters.retry_after` intacto — e nao como excecao.
 *
 * ===========================================================================
 * PORQUE NUNCA RETRY CEGO
 * ===========================================================================
 * Um 429 diz "estas a mandar depressa demais". Repetir imediatamente adiciona
 * carga ao servidor que ja te esta a mandar parar: AMPLIFICA o problema que a
 * resposta existe para resolver, e o Telegram responde alargando a janela. Por
 * isso, aqui:
 *
 *   - so se repete quando o servidor DIZ quanto esperar (`retry_after`);
 *   - espera-se exatamente esse tempo, nem mais nem menos;
 *   - repete-se no maximo {@link DEFAULT_MAX_RETRY_ATTEMPTS} vez;
 *   - e um `retry_after` absurdo (acima de {@link DEFAULT_MAX_DELAY_SECONDS})
 *     NAO e esperado: um worker que dorme uma hora com o chat pendurado e
 *     indistinguivel de um worker morto, e o erro devolvido ao chamador da-lhe
 *     a hipotese de dizer isso ao dono.
 *
 * Erro de REDE nao e tratado aqui: ele nao produz `ApiResponse` nenhuma, sobe
 * como excecao e quem o TESTEMUNHA e `./transport-log.ts`, que fica por baixo
 * deste transformer. Aqui ele apenas atravessa.
 *
 * ===========================================================================
 * `getUpdates` E EXCLUIDO — E ISTO CORRIGE UM FACTO ERRADO
 * ===========================================================================
 * A versao anterior deste cabecalho afirmava que «o 429 do proprio polling nao
 * passa por aqui». **PASSA.** A revisao adversarial mediu-o: um 429 com
 * `retry_after: 7` em `getUpdates` produziu `sleeps = [7000]` neste transformer.
 * A afirmacao estava errada num ficheiro cuja autoridade e a medicao, o que e
 * pior do que o defeito que ela escondia.
 *
 * E escondia um: o grammY JA trata o 429 do polling em `handlePollingError`
 * (`out/bot.js`), dormindo `error.parameters.retry_after`. Com o transformer a
 * dormir tambem, uma repeticao que voltasse a levar 429 custava
 * `retry_after` AQUI **mais** `retry_after` LA — ate **2x a indisponibilidade
 * pedida pelo servidor** (120 s para um `retry_after: 60`).
 *
 * DECISAO: `getUpdates` sai daqui e fica inteiramente com o grammY. Tres razoes:
 *
 *  1. **Um so dono para cada caminho.** O polling ja tem tratamento canonico,
 *     medido, na biblioteca; duplica-lo nao acrescenta correcao, acrescenta
 *     espera.
 *  2. **Esperar a MAIS tambem e um defeito.** Amplificar (esperar de menos) e o
 *     erro obvio; dormir o dobro do que o servidor pediu e o erro silencioso,
 *     e num bot que anuncia estado de tunel a indisponibilidade custa.
 *  3. **Este transformer existe para o que o grammY NAO faz:** repetir as
 *     chamadas de SAIDA (`sendMessage`, `editMessageText`, ...), onde nao ha
 *     retry nenhum na biblioteca.
 */

import type { ApiResponse } from 'grammy/types'
import type { Transformer } from 'grammy'

import { systemTime, type Sleeper } from './clock.ts'
import type { WorkerLogger } from './log.ts'

/** Uma repeticao. Se a segunda tentativa tambem leva 429, o problema nao e ritmo. */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 1

/** Acima disto nao se espera: devolve-se o erro e deixa-se o chamador decidir. */
export const DEFAULT_MAX_DELAY_SECONDS = 60

/** O unico codigo que traz `retry_after` na Bot API. */
export const TOO_MANY_REQUESTS = 429

/**
 * Metodos cujo 429 NAO e repetido aqui.
 *
 * So `getUpdates`, e a razao esta no cabecalho: o grammY ja dorme
 * `retry_after` no ciclo de polling, e repetir dos dois lados dobra a espera.
 */
export const METODOS_SEM_RETRY: readonly string[] = ['getUpdates']

export interface AutoRetryOptions {
  /** Quantas repeticoes, no maximo. Omitido, {@link DEFAULT_MAX_RETRY_ATTEMPTS}. */
  readonly maxRetryAttempts?: number
  /** Tecto do `retry_after` aceite. Omitido, {@link DEFAULT_MAX_DELAY_SECONDS}. */
  readonly maxDelaySeconds?: number
  /** A espera. Injetada — ver o cabecalho e `./clock.ts`. */
  readonly time?: Sleeper
  readonly log?: WorkerLogger
}

/**
 * Quantos segundos o servidor mandou esperar, ou `undefined` se ele nao mandou.
 *
 * `undefined` e a resposta certa para tudo o que nao seja um 429 com um
 * `retry_after` numerico e finito: e essa ausencia que impede o retry cego.
 */
export function retryAfterSeconds(response: ApiResponse<unknown>): number | undefined {
  if (response.ok) return undefined
  if (response.error_code !== TOO_MANY_REQUESTS) return undefined
  const value = response.parameters?.retry_after
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  // Um `retry_after` negativo e lixo; trata-se como "ja podes", nao como erro.
  return value < 0 ? 0 : value
}

/**
 * Constroi o transformer. Instala-se com `bot.api.config.use(...)`.
 *
 * Sem estado de modulo: o contador de tentativas vive na chamada, o que torna
 * duas chamadas concorrentes independentes — como tem de ser, ja que o 429 de
 * uma nao diz nada sobre a outra.
 */
export function createAutoRetryTransformer(options: AutoRetryOptions = {}): Transformer {
  const maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS
  const maxDelaySeconds = options.maxDelaySeconds ?? DEFAULT_MAX_DELAY_SECONDS
  const time = options.time ?? systemTime
  const log = options.log

  return async (prev, method, payload, signal) => {
    let attempts = 0
    for (;;) {
      const response = await prev(method, payload, signal)

      // O polling tem dono, e nao e este. Ver METODOS_SEM_RETRY.
      if (METODOS_SEM_RETRY.includes(method)) return response

      const seconds = retryAfterSeconds(response)

      // Sucesso, ou um erro que nao diz quanto esperar: devolve-se como esta.
      // NAO se lanca — quem lanca e o grammY, uma camada acima, e lancar aqui
      // transformaria um `GrammyError` num `HttpError` (ver a doc de `HttpError`).
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
      // Repetir a chamada agora seria mandar um pedido que ja ninguem espera —
      // e, do lado do Telegram, seria exatamente o retry cego que o `retry_after`
      // pediu para nao acontecer.
      if (signal?.aborted === true) {
        log?.debug('espera do 429 abortada: nao se repete a chamada', { method })
        return response
      }
    }
  }
}
