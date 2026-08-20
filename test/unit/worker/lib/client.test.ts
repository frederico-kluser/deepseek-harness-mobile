/**
 * `worker/lib/client.ts` — as duas perguntas duras da revisao:
 *
 *   4. `bot.catch` cobre `HttpError` alem de `GrammyError`?
 *   5. O token aparece nalgum log — MESMO dentro de uma mensagem de erro que
 *      cite a URL?
 *
 * A pergunta 5 e testada com a mensagem LITERAL do `node-fetch`, que e o cliente
 * HTTP que o grammY 1.45.1 usa no Node (`out/shim.node.js`). Nao e uma string
 * inventada: e o formato que aparece a serio quando o Wi-Fi cai.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { Bot, GrammyError, HttpError } from 'grammy'

import {
  createBot,
  createErrorHandler,
  describeBotError,
  normalizeApiRoot,
} from '../../../../worker/lib/client.ts'
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
  await Promise.all([...abertos.map((srv) => srv.close()), ...mudos.map((srv) => srv.close())])
})

/** A mensagem que o `node-fetch` produz de verdade — com o token dentro da URL. */
const MENSAGEM_COM_TOKEN =
  `request to https://api.telegram.org/bot${TOKEN_DE_TESTE}/getUpdates failed, ` +
  'reason: getaddrinfo ENOTFOUND api.telegram.org'

function grammyError(error_code: number, description: string, parameters = {}): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed!`,
    { ok: false, error_code, description, parameters },
    'sendMessage',
    { chat_id: 1 },
  )
}

describe('worker/lib/client — bot.catch cobre as DUAS familias de erro', () => {
  it('GrammyError: a Bot API respondeu com erro, e o diagnostico traz metodo e codigo', () => {
    const log = captureLog()
    const handler = createErrorHandler(log.logger)

    handler({ error: grammyError(400, 'Bad Request: chat not found') })

    const texto = log.all()
    assert.match(texto, /ERROR/u)
    assert.match(texto, /GrammyError/u)
    assert.match(texto, /sendMessage/u)
    assert.match(texto, /400/u)
    assert.match(texto, /chat not found/u)
  })

  it('HttpError: falha de REDE. Sem este ramo, o processo morre por queda de Wi-Fi', () => {
    const log = captureLog()
    const handler = createErrorHandler(log.logger)

    handler({ error: new HttpError(`Network request for 'getUpdates' failed!`, new Error('ECONNRESET')) })

    const texto = log.all()
    assert.match(texto, /HttpError/u)
    assert.match(texto, /rede/u)
    assert.match(texto, /continua vivo/u, 'a linha diz ao operador que isto NAO e terminal')
  })

  it('um erro que nao e nenhum dos dois tambem e registado — nunca engolido', () => {
    const log = captureLog()
    const handler = createErrorHandler(log.logger)
    handler({ error: new TypeError('defeito de programacao no middleware') })
    assert.match(log.all(), /defeito de programacao/u)
  })

  it('o handler NUNCA relanca: um erro ja tratado nao pode matar o processo', () => {
    const log = captureLog()
    const handler = createErrorHandler(log.logger)
    assert.doesNotThrow(() => {
      handler({ error: grammyError(500, 'Internal Server Error') })
    })
    assert.doesNotThrow(() => {
      handler({ error: 'uma string solta' })
    })
  })
})

describe('worker/lib/client — o token nunca sai no log', () => {
  it('pergunta 5: HttpError cuja CAUSA cita a URL com o token', () => {
    const log = captureLog()
    const handler = createErrorHandler(log.logger, () => [TOKEN_DE_TESTE])

    handler({
      error: new HttpError(
        `Network request for 'getUpdates' failed!`,
        new Error(MENSAGEM_COM_TOKEN),
      ),
    })

    const texto = log.all()
    assert.equal(texto.includes(TOKEN_DE_TESTE), false, 'o token literal nao pode estar aqui')
    assert.equal(texto.includes('AAHfalso-so-para-teste'), false, 'nem a cauda dele')
    assert.match(texto, /REDACTED/u, 'e ve-se que houve corte, em vez de o campo desaparecer')
    assert.match(texto, /ENOTFOUND/u, 'o diagnostico util sobrevive ao corte')
  })

  it('a camada de FORMA apanha um token que nem sequer conhecemos', () => {
    const log = captureLog()
    // Sem `secrets`: nao ha literal conhecido, so a forma `<id>:<segredo>`.
    const handler = createErrorHandler(log.logger)
    handler({
      error: new HttpError(
        'falhou',
        new Error('GET https://api.telegram.org/bot987654321:BBBoutro-token-completamente-diferente/getMe'),
      ),
    })
    const texto = log.all()
    assert.equal(texto.includes('BBBoutro-token-completamente-diferente'), false)
    assert.match(texto, /987654321:\[REDACTED\]/u, 'o id do bot fica, o segredo sai')
  })

  it('a description vinda do servidor tambem passa pelo corte', () => {
    const log = captureLog()
    const handler = createErrorHandler(log.logger, () => [TOKEN_DE_TESTE])
    handler({ error: grammyError(401, `Unauthorized: token ${TOKEN_DE_TESTE} rejeitado`) })
    assert.equal(log.all().includes(TOKEN_DE_TESTE), false)
  })

  it('describeBotError devolve o retry_after do 429, que e o que o auto-retry le', () => {
    const { fields } = describeBotError(
      grammyError(429, 'Too Many Requests: retry after 5', { retry_after: 5 }),
    )
    assert.equal(fields['retry_after'], 5)
    assert.equal(fields['error_code'], 429)
  })
})

describe('worker/lib/client — construcao', () => {
  it('token vazio e recusado aqui, e nao mais tarde com um 404 do servidor', () => {
    const log = captureLog()
    assert.throws(
      () => createBot({ token: '   ', log: log.logger }),
      /TOKEN_MISSING/u,
    )
  })

  it('a barra final do apiRoot e normalizada (o grammY LANCA com ela)', () => {
    assert.equal(normalizeApiRoot('http://127.0.0.1:8081/'), 'http://127.0.0.1:8081')
    assert.equal(normalizeApiRoot('http://127.0.0.1:8081///'), 'http://127.0.0.1:8081')
    assert.equal(normalizeApiRoot('http://127.0.0.1:8081'), 'http://127.0.0.1:8081')
  })

  it('o apiRoot manda mesmo: a chamada vai para o servidor LOCAL, nunca para o Telegram', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()
    // Com barra final de proposito: se a normalizacao nao existisse, isto lancava.
    const bot = createBot({ token: TOKEN_DE_TESTE, apiRoot: `${srv.apiRoot}/`, log: log.logger })

    const me = await bot.api.getMe()

    assert.equal(me.username, 'dsh_spike_bot')
    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0]?.method, 'getme')
  })

  it('ACHADO 3: `sensitiveLogs: false` esta DECLARADO, e nao herdado em silencio', () => {
    const log = captureLog()
    const bot = createBot({ token: TOKEN_DE_TESTE, log: log.logger })
    // `undefined` (linha apagada) e `true` sao os dois mutantes que a revisao
    // fez sobreviver ao gate inteiro. Esta asserção mata os dois.
    const opcoes = bot.api.options
    assert.ok(opcoes !== undefined, 'o cliente foi construido com opcoes explicitas')
    assert.equal(opcoes.sensitiveLogs, false)
    assert.notEqual(
      opcoes.sensitiveLogs,
      undefined,
      'herdar o default nao chega: a versao seguinte do grammY pode muda-lo',
    )
  })

  it('ACHADO 3: e a flag MUDA mesmo o comportamento — o contrafactual prova-o', async () => {
    const mudo = await startServidorMudo()
    mudos.push(mudo)
    const log = captureLog()

    // O NOSSO cliente.
    const nosso = createBot({ token: TOKEN_DE_TESTE, apiRoot: mudo.apiRoot, log: log.logger })
    const erroNosso = await nosso.api.getMe().then(
      () => undefined,
      (e: unknown) => e,
    )
    assert.ok(erroNosso instanceof HttpError)
    assert.equal(
      erroNosso.message.includes(TOKEN_DE_TESTE),
      false,
      'com sensitiveLogs: false a mensagem nao carrega a URL',
    )

    // O CONTRAFACTUAL: o mesmo pedido com a flag ligada.
    const inseguro = new Bot(TOKEN_DE_TESTE, {
      client: { apiRoot: mudo.apiRoot, sensitiveLogs: true },
    })
    const erroInseguro = await inseguro.api.getMe().then(
      () => undefined,
      (e: unknown) => e,
    )
    assert.ok(erroInseguro instanceof HttpError)
    assert.equal(
      erroInseguro.message.includes(TOKEN_DE_TESTE),
      true,
      'com `true`, o node-fetch poe a URL — e o token — dentro da mensagem. E isto que a flag evita.',
    )
  })

  it('o auto-retry esta instalado no cliente construido', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()
    const bot = createBot({
      token: TOKEN_DE_TESTE,
      apiRoot: srv.apiRoot,
      log: log.logger,
      // Espera de zero segundos: aqui mede-se a INSTALACAO, nao o atraso —
      // o atraso ja e medido, com relogio injetado, em `auto-retry.test.ts`.
      autoRetry: { maxRetryAttempts: 1 },
    })
    srv.queueError('getMe', {
      error_code: 429,
      description: 'Too Many Requests: retry after 0',
      parameters: { retry_after: 0 },
    })

    const me = await bot.api.getMe()

    assert.equal(me.username, 'dsh_spike_bot')
    assert.equal(srv.calls.filter((c) => c.method === 'getme').length, 2, 'repetiu uma vez')
    assert.match(log.all(), /429/u)
  })
})
