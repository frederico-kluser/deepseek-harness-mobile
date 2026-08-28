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

describe('provider/discord/transporte — o orcamento e as bordas', () => {
  it('maxRetryAttempts 0: orcamento vazio, nenhuma repeticao (mesmo com retry_after)', async () => {
    const tempo = new FakeTime()
    let tentativas = 0
    await assert.rejects(
      comAutoRetry(
        async () => {
          tentativas += 1
          throw erro429(50)
        },
        { time: tempo, maxRetryAttempts: 0 },
      ),
    )
    assert.equal(tentativas, 1)
    assert.deepEqual(tempo.sleeps, [], 'nunca esperou: nao ia haver segunda tentativa')
  })

  it('maxRetryAttempts 2: repete ate 3 tentativas no total', async () => {
    const tempo = new FakeTime()
    let tentativas = 0
    const resultado = await comAutoRetry(
      async () => {
        tentativas += 1
        if (tentativas < 3) throw erro429(10)
        return 'fim'
      },
      { time: tempo, maxRetryAttempts: 2 },
    )
    assert.equal(resultado, 'fim')
    assert.equal(tentativas, 3)
    assert.deepEqual(tempo.sleeps, [10, 10], 'uma espera por repeticao, na ordem')
  })

  it('maxDelaySeconds custom: o tecto respeita o valor dado', async () => {
    const tempo = new FakeTime()
    let tentativas = 0
    await assert.rejects(
      comAutoRetry(
        async () => {
          tentativas += 1
          throw erro429(2_000) // 2 s, acima do tecto de 1 s dado
        },
        { time: tempo, maxDelaySeconds: 1 },
      ),
    )
    assert.equal(tentativas, 1)
    assert.deepEqual(tempo.sleeps, [], 'acima do tecto nao se espera')
  })

  it('erro que NAO e DiscordApiError (ex.: TypeError da rede) sai na hora, sem retry', async () => {
    const tempo = new FakeTime()
    let chamadas = 0
    await assert.rejects(
      comAutoRetry(async () => {
        chamadas += 1
        throw new TypeError('fetch failed')
      }, { time: tempo }),
      TypeError,
    )
    assert.equal(chamadas, 1)
    assert.deepEqual(tempo.sleeps, [])
  })

  it('DiscordApiError nao-429 (ex.: 500) sai na hora — o servidor nao disse quanto esperar', async () => {
    const tempo = new FakeTime()
    let chamadas = 0
    await assert.rejects(
      comAutoRetry(async () => {
        chamadas += 1
        throw new DiscordApiError(500, { code: 10008 })
      }, { time: tempo }),
      (error: unknown) => error instanceof DiscordApiError && error.status === 500,
    )
    assert.equal(chamadas, 1)
  })

  it('o log avisa no orcamento esgotado e no tecto, com os campos do contrato', async () => {
    const tempo = new FakeTime()
    const log = captureLog()

    await assert.rejects(
      comAutoRetry(async () => {
        throw erro429(20)
      }, { time: tempo, log: log.logger }),
    )
    assert.ok(log.lines.some((l) => l.includes('orcamento de repeticoes esgotado')), 'orçamento esgotado logado')
    assert.ok(log.lines.some((l) => l.includes('429: a esperar o retry_after')), 'a espera e logada')

    log.lines.length = 0
    await assert.rejects(
      comAutoRetry(async () => {
        throw erro429((DEFAULT_MAX_DELAY_SECONDS + 10) * 1000)
      }, { time: tempo, log: log.logger }),
    )
    assert.ok(log.lines.some((l) => l.includes('acima do tecto')), 'o tecto e logado')
    assert.ok(log.lines.some((l) => l.includes('max_delay_ms=60000')))
  })

  it('as esperas repetem EXATAMENTE o retry_after de cada 429 (nao o acumulam)', async () => {
    const tempo = new FakeTime()
    const esperas: number[] = [100, 250]
    let tentativas = 0
    await assert.rejects(
      comAutoRetry(
        async () => {
          tentativas += 1
          throw erro429(esperas[tentativas - 1] ?? 0)
        },
        { time: tempo, maxRetryAttempts: 2 },
      ),
    )
    assert.deepEqual(tempo.sleeps, [100, 250], 'cada 429 dorme o SEU retry_after')
  })
})
