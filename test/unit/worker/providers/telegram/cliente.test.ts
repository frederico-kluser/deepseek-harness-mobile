/**
 * `worker/providers/telegram/cliente.ts` — o bot grammY: `apiRoot`
 * normalizado, `sensitiveLogs: false` EXPLICITO, transformers instalados, e
 * `bot.catch` cobrindo `GrammyError` E `HttpError`. Port fiel de
 * `worker/lib/client.ts`, contra o duble congelado.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { GrammyError, HttpError } from 'grammy'

import {
  createErrorHandler,
  createTelegramBot,
  normalizeApiRoot,
} from '../../../../../worker/providers/telegram/cliente.ts'
import {
  captureLog,
  startFakeBotApi,
  startServidorMudo,
  TOKEN_DE_TESTE,
  type FakeBotApi,
  type ServidorMudo,
} from './apoio.ts'

const abertos: FakeBotApi[] = []
const mudos: ServidorMudo[] = []
after(async () => {
  await Promise.all([...abertos.map((s) => s.close()), ...mudos.map((s) => s.close())])
})

function grammyError(error_code: number, description: string, parameters = {}): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed!`,
    { ok: false, error_code, description, parameters },
    'sendMessage',
    { chat_id: 1 },
  )
}

describe('provider/telegram/cliente — bot.catch cobre as DUAS familias', () => {
  it('GrammyError: diagnostico com metodo e codigo', () => {
    const log = captureLog()
    createErrorHandler(log.logger)({ error: grammyError(400, 'Bad Request: chat not found') })
    assert.match(log.all(), /GrammyError/u)
    assert.match(log.all(), /400/u)
  })

  it('HttpError: queda de rede — continua vivo (sem este ramo o bot morre por Wi-Fi)', () => {
    const log = captureLog()
    createErrorHandler(log.logger)({
      error: new HttpError(`Network request for 'getUpdates' failed!`, new Error('ECONNRESET')),
    })
    assert.match(log.all(), /HttpError/u)
    assert.match(log.all(), /rede/u)
  })

  it('o handler NUNCA relanca: nao engole calado — registado e segue', () => {
    const log = captureLog()
    assert.doesNotThrow(() => createErrorHandler(log.logger)({ error: 'string solta' }))
    assert.match(log.all(), /nao tratado/u)
  })
})

describe('provider/telegram/cliente — token nunca sai no log', () => {
  it('HttpError cuja causa cita a URL com o token e mascarado', () => {
    const log = captureLog()
    createErrorHandler(log.logger, () => [TOKEN_DE_TESTE])({
      error: new HttpError(
        `Network request for 'getUpdates' failed!`,
        new Error(
          `request to https://api.telegram.org/bot${TOKEN_DE_TESTE}/getUpdates failed, reason: ENOTFOUND`,
        ),
      ),
    })
    const texto = log.all()
    assert.equal(texto.includes(TOKEN_DE_TESTE), false)
    assert.match(texto, /REDACTED/u)
  })
})

describe('provider/telegram/cliente — construcao', () => {
  it('token vazio e recusado aqui (nao com um 404 do servidor)', () => {
    const log = captureLog()
    assert.throws(() => createTelegramBot({ token: '   ', log: log.logger }), /TOKEN_MISSING/u)
  })

  it('a barra final do apiRoot e normalizada (o grammY lança com ela)', () => {
    assert.equal(normalizeApiRoot('http://127.0.0.1:8081/'), 'http://127.0.0.1:8081')
    assert.equal(normalizeApiRoot('http://127.0.0.1:8081///'), 'http://127.0.0.1:8081')
    assert.equal(normalizeApiRoot('http://127.0.0.1:8081'), 'http://127.0.0.1:8081')
  })

  it('o apiRoot manda mesmo: chamada vai para o servidor local, nunca para o Telegram', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()
    // Com barra final de proposito: se a normalizacao nao existisse, isto lancava.
    const bot = createTelegramBot({ token: TOKEN_DE_TESTE, apiRoot: `${srv.apiRoot}/`, log: log.logger })
    const me = await bot.api.getMe()
    assert.equal(me.username, 'dsh_spike_bot')
    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0]?.method, 'getme')
  })

  it('sensitiveLogs: false DECLARADO EXPLICITAMENTE (nao herdado)', () => {
    const log = captureLog()
    const bot = createTelegramBot({ token: TOKEN_DE_TESTE, log: log.logger })
    const opcoes = bot.api.options
    assert.ok(opcoes !== undefined)
    assert.equal(opcoes.sensitiveLogs, false)
    assert.notEqual(opcoes.sensitiveLogs, undefined)
  })

  it('na queda de rede, a mensagem HttpError NAO carrega a URL (sensitiveLogs: false)', async () => {
    const mudo = await startServidorMudo()
    mudos.push(mudo)
    const log = captureLog()
    const bot = createTelegramBot({ token: TOKEN_DE_TESTE, apiRoot: mudo.apiRoot, log: log.logger })
    const erro = await bot.api.getMe().then(
      () => undefined,
      (e: unknown) => e,
    )
    assert.ok(erro instanceof HttpError)
    assert.equal(erro.message.includes(TOKEN_DE_TESTE), false)
  })

  it('o auto-retry do 429 esta instalado (espera injetada de 0s, repete uma vez)', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()
    const bot = createTelegramBot({
      token: TOKEN_DE_TESTE,
      apiRoot: srv.apiRoot,
      log: log.logger,
      autoRetry: { maxRetryAttempts: 1 },
    })
    srv.queueError('getMe', {
      error_code: 429,
      description: 'Too Many Requests: retry after 0',
      parameters: { retry_after: 0 },
    })
    const me = await bot.api.getMe()
    assert.equal(me.username, 'dsh_spike_bot')
    assert.equal(srv.calls.filter((c) => c.method === 'getme').length, 2)
  })
})