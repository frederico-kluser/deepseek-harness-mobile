/**
 * `src/ratelimit/tracker.ts` -- contadores em memoria, ban, teto de memoria e
 * disposer sincrono. Cobre RL-005..RL-010 e ORIG-015 de `04-TESTES.md`.
 *
 * A SEQUENCIA (`runThrottledAttempt`) e a regressao de auto-DoS estao no ficheiro
 * irmao `attempt.test.ts`: sao o veredito, nao os contadores, e mante-los aqui
 * punha este ficheiro acima do teto de 400 linhas.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FakeClock } from '../../support/clock.ts'
import { toSessionId } from '../../../src/brand.ts'
import type { Identity, RateLimiter } from '../../../src/contracts/auth.ts'
import { computeAuthDelayMs, DEFAULT_RATE_LIMIT_POLICY } from '../../../src/ratelimit/policy.ts'
import {
  createFailureTracker,
  GLOBAL_BUCKET_KEY,
  nodeIntervalScheduler,
  resolveIdentityBucket,
  type FailureTracker,
  type IntervalScheduler,
} from '../../../src/ratelimit/tracker.ts'

const policy = DEFAULT_RATE_LIMIT_POLICY
const nominal = (): number => 1

/** Sem tunel de confianca, `ip` chega `undefined`: e o caso REAL de hoje (S2). */
const anonymous: Identity = {}
/**
 * Balde IDENTIFICADO. O ban duro so se aplica a estes -- sobre o balde global
 * ele seria auto-DoS remoto (`policy.ts`, `banAppliesToScope`; regressao inteira
 * em `auto-dos.test.ts`). Os testes de ban usam esta identidade de proposito.
 */
const identificada: Identity = { ip: '198.51.100.77' }

function makeTracker(clock: FakeClock, maxTrackedIdentities = 4_096): FailureTracker {
  return createFailureTracker({ policy, now: () => clock.now(), random: nominal, maxTrackedIdentities })
}

describe('resolveIdentityBucket -- a decisao IP vs sessao vs global (spike S2)', () => {
  it('ORIG-015: sem IP de confianca a identidade colapsa no balde GLOBAL', () => {
    // A medicao da Onda 0: `X-Forwarded-For` e forjavel e a origem e sempre
    // 127.0.0.1. Enquanto `trustEdgeHeaders` for false, `Identity.ip` e
    // `undefined` -- e o codigo assume isso em vez de inventar um IP.
    assert.deepEqual(resolveIdentityBucket(anonymous), { scope: 'global', key: GLOBAL_BUCKET_KEY })
    assert.equal(resolveIdentityBucket({ ip: undefined, sessionId: undefined }).key, GLOBAL_BUCKET_KEY)
    assert.equal(resolveIdentityBucket({ ip: '' }).key, GLOBAL_BUCKET_KEY)
  })

  it('com sessao, conta por sessao -- e a chave nao guarda o id em claro', () => {
    const sessionId = toSessionId('a'.repeat(40))
    const bucket = resolveIdentityBucket({ sessionId })
    assert.equal(bucket.scope, 'session')
    assert.equal(bucket.key.startsWith('sess:'), true)
    assert.equal(bucket.key.includes('aaaaaaaa'), false, 'o id de sessao nao pode ficar retido na chave')
    assert.equal(bucket.key.length, 'sess:'.length + 32, 'chave de tamanho FIXO: um cookie de 1 MB nao vira chave de 1 MB')
  })

  it('com IP (so possivel se um dia a config confiar na borda), conta por IP e o IP tem precedencia', () => {
    const sessionId = toSessionId('b'.repeat(40))
    const withIp = resolveIdentityBucket({ ip: '203.0.113.7', sessionId })
    assert.equal(withIp.scope, 'ip')
    assert.notEqual(withIp.key, resolveIdentityBucket({ ip: '203.0.113.8', sessionId }).key)
  })
})

describe('createFailureTracker -- escada, ban e janela', () => {
  it('satisfaz o contrato congelado `RateLimiter`', () => {
    const tracker = makeTracker(new FakeClock(1_000))
    const asContract: RateLimiter = tracker
    assert.deepEqual(asContract.check(anonymous), { allowed: true, retryAfterMs: 0 })
    tracker.dispose()
  })

  it('RL-001..RL-003: o atraso interno segue a escada da contagem', () => {
    const tracker = makeTracker(new FakeClock(0))
    const delays: number[] = []
    for (let i = 0; i < 8; i += 1) {
      delays.push(tracker.check(anonymous).retryAfterMs)
      tracker.recordFailure(anonymous)
    }
    assert.deepEqual(delays, [0, 0, 0, 0, 0, 1_000, 2_000, 4_000])
    tracker.dispose()
  })

  it('RL-005: a 15a falha bane a identidade IDENTIFICADA e `allowed` passa a false', () => {
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 14; i += 1) tracker.recordFailure(identificada)
    assert.equal(tracker.check(identificada).allowed, true)

    const record = tracker.recordFailure(identificada)
    assert.equal(record.identityFailures, 15)
    assert.equal(record.banned, true)
    assert.equal(tracker.check(identificada).allowed, false)
    tracker.dispose()
  })

  it('RL-005: o ban NAO muda o tempo, so o veredito -- responder mais depressa seria o oraculo', () => {
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 15; i += 1) tracker.recordFailure(identificada)

    const banned = tracker.check(identificada)
    assert.equal(banned.allowed, false)
    assert.equal(banned.retryAfterMs, computeAuthDelayMs(15, policy, nominal))
    assert.equal(banned.retryAfterMs, policy.maxDelayMs)
    tracker.dispose()
  })

  it('RL-006: o ban expira quando o relogio anda e a tentativa volta a ser avaliada', () => {
    const clock = new FakeClock(0)
    const tracker = makeTracker(clock)
    for (let i = 0; i < 15; i += 1) tracker.recordFailure(identificada)
    assert.equal(tracker.check(identificada).allowed, false)

    clock.advance(policy.banDurationMs - 1)
    assert.equal(tracker.check(identificada).allowed, false, 'um milissegundo antes ainda esta banido')

    clock.advance(2)
    const after = tracker.check(identificada)
    assert.equal(after.allowed, true)
    assert.equal(after.retryAfterMs, 0, 'a janela de observacao tambem ja passou: a escada zera')
    tracker.dispose()
  })

  it('a janela de observacao esquece falhas antigas, mas NAO levanta um ban vivo', () => {
    const clock = new FakeClock(0)
    const tracker = makeTracker(clock)
    for (let i = 0; i < 6; i += 1) tracker.recordFailure(identificada)
    assert.equal(tracker.check(identificada).retryAfterMs, 2_000)

    clock.advance(policy.observationWindowMs + 1)
    assert.equal(tracker.check(identificada).retryAfterMs, 0, 'findtime: falhas fora da janela nao contam')

    for (let i = 0; i < 15; i += 1) tracker.recordFailure(identificada)
    clock.advance(policy.observationWindowMs + 1)
    assert.equal(tracker.check(identificada).allowed, false, 'a janela expirou mas o ban de 60 min continua')
    tracker.dispose()
  })

  it('RL-007: sucesso zera a escada da identidade e o contador da conta', () => {
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 7; i += 1) tracker.recordFailure(anonymous)
    assert.equal(tracker.snapshot().accountFailures, 7)

    tracker.recordSuccess(anonymous)
    assert.equal(tracker.snapshot().accountFailures, 0)
    assert.equal(tracker.check(anonymous).retryAfterMs, 0)
    tracker.dispose()
  })

  it('um sucesso NAO lava um ban vivo (o ban e da identidade, nao da credencial)', () => {
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 15; i += 1) tracker.recordFailure(identificada)
    tracker.recordSuccess(identificada)
    assert.equal(tracker.check(identificada).allowed, false)
    tracker.dispose()
  })

  it('o ban NAO e rearmado por pedidos feitos durante ele: tem fim determinado', () => {
    // Sem esta propriedade, um pedido por hora mantinha a identidade fora para
    // sempre -- "ban temporario" sem fim e lockout com outro nome.
    const clock = new FakeClock(0)
    const tracker = makeTracker(clock)
    for (let i = 0; i < 15; i += 1) tracker.recordFailure(identificada)

    for (let i = 0; i < 10; i += 1) {
      clock.advance(policy.banDurationMs / 12)
      tracker.recordFailure(identificada)
    }
    clock.set(policy.banDurationMs + 1)
    assert.equal(tracker.check(identificada).allowed, true, 'o ban tem de acabar na hora marcada')
    tracker.dispose()
  })

  it('RL-009: identidades distintas tem bans independentes e a CONTA soma todas', () => {
    const tracker = makeTracker(new FakeClock(0))
    const ips: Identity[] = [{ ip: '198.51.100.1' }, { ip: '198.51.100.2' }, { ip: '198.51.100.3' }]

    for (const identity of ips) {
      for (let i = 0; i < 15; i += 1) tracker.recordFailure(identity)
    }
    for (const identity of ips) assert.equal(tracker.check(identity).allowed, false)

    // Rodar identidade nao apaga a escada da conta: e o que impede o bypass.
    assert.equal(tracker.snapshot().accountFailures, 45)
    assert.equal(tracker.check({ ip: '198.51.100.9' }).allowed, true, 'um IP novo nao nasce banido')
    tracker.dispose()
  })

  it('RL-008: o teto da conta acende aos 100, somando identidades diferentes', () => {
    const tracker = makeTracker(new FakeClock(0))
    let last = tracker.recordFailure({ ip: 'seed' })
    for (let i = 1; i < 100; i += 1) last = tracker.recordFailure({ ip: `rotativo-${String(i)}` })

    assert.equal(last.accountFailures, 100)
    assert.equal(last.ceilingReached, true)
    assert.equal(tracker.snapshot().ceilingReached, true)
    tracker.dispose()
  })
})

describe('memoria -- o limitador nao pode virar o proprio DoS', () => {
  it('RL-010: 10^4 identidades novas nao fazem a estrutura crescer sem limite', () => {
    const tracker = makeTracker(new FakeClock(0), 256)
    for (let i = 0; i < 10_000; i += 1) tracker.recordFailure({ ip: `atacante-${String(i)}` })

    const snapshot = tracker.snapshot()
    assert.equal(snapshot.trackedIdentities <= 256, true, `baldes vivos: ${String(snapshot.trackedIdentities)}`)
    assert.equal(snapshot.accountFailures, 10_000, 'o contador da conta nao e evitavel por rotacao')
    assert.equal(snapshot.ceilingReached, true)
    tracker.dispose()
  })

  it('`check()` sozinho NAO aloca balde nenhum -- so `recordFailure` cria', () => {
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 5_000; i += 1) tracker.check({ ip: `sonda-${String(i)}` })
    assert.equal(tracker.snapshot().trackedIdentities, 0)
    tracker.dispose()
  })

  it('o despejo prefere baldes SEM ban vivo (nao se lava um ban criando identidades)', () => {
    const tracker = makeTracker(new FakeClock(0), 8)
    const vitima: Identity = { ip: '203.0.113.99' }
    for (let i = 0; i < 15; i += 1) tracker.recordFailure(vitima)
    assert.equal(tracker.check(vitima).allowed, false)

    for (let i = 0; i < 500; i += 1) tracker.recordFailure({ ip: `enchente-${String(i)}` })
    assert.equal(tracker.check(vitima).allowed, false, 'o ban sobreviveu a enchente de identidades')
    assert.equal(tracker.snapshot().trackedIdentities <= 8, true)
    tracker.dispose()
  })

  it('com a tabela INTEIRA banida, o despejo cai no mais antigo -- e a conta continua a somar', () => {
    // O pior caso honesto: se o atacante conseguir encher o teto so com baldes
    // banidos, um ban antigo acaba por sair. Nao ha como evitar sem memoria
    // ilimitada -- e memoria ilimitada e o DoS que RL-010 fecha. A rede de
    // seguranca e o contador da CONTA, que nao e despejavel.
    const tracker = makeTracker(new FakeClock(0), 4)
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 15; j += 1) tracker.recordFailure({ ip: `banido-${String(i)}` })
    assert.equal(tracker.snapshot().trackedIdentities, 4)
    assert.equal(tracker.check({ ip: 'banido-0' }).allowed, false)

    tracker.recordFailure({ ip: 'recem-chegado' })
    assert.equal(tracker.snapshot().trackedIdentities, 4, 'o teto continua a ser respeitado')
    assert.equal(tracker.check({ ip: 'banido-0' }).allowed, true, 'o ban mais antigo foi o despejado')
    assert.equal(tracker.check({ ip: 'banido-3' }).allowed, false, 'os mais recentes ficaram')
    assert.equal(tracker.snapshot().accountFailures, 61)
    tracker.dispose()
  })

  it('recusa um teto de identidades invalido (fail loud, nao "assume um numero")', () => {
    for (const maxTrackedIdentities of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => createFailureTracker({ policy, now: () => 0, random: nominal, maxTrackedIdentities }),
        /RATE_LIMIT_TRACKER_INVALID/u,
      )
    }
  })
})

describe('disposer -- Q-2, SINCRONO', () => {
  it('esvazia o mapa, e usar o limitador depois de disposto LANCA', () => {
    const tracker = makeTracker(new FakeClock(0))
    tracker.recordFailure(anonymous)
    assert.equal(tracker.snapshot().trackedIdentities, 1)

    tracker.dispose()
    tracker.dispose() // idempotente

    assert.throws(() => tracker.check(anonymous), /RATE_LIMIT_TRACKER_DISPOSED/u)
    assert.throws(() => tracker.recordFailure(anonymous), /RATE_LIMIT_TRACKER_DISPOSED/u)
    assert.throws(() => {
      tracker.recordSuccess(anonymous)
    }, /RATE_LIMIT_TRACKER_DISPOSED/u)
    assert.equal(tracker.snapshot().trackedIdentities, 0)
  })

  it('com varredura periodica injetada, o disposer faz `clearInterval` + esvaziar o mapa', () => {
    const clock = new FakeClock(0)
    let armed = 0
    let cleared = 0
    let tick: (() => void) | undefined
    const scheduler: IntervalScheduler = {
      setInterval(callback: () => void): unknown {
        armed += 1
        tick = callback
        return { id: armed }
      },
      clearInterval: (): void => void (cleared += 1),
    }
    const deps = { policy, now: (): number => clock.now(), random: nominal, maxTrackedIdentities: 64 }
    const tracker = createFailureTracker({ ...deps, sweep: { everyMs: 60_000, scheduler } })

    tracker.recordFailure({ ip: 'antigo' })
    assert.equal(armed, 1)
    assert.equal(tracker.snapshot().trackedIdentities, 1)

    clock.advance(policy.observationWindowMs + 1)
    assert.notEqual(tick, undefined)
    tick?.()
    assert.equal(tracker.snapshot().trackedIdentities, 0, 'a varredura podou o balde fora da janela')

    tracker.dispose()
    assert.equal(cleared, 1)
    tracker.dispose()
    assert.equal(cleared, 1, 'o disposer e idempotente e nao limpa duas vezes')
  })

  it('o agendador real do Node arma e desarma sem segurar o processo', () => {
    const handle = nodeIntervalScheduler.setInterval(() => {
      throw new Error('nunca deve disparar neste teste')
    }, 1_000_000)
    assert.notEqual(handle, undefined)
    nodeIntervalScheduler.clearInterval(handle)
  })
})
