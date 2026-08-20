/**
 * Item 5 (costura): session.issue (/acessar) e secret.rotate (/rotacionar)
 * no responder do HOST — o link magico REAL (MagicStore de T2.2) e a rotacao
 * com nonce consumido no HOST, SEM a senha a sair pelo chat (S3/Q-4).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { IpcIntentMessage } from '../../../src/contracts/ipc.ts'
import { createConfirmService } from '../../../src/control/confirm.ts'
import { createTunnelController } from '../../../src/control/controller.ts'
import { criarRespondedorIpc } from '../../../src/control/surface-ipc.ts'
import type { TunnelSnapshot } from '../../../src/contracts/tunnel.ts'
import type { TunnelSupervisor } from '../../../src/tunnel/supervisor.ts'
import { createMagicStore } from '../../../src/session/magic.ts'
import { FakeScheduler } from '../../support/child-double.ts'
import { FakeClock } from '../../support/clock.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'

class SupervisorDuble implements TunnelSupervisor {
  snapshotAtual: TunnelSnapshot = { state: 'STOPPED', attempts: 0 }
  start(): Promise<TunnelSnapshot> { return Promise.resolve(this.snapshotAtual) }
  stop(): void {}
  dispose(): void {}
  snapshot(): TunnelSnapshot { return this.snapshotAtual }
  definirObservado(snap: TunnelSnapshot): void { this.snapshotAtual = snap }
}

function intent(overrides: Partial<IpcIntentMessage> = {}): IpcIntentMessage {
  return {
    v: 1,
    type: 'intent',
    intent: 'session.issue',
    requestId: 'req-item5',
    from: 123,
    chat: 456,
    ...overrides,
  }
}

function controladorRead(supervisor: SupervisorDuble): {
  controlador: ReturnType<typeof createTunnelController>
  scheduler: FakeScheduler
  clock: FakeClock
} {
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler()
  return {
    controlador: createTunnelController({
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
    }),
    scheduler,
    clock,
  }
}

describe('session.issue — o link magico REAL (item 5, TG-085)', () => {
  it('com o tunel READY: emite o mk e notifica com o link; ack accepted INVISIVEL', async () => {
    const clock = new FakeClock(1_000)
    const supervisor = new SupervisorDuble()
    supervisor.definirObservado({
      state: 'READY',
      info: { url: 'https://x.trycloudflare.com', startedAt: 1_000, mode: 'quick' },
      attempts: 0,
      expiresAt: 5_000,
    })
    const notificacoes: string[] = []
    const magic = createMagicStore({
      clock: { now: () => clock.now() },
      randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    })
    const montado = controladorRead(supervisor)
    // A PROMOCAO a READY vem do repasse, e o repasse so arma numa transicao:
    // sobe-se com um start real (nonce) e o supervisor reporta READY logo no
    // start; o repasse promove.
    const confirmacao = montado.controlador.emitirNonce('start')
    await montado.controlador.despachar({
      action: 'start',
      requestedBy: 'telegram:1',
      requestId: 'item5-up',
      nonce: confirmacao.valor,
      at: montado.clock.now(),
    })
    supervisor.definirObservado({
      state: 'READY',
      info: { url: 'https://x.trycloudflare.com', startedAt: 1_000, mode: 'quick' },
      attempts: 0,
      expiresAt: 5_000,
    })
    montado.scheduler.runLast()
    assert.equal(montado.controlador.snapshot().state, 'READY')
    const responder = criarRespondedorIpc({
      controller: montado.controlador,
      modoTunel: true,
      pareado: () => true,
      audit: { append: () => undefined },
      log: createFakeLogger()('r'),
      agora: () => clock.now(),
      reemitirEstado: () => undefined,
      aposEmergencia: () => undefined,
      magic,
      notificarDono: (texto) => void notificacoes.push(texto),
    })

    const resposta = responder(intent())
    assert.equal(resposta.type, 'ack')
    assert.equal((resposta as { result?: string }).result, 'accepted')
    assert.equal(notificacoes.length, 1)
    const texto = notificacoes[0] ?? ''
    assert.match(texto, /alerta:link-magico/u, 'o marcador do link (T5.4)')
    assert.match(texto, /x.trycloudflare.com/u, 'a URL do tunel no link')
    assert.match(texto, /#mk=/u, 'o mk no FRAGMENTO (D3)')
    const mk = /#mk=([A-Za-z0-9_-]+)/u.exec(texto)?.[1]
    assert.ok(mk !== undefined)
    assert.equal(magic.consume(mk), true, 'o mk emitido e consumivel (uso unico)')
    assert.equal(magic.consume(mk), false, 'segundo consumo recusado')
  })

  it('sem tunel online, o /acessar e recusado (o link nao tem para onde apontar)', () => {
    const clock = new FakeClock(1_000)
    const supervisor = new SupervisorDuble()
    const responder = criarRespondedorIpc({
      controller: controladorRead(supervisor).controlador,
      modoTunel: true,
      pareado: () => true,
      audit: { append: () => undefined },
      log: createFakeLogger()('r'),
      agora: () => clock.now(),
      reemitirEstado: () => undefined,
      aposEmergencia: () => undefined,
      magic: createMagicStore({ clock: { now: () => clock.now() } }),
      notificarDono: () => undefined,
    })
    const resposta = responder(intent({ requestId: 'req-off' }))
    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { code?: string }).code, 'INTERNAL')
  })

  it('sem magia fiada (o estado de antes da costura), INTERNAL fail-closed', () => {
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
    })
    const resposta = responder(intent({ requestId: 'req-sem-magia' }))
    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { code?: string }).code, 'INTERNAL')
  })
})

describe('secret.rotate — nonce consumido no HOST, senha nunca pelo chat (item 5)', () => {
  it('com nonce valido: regera, invalida sessoes (SECRET-008) e NOTIFICA sem a senha', () => {
    const clock = new FakeClock(1_000)
    const confirm = createConfirmService({
      now: () => clock.now(),
      randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    })
    const rotacoes: string[] = []
    const notificacoes: string[] = []
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
      secretos: {
        rotate: () => {
          rotacoes.push('rotacao')
          return { display: 'A SENHA EM CLARO' }
        },
      },
      notificarDono: (texto) => void notificacoes.push(texto),
    })
    const nonce = confirm.issue('reset').valor

    const resposta = responder(intent({ intent: 'secret.rotate', requestId: 'req-rotate', nonce }))
    assert.equal(resposta.type, 'ack')
    assert.equal((resposta as { result?: string }).result, 'accepted')
    assert.equal(rotacoes.length, 1, 'o segredo foi regenerado')
    assert.equal(notificacoes.length, 1)
    const texto = notificacoes[0] ?? ''
    assert.ok(!texto.includes('A SENHA EM CLARO'), 'a senha NUNCA sai pelo chat (S3/Q-4)')
    assert.match(texto, /terminal/u, 'a instrucao do caminho local chega ao dono')
    assert.equal(confirm.consume(nonce, 'reset'), false, 'o nonce foi CONSUMIDO (uso unico, CTL-021)')
  })

  it('nonce ausente: rejected NONCE_INVALID e NENHUMA rotacao (CTL-023)', () => {
    const clock = new FakeClock(1_000)
    const confirm = createConfirmService({ now: () => clock.now() })
    let rotacoes = 0
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
      secretos: { rotate: () => { rotacoes += 1; return { display: 'x' } } },
      notificarDono: () => undefined,
    })
    const resposta = responder(intent({ intent: 'secret.rotate', requestId: 'req-sem-nonce' }))
    assert.equal(resposta.type, 'ack')
    assert.deepEqual(resposta, { v: 1, type: 'ack', requestId: 'req-sem-nonce', result: 'rejected', state: 'STOPPED', code: 'NONCE_INVALID' })
    assert.equal(rotacoes, 0, 'sem confirmacao nao ha rotacao')
  })
})