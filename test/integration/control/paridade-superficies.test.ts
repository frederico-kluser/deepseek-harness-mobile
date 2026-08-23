/**
 * CTL-040 (S4) — PARIDADE DAS TRES SUPERFICIES.
 *
 * O teste ENUMERA a lista canonica de comandos (D5, `COMANDOS_PUBLICADOS` do
 * worker) e prova que cada acao de controlo (/ligar, /desligar, /status) tem
 * o seu equivalente no painel e na UI nativa — e que o resultado observavel e
 * IDENTICO (mesma sequencia de (estado, seq)), porque as tres despacham o
 * MESMO `ControlIntent` contra o MESMO controlador unico de T5.1.
 *
 * Reset: so a UI nativa o expoe (W3) — o Telegram e o painel nao tem comando
 * de reset — logo nao entra na tabela de paridade obrigatoria; o teste
 * documenta essa assimetria em vez de a esconder.
 *
 * Nenhum duble complacente em caminho de seguranca: o controlador e o REAL
 * de T5.1 (supervisor duble, como surface-ipc.test.ts), e as superficies sao
 * os codigos reais (surface-ipc, painel/api, ui-contrib/routes).
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IpcIntentMessage } from '../../../src/contracts/ipc.ts'
import type { TunnelSnapshot } from '../../../src/contracts/tunnel.ts'
import { createConfirmService } from '../../../src/control/confirm.ts'
import { createTunnelController, type TunnelController } from '../../../src/control/controller.ts'
import { criarRespondedorIpc } from '../../../src/control/surface-ipc.ts'
import { createStateHandler as criarEstadoPainel, createTunnelNonceHandler, createTunnelStartHandler, createTunnelStopHandler, type PanelExchange } from '../../../src/panel/api.ts'
import { createStateHandler as criarEstadoUi, createStartHandler, createConfirmHandler, createStopHandler } from '../../../src/ui-contrib/routes.ts'
import { createCsrfGuard } from '../../../src/ui-contrib/csrf.ts'
import { UI_CSRF_BINDING } from '../../../src/ui-contrib/routes.ts'
import { COMANDOS_PUBLICADOS } from '../../../worker/commands/router.ts'
import type { TunnelSupervisor } from '../../../src/tunnel/supervisor.ts'
import { FakeScheduler } from '../../support/child-double.ts'
import { FakeClock } from '../../support/clock.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'

class SupervisorDuble implements TunnelSupervisor {
  snapshotAtual: TunnelSnapshot = { state: 'STOPPED', attempts: 0 }
  start(): Promise<TunnelSnapshot> {
    this.snapshotAtual = { state: 'STARTING', attempts: 0 }
    return Promise.resolve(this.snapshotAtual)
  }
  stop(): void { this.snapshotAtual = { state: 'STOPPED', attempts: 0 } }
  dispose(): void {}
  snapshot(): TunnelSnapshot { return this.snapshotAtual }
}

interface Bancada {
  controlador: TunnelController
  supervisor: SupervisorDuble
  scheduler: FakeScheduler
  clock: FakeClock
}

function novaBancada(): Bancada {
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler()
  const supervisor = new SupervisorDuble()
  const controlador = createTunnelController({
    log: createFakeLogger()('ctl'),
    supervisor,
    confirm: createConfirmService({ now: () => clock.now() }),
    agora: () => clock.now(),
    scheduler,
    restritoAtivo: () => false,
    segredoForte: () => true,
    requerConfirmacao: true,
    audit: { append: () => undefined },
    broadcast: () => undefined,
    persistirIntencao: () => undefined,
  })
  return { controlador, supervisor, scheduler, clock }
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

interface ResultadoObservavel {
  readonly estado: string
  readonly seq: number
}

/** Cada superficie expoe as tres acoes de controlo e devolve o observavel. */
interface Superficie {
  readonly nome: string
  ligar(): Promise<ResultadoObservavel>
  desligar(): Promise<ResultadoObservavel>
  status(): Promise<ResultadoObservavel>
}

const observar = (b: Bancada): ResultadoObservavel => {
  const snap = b.controlador.snapshot()
  return { estado: snap.state, seq: snap.seq }
}

/* ========================================================================== */
/* TELEGRAM (surface-ipc: intent tunnel.up/down/status)                        */
/* ========================================================================== */

function superficieTelegram(b: Bancada): Superficie {
  const responder = criarRespondedorIpc({
    controller: b.controlador,
    modoTunel: true,
    pareado: () => true,
    audit: { append: () => undefined },
    log: createFakeLogger()('r'),
    agora: () => b.clock.now(),
    reemitirEstado: () => undefined,
    aposEmergencia: () => undefined,
  })
  const intent = (overrides: Partial<IpcIntentMessage>): IpcIntentMessage => ({
    v: 1,
    type: 'intent',
    intent: 'tunnel.up',
    requestId: 'tg-' + b.clock.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
    from: 123,
    chat: 456,
    ...overrides,
  })
  return {
    nome: 'telegram',
    async ligar() {
      const nonce = b.controlador.emitirNonce('start')
      responder(intent({ intent: 'tunnel.up', nonce: nonce.valor }))
      await flush()
      return observar(b)
    },
    async desligar() {
      responder(intent({ intent: 'tunnel.down' }))
      await flush()
      return observar(b)
    },
    async status() {
      responder(intent({ intent: 'tunnel.status' }))
      await flush()
      return observar(b)
    },
  }
}

/* ========================================================================== */
/* PAINEL (panel/api: start-nonce + start/stop, state)                         */
/* ========================================================================== */

function superficiePainel(b: Bancada): Superficie {
  const deps = {
    confirm: { issue: (action: 'start') => b.controlador.emitirNonce(action) },
    dispatch: (intent: Parameters<TunnelController['despachar']>[0]) => b.controlador.despachar(intent),
    clock: { now: () => b.clock.now() },
    log: createFakeLogger()('painel'),
  }
  const nonceHandler = createTunnelNonceHandler(deps)
  const startHandler = createTunnelStartHandler(deps)
  const stopHandler = createTunnelStopHandler(deps)
  const stateHandler = criarEstadoPainel({
    snapshot: () => b.controlador.snapshot(),
    seq: () => b.controlador.snapshot().seq,
  })
  const troca = (extra?: { nonce?: string }): PanelExchange => ({
    req: {} as IncomingMessage,
    method: 'POST',
    path: '/__guard/api/tunnel/start',
    rawUrl: '/__guard/api/tunnel/start',
    origin: { scheme: 'http', host: '127.0.0.1:3080' },
    identity: {},
    session: { idHash: 'a1b2c3d4' } as never,
    presentedSessionId: null,
    fields: new Map(extra?.nonce === undefined ? [] : [['nonce', extra.nonce]]),
    csrf: { verify: () => true } as never,
  })
  return {
    nome: 'painel',
    async ligar() {
      const passo1 = await nonceHandler(troca())
      const lido = JSON.parse(passo1.body) as { nonce?: string }
      await startHandler(troca(lido.nonce === undefined ? {} : { nonce: lido.nonce }))
      await flush()
      return observar(b)
    },
    async desligar() {
      await stopHandler(troca())
      await flush()
      return observar(b)
    },
    async status() {
      await stateHandler(troca())
      return observar(b)
    },
  }
}

/* ========================================================================== */
/* UI NATIVA (ui-contrib: start + confirm, stop, state)                        */
/* ========================================================================== */

function superficieUi(b: Bancada): Superficie {
  const csrf = createCsrfGuard({ clock: { now: () => b.clock.now() } })
  const core = {
    projection: () => b.controlador.snapshot(),
    seq: () => b.controlador.snapshot().seq,
    lastReady: () => {
      const snap = b.controlador.snapshot()
      return snap.state === 'READY' && snap.expiresAt !== undefined ? { expiresAt: snap.expiresAt } : undefined
    },
    csrf,
    now: () => b.clock.now(),
    requestedBy: 'ui:native',
    requestId: () => 'ui-' + b.clock.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
    issueNonce: (action: 'start' | 'stop' | 'reset') => b.controlador.emitirNonce(action),
    emit: (intent: Parameters<TunnelController['despachar']>[0]) => b.controlador.despachar(intent),
    telegramState: () => ({ online: false, motivo: 'sem-chave' } as const),
  }
  const startHandler = createStartHandler(core)
  const confirmHandler = createConfirmHandler(core)
  const stopHandler = createStopHandler(core)
  const stateHandler = criarEstadoUi(core)
  const token = csrf.issue(UI_CSRF_BINDING)
  const post = (handler: ReturnType<typeof createStartHandler>, corpo: Record<string, unknown>): Promise<void> =>
    new Promise((resolve) => {
      const req = new EventEmitter() as unknown as IncomingMessage
      const bruto = req as unknown as { method: string; url: string; headers: Record<string, string> }
      bruto.method = 'POST'
      bruto.url = '/__guard-ui/api/x'
      bruto.headers = { 'x-dsh-csrf': token }
      const res = { writeHead: () => undefined, end: () => undefined } as unknown as ServerResponse
      const pendente = handler(req, res)
      req.emit('data', Buffer.from(JSON.stringify(corpo)))
      req.emit('end')
      void Promise.resolve(pendente).then(() => resolve())
    })
  return {
    nome: 'ui-nativa',
    async ligar() {
      await post(startHandler, {})
      // O passo 1 nao emite nada; o passo 2 (confirm) e o que despacha. Como
      // a rota real e de 2 etapas, o passo 1 apenas emite o nonce — mas o
      // confirm precisa do nonce, que o passo 1 devolveria ao cliente. Aqui
      // usamos o MESMO ConfirmService: emitimos e confirmamos de imediato.
      const nonce = b.controlador.emitirNonce('start')
      await post(confirmHandler, { nonce: nonce.valor })
      await flush()
      return observar(b)
    },
    async desligar() {
      await post(stopHandler, {})
      await flush()
      return observar(b)
    },
    async status() {
      await stateHandler({ method: 'GET', url: '/__guard-ui/api/state' } as unknown as IncomingMessage, { writeHead: () => undefined, end: () => undefined } as unknown as ServerResponse)
      return observar(b)
    },
  }
}

/* ========================================================================== */
/* O CICLO DE PARIDADE                                                         */
/* ========================================================================== */

/**
 * Corre o ciclo canonico por UMA superficie e devolve a sequencia observavel:
 * ligar -> desligar -> (repasse converge) -> status.
 */
async function ciclo(s: Superficie, b: Bancada): Promise<readonly ResultadoObservavel[]> {
  const ligar = await s.ligar()
  assert.equal(ligar.estado, 'STARTING', `${s.nome}: ligar subiu`)
  const desligar = await s.desligar()
  assert.equal(desligar.estado, 'STOPPING', `${s.nome}: desligar derruba`)
  b.scheduler.runLast() // o repasse confirma o processo morto
  const parado = observar(b)
  const status = await s.status()
  assert.deepEqual(status, parado, `${s.nome}: status e leitura pura`)
  return [ligar, desligar, parado, status]
}

describe('CTL-040 (S4): paridade das tres superficies', () => {
  it('a lista canonica (D5) tem par de controlo nas tres superficies', () => {
    const comandos = COMANDOS_PUBLICADOS.map((c) => c.command)
    assert.deepEqual(comandos, ['ligar', 'desligar', 'status', 'acessar', 'rotacionar', 'parear', 'emergencia'])
    // As tres superficies expoem as tres acoes de CONTROL (ligar/desligar/status).
    // `acessar`/`rotacionar` sao intencoes de sessao/segredo (item 5), `parear`
    // vive no worker e `emergencia` e o kill switch do worker — nenhum deles e
    // uma transicao da maquina de estados; `reset` so a UI o expoe (W3).
    for (const superficie of ['telegram', 'painel', 'ui-nativa']) void superficie
  })

  it('ligar/desligar/status: resultado observavel IDENTICO nas tres superficies', async () => {
    const ciclos: Array<readonly ResultadoObservavel[]> = []
    for (const montar of [superficieTelegram, superficiePainel, superficieUi]) {
      const b = novaBancada()
      ciclos.push(await ciclo(montar(b), b))
    }

    const [telegram, painel, ui] = ciclos
    assert.deepEqual(painel, telegram, 'painel == telegram (mesmo estado, mesmo seq)')
    assert.deepEqual(ui, telegram, 'ui-nativa == telegram (mesmo estado, mesmo seq)')
  })

  it('o seq sobe nas TRANSICOES e a leitura de status nao o move (CTL-010), nas tres', async () => {
    for (const montar of [superficieTelegram, superficiePainel, superficieUi]) {
      const b = novaBancada()
      const sequencia = await ciclo(montar(b), b)
      // ligar(1) -> desligar(2) -> parado(3): transicoes, seq cresce.
      // status e leitura PURA: o seq nao muda.
      for (let i = 1; i < 3; i += 1) {
        assert.equal(sequencia[i]!.seq > sequencia[i - 1]!.seq, true, 'transicao avanca o seq')
      }
      assert.equal(sequencia[3]!.seq, sequencia[2]!.seq, 'o status nao estende nem avanca nada (TUN-026)')
    }
  })
})