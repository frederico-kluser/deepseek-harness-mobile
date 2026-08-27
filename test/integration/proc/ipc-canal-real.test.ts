/**
 * O CANAL sobre PIPES REAIS -- `src/ipc/channel.ts` + `worker/ipc.ts` + o
 * supervisor generico, com um processo `node` do outro lado.
 *
 * PORQUE ISTO NAO E REDUNDANTE COM OS TESTES UNITARIOS: os unitarios usam
 * `PassThrough`, que entrega cada `write` como um `data` inteiro. Um PIPE do
 * sistema operativo nao promete isso -- ele parte e junta onde quiser, e e
 * exatamente essa liberdade que o acumulador existe para absorver. Uma
 * implementacao que so funcionasse com fronteiras alinhadas passava a suite
 * unitaria inteira e falhava em producao de forma intermitente.
 *
 * NENHUM TESTE AQUI CHAMA `api.telegram.org`: o "worker" e um `node` de vinte
 * linhas que vive em `./fixtures/worker-eco.ts`.
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import type { BackoffConfig } from '../../../src/config/schema.ts'
import type { IpcIntentMessage, IpcMessageToWorker } from '../../../src/contracts/ipc.ts'
import type { SubprocessHandle } from '../../../src/dsh/adapter.ts'
import { createProcessSupervisor, type ProcessSupervisor } from '../../../src/proc/supervisor.ts'
import { createHostIpcChannel, type HostIpcChannel } from '../../../src/ipc/channel.ts'
import { createGuardLogger } from '../../../src/logging/logger.ts'
import { FakeScheduler, makeSupervisorDeps } from '../../support/child-double.ts'
import { isAlive, makeRealContext, waitFor, type RealSubprocessService } from './seat.ts'

const ECO = fileURLToPath(new URL('./fixtures/worker-eco.ts', import.meta.url))
const RAIZ = fileURLToPath(new URL('../../..', import.meta.url))

const BACKOFF: BackoffConfig = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 10,
  resetAfterMs: 60_000,
}

const supervisores: ProcessSupervisor[] = []
const servicos: RealSubprocessService[] = []

after(() => {
  for (const supervisor of supervisores) supervisor.dispose()
  for (const servico of servicos) servico.killAll()
})

interface Bancada {
  supervisor: ProcessSupervisor
  subprocess: RealSubprocessService
  logger: ReturnType<typeof makeRealContext>['logger']
  intencoes: IpcIntentMessage[]
  canal(): HostIpcChannel
}

/**
 * Monta o supervisor GENERICO com o gancho `attachChannel` -- a mesma costura
 * que `src/proc/worker.ts` usa. Nao se usa `createWorkerSupervisor` porque o
 * `argv` dele aponta para `worker/telegram-bot.ts`, que e de T4.2 e ainda esta
 * vazio nesta onda; o que se quer exercitar e o CANAL, nao o entrypoint.
 */
function montar(): Bancada {
  const { ctx, subprocess, logger } = makeRealContext()
  servicos.push(subprocess)
  const { deps } = makeSupervisorDeps(new FakeScheduler())
  const log = createGuardLogger(ctx)
  const intencoes: IpcIntentMessage[] = []
  let corrente: HostIpcChannel | undefined

  const supervisor = createProcessSupervisor(
    ctx,
    {
      name: 'worker-de-eco',
      backoff: BACKOFF,
      buildSpec: (signal: AbortSignal) => ({
        argv: [process.execPath, ECO],
        cwd: RAIZ,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 200,
        signal,
      }),
      attachChannel: (handle: SubprocessHandle): (() => void) => {
        const canal = createHostIpcChannel({
          input: handle.stdout,
          output: handle.stdin,
          log,
          secrets: (): readonly string[] => [],
          onIntent: (intent): IpcMessageToWorker => {
            intencoes.push(intent)
            return { v: 2, type: 'ack', requestId: intent.requestId, result: 'noop', state: 'STOPPED' }
          },
        })
        corrente = canal
        return (): void => {
          canal.dispose()
          if (corrente === canal) corrente = undefined
        }
      },
    },
    deps,
  )
  supervisores.push(supervisor)

  return {
    supervisor,
    subprocess,
    logger,
    intencoes,
    canal: (): HostIpcChannel => {
      if (corrente === undefined) throw new Error('o canal ainda nao foi ligado')
      return corrente
    },
  }
}

const DIFUSAO = (seq: number): IpcMessageToWorker => ({
  v: 2,
  type: 'state',
  state: 'STOPPED',
  seq,
})

describe('a viagem de ida e volta sobre pipes do sistema operativo', () => {
  it('uma difusao do host volta como intencao do worker', async () => {
    const h = montar()
    h.supervisor.start()

    assert.equal(h.canal().send(DIFUSAO(1)), true)
    assert.equal(await waitFor(() => h.intencoes.length >= 1, { timeoutMs: 10_000 }), true)

    const intencao = h.intencoes[0]
    assert.equal(h.intencoes.length, 1, 'uma difusao produz UMA intencao, nao um ciclo')
    assert.ok(intencao !== undefined, 'a intencao do eco chegou')
    assert.equal(intencao.intent, 'tunnel.status')
    assert.equal(intencao.requestId, 'eco-1')
    // V2 (EMENDA ONDA-1-IPC-ENVELOPE-STRING): os eixos viajam como STRING.
    assert.equal(intencao.from, '111')
    assert.equal(intencao.chat, '222')
    // S5: o nonce atravessou OPACO, sem ninguem no worker o ter interpretado.
    assert.equal(intencao.nonce, 'nonce-opaco-que-o-worker-nao-le')

    h.supervisor.dispose()
  })

  it('uma RAJADA de 200 difusoes chega toda, pela ordem, sem perder nem duplicar', async () => {
    const h = montar()
    h.supervisor.start()

    // As respostas voltam pelo pipe em chunks que o SO parte onde quiser: e este
    // o caso que so um pipe real produz e que o acumulador tem de absorver.
    for (let seq = 1; seq <= 200; seq += 1) {
      assert.equal(h.canal().send(DIFUSAO(seq)), true, `difusao ${String(seq)} recusada`)
    }

    assert.equal(
      await waitFor(() => h.intencoes.length >= 200, { timeoutMs: 20_000 }),
      true,
      `chegaram ${String(h.intencoes.length)} de 200`,
    )
    assert.deepEqual(
      h.intencoes.map((i) => i.requestId),
      Array.from({ length: 200 }, (_v, index) => `eco-${String(index + 1)}`),
      'ordem e conteudo tem de bater exatamente',
    )
    assert.equal(h.canal().stats.malformed, 0, 'nenhuma linha foi dada como malformada')

    h.supervisor.dispose()
  })

  it('S2: o ruido humano do worker vai para o log, e NAO para o analisador', async () => {
    const h = montar()
    h.supervisor.start()

    h.canal().send(DIFUSAO(1))
    await waitFor(() => h.intencoes.length >= 1, { timeoutMs: 10_000 })
    await waitFor(() => h.logger.has('warn', '[worker-de-eco STDERR]'), { timeoutMs: 5000 })

    // O texto humano existe, esta no log, e veio por `stderr`.
    assert.equal(h.logger.has('warn', 'mensagem do tipo state'), true)
    // E nao ha vestigio de `stdout` no log: ele e protocolo.
    assert.equal(h.logger.has('debug', '[worker-de-eco STDOUT]'), false)
    assert.equal(h.canal().stats.malformed, 0)

    h.supervisor.dispose()
  })

  it('o disposer derruba o processo e o canal, e `send` fica mudo', async () => {
    const h = montar()
    h.supervisor.start()

    h.canal().send(DIFUSAO(1))
    await waitFor(() => h.intencoes.length >= 1, { timeoutMs: 10_000 })
    const { pid } = h.subprocess.lastChild()
    const canal = h.canal()

    h.supervisor.dispose()

    assert.equal(canal.send(DIFUSAO(2)), false, 'o canal disposto nao escreve mais')
    assert.equal(await waitFor(() => !isAlive(pid), { timeoutMs: 5000 }), true)
  })
})
