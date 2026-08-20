/**
 * `src/proc/retry.ts` -- SUP-002, SUP-003, SUP-004, SUP-005, e a prova de que o
 * bloco de orcamento/backoff e UM SO no repositorio.
 *
 * PORQUE ESTE FICHEIRO EXISTE separado de `supervisor.test.ts`: a decisao "o que
 * fazer depois de uma tentativa acabar" nao precisa de subprocesso nenhum para
 * ser exercitada, e as suas propriedades (progressao, saturacao, janela do
 * jitter, zeragem por uptime) sao as que a revisao adversarial vai querer ver
 * medidas em vez de descritas.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import type { BackoffConfig } from '../../../src/config/schema.ts'
import { computeBackoffDelay } from '../../../src/proc/backoff.ts'
import { createRestartBudget, type RestartBudget } from '../../../src/proc/retry.ts'
import { FakeScheduler } from '../../support/child-double.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'

const BACKOFF: BackoffConfig = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 10,
  resetAfterMs: 60_000,
}

interface Harness {
  budget: RestartBudget
  scheduler: FakeScheduler
  runs: number[]
  failures: string[]
  logger: ReturnType<typeof createFakeLogger>
}

function makeBudget(overrides: Partial<BackoffConfig> = {}, random = (): number => 0): Harness {
  const scheduler = new FakeScheduler()
  const logger = createFakeLogger()
  const runs: number[] = []
  const failures: string[] = []

  const budget = createRestartBudget({
    name: 'cloudflared',
    backoff: { ...BACKOFF, ...overrides },
    scheduler,
    random,
    log: logger('guarded-bot'),
    hooks: {
      onFailed: (failure): void => {
        failures.push(failure.kind)
      },
    },
    isCancelled: (): boolean => false,
    runAttempt: (): void => {
      runs.push(runs.length + 1)
    },
  })

  return { budget, scheduler, runs, failures, logger }
}

describe('SUP-002: progressao de backoff e saturacao no teto', () => {
  it('500 -> 1000 -> 2000 -> 4000 -> 8000 e satura em 10000', () => {
    const { budget, scheduler } = makeBudget()

    for (let i = 0; i < 7; i += 1) budget.conclude('caiu.', undefined, 0)

    assert.deepEqual(scheduler.delays(), [500, 1000, 2000, 4000, 8000, 10_000, 10_000])
  })
})

describe('SUP-003: jitter nos dois extremos fica em [base, min(base*1.5, max)]', () => {
  it('com random() = 0 a sequencia degenera na progressao nominal', () => {
    const { scheduler } = makeBudget()
    void scheduler
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      assert.equal(
        computeBackoffDelay(attempt, BACKOFF, () => 0),
        Math.min(500 * 2 ** (attempt - 1), 10_000),
      )
    }
  })

  it('com random() = 0,999 o atraso nunca sai da janela, e o piso NUNCA cai abaixo da base', () => {
    for (const random of [0, 0.5, 0.999]) {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const base = Math.min(500 * 2 ** (attempt - 1), 10_000)
        const delay = computeBackoffDelay(attempt, BACKOFF, () => random)
        // O jitter e SOMADO por cima da base, nunca subtraido dela: um piso
        // abaixo do minimo documentado e um crash-loop mais agressivo do que o
        // configurado, exatamente quando o processo esta a falhar de imediato.
        assert.ok(delay >= base, `attempt=${String(attempt)} random=${String(random)}: ${String(delay)} < ${String(base)}`)
        assert.ok(delay <= Math.min(base * 1.5, 10_000))
      }
    }
  })
})

describe('SUP-004: o contador zera SO apos uptime saudavel, nunca "a cada sucesso"', () => {
  it('uptime abaixo de resetAfterMs NAO zera: o atraso continua a crescer', () => {
    const { budget, scheduler } = makeBudget()

    // Um processo que morre fiavelmente aos 5 minutos com `resetAfterMs` de 60 s
    // zeraria o contador para sempre se a regra fosse "a cada sucesso".
    budget.conclude('caiu.', undefined, 59_999)
    budget.conclude('caiu.', undefined, 59_999)
    budget.conclude('caiu.', undefined, 59_999)

    assert.deepEqual(scheduler.delays(), [500, 1000, 2000])
    assert.equal(budget.attempts, 3)
  })

  it('uptime >= resetAfterMs zera, e a queda seguinte volta ao atraso inicial', () => {
    const { budget, scheduler } = makeBudget()

    budget.conclude('caiu.', undefined, 0)
    budget.conclude('caiu.', undefined, 0)
    assert.deepEqual(scheduler.delays(), [500, 1000])

    budget.conclude('caiu depois de horas.', undefined, 60_000)
    assert.deepEqual(scheduler.delays(), [500, 1000, 500])
    assert.equal(budget.attempts, 1)
  })
})

describe('SUP-005: orcamento esgotado e ESTADO TERMINAL observavel', () => {
  it('nao agenda mais nada, expoe `exhausted` e a causa, e chama onFailed uma vez', () => {
    const { budget, scheduler, failures, logger } = makeBudget({ maxAttempts: 3 })

    for (let i = 0; i < 4; i += 1) budget.conclude('caiu.', undefined, 0)

    assert.equal(scheduler.scheduled.length, 3, 'a 4a conclusao ultrapassa o orcamento')
    assert.equal(budget.exhausted, true)
    assert.equal(budget.failure?.kind, 'BUDGET_EXHAUSTED')
    assert.deepEqual(failures, ['BUDGET_EXHAUSTED'])
    // A divergencia documentada: estado terminal em vez do auto-desregisto que a
    // API do Cordis nao oferece. Apagar esta linha do log e uma regressao.
    assert.equal(logger.has('error', 'nao expoe auto-desregisto'), true)
    assert.equal(logger.has('error', 'estado terminal'), true)
  })

  it('a mensagem do orcamento esgotado e accionavel e sem caminho absoluto', () => {
    const { budget } = makeBudget({ maxAttempts: 1 })
    budget.conclude('caiu.', undefined, 0)
    budget.conclude('caiu.', undefined, 0)

    const message = budget.failure?.message ?? ''
    assert.equal(message.includes('cloudflared'), true)
    assert.equal(/(^|\s)\/[\w./-]+/u.test(message), false, 'a mensagem vai para o Telegram')
  })
})

describe('nao-retryable curto-circuita o orcamento', () => {
  it('ENOENT nao consome tentativa nenhuma nem agenda', () => {
    const { budget, scheduler, failures } = makeBudget()

    budget.conclude('caiu.', Object.assign(new Error('x'), { code: 'ENOENT' }), 0)

    assert.deepEqual(scheduler.scheduled, [])
    assert.equal(budget.attempts, 0)
    assert.deepEqual(failures, ['BINARY_NOT_FOUND'])
  })
})

describe('o reinicio POR INTENCAO partilha o MESMO contador', () => {
  it('conclusoes espontaneas e por intencao somam no mesmo orcamento', () => {
    const { budget, scheduler } = makeBudget({ maxAttempts: 2 })

    budget.conclude('caiu sozinho.', undefined, 0)
    budget.conclude('warmup falhou; reinicio por intencao.', undefined, 0)
    budget.conclude('caiu sozinho outra vez.', undefined, 0)

    // Se o reinicio por intencao tivesse contagem propria, este cenario nunca
    // esgotaria: um ciclo de `/ligar` correria para sempre sem consumir nada.
    assert.equal(budget.exhausted, true)
    assert.equal(scheduler.scheduled.length, 2)
  })
})

describe('GENERALIZOU, NAO DUPLICOU: um unico bloco de backoff em `src/**`', () => {
  it('so `src/proc/retry.ts` chama `computeBackoffDelay`', () => {
    const srcDir = fileURLToPath(new URL('../../../src/', import.meta.url))
    const callers: string[] = []

    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full, `${prefix}${entry.name}/`)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        const text = readFileSync(full, 'utf8')
        // A DEFINICAO vive em `backoff.ts`; o que se conta sao as CHAMADAS.
        if (`${prefix}${entry.name}` === 'proc/backoff.ts') continue
        if (/computeBackoffDelay\s*\(/u.test(text)) callers.push(`${prefix}${entry.name}`)
      }
    }
    walk(srcDir, '')

    // "Se ha dois blocos de backoff no repositorio, a generalizacao e ficticia."
    // Este assert e a forma executavel dessa pergunta: um supervisor de tunel que
    // copiasse a logica em vez de a instanciar aparece aqui, e o teste fica vermelho.
    assert.deepEqual(callers, ['proc/retry.ts'])
  })
})
