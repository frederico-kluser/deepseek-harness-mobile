/**
 * Item 5 (costura) + ONDA 2 (expose-port): session.issue (/acessar) e
 * secret.rotate (/rotacionar) no responder do HOST — o LINK DA CHAVE DE ACESSO
 * (`LinkTokenStore`, `https://<url>?key=<token>`) e a rotacao com nonce
 * consumido no HOST, SEM a senha a sair pelo chat (S3/Q-4). O /rotacionar
 * REVOGA a chave anterior (a rotacao do segredo de `src/index.ts` fecha
 * `revogar()`; aqui simulamos essa ligacao no stub dos `secretos`).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { IpcIntentMessage } from '../../../src/contracts/ipc.ts'
import { createConfirmService } from '../../../src/control/confirm.ts'
import { createTunnelController } from '../../../src/control/controller.ts'
import { criarRespondedorIpc } from '../../../src/control/surface-ipc.ts'
import type { TunnelSnapshot } from '../../../src/contracts/tunnel.ts'
import type { TunnelSupervisor } from '../../../src/tunnel/supervisor.ts'
import { createLinkTokenStore } from '../../../src/session/link-token.ts'
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

describe('session.issue — o link da CHAVE DE ACESSO (onda 2, TG-085)', () => {
  it('com o tunel READY: emite a chave, compoe ?key= e notifica; ack accepted INVISIVEL', () => {
    const clock = new FakeClock(1_000)
    const supervisor = new SupervisorDuble()
    supervisor.definirObservado({
      state: 'READY',
      info: { url: 'https://x.trycloudflare.com', startedAt: 1_000, mode: 'quick' },
      attempts: 0,
      expiresAt: 5_000,
    })
    const notificacoes: string[] = []
    const linkToken = createLinkTokenStore({
      clock: { now: () => clock.now() },
      randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    })
    const montado = controladorRead(supervisor)
    const confirmacao = montado.controlador.emitirNonce('start')
    return (async () => {
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
        linkToken,
        notificarDono: (texto) => void notificacoes.push(texto),
      })

      const resposta = responder(intent())
      assert.equal(resposta.type, 'ack')
      assert.equal((resposta as { result?: string }).result, 'accepted')
      assert.equal(notificacoes.length, 1)
      const texto = notificacoes[0] ?? ''
      assert.match(texto, /alerta:link-magico/u, 'o marcador do link (T5.4)')
      assert.match(texto, /x\.trycloudflare\.com\?key=/u, 'a URL do tunel com a chave na QUERY')
      // O token viaja 1x e e REUTILIZAVEL ate a rotacao do segredo.
      const chave = /[?&]key=([A-Za-z2-7=]+)/u.exec(texto)?.[1]
      assert.ok(chave !== undefined, 'o token de link esta no query')
      assert.equal(linkToken.verificar(chave), true, 'a chave emitida e aceite pelo portao')
      assert.ok(!texto.includes('#mk='), 'NAO usa mais o fragmento #mk=')
      assert.match(texto, /sem senha/u, 'o texto diz que entra sem senha')
    })()
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
      linkToken: createLinkTokenStore({ clock: { now: () => clock.now() } }),
      notificarDono: () => undefined,
    })
    const resposta = responder(intent({ requestId: 'req-off' }))
    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { code?: string }).code, 'INTERNAL')
  })

  it('sem chave fiada (o estado de antes da costura), INTERNAL fail-closed', () => {
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
    const resposta = responder(intent({ requestId: 'req-sem-chave' }))
    assert.equal(resposta.type, 'error')
    assert.equal((resposta as { code?: string }).code, 'INTERNAL')
  })
})

describe('secret.rotate — nonce consumido no HOST, senha nunca pelo chat (item 5)', () => {
  it('com nonce valido: regera, REVOGA a chave anterior e NOTIFICA sem a senha', () => {
    const clock = new FakeClock(1_000)
    const confirm = createConfirmService({
      now: () => clock.now(),
      randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    })
    const rotacoes: string[] = []
    const notificacoes: string[] = []
    // A Onda 1 fia em `src/index.ts`: a rotacao do segredo chama `revogar()` do
    // link-store alem de regenerar o segredo. Aqui simulamos essa ligacao no
    // stub dos `secretos` para poder asserir que a chave anterior morre.
    const linkToken = createLinkTokenStore({
      clock: { now: () => clock.now() },
      randomBytes: () => Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 9, 8, 7, 6, 5, 4]),
    })
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
          linkToken.revogar()
          return { display: 'A SENHA EM CLARO' }
        },
      },
      notificarDono: (texto) => void notificacoes.push(texto),
    })
    const nonce = confirm.issue('reset').valor
    // Antes da rotacao, emite uma chave e confirma que e valida.
    const chaveAntiga = linkToken.emitir().token
    assert.equal(linkToken.verificar(chaveAntiga), true, 'a chave valida antes da rotacao')

    const resposta = responder(intent({ intent: 'secret.rotate', requestId: 'req-rotate', nonce }))
    assert.equal(resposta.type, 'ack')
    assert.equal((resposta as { result?: string }).result, 'accepted')
    assert.equal(rotacoes.length, 1, 'o segredo foi regenerado')
    assert.equal(linkToken.verificar(chaveAntiga), false, 'a chave ANTERIOR foi revogada (SECRET-008)')
    assert.equal(notificacoes.length, 1)
    const texto = notificacoes[0] ?? ''
    assert.ok(!texto.includes('A SENHA EM CLARO'), 'a senha NUNCA sai pelo chat (S3/Q-4)')
    assert.match(texto, /chave/i, 'o texto fala da chave de acesso, nao da senha')
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