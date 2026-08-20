/**
 * `src/proc/backoff.ts` -- recuo exponencial com jitter somado por cima da base.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeBackoffDelay } from '../../../src/proc/backoff.ts'

describe('computeBackoffDelay', () => {
  const backoff = {
    initialDelayMs: 500,
    maxDelayMs: 10000,
    maxAttempts: 10,
    resetAfterMs: 60000,
  }

  it('cresce de 500 ms ate ao teto de 10000 ms e satura', () => {
    // `random() === 0` = sem jitter = progressao nominal exata. (Era `() => 1`
    // quando o jitter era subtraido da base; agora e somado por cima dela.)
    const sequence = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) =>
      computeBackoffDelay(attempt, backoff, () => 0),
    )

    assert.deepEqual(sequence, [500, 1000, 2000, 4000, 8000, 10000, 10000, 10000])
  })

  it('o PISO nunca fica abaixo de initialDelayMs (jitter por cima da base)', () => {
    // Regressao do achado A-LOW: com "equal jitter" (base/2 + random*base/2) o
    // atraso da primeira tentativa descia a 250 ms -- METADE do initialDelayMs de
    // 500 ms que o DSH prescreve como base cronologica inicial imposta.
    for (const random of [0, 0.001, 0.25, 0.5, 0.75, 1]) {
      assert.equal(
        computeBackoffDelay(1, backoff, () => random) >= backoff.initialDelayMs,
        true,
        `random=${random} nao pode produzir atraso abaixo de initialDelayMs`,
      )
    }

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      for (const random of [0, 0.3, 1]) {
        const delay = computeBackoffDelay(attempt, backoff, () => random)
        assert.equal(delay >= backoff.initialDelayMs, true)
        assert.equal(delay <= backoff.maxDelayMs, true)
      }
    }
  })

  it('nunca excede maxDelayMs e o atraso cresce com o jitter', () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const low = computeBackoffDelay(attempt, backoff, () => 0)
      const high = computeBackoffDelay(attempt, backoff, () => 1)
      const mid = computeBackoffDelay(attempt, backoff, () => 0.5)

      assert.equal(high <= backoff.maxDelayMs, true)
      assert.equal(low <= high, true, 'a base e o piso; o jitter so pode somar')
      assert.equal(mid >= low && mid <= high, true)
    }
  })

  it('o jitter dispersa o instante de reinicio (sem thundering herd)', () => {
    const values = new Set<number>()
    for (let i = 0; i < 200; i += 1) values.add(computeBackoffDelay(5, backoff, Math.random))
    assert.equal(values.size > 1, true, 'com jitter os atrasos nao podem coincidir sempre')
  })
})
