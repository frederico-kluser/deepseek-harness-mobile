/**
 * `src/tunnel/ttl.ts` -- TUN-018, TUN-019, TUN-026 e o veredito do boot.
 *
 * Relogio INJETADO (`test/support/clock.ts`): nenhum teste espera tempo real. Um
 * TTL de 60 minutos com relogio verdadeiro seria um teste de uma hora.
 *
 * A ameaca que isto cobre (T10 de `02-SEGURANCA.md`): abre-se o tunel numa terca
 * a noite, fecha-se o portatil, e descobre-se no domingo que ele nunca fechou.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import {
  applyTtlExpiry,
  assertValidTtlMinutes,
  createTtlEffects,
  createTunnelTtl,
  decideOnResume,
  EVENTO_TTL_EXPIRADO,
  isTtlExpired,
  ownerExpiryMessage,
  ttlDeadline,
  ttlRemainingMs,
  TTL_MAX_MINUTES,
  TunnelTtlError,
  type TtlEffects,
  type TtlExpiryFacts,
} from '../../../src/tunnel/ttl.ts'
import { FakeScheduler } from '../../support/child-double.ts'
import { FakeClock } from '../../support/clock.ts'

const FACTS: TtlExpiryFacts = {
  startedAt: 1_000,
  expiresAt: 3_601_000,
  ttlMinutes: 60,
  detectedBy: 'timer',
}

interface Recorder {
  readonly order: string[]
  readonly effects: TtlEffects
  readonly audited: AuditEvent[]
  readonly notices: string[]
}

function recorder(overrides: Partial<TtlEffects> = {}): Recorder {
  const order: string[] = []
  const audited: AuditEvent[] = []
  const notices: string[] = []

  const base = createTtlEffects({
    stopTunnel: (): void => {
      order.push('stopTunnel')
    },
    sessions: {
      revokeAll: (): void => {
        order.push('revokeAllSessions')
      },
    },
    audit: {
      append: (event: AuditEvent): void => {
        order.push('audit')
        audited.push(event)
      },
    },
    notifyOwner: (message: string): void => {
      order.push('notifyOwner')
      notices.push(message)
    },
  })

  return { order, audited, notices, effects: { ...base, ...overrides } }
}

const silentLog = { info: (): void => {}, error: (): void => {} }

describe('TUN-019: `ttlMinutes` obrigatorio, tecto 480, SEM default e SEM clamp', () => {
  it('ausente, zero, negativo e nao inteiro sao recusados', () => {
    for (const value of [undefined, null, 0, -1, -60, 1.5, Number.NaN, '60']) {
      assert.throws(() => assertValidTtlMinutes(value), TunnelTtlError, `aceitou ${String(value)}`)
    }
  })

  it('acima do tecto e RECUSADO, nunca reduzido em silencio', () => {
    assert.throws(() => assertValidTtlMinutes(TTL_MAX_MINUTES + 1), TunnelTtlError)
    // Um `ttlMinutes: 10080` reduzido a 480 diz ao utilizador que ele pediu uma
    // semana e recebeu uma semana. Fail LOUD.
    assert.throws(() => assertValidTtlMinutes(10_080), TunnelTtlError)
    assert.equal(assertValidTtlMinutes(TTL_MAX_MINUTES), 480)
  })

  it('a mensagem diz que NAO ha default no codigo', () => {
    try {
      assertValidTtlMinutes(undefined)
      assert.fail('devia ter lancado')
    } catch (error) {
      assert.equal(error instanceof TunnelTtlError, true)
      assert.equal((error as TunnelTtlError).code, 'TTL_INVALID')
      assert.equal((error as Error).message.includes('Nao ha default no codigo'), true)
    }
  })

  it('valores validos passam sem alteracao', () => {
    for (const value of [1, 60, 120, 479, 480]) assert.equal(assertValidTtlMinutes(value), value)
  })
})

describe('aritmetica do prazo', () => {
  it('o prazo e `startedAt + ttlMinutes * 60_000`', () => {
    assert.equal(ttlDeadline(1_000, 60), 1_000 + 3_600_000)
    assert.equal(ttlRemainingMs(1_000, 60, 1_000), 3_600_000)
    assert.equal(ttlRemainingMs(1_000, 60, 3_601_000), 0)
    assert.equal(ttlRemainingMs(1_000, 60, 9_999_999), 0, 'nunca negativo')
    assert.equal(isTtlExpired(1_000, 60, 3_601_000), true)
    assert.equal(isTtlExpired(1_000, 60, 3_600_999), false)
  })
})

describe('TUN-018: a ORDEM dos efeitos ao expirar', () => {
  it('derruba -> invalida sessoes -> auditoria -> aviso ao dono', () => {
    const rec = recorder()
    applyTtlExpiry(rec.effects, silentLog, FACTS)

    assert.deepEqual(rec.order, ['stopTunnel', 'revokeAllSessions', 'audit', 'notifyOwner'])
  })

  it('o aviso vem DEPOIS do registo -- a auditoria nao pode depender da rede', () => {
    const rec = recorder()
    applyTtlExpiry(rec.effects, silentLog, FACTS)

    assert.ok(rec.order.indexOf('audit') < rec.order.indexOf('notifyOwner'))
  })

  it('o aviso a falhar NAO desfaz nem impede os tres passos anteriores', () => {
    const rec = recorder({
      notifyOwner: (): void => {
        throw new Error('Telegram fora do ar')
      },
    })
    const erros: string[] = []

    assert.doesNotThrow(() =>
      applyTtlExpiry(rec.effects, { info: (): void => {}, error: (m) => erros.push(m) }, FACTS),
    )
    assert.deepEqual(rec.order, ['stopTunnel', 'revokeAllSessions', 'audit'])
    // A excepcao NAO e engolida: fica registada.
    assert.equal(erros.some((m) => m.includes('aviso ao dono FALHOU')), true)
  })

  it('a auditoria a falhar nao impede o aviso -- a exposicao JA foi fechada', () => {
    const rec = recorder({
      audit: (): void => {
        throw new Error('disco cheio')
      },
    })
    const erros: string[] = []

    applyTtlExpiry(rec.effects, { info: (): void => {}, error: (m) => erros.push(m) }, FACTS)

    assert.deepEqual(rec.order, ['stopTunnel', 'revokeAllSessions', 'notifyOwner'])
    assert.equal(erros.some((m) => m.includes('auditoria FALHOU')), true)
  })

  it('uma falha a FECHAR a exposicao sobe: nunca e mitigada em silencio', () => {
    const rec = recorder({
      revokeAllSessions: (): void => {
        throw new Error('store indisponivel')
      },
    })
    assert.throws(() => applyTtlExpiry(rec.effects, silentLog, FACTS))
  })

  it('o registo de auditoria nomeia o evento e o resultado', () => {
    const rec = recorder()
    applyTtlExpiry(rec.effects, silentLog, FACTS)

    assert.equal(rec.audited[0]?.evento.startsWith(EVENTO_TTL_EXPIRADO), true)
    assert.equal(rec.audited[0]?.resultado, 'permitido')
  })

  it('o aviso ao dono NAO leva a URL do tunel nem caminho absoluto', () => {
    const message = ownerExpiryMessage(60)
    assert.equal(message.includes('http'), false, 'a URL e efemera e ja nao existe')
    assert.equal(/(^|\s)\/[\w./-]+/u.test(message), false)
    assert.equal(message.includes('60'), true)
  })
})

describe('o temporizador, com relogio injetado', () => {
  it('arma para o tempo restante e dispara os quatro efeitos', () => {
    const clock = new FakeClock(1_000)
    const scheduler = new FakeScheduler()
    const rec = recorder()

    const ttl = createTunnelTtl({
      ttlMinutes: 60,
      scheduler,
      now: () => clock.now(),
      effects: rec.effects,
      log: silentLog,
    })
    ttl.arm(1_000)

    assert.deepEqual(scheduler.delays(), [3_600_000])
    assert.equal(ttl.expiresAt, 3_601_000)
    assert.deepEqual(rec.order, [], 'ainda nada aconteceu')

    clock.advance(3_600_000)
    scheduler.runLast()

    assert.deepEqual(rec.order, ['stopTunnel', 'revokeAllSessions', 'audit', 'notifyOwner'])
    assert.equal(ttl.expiresAt, undefined)
  })

  it('um `startedAt` vindo do DISCO que ja passou do prazo expira JA, sem agendar', () => {
    const clock = new FakeClock(10_000_000)
    const scheduler = new FakeScheduler()
    const rec = recorder()

    const ttl = createTunnelTtl({
      ttlMinutes: 60,
      scheduler,
      now: () => clock.now(),
      effects: rec.effects,
      log: silentLog,
    })
    // Um `setTimeout(0)` daria o mesmo resultado um tick depois -- e esse tick e
    // uma janela em que o tunel esta vivo e ninguem sabe.
    ttl.arm(1_000)

    assert.deepEqual(scheduler.scheduled, [], 'nada e agendado')
    assert.deepEqual(rec.order, ['stopTunnel', 'revokeAllSessions', 'audit', 'notifyOwner'])
  })

  it('o disposer CANCELA o prazo em vez de o cumprir', () => {
    const scheduler = new FakeScheduler()
    const rec = recorder()

    const ttl = createTunnelTtl({
      ttlMinutes: 60,
      scheduler,
      now: () => 0,
      effects: rec.effects,
      log: silentLog,
    })
    ttl.arm(0)
    ttl.dispose()
    ttl.dispose()

    assert.equal(scheduler.pending.length, 0)
    // Disparar a expiracao no disposer notificaria o dono de um vencimento que
    // nao aconteceu: descarregar o plugin ja derruba o tunel pelo LIFO.
    assert.deepEqual(rec.order, [])
    assert.equal(ttl.expiresAt, undefined)
  })

  it('recusa `ttlMinutes` invalido na construcao (fail loud, nao no disparo)', () => {
    assert.throws(
      () =>
        createTunnelTtl({
          ttlMinutes: 0,
          scheduler: new FakeScheduler(),
          now: () => 0,
          effects: recorder().effects,
          log: silentLog,
        }),
      TunnelTtlError,
    )
  })
})

describe('TUN-026: um `/status` ou um acesso NAO estendem o TTL', () => {
  it('a superficie NAO tem `renew`, `touch` nem `extend` -- a ausencia e o controlo', () => {
    const ttl = createTunnelTtl({
      ttlMinutes: 60,
      scheduler: new FakeScheduler(),
      now: () => 0,
      effects: recorder().effects,
      log: silentLog,
    })
    ttl.arm(0)

    const surface = ttl as unknown as Record<string, unknown>
    for (const method of ['renew', 'touch', 'extend', 'keepAlive', 'refresh']) {
      assert.equal(surface[method], undefined, `${method} nao pode existir`)
    }
    ttl.dispose()
  })

  it('ler o prazo muitas vezes nao o move: so um `arm` novo abre janela nova', () => {
    const clock = new FakeClock(0)
    const scheduler = new FakeScheduler()

    const ttl = createTunnelTtl({
      ttlMinutes: 60,
      scheduler,
      now: () => clock.now(),
      effects: recorder().effects,
      log: silentLog,
    })
    ttl.arm(0)
    const prazo = ttl.expiresAt

    for (let i = 0; i < 20; i += 1) {
      clock.advance(60_000)
      assert.equal(ttl.expiresAt, prazo, 'um TTL que se estende com o uso nunca expira para quem usa')
    }
    assert.equal(scheduler.scheduled.length, 1, 'nenhum temporizador novo')
    ttl.dispose()
  })
})

describe('o veredito do BOOT: o TTL sobrevive a morte do event loop', () => {
  it('`startedAt` persistido + relogio = "o prazo ja passou", sem temporizador nenhum', () => {
    // Um `setTimeout` morre com o event loop: SIGKILL no DSH, reinicio da
    // maquina, queda de energia. O `cloudflared` `detached` NAO morre com ele.
    assert.deepEqual(decideOnResume(1_000, 60, 3_601_000), { expired: true, overdueMs: 0 })
    assert.deepEqual(decideOnResume(1_000, 60, 5_000_000), { expired: true, overdueMs: 1_399_000 })
  })

  it('dentro do prazo devolve o que falta -- o boot rearma com o resto, nao com o total', () => {
    assert.deepEqual(decideOnResume(1_000, 60, 1_000), { expired: false, remainingMs: 3_600_000 })
    assert.deepEqual(decideOnResume(1_000, 60, 601_000), { expired: false, remainingMs: 3_000_000 })
  })
})
