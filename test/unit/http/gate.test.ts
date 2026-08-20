/**
 * `src/http/gate.ts` -- a POLITICA do portao, isolada do sitio onde e instalada.
 *
 * Aqui nao ha barreira nem `node:http.Server`: constroi-se o handler guardado
 * com dependencias explicitas e observa-se a decisao. As primitivas da Onda 2
 * sao REAIS (estado, sessoes, segredo, limitador, auditoria) sobre um diretorio
 * descartavel -- dublar o que esta sob teste nao provaria a fiacao.
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

/** Qualquer toque no stream do corpo levanta -- ver o teste que a usa. */
function proibido(nome: string): () => never {
  return (): never => {
    throw new Error(`o portao consumiu o corpo da requisicao (${nome})`)
  }
}

/** Substitui o sink de auditoria por um que falha como um disco cheio. */
function comAuditoriaAvariada(b: Bancada): GateDeps {
  return {
    ...b.gate,
    auth: () => ({
      ...b.stack.auth,
      audit: {
        append(_event: AuditEvent): void {
          throw new AuditWriteError(
            'nao foi possivel registar a auditoria — o gate TEM de negar (fail-closed). ' +
              'Registos perdidos nesta janela: 1.',
            1,
            '/caminho/que/nao/pode/aparecer/no/corpo/audit.log',
          )
        },
      },
    }),
  }
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

describe('barreira de autenticacao sobre o despacho guardado', () => {
  it('devolve 401 com WWW-Authenticate quando a credencial esta ausente', async () => {
    const b = abrir()
    let originalCalled = false

    const handler = createGuardedHandler(b.gate, (): void => {
      originalCalled = true
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(pedido(), res.asServerResponse())

    assert.equal(res.statusCode, 401)
    assert.equal(res.headers['WWW-Authenticate'], `Basic realm="${b.config.realm}", charset="UTF-8"`)
    assert.equal(res.ended, true)
    assert.equal(originalCalled, false, 'o handler original NAO pode ser alcancado')
  })

  it('devolve 401 quando a credencial esta errada', async () => {
    const b = abrir()
    let originalCalled = false

    const handler = createGuardedHandler(b.gate, (): void => {
      originalCalled = true
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(
      pedido({ headers: { authorization: `Basic ${WRONG_CREDENTIAL}` } }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
    assert.equal(originalCalled, false)
  })

  it('deixa passar (pass-through) com a credencial estatica correta', async () => {
    const b = abrir()
    let originalCalled = false

    const handler = createGuardedHandler(b.gate, (_req, res): void => {
      originalCalled = true
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>SPA</html>')
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(
      pedido({ headers: { authorization: `Basic ${VALID_CREDENTIAL}` } }),
      res.asServerResponse(),
    )

    assert.equal(originalCalled, true)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, '<html>SPA</html>')
  })

  it('deixa passar com o SEGREDO gerado pelo plugin (sem encodedAuthString)', async () => {
    // E o caminho normal do produto: D19 tirou a credencial do manifesto e o
    // segredo passou a ser gerado por CSPRNG, com so o digest em disco.
    const b = abrir({ comSegredo: true, semCredencialEstatica: true })
    let served = false

    const handler = createGuardedHandler(b.gate, (): void => {
      served = true
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(
      pedido({ headers: { authorization: basic(OWNER_SECRET) } }),
      res.asServerResponse(),
    )

    assert.equal(served, true, 'o segredo do dono tem de autenticar')
    assert.equal(res.statusCode, undefined)
  })

  it('aceita o loopback entregue como IPv4 mapeado em IPv6', async () => {
    const b = abrir()
    let originalCalled = false

    const handler = createGuardedHandler(b.gate, (): void => {
      originalCalled = true
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(
      pedido({
        remoteAddress: '::ffff:127.0.0.1',
        headers: { authorization: `Basic ${VALID_CREDENTIAL}` },
      }),
      res.asServerResponse(),
    )

    assert.equal(originalCalled, true)
  })

  it('NAO consome o corpo da requisicao ao decidir', async () => {
    const b = abrir()
    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')

    // Um `IncomingMessage` que EXPLODE se alguem lhe tocar no stream. O portao
    // decide por metodo, URL, cabecalhos e socket -- e por mais nada.
    const req = {
      method: 'POST',
      url: '/api/commands/execute',
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
      on: proibido('on'),
      once: proibido('once'),
      read: proibido('read'),
      pipe: proibido('pipe'),
      setEncoding: proibido('setEncoding'),
      resume: proibido('resume'),
      [Symbol.asyncIterator]: proibido('asyncIterator'),
    } as unknown as IncomingMessage

    const res = new FakeResponse()
    await handler(req, res.asServerResponse())

    assert.equal(res.statusCode, 401)
  })
})

describe('a ordem 403-antes-de-401 e contrato', () => {
  it('devolve 403 (e nao 401) a uma origem fora de trustedRemotes', async () => {
    const b = abrir()
    let originalCalled = false

    const handler = createGuardedHandler(b.gate, (): void => {
      originalCalled = true
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(
      pedido({ remoteAddress: '10.0.0.7', headers: { authorization: `Basic ${VALID_CREDENTIAL}` } }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 403)
    assert.equal(res.headers['WWW-Authenticate'], undefined, '403 nao pode desafiar credencial')
    assert.equal(originalCalled, false)
  })

  it('COM SESSAO ATIVA, trustedRemotes continua a ser avaliado ANTES', async () => {
    // Se a sessao curto-circuitasse o perimetro, o portador de um cookie valido
    // vindo de uma origem recusada passaria a receber 401 em vez de 403 -- e a
    // ordem perder-se-ia sem que nenhum teste de credencial acusasse.
    const b = abrir()
    const cookie = b.emitirSessao()

    const handler = createGuardedHandler(b.gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(pedido({ remoteAddress: '10.0.0.7', headers: { cookie } }), res.asServerResponse())

    assert.equal(res.statusCode, 403, 'a sessao nao pode curto-circuitar o perimetro de rede')
    assert.equal(res.headers['WWW-Authenticate'], undefined)
  })

  it('a sessao valida, de origem confiada, deixa passar', async () => {
    const b = abrir()
    const cookie = b.emitirSessao()
    let served = false

    const handler = createGuardedHandler(b.gate, (): void => {
      served = true
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(pedido({ headers: { cookie } }), res.asServerResponse())

    assert.equal(served, true)
  })

  it('trustedRemotes vazio nega TODA a gente (fail-closed), incluindo o loopback', async () => {
    const b = abrir({ config: { trustedRemotes: [] } })
    let originalCalled = false

    const handler = createGuardedHandler(b.gate, (): void => {
      originalCalled = true
    }, 'dispatch:request')

    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.7']) {
      const res = new FakeResponse()
      await handler(
        pedido({ remoteAddress, headers: { authorization: `Basic ${VALID_CREDENTIAL}` } }),
        res.asServerResponse(),
      )
      assert.equal(res.statusCode, 403, `origem ${remoteAddress} devia ser recusada`)
    }

    assert.equal(originalCalled, false)
  })
})

describe('isencao explicita (a porta de login do painel)', () => {
  it('deixa passar SEM credencial so o que consta da lista, ao SEGMENTO', async () => {
    const b = abrir({ unauthenticatedPrefixes: ['/__guard/api/login'] })
    const servidos: string[] = []

    const handler = createGuardedHandler(b.gate, (req): void => {
      servidos.push(String(req.url))
    }, 'dispatch:request')

    for (const url of ['/__guard/api/login', '/__guard/api/login/passo2']) {
      const res = new FakeResponse()
      await handler(pedido({ method: 'POST', url }), res.asServerResponse())
      assert.equal(res.statusCode, undefined, `${url} devia ser isento`)
    }
    assert.deepEqual(servidos, ['/__guard/api/login', '/__guard/api/login/passo2'])

    // A fronteira e ao SEGMENTO: um vizinho de prefixo NAO herda a isencao.
    for (const url of ['/__guard/api/loginX', '/api/commands/execute']) {
      const res = new FakeResponse()
      await handler(pedido({ method: 'POST', url }), res.asServerResponse())
      assert.equal(res.statusCode, 401, `${url} NAO devia ser isento`)
    }
  })

  it('a isencao dispensa L3 mas NAO o perimetro (L2) nem o Host (L2.5)', async () => {
    const b = abrir({ unauthenticatedPrefixes: ['/__guard/api/login'] })

    const handler = createGuardedHandler(b.gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request')

    const foraDoPerimetro = new FakeResponse()
    await handler(
      pedido({ method: 'POST', url: '/__guard/api/login', remoteAddress: '10.0.0.7' }),
      foraDoPerimetro.asServerResponse(),
    )
    assert.equal(foraDoPerimetro.statusCode, 403)

    const hostForjado = new FakeResponse()
    await handler(
      pedido({ method: 'POST', url: '/__guard/api/login', headers: { host: 'evil.com' } }),
      hostForjado.asServerResponse(),
    )
    assert.equal(hostForjado.statusCode, 403)
  })
})

describe('cascata http/auth-check', () => {
  it('o next TERMINAL entrega a decisao do portao: fail-closed sem qualquer ouvinte', async () => {
    const b = abrir()
    assert.equal(b.ctx.listeners.size, 0, 'esta bancada nao regista ouvintes')

    const handler = createGuardedHandler(b.gate, (_req, res): void => {
      res.writeHead(200)
      res.end('ok')
    }, 'dispatch:request')

    const semCredencial = new FakeResponse()
    await handler(pedido(), semCredencial.asServerResponse())
    assert.equal(semCredencial.statusCode, 401)

    const comCredencial = new FakeResponse()
    await handler(
      pedido({ headers: { authorization: `Basic ${VALID_CREDENTIAL}` } }),
      comCredencial.asServerResponse(),
    )
    assert.equal(comCredencial.statusCode, 200)
  })

  it('um ouvinte externo pode vetar mesmo com credencial valida', async () => {
    const b = abrir()
    b.ctx.on('http/auth-check', async (): Promise<boolean> => false)

    const handler = createGuardedHandler(b.gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request')

    const res = new FakeResponse()
    await handler(
      pedido({ headers: { authorization: `Basic ${VALID_CREDENTIAL}` } }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
  })
})

describe('auditoria fail-closed e o 401 UNICO (D9)', () => {
  it('AuditWriteError vira o MESMO 401 de credencial errada, byte a byte', async () => {
    const b = abrir({ comSegredo: true })

    const errada = new FakeResponse()
    await createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')(
      pedido({ headers: { authorization: basic('senha-errada') } }),
      errada.asServerResponse(),
    )

    const discoCheio = new FakeResponse()
    await createGuardedHandler(comAuditoriaAvariada(b), (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request')(
      pedido({ headers: { authorization: basic(OWNER_SECRET) } }),
      discoCheio.asServerResponse(),
    )

    assert.equal(errada.statusCode, 401)
    assert.equal(discoCheio.statusCode, 401, 'disco cheio NAO pode virar 500: seria um oraculo')
    assert.deepEqual(discoCheio.headers, errada.headers)
    assert.equal(discoCheio.body, errada.body)
  })

  it('o caminho do ficheiro de auditoria NUNCA entra no corpo da resposta', async () => {
    const b = abrir({ comSegredo: true })

    const res = new FakeResponse()
    await createGuardedHandler(comAuditoriaAvariada(b), (): void => {}, 'dispatch:request')(
      pedido({ headers: { authorization: basic(OWNER_SECRET) } }),
      res.asServerResponse(),
    )

    assert.equal(res.body.includes('/caminho/que/nao/pode/aparecer'), false)
    assert.equal(JSON.stringify(res.headers).includes('/caminho/'), false)
  })

  it('regista no ficheiro de auditoria a tentativa aceite e a recusada', async () => {
    const b = abrir({ comSegredo: true })
    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')

    await handler(
      pedido({ headers: { authorization: basic(OWNER_SECRET) } }),
      new FakeResponse().asServerResponse(),
    )
    await handler(
      pedido({ headers: { authorization: basic('nao-e-esta') } }),
      new FakeResponse().asServerResponse(),
    )

    const linhas = readFileSync(b.auditPath, 'utf8').trim().split('\n')
    assert.equal(linhas.length, 2)
    assert.equal(linhas[0]?.includes('"resultado":"permitido"'), true, linhas[0])
    assert.equal(linhas[1]?.includes('"resultado":"negado"'), true, linhas[1])
    assert.equal(
      readFileSync(b.auditPath, 'utf8').includes(OWNER_SECRET),
      false,
      'o segredo tentado NUNCA e escrito',
    )
  })
})

describe('modo restrito', () => {
  it('recusa credencial CERTA vinda do tunel e aceita a mesma no loopback', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    // O modo restrito e persistido pelo `StateStore` -- e assim que ele
    // sobrevive a um reinicio do DSH.
    b.stack.state.update((previous) => ({
      ...previous,
      restricted: { since: 1, reason: 'brute-force-ceiling' },
    }))
    b.stack.restricted.reload()

    let served = 0
    const handler = createGuardedHandler(b.gate, (): void => {
      served += 1
    }, 'dispatch:request')

    const doTunel = new FakeResponse()
    await handler(
      pedido({
        headers: {
          host: 'marks-organization-moved-coupons.trycloudflare.com',
          authorization: basic(OWNER_SECRET),
        },
      }),
      doTunel.asServerResponse(),
    )
    assert.equal(doTunel.statusCode, 401, 'em modo restrito o tunel nao autentica')
    assert.equal(served, 0)

    const doLoopback = new FakeResponse()
    await handler(
      pedido({ headers: { authorization: basic(OWNER_SECRET) } }),
      doLoopback.asServerResponse(),
    )
    assert.equal(served, 1, 'o loopback continua a autenticar -- a saida e LOCAL')
    assert.equal(doLoopback.statusCode, undefined)
  })

  it('recusa tambem a SESSAO vinda do tunel', async () => {
    const b = abrir({ tunnelReady: true })
    const cookie = b.emitirSessao()
    b.stack.state.update((previous) => ({
      ...previous,
      restricted: { since: 1, reason: 'brute-force-ceiling' },
    }))
    b.stack.restricted.reload()

    const res = new FakeResponse()
    await createGuardedHandler(b.gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request')(
      pedido({
        headers: { host: 'marks-organization-moved-coupons.trycloudflare.com', cookie },
      }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
  })
})

describe('a landmine do tunel: reescrita de Host APOS autenticar', () => {
  it('reescreve Host e apaga origin/sec-fetch-* so no pedido APROVADO do tunel', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    const visto: Record<string, string | string[] | undefined> = {}

    const handler = createGuardedHandler(b.gate, (req): void => {
      Object.assign(visto, req.headers)
    }, 'dispatch:request')

    const req = pedido({
      url: '/api/state',
      headers: {
        host: 'marks-organization-moved-coupons.trycloudflare.com',
        origin: FAKE_TUNNEL_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        authorization: basic(OWNER_SECRET),
      },
    })
    await handler(req, new FakeResponse().asServerResponse())

    assert.equal(visto['host'], '127.0.0.1:3080')
    assert.equal(visto['origin'], undefined)
    assert.equal(visto['sec-fetch-site'], undefined)
    assert.equal(visto['sec-fetch-mode'], undefined)
  })

  it('NAO reescreve nada num pedido de loopback', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    const visto: Record<string, string | string[] | undefined> = {}

    await createGuardedHandler(b.gate, (req): void => {
      Object.assign(visto, req.headers)
    }, 'dispatch:request')(
      pedido({
        headers: {
          host: '127.0.0.1:3080',
          origin: 'http://127.0.0.1:3080',
          authorization: basic(OWNER_SECRET),
        },
      }),
      new FakeResponse().asServerResponse(),
    )

    assert.equal(visto['origin'], 'http://127.0.0.1:3080', 'o loopback ja funciona: nao se mexe')
  })

  it('um pedido RECUSADO do tunel nunca chega a ser reescrito', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    const req = pedido({
      headers: { host: 'marks-organization-moved-coupons.trycloudflare.com', origin: FAKE_TUNNEL_ORIGIN },
    })

    await createGuardedHandler(b.gate, (): void => {
      throw new Error('nao devia ser alcancado')
    }, 'dispatch:request')(req, new FakeResponse().asServerResponse())

    assert.equal(req.headers.host, 'marks-organization-moved-coupons.trycloudflare.com')
    assert.equal(req.headers.origin, FAKE_TUNNEL_ORIGIN)
  })
})

describe('handshake de upgrade guardado (achado B-MEDIUM)', () => {
  it('recusa o handshake sem credencial com 401 escrito no socket cru', async () => {
    const b = abrir()
    let handshakeFeito = false

    const handler = createGuardedUpgradeHandler(b.gate, (): void => {
      handshakeFeito = true
    }, 'dispatch:upgrade')

    const socket = await runUpgrade(handler, pedido({ url: '/ws' }))

    assert.equal(handshakeFeito, false, 'o WebSocket NAO pode ser estabelecido sem credencial')
    assert.equal(socket.written.startsWith('HTTP/1.1 401 Unauthorized\r\n'), true, socket.written)
    assert.equal(socket.written.includes(`WWW-Authenticate: Basic realm="${b.config.realm}"`), true)
    assert.equal(socket.written.endsWith('\r\n\r\n'), true, 'a resposta crua precisa da linha em branco')
    assert.equal(socket.destroyed, true)
  })

  it('recusa com 403 (sem desafio) uma origem fora de trustedRemotes', async () => {
    const b = abrir()

    const socket = await runUpgrade(
      createGuardedUpgradeHandler(b.gate, (): void => {
        throw new Error('nao devia ser alcancado')
      }, 'dispatch:upgrade'),
      pedido({
        url: '/ws',
        remoteAddress: '10.0.0.7',
        headers: { authorization: `Basic ${VALID_CREDENTIAL}` },
      }),
    )

    assert.equal(socket.written.startsWith('HTTP/1.1 403 Forbidden\r\n'), true, socket.written)
    assert.equal(socket.written.includes('WWW-Authenticate'), false, '403 nao desafia credencial')
    assert.equal(socket.destroyed, true)
  })

  it('deixa passar o handshake com credencial valida, com head e socket intactos', async () => {
    const b = abrir()
    const recebido: { url: string | undefined; head: number | undefined } = {
      url: undefined,
      head: undefined,
    }

    const socket = await runUpgrade(
      createGuardedUpgradeHandler(b.gate, (req, _socket, head): void => {
        recebido.url = req.url
        recebido.head = head.byteLength
      }, 'dispatch:upgrade'),
      pedido({
        url: '/ws',
        headers: { origin: 'http://127.0.0.1:3080', authorization: `Basic ${VALID_CREDENTIAL}` },
      }),
    )

    assert.equal(recebido.url, '/ws')
    assert.equal(recebido.head, 0)
    assert.equal(socket.destroyed, false, 'o handshake aprovado nao pode destruir o socket')
    assert.equal(socket.written, '')
  })

  it('um erro no caminho de decisao destroi o socket (fail-closed) e nao rejeita', async () => {
    const b = abrir()
    b.ctx.on('http/auth-check', async (): Promise<boolean> => {
      throw new Error('ouvinte de terceiro rebentou')
    })

    const socket = await runUpgrade(
      createGuardedUpgradeHandler(b.gate, (): void => {
        throw new Error('nao devia ser alcancado')
      }, 'dispatch:upgrade'),
      pedido({ url: '/ws', headers: { authorization: `Basic ${VALID_CREDENTIAL}` } }),
    )

    assert.equal(socket.destroyed, true)
    assert.equal(b.ctx.logger.has('error', 'socket destruido'), true)
  })
})
