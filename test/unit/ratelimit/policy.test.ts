/**
 * `src/ratelimit/policy.ts` -- a funcao PURA falhas -> atraso, o limiar de ban e
 * o teto NIST. Cobre RL-001..RL-004 de `04-TESTES.md`.
 *
 * Relogio nao entra aqui de proposito: a politica nao tem relogio. O que entra e
 * o gerador aleatorio injetado, que e o que torna o full jitter deterministico.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assertRateLimitPolicy,
  banAppliesToScope,
  computeAuthDelayMs,
  DEFAULT_RATE_LIMIT_POLICY,
  hasReachedBruteForceCeiling,
  isBanTriggeredBy,
  NIST_BRUTE_FORCE_CEILING,
  RateLimitPolicyError,
  type RateLimitPolicy,
} from '../../../src/ratelimit/policy.ts'

const policy = DEFAULT_RATE_LIMIT_POLICY
/** Full jitter com `random() === 1` degenera na progressao nominal exata. */
const nominal = (): number => 1
const floor = (): number => 0

describe('computeAuthDelayMs -- escada de atraso (full jitter)', () => {
  it('RL-001: as 4 primeiras falhas nao sofrem atraso nenhum', () => {
    for (const failures of [0, 1, 2, 3, 4]) {
      assert.equal(computeAuthDelayMs(failures, policy, nominal), 0)
    }
  })

  it('RL-002/RL-003: 5a..8a falha = 1 s, 2 s, 4 s, 8 s com o RNG injetado', () => {
    const sequence = [5, 6, 7, 8].map((failures) => computeAuthDelayMs(failures, policy, nominal))
    assert.deepEqual(sequence, [1_000, 2_000, 4_000, 8_000])
  })

  it('RL-004: satura no teto configurado e nunca o excede (30 s default, 60 s configurado)', () => {
    const at60s: RateLimitPolicy = { ...policy, maxDelayMs: 60_000 }

    assert.deepEqual(
      [9, 10, 11, 12, 40].map((f) => computeAuthDelayMs(f, policy, nominal)),
      [16_000, 30_000, 30_000, 30_000, 30_000],
    )
    assert.deepEqual(
      [9, 10, 11, 12, 40].map((f) => computeAuthDelayMs(f, at60s, nominal)),
      [16_000, 32_000, 60_000, 60_000, 60_000],
    )

    for (let failures = 0; failures <= 120; failures += 1) {
      for (const random of [floor, nominal, (): number => 0.5, Math.random]) {
        const delay = computeAuthDelayMs(failures, policy, random)
        assert.equal(delay >= 0, true)
        assert.equal(delay <= policy.maxDelayMs, true)
      }
    }
  })

  it('FULL jitter: o piso e 0 e o teto e a base -- 0 <= atraso <= min(cap, base*2^n)', () => {
    for (const failures of [5, 6, 7, 8, 9, 10, 20]) {
      const cap = computeAuthDelayMs(failures, policy, nominal)
      assert.equal(computeAuthDelayMs(failures, policy, floor), 0)
      assert.equal(computeAuthDelayMs(failures, policy, () => 0.5), Math.round(cap / 2))
      for (let i = 0; i < 50; i += 1) {
        const delay = computeAuthDelayMs(failures, policy, Math.random)
        assert.equal(delay >= 0 && delay <= cap, true, `${String(delay)} fora de [0, ${String(cap)}]`)
      }
    }
  })

  it('o jitter dispersa de facto (nao e uma constante disfarcada)', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 300; i += 1) seen.add(computeAuthDelayMs(9, policy, Math.random))
    assert.equal(seen.size > 1, true)
  })

  it('um `random()` injetado fora de [0,1] nao rompe o contrato', () => {
    for (const rogue of [-5, 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const delay = computeAuthDelayMs(9, policy, () => rogue)
      assert.equal(delay >= 0 && delay <= 16_000, true, `random=${String(rogue)} -> ${String(delay)}`)
    }
  })

  it('entrada nao finita ou fracionaria nao produz atraso absurdo', () => {
    assert.equal(computeAuthDelayMs(Number.NaN, policy, nominal), 0)
    assert.equal(computeAuthDelayMs(Number.POSITIVE_INFINITY, policy, nominal), 0)
    assert.equal(computeAuthDelayMs(5.9, policy, nominal), 1_000)
    assert.equal(computeAuthDelayMs(-3, policy, nominal), 0)
  })

  it('A PROVA ESTRUTURAL: a credencial nao aparece em lado nenhum da funcao', () => {
    // ASSERCAO REJEITADA, e a razao fica registada: `computeAuthDelayMs.length
    // === 3` NAO prova nada. `Function.length` ignora parametros com valor por
    // omissao e `...rest`, portanto acrescentar `credential = ''` como 4o
    // parametro -- exatamente a mudanca que a asercao dizia impedir -- mantem
    // `.length === 3`. Uma asercao que nao pode falhar e pior do que nenhuma,
    // porque parece cobertura.
    //
    // Esta, sim, morre com essa mutacao: o texto do corpo passaria a conter o
    // token. E a PROVA DA ORDEM (que o atraso corre antes da comparacao) esta
    // onde ela e real -- na sonda de rasto de `tracker.test.ts`, que observa a
    // sequencia executada e nao a assinatura.
    const fonte = computeAuthDelayMs.toString()
    for (const token of ['credential', 'credencial', 'secret', 'segredo', 'verify', 'digest']) {
      assert.equal(fonte.includes(token), false, `computeAuthDelayMs menciona \`${token}\``)
    }
  })

  it('o atraso e funcao SO da contagem: mesma contagem, mesmo RNG -> mesmo valor', () => {
    // Corolario testavel da pureza: nada fora dos tres argumentos pode influir.
    for (const failures of [4, 5, 9, 15, 100]) {
      const primeiro = computeAuthDelayMs(failures, policy, () => 0.37)
      for (let i = 0; i < 20; i += 1) {
        assert.equal(computeAuthDelayMs(failures, policy, () => 0.37), primeiro)
      }
    }
  })
})

describe('banAppliesToScope -- a regra que fecha o auto-DoS remoto', () => {
  it('o balde GLOBAL nunca pode ser banido: banir toda a gente inclui o dono', () => {
    // 15 pedidos anonimos nao podem recusar a credencial CORRETA do dono durante
    // uma hora. `02-SEGURANCA.md` 6.1 escopa o ban "para aquele IP"; sob tunel
    // nao ha IP (S2), e ORIG-015 nomeia o teto NIST -- nao o ban -- como o
    // controlo do caso colapsado.
    assert.equal(banAppliesToScope('global'), false)
  })

  it('baldes IDENTIFICADOS continuam banivies: ai o ban castiga uma origem', () => {
    assert.equal(banAppliesToScope('ip'), true)
    assert.equal(banAppliesToScope('session'), true)
  })
})

describe('isBanTriggeredBy / hasReachedBruteForceCeiling', () => {
  it('RL-005: o ban dispara na 15a falha, nao na 14a', () => {
    assert.equal(isBanTriggeredBy(14, policy), false)
    assert.equal(isBanTriggeredBy(15, policy), true)
    assert.equal(isBanTriggeredBy(99, policy), true)
  })

  it('RL-008: o teto NIST e 100 falhas consecutivas na CONTA', () => {
    assert.equal(NIST_BRUTE_FORCE_CEILING, 100)
    assert.equal(policy.bruteForceCeiling, 100)
    assert.equal(hasReachedBruteForceCeiling(99, policy), false)
    assert.equal(hasReachedBruteForceCeiling(100, policy), true)
    assert.equal(hasReachedBruteForceCeiling(101, policy), true)
  })
})

describe('assertRateLimitPolicy -- FAIL LOUD (Q-3)', () => {
  it('a politica adotada e coerente (foi validada no carregamento do modulo)', () => {
    assert.doesNotThrow(() => {
      assertRateLimitPolicy(policy)
    })
  })

  const invalid: Array<[string, RateLimitPolicy]> = [
    ['freeFailures negativo', { ...policy, freeFailures: -1 }],
    ['initialDelayMs zero', { ...policy, initialDelayMs: 0 }],
    ['maxDelayMs fracionario', { ...policy, maxDelayMs: 1.5 }],
    ['banAfterFailures zero', { ...policy, banAfterFailures: 0 }],
    ['banDurationMs negativo', { ...policy, banDurationMs: -1 }],
    ['observationWindowMs zero', { ...policy, observationWindowMs: 0 }],
    ['bruteForceCeiling zero', { ...policy, bruteForceCeiling: 0 }],
    ['teto do atraso abaixo da base', { ...policy, maxDelayMs: 500, initialDelayMs: 1_000 }],
    ['banir antes de atrasar', { ...policy, banAfterFailures: 3 }],
    ['teto NIST abaixo do ban', { ...policy, bruteForceCeiling: 10 }],
    ['teto NIST acima de 100', { ...policy, bruteForceCeiling: 101, banAfterFailures: 15 }],
  ]

  for (const [label, broken] of invalid) {
    it(`recusa: ${label}`, () => {
      assert.throws(
        () => {
          assertRateLimitPolicy(broken)
        },
        (error: unknown) => {
          assert.ok(error instanceof RateLimitPolicyError)
          assert.equal(error.name, 'RateLimitPolicyError')
          assert.match(error.message, /RATE_LIMIT_POLICY_INVALID/u)
          return true
        },
      )
    })
  }

  it('subir o teto acima de 100 e recusado -- "no more than 100" e LIMITE SUPERIOR', () => {
    assert.throws(
      () => {
        assertRateLimitPolicy({ ...policy, bruteForceCeiling: 1_000 })
      },
      /excede o teto normativo/u,
    )
    // Baixar e permitido pela norma ("agencies MAY impose lower limits").
    assert.doesNotThrow(() => {
      assertRateLimitPolicy({ ...policy, bruteForceCeiling: 50 })
    })
  })
})
