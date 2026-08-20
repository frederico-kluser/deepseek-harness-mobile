/**
 * `src/http/gate.ts` -- a POLITICA do portao, isolada do sitio onde e instalada.
 *
 * Aqui nao ha barreira nem `node:http.Server`: constroi-se o handler guardado
 * com dependencias explicitas e observa-se a decisao.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { IncomingMessage } from 'node:http'

import type { Config } from '../../../src/config/schema.ts'
import { createGuardedHandler, createGuardedUpgradeHandler } from '../../../src/http/gate.ts'
import type { GateDeps } from '../../../src/http/gate.ts'
import { createGuardLogger } from '../../../src/logging/logger.ts'
import { FakeContext, FakeResponse, FakeSocket, makeRequest } from '../../support/ctx-double.ts'
import { makeConfig, VALID_CREDENTIAL, WRONG_CREDENTIAL } from '../../support/fixtures.ts'

interface Bancada {
  ctx: FakeContext
  config: Config
  gate: GateDeps
}

function bancada(overrides: Partial<Config> = {}): Bancada {
  const ctx = new FakeContext()
  const config = makeConfig(overrides)
  const gate: GateDeps = { ctx: ctx.asContext(), log: createGuardLogger(ctx.asContext()), config }
  return { ctx, config, gate }
}

/** Corre um handshake guardado e espera pela decisao assincrona. */
async function runUpgrade(
  handler: (req: IncomingMessage, socket: never, head: Buffer) => void | Promise<void>,
  req: IncomingMessage,
): Promise<FakeSocket> {
  const socket = new FakeSocket()
  await handler(req, socket.asDuplex() as never, Buffer.alloc(0))
  return socket
}

describe('barreira Basic Auth sobre o despacho guardado', () => {
  it('devolve 401 com WWW-Authenticate quando a credencial esta ausente', async () => {
    const { config, gate } = bancada()
    let originalCalled = false

    const handler = createGuardedHandler(gate, (): void => {
      originalCalled = true
    }, 'dispatch:request', true)

    const res = new FakeResponse()
    await handler(makeRequest({ remoteAddress: '127.0.0.1' }), res.asServerResponse())

    assert.equal(res.statusCode, 401)
    assert.equal(res.headers['WWW-Authenticate'], `Basic realm="${config.realm}", charset="UTF-8"`)
    assert.equal(res.ended, true)
    assert.equal(originalCalled, false, 'o handler original NAO pode ser alcancado')
  })

  it('devolve 401 quando a credencial esta errada', async () => {
    const { gate } = bancada()
    let originalCalled = false

    const handler = createGuardedHandler(gate, (): void => {
      originalCalled = true
    }, 'dispatch:request', true)

    const res = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '127.0.0.1', authorization: `Basic ${WRONG_CREDENTIAL}` }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
    assert.equal(originalCalled, false)
  })

  it('deixa passar (pass-through) com a credencial correta', async () => {
    const { gate } = bancada()
    let originalCalled = false

    const handler = createGuardedHandler(gate, (_req, res): void => {
      originalCalled = true
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>SPA</html>')
    }, 'dispatch:request', true)

    const res = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '127.0.0.1', authorization: `Basic ${VALID_CREDENTIAL}` }),
      res.asServerResponse(),
    )

    assert.equal(originalCalled, true)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, '<html>SPA</html>')
  })

  it('aceita o loopback entregue como IPv4 mapeado em IPv6', async () => {
    const { gate } = bancada()
    let originalCalled = false

    const handler = createGuardedHandler(gate, (): void => {
      originalCalled = true
    }, 'dispatch:request', true)

    const res = new FakeResponse()
    await handler(
      makeRequest({
        remoteAddress: '::ffff:127.0.0.1',
        authorization: `Basic ${VALID_CREDENTIAL}`,
      }),
      res.asServerResponse(),
    )

    assert.equal(originalCalled, true)
  })

  it('nao consome o corpo da requisicao ao decidir', async () => {
    const { gate } = bancada()
    const handler = createGuardedHandler(gate, (): void => {}, 'dispatch:request', true)

    // Um `IncomingMessage` sem qualquer API de stream: se o plugin tentasse ler
    // o corpo (`on('data')`, `read()`, `for await`), este teste rebentava.
    const req = {
      method: 'POST',
      url: '/api/commands/execute',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage

    const res = new FakeResponse()
    await handler(req, res.asServerResponse())

    assert.equal(res.statusCode, 401)
  })
})

describe('allowlist de origens remotas no portao', () => {
  it('devolve 403 (e nao 401) a uma origem fora de trustedRemotes', async () => {
    const { gate } = bancada()
    let originalCalled = false

    const handler = createGuardedHandler(gate, (): void => {
      originalCalled = true
    }, 'dispatch:request', true)

    const res = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '10.0.0.7', authorization: `Basic ${VALID_CREDENTIAL}` }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 403)
    assert.equal(res.headers['WWW-Authenticate'], undefined, '403 nao pode desafiar credencial')
    assert.equal(originalCalled, false)
  })

  it('trustedRemotes vazio nega TODA a gente (fail-closed), incluindo o loopback', async () => {
    const { gate } = bancada({ trustedRemotes: [] })
    let originalCalled = false

    const handler = createGuardedHandler(gate, (): void => {
      originalCalled = true
    }, 'dispatch:request', true)

    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.7']) {
      const res = new FakeResponse()
      await handler(
        makeRequest({ remoteAddress, authorization: `Basic ${VALID_CREDENTIAL}` }),
        res.asServerResponse(),
      )
      assert.equal(res.statusCode, 403, `origem ${remoteAddress} devia ser recusada`)
    }

    assert.equal(originalCalled, false)
  })
})

describe('modo por-pedido (alwaysGuarded = false)', () => {
  it('so guarda os caminhos que caem sob guardedPrefixes', async () => {
    // E a forma que a politica por rota do painel /__guard (Onda 3, D5) usa. A
    // barreira de despacho monta-se com `true`; este modo continua exercitado.
    const { gate } = bancada()
    let served = false

    const handler = createGuardedHandler(gate, (_req, res): void => {
      served = true
      res.writeHead(200)
      res.end('spa')
    }, 'rota:/', false)

    const aberto = new FakeResponse()
    await handler(makeRequest({ url: '/index.html' }), aberto.asServerResponse())
    assert.equal(served, true, 'caminho fora do inventario nao pode passar a exigir senha')
    assert.equal(aberto.statusCode, 200)

    served = false
    const guardado = new FakeResponse()
    await handler(
      makeRequest({ method: 'POST', url: '/api/commands/execute', remoteAddress: '127.0.0.1' }),
      guardado.asServerResponse(),
    )
    assert.equal(guardado.statusCode, 401)
    assert.equal(served, false)
  })
})

describe('cascata http/auth-check', () => {
  it('o next TERMINAL repete a verificacao: fail-closed sem qualquer ouvinte', async () => {
    const { ctx, gate } = bancada()
    assert.equal(ctx.listeners.size, 0, 'esta bancada nao regista ouvintes')

    const handler = createGuardedHandler(gate, (_req, res): void => {
      res.writeHead(200)
      res.end('ok')
    }, 'dispatch:request', true)

    const semCredencial = new FakeResponse()
    await handler(makeRequest({ remoteAddress: '127.0.0.1' }), semCredencial.asServerResponse())
    assert.equal(semCredencial.statusCode, 401)

    const comCredencial = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '127.0.0.1', authorization: `Basic ${VALID_CREDENTIAL}` }),
      comCredencial.asServerResponse(),
    )
    assert.equal(comCredencial.statusCode, 200)
  })

  it('um ouvinte externo pode vetar mesmo com credencial valida', async () => {
    const { ctx, gate } = bancada()
    ctx.on('http/auth-check', async (): Promise<boolean> => false)

    const handler = createGuardedHandler(gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request', true)

    const res = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '127.0.0.1', authorization: `Basic ${VALID_CREDENTIAL}` }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
  })
})

describe('handshake de upgrade guardado (achado B-MEDIUM)', () => {
  it('recusa o handshake sem credencial com 401 escrito no socket cru', async () => {
    const { config, gate } = bancada()
    let handshakeFeito = false

    const handler = createGuardedUpgradeHandler(gate, (): void => {
      handshakeFeito = true
    }, 'dispatch:upgrade')

    const socket = await runUpgrade(handler, makeRequest({ url: '/ws', remoteAddress: '127.0.0.1' }))

    assert.equal(handshakeFeito, false, 'o WebSocket NAO pode ser estabelecido sem credencial')
    assert.equal(socket.written.startsWith('HTTP/1.1 401 Unauthorized\r\n'), true, socket.written)
    assert.equal(socket.written.includes(`WWW-Authenticate: Basic realm="${config.realm}"`), true)
    assert.equal(
      socket.written.endsWith('\r\n\r\n'),
      true,
      'a resposta crua precisa da linha em branco',
    )
    assert.equal(socket.destroyed, true)
  })

  it('recusa com 403 (sem desafio) uma origem fora de trustedRemotes', async () => {
    const { gate } = bancada()

    const handler = createGuardedUpgradeHandler(gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:upgrade')

    const socket = await runUpgrade(
      handler,
      makeRequest({
        url: '/ws',
        remoteAddress: '10.0.0.7',
        authorization: `Basic ${VALID_CREDENTIAL}`,
      }),
    )

    assert.equal(socket.written.startsWith('HTTP/1.1 403 Forbidden\r\n'), true, socket.written)
    assert.equal(socket.written.includes('WWW-Authenticate'), false, '403 nao desafia credencial')
    assert.equal(socket.destroyed, true)
  })

  it('deixa passar o handshake com credencial valida, com head e socket intactos', async () => {
    const { gate } = bancada()
    const recebido: { url: string | undefined; head: number | undefined } = {
      url: undefined,
      head: undefined,
    }

    const handler = createGuardedUpgradeHandler(gate, (req, _socket, head): void => {
      recebido.url = req.url
      recebido.head = head.byteLength
    }, 'dispatch:upgrade')

    const socket = await runUpgrade(
      handler,
      makeRequest({
        url: '/ws',
        remoteAddress: '127.0.0.1',
        authorization: `Basic ${VALID_CREDENTIAL}`,
      }),
    )

    assert.equal(recebido.url, '/ws')
    assert.equal(recebido.head, 0)
    assert.equal(socket.destroyed, false, 'o handshake aprovado nao pode destruir o socket')
    assert.equal(socket.written, '')
  })

  it('um erro no caminho de decisao destroi o socket (fail-closed) e nao rejeita', async () => {
    const { ctx, gate } = bancada()
    ctx.on('http/auth-check', async (): Promise<boolean> => {
      throw new Error('ouvinte de terceiro rebentou')
    })

    const handler = createGuardedUpgradeHandler(gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:upgrade')

    const socket = await runUpgrade(
      handler,
      makeRequest({
        url: '/ws',
        remoteAddress: '127.0.0.1',
        authorization: `Basic ${VALID_CREDENTIAL}`,
      }),
    )

    assert.equal(socket.destroyed, true)
    assert.equal(ctx.logger.has('error', 'socket destruido'), true)
  })
})
