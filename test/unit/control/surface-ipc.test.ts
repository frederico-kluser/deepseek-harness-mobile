/**
 * `src/control/surface-ipc.ts` — a superficie Telegram do controlador.
 *
 * Preso aqui: o mapeamento `IpcIntentMessage -> IpcMessageToWorker` — o ack
 * SEMPRE emitido, D29 decidido no proprio tick (SHUTDOWN_IN_PROGRESS), o
 * EXPOSURE_DISABLED sem controlador (modo loopback), o NOT_PAIRED contado no
 * audit (CTL-029), o emergency sem nonce (CTL-024) e o INTERNAL das intencoes
 * ainda sem dono nesta onda.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import type { IpcIntentMessage } from '../../../src/contracts/ipc.ts'
import type { TunnelSnapshot } from '../../../src/contracts/tunnel.ts'
import { createConfirmService } from '../../../src/control/confirm.ts'
import { createTunnelController } from '../../../src/control/controller.ts'
import { criarRespondedorDeNonce, criarRespondedorIpc, resultadoDoAck } from '../../../src/control/surface-ipc.ts'
import type { TunnelSupervisor } from '../../../src/tunnel/supervisor.ts'
import { FakeScheduler } from '../../support/child-double.ts'
import { FakeClock } from '../../support/clock.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'
import { flush } from '../../support/fixtures.ts'

/* ========================================================================= */
/* Duble minimo do supervisor (o comportamento do processo real entra na      */
/* integracao; aqui so a forma interessa)                                     */
/* ========================================================================= */

class SupervisorDuble implements TunnelSupervisor {
  snapshotAtual: TunnelSnapshot = { state: 'STOPPED', attempts: 0 }
  startCalls = 0
  stopCalls = 0
  disposed = false

  start(): Promise<TunnelSnapshot> {
    this.startCalls += 1
    this.snapshotAtual = { state: 'STARTING', attempts: 0 }
    return Promise.resolve(this.snapshotAtual)
  }

  stop(): void {
    this.stopCalls += 1
    this.snapshotAtual = { state: 'STOPPED', attempts: 0 }
  }

  dispose(): void {
    this.disposed = true
  }

  snapshot(): TunnelSnapshot {
    return this.snapshotAtual
  }

  definirObservado(snap: TunnelSnapshot): void {
    this.snapshotAtual = snap
  }
}

interface Bancada {
  responder: ReturnType<typeof criarRespondedorIpc>
  controlador: ReturnType<typeof createTunnelController>
  supervisor: SupervisorDuble
  scheduler: FakeScheduler
  clock: FakeClock
  auditoria: AuditEvent[]
  reemitidas: { contagem: number }
  emergencias: IpcIntentMessage[]
  emitirNonce: (action: 'start' | 'reset') => string
}

function fazerBancada(overrides: {
  controller?: ReturnType<typeof createTunnelController> | undefined
  modoTunel?: boolean
  pareado?: boolean
  /** Modo restrito do controlador interno (CTL-015 mapeado no canal). */
  restritoAtivo?: boolean | undefined
  /** Segredo forte do controlador interno (CTL-009 mapeado no canal). */
  segredoForte?: boolean | undefined
} = {}): Bancada {
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler()
  const supervisor = new SupervisorDuble()
  const auditoria: AuditEvent[] = []
  // Objeto-contador: a bancada devolve a REFERENCIA, nao uma copia do valor.
  const reemitidas: { contagem: number } = { contagem: 0 }
  const emergencias: IpcIntentMessage[] = []

  const controlador = createTunnelController({
    // `createFakeLogger()` e um CALLABLE: os metodos vivem no objeto da chamada.
    log: createFakeLogger()('ctl'),
    supervisor,
    confirm: createConfirmService({
      now: () => clock.now(),
      randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    }),
    agora: () => clock.now(),
    scheduler,
    restritoAtivo: () => overrides.restritoAtivo ?? false,
    segredoForte: () => overrides.segredoForte ?? true,
    requerConfirmacao: true,
    audit: { append: (evento) => auditoria.push(evento) },
    broadcast: () => {},
    persistirIntencao: () => {},
  })

  // `controller: undefined` e um override LEGITIMO (modo loopback): o `??`
  // colapsaria o undefined no controlador, entao o teste distingue a presenca.
  const controller = 'controller' in overrides ? overrides.controller : controlador
  const responder = criarRespondedorIpc({
    controller,
    modoTunel: overrides.modoTunel ?? true,
    pareado: () => overrides.pareado ?? true,
    audit: { append: (evento) => auditoria.push(evento) },
    // `createFakeLogger()` e um CALLABLE: os metodos vivem no objeto da chamada.
    log: createFakeLogger()('ctl'),
    agora: () => clock.now(),
    reemitirEstado: () => {
      reemitidas.contagem += 1
    },
    aposEmergencia: (intent) => emergencias.push(intent),
  })

  return {
    responder,
    controlador,
    supervisor,
    scheduler,
    clock,
    auditoria,
    reemitidas,
    emergencias,
    emitirNonce: (action) => controlador.emitirNonce(action).valor,
  }
}

function intent(overrides: Partial<IpcIntentMessage> = {}): IpcIntentMessage {
  return {
    v: 1,
    type: 'intent',
    intent: 'tunnel.up',
    requestId: 'req-ipc',
    from: 123,
    chat: 456,
    ...overrides,
  }
}

/* ========================================================================= */
/* As intencoes de liga/desliga                                               */
/* ========================================================================= */

describe('tunnel.up', () => {
  it('com nonce valido a partir de STOPPED: accepted JA, e o despacho corre na fila', async () => {
    const h = fazerBancada()
    const resposta = h.responder(intent({ nonce: h.emitirNonce('start') }))

    assert.equal(resposta.type, 'ack')
    assert.equal((resposta as { result?: string }).result, 'accepted')
    assert.equal((resposta as { state?: string }).state, 'STOPPED', 'o ack imediato carrega o estado corrente')

    await flush()
    assert.equal(h.supervisor.startCalls, 1, 'o trabalho lento corre depois, na fila')
  })

  it('em STOPPING responde rejected SHUTDOWN_IN_PROGRESS no proprio tick (D29)', async () => {
    const h = fazerBancada()
    await h.controlador.despachar({ action: 'start', requestedBy: 'telegram:1', requestId: 'a', nonce: h.emitirNonce('start'), at: 1_000 })
    await h.controlador.despachar({ action: 'stop', requestedBy: 'telegram:1', requestId: 'b', at: 1_000 })
    assert.equal(h.controlador.snapshot().state, 'STOPPING')

    const resposta = h.responder(intent({ requestId: 'req-d29', nonce: h.emitirNonce('start') }))
    assert.deepEqual(resposta, {
      v: 1,
      type: 'ack',
      requestId: 'req-d29',
      result: 'rejected',
      state: 'STOPPING',
      code: 'SHUTDOWN_IN_PROGRESS',
    })
  })

  it('sem nonce responde rejected NONCE_INVALID e o spawn nao acontece (CTL-023)', async () => {
    const h = fazerBancada()
    const resposta = h.responder(intent({ requestId: 'req-sem-nonce' }))

    assert.deepEqual(resposta, {
      v: 1,
      type: 'ack',
      requestId: 'req-sem-nonce',
      result: 'rejected',
      state: 'STOPPED',
      code: 'NONCE_INVALID',
    })
    await flush()
    assert.equal(h.supervisor.startCalls, 0)
  })

  it('em READY responde noop e a URL vem pela difusao (nao pelo ack)', async () => {
    const h = fazerBancada()
    await h.controlador.despachar({ action: 'start', requestedBy: 'telegram:1', requestId: 'c', nonce: h.emitirNonce('start'), at: 1_000 })
    // O duble sobrescreve o snapshot no start: a promocao a READY vem do
    // repasse sobre um snapshot que o teste volta a definir.
    h.supervisor.definirObservado({
      state: 'READY',
      info: { url: 'https://x.trycloudflare.com', startedAt: 1_000, mode: 'quick' },
      attempts: 0,
      expiresAt: 5_000,
    })
    h.scheduler.runLast()
    assert.equal(h.controlador.snapshot().state, 'READY')

    const resposta = h.responder(intent({ requestId: 'req-ready', nonce: h.emitirNonce('start') }))
    assert.deepEqual(resposta, {
      v: 1,
      type: 'ack',
      requestId: 'req-ready',
      result: 'noop',
      state: 'READY',
    })
  })

  it('sem controlador (modo loopback) responde EXPOSURE_DISABLED', () => {
    const h = fazerBancada({ controller: undefined })
    const resposta = h.responder(intent({ requestId: 'req-loopback', nonce: 'x' }))

    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { code?: string }).code, 'EXPOSURE_DISABLED')
  })
})

describe('CTL-020 no caminho sincrono do canal (a superficie real)', () => {
  it('requestId repetido de tunnel.down nao repete o efeito', async () => {
    const h = fazerBancada()
    await h.controlador.despachar({ action: 'start', requestedBy: 'telegram:1', requestId: 'f', nonce: h.emitirNonce('start'), at: 1_000 })
    // O duble sobrescreve o snapshot no start: a promocao a READY vem do
    // repasse sobre um snapshot que o teste define DEPOIS do despacho.
    h.supervisor.definirObservado({
      state: 'READY',
      info: { url: 'https://x.trycloudflare.com', startedAt: 1_000, mode: 'quick' },
      attempts: 0,
      expiresAt: 5_000,
    })
    h.scheduler.runLast()
    assert.equal(h.controlador.snapshot().state, 'READY')

    const primeira = h.responder(intent({ intent: 'tunnel.down', requestId: 'req-duplo' }))
    assert.equal((primeira as { result?: string }).result, 'accepted')
    assert.equal(h.supervisor.stopCalls, 1)

    const segunda = h.responder(intent({ intent: 'tunnel.down', requestId: 'req-duplo' }))
    assert.equal((segunda as { result?: string }).result, 'accepted')
    assert.equal((segunda as { state?: string }).state, 'STOPPING')
    assert.equal(h.supervisor.stopCalls, 1, 'o requestId repetido nao re-executa no caminho sincrono')
  })

  it('a recusa sincrona repetida (sem nonce) nao re-audita', async () => {
    const h = fazerBancada()
    const primeira = h.responder(intent({ requestId: 'req-recusa-dupla' }))
    assert.equal((primeira as { code?: string }).code, 'NONCE_INVALID')

    const antes = h.auditoria.length
    const segunda = h.responder(intent({ requestId: 'req-recusa-dupla' }))
    assert.equal((segunda as { code?: string }).code, 'NONCE_INVALID')
    assert.equal(h.auditoria.length, antes, 'a repeticao devolve o primeiro resultado sem re-auditar')
  })
})

describe('tunnel.down', () => {
  it('em READY transiciona para STOPPING e responde accepted — sem nonce (CTL-024)', async () => {
    const h = fazerBancada()
    h.supervisor.definirObservado({
      state: 'READY',
      info: { url: 'https://x.trycloudflare.com', startedAt: 1_000, mode: 'quick' },
      attempts: 0,
      expiresAt: 5_000,
    })
    await h.controlador.despachar({ action: 'start', requestedBy: 'telegram:1', requestId: 'd', nonce: h.emitirNonce('start'), at: 1_000 })
    h.scheduler.runLast()

    const resposta = h.responder(intent({ intent: 'tunnel.down', requestId: 'req-down' }))

    assert.deepEqual(resposta, { v: 1, type: 'ack', requestId: 'req-down', result: 'accepted', state: 'STOPPING' })
    assert.equal(h.supervisor.stopCalls, 1)
  })

  it('em STOPPED responde noop (CTL-004)', () => {
    const h = fazerBancada()
    const resposta = h.responder(intent({ intent: 'tunnel.down', requestId: 'req-noop' }))

    assert.deepEqual(resposta, { v: 1, type: 'ack', requestId: 'req-noop', result: 'noop', state: 'STOPPED' })
    assert.equal(h.supervisor.stopCalls, 0)
  })
})

describe('emergency (kill switch)', () => {
  it('derruba o tunel PRIMEIRO e so depois invalida as sessoes; nao exige nonce', async () => {
    const h = fazerBancada()
    h.supervisor.definirObservado({
      state: 'READY',
      info: { url: 'https://x.trycloudflare.com', startedAt: 1_000, mode: 'quick' },
      attempts: 0,
      expiresAt: 5_000,
    })
    await h.controlador.despachar({ action: 'start', requestedBy: 'telegram:1', requestId: 'e', nonce: h.emitirNonce('start'), at: 1_000 })
    h.scheduler.runLast()

    const resposta = h.responder(intent({ intent: 'emergency', requestId: 'req-emergencia' }))

    assert.deepEqual(resposta, { v: 1, type: 'ack', requestId: 'req-emergencia', result: 'accepted', state: 'STOPPING' })
    await flush()
    assert.equal(h.supervisor.stopCalls, 1)
    assert.equal(h.emergencias.length, 1, 'a invalidacao de sessoes corre DEPOIS do tunel cair')
    assert.equal(h.emergencias[0]?.requestId, 'req-emergencia', 'a origem da linha vem da intent')
  })

  it('sem tunel (loopback) invalida as sessoes na mesma, sem despachar', async () => {
    const h = fazerBancada({ controller: undefined })
    const resposta = h.responder(intent({ intent: 'emergency', requestId: 'req-emg-loopback' }))

    assert.equal(resposta.type, 'ack')
    assert.equal(h.emergencias.length, 1, 'o kill switch funciona de primeira, mesmo sem tunel')
  })
})

describe('tunnel.status', () => {
  it('responde noop com o estado corrente e REENVIA o estado completo (CTL-027)', async () => {
    const h = fazerBancada()
    const resposta = h.responder(intent({ intent: 'tunnel.status', requestId: 'req-status' }))

    assert.deepEqual(resposta, { v: 1, type: 'ack', requestId: 'req-status', result: 'noop', state: 'STOPPED' })
    assert.equal(h.reemitidas.contagem, 1, 'o worker (re)conectado recebe o estado completo, nao um delta')
  })
})

describe('identidade e intencoes sem dono', () => {
  it('identidade nao pareada: NOT_PAIRED antes da maquina de estado, contada no audit (CTL-029)', () => {
    const h = fazerBancada({ pareado: false })
    const resposta = h.responder(intent({ requestId: 'req-estranho' }))

    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { code?: string }).code, 'NOT_PAIRED')
    assert.equal(h.auditoria.some((e) => e.evento.includes('tunel_intent_nao_pareado') && e.resultado === 'negado'), true)
  })

  it('session.issue e secret.rotate respondem INTERNAL (costura pos-onda)', () => {
    const h = fazerBancada()
    for (const intentName of ['session.issue', 'secret.rotate'] as const) {
      const resposta = h.responder(intent({ intent: intentName, requestId: `req-${intentName}` }))
      assert.equal(resposta.type, 'error')
      assert.equal((resposta as { code?: string }).code, 'INTERNAL')
    }
  })
})

describe('resultadoDoAck: a derivacao accepted/noop/rejected', () => {
  it('start em STARTING/DEGRADED e accepted; em READY e noop; em FAILED e rejected PROBE_FAILED', () => {
    assert.equal(resultadoDoAck('start', { estado: 'STARTING', idempotente: false }).result, 'accepted')
    assert.equal(resultadoDoAck('start', { estado: 'DEGRADED', idempotente: false }).result, 'accepted')
    assert.equal(resultadoDoAck('start', { estado: 'READY', idempotente: false }).result, 'noop')
    const falha = resultadoDoAck('start', { estado: 'FAILED', idempotente: false })
    assert.deepEqual(falha, { result: 'rejected', code: 'PROBE_FAILED' })
  })

  it('a recusa mapeia para o codigo fechado do IPC', () => {
    assert.equal(resultadoDoAck('start', { estado: 'STOPPING', idempotente: false, recusa: 'SHUTDOWN_IN_PROGRESS' }).code, 'SHUTDOWN_IN_PROGRESS')
    assert.equal(resultadoDoAck('start', { estado: 'STOPPED', idempotente: false, recusa: 'MODO_RESTRITO' }).code, 'RESTRICTED_MODE')
    assert.equal(resultadoDoAck('start', { estado: 'STOPPED', idempotente: false, recusa: 'TERMINAL_SEM_RESET' }).code, 'TUNNEL_FAILED')
    assert.equal(resultadoDoAck('start', { estado: 'STOPPED', idempotente: false, recusa: 'NONCE_AUSENTE' }).code, 'NONCE_INVALID')
    assert.equal(resultadoDoAck('start', { estado: 'STOPPED', idempotente: false, recusa: 'SEM_SEGREDO_FORTE' }).code, 'INTERNAL')
  })
})
/* ========================================================================= */
/* O RESPONDEDOR DE NONCE — EMENDA-COSTURA-5 (transporte do nonce)          */
/* ========================================================================= */

describe('criarRespondedorDeNonce — o host atende nonce.request', () => {
  it('emite pelo ConfirmService de T5.1 e responde nonce.issued com o requestId do pedido', () => {
    const clock = new FakeClock(1_000)
    const controlador = createTunnelController({
      log: createFakeLogger()('ctl'),
      supervisor: new SupervisorDuble(),
      confirm: createConfirmService({ now: () => clock.now(), randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) }),
      agora: () => clock.now(),
      scheduler: new FakeScheduler(),
      restritoAtivo: () => false,
      segredoForte: () => true,
      requerConfirmacao: true,
      audit: { append: () => undefined },
      broadcast: () => undefined,
      persistirIntencao: () => undefined,
    })
    const avisos: string[] = []
    const responder = criarRespondedorDeNonce({
      controller: controlador,
      log: createFakeLogger()('nonce'),
    })
    void avisos

    const resposta = responder({ v: 1, type: 'nonce.request', acao: 'start', requestId: 'req-nonce' })
    assert.equal(resposta.type, 'nonce.issued')
    assert.equal((resposta as { acao?: string }).acao, 'start')
    assert.equal((resposta as { requestId?: string }).requestId, 'req-nonce')
    // O nonce emitido e CONSUMIVEL pelo mesmo ConfirmService (uso unico):
    // o worker transportou-o opaco e o host aceita-o no consume.
    const emitido = resposta as { nonce?: string; expiresAt?: number }
    assert.ok(typeof emitido.nonce === 'string' && emitido.nonce.length === 32, '128 bits em hex')
    assert.ok(typeof emitido.expiresAt === 'number' && emitido.expiresAt > clock.now(), 'o prazo do nonce viaja')
  })

  it('sem controlador (modo loopback) responde EXPOSURE_DISABLED — fail-closed', () => {
    const responder = criarRespondedorDeNonce({
      controller: undefined,
      log: createFakeLogger()('nonce'),
    })
    const resposta = responder({ v: 1, type: 'nonce.request', acao: 'start', requestId: 'req-loopback' })
    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { code?: string }).code, 'EXPOSURE_DISABLED')
    assert.equal((resposta as { requestId?: string }).requestId, 'req-loopback')
  })

  it('o VALOR do nonce nunca vai ao log (S3): o log so menciona a acao e o prazo', () => {
    const clock = new FakeClock(1_000)
    const controlador = createTunnelController({
      log: createFakeLogger()('ctl'),
      supervisor: new SupervisorDuble(),
      confirm: createConfirmService({ now: () => clock.now(), randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) }),
      agora: () => clock.now(),
      scheduler: new FakeScheduler(),
      restritoAtivo: () => false,
      segredoForte: () => true,
      requerConfirmacao: true,
      audit: { append: () => undefined },
      broadcast: () => undefined,
      persistirIntencao: () => undefined,
    })
    const linhas: string[] = []
    const log = {
      ...createFakeLogger()('nonce'),
      debug: (mensagem: string): void => void linhas.push(mensagem),
    }
    const responder = criarRespondedorDeNonce({ controller: controlador, log })
    const resposta = responder({ v: 1, type: 'nonce.request', acao: 'reset', requestId: 'req-s3' }) as { nonce?: string }
    assert.ok(resposta.nonce !== undefined)
    for (const linha of linhas) assert.ok(!linha.includes(resposta.nonce), 'o nonce nao vai ao log')
  })
})

/* ========================================================================= */
/* 8(d): /parear em grupo — a identidade e REVALIDADA NO HOST (S6, os 2 eixos) */
/* ========================================================================= */

describe('8(d): pareamento de GRUPO — o host revalida os DOIS eixos (from E chat)', () => {
  it('intent do dono NO grupo pareado passa; de outro chat ou de outro from e NOT_PAIRED', () => {
    const clock = new FakeClock(1_000)
    // O pareamento persistido tem o chat do GRUPO: a revalidacao no host
    // exige from == dono E chat == grupo — o worker nao decide sozinho (S6).
    const dono = 42
    const grupo = -1001234567890
    const pareado = (from: number, chat: number): boolean => from === dono && chat === grupo
    const auditoria: AuditEvent[] = []
    const responder = criarRespondedorIpc({
      controller: undefined,
      modoTunel: true,
      pareado,
      audit: { append: (evento) => auditoria.push(evento) },
      log: createFakeLogger()('r'),
      agora: () => clock.now(),
      reemitirEstado: () => undefined,
      aposEmergencia: () => undefined,
    })

    const aceite = responder({ v: 1, type: 'intent', intent: 'tunnel.down', requestId: 'g-1', from: dono, chat: grupo })
    // Sem controlador (modo loopback) a resposta e EXPOSURE_DISABLED — o que
    // importa aqui e que a IDENTIDADE passou: nada de NOT_PAIRED, nada no audit.
    assert.equal((aceite as { code?: string }).code, 'EXPOSURE_DISABLED', 'o dono no grupo pareado passa o portao de identidade')

    const chatErrado = responder({ v: 1, type: 'intent', intent: 'tunnel.down', requestId: 'g-2', from: dono, chat: 999 })
    assert.equal((chatErrado as { code?: string }).code, 'NOT_PAIRED', 'mesmo from, chat fora do pareamento')

    const fromErrado = responder({ v: 1, type: 'intent', intent: 'tunnel.down', requestId: 'g-3', from: 7, chat: grupo })
    assert.equal((fromErrado as { code?: string }).code, 'NOT_PAIRED', 'mesmo grupo, from fora do pareamento')

    assert.equal(auditoria.length, 2, 'as recusas de identidade sao contadas no audit (CTL-029)')
    for (const evento of auditoria) {
      assert.equal(evento.resultado, 'negado')
      assert.match(evento.evento, /tunel_intent_nao_pareado:telegram:/u)
    }
  })
})

/* ========================================================================= */
/* Bordas que faltavam: reset->noop em resultadoDoAck, requestId no erro,    */
/* mapeamento de recusas pelo canal real, secret.rotate sem secretos,        */
/* identidade nao pareada com requestId ecoado                               */
/* ========================================================================= */

describe('resultadoDoAck: o reset e a derivacao que faltava', () => {
  it('reset com estado STOPPED e accepted; com qualquer outro estado e noop', () => {
    assert.deepEqual(resultadoDoAck('reset', { estado: 'STOPPED', idempotente: false }), { result: 'accepted' })
    assert.deepEqual(resultadoDoAck('reset', { estado: 'READY', idempotente: false }), { result: 'noop' })
    assert.deepEqual(resultadoDoAck('reset', { estado: 'STARTING', idempotente: false }), { result: 'noop' })
  })

  it('stop com estado FAILED (sem recusa) e noop — a derivacao nao inventa rejected', () => {
    assert.deepEqual(resultadoDoAck('stop', { estado: 'FAILED', idempotente: false }), { result: 'noop' })
  })
})

describe('a resposta de erro ecoa o requestId da intent (correlacao no canal)', () => {
  it('EXPOSURE_DISABLED carrega o requestId', () => {
    const h = fazerBancada({ controller: undefined })
    const resposta = h.responder(intent({ requestId: 'req-erro-eco', nonce: 'x' }))
    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { requestId?: string }).requestId, 'req-erro-eco')
    assert.equal((resposta as { code?: string }).code, 'EXPOSURE_DISABLED')
  })

  it('NOT_PAIRED carrega o requestId da intent rejeitada', () => {
    const h = fazerBancada({ pareado: false })
    const resposta = h.responder(intent({ requestId: 'req-nao-pareado' }))
    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { requestId?: string }).requestId, 'req-nao-pareado')
    assert.equal((resposta as { code?: string }).code, 'NOT_PAIRED')
  })
})

describe('recusas do controlador mapeadas no canal real (ack com code)', () => {
  it('start com o controlador em FAILED: rejected TUNNEL_FAILED (CTL-011)', async () => {
    const h = fazerBancada()
    await h.controlador.despachar({ action: 'start', requestedBy: 'telegram:1', requestId: 'falha-1', nonce: h.emitirNonce('start'), at: 1_000 })
    // O repasse converge para o snapshot FAILED que o teste define.
    h.supervisor.definirObservado({
      state: 'FAILED',
      failure: { code: 'PROBE_FAILED', message: 'o gate nao esta armado', retryable: false, probe: 'spa-fallback' },
      attempts: 0,
    })
    h.scheduler.runLast()
    assert.equal(h.controlador.snapshot().state, 'FAILED')

    const resposta = h.responder(intent({ requestId: 'req-failed' }))
    assert.deepEqual(resposta, {
      v: 1,
      type: 'ack',
      requestId: 'req-failed',
      result: 'rejected',
      state: 'FAILED',
      code: 'TUNNEL_FAILED',
    })
  })

  it('start com modo restrito ativo: rejected RESTRICTED_MODE (CTL-015)', () => {
    const h = fazerBancada({ restritoAtivo: true })
    const resposta = h.responder(intent({ requestId: 'req-restrito', nonce: 'x' }))
    assert.deepEqual(resposta, {
      v: 1,
      type: 'ack',
      requestId: 'req-restrito',
      result: 'rejected',
      state: 'STOPPED',
      code: 'RESTRICTED_MODE',
    })
  })

  it('start sem segredo forte: rejected INTERNAL — o motivo fica no audit, nao no canal', () => {
    const h = fazerBancada({ segredoForte: false })
    const resposta = h.responder(intent({ requestId: 'req-sem-segredo' }))
    assert.equal(resposta.type, 'ack')
    assert.equal((resposta as { code?: string }).code, 'INTERNAL')
    assert.equal((resposta as { result?: string }).result, 'rejected')
    // O motivo NAO denuncia topologia: SEM_SEGREDO_FORTE nao tem codigo IPC.
    assert.equal(h.auditoria.some((e) => e.evento.includes('tunel_ligar') && e.resultado === 'negado'), true)
  })
})

describe('secret.rotate: a cadeia INTERNAL com cada peca ausente isolada', () => {
  it('secretos ausente (mesmo com confirm e notificarDono presentes) -> INTERNAL', () => {
    const clock = new FakeClock(1_000)
    const confirm = createConfirmService({ now: () => clock.now() })
    const responder = criarRespondedorIpc({
      controller: undefined,
      modoTunel: true,
      pareado: () => true,
      audit: { append: () => undefined },
      log: createFakeLogger()('r'),
      agora: () => clock.now(),
      reemitirEstado: () => undefined,
      aposEmergencia: () => undefined,
      confirm,
      notificarDono: () => undefined,
    })
    const resposta = responder(intent({ intent: 'secret.rotate', requestId: 'req-sem-secretos' }))
    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { code?: string }).code, 'INTERNAL')
    assert.equal((resposta as { requestId?: string }).requestId, 'req-sem-secretos')
  })

  it('confirm ausente (mesmo com secretos e notificarDono presentes) -> INTERNAL', () => {
    const clock = new FakeClock(1_000)
    const responder = criarRespondedorIpc({
      controller: undefined,
      modoTunel: true,
      pareado: () => true,
      audit: { append: () => undefined },
      log: createFakeLogger()('r'),
      agora: () => clock.now(),
      reemitirEstado: () => undefined,
      aposEmergencia: () => undefined,
      secretos: { rotate: () => ({ display: 'x' }) },
      notificarDono: () => undefined,
    })
    const resposta = responder(intent({ intent: 'secret.rotate', requestId: 'req-sem-confirm' }))
    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { code?: string }).code, 'INTERNAL')
  })
})

/* ========================================================================= */
/* Frente 4 (Onda 6): o /emergencia nunca derruba o processo por uma         */
/* promise derivada sem catch, e o despacho SINCRONO avariado vira ack de    */
/* erro — nunca escapa (o "ack sempre emitido" e o contrato do canal, Q-5).  */
/* ========================================================================= */

describe('Frente 4 (Onda 6): emergency sem unhandled rejection', () => {
  it('(a) aposEmergencia a LANCAR: o ack sai e a rejeicao da promise derivada e tratada (log, sem unhandled rejection)', async () => {
    const h = fazerBancada()
    const servico = createFakeLogger()
    const responder = criarRespondedorIpc({
      controller: h.controlador,
      modoTunel: true,
      pareado: () => true,
      audit: { append: () => undefined },
      log: servico('ctl'),
      agora: () => h.clock.now(),
      reemitirEstado: () => undefined,
      aposEmergencia: () => {
        throw new Error('invalidacao de sessoes avariada')
      },
    })

    const resposta = responder(intent({ intent: 'emergency', requestId: 'req-f4-apos' }))

    assert.equal(resposta.type, 'ack', 'o ack sai ANTES da promise derivada')
    await flush()
    // Com o .catch, a rejeicao e logada e o processo segue; sem o .catch,
    // o node:test morre com unhandled rejection — a mutacao mata-se sozinha.
    assert.equal(servico.has('error', 'falha no /emergencia apos o ack'), true)
  })

  it('(b) o despacho SINCRONO que LANCA (persistirIntencao a rebentar no stop) vira ack de erro — nada escapa', async () => {
    const clock = new FakeClock(1_000)
    const scheduler = new FakeScheduler()
    const supervisor = new SupervisorDuble()
    const servico = createFakeLogger()
    const controlador = createTunnelController({
      log: servico('ctl'),
      supervisor,
      confirm: createConfirmService({
        now: () => clock.now(),
        randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      }),
      agora: () => clock.now(),
      scheduler,
      restritoAtivo: () => false,
      segredoForte: () => true,
      requerConfirmacao: true,
      audit: { append: () => undefined },
      broadcast: () => undefined,
      persistirIntencao: (alvo) => {
        // Sobe ate READY (READY e persistido sem problema) e rebenta SO no
        // stop do emergency (STOPPED) — o cenario real de um disco a falhar
        // no instante da paragem.
        if (alvo === 'STOPPED') throw new Error('nao foi possivel persistir a intencao (disco)')
      },
    })
    // Ate READY: o start persiste READY e funciona; o repasse promove.
    await controlador.despachar({ action: 'start', requestedBy: 'telegram:1', requestId: 'up-f4', nonce: controlador.emitirNonce('start').valor, at: 1_000 })
    supervisor.definirObservado({
      state: 'READY',
      info: { url: 'https://x.trycloudflare.com', startedAt: 1_000, mode: 'quick' },
      attempts: 0,
      expiresAt: 5_000,
    })
    scheduler.runLast()
    assert.equal(controlador.snapshot().state, 'READY')

    const responder = criarRespondedorIpc({
      controller: controlador,
      modoTunel: true,
      pareado: () => true,
      audit: { append: () => undefined },
      log: servico('ctl'),
      agora: () => clock.now(),
      reemitirEstado: () => undefined,
      aposEmergencia: () => undefined,
    })

    const resposta = responder(intent({ intent: 'emergency', requestId: 'req-f4-sync' }))

    assert.equal(resposta.type, 'error', 'o throw sincrono vira ack de erro, nunca escapa')
    assert.equal((resposta as { code?: string }).code, 'INTERNAL')
    assert.equal((resposta as { requestId?: string }).requestId, 'req-f4-sync')
    assert.equal(servico.has('error', 'falha ao despachar o /emergencia'), true)
  })

  it('(b2) sem tunel (loopback): um aposEmergencia que LANCA nao impede o ack', () => {
    const servico = createFakeLogger()
    const responder = criarRespondedorIpc({
      controller: undefined,
      modoTunel: true,
      pareado: () => true,
      audit: { append: () => undefined },
      log: servico('ctl'),
      agora: () => 1_000,
      reemitirEstado: () => undefined,
      aposEmergencia: () => {
        throw new Error('invalidacao avariada no loopback')
      },
    })

    const resposta = responder(intent({ intent: 'emergency', requestId: 'req-f4-loop' }))

    assert.equal(resposta.type, 'ack')
    assert.equal((resposta as { result?: string }).result, 'accepted')
    assert.equal(servico.has('error', 'falha no /emergencia (sem tunel)'), true)
  })
})
