/**
 * T6.2 — o 429 com `retry_after`, provado sobre o FIO REAL (pergunta
 * falsificavel 1/5: o servidor falso implementa o 429 e o worker LÊ o
 * `retry_after` do corpo real — nunca retry cego).
 *
 * O transformer `auto-retry` (`worker/lib/auto-retry.ts`) ve a `ApiResponse`
 * ANTES de o grammY a converter em `GrammyError`: o `retry_after` chega como
 * dado do fio. Estes testes provam a cadeia inteira: HTTP 429 com
 * `parameters.retry_after` -> sono EXATO desse valor no relogio injetado ->
 * repeticao. E provam o contrapositivo: sem `retry_after` (ou acima do tecto)
 * NAO se dorme e NAO se repete.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { GrammyError } from 'grammy'

import {
  aguardar,
  assertSemTokenRealNoAmbiente,
  captureLog,
  chamadasDe,
  FakeTime,
  startFakeBotApi,
  TOKEN_DE_TESTE,
  type FakeBotApi,
} from './telegram-apoio.ts'
import { createBot } from '../../worker/lib/client.ts'
import { buildPollingOptions, runPolling } from '../../worker/lib/polling.ts'

assertSemTokenRealNoAmbiente()

const abertos: FakeBotApi[] = []
after(async () => {
  await Promise.all(abertos.map((srv) => srv.close()))
})

function erro429(retryAfter?: number): { error_code: number; description: string; parameters?: Record<string, unknown> } {
  return retryAfter === undefined
    ? { error_code: 429, description: 'Too Many Requests' }
    : {
        error_code: 429,
        description: `Too Many Requests: retry after ${retryAfter}`,
        parameters: { retry_after: retryAfter },
      }
}

describe('e2e 429 — retry_after lido do fio e respeitado EXATAMENTE', () => {
  it('sendMessage com 429{retry_after:5}: dorme 5000 ms no relogio injetado e repete UMA vez', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    srv.queueError('sendMessage', erro429(5))
    const time = new FakeTime()
    const log = captureLog()
    const bot = createBot({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger, time })

    const enviada = await bot.api.sendMessage(777000123, 'ola')

    assert.equal(enviada.message_id, 101, 'a repeticao passou e devolveu a resposta feliz')
    assert.equal(chamadasDe(srv, 'sendMessage').length, 2, 'a original e UMA repeticao')
    assert.deepEqual(time.sleeps, [5000], 'esperou exatamente o retry_after, nem mais nem menos')
    assert.equal(time.now(), 5000, 'o relogio andou 5 s — nada alem')
  })

  it('429 SEM retry_after: nenhuma espera, nenhuma repeticao — o erro chega a quem chamou', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    srv.queueError('sendMessage', erro429())
    const time = new FakeTime()
    const log = captureLog()
    const bot = createBot({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger, time })

    await assert.rejects(
      () => bot.api.sendMessage(777000123, 'ola'),
      (e: unknown) => e instanceof GrammyError && e.error_code === 429,
      'sem retry_after nao ha quanto esperar — repetir as cegas amplificaria o problema',
    )
    assert.equal(chamadasDe(srv, 'sendMessage').length, 1)
    assert.deepEqual(time.sleeps, [])
  })

  it('retry_after acima do tecto (60 s): nao se espera, o erro devolve-se', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    srv.queueError('sendMessage', erro429(3600))
    const time = new FakeTime()
    const log = captureLog()
    const bot = createBot({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger, time })

    await assert.rejects(
      () => bot.api.sendMessage(777000123, 'ola'),
      (e: unknown) => e instanceof GrammyError && e.error_code === 429,
    )
    assert.equal(chamadasDe(srv, 'sendMessage').length, 1, 'um worker que dorme 1 h e indistinguivel de morto')
    assert.deepEqual(time.sleeps, [])
    assert.match(log.all(), /acima do tecto/u)
  })

  it('429 persistente: uma repeticao e so — o orcamento para e o erro chega', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    srv.queueError('sendMessage', erro429(1))
    srv.queueError('sendMessage', erro429(1))
    const time = new FakeTime()
    const log = captureLog()
    const bot = createBot({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger, time })

    await assert.rejects(
      () => bot.api.sendMessage(777000123, 'ola'),
      (e: unknown) => e instanceof GrammyError && e.error_code === 429,
    )
    assert.equal(chamadasDe(srv, 'sendMessage').length, 2, 'a original e UMA repeticao — sem ciclo')
    assert.deepEqual(time.sleeps, [1000])
    assert.match(log.all(), /orcamento de repeticoes esgotado/u)
  })

  it('o 429 do POLLING nao passa por aqui: o transformer nao dorme, o grammY dorme retry_after e o polling continua', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    // Enfileirado ANTES do polling: o PRIMEIRO getUpdates recebe o 429.
    srv.queueError('getUpdates', erro429(1))
    const time = new FakeTime()
    const log = captureLog()
    const bot = createBot({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger, time })

    const corrida = runPolling({ bot, log: log.logger, options: buildPollingOptions() })
    await aguardar(() => chamadasDe(srv, 'getUpdates').length >= 1, 'primeiro getUpdates (o 429)')
    const t0 = Date.now()
    await aguardar(() => chamadasDe(srv, 'getUpdates').length >= 2, 'a repeticao depois do retry_after', 8000)
    const gap = Date.now() - t0
    await bot.stop()
    const outcome = await corrida

    assert.ok(outcome.kind === 'stopped', 'o 429 do polling nao e terminal: o worker nao sai')
    assert.deepEqual(
      time.sleeps,
      [],
      'o nosso transformer NAO dormiu neste 429: o dono do polling e o grammY — dormir aqui E ali dobrava a espera',
    )
    assert.ok(gap >= 900, `a repeticao esperou o retry_after (1 s) — medido: ${gap} ms`)
  })

  it('o formato do 429 nao e complacente: HTTP 429, corpo canonico com parameters.retry_after', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    srv.queueError('getUpdates', erro429(5))

    const resposta = await fetch(`${srv.apiRoot}/bot${TOKEN_DE_TESTE}/getUpdates`)

    assert.equal(resposta.status, 429)
    assert.deepEqual(await resposta.json(), {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 5',
      parameters: { retry_after: 5 },
    })
  })
})
