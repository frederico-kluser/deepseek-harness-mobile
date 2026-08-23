/**
 * LONG POLLING do adaptador telegram: a sequencia de boot
 * `getMe -> deleteWebhook{drop_pending_updates:true} -> getUpdates`, com
 * `allowed_updates: ['message','callback_query']`, `timeout: 50`, classificacao
 * terminal de 409/401 (ZERO reconexoes) e prazo de arranque. Port fiel de
 * `worker/lib/polling.ts`.
 *
 * ===========================================================================
 * PORQUE LONG POLLING E NAO WEBHOOK
 * ===========================================================================
 * Com o token, um atacante personifica o bot e rouba a fila de updates. O que
 * ele NAO consegue e FABRICAR um update com identidade allowlistada: todas as
 * accoes partem de updates de ENTRADA, e em long polling nao existe endpoint
 * nosso onde forjar um POST. ISSO E PROPRIEDADE DO DESENHO.
 *
 * ===========================================================================
 * DESCARTE DA FILA NO BOOT (`drop_pending_updates`)
 * ===========================================================================
 * Updates ficam ate 24 h no servidor. Um bot que liga e desliga nao pode
 * executar uma avalanche de comandos velhos ao voltar. `drop_pending_updates`
 * **NAO e parametro de `getUpdates`** — e de `setWebhook`/`deleteWebhook`. O
 * `bot.start({ drop_pending_updates: true })` do grammY traduz-se em
 * `deleteWebhook{drop_pending_updates:true}`, e a sequencia observada foi
 * `getMe -> deleteWebhook -> getUpdates`. Este teste assere a chamada ONDE ELA
 * EXISTE.
 *
 * ===========================================================================
 * `allowed_updates` ENVIADO EXPLICITAMENTE — SEMPRE
 * ===========================================================================
 * Omitir significa MANTER O QUE LA ESTAVA — estado invisivel no servidor. O
 * grammY manda `allowed_updates` so no PRIMEIRO `getUpdates` do ciclo e omite-o
 * depois (poupa trafego, e correto — o valor ja ficou fixado).
 *
 * ===========================================================================
 * O PRAZO DE ARRANQUE (`DEFAULT_BOOT_TIMEOUT_MS` = 45 s)
 * ===========================================================================
 * MEDIDO no artefacto compilado do grammY 1.45.1: um bug de unidades entra um
 * sono de **100 s** na segunda tentativa do `withRetries` do `getMe` quando a
 * rede falha no boot — e o processo fica VIVO, CALADO e SEM SAIR. Passado o
 * prazo, o adaptador RELATA e garante a saida; a politica de reinicio volta a
 * quem a deve tomar (o supervisor do host).
 */

import { GrammyError, type Bot, type Context } from 'grammy'

import {
  ProviderError,
  type ProviderErrorCode,
  exitCodeFor,
  describeForLog,
  WORKER_EXIT,
  type WorkerLogger,
} from './interno.ts'

/** Tecto do servidor, do fonte do `telegram-bot-api`. Nao e opiniao nossa. */
export const LONG_POLL_MAX_TIMEOUT = 50

/** Os DOIS tipos de update que este bot trata. Fechado de proposito. */
export const ALLOWED_UPDATES = Object.freeze(['message', 'callback_query'] as const)

/** Prazo para o arranque chegar a receber updates. Ver a medicao no cabecalho. */
export const DEFAULT_BOOT_TIMEOUT_MS = 45_000

/** 409 de polling duplicado, verbatim de `tdlib/telegram-bot-api/Client.cpp`. */
export const CONFLICT_OTHER_GET_UPDATES = 409
/** 401: token errado ou revogado. */
export const UNAUTHORIZED = 401

/** Como o polling terminou. */
export type PollingOutcome =
  | { readonly kind: 'stopped'; readonly exitCode: number }
  | {
      readonly kind: 'fatal'
      readonly code: ProviderErrorCode
      readonly exitCode: number
      readonly error: unknown
    }

/** Opcoes de polling. Os tres valores que interessam sao explicitos. */
export interface TelegramPollingOptions {
  readonly timeout: number
  readonly allowed_updates: readonly ('message' | 'callback_query')[]
  readonly drop_pending_updates: boolean
  readonly limit: number
  readonly onStart?: ((botInfo: { username: string | undefined }) => Promise<void>) | undefined
}

/**
 * Guarda de sanidade sobre as opcoes — Lanca em vez de corrigir em silencio.
 * O gap historico: `allowed_updates: []` e o "reset to default" do grammY, ou
 * seja a superficie FECHADA de dois tipos abria-se para o conjunto por omissao.
 */
export function assertPollingOptions(options: TelegramPollingOptions): void {
  if (options.allowed_updates === undefined) {
    throw new ProviderError(
      'POLLING_FAILED',
      'allowed_updates omitido: o servidor MANTERIA a configuracao anterior, ' +
        'que e estado invisivel guardado do lado do Telegram.',
    )
  }
  if (options.allowed_updates.length === 0) {
    throw new ProviderError(
      'POLLING_FAILED',
      'allowed_updates vazio: na Bot API isso NAO e "nenhum", e o reset para o ' +
        'conjunto por omissao — abre a superficie fechada para mais de vinte.',
    )
  }
  if (options.timeout === undefined || options.timeout > LONG_POLL_MAX_TIMEOUT) {
    throw new ProviderError(
      'POLLING_FAILED',
      `timeout tem de existir e ser <= ${LONG_POLL_MAX_TIMEOUT} (o servidor clampa la de qualquer forma).`,
    )
  }
  if (options.drop_pending_updates !== true) {
    throw new ProviderError(
      'POLLING_FAILED',
      'drop_pending_updates tem de ser true no boot: ate 24 h de comandos represados ' +
        'executariam de uma vez ao arrancar.',
    )
  }
}

/**
 * Classifica um erro que fez `bot.start()` rejeitar. O grammY faz retry de tudo
 * menos 401 e 409 (MEDIDO em `out/bot.js`); chegar aqui ja significa
 * "terminal" — o que falta e dizer QUAL.
 */
export function classifyPollingError(error: unknown): {
  readonly code: ProviderErrorCode
  readonly exitCode: number
  readonly message: string
} {
  if (error instanceof GrammyError && error.error_code === CONFLICT_OTHER_GET_UPDATES) {
    return {
      code: 'POLLING_CONFLICT',
      exitCode: exitCodeFor('POLLING_CONFLICT'),
      message:
        'CONFLITO 409: outro getUpdates esta a correr com este mesmo token. ' +
        'Nao existe segundo consumidor legitimo. O processo SAI: reiniciar cegamente ' +
        'produz flapping infinito, porque o 409 mata a instancia que JA estava pendurada, ' +
        'nunca a que chega. Verifique se ha outro worker vivo (ou revogue o token no BotFather).',
    }
  }
  if (error instanceof GrammyError && error.error_code === UNAUTHORIZED) {
    return {
      code: 'POLLING_UNAUTHORIZED',
      exitCode: exitCodeFor('POLLING_UNAUTHORIZED'),
      message:
        'NAO AUTORIZADO 401: o token do bot foi recusado. Foi revogado, ou a ' +
        'variavel de ambiente traz outro valor. Fale com o @BotFather.',
    }
  }
  return {
    code: 'POLLING_FAILED',
    exitCode: exitCodeFor('POLLING_FAILED'),
    message: 'o long polling terminou com erro terminal.',
  }
}

export interface RunPollingDeps {
  readonly bot: Pick<Bot<Context>, 'start' | 'stop'>
  readonly log: WorkerLogger
  readonly options?: TelegramPollingOptions
  readonly secrets?: () => readonly string[]
  readonly bootTimeoutMs?: number
}

/**
 * Corre o long polling até ele acabar e devolve um veredito. NAO chama
 * `process.exit`; o erro NUNCA e engolido — ou volta dentro do `PollingOutcome`,
 * ou nao chega aqui.
 */
export async function runPolling(deps: RunPollingDeps): Promise<PollingOutcome> {
  const options = deps.options ?? {
    timeout: LONG_POLL_MAX_TIMEOUT,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: true,
    limit: 100,
  }
  const secretsOf = deps.secrets ?? ((): readonly string[] => [])

  assertPollingOptions(options)

  deps.log.info('a arrancar o long polling', {
    timeout: options.timeout,
    allowed_updates: options.allowed_updates,
    drop_pending_updates: options.drop_pending_updates,
  })

  const bootTimeoutMs = deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
  let arrancou = false
  const comOnStart = {
    ...options,
    onStart: async (botInfo: { username: string | undefined }): Promise<void> => {
      arrancou = true
      deps.log.info('arranque concluido: a receber updates', { bot: botInfo.username })
      await options.onStart?.(botInfo)
    },
  }

  const prazo = new Promise<'boot-timeout'>((resolve) => {
    const timer = setTimeout(() => {
      if (!arrancou) resolve('boot-timeout')
    }, bootTimeoutMs)
    timer.unref()
  })

  try {
    const started = deps.bot.start(comOnStart as Parameters<Bot<Context>['start']>[0])
    /* Se o prazo ganhar a corrida, `started` fica pendente e pode rejeitar mais
       tarde, sem ninguem a ouvir. Este ouvinte NAO engole. */
    void started.catch(() => undefined)

    const resultado = await Promise.race([started.then(() => 'stopped' as const), prazo])

    if (resultado === 'boot-timeout') {
      const erro = new ProviderError(
        'BOOT_TIMEOUT',
        `o arranque nao chegou a receber updates em ${bootTimeoutMs} ms`,
      )
      deps.log.error(
        'ARRANQUE ENCRAVADO: passaram ' +
          `${bootTimeoutMs} ms sem o polling comecar. Causa tipica: a Bot API esta inalcancavel ` +
          'e o retry interno do grammY entrou num sono longo. O adaptador SAI para que o ' +
          'supervisor do host aplique a sua propria politica de reinicio.',
        { code: erro.code, exit_code: exitCodeFor(erro.code), boot_timeout_ms: bootTimeoutMs },
      )
      await pararComCuidado(deps)
      return { kind: 'fatal', code: erro.code, exitCode: exitCodeFor(erro.code), error: erro }
    }

    deps.log.info('long polling terminado a pedido')
    return { kind: 'stopped', exitCode: WORKER_EXIT.OK }
  } catch (error) {
    const verdict = classifyPollingError(error)
    deps.log.error(verdict.message, {
      code: verdict.code,
      exit_code: verdict.exitCode,
      cause: describeForLog(error, secretsOf()),
    })
    return { kind: 'fatal', code: verdict.code, exitCode: verdict.exitCode, error }
  }
}

/** Tenta parar o bot depois do prazo de arranque. NAO engole em silencio. */
async function pararComCuidado(deps: RunPollingDeps): Promise<void> {
  try {
    await deps.bot.stop()
  } catch (error) {
    deps.log.debug('bot.stop falhou depois do prazo de arranque', {
      detail: describeForLog(error),
    })
  }
}