/**
 * O ADAPTADOR TELEGRAM: `createTelegramProvider(deps) -> ProviderAdapter`.
 * Consome SO o contrato neutro `worker/surface/contract.ts` (e, como
 * referencia de consumo, `worker/surface/core.ts`); o grammY vive
 * EXCLUSIVAMENTE neste diretorio.
 *
 * ===========================================================================
 * A DIVISAO (D4)
 * ===========================================================================
 * ENTRADA: o adaptador e DONO do SEU proprio loop de consumo (long polling) e
 * EMPURRA {@link SurfaceEvent} para o handler que o nucleo lhe passa em
 * `start(handleEvent)`. SAIDA: `sender()` fornece o {@link SurfaceSender}
 * neutro com que o nucleo envia/edita/responde. O nucleo NAO conhece o polling
 * nem o grammY.
 *
 * O adaptador NORMALIZA NUMERICO NA FRONTEIRA (D4): `chatKey`/`userKey` sao
 * STRINGS neutras; `sender()` faz `Number(chatKey)` ao chegar a `ApiDoBot`. O
 * alfabeto do id do Telegram e `[0-9]+`, logo `Number(...)` e fiel; ids
 * NAO-numericos de um futuro provedor sao resolvidos na fase 5 do IPC.
 *
 * ===========================================================================
 * LIMITES — o que o nucleo usa para cortar e renderizar
 * ===========================================================================
 * maxTextLength 4096 (mensagem), maxActionRows 1 e maxActionPerRow 1 (os
 * teclados deste bot sao UMA linha de UM botao em cada confirmacao),
 * maxActionDataBytes 64 (o `callback_data` do Telegram, EM BYTES),
 * supportsEditing true (`editMessageText` existe).
 */

import type { Bot, Context } from 'grammy'

import type {
  ProviderAdapter,
  SurfaceEditOutcome,
  SurfaceEvent,
  SurfaceLimits,
  SurfacePublishedCommand,
  SurfaceSender,
  SurfaceSendOptions,
} from '../../surface/contract.ts'

import { createTelegramBot, type CreateTelegramBotOptions } from './cliente.ts'
import type { AutoRetryOptions } from './transporte.ts'
import type { WorkerLogger } from './interno.ts'
import { systemTime, type TimeSource } from './interno.ts'
import { criarParse } from './parse.ts'
import { ALLOWED_UPDATES, LONG_POLL_MAX_TIMEOUT, runPolling, type PollingOutcome } from './polling.ts'
import { answerCallbackAlways, editMessageTextInPlace, renderActionRowLayout, type InlineKeyboardApi } from './teclado.ts'

/** As dependencias que o boot injeta ao criar o adaptador. */
export interface TelegramProviderDeps {
  readonly token: string
  /** Raiz da Bot API (duble de teste). Omitido, a oficial. */
  readonly apiRoot?: string
  readonly log: WorkerLogger
  readonly time?: TimeSource
  readonly autoRetry?: AutoRetryOptions
}

/** Limites do provedor telegram (D4). O nucleo corta/renderiza por aqui. */
export const TELEGRAM_LIMITS: SurfaceLimits = Object.freeze({
  maxTextLength: 4096,
  maxActionRows: 1,
  maxActionPerRow: 1,
  maxActionDataBytes: 64,
  supportsEditing: true,
})

/** A superficie exposta: o contrato + o contador de descartes (TG-089). */
export type TelegramAdapter = ProviderAdapter & {
  /** Quantos updates o adaptador descartou desde `start` (TG-089). */
  readonly descartados: () => number
}

/**
 * Cria o PROVIDER telegram — a superficie completa que o boot da Onda 4 consome.
 *
 * @throws {Error} `TOKEN_MISSING` quando o token e vazio (o boot deve VALIDAR
 *   com `lerTokenDoAmbiente` e `assertTokenNotInArgv` de `./token.ts` ANTES).
 */
export function createTelegramProvider(deps: TelegramProviderDeps): TelegramAdapter {
  const time = deps.time ?? systemTime
  const log = deps.log
  const token = deps.token.trim()
  if (token === '') {
    throw new Error('token vazio: nao ha bot para construir (valide antes com lerTokenDoAmbiente)')
  }
  const secretsOf = (): readonly string[] => [token]

  // Estado vivo do loop — criado no `start()`, encerrado no `stop()`.
  let bot: Bot<Context> | undefined
  let tarefaPolling: Promise<PollingOutcome> | undefined
  let handleEvent: ((event: SurfaceEvent) => Promise<void>) | undefined
  const parse = criarParse()

  /** O middleware do grammY: update cru -> SurfaceEvent -> handleEvent. */
  function instalarHandlers(novoBot: Bot<Context>): void {
    const tratar = async (ctx: { readonly update: unknown }): Promise<void> => {
      const evento = parse.mapear(ctx.update)
      if (evento === undefined) return
      if (handleEvent === undefined) return
      try {
        await handleEvent(evento)
      } catch (error) {
        // S4: uma falha de entrega nao pode matar o polling. Registar e seguir.
        log.error('falha ao entregar evento da superficie ao nucleo', {
          kind: evento.kind,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    novoBot.on('message', tratar)
    novoBot.on('callback_query', tratar)
  }

  /** Constrói e configura o bot do grammY (client + transformers + catch). */
  function criarBot(): Bot<Context> {
    const options: CreateTelegramBotOptions = {
      token,
      log,
      time,
      ...(deps.apiRoot === undefined ? {} : { apiRoot: deps.apiRoot }),
    }
    // `createTelegramBot` ja instala transporte+auto-retry e o `bot.catch` com
    // a ordem certa; aqui nao se volta a mexer (nao duplicar transformers).
    return createTelegramBot(options)
  }

  /** Constrói o {@link SurfaceSender} NEUTRO sobre a `ApiDoBot`. */
  function criarSender(): SurfaceSender {
    function botAtual(): Bot<Context> {
      const b = bot
      if (b === undefined) throw new Error('sender usado antes do start() — o bot ainda nao existe')
      return b
    }
    function markupPara(opcoes: SurfaceSendOptions | undefined): Record<string, unknown> {
      const saida: Record<string, unknown> = {}
      if (opcoes?.actionRows !== undefined) {
        const markup = renderActionRowLayout(opcoes.actionRows, log)
        if (markup !== undefined) saida.reply_markup = markup
      }
      if (opcoes?.disableWebPagePreview === true) saida.disable_web_page_preview = true
      return saida
    }

    return {
      async send(chatKey: string, texto: string, opcoes?: SurfaceSendOptions): Promise<string> {
        const api = botAtual().api as InlineKeyboardApi & {
          sendMessage(
            chatId: number,
            text: string,
            other?: Record<string, unknown>,
          ): Promise<{ message_id: number }>
        }
        const extra: Record<string, unknown> = { ...markupPara(opcoes) }
        const r = await api.sendMessage(Number(chatKey), texto, extra)
        // `sendMessage` devolve `message_id`; resolve com o id STRING (D4).
        return String(r.message_id)
      },
      async edit(
        chatKey: string,
        messageId: string,
        texto: string,
        opcoes?: SurfaceSendOptions,
      ): Promise<SurfaceEditOutcome> {
        const api = botAtual().api as InlineKeyboardApi
        const alvo = { chatId: Number(chatKey), messageId: Number(messageId) }
        const markup = opcoes?.actionRows === undefined ? undefined : renderActionRowLayout(opcoes.actionRows, log)
        const outcome: SurfaceEditOutcome = await editMessageTextInPlace(
          api,
          alvo,
          texto,
          log,
          markup === undefined ? undefined : markup,
        )
        return outcome
      },
      async answer(
        answerTarget: string,
        outras?: { readonly text?: string; readonly showAlert?: boolean },
      ): Promise<boolean> {
        const api = botAtual().api as InlineKeyboardApi
        return answerCallbackAlways(api, answerTarget, log, outras)
      },
    }
  }

  const sender = criarSender()

  return {
    id: 'telegram',
    limits: TELEGRAM_LIMITS,
    async start(handler: (event: SurfaceEvent) => Promise<void>) {
      handleEvent = handler
      const novoBot = criarBot()
      bot = novoBot
      instalarHandlers(novoBot)

      const tasksPromise = runPolling({
        bot: novoBot,
        log,
        options: {
          timeout: LONG_POLL_MAX_TIMEOUT,
          allowed_updates: ALLOWED_UPDATES,
          drop_pending_updates: true,
          limit: 100,
          onStart: async () => undefined,
        },
        secrets: secretsOf,
      })
      tarefaPolling = tasksPromise

      // `runPolling` corre `bot.start()` (getMe -> deleteWebhook -> getUpdates).
      // O outcome `stopped` chega quando `bot.start()` resolve (o arranque
      // terminou — onStart do grammY); `fatal` quando `bot.start()` rejeita.
      //
      // Por que AWAIT do outcome e nao um `boot` resolvido no onStart:
      // o onStart do grammY fire ANTES do primeiro `getUpdates` — nos casos
      // 409/401 enfileirados em `getUpdates`, `bot.start()` REJEITA DEPOIS de o
      // onStart ja ter rodado. Um `start()` que confiasse numa promessa resolvida
      // no onStart devolveria "boot concluido" e o processo ficaria pendurado a
      // ver o polling morrer. Aguardar o outcome FATAL do `runPolling` (que e o
      // `bot.start()` rejeitado, ja classificado) faz `start()` rejeitar e o
      // host termina com 11/12 — o e2e 409/401 depende disto.
      const resultado = await tasksPromise
      if (resultado.kind === 'fatal') throw resultado.error
    },
    async stop() {
      handleEvent = undefined
      const atual = bot
      bot = undefined
      if (atual !== undefined) await atual.stop()
      if (tarefaPolling !== undefined) await tarefaPolling.catch(() => undefined)
    },
    async publishCommands(comandos: readonly SurfacePublishedCommand[]) {
      const atual = bot
      if (atual === undefined) {
        log.warn('publishCommands antes do start: sem bot para publicar')
        return undefined
      }
      // `setMyCommands` do grammY recebe a lista DIRECTAMENTE como primeiro
      // argumento, e cada item como `{ command, description }`.
      return atual.api.setMyCommands(
        comandos.map((c) => ({ command: c.command, description: c.description })),
      )
    },
    sender: () => sender,
    descartados: () => parse.descartados(),
  }
}