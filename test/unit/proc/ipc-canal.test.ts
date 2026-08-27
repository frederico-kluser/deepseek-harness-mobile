/**
 * A FIACAO do canal IPC ao supervisor do worker (`src/proc/worker.ts` +
 * `src/proc/supervisor.ts`).
 *
 * O codec esta em `test/unit/ipc/channel.test.ts` e o comportamento contra
 * processos reais em `test/integration/proc/**`. O que SO aqui se prova e a
 * composicao: que o canal nasce e morre com o filho a que pertence, que
 * `send()` fala com o filho CORRENTE, e que a mudanca de `stdio` nao regrediu
 * nenhuma das invariantes que a Onda 3 fixou.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { IpcIntentMessage, IpcMessageToWorker } from '../../../src/contracts/ipc.ts'
import { createWorkerSupervisor } from '../../../src/proc/supervisor.ts'
import { serializeIpcMessage } from '../../../src/ipc/channel.ts'
import { FakeScheduler, makeSupervisorDeps } from '../../support/child-double.ts'
import { flush, makeConfig } from '../../support/fixtures.ts'
import { makeContextoComStdio } from './ipc-seat.ts'

const INTENCAO: IpcIntentMessage = {
  v: 2,
  type: 'intent',
  intent: 'tunnel.up',
  requestId: '01J0000000000000000000000A',
  from: '123456789',
  chat: '123456789',
}

const SAIDA_COM_ERRO = { exitCode: 1, signal: null } as const

function montar(onIntent?: (intent: IpcIntentMessage) => IpcMessageToWorker): {
  ctx: ReturnType<typeof makeContextoComStdio>
  scheduler: FakeScheduler
  supervisor: ReturnType<typeof createWorkerSupervisor>
} {
  const ctx = makeContextoComStdio()
  const scheduler = new FakeScheduler()
  const { deps } = makeSupervisorDeps(scheduler)
  const supervisor = createWorkerSupervisor(
    ctx.ctx,
    makeConfig(),
    deps,
    onIntent === undefined ? {} : { onIntent },
  )
  return { ctx, scheduler, supervisor }
}

describe('o canal nasce com o filho e o `stdio` nao regrediu', () => {
  it('o spec pede `stdin: pipe` e o handle publica o `stdin` correspondente', () => {
    const h = montar()
    h.supervisor.start()

    assert.equal(h.ctx.subprocess.calls[0]?.stdio.stdin, 'pipe')
    assert.notEqual(h.ctx.subprocess.lastChild().stdin, undefined)
    h.supervisor.dispose()
  })

  it('o ambiente leva a marca DSH_GUARD_IPC, e ela nao e o controlo', () => {
    const h = montar()
    h.supervisor.start()

    assert.equal(h.ctx.subprocess.calls[0]?.env?.['DSH_GUARD_IPC'], '1')
    h.supervisor.dispose()
  })

  it('o ouvinte do canal esta ligado no `stdout` ANTES de qualquer leitura', () => {
    const h = montar()
    h.supervisor.start()
    const child = h.ctx.subprocess.lastChild()

    // UM ouvinte de `'data'`: o do canal. O encaminhamento de `stdout` para o
    // log saiu de cena (S2) e nao pode voltar -- duas copias de cada mensagem
    // do protocolo no log e ruido que treina o operador a nao ler o log.
    assert.equal(child.stdout.listenerCount('data'), 1)
    assert.equal(child.stderr.listenerCount('data'), 1, 'o stderr continua no log')
    h.supervisor.dispose()
  })
})

describe('a viagem completa: intencao entra pelo stdout, resposta sai pelo stdin', () => {
  it('com controlador montado, a resposta dele e o que viaja', () => {
    const vistas: IpcIntentMessage[] = []
    const h = montar((intent): IpcMessageToWorker => {
      vistas.push(intent)
      return { v: 2, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'STARTING' }
    })
    h.supervisor.start()

    const child = h.ctx.subprocess.lastChild()
    child.diz(serializeIpcMessage(INTENCAO, 'to-host'))

    assert.deepEqual(vistas, [INTENCAO])
    assert.equal(
      child.recebido(),
      serializeIpcMessage(
        { v: 2, type: 'ack', requestId: INTENCAO.requestId, result: 'accepted', state: 'STARTING' },
        'to-worker',
      ),
    )
    h.supervisor.dispose()
  })

  it('SEM controlador, responde INTERNAL -- fail-closed, com log, nunca silencio', () => {
    const h = montar()
    h.supervisor.start()

    const child = h.ctx.subprocess.lastChild()
    child.diz(serializeIpcMessage(INTENCAO, 'to-host'))

    const resposta = child.recebido()
    assert.match(resposta, /"type":"error"/u)
    assert.match(resposta, /"code":"INTERNAL"/u)
    assert.match(resposta, new RegExp(INTENCAO.requestId, 'u'), 'a resposta nomeia o pedido')
    assert.equal(h.ctx.logger.has('warn', 'sem controlador montado'), true)
    h.supervisor.dispose()
  })

  it('linha malformada seguida de boa: a boa responde e o canal fica de pe', () => {
    const h = montar()
    h.supervisor.start()
    const child = h.ctx.subprocess.lastChild()

    child.diz('{isto nao e json\n')
    child.diz('{"v":7,"type":"intent"}\n')
    child.diz(serializeIpcMessage(INTENCAO, 'to-host'))

    assert.equal(child.recebido().split('\n').filter((l) => l !== '').length, 1)
    assert.equal(h.ctx.logger.has('warn', 'json-invalido'), true)
    assert.equal(h.ctx.logger.has('warn', 'versao-desconhecida'), true)
    h.supervisor.dispose()
  })

  it('uma intencao partida entre dois chunks e reconstruida', () => {
    const h = montar()
    h.supervisor.start()
    const child = h.ctx.subprocess.lastChild()

    const linha = serializeIpcMessage(INTENCAO, 'to-host')
    child.diz(linha.slice(0, 15))
    assert.equal(child.recebido(), '', 'metade de uma linha nao produz resposta')
    child.diz(linha.slice(15))

    assert.notEqual(child.recebido(), '')
    h.supervisor.dispose()
  })
})

describe('`send()` fala sempre com o filho CORRENTE', () => {
  const DIFUSAO: IpcMessageToWorker = { v: 2, type: 'state', state: 'STOPPED', seq: 1 }

  it('antes do arranque nao ha canal, e `send` devolve false sem lancar', () => {
    const h = montar()
    assert.equal(h.supervisor.send(DIFUSAO), false)
  })

  it('depois do arranque escreve no `stdin` do filho', () => {
    const h = montar()
    h.supervisor.start()

    assert.equal(h.supervisor.send(DIFUSAO), true)
    assert.equal(h.ctx.subprocess.lastChild().recebido(), serializeIpcMessage(DIFUSAO, 'to-worker'))
    h.supervisor.dispose()
  })

  it('apos um reinicio, escreve no filho NOVO e nao no antigo', async () => {
    const h = montar()
    h.supervisor.start()
    const antigo = h.ctx.subprocess.lastChild()

    antigo.settle(SAIDA_COM_ERRO)
    await flush()
    h.scheduler.runLast()

    const novo = h.ctx.subprocess.lastChild()
    assert.notEqual(novo, antigo, 'houve mesmo um segundo filho')
    assert.equal(h.supervisor.send(DIFUSAO), true)
    assert.equal(antigo.recebido(), '', 'o filho morto nao recebe nada')
    assert.equal(novo.recebido(), serializeIpcMessage(DIFUSAO, 'to-worker'))
    h.supervisor.dispose()
  })

  it('depois do disposer o canal esta mudo e o ouvinte foi removido', () => {
    const h = montar()
    h.supervisor.start()
    const child = h.ctx.subprocess.lastChild()

    h.supervisor.dispose()

    assert.equal(h.supervisor.send(DIFUSAO), false)
    assert.equal(child.stdout.listenerCount('data'), 0)
    // O absorvedor de `'error'` FICA: um EventEmitter sem ele LANCA no host, e
    // um EPIPE num stream de filho morto derrubaria o DSH inteiro.
    assert.ok(child.stdout.listenerCount('error') >= 1)
  })

  it('`dispose()` 3x = 1 kill do grupo (idempotente), e continua sincrono', () => {
    const ctx = makeContextoComStdio()
    ctx.subprocess.pid = 77
    const { deps, kills } = makeSupervisorDeps(new FakeScheduler())
    const supervisor = createWorkerSupervisor(ctx.ctx, makeConfig(), deps)

    supervisor.start()
    supervisor.dispose()
    supervisor.dispose()
    supervisor.dispose()

    // O sinal NEGATIVO alveja o GRUPO, e uma so vez. Passar `stdin` a `'pipe'`
    // nao mexeu nisto -- a evidencia contra processos reais esta em
    // `test/integration/proc/stdio-pipe-nao-regride-tree-kill.test.ts`.
    assert.deepEqual(kills, [[-77, 'SIGKILL']])
    assert.equal(supervisor.send({ v: 2, type: 'state', state: 'STOPPED', seq: 1 }), false)
  })

  it('a morte do filho fecha o canal: `send` deixa de escrever', async () => {
    const h = montar()
    h.supervisor.start()
    const child = h.ctx.subprocess.lastChild()

    child.settle(SAIDA_COM_ERRO)
    await flush()

    assert.equal(h.supervisor.send(DIFUSAO), false)
    assert.equal(child.recebido(), '')
    h.supervisor.dispose()
  })
})

describe('a superficie generica continua observavel atraves do embrulho do worker', () => {
  it('`attempts`, `exhausted` e `failure` sao lidos ao vivo, nao congelados', async () => {
    const config = makeConfig()
    config.worker.backoff.maxAttempts = 2
    const ctx = makeContextoComStdio()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)
    const supervisor = createWorkerSupervisor(ctx.ctx, config, deps)

    supervisor.start()
    assert.equal(supervisor.attempts, 0)

    for (let i = 0; i < 2; i += 1) {
      ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO)
      await flush()
      scheduler.runLast()
    }
    ctx.subprocess.lastChild().settle(SAIDA_COM_ERRO) // 3a falha: ultrapassa o orcamento
    await flush()

    // Se o embrulho tivesse copiado os getters por valor (`{ ...supervisor }`),
    // estas tres leituras davam o estado do instante da copia -- `attempts` em
    // zero e `exhausted` em false para sempre.
    assert.equal(supervisor.attempts, 3)
    assert.equal(supervisor.exhausted, true)
    assert.equal(supervisor.failure?.kind, 'BUDGET_EXHAUSTED')
    assert.equal(supervisor.signal.aborted, false)

    supervisor.dispose()
    assert.equal(supervisor.signal.aborted, true)
  })
})
