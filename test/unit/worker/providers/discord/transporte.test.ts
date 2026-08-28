/**
 * `worker/providers/discord/transporte.ts` — o auto-retry do 429.
 *
 * Cobre: retry EXATAMENTE pelo `retry_after` indicado (no relogio injetado),
 * orcamento de tentativas, teto de espera, e a regra dura de NAO repetir nem
 * 429 sem espera nem erro de rede (POST de mensagem nao e idempotente).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DiscordApiError } from '../../../../../worker/providers/discord/cliente.ts'
import {
  comAutoRetry,
  DEFAULT_MAX_DELAY_SECONDS,
  DEFAULT_MAX_RETRY_ATTEMPTS,
  TOO_MANY_REQUESTS,
} from '../../../../../worker/providers/discord/transporte.ts'
import { FakeTime, captureLog } from './apoio.ts'

function erro429(retryAfterMs: number): DiscordApiError {
  return new DiscordApiError(TOO_MANY_REQUESTS, { retryAfterMs })
}

describe('provider/discord/transporte — auto-retry do 429', () => {
  it('429 com retry_after: espera EXATAMENTE o valor no relogio e repete', async () => {
    const tempo = new FakeTime()
    const log = captureLog()
    let tentativas = 0
    const resultado = await comAutoRetry(
      async () => {
        tentativas += 1
        if (tentativas === 1) throw erro429(500)
        return 'ok'
      },
      { time: tempo, log: log.logger },
    )
    assert.equal(resultado, 'ok')
    assert.equal(tentativas, 2)
    assert.deepEqual(tempo.sleeps, [500], 'dormiu exatamente o retry_after em ms')
  })

  it('orcamento esgotado (DEFAULT_MAX_RETRY_ATTEMPTS = 1): devolve o erro', async () => {
    const tempo = new FakeTime()
    let tentativas = 0
    await assert.rejects(
      comAutoRetry(
        async () => {
          tentativas += 1
          throw erro429(100)
        },
        { time: tempo },
      ),
      (error: unknown) => error instanceof DiscordApiError && error.status === 429,
    )
    assert.equal(tentativas, DEFAULT_MAX_RETRY_ATTEMPTS + 1)
  })

  it('retry_after acima do teto (60 s): nao espera, devolve o erro', async () => {
    const tempo = new FakeTime()
    let tentativas = 0
    await assert.rejects(
      comAutoRetry(
        async () => {
          tentativas += 1
          throw erro429((DEFAULT_MAX_DELAY_SECONDS + 1) * 1000)
        },
        { time: tempo },
      ),
    )
    assert.equal(tentativas, 1)
    assert.deepEqual(tempo.sleeps, [], 'nenhuma espera')
  })

  it('429 SEM retry_after e erro de REDE (status 0): NUNCA repete (sem retry cego)', async () => {
    const tempo = new FakeTime()
    let chamadas = 0
    const semEspera = new DiscordApiError(429, {})
    await assert.rejects(
      comAutoRetry(async () => {
        chamadas += 1
        throw semEspera
      }, { time: tempo }),
    )
    const rede = new DiscordApiError(0)
    await assert.rejects(
      comAutoRetry(async () => {
        chamadas += 1
        throw rede
      }, { time: tempo }),
    )
    assert.equal(chamadas, 2, 'um erro nao-429 e um 429 sem espera nao se repetem')
    assert.deepEqual(tempo.sleeps, [])
  })

  it('sucesso de primeira nao espera nada', async () => {
    const tempo = new FakeTime()
    assert.equal(await comAutoRetry(async () => 42, { time: tempo }), 42)
    assert.deepEqual(tempo.sleeps, [])
  })
})
