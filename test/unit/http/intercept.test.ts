/**
 * `src/http/intercept.ts` -- a MECANICA da barreira: posse do despacho, recusa
 * de empilhamento, reversao exata e fail-closed.
 *
 * O `node:http.Server` aqui e REAL (nunca posto a escutar): e exatamente o
 * objeto cujo despacho a barreira troca. Dublar o `EventEmitter` seria dublar o
 * que esta sob teste. O comportamento ponta a ponta, com sockets reais, esta em
 * `test/integration/http/barreira.test.ts`.
 */

import assert from 'node:assert/strict'
import { Server } from 'node:http'
import { describe, it } from 'node:test'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { GuardError } from '../../../src/errors.ts'
import { BARRIER_OWNER_MARK, installAuthBarrier } from '../../../src/http/intercept.ts'
import { createGuardLogger, type GuardLogger } from '../../../src/logging/logger.ts'
import { FakeContext, FakeResponse, FakeSocket, makeRequest } from '../../support/ctx-double.ts'
import { flush } from '../../support/fixtures.ts'

function log(): GuardLogger {
  return createGuardLogger(new FakeContext().asContext())
}

/** Envelopes triviais: deixam passar tudo. Isolam a mecanica da politica. */
const passthrough = {
  wrapRequest:
    (delegate: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => delegate,
  wrapUpgrade:
    (delegate: (req: IncomingMessage, s: Duplex, h: Buffer) => void | Promise<void>) => delegate,
}

describe('posse do despacho', () => {
  it('substitui os listeners por UM listener marcado como nosso', () => {
    const server = new Server()
    server.on('request', () => {})
    server.on('upgrade', () => {})

    const dispose = installAuthBarrier(server, passthrough, log())

    assert.equal(server.listenerCount('request'), 1)
    assert.equal(server.listenerCount('upgrade'), 1)
    const installed = server.listeners('request')[0] as unknown as Record<symbol, unknown>
    assert.equal(installed[BARRIER_OWNER_MARK], true, 'a marca de posse e obrigatoria')

    dispose()
  })

  it('RECUSA uma segunda barreira no mesmo servidor', () => {
    const server = new Server()
    server.on('request', () => {})

    const dispose = installAuthBarrier(server, passthrough, log())

    assert.throws(
      () => installAuthBarrier(server, passthrough, log()),
      (error: unknown) =>
        error instanceof GuardError && error.code === 'BARRIER_ALREADY_INSTALLED',
    )
    assert.equal(server.listenerCount('request'), 1, 'a recusa nao pode deixar residuo')

    dispose()
  })

  it('FALHA ALTO quando o servidor ainda nao tem despacho de request', () => {
    const server = new Server()

    assert.throws(
      () => installAuthBarrier(server, passthrough, log()),
      (error: unknown) => error instanceof GuardError && error.code === 'BARRIER_UNAVAILABLE',
      'nunca degradar para "sem barreira"',
    )
  })
})

describe('reversao', () => {
  it('reinstala EXATAMENTE os listeners originais, por identidade e ordem', () => {
    const server = new Server()
    const primeiro = (): void => {}
    const segundo = (): void => {}
    const upgrade = (): void => {}
    server.on('request', primeiro)
    server.on('request', segundo)
    server.on('upgrade', upgrade)

    const dispose = installAuthBarrier(server, passthrough, log())
    assert.equal(server.listenerCount('request'), 1)

    dispose()

    assert.deepEqual(server.listeners('request'), [primeiro, segundo])
    assert.deepEqual(server.listeners('upgrade'), [upgrade])
  })

  it('e idempotente: chamar o disposer 3x nao duplica os originais', () => {
    const server = new Server()
    const original = (): void => {}
    server.on('request', original)

    const dispose = installAuthBarrier(server, passthrough, log())
    dispose()
    dispose()
    dispose()

    assert.deepEqual(server.listeners('request'), [original])
  })

  it('NAO restaura por cima de outro dono: falha alto e nao duplica o despacho', () => {
    const server = new Server()
    const original = (): void => {}
    server.on('request', original)

    const dispose = installAuthBarrier(server, passthrough, log())

    // Um terceiro toma o despacho ignorando a marca de posse.
    const terceiro = (): void => {}
    server.removeAllListeners('request')
    server.on('request', terceiro)

    assert.throws(
      () => dispose(),
      (error: unknown) => error instanceof GuardError && error.code === 'BARRIER_OWNERSHIP_LOST',
    )

    // O modo de falha que isto evita: dois despachos a responder ao mesmo `res`,
    // que levanta ERR_HTTP_HEADERS_SENT nao capturavel e derruba o processo.
    assert.deepEqual(server.listeners('request'), [terceiro], 'sem duplicacao de despacho')
  })
})

describe('semantica de upgrade', () => {
  it('NAO instala listener de upgrade num servidor que nao tinha nenhum', () => {
    // Medido no Node 24: com ZERO listeners de `upgrade` o pedido cai no caminho
    // `request` (que a barreira ja guarda). Instalar um mudaria a semantica do
    // servidor e penduraria um upgrade autorizado numa delegacao vazia.
    const server = new Server()
    server.on('request', () => {})

    const dispose = installAuthBarrier(server, passthrough, log())

    assert.equal(server.listenerCount('upgrade'), 0)

    dispose()
    assert.equal(server.listenerCount('upgrade'), 0)
  })
})

describe('fail-closed do despacho assincrono', () => {
  it('uma rejeicao da politica vira 500 em vez de unhandledRejection', async () => {
    const server = new Server()
    server.on('request', () => {
      throw new Error('o despacho original NAO pode ser alcancado')
    })

    const dispose = installAuthBarrier(
      server,
      {
        wrapRequest: () => async (): Promise<void> => {
          throw new Error('politica rebentou')
        },
        wrapUpgrade: (delegate) => delegate,
      },
      log(),
    )

    const res = new FakeResponse()
    server.emit('request', makeRequest(), res.asServerResponse())
    await flush()

    assert.equal(res.statusCode, 500)
    assert.equal(res.ended, true)

    dispose()
  })

  it('uma rejeicao no caminho de upgrade destroi o socket', async () => {
    const server = new Server()
    server.on('request', () => {})
    server.on('upgrade', () => {
      throw new Error('o despacho original NAO pode ser alcancado')
    })

    const dispose = installAuthBarrier(
      server,
      {
        wrapRequest: (delegate) => delegate,
        wrapUpgrade: () => async (): Promise<void> => {
          throw new Error('politica rebentou')
        },
      },
      log(),
    )

    const socket = new FakeSocket()
    server.emit('upgrade', makeRequest(), socket.asDuplex(), Buffer.alloc(0))
    await flush()

    assert.equal(socket.destroyed, true)

    dispose()
  })
})
