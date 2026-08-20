/**
 * =============================================================================
 * CWE-1385 -- CROSS-SITE WEBSOCKET HIJACKING. Suite adversarial de T3.3.
 * =============================================================================
 *
 * PORQUE ESTA SUITE EXISTE, com nome e numero. Dois precedentes diretos, ambos
 * servidor de loopback com execucao de codigo do outro lado do canal:
 *
 *   CVE-2023-26114  code-server, CVSS 9.3 -- handshake de WebSocket aceite a
 *                   partir de qualquer origem;
 *   CVE-2025-52882  extensoes do Claude Code -- a mesma classe.
 *
 * A raiz e sempre a mesma frase: **WebSockets NAO estao sujeitos a same-origin
 * policy**. Qualquer pagina aberta no navegador da maquina pode abrir
 * `ws://127.0.0.1:3080/...` sem preflight, sem CORS e sem qualquer permissao. O
 * unico controlo e validar `Origin` no handshake -- e valida-lo por ALLOWLIST
 * EXATA, porque e trivial fabricar uma origem que CONTEM o nome certo.
 *
 * O teste que decide isto e o primeiro: `https://evil.com/?x=meudominio.com`.
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { IncomingMessage } from 'node:http'

import { buildAllowedOrigins, canonicalOrigin, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { FakeSocket } from '../support/ctx-double.ts'
import { VALID_CREDENTIAL } from '../support/fixtures.ts'
import { bancada, pedido, FAKE_TUNNEL_ORIGIN, type Bancada } from '../unit/http/bancada.ts'

let aberta: Bancada | undefined
function abrir(...args: Parameters<typeof bancada>): Bancada {
  aberta = bancada(...args)
  return aberta
}
afterEach(() => {
  aberta?.cleanup()
  aberta = undefined
})

async function handshake(b: Bancada, req: IncomingMessage): Promise<FakeSocket> {
  const socket = new FakeSocket()
  let delegado = false
  const handler = createGuardedUpgradeHandler(b.gate, (): void => {
    delegado = true
  }, 'dispatch:upgrade')
  await handler(req, socket.asDuplex() as never, Buffer.alloc(0))
  Object.assign(socket, { delegado })
  return socket
}

function status(socket: FakeSocket): number | 'upgrade' {
  if (socket.written === '') return 'upgrade'
  const match = /^HTTP\/1\.1 (\d{3})/u.exec(socket.written)
  return match === null ? 0 : Number(match[1])
}

describe('ALLOWLIST EXATA, nunca "contem"', () => {
  it('>>> Origin: https://evil.com/?x=meudominio.com E RECUSADO <<<', async () => {
    const b = abrir()

    const socket = await handshake(
      b,
      pedido({
        url: '/api/events.mux',
        headers: {
          origin: 'https://evil.com/?x=meudominio.com',
          authorization: `Basic ${VALID_CREDENTIAL}`,
        },
      }),
    )

    assert.equal(status(socket), 403, socket.written)
    assert.equal(socket.destroyed, true)
    assert.equal(
      socket.written.includes('WWW-Authenticate'),
      false,
      'repetir a credencial nao ajuda: a origem nunca sera aceite',
    )
  })

  it('recusa toda a familia de origens que CONTEM o nome certo', async () => {
    const b = abrir({ tunnelReady: true })
    const forjadas = [
      'https://evil.com/?x=127.0.0.1',
      'https://evil.com/#127.0.0.1:3080',
      'https://127.0.0.1.evil.com',
      'https://evil.com:3080',
      'http://127.0.0.1.evil.com:3080',
      'https://marks-organization-moved-coupons.trycloudflare.com.evil.com',
      'https://evil.com/?r=marks-organization-moved-coupons.trycloudflare.com',
      // Origem OPACA: sandbox, `data:`, redirecionamento entre esquemas.
      'null',
      // Esquemas que nao sao HTTP nem HTTPS nunca sao a nossa origem.
      'file://',
      'chrome-extension://abcdefghijklmnop',
    ]

    for (const origin of forjadas) {
      const socket = await handshake(
        b,
        pedido({
          url: '/api/events.mux',
          headers: { origin, authorization: `Basic ${VALID_CREDENTIAL}` },
        }),
      )
      assert.equal(status(socket), 403, `origem aceite indevidamente: ${origin}`)
    }
  })

  it('aceita as origens legitimas -- a allowlist nao pode ser so teatro', async () => {
    // Uma allowlist que recusa tudo "passa" no teste anterior sem defender nada.
    const b = abrir({ tunnelReady: true })

    for (const origin of [
      'http://127.0.0.1:3080',
      'http://localhost:3080',
      FAKE_TUNNEL_ORIGIN,
      // Porta por omissao explicita: `https://x` e `https://x:443` sao a mesma.
      `${FAKE_TUNNEL_ORIGIN}:443`,
    ]) {
      const socket = await handshake(
        b,
        pedido({
          url: '/api/events.mux',
          headers: { origin, authorization: `Basic ${VALID_CREDENTIAL}` },
        }),
      )
      assert.equal(status(socket), 'upgrade', `origem legitima recusada: ${origin}`)
    }
  })

  it('a comparacao e sobre esquema+host+porta, cada um extraido por um parser', () => {
    assert.equal(canonicalOrigin('https://EVIL.com:443/caminho?x=1#y'), 'https://evil.com')
    assert.equal(canonicalOrigin('http://[::1]:3080'), 'http://127.0.0.1:3080')
    assert.equal(canonicalOrigin('http://127.0.0.1:80'), 'http://127.0.0.1')
    assert.equal(canonicalOrigin('ws://127.0.0.1:3080'), undefined)
    assert.equal(canonicalOrigin('null'), undefined)
    assert.equal(canonicalOrigin(undefined), undefined)
  })
})

describe('o handshake e guardado POR INTEIRO', () => {
  it('recusa o upgrade SEM credencial, independentemente de guardedPrefixes', async () => {
    for (const guardedPrefixes of [['/api'], [], ['/nada-que-ver']]) {
      const b = abrir({ config: { guardedPrefixes } })

      for (const url of ['/api/events.mux', '/', '/ws', '/plugins/x/socket']) {
        const socket = await handshake(
          b,
          pedido({ url, headers: { origin: 'http://127.0.0.1:3080' } }),
        )
        assert.equal(
          status(socket),
          401,
          `upgrade sem credencial aceite em ${url} com guardedPrefixes=${JSON.stringify(guardedPrefixes)}`,
        )
      }

      b.cleanup()
      aberta = undefined
    }
  })

  it('a ordem 403-antes-de-401 vale tambem no upgrade', async () => {
    const b = abrir()

    const foraDoPerimetro = await handshake(
      b,
      pedido({
        url: '/api/events.mux',
        remoteAddress: '10.0.0.7',
        headers: { origin: 'http://127.0.0.1:3080', authorization: `Basic ${VALID_CREDENTIAL}` },
      }),
    )
    assert.equal(status(foraDoPerimetro), 403)

    const semCredencial = await handshake(
      b,
      pedido({ url: '/api/events.mux', headers: { origin: 'http://127.0.0.1:3080' } }),
    )
    assert.equal(status(semCredencial), 401)
  })

  it('`Origin` AUSENTE cai para a credencial -- e a sonda `websocket-upgrade` exige-o', async () => {
    // Um NAVEGADOR envia sempre `Origin` no handshake e o script nao lhe toca:
    // a ausencia significa cliente nao-navegador, e o ataque de origem cruzada
    // -- que so um navegador monta -- nao se aplica. Recusar com 403 quebraria
    // ainda a sonda fail-closed de `src/contracts/tunnel.ts`, cujo caso feliz e
    // "socket destruido OU 401": um 403 fa-la-ia concluir que o gate nao esta
    // armado, e o tunel nunca subiria.
    const b = abrir()

    const semCredencial = await handshake(b, pedido({ url: '/' }))
    assert.equal(status(semCredencial), 401, 'sem Origin e sem credencial: 401, nunca 403')
    assert.equal(semCredencial.destroyed, true)

    const comCredencial = await handshake(
      b,
      pedido({ url: '/', headers: { authorization: `Basic ${VALID_CREDENTIAL}` } }),
    )
    assert.equal(status(comCredencial), 'upgrade')
  })
})

describe('a origem do tunel entra em READY e SAI quando cai', () => {
  it('a mesma origem passa com o tunel de pe e e recusada depois da queda', async () => {
    const b = abrir({ tunnelReady: true })

    const comTunel = await handshake(
      b,
      pedido({
        url: '/api/events.mux',
        headers: {
          host: 'marks-organization-moved-coupons.trycloudflare.com',
          origin: FAKE_TUNNEL_ORIGIN,
          authorization: `Basic ${VALID_CREDENTIAL}`,
        },
      }),
    )
    assert.equal(status(comTunel), 'upgrade')

    b.tunnelOrigin.publish(undefined) // o tunel caiu

    const depoisDaQueda = await handshake(
      b,
      pedido({
        url: '/api/events.mux',
        headers: {
          host: 'marks-organization-moved-coupons.trycloudflare.com',
          origin: FAKE_TUNNEL_ORIGIN,
          authorization: `Basic ${VALID_CREDENTIAL}`,
        },
      }),
    )
    assert.equal(
      status(depoisDaQueda),
      403,
      'entrada morta: um nome derrubado volta a ser distribuido a outra pessoa',
    )
  })

  it('a allowlist de origens acompanha o estado do tunel', () => {
    assert.deepEqual(buildAllowedOrigins('127.0.0.1:3080', undefined), [
      'http://127.0.0.1:3080',
      'http://localhost:3080',
    ])
    assert.equal(
      buildAllowedOrigins('127.0.0.1:3080', FAKE_TUNNEL_ORIGIN).includes(FAKE_TUNNEL_ORIGIN),
      true,
    )
  })
})

describe('`Origin` REPETIDO nao pode saltar a verificacao', () => {
  it('>>> um array em req.headers.origin e ILEGIVEL, e ilegivel FECHA <<<', async () => {
    // FORMA FAIL-OPEN LATENTE, corrigida: o caminho lia o cabecalho por um
    // helper que colapsa "ausente" e "repetido" no mesmo `undefined`. Para o
    // `Host` isso fecha (sem `Host` nada casa); para o `Origin` ABRIA -- o ramo
    // lia `undefined` como "nao ha origem para validar" e SALTAVA a defesa de
    // CWE-1385 inteira. Com credencial valida, o handshake passava.
    //
    // Nao e alcancavel de um socket real (o Node junta `Origin` duplicado por
    // virgula, e ai `new URL` lanca e sai 403), mas o comentario prometia o
    // contrario do que o codigo fazia -- e e assim que uma defesa se perde num
    // refactor seguinte.
    const b = abrir()

    const req = {
      method: 'GET',
      url: '/api/events.mux',
      headers: {
        host: '127.0.0.1:3080',
        origin: ['http://127.0.0.1:3080', 'https://evil.com'],
        authorization: `Basic ${VALID_CREDENTIAL}`,
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage

    const socket = await handshake(b, req)

    assert.equal(status(socket), 403, 'origem repetida tem de ser recusada, nao ignorada')
    assert.equal(socket.destroyed, true)
  })
})

describe('L2.6 tambem corre no handshake', () => {
  it('rota de CANAL LOCAL APENAS pelo tunel: recusada, e com o 401 UNIVERSAL', async () => {
    // A invariante escrita em `loopbackOnlyPrefixes` dizia "vale para rotas
    // isentas e guardadas" -- era verdadeira no request e FALSA aqui. Hoje corre
    // nas duas superficies.
    //
    // PORQUE 401 E NAO O 404 DO REQUEST: nesta superficie 401 e a resposta a
    // tudo o que nao tem credencial (nao ha isencoes no upgrade). Um codigo
    // DIFERENTE passaria a distinguir "esta rota e de canal local" de "nao tens
    // credencial" -- criaria o sinal que hoje nao existe.
    const b = abrir({ comSegredo: true, tunnelReady: true })

    const pelaBorda = await handshake(
      b,
      pedido({
        url: '/__guard/secret',
        headers: {
          host: 'marks-organization-moved-coupons.trycloudflare.com',
          origin: FAKE_TUNNEL_ORIGIN,
          authorization: `Basic ${VALID_CREDENTIAL}`,
        },
      }),
    )
    assert.equal(status(pelaBorda), 401)

    const semCredencialQualquerRota = await handshake(
      b,
      pedido({
        url: '/api/events.mux',
        headers: { host: 'marks-organization-moved-coupons.trycloudflare.com', origin: FAKE_TUNNEL_ORIGIN },
      }),
    )
    assert.equal(
      status(semCredencialQualquerRota),
      401,
      'as duas recusas tem de ser o MESMO codigo -- senao L2.6 vira um oraculo',
    )
  })

  it('pelo loopback, a mesma rota chega ao handshake', async () => {
    // Caso de controlo: sem ele, o teste acima passava com a rota partida.
    const b = abrir({ comSegredo: true, tunnelReady: true })

    const socket = await handshake(
      b,
      pedido({
        url: '/__guard/secret',
        headers: { origin: 'http://127.0.0.1:3080', authorization: `Basic ${VALID_CREDENTIAL}` },
      }),
    )

    assert.equal(status(socket), 'upgrade')
  })
})
