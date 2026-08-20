/**
 * `src/proc/supervisor.ts` (2/2) -- TERMINACAO: tree-kill do grupo, disposer
 * sincrono, substituicao de recursos, estado terminal e ambiente do spawn.
 *
 * O arranque e a progressao de reinicio estao em `supervisor.test.ts`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createWorkerSupervisor, type WorkerSupervisor } from '../../../src/proc/supervisor.ts'
import { FakeContext } from '../../support/ctx-double.ts'
import { FakeScheduler, makeSupervisorDeps } from '../../support/child-double.ts'
import { flush, makeConfig } from '../../support/fixtures.ts'

const SAIDA_COM_ERRO = { exitCode: 1, signal: null } as const

describe('tree-kill do grupo de processos (achado A-CRITICAL)', () => {
  it('o abort do spec aciona terminate() no handle -- e o assento que escala', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 4242

    const { deps } = makeSupervisorDeps(new FakeScheduler())
    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const child = ctx.subprocess.lastChild()
    const spec = ctx.subprocess.calls[0]
    assert.equal(child.terminateCalls, 0, 'antes do abort nada foi terminado')

    supervisor.dispose()

    // ESTE e o estado real de producao que o duble anterior escondia. Ele
    // modelava um `ChildProcess` com `killed = false` fixo; o assento publicado
    // nao tem `killed` nem `kill()` -- tem `terminate()`, accionado tambem pelo
    // `AbortSignal` do spec.
    assert.equal(spec?.signal?.aborted, true, 'o AbortController tem de ter disparado')
    assert.equal(child.terminateCalls >= 1, true)
  })

  it('faz tree-kill do GRUPO mesmo depois de terminate() ja ter corrido', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 4242

    const { deps, kills } = makeSupervisorDeps(new FakeScheduler())
    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()
    supervisor.dispose()

    // ANTI-REGRESSAO DIRETA. Se alguem reintroduzir uma guarda do tipo
    // `if (jaTerminado) return` antes do tree-kill -- que era o que a guarda
    // `!child.killed` do exemplo canonico fazia -- este assert falha, e e
    // exatamente como os netos do worker sobreviviam reparentados ao init.
    assert.deepEqual(kills, [[-4242, 'SIGKILL']], 'o kill do GRUPO (-pid) tem de acontecer')
  })

  it('o disposer continua idempotente: 3 chamadas, 1 kill', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 909

    const { deps, kills } = makeSupervisorDeps(new FakeScheduler())
    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    assert.doesNotThrow(() => {
      supervisor.dispose()
      supervisor.dispose()
      supervisor.dispose()
    })

    assert.deepEqual(kills, [[-909, 'SIGKILL']])
  })
})

describe('falha de spawn (achado A-HIGH)', () => {
  it('reinicia quando `done` REJEITA por causa TRANSITORIA (a falha de spawn nao produz saida normal)', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    // "`done` resolves at process close with exit facts and rejects only for
    // spawn-level failures": numa falha de spawn nao ha saida normal nenhuma
    // para observar. `EAGAIN` (sem recursos para bifurcar agora) e o exemplo
    // canonico de causa que PODE melhorar na tentativa seguinte -- ao contrario
    // de `ENOENT`, que e coberto pelo caso SUP-007 abaixo.
    ctx.subprocess
      .lastChild()
      .fail(Object.assign(new Error('spawn python3 EAGAIN'), { code: 'EAGAIN' }))
    await flush()

    assert.equal(scheduler.pending.length, 1, 'a falha de spawn TEM de agendar reinicio')
    assert.deepEqual(scheduler.delays(), [500])
    assert.equal(supervisor.attempts, 1, 'e TEM de consumir orcamento')
    assert.equal(ctx.logger.has('error', 'EAGAIN'), true)

    scheduler.runLast()
    assert.equal(ctx.subprocess.calls.length, 2, 'o worker volta a ser instanciado')

    supervisor.dispose()
  })

  it('SUP-007: ENOENT e NAO-RETRYABLE -- estado terminal, sem consumir orcamento e sem reagendar', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    ctx.subprocess
      .lastChild()
      .fail(Object.assign(new Error('spawn /nao/existe ENOENT'), { code: 'ENOENT' }))
    await flush()

    // O binario ausente nao aparece na decima tentativa. Consumir orcamento com
    // ele so atrasa em minutos a mensagem que ja estava na PRIMEIRA falha.
    assert.deepEqual(scheduler.scheduled, [], 'nao pode agendar reinicio nenhum')
    assert.equal(supervisor.attempts, 0, 'nao pode consumir orcamento')
    assert.equal(supervisor.exhausted, true, 'estado terminal tem de ser observavel')
    assert.equal(supervisor.failure?.kind, 'BINARY_NOT_FOUND')
    assert.equal(supervisor.failure?.retryable, false)
    assert.equal(ctx.logger.has('error', 'NAO-RETRYABLE'), true)
    assert.equal(ctx.subprocess.calls.length, 1, 'nenhum spawn novo')

    supervisor.dispose()
  })

  it('SUP-008: EACCES e NAO-RETRYABLE, com a mesma disciplina do ENOENT', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    ctx.subprocess
      .lastChild()
      .fail(Object.assign(new Error('spawn /tmp/sem-x EACCES'), { code: 'EACCES' }))
    await flush()

    assert.deepEqual(scheduler.scheduled, [])
    assert.equal(supervisor.attempts, 0)
    assert.equal(supervisor.failure?.kind, 'BINARY_NOT_EXECUTABLE')

    supervisor.dispose()
  })

  it('uma instancia consome o orcamento UMA vez', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    // No `child_process` cru, `'error'` e `'exit'` podiam chegar ambos e uma
    // instancia consumia o orcamento duas vezes. `done` e uma unica promessa: a
    // segunda notificacao ja nao e sequer expressavel -- observa-se aqui.
    const child = ctx.subprocess.lastChild()
    child.fail(new Error('falhou'))
    child.settle(SAIDA_COM_ERRO)
    await flush()

    assert.equal(scheduler.scheduled.length, 1)
    assert.equal(supervisor.attempts, 1)

    supervisor.dispose()
  })

  it('a morte de um handle JA SUBSTITUIDO nao consome orcamento nem agenda', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    // Primeira queda: agenda o reinicio.
    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
    await flush()
    const tarefa = scheduler.scheduled[0]
    assert.notEqual(tarefa, undefined)

    // DOIS `spawnOnce` seguidos SEM o segundo filho ter terminado. E o formato do
    // gatilho de reinicio INDEPENDENTE da terminacao que a Onda 5 acrescenta
    // (reinicio por intencao do plano de controlo): o filho #2 e largado por
    // `releaseCurrentHandle()` com o `done` ainda por assentar, e so morre
    // DEPOIS de o #3 ja ser o corrente.
    scheduler.runLast()
    tarefa?.callback()

    assert.equal(ctx.subprocess.children.length, 3)
    const substituido = ctx.subprocess.children[1]
    const corrente = ctx.subprocess.children[2]
    assert.notEqual(substituido, corrente)

    const tentativasAntes = supervisor.attempts
    const agendadasAntes = scheduler.scheduled.length

    // O handle ja substituido morre agora. Sem a guarda `handle !== spawned`,
    // esta morte gastava uma tentativa do orcamento e agendava um SEGUNDO
    // reinicio -- com o filho #3 ainda vivo, ficariam dois workers.
    substituido?.settle(SAIDA_COM_ERRO)
    await flush()

    assert.equal(supervisor.attempts, tentativasAntes, 'nao pode consumir orcamento')
    assert.equal(scheduler.scheduled.length, agendadasAntes, 'nao pode agendar reinicio')
    assert.equal(scheduler.pending.length, 0)

    // E o filho corrente continua a ser o dono do ciclo: a sua morte agenda.
    corrente?.settle(SAIDA_COM_ERRO)
    await flush()
    assert.equal(supervisor.attempts, tentativasAntes + 1)
    assert.equal(scheduler.pending.length, 1)

    supervisor.dispose()
  })
})

describe('substituicao de recursos (achado A-MEDIUM)', () => {
  it('o filho anterior e morto quando um novo o substitui', async () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 222

    const scheduler = new FakeScheduler()
    const { deps, kills } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
    await flush()
    scheduler.runLast() // spawnOnce() -> substitui o filho

    assert.equal(ctx.subprocess.children.length, 2)
    assert.deepEqual(kills, [[-222, 'SIGKILL']], 'o 1o filho nao pode ficar sem kill')

    supervisor.dispose()
    assert.deepEqual(
      kills,
      [
        [-222, 'SIGKILL'],
        [-222, 'SIGKILL'],
      ],
      'o 2o filho e morto pelo disposer',
    )
  })

  it('start() repetido nao instancia um segundo worker', () => {
    const ctx = new FakeContext()
    const { deps } = makeSupervisorDeps(new FakeScheduler())

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()
    supervisor.start()
    supervisor.start()

    assert.equal(ctx.subprocess.calls.length, 1)
    assert.equal(ctx.logger.has('warn', 'start() repetido ignorado'), true)

    supervisor.dispose()
  })

  it('nao deixa dois temporizadores vivos e o disposer nao deixa nenhum', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
    await flush()
    scheduler.runLast()
    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
    await flush()

    assert.equal(scheduler.pending.length, 1, 'so um reinicio pendente de cada vez')

    supervisor.dispose()
    assert.equal(scheduler.pending.length, 0, 'o disposer nao deixa temporizadores vivos')
  })

  it('remove os ouvintes de stream quando o worker termina, e deixa o absorvedor', async () => {
    const ctx = new FakeContext()
    const { deps } = makeSupervisorDeps(new FakeScheduler())

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const child = ctx.subprocess.lastChild()
    assert.equal(child.stdout.listenerCount('data'), 1)
    assert.equal(child.stderr.listenerCount('data'), 1)

    child.settle(SAIDA_COM_ERRO)
    await flush()

    assert.equal(child.stdout.listenerCount('data'), 0, 'ouvinte de stdout tem de ser removido')
    assert.equal(child.stderr.listenerCount('data'), 0, 'ouvinte de stderr idem')
    assert.equal(
      child.stdout.listenerCount('error'),
      1,
      "tem de sobrar o absorvedor de 'error' (um EventEmitter sem ele LANCA)",
    )

    supervisor.dispose()
  })
})

describe('estado terminal do orcamento (achado A-MEDIUM)', () => {
  it('expoe `exhausted` e recusa qualquer novo arranque', async () => {
    const ctx = new FakeContext()
    const config = makeConfig()
    config.worker.backoff.maxAttempts = 2

    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), config, deps)
    supervisor.start()

    assert.equal(supervisor.exhausted, false)

    for (let i = 0; i < 2; i += 1) {
      ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
      await flush()
      scheduler.runLast()
    }
    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO) // 3a falha: ultrapassa o orcamento
    await flush()

    assert.equal(supervisor.exhausted, true, 'estado terminal tem de ser observavel')
    assert.equal(ctx.logger.has('error', 'estado terminal'), true)
    assert.equal(ctx.logger.has('error', 'nao expoe auto-desregisto'), true)
    assert.equal(scheduler.pending.length, 0, 'nada mais e agendado')

    supervisor.dispose()
  })
})

describe('disposer reentrante (achado A-LOW)', () => {
  it('nao agenda reinicio quando o dispose() acontece DURANTE o tratador de saida', async () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const holder: { supervisor: WorkerSupervisor | undefined } = { supervisor: undefined }

    // O `warn` imediatamente anterior ao agendamento e o ponto de reentrancia:
    // simula um ouvinte de log (ou outra Fiber) que descarta o plugin nesse
    // instante. Sem a re-verificacao de `disposed` antes do setTimeout, o
    // temporizador nascia DEPOIS do clearTimeout do disposer.
    ctx.logger.override('warn', (_scope: string, message: string): void => {
      if (message.includes('Reinicio')) holder.supervisor?.dispose()
    })

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    holder.supervisor = supervisor
    supervisor.start()

    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
    await flush()

    assert.deepEqual(scheduler.scheduled, [], 'nenhum temporizador pode sobreviver ao disposer')
  })
})

describe('ambiente do spawn real (achado B-HIGH)', () => {
  it('o spawn do supervisor tambem nao leva ADMIN_PASS', () => {
    const anterior = process.env['ADMIN_PASS']
    process.env['ADMIN_PASS'] = 's3cr3t-do-plano-de-controlo'

    try {
      const ctx = new FakeContext()
      const { deps } = makeSupervisorDeps(new FakeScheduler())

      const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
      supervisor.start()

      const env = ctx.subprocess.calls[0]?.env
      assert.notEqual(env, undefined)
      assert.equal(env?.['ADMIN_PASS'], undefined)
      assert.equal(env?.['TELEGRAM_BOT_TOKEN'], 'token-de-teste')

      supervisor.dispose()
    } finally {
      if (anterior === undefined) delete process.env['ADMIN_PASS']
      else process.env['ADMIN_PASS'] = anterior
    }
  })

  it('o token viaja SO por ambiente, nunca em argv (/proc/<pid>/cmdline e publico)', () => {
    const ctx = new FakeContext()
    const { deps } = makeSupervisorDeps(new FakeScheduler())

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const spec = ctx.subprocess.calls[0]
    assert.equal(
      (spec?.argv ?? []).some((argument) => argument.includes('token-de-teste')),
      false,
      'Q-4: segredo nunca em argv',
    )
    assert.equal(spec?.env?.['TELEGRAM_BOT_TOKEN'], 'token-de-teste')

    supervisor.dispose()
  })
})
