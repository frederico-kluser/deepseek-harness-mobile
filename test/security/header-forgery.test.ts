/**
 * =============================================================================
 * ADV-021..ADV-028 -- FORJA DE CABECALHO E IDENTIDADE. Suite adversarial de T6.3.
 * =============================================================================
 *
 * A lista fechada de 04-TESTES.md 6.2, contra o servidor REAL.
 *
 * A regra de ouro, dita por ADV-021: **a decisao usa req.socket.remoteAddress,
 * jamais cabecalho.** Um cabecalho de IP forjado (X-Forwarded-For, X-Real-IP,
 * Forwarded, CF-Connecting-IP) nao muda NADA -- e por isso que o teste assere o
 * 403 com o cabecalho presente: se a decisao olhasse para ele, o pedido
 * passaria o perimetro.
 *
 * A ordem 403-antes-de-401 e o contrato que ADV-024 fecha: o gate nao confia em
 * Origin para AUTORIZAR; so o usa, se o usa, para NEGAR. Um Origin forjado de
 * 127.0.0.1 vindo de fora nao compra nada.
 *
 * Cf-Access-Jwt-Assertion (ADV-025) e skip com TODO nomeado: a Camada L0
 * (Cloudflare Access) nao existe nesta versao, e o teste so passa a valer no
 * dia em que ela entrar -- o que nao impede de o furo ficar registado.
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { IncomingMessage, ServerResponse } from 'node:http'

import { createGuardedHandler, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { bancada, basic, OWNER_SECRET, pedido, FAKE_TUNNEL_ORIGIN, type Bancada } from '../unit/http/bancada.ts'
import { FakeResponse, FakeSocket } from '../support/ctx-double.ts'
import { VALID_CREDENTIAL } from '../support/fixtures.ts'

let aberta: Bancada | undefined
function abrir(...args: Parameters<typeof bancada>): Bancada {
  aberta = bancada(...args)
  return aberta
}
afterEach(() => {
  aberta?.cleanup()
  aberta = undefined
})

/** O hostname do tunel publicado pela bancada (`FAKE_TUNNEL_ORIGIN`). */
function hostDoTunel(_b: Bancada): string {
  return new URL(FAKE_TUNNEL_ORIGIN).host
}

interface Veredito {
  readonly status: number
  readonly challenge: string | undefined
  readonly delegado: boolean
}

/** Decide um pedido pelo caminho real (gate sobre servidor REAL por baixo). */
async function decidir(b: Bancada, req: IncomingMessage, surface = 'adv:header'): Promise<Veredito> {
  let delegado = false
  const handler = createGuardedHandler(
    b.gate,
    (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
      delegado = true
      res.writeHead(200)
      res.end('ok')
      return Promise.resolve()
    },
    surface,
  )
  const res = new FakeResponse()
  await handler(req, res.asServerResponse())
  return { status: res.statusCode ?? 0, challenge: res.headers['WWW-Authenticate'], delegado }
}

/**
 * ADV-021..024, ADV-026: pedidos de UMA origem NAO confiavel (10.0.0.7) com os
 * cabecalhos forjados. Com trustedRemotes: [] nada e confiado -- o 403 e a
 * resposta a QUALQUER pedido, e o teste assere que o cabecalho NAO o converteu.
 */
describe('ADV-021..024 -- cabecalhos de IP e identidade forjados nao compram origem', () => {
  it('ADV-021: X-Forwarded-For: 127.0.0.1 vindo de 10.0.0.7 e IGNORADO -> 403', async () => {
    const b = abrir({ config: { trustedRemotes: [] } })
    const req = pedido({
      url: '/api/state',
      remoteAddress: '10.0.0.7',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    })
    const r = await decidir(b, req)
    assert.equal(r.status, 403, 'a decisao usa o SOCKET, nao o header')
    assert.equal(r.challenge, undefined, '403 nao desafia credencial')
    assert.equal(r.delegado, false)
  })

  it('ADV-022: X-Real-IP, Forwarded e CF-Connecting-IP forjados -> idem 403', async () => {
    const b = abrir({ config: { trustedRemotes: [] } })
    for (const [nome, valor] of [
      ['x-real-ip', '127.0.0.1'],
      ['forwarded', 'for=127.0.0.1'],
      ['cf-connecting-ip', '127.0.0.1'],
    ]) {
      const req = pedido({
        url: '/api/state',
        remoteAddress: '10.0.0.7',
        headers: Object.fromEntries([[nome, valor]]),
      })
      const r = await decidir(b, req)
      assert.equal(r.status, 403, nome + ' forjado nao pode comprar origem')
      assert.equal(r.delegado, false)
    }
  })

  it('ADV-023: Host: localhost forjado -- localhost NAO abre o perimetro', async () => {
    const b = abrir({ config: { trustedRemotes: [] } })
    const r = await decidir(
      b,
      pedido({ url: '/api/state', remoteAddress: '10.0.0.7', headers: { host: 'localhost' } }),
    )
    // L2 (origem) corre ANTES de L2.5 (Host): 10.0.0.7 morre na origem, mesmo
    // com um Host de loopback. O Host so importa DEPOIS de a origem passar.
    assert.equal(r.status, 403)
    assert.equal(r.delegado, false)
  })

  it('ADV-024: Origin: http://127.0.0.1:3080 forjado de fora nao autoriza', async () => {
    const b = abrir({ config: { trustedRemotes: [] } })
    const r = await decidir(
      b,
      pedido({
        url: '/api/state',
        remoteAddress: '10.0.0.7',
        headers: { origin: 'http://127.0.0.1:3080' },
      }),
    )
    assert.equal(r.status, 403, 'o gate nao confia em Origin para autorizar')
    assert.equal(r.delegado, false)
  })

  it('ADV-025: Cf-Access-Jwt-Assertion -- SKIP com TODO nomeado (L0 nao existe)', (t) => {
    t.skip('TODO ADV-025: validar kid/iss/aud/exp contra as chaves publicas do team quando L0 entrar')
  })

  it('ADV-026: Authorization duplicado -- o Node junta por virgula e a comparacao falha', async () => {
    // O caminho de credencial do gate so corre na superficie do TUNEL (onda 1:
    // o acesso local abre direto). Usa-se o host do tunel.
    const b = abrir({ comSegredo: true, tunnelReady: true })
    const req = pedido({
      url: '/api/state',
      headers: {
        host: hostDoTunel(b),
        authorization: 'Basic ' + VALID_CREDENTIAL + ', Basic ' + VALID_CREDENTIAL,
      },
    })
    const r = await decidir(b, req)
    assert.equal(r.status, 401)
    assert.equal(r.delegado, false)
  })
})

describe('ADV-027..028 -- decisao por pedido, sem cache e sem sessao roubada', () => {
  it('ADV-027: com credencial valida e o mesmo handler, cada pedido e avaliado de novo', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    const semCredencial = await decidir(b, pedido({ url: '/api/state', headers: { host: hostDoTunel(b) } }))
    assert.equal(semCredencial.status, 401)
    assert.equal(semCredencial.delegado, false)
    const comCredencial = await decidir(
      b,
      pedido({ url: '/api/state', headers: { host: hostDoTunel(b), authorization: basic(OWNER_SECRET) } }),
    )
    assert.equal(comCredencial.status, 200)
    assert.equal(comCredencial.delegado, true)
    const outraVez = await decidir(b, pedido({ url: '/api/state', headers: { host: hostDoTunel(b) } }))
    assert.equal(outraVez.status, 401)
    assert.equal(outraVez.delegado, false)
  })

  it('ADV-028: cookie de sessao de OUTRO segredo (pos-rotacao) e rejeitado', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    const cookie = '__Host-dsh_sid=' + b.stack.sessions.create()
    const valida = await decidir(b, pedido({ url: '/api/state', headers: { host: hostDoTunel(b), cookie } }))
    assert.equal(valida.status, 200)
    // Rotacao revoga TODAS as sessoes (SECRET-008) e emite digest novo.
    b.stack.secrets.rotate()
    const posRotacao = await decidir(b, pedido({ url: '/api/state', headers: { host: hostDoTunel(b), cookie } }))
    assert.equal(posRotacao.status, 401, 'a sessao emitida sob o segredo antigo morre com ele')
    assert.equal(posRotacao.delegado, false)
  })
})

describe('a ordem 403-antes-de-401 e contrato nesta suite (AUTH-032)', () => {
  it('origem nao confiada SEM credencial: 403, e nunca 401', async () => {
    const b = abrir({ config: { trustedRemotes: [] } })
    const r = await decidir(b, pedido({ url: '/api/state', remoteAddress: '10.0.0.7' }))
    assert.equal(r.status, 403)
    assert.equal(r.challenge, undefined, 'o 403 nao convida a repetir a credencial')
  })

  it('origem nao confiada COM credencial CORRETA: continua 403', async () => {
    const b = abrir({ config: { trustedRemotes: [] } })
    const r = await decidir(
      b,
      pedido({
        url: '/api/state',
        remoteAddress: '10.0.0.7',
        headers: { authorization: basic(OWNER_SECRET) },
      }),
    )
    assert.equal(r.status, 403)
    assert.equal(r.delegado, false)
  })
})

describe('o upgrade herda a mesma politica de perimetro (403-antes-de-401)', () => {
  it('handshake de 10.0.0.7: 403 cru, sem desafio, socket destruido', async () => {
    const b = abrir({ config: { trustedRemotes: [] } })
    const handler = createGuardedUpgradeHandler(
      b.gate,
      (): Promise<void> => Promise.resolve(),
      'adv:header:upgrade',
    )
    const socket = new FakeSocket()
    await handler(
      pedido({ url: '/api/events.mux', remoteAddress: '10.0.0.7' }),
      socket.asDuplex() as never,
      Buffer.alloc(0),
    )
    assert.match(socket.written, /^HTTP\/1\.1 403 /u)
    assert.equal(socket.written.includes('WWW-Authenticate'), false)
    assert.equal(socket.destroyed, true)
  })
})

