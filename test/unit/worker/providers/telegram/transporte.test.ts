/**
 * `worker/providers/telegram/transporte.ts` — o auto-retry do 429 (lendo
 * `retry_after` no relogio injetado) e o transporte-log (amostragem por
 * potencia de dois, escalada a ERROR apos 5). Port fiel de
 * `worker/lib/{auto-retry,transport-log}.ts`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ApiResponse } from 'grammy/types'

import {
  createAutoRetryTransformer,
  createTransportLogTransformer,
  ESCALATE_AFTER,
  isSamplePoint,
  METODOS_SEM_RETRY,
  retryAfterSeconds,
  TOO_MANY_REQUESTS,
} from '../../../../../worker/providers/telegram/transporte.ts'
import { FakeTime, captureLog } from './apoio.ts'

function response429(retryAfter: number): ApiResponse<unknown> {
  return {
    ok: false,
    error_code: TOO_MANY_REQUESTS,
    description: 'Too Many Requests',
    parameters: { retry_after: retryAfter },
  }
}

describe('provider/telegram/transporte — retryAfterSeconds', () => {
  it('so le retry_after de um 429 com valor numerico finito', () => {
    assert.equal(retryAfterSeconds({ ok: true, result: null as never }), undefined)
    assert.equal(retryAfterSeconds({ ok: false, error_code: 500, description: 'x' }), undefined)
    assert.equal(retryAfterSeconds(response429(5)), 5)
    assert.equal(retryAfterSeconds(response429(0)), 0)
  })
  it('negativo trata-se como ja-podes; ausente/absurdo nunca retry', () => {
    assert.equal(retryAfterSeconds(response429(-3)), 0)
    assert.equal(retryAfterSeconds({ ok: false, error_code: 429, description: 'x' }), undefined)
    assert.equal(retryAfterSeconds({ ok: false, error_code: 429, description: 'x', parameters: {} }), undefined)
  })
})

describe('provider/telegram/transporte — auto-retry do 429', () => {
  it('espera exatamente retry_after pelo relogio injetado e repete uma vez', async () => {
    const time = new FakeTime(0)
    const log = captureLog()
    const transformer = createAutoRetryTransformer({ time, log: log.logger })

    let calls = 0
    const prev = async (_method: string, _payload: never, _signal: unknown): Promise<ApiResponse<unknown>> => {
      calls += 1
      return calls === 1 ? response429(3) : { ok: true, result: 'ok' }
    }
    const out = await transformer(prev as never, 'sendMessage' as never, {} as never, undefined)
    assert.equal(out.ok, true)
    assert.equal(calls, 2)
    assert.deepEqual(time.sleeps, [3000], '3 s pelo relogio injetado (TG-043)')
  })

  it('sem retry_after NAO retry cego', async () => {
    const time = new FakeTime()
    const transformer = createAutoRetryTransformer({ time })
    let calls = 0
    const prev = async (_method: string, _payload: never, _signal: unknown): Promise<ApiResponse<unknown>> => {
      calls += 1
      return { ok: false, error_code: 500, description: 'x' }
    }
    await transformer(prev as never, 'sendMessage' as never, {} as never, undefined)
    assert.equal(calls, 1)
    assert.deepEqual(time.sleeps, [])
  })

  it('retry_after acima do tecto (60 s) NAO se espera', async () => {
    const time = new FakeTime()
    const transformer = createAutoRetryTransformer({ time, maxDelaySeconds: 60 })
    let calls = 0
    const prev = async (_method: string, _payload: never, _signal: unknown): Promise<ApiResponse<unknown>> => {
      calls += 1
      return response429(120)
    }
    await transformer(prev as never, 'sendMessage' as never, {} as never, undefined)
    assert.equal(calls, 1)
  })

  it('getUpdates fica FORA (o grammY ja dorme retry_after no polling)', async () => {
    const time = new FakeTime()
    const transformer = createAutoRetryTransformer({ time })
    let calls = 0
    const prev = async (_method: string, _payload: never, _signal: unknown): Promise<ApiResponse<unknown>> => {
      calls += 1
      return response429(5)
    }
    await transformer(prev as never, 'getUpdates' as never, { offset: 1 } as never, undefined)
    assert.equal(calls, 1, 'nao repete getUpdates')
    assert.equal(METODOS_SEM_RETRY.includes('getUpdates'), true)
  })
})

describe('provider/telegram/transporte — transporte-log', () => {
  it('amostra por potencia de dois e a PRIMEIRA falha sai sempre', async () => {
    assert.equal(isSamplePoint(1), true)
    assert.equal(isSamplePoint(2), true)
    assert.equal(isSamplePoint(3), false)
    assert.equal(isSamplePoint(4), true)
    assert.equal(isSamplePoint(5), false)
  })

  it('escala a ERROR apos ESCALATE_AFTER e relanca o erro original', async () => {
    const log = captureLog()
    const transformer = createTransportLogTransformer({ log: log.logger })
    let falhou = false
    const prev = async (_method: string, _payload: never, _signal: unknown): Promise<ApiResponse<unknown>> => {
      throw new Error('ECONNRESET')
    }
    for (let i = 0; i < ESCALATE_AFTER; i += 1) {
      try {
        await transformer(prev as never, 'getUpdates' as never, {} as never, undefined)
      } catch {
        falhou = true
      }
    }
    assert.equal(falhou, true, 'o erro original e RELANCADO')
    assert.match(log.all(), /falhou \(rede\)/u)
  })

  it('registar a recuperacao quando a rede volta', async () => {
    const log = captureLog()
    const transformer = createTransportLogTransformer({ log: log.logger })
    let calls = 0
    const prev = async (_method: string, _payload: never, _signal: unknown): Promise<ApiResponse<unknown>> => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return { ok: true, result: [] }
    }
    let primeiroFalhou = false
    try {
      await transformer(prev as never, 'getUpdates' as never, {} as never, undefined)
    } catch {
      primeiroFalhou = true
    }
    assert.equal(primeiroFalhou, true, 'a primeira chamada falha (relanca)')
    await transformer(prev as never, 'getUpdates' as never, {} as never, undefined)
    assert.match(log.all(), /recuperado/u)
  })
})