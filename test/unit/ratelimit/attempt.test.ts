/**
 * `runThrottledAttempt` -- a SEQUENCIA (atraso ANTES da comparacao) e o VEREDITO
 * de tres ramos. Cobre RL-011/RL-012/RL-013 e, sobretudo, a REGRESSAO DE
 * AUTO-DoS REMOTO encontrada em revisao adversarial.
 *
 * PORQUE FICHEIRO PROPRIO, e nao dentro de `tracker.test.ts`: sao duas coisas
 * distintas -- ali provam-se os CONTADORES, aqui prova-se o VEREDITO. Juntos
 * passavam o teto de 400 linhas, e a regressao merece um sitio onde se veja pelo
 * nome do ficheiro que existe e o que fecha.
 *
 * O DEFEITO QUE ESTE FICHEIRO IMPEDE DE VOLTAR, em quatro passos:
 *   1. sob tunel nao ha IP (S2), e num login ainda nao ha sessao -> balde GLOBAL;
 *   2. o ban de 15 falhas era aplicado a esse balde -> 15 pedidos ANONIMOS
 *      recusavam a credencial CORRETA do dono durante 60 minutos;
 *   3. `granted ? recordSuccess : recordFailure` contava essas recusas como
 *      falhas da CONTA -> o dono, insistindo com a senha certa, empurrava-se ate
 *      ao teto NIST e acendia o modo restrito sozinho;
 *   4. `bannedUntil` era REARMADO a cada falha -> um pedido por hora mantinha-o
 *      fora para sempre.
 *
 * A restricao que estes testes fixam: **um atacante remoto nao autenticado nao
 * pode, por repeticao, negar o acesso ao dono que apresenta a credencial
 * correta.**
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FakeClock } from '../../support/clock.ts'
import type { Identity } from '../../../src/contracts/auth.ts'
import { DEFAULT_RATE_LIMIT_POLICY } from '../../../src/ratelimit/policy.ts'
import {
  createFailureTracker,
  runThrottledAttempt,
  type FailureTracker,
  type ThrottledAttemptOutcome,
} from '../../../src/ratelimit/tracker.ts'

const policy = DEFAULT_RATE_LIMIT_POLICY
const nominal = (): number => 1

/** O caso REAL de producao: sem IP de confianca e sem sessao -> balde global. */
const anonymous: Identity = {}
/** Balde IDENTIFICADO -- o unico escopo em que o ban duro se aplica. */
const identificada: Identity = { ip: '198.51.100.77' }

function makeTracker(clock: FakeClock, maxTrackedIdentities = 4_096): FailureTracker {
  return createFailureTracker({ policy, now: () => clock.now(), random: nominal, maxTrackedIdentities })
}

interface Probe {
  readonly trail: string[]
  readonly wait: (ms: number) => Promise<void>
  readonly verify: () => boolean
  readonly calls: () => number
}

/** Regista a sequencia de eventos para provar quem correu primeiro. */
function instrument(verified: boolean): Probe {
  const trail: string[] = []
  let calls = 0
  const wait = (ms: number): Promise<void> => {
    trail.push(`wait:${String(ms)}`)
    return Promise.resolve()
  }
  const verify = (): boolean => {
    calls += 1
    trail.push('verify')
    return verified
  }
  return { trail, wait, verify, calls: (): number => calls }
}

describe('runThrottledAttempt -- a ORDEM e uma propriedade de seguranca', () => {
  it('RL-012: o atraso corre ANTES da comparacao, e pelo agendador injetado', async () => {
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 6; i += 1) tracker.recordFailure(anonymous)

    const probe = instrument(false)
    const started = Date.now()
    const outcome = await runThrottledAttempt(tracker, anonymous, probe.verify, probe.wait)

    assert.deepEqual(probe.trail, ['wait:2000', 'verify'], 'wait TEM de vir antes de verify')
    assert.equal(outcome.delayMs, 2_000)
    assert.equal(Date.now() - started < 1_000, true, 'nenhum sleep real: o teste nao pode dormir 2 s')
    tracker.dispose()
  })

  it('sucesso: veredito concedido, escada zerada, e o atraso continua a preceder a comparacao', async () => {
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 5; i += 1) tracker.recordFailure(anonymous)

    const probe = instrument(true)
    const outcome = await runThrottledAttempt(tracker, anonymous, probe.verify, probe.wait)

    assert.deepEqual(probe.trail, ['wait:1000', 'verify'])
    assert.equal(outcome.granted, true)
    assert.equal(outcome.deniedByBan, false)
    assert.equal(outcome.accountFailures, 0)
    assert.equal(outcome.ceilingReached, false)
    tracker.dispose()
  })

  it('RL-011: credencial CORRETA durante o ban de uma identidade IDENTIFICADA e NEGADA', async () => {
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 15; i += 1) tracker.recordFailure(identificada)

    const probe = instrument(true)
    const outcome = await runThrottledAttempt(tracker, identificada, probe.verify, probe.wait)

    assert.equal(outcome.granted, false)
    assert.equal(outcome.deniedByBan, true)
    assert.equal(probe.calls(), 1, 'a comparacao corre na mesma -- e o que iguala o custo do caminho')
    tracker.dispose()
  })

  it('RL-013: o caminho "banido" e o caminho "senha errada" gastam as MESMAS operacoes', async () => {
    const banido = makeTracker(new FakeClock(0))
    const errado = makeTracker(new FakeClock(0))
    for (let i = 0; i < 15; i += 1) banido.recordFailure(identificada)
    for (let i = 0; i < 15; i += 1) errado.recordFailure({ ip: 'outro' })

    const a = instrument(true) // banido, credencial certa
    const b = instrument(false) // nao banido, credencial errada
    await runThrottledAttempt(banido, identificada, a.verify, a.wait)
    await runThrottledAttempt(errado, identificada, b.verify, b.wait)

    assert.equal(a.calls(), b.calls(), 'mesmo numero de comparacoes')
    assert.deepEqual(
      a.trail.map((step) => step.split(':')[0]),
      b.trail.map((step) => step.split(':')[0]),
      'mesma sequencia de operacoes, na mesma ordem',
    )
    banido.dispose()
    errado.dispose()
  })

  it('o teto NIST e reportado pelo resultado, sem que o limitador execute nada', async () => {
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 99; i += 1) tracker.recordFailure({ ip: `r-${String(i)}` })

    const probe = instrument(false)
    const outcome = await runThrottledAttempt(tracker, anonymous, probe.verify, probe.wait)
    assert.equal(outcome.accountFailures, 100)
    assert.equal(outcome.ceilingReached, true)
    tracker.dispose()
  })
})

describe('AUTO-DoS REMOTO FECHADO -- a sonda da revisao adversarial', () => {
  /** O atacante: pedidos anonimos, sempre com a credencial errada. */
  async function martelar(tracker: FailureTracker, vezes: number): Promise<void> {
    for (let i = 0; i < vezes; i += 1) {
      const probe = instrument(false)
      await runThrottledAttempt(tracker, anonymous, probe.verify, probe.wait)
    }
  }

  /** O dono: mesmo balde global (nao tem outro), credencial CORRETA. */
  async function donoTenta(tracker: FailureTracker): Promise<ThrottledAttemptOutcome> {
    const probe = instrument(true)
    return runThrottledAttempt(tracker, anonymous, probe.verify, probe.wait)
  }

  it('15 falhas anonimas NAO trancam o dono -- ele entra a seguir com a senha certa', async () => {
    const tracker = makeTracker(new FakeClock(0))
    await martelar(tracker, 15)

    const dono = await donoTenta(tracker)
    assert.equal(dono.granted, true, 'o dono TEM de entrar: 15 pedidos anonimos nao podem tranca-lo')
    assert.equal(dono.deniedByBan, false)
    assert.equal(tracker.snapshot().accountFailures, 0, 'o sucesso zera a serie (NIST 3.2.2)')
    tracker.dispose()
  })

  it('nem 500 -- o balde GLOBAL nunca e banido, so atrasado', async () => {
    const tracker = makeTracker(new FakeClock(0))
    await martelar(tracker, 500)

    assert.equal(tracker.check(anonymous).allowed, true, 'o balde colapsado nao pode ser banido')
    assert.equal(
      tracker.check(anonymous).retryAfterMs,
      policy.maxDelayMs,
      'o que resta e o atraso exponencial saturado -- abranda sem trancar',
    )
    assert.equal((await donoTenta(tracker)).granted, true)
    tracker.dispose()
  })

  it('o dono a insistir com a senha CERTA nunca se empurra para o teto NIST', async () => {
    // O cenario exato da refutacao: antes, cada insistencia contava como falha
    // de conta e em ~85 tentativas o proprio dono acendia o modo restrito.
    const tracker = makeTracker(new FakeClock(0))
    await martelar(tracker, 15)

    for (let i = 0; i < 200; i += 1) {
      const dono = await donoTenta(tracker)
      assert.equal(dono.granted, true)
      assert.equal(dono.ceilingReached, false)
      assert.equal(dono.accountFailures, 0)
    }
    assert.equal(tracker.snapshot().ceilingReached, false)
    tracker.dispose()
  })

  it('um unico login do dono apaga 99 tentativas do atacante (NIST: SHOULD disregard)', async () => {
    const tracker = makeTracker(new FakeClock(0))
    await martelar(tracker, 99)
    assert.equal(tracker.snapshot().accountFailures, 99, 'a 1 do teto')

    assert.equal((await donoTenta(tracker)).granted, true)
    assert.equal(tracker.snapshot().accountFailures, 0)
    assert.equal(tracker.snapshot().ceilingReached, false)
    tracker.dispose()
  })

  it('sob ban de IP, a credencial CORRETA e negada (RL-011) mas NAO conta como falha', async () => {
    // O ban continua a valer no caminho identificado -- o que muda e a
    // contabilidade: uma credencial correta nunca e "failed authentication
    // attempt", logo nao pode empurrar a conta para o teto.
    const tracker = makeTracker(new FakeClock(0))
    for (let i = 0; i < 15; i += 1) tracker.recordFailure(identificada)
    assert.equal(tracker.snapshot().accountFailures, 15)

    const probe = instrument(true)
    const outcome = await runThrottledAttempt(tracker, identificada, probe.verify, probe.wait)

    assert.equal(outcome.granted, false, 'RL-011 mantem-se no balde identificado')
    assert.equal(outcome.deniedByBan, true)
    assert.equal(outcome.accountFailures, 0, 'apresentar a credencial certa quebra a serie da conta')
    assert.equal(tracker.check(identificada).allowed, false, 'e nao lava o ban da origem')
    tracker.dispose()
  })

  it('o controlo NAO foi enfraquecido: o atacante sozinho continua a acender o teto', async () => {
    const tracker = makeTracker(new FakeClock(0))
    await martelar(tracker, 99)
    assert.equal(tracker.snapshot().ceilingReached, false)

    const probe = instrument(false)
    const centesima = await runThrottledAttempt(tracker, anonymous, probe.verify, probe.wait)
    assert.equal(centesima.accountFailures, 100)
    assert.equal(centesima.ceilingReached, true, 'o teto NIST continua a ser o controlo principal')
    tracker.dispose()
  })
})
