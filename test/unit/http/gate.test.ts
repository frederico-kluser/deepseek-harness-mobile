/**
 * `src/http/gate.ts` -- a POLITICA da superficie do TUNEL (modelo expose-port).
 *
 * ONDA 1 (remocao do login) -> MODELO EXPOSE-PORT (correccao do BLOCK).
 *
 * O gate JA NAO decide "abrir" por `Host` de loopback: ele corre no PROXY do
 * tunel (`src/tunnel/proxy.ts`), onde todo o pedido veio do cloudflared e por
 * isso tem de autenticar. NEM MESMO um `Host: 127.0.0.1:3080` FORJADO abre --
 * ele passa L2/L2.5 e morre AQUI em L3 (401 sem `WWW-Authenticate`).
 *
 * A superficie do DSH (upstream) NAO tem gate; eso e coberto em
 * `test/unit/tunnel/proxy.test.ts` (proxy vs upstream).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, describe, it } from 'node:test'

import type { IncomingMessage } from 'node:http'

import { AuditWriteError } from '../../../src/audit/log.ts'
import type { AuditEvent } from '../../../src/contracts/auth.ts'
import { createGuardedHandler, createGuardedUpgradeHandler, type GateDeps } from '../../../src/http/gate.ts'
import { FakeResponse, FakeSocket } from '../../support/ctx-double.ts'
import { VALID_CREDENTIAL, WRONG_CREDENTIAL } from '../../support/fixtures.ts'
import {
  bancada,
  basic,
  pedido,
  FAKE_TUNNEL_ORIGIN,
  OWNER_SECRET,
  type Bancada,
} from './bancada.ts'

let aberta: Bancada | undefined

function abrir(...args: Parameters<typeof bancada>): Bancada {
  aberta = bancada(...args)
  return aberta
}

afterEach(() => {
  aberta?.cleanup()
  aberta = undefined
})

function hostDoTunel(): string {
  return new URL(FAKE_TUNNEL_ORIGIN).host
}

/** Um pedido que CHEGA PELO TUNEL. */
function pedidoTunel(spec: Parameters<typeof pedido>[0] = {}): IncomingMessage {
  return pedido({ ...spec, headers: { host: hostDoTunel(), ...spec.headers } })
}

/** Bancada para o fluxo `?key=` (origem https para o cookie Secure). */
function abrirTunelComBorda(...args: Parameters<typeof bancada>): Bancada {
  const base = args[0] ?? {}
  return abrir({
    ...base,
    tunnelReady: true,
    config: {
      exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: false },
      ...(base.config ?? {}),
    },
  })
}

function comAuditoriaAvariada(b: Bancada): GateDeps {
  return {
    ...b.gate,
    auth: () => ({
      ...b.stack.auth,
      audit: {
        append(_event: AuditEvent): void {
          throw new AuditWriteError('disco cheio', 1, '/nao/apresentavel/audit.log')
        },
      },
    }),
  }
}

async function runUpgrade(
  handler: (req: IncomingMessage, socket: never, head: Buffer) => void | Promise<void>,
  req: IncomingMessage,
): Promise<FakeSocket> {
  const socket = new FakeSocket()
  await handler(req, socket.asDuplex() as never, Buffer.alloc(0))
  return socket
}

describe('superficie do TUNEL: NUNCA abre por Host -- nem loopback forjado (BLOCK)', () => {
  it('Host: 127.0.0.1:3080 FORJADO, sem credencial -> 401 (nao 200)', async () => {
    // O furo que o revisor reproduziu: pedido pelo cloudflared (socket
    // trustedRemote) com `Host` de loopback passava a regra "local" e abria.
    const b = abrir({ tunnelReady: true })
    let originalCalled = false
    const handler = createGuardedHandler(b.gate, (): void => {
      originalCalled = true
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(
      pedido({ url: '/', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3080' } }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401, 'o Host de loopback forjado NAO abre a superficie do tunel')
    assert.equal(res.headers['WWW-Authenticate'], undefined)
    assert.equal(originalCalled, false)
  })

  it('sem sessao e sem chave -> 401 TEXTO PURO, SEM WWW-Authenticate', async () => {
    const b = abrir({ tunnelReady: true })
    let originalCalled = false
    const handler = createGuardedHandler(b.gate, (): void => {
      originalCalled = true
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(pedidoTunel(), res.asServerResponse())

    assert.equal(res.statusCode, 401)
    assert.equal(res.headers['WWW-Authenticate'], undefined, 'o popup foi removido')
    assert.equal(res.headers['Content-Type'], 'text/plain; charset=utf-8')
    assert.equal(originalCalled, false)
  })

  it('uma SESSAO valida deixa passar (o delegate original corre)', async () => {
    const b = abrir({ tunnelReady: true })
    const cookie = b.emitirSessao()
    let served = false
    const handler = createGuardedHandler(b.gate, (): void => {
      served = true
    }, 'dispatch:request')

    await handler(pedidoTunel({ headers: { cookie } }), new FakeResponse().asServerResponse())
    assert.equal(served, true)
  })

  it('?key= VALIDA -> 302 para a URL LIMPA + Set-Cookie, e a chave e REUTILIZAVEL', async () => {
    const b = abrirTunelComBorda()
    const { token } = b.linkStore.emitir()
    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')

    const res = new FakeResponse()
    await handler(pedidoTunel({ url: `/?key=${token}`, headers: { 'x-forwarded-proto': 'https' } }), res.asServerResponse())

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers['Location'], '/')
    assert.ok((res.headers['Set-Cookie'] ?? '').startsWith('__Host-dsh_sid='))
    assert.equal(res.headers['WWW-Authenticate'], undefined)

    const cookie = String(res.headers['Set-Cookie']).slice('__Host-dsh_sid='.length).split(';')[0]
    let served = false
    await createGuardedHandler(b.gate, (): void => {
      served = true
    }, 'dispatch:request')(
      pedidoTunel({ headers: { cookie: `__Host-dsh_sid=${cookie}` } }),
      new FakeResponse().asServerResponse(),
    )
    assert.equal(served, true, 'a sessao emitida pelo link autoriza')
    assert.equal(b.linkStore.verificar(token), true, 'a chave e reutilizavel')
  })

  it('?key= valida NUNCA loga o token em claro (HIGH #2)', async () => {
    const b = abrirTunelComBorda()
    const { token } = b.linkStore.emitir()
    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')

    await handler(pedidoTunel({ url: `/?key=${token}`, headers: { 'x-forwarded-proto': 'https' } }), new FakeResponse().asServerResponse())

    // O log capturado pela bancada nao pode conter o valor do token (256 bits).
    const tudo = b.ctx.logger.entries.map((e) => e.message).join('\n')
    assert.equal(tudo.includes(token), false, 'o token viajou para o log')
    assert.equal(tudo.includes('key='), false, 'a forma ?key= nao aparece em nenhum log')
  })

  it('?key= INVALIDA -> 401, sem 302 e sem desafio', async () => {
    const b = abrir({ tunnelReady: true })
    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')
    const res = new FakeResponse()
    await handler(pedidoTunel({ url: '/?key=not-a-token', headers: { 'x-forwarded-proto': 'https' } }), res.asServerResponse())
    assert.equal(res.statusCode, 401)
    assert.equal(res.headers['Location'], undefined)
    assert.equal(res.headers['WWW-Authenticate'], undefined)
  })

  it('a credencial estatica do manifesto continua a autenticar pelo tunel', async () => {
    const b = abrir({ tunnelReady: true })
    let served = false
    const handler = createGuardedHandler(b.gate, (): void => {
      served = true
    }, 'dispatch:request')
    await handler(
      pedidoTunel({ headers: { authorization: `Basic ${VALID_CREDENTIAL}` } }),
      new FakeResponse().asServerResponse(),
    )
    assert.equal(served, true)
  })

  it('credencial errada pelo tunel e 401 sem desafio', async () => {
    const b = abrir({ tunnelReady: true })
    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')
    const res = new FakeResponse()
    await handler(
      pedidoTunel({ headers: { authorization: `Basic ${WRONG_CREDENTIAL}` } }),
      res.asServerResponse(),
    )
    assert.equal(res.statusCode, 401)
    assert.equal(res.headers['WWW-Authenticate'], undefined)
  })
})

describe('a ordem 403-antes-de-401 e contrato', () => {
  it('devolve 403 a uma origem fora de trustedRemotes', async () => {
    const b = abrir({ tunnelReady: true })
    const handler = createGuardedHandler(b.gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request')
    const res = new FakeResponse()
    await handler(pedidoTunel({ remoteAddress: '10.0.0.7' }), res.asServerResponse())
    assert.equal(res.statusCode, 403)
    assert.equal(res.headers['WWW-Authenticate'], undefined)
  })

  it('trustedRemotes vazio nega TODA a gente (fail-closed), incluindo o loopback', async () => {
    const b = abrir({ config: { trustedRemotes: [] } })
    const handler = createGuardedHandler(b.gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request')
    const res = new FakeResponse()
    await handler(pedido({ remoteAddress: '127.0.0.1' }), res.asServerResponse())
    assert.equal(res.statusCode, 403)
  })
})

describe('cascata http/auth-check', () => {
  it('o next TERMINAL entrega a decisao: tunel sem sessao NEGA (401), com sessao passa', async () => {
    const b = abrir({ tunnelReady: true })
    const handler = createGuardedHandler(b.gate, (_req, res): void => {
      res.writeHead(200)
      res.end('ok')
    }, 'dispatch:request')

    const sem = new FakeResponse()
    await handler(pedidoTunel(), sem.asServerResponse())
    assert.equal(sem.statusCode, 401)

    const cookie = b.emitirSessao()
    const com = new FakeResponse()
    await handler(pedidoTunel({ headers: { cookie } }), com.asServerResponse())
    assert.equal(com.statusCode, 200)
  })

  it('um ouvinte externo pode vetar um pedido do tunel mesmo com sessao', async () => {
    const b = abrir({ tunnelReady: true })
    const cookie = b.emitirSessao()
    b.ctx.on('http/auth-check', async (): Promise<boolean> => false)
    const handler = createGuardedHandler(b.gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request')
    const res = new FakeResponse()
    await handler(pedidoTunel({ headers: { cookie } }), res.asServerResponse())
    assert.equal(res.statusCode, 401)
  })
})

describe('auditoria fail-closed e o 401 UNICO (D9)', () => {
  it('AuditWriteError vira o MESMO 401 de credencial errada, byte a byte', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    const erradaRes = new FakeResponse()
    await createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')(
      pedidoTunel({ headers: { authorization: basic('senha-errada') } }),
      erradaRes.asServerResponse(),
    )

    const discoCheio = new FakeResponse()
    await createGuardedHandler(comAuditoriaAvariada(b), (): void => {}, 'dispatch:request')(
      pedidoTunel({ headers: { authorization: basic(OWNER_SECRET) } }),
      discoCheio.asServerResponse(),
    )
    assert.equal(erradaRes.statusCode, 401)
    assert.equal(discoCheio.statusCode, 401)
    assert.deepEqual(discoCheio.headers, erradaRes.headers)
    assert.equal(discoCheio.body, erradaRes.body)
  })

  it('regista no ficheiro de auditoria a tentativa aceite e a recusada', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')
    await handler(pedidoTunel({ headers: { authorization: basic(OWNER_SECRET) } }), new FakeResponse().asServerResponse())
    await handler(pedidoTunel({ headers: { authorization: basic('nao-e-esta') } }), new FakeResponse().asServerResponse())
    const linhas = readFileSync(b.auditPath, 'utf8').trim().split('\n')
    assert.equal(linhas.length, 2)
    assert.equal(linhas[0]?.includes('"resultado":"permitido"'), true)
    assert.equal(linhas[1]?.includes('"resultado":"negado"'), true)
    assert.equal(readFileSync(b.auditPath, 'utf8').includes(OWNER_SECRET), false)
  })
})

describe('modo restrito', () => {
  it('recusa a CHAVE no link vinda do tunel em modo restrito', async () => {
    const b = abrir({ tunnelReady: true })
    const { token } = b.linkStore.emitir()
    b.stack.state.update((p) => ({ ...p, restricted: { since: 1, reason: 'brute-force-ceiling' } }))
    b.stack.restricted.reload()
    const res = new FakeResponse()
    await createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')(
      pedidoTunel({ url: `/?key=${token}`, headers: { 'x-forwarded-proto': 'https' } }),
      res.asServerResponse(),
    )
    assert.equal(res.statusCode, 401, 'em modo restrito a chave do tunel nao autentica')
  })

  it('recusa tambem a SESSAO vinda do tunel', async () => {
    const b = abrir({ tunnelReady: true })
    const cookie = b.emitirSessao()
    b.stack.state.update((p) => ({ ...p, restricted: { since: 1, reason: 'brute-force-ceiling' } }))
    b.stack.restricted.reload()
    const res = new FakeResponse()
    await createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')(
      pedidoTunel({ headers: { cookie } }),
      res.asServerResponse(),
    )
    assert.equal(res.statusCode, 401)
  })
})

describe('a landmine do tunel: reescrita de Host APOS autenticar', () => {
  it('apaga a cerca de borda do nucleo so no pedido APROVADO do tunel', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    const visto: Record<string, string | string[] | undefined> = {}
    await createGuardedHandler(b.gate, (req): void => {
      Object.assign(visto, req.headers)
    }, 'dispatch:request')(
      pedidoTunel({ url: '/api/state', headers: { origin: FAKE_TUNNEL_ORIGIN, authorization: basic(OWNER_SECRET) } }),
      new FakeResponse().asServerResponse(),
    )
    assert.equal(visto['origin'], undefined)
    assert.equal(visto['sec-fetch-site'], undefined)
  })
})

describe('handshake de upgrade guardado (B-MEDIUM)', () => {
  it('recusa o handshake do tunel sem sessao com 401 no socket cru e SEM desafio', async () => {
    const b = abrir({ tunnelReady: true })
    let handshakeFeito = false
    const socket = await runUpgrade(
      createGuardedUpgradeHandler(b.gate, (): void => {
        handshakeFeito = true
      }, 'dispatch:upgrade'),
      pedidoTunel({ url: '/ws' }),
    )
    assert.equal(handshakeFeito, false)
    assert.equal(socket.written.startsWith('HTTP/1.1 401 Unauthorized\r\n'), true)
    assert.equal(socket.written.includes('WWW-Authenticate'), false)
    assert.equal(socket.destroyed, true)
  })

  it('mesmo com Host de loopback FORJADO, o handshake do tunel recusa sem sessao (BLOCK)', async () => {
    const b = abrir({ tunnelReady: true })
    const socket = await runUpgrade(
      createGuardedUpgradeHandler(b.gate, (): void => {}, 'dispatch:upgrade'),
      pedido({ url: '/ws', headers: { host: '127.0.0.1:3080' } }),
    )
    assert.equal(socket.written.startsWith('HTTP/1.1 401 Unauthorized\r\n'), true)
    assert.equal(socket.written.includes('WWW-Authenticate'), false)
  })

  it('o handshake do tunel com sessao valida passa, com head e socket intactos', async () => {
    const b = abrir({ tunnelReady: true })
    const cookie = b.emitirSessao()
    const recebido: { url: string | undefined; head: number | undefined } = { url: undefined, head: undefined }
    const socket = await runUpgrade(
      createGuardedUpgradeHandler(b.gate, (req, _s, head): void => {
        recebido.url = req.url
        recebido.head = head.byteLength
      }, 'dispatch:upgrade'),
      pedidoTunel({ url: '/ws', headers: { origin: FAKE_TUNNEL_ORIGIN, cookie } }),
    )
    assert.equal(recebido.url, '/ws')
    assert.equal(socket.destroyed, false)
  })

  it('um erro no caminho de decisao do tunel destroi o socket (fail-closed)', async () => {
    const b = abrir({ tunnelReady: true })
    const cookie = b.emitirSessao()
    b.ctx.on('http/auth-check', async (): Promise<boolean> => {
      throw new Error('ouvinte rebentou')
    })
    const socket = await runUpgrade(
      createGuardedUpgradeHandler(b.gate, (): void => {}, 'dispatch:upgrade'),
      pedidoTunel({ url: '/ws', headers: { cookie } }),
    )
    assert.equal(socket.destroyed, true)
  })
})

describe('nenhum handler do portao emite WWW-Authenticate', () => {
  it('401/403 do tunel e 401/403 do upgrade nao desafiam', async () => {
    const b = abrir({ tunnelReady: true })
    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')
    const resps: FakeResponse[] = []
    for (const req of [
      pedidoTunel({}),
      pedidoTunel({ url: '/?key=xxxx' }),
      pedidoTunel({ remoteAddress: '10.0.0.7' }),
      pedido({ url: '/', headers: { host: 'evil.com' } }),
    ]) {
      const r = new FakeResponse()
      await handler(req, r.asServerResponse())
      resps.push(r)
    }
    for (const res of resps) {
      assert.equal(res.headers['WWW-Authenticate'], undefined)
    }

    const socket = await runUpgrade(
      createGuardedUpgradeHandler(b.gate, (): void => {}, 'dispatch:upgrade'),
      pedidoTunel({ url: '/ws' }),
    )
    assert.equal(socket.written.includes('WWW-Authenticate'), false)
  })
})