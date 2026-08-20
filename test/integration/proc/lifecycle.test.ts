/**
 * SUP-001 a SUP-006, SUP-009 e SUP-014 — ciclo de vida do supervisor GENERICO
 * contra processos REAIS (`04-TESTES.md` 5.4.3).
 *
 * PORQUE OS CENARIOS SAO CONSTRUIDOS AQUI, e nao pedidos ao dublê: o
 * `test/bin/fake-cloudflared.mjs` congelado no COMMIT PREP 2 NAO tem os modos
 * `--fake=crash|instant-exit|stubborn|tree` que `04-TESTES.md` 5.4.1 descreve —
 * a divergencia doc-codigo esta registada para o COMMIT PREP 4 e nao e desta
 * sub-tarefa corrigir material prep-owned no meio da onda. Cada cenario que falta
 * e um `node` de uma linha escrito por este ficheiro, dentro do diretorio que ele
 * proprio limpa.
 *
 * NENHUM processo aqui e o `cloudflared` verdadeiro (D10). O relogio e o
 * agendador sao injetados: nenhum caso espera tempo real de backoff.
 */

import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import type { BackoffConfig } from '../../../src/config/schema.ts'
import { createProcessSupervisor, type ProcessSupervisor } from '../../../src/proc/supervisor.ts'
import { FakeScheduler, makeSupervisorDeps } from '../../support/child-double.ts'
import {
  isAlive,
  makeBinDir,
  makeRealContext,
  waitFor,
  writeExecutableShim,
  type RealSubprocessService,
} from './seat.ts'

const BACKOFF: BackoffConfig = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 10,
  resetAfterMs: 60_000,
}

const bin = makeBinDir()
const supervisores: ProcessSupervisor[] = []
const servicos: RealSubprocessService[] = []

after(() => {
  for (const supervisor of supervisores) supervisor.dispose()
  for (const servico of servicos) servico.killAll()
  bin.cleanup()
})

/* Cenarios que o dublê congelado nao cobre, construidos aqui. */
const CRASH = writeExecutableShim(
  bin.path,
  'fake-crash',
  'setTimeout(() => process.exit(1), Number(process.env.FAKE_LIFETIME_MS ?? "20"))\n',
)
const INSTANT_EXIT = writeExecutableShim(bin.path, 'fake-instant-exit', 'process.exit(1)\n')
const STUBBORN = writeExecutableShim(
  bin.path,
  'fake-stubborn',
  // Ignora SIGTERM de proposito: e este processo que prova que o SIGKILL chega.
  "process.on('SIGTERM', () => {})\nprocess.stdout.write('PRONTO\\n')\nsetInterval(() => {}, 1000)\n",
)
const TREE = writeExecutableShim(
  bin.path,
  'fake-tree',
  [
    "import { spawn } from 'node:child_process'",
    "const neto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    "process.stdout.write(`PRONTO neto=${neto.pid}\\n`)",
    'setInterval(() => {}, 1000)',
  ].join('\n') + '\n',
)
const SEM_EXECUCAO = join(bin.path, 'sem-bit-de-execucao')
writeFileSync(SEM_EXECUCAO, '#!/bin/sh\necho oi\n')
chmodSync(SEM_EXECUCAO, 0o600)

interface Harness {
  supervisor: ProcessSupervisor
  subprocess: RealSubprocessService
  scheduler: FakeScheduler
  logger: ReturnType<typeof makeRealContext>['logger']
  clock: { value: number }
}

function makeHarness(
  command: string,
  options: { backoff?: Partial<BackoffConfig>; env?: NodeJS.ProcessEnv; random?: () => number } = {},
): Harness {
  const { ctx, subprocess, logger } = makeRealContext()
  const scheduler = new FakeScheduler()
  const overrides = options.random === undefined ? {} : { random: options.random }
  const { deps, clock } = makeSupervisorDeps(scheduler, overrides)
  servicos.push(subprocess)

  const supervisor = createProcessSupervisor(
    ctx,
    {
      name: 'processo-de-teste',
      backoff: { ...BACKOFF, ...options.backoff },
      buildSpec: (signal: AbortSignal) => ({
        argv: [command],
        cwd: bin.path,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 120,
        signal,
        ...(options.env === undefined ? {} : { env: options.env }),
      }),
    },
    deps,
  )
  supervisores.push(supervisor)

  return { supervisor, subprocess, scheduler, logger, clock }
}

describe('SUP-001 / SUP-002: queda real agenda reinicio com a progressao nominal', () => {
  it('SUP-001: um processo que sai com 1 agenda reinicio com computeBackoffDelay(1)', async () => {
    const h = makeHarness(CRASH)
    h.supervisor.start()

    await h.subprocess.lastChild().done.catch(() => undefined)
    await waitFor(() => h.scheduler.scheduled.length > 0)

    assert.deepEqual(h.scheduler.delays(), [500], 'piso = initialDelayMs')
    assert.equal(h.supervisor.attempts, 1)
  })

  it('SUP-002: 5 quedas reais dao 500 -> 1000 -> 2000 -> 4000 -> 8000', async () => {
    const h = makeHarness(CRASH)
    h.supervisor.start()

    for (let i = 0; i < 5; i += 1) {
      await h.subprocess.lastChild().done.catch(() => undefined)
      await waitFor(() => h.scheduler.scheduled.length === i + 1)
      if (i < 4) h.scheduler.runLast()
    }

    assert.deepEqual(h.scheduler.delays(), [500, 1000, 2000, 4000, 8000])
  })
})

describe('SUP-003: jitter nos dois extremos, com processos reais', () => {
  for (const random of [0, 0.999]) {
    it(`random() fixo em ${String(random)} mantem o atraso em [base, min(base*1.5, max)]`, async () => {
      const h = makeHarness(CRASH, { random: () => random })
      h.supervisor.start()

      for (let i = 0; i < 3; i += 1) {
        await h.subprocess.lastChild().done.catch(() => undefined)
        await waitFor(() => h.scheduler.scheduled.length === i + 1)
        if (i < 2) h.scheduler.runLast()
      }

      const bases = [500, 1000, 2000]
      h.scheduler.delays().forEach((delay, index) => {
        const base = bases[index] ?? 0
        assert.ok(delay >= base, `${String(delay)} < ${String(base)}`)
        assert.ok(delay <= Math.min(base * 1.5, 10_000))
      })
    })
  }
})

describe('SUP-004: uptime saudavel zera o contador', () => {
  it('depois de `resetAfterMs` vivo, a queda seguinte volta ao atraso inicial', async () => {
    const h = makeHarness(CRASH)
    h.supervisor.start()

    await h.subprocess.lastChild().done.catch(() => undefined)
    await waitFor(() => h.scheduler.scheduled.length === 1)
    h.scheduler.runLast()

    await h.subprocess.lastChild().done.catch(() => undefined)
    await waitFor(() => h.scheduler.scheduled.length === 2)
    assert.deepEqual(h.scheduler.delays(), [500, 1000])
    h.scheduler.runLast()

    // O relogio injetado faz o processo seguinte "viver" mais do que resetAfterMs.
    h.clock.value += 60_000
    await h.subprocess.lastChild().done.catch(() => undefined)
    await waitFor(() => h.scheduler.scheduled.length === 3)

    assert.deepEqual(h.scheduler.delays(), [500, 1000, 500])
    assert.equal(h.supervisor.attempts, 1)
  })
})

describe('SUP-005 / SUP-006: falha deterministica nao vira retry infinito', () => {
  it('SUP-006 + SUP-005: `instant-exit` esgota o orcamento e PARA, sem novo spawn', async () => {
    const h = makeHarness(INSTANT_EXIT, { backoff: { maxAttempts: 3 } })
    h.supervisor.start()

    for (let i = 0; i < 3; i += 1) {
      await h.subprocess.lastChild().done.catch(() => undefined)
      await waitFor(() => h.scheduler.scheduled.length === i + 1)
      h.scheduler.runLast()
    }
    await h.subprocess.lastChild().done.catch(() => undefined)
    await waitFor(() => h.supervisor.exhausted)

    const spawnsAntes = h.subprocess.calls.length
    assert.equal(h.supervisor.exhausted, true, 'estado TERMINAL')
    assert.equal(h.supervisor.failure?.kind, 'BUDGET_EXHAUSTED')
    assert.equal(h.scheduler.pending.length, 0, 'nada mais agendado')
    assert.equal(h.logger.has('error', 'Orcamento de reinicios esgotado'), true)

    // Nao ha caminho que instancie um quinto processo: o estado terminal e mesmo terminal.
    h.supervisor.start()
    assert.equal(h.subprocess.calls.length, spawnsAntes, 'sem novo spawn')
  })

  it('SUP-008: um ficheiro sem bit de execucao e NAO-RETRYABLE (EACCES)', async () => {
    const h = makeHarness(SEM_EXECUCAO)
    h.supervisor.start()

    await h.subprocess.lastChild().done.catch(() => undefined)
    await waitFor(() => h.supervisor.exhausted)

    assert.equal(h.supervisor.failure?.kind, 'BINARY_NOT_EXECUTABLE')
    assert.equal(h.supervisor.attempts, 0, 'nao consome orcamento')
    assert.deepEqual(h.scheduler.scheduled, [])
  })

  it('SUP-007: um binario que nao existe e NAO-RETRYABLE (ENOENT), tratado pelo `close`', async () => {
    const h = makeHarness(join(bin.path, 'este-binario-nao-existe'))
    h.supervisor.start()

    const child = h.subprocess.lastChild()
    await child.done.catch(() => undefined)
    await waitFor(() => h.supervisor.exhausted)

    // A EVIDENCIA: `'exit'` nunca disparou, e mesmo assim o supervisor concluiu.
    assert.deepEqual(child.events, ['error', 'close'])
    assert.equal(child.events.includes('exit'), false)
    assert.equal(h.supervisor.failure?.kind, 'BINARY_NOT_FOUND')
    assert.equal(h.supervisor.attempts, 0)
  })
})

describe('SUP-009: saida por `signal.aborted` NAO reinicia', () => {
  it('o disposer derruba o processo e nao agenda nada', async () => {
    const h = makeHarness(STUBBORN)
    h.supervisor.start()
    const child = h.subprocess.lastChild()
    await waitFor(() => child.pid > 0 && isAlive(child.pid))

    h.supervisor.dispose()
    await child.done.catch(() => undefined)

    assert.deepEqual(h.scheduler.scheduled, [], 'desligamento intencional nao agenda reinicio')
    assert.equal(h.subprocess.calls.length, 1)
  })
})

describe('SUP-014: SIGTERM ao GRUPO -> graceMs -> SIGKILL, com um processo teimoso', () => {
  it('com `stubborn` (que ignora SIGTERM) o SIGKILL TEM de chegar', async () => {
    const h = makeHarness(STUBBORN)
    h.supervisor.start()
    const child = h.subprocess.lastChild()
    await waitFor(() => child.pid > 0 && isAlive(child.pid))
    const pid = child.pid

    // O processo IGNORA SIGTERM: sem a escalada, ficava vivo para sempre.
    h.supervisor.dispose()
    const morreu = await waitFor(() => !isAlive(pid), { timeoutMs: 4000 })

    assert.equal(morreu, true, 'o SIGKILL do tree-kill tem de chegar ao grupo')
  })

  it('o tree-kill do GRUPO leva o NETO junto', async () => {
    const h = makeHarness(TREE)
    h.supervisor.start()
    const child = h.subprocess.lastChild()

    let netoPid = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      const match = /neto=(\d+)/u.exec(chunk.toString())
      if (match?.[1] !== undefined) netoPid = Number(match[1])
    })
    await waitFor(() => netoPid > 0)
    assert.equal(isAlive(netoPid), true, 'o neto tem de estar vivo antes do dispose')

    h.supervisor.dispose()

    // `process.kill(-pid)` so designa um grupo porque o filho e `detached`, ou
    // seja LIDER DO SEU PROPRIO GRUPO. Sem isso o neto sobrevivia reparentado.
    const netoMorreu = await waitFor(() => !isAlive(netoPid), { timeoutMs: 4000 })
    assert.equal(netoMorreu, true, 'o neto tem de morrer com o grupo')
  })
})

describe('SUP-015: `graceMs` vai EXPLICITO no spec (o assento nao aplica defaults)', () => {
  it('o spec entregue ao assento traz graceMs e o AbortSignal', () => {
    const h = makeHarness(INSTANT_EXIT)
    h.supervisor.start()

    assert.equal(h.subprocess.calls[0]?.graceMs, 120)
    assert.equal(h.subprocess.calls[0]?.signal instanceof AbortSignal, true)
  })
})
