/**
 * O cliente grammY: `apiRoot`, auto-retry do 429, e `bot.catch`.
 *
 * ===========================================================================
 * `bot.catch` TEM DE COBRIR `HttpError`, E NAO SO `GrammyError`
 * ===========================================================================
 * Sao coisas diferentes, e tratar so a primeira e o defeito classico:
 *
 *   - `GrammyError` — falamos com o Telegram E ELE RESPONDEU COM ERRO. Tem
 *     `method`, `error_code`, `description` e `parameters`. E diagnostico.
 *   - `HttpError`   — o pedido HTTP nem chegou a ter resposta. E QUEDA DE REDE:
 *     o Wi-Fi caiu, o DNS falhou, o portatil suspendeu. Num bot domestico isto
 *     acontece todas as semanas.
 *
 * Esquecer o `HttpError` deixa o processo morrer por queda de Wi-Fi — e o
 * operador ve "o bot para sozinho de vez em quando", que e o bug mais caro de
 * diagnosticar que existe.
 *
 * >>> MAS `bot.catch` **NAO** APANHA A REDE DO POLLING. <<< Ele cobre erros de
 * MIDDLEWARE, e o ciclo de `getUpdates` nao passa por middleware nenhum — o
 * grammY manda-o para o `debug`, que e mudo sem a variavel `DEBUG`. Quem
 * testemunha a queda de rede e `./transport-log.ts`, instalado como transformer.
 * O ramo `HttpError` daqui continua a valer para o que ACONTECE em middleware
 * (um `ctx.reply` durante uma queda, por exemplo), e e por isso que os dois
 * existem em vez de um.
 *
 * ===========================================================================
 * O TOKEN DENTRO DE UMA MENSAGEM DE ERRO QUE CITA A URL
 * ===========================================================================
 * Esta e a pergunta 5 da revisao, e tem resposta em duas camadas:
 *
 *  1. `sensitiveLogs: false` — DECLARADO EXPLICITAMENTE, apesar de ja ser o
 *     default do grammY. Com ele a `false`, `toHttpError` NAO concatena a
 *     mensagem do erro subjacente (`out/core/error.js`), e e essa mensagem que
 *     traz `request to https://api.telegram.org/bot<id>:<segredo>/getUpdates
 *     failed` — o formato literal do `node-fetch`, que e o cliente HTTP que o
 *     grammY 1.45.1 usa no Node. Declarar o default e barato; herda-lo em
 *     silencio significa que a versao seguinte pode mudar-lho debaixo dos pes.
 *
 *  2. `redact()` COM O TOKEN COMO LITERAL CONHECIDO — porque `HttpError.error`
 *     continua a guardar o erro original, com a URL inteira la dentro, e basta
 *     alguem registar `err.error` para o vazar. A camada 1 protege o caminho
 *     que o grammY controla; a camada 2 protege o resto.
 */

import { Bot, GrammyError, HttpError, type ApiClientOptions, type Context } from 'grammy'

import { createAutoRetryTransformer, type AutoRetryOptions } from './auto-retry.ts'
import { createTransportLogTransformer } from './transport-log.ts'
import { systemTime, type TimeSource } from './clock.ts'
import { WorkerError } from './errors.ts'
import type { WorkerLogger } from './log.ts'
import { describeForLog } from './redact.ts'

export interface CreateBotOptions {
  readonly token: string
  /**
   * Raiz da Bot API. Nos testes aponta para `test/support/telegram-server.mjs`.
   *
   * MEDIDO (spike S5): o grammY redireciona MESMO as chamadas para aqui, e o
   * caminho da opcao e `new Bot(token, { client: { apiRoot } })`. `http:` e
   * aceite — `out/platform.node.js` escolhe o agente pelo prefixo — portanto o
   * duble nao precisa de TLS.
   */
  readonly apiRoot?: string
  readonly log: WorkerLogger
  readonly time?: TimeSource
  readonly autoRetry?: AutoRetryOptions
}

/**
 * Tira a barra final do `apiRoot`.
 *
 * MEDIDO: o grammY LANCA com barra final («Remove the trailing '/' from the
 * 'apiRoot' option», `out/core/client.js:86-87`) — nao normaliza. Como este
 * valor vem de uma variavel de ambiente escrita a mao, deixar o processo morrer
 * no arranque por causa de uma barra seria transformar um erro de dactilografia
 * numa indisponibilidade.
 */
export function normalizeApiRoot(apiRoot: string): string {
  return apiRoot.replace(/\/+$/u, '')
}

/**
 * Traduz um erro do grammY para uma linha que um humano consegue accionar.
 *
 * Devolve texto E campos: a mensagem diz o que aconteceu, os campos dizem
 * contra que metodo. Tudo ja mascarado.
 */
export function describeBotError(
  error: unknown,
  secrets: readonly string[] = [],
): { readonly message: string; readonly fields: Readonly<Record<string, unknown>> } {
  if (error instanceof GrammyError) {
    return {
      message: 'a Bot API respondeu com erro',
      fields: {
        kind: 'GrammyError',
        method: error.method,
        error_code: error.error_code,
        // A `description` vem do servidor. Passa por `redact` na mesma: e texto
        // de terceiros e nao ha razao para confiar no que la vem.
        description: describeForLog(error.description, secrets),
        retry_after: error.parameters.retry_after,
      },
    }
  }
  if (error instanceof HttpError) {
    return {
      message: 'o pedido HTTP a Bot API falhou (rede) — o bot continua vivo e volta a tentar',
      fields: {
        kind: 'HttpError',
        // `error.message` ja vem sem a URL por causa de `sensitiveLogs: false`;
        // `error.error` NAO vem, e e por isso que passa por `describeForLog`.
        detail: describeForLog(error.message, secrets),
        cause: describeForLog(error.error, secrets),
      },
    }
  }
  return {
    message: 'erro nao tratado no middleware do bot',
    fields: { kind: 'Error', detail: describeForLog(error, secrets) },
  }
}

/**
 * O handler de `bot.catch`.
 *
 * NUNCA relanca e NUNCA fica calado: relancar dentro do `bot.catch` mata o
 * processo por um erro que ja foi tratado; ficar calado transforma uma falha
 * num nada observavel. Regista e segue — o polling continua.
 */
export function createErrorHandler(
  log: WorkerLogger,
  secretsOf: () => readonly string[] = () => [],
): (error: { readonly error: unknown; readonly ctx?: unknown }) => void {
  return (botError) => {
    const secrets = secretsOf()
    const { message, fields } = describeBotError(botError.error, secrets)
    log.error(message, fields)
  }
}

/**
 * Monta o bot.
 *
 * O token e validado aqui e nao no `Bot`: o grammY aceita string vazia e so
 * falha no `getMe`, com um 404 do servidor — mensagem que nao ajuda ninguem.
 */
export function createBot(options: CreateBotOptions): Bot<Context> {
  const token = options.token.trim()
  if (token === '') {
    throw new WorkerError('TOKEN_MISSING', 'token vazio: nao ha bot para construir')
  }

  const time = options.time ?? systemTime
  const secretsOf = (): readonly string[] => [token]

  const client: ApiClientOptions = {
    // Ver o cabecalho: explicito, e nao herdado.
    sensitiveLogs: false,
    ...(options.apiRoot === undefined ? {} : { apiRoot: normalizeApiRoot(options.apiRoot) }),
  }

  const bot = new Bot<Context>(token, { client })

  /* A ORDEM E DELIBERADA, e foi medida.
     ------------------------------------------------------------------------
     `use()` faz `transformers.reduce(concatTransformer, this.call)`
     (`out/core/client.js`), portanto o ULTIMO instalado fica por FORA. O
     registo de transporte entra PRIMEIRO — fica encostado a rede — para ver
     cada tentativa HTTP real, e nao so a ultima de uma serie de repeticoes.
     O auto-retry fica por fora, a decidir se ha outra tentativa. */
  bot.api.config.use(
    createTransportLogTransformer({ log: options.log, secrets: secretsOf }),
    createAutoRetryTransformer({
      time,
      log: options.log,
      ...options.autoRetry,
    }),
  )

  bot.catch(createErrorHandler(options.log, secretsOf))

  return bot
}
