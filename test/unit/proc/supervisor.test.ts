/**
 * `src/proc/supervisor.ts` (1/2) -- ARRANQUE E REINICIO: forma do spec entregue
 * ao assento real (`spawn(spec) -> SubprocessHandle`), progressao de backoff e
 * orcamento de reinicios.
 *
 * A terminacao, o tree-kill, a substituicao de recursos e o ambiente estao em
 * `supervisor-disposer.test.ts` -- o mesmo fonte, dividido porque nenhum
 * ficheiro de codigo passa das 400 linhas.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PACKAGED_WORKER_ENTRYPOINT } from '../../../src/config/schema.ts'
import { createWorkerSupervisor, type WorkerSupervisor } from '../../../src/proc/supervisor.ts'
import { FakeContext } from '../_duble-ctx.ts'
import { FakeScheduler, makeSupervisorDeps } from '../_duble-filho.ts'
import { flush, makeConfig, WORKER_CWD } from '../_fixturas.ts'

const SAIDA_COM_ERRO = { exitCode: 1, signal: null } as const

describe('supervisor do worker de long-polling', () => {
  it('faz spawn pela costura ctx.subprocess com argv, cwd, stdio, graceMs e signal', () => {
    const ctx = new FakeContext()
    const config = makeConfig()
    const { deps } = makeSupervisorDeps(new FakeScheduler())

    const supervisor = createWorkerSupervisor(ctx.asContext(), config, deps)
    supervisor.start()

    const spec = ctx.subprocess.calls[0]
    assert.notEqual(spec, undefined)
    // `spawn(cmd, args, opts)` nao existe: o assento recebe UM spec, e `argv[0]`
    // e o programa. O ENTRYPOINT e anteposto pelo supervisor, nunca vem do
    // manifesto -- com `args: []`, `[command, ...args]` dava `argv` de UM
    // elemento, ou seja um REPL do Node em vez do worker.
    assert.deepEqual(spec?.argv, [process.execPath, PACKAGED_WORKER_ENTRYPOINT])
    assert.equal(spec?.cwd, WORKER_CWD)
    assert.deepEqual(spec?.stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    assert.equal(spec?.graceMs, 3000, 'graceMs e obrigatorio: o assento nao aplica defaults')
    assert.equal(spec?.signal instanceof AbortSignal, true)
    assert.equal(spec?.env?.['TELEGRAM_BOT_TOKEN'], 'token-de-teste')

    supervisor.dispose()
  })

  it('encaminha stdout/stderr do worker para o logger', () => {
    const ctx = new FakeContext()
    const { deps } = makeSupervisorDeps(new FakeScheduler())

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const child = ctx.subprocess.lastChild()
    child.stdout.emit('data', Buffer.from('a sondar updates\n'))
    child.stderr.emit('data', Buffer.from('timeout na rede\n'))

    assert.equal(ctx.logger.has('debug', 'a sondar updates'), true)
    assert.equal(ctx.logger.has('warn', 'timeout na rede'), true)

    supervisor.dispose()
  })

  it('reinicia com a progressao 500 -> 10000 e satura no teto', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    for (let i = 0; i < 7; i += 1) {
      ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
      await flush()
      scheduler.runLast()
    }

    assert.deepEqual(scheduler.delays(), [500, 1000, 2000, 4000, 8000, 10000, 10000])
    assert.equal(ctx.subprocess.calls.length, 8, '1 arranque + 7 reinicios')

    supervisor.dispose()
  })

  it('nao reinicia quando a saida e intencional (signal.aborted)', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const child = ctx.subprocess.lastChild()
    supervisor.dispose()
    child.settle({ exitCode: null, signal: 'SIGKILL' })
    await flush()

    assert.deepEqual(scheduler.scheduled, [], 'desligamento intencional nao agenda reinicio')
    assert.equal(ctx.subprocess.calls.length, 1)
  })

  it('cessa a recuperacao quando o orcamento maxAttempts se esgota', async () => {
    const ctx = new FakeContext()
    const config = makeConfig()
    config.worker.backoff.maxAttempts = 3

    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), config, deps)
    supervisor.start()

    for (let i = 0; i < 3; i += 1) {
      ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
      await flush()
      scheduler.runLast()
    }

    // A 4a falha ultrapassa o orcamento: nada mais e agendado.
    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
    await flush()

    assert.equal(scheduler.scheduled.length, 3)
    assert.equal(supervisor.attempts, 4)
    assert.equal(ctx.logger.has('error', 'Orcamento de reinicios esgotado'), true)

    supervisor.dispose()
  })

  it('uptime saudavel (resetAfterMs) devolve o atraso ao valor inicial', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps, clock } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    for (let i = 0; i < 2; i += 1) {
      ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
      await flush()
      scheduler.runLast()
    }
    assert.deepEqual(scheduler.delays(), [500, 1000])

    // O worker seguinte vive mais do que resetAfterMs antes de cair.
    clock.value += 60000
    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
    await flush()

    assert.deepEqual(scheduler.delays(), [500, 1000, 500])

    supervisor.dispose()
  })

  it('o disposer e SINCRONO, cancela o temporizador e faz tree-kill do grupo', async () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 4242

    const scheduler = new FakeScheduler()
    const { deps, kills } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
    await flush()
    assert.equal(scheduler.pending.length, 1, 'ha um reinicio agendado por cancelar')

    const result: unknown = supervisor.dispose()

    // SINCRONO: devolve `undefined`, jamais um thenable. Se devolvesse uma
    // Promise, a Fiber do Cordis perderia a garantia LIFO. (O host TOLERA
    // disposers assincronos; este projeto nao usa essa tolerancia -- Q-2.)
    assert.equal(result, undefined)
    assert.equal(typeof (result as { then?: unknown } | undefined)?.then, 'undefined')

    // clearTimeout aconteceu: nao fica temporizador pendurado a ressuscitar o
    // worker depois da Fiber ja estar DISPOSED.
    assert.deepEqual(scheduler.clearedIds, [1])
    assert.equal(scheduler.pending.length, 0)

    // Tree-kill: sinal negativo (grupo de processos inteiro) + SIGKILL.
    assert.deepEqual(kills, [[-4242, 'SIGKILL']])
  })

  it('e reentrante: dispose() repetido nao volta a matar', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 77

    const { deps, kills } = makeSupervisorDeps(new FakeScheduler())

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()
    supervisor.dispose()
    supervisor.dispose()

    assert.deepEqual(kills, [[-77, 'SIGKILL']])
  })
})

describe('argv do spawn (entrypoint resolvido, nunca do manifesto)', () => {
  it('e sempre [command, entrypoint, ...args] -- o entrypoint NUNCA falta', () => {
    const ctx = new FakeContext()
    const { deps } = makeSupervisorDeps(new FakeScheduler())

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const argv = ctx.subprocess.calls[0]?.argv ?? []
    // Com o manifesto real (`args: []`), `[command, ...args]` dava argv de UM
    // elemento: o Node sem script nenhum, e nao o worker.
    assert.equal(argv.length >= 2, true, 'sem entrypoint nao ha worker nenhum a correr')
    assert.equal(argv[0], process.execPath, 'argv[0] e o executavel do manifesto')
    assert.equal(argv[1], PACKAGED_WORKER_ENTRYPOINT, 'argv[1] e o entrypoint resolvido')

    supervisor.dispose()
  })

  it('os `args` do manifesto sao argumentos EXTRA, DEPOIS do entrypoint', () => {
    const ctx = new FakeContext()
    const config = makeConfig()
    config.worker.args = ['--verbose', '--offset=0']

    const { deps } = makeSupervisorDeps(new FakeScheduler())
    const supervisor = createWorkerSupervisor(ctx.asContext(), config, deps)
    supervisor.start()

    assert.deepEqual(ctx.subprocess.calls[0]?.argv, [
      process.execPath,
      PACKAGED_WORKER_ENTRYPOINT,
      '--verbose',
      '--offset=0',
    ])

    supervisor.dispose()
  })

  it('o entrypoint e absoluto e NAO deriva do cwd do worker nem do host', () => {
    const ctx = new FakeContext()
    const { deps } = makeSupervisorDeps(new FakeScheduler())

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const entrada = ctx.subprocess.calls[0]?.argv[1] ?? ''
    assert.equal(entrada.startsWith('/'), true, 'tem de ser absoluto')
    assert.equal(entrada.startsWith(WORKER_CWD), false, 'nao pode ser derivado do worker.cwd')

    supervisor.dispose()
  })

  it('o argv EFETIVO e o que vai para o log (era a diferenca que escondia o defeito)', () => {
    const ctx = new FakeContext()
    const { deps } = makeSupervisorDeps(new FakeScheduler())

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    assert.equal(ctx.logger.has('info', PACKAGED_WORKER_ENTRYPOINT), true)

    supervisor.dispose()
  })
})
