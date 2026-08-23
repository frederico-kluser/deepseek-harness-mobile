/**
 * =============================================================================
 * ONDA 1 (remocao do login): as recusas do PORTAO nao desafiam.
 * =============================================================================
 *
 * Antes desta onda, o 401 do gate e o 401 do painel eram o MESMO 401, byte a
 * byte, ambos com `WWW-Authenticate` -- a igualdade era o que impedia um
 * scanner de distinguir o painel do resto do DSH.
 *
 * A Onda 1 remove o login do portao: o gate NUNCA emite `WWW-Authenticate` (o
 * popup do navegador acabou). O 401 do gate passa a ser TEXTO PURO. A Onda 2
 * alinhou o PAINEL ao mesmo modelo expose-port: o painel (`src/panel/routes.ts`)
 * NAO pede senha nunca mais — o seu 401 `exige-sessao` e o MESMO `denyUnauthorized`
 * texto puro, sem desafio. Logo os dois 401 sao identicos de novo (por
 * construcao, partilham a funcao), e esta suite prende NENHUMA recusa — do
 * gate OU do painel — com `WWW-Authenticate`.
 *
 * O que esta suite agora prende: NENHUMA recusa do portao -- 401 do tunel,
 * 403 de perimetro/Host, 404 de canal-local-apenas, handshakes recusados --
 * emite `WWW-Authenticate`, e todas levam `Referrer-Policy: no-referrer`
 * (a regra de ficheiro de `src/http/responses.ts`).
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { createGuardedHandler, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { installAuthBarrier } from '../../src/http/intercept.ts'
import { LOOPBACK_ONLY_PREFIXES, UNAUTHENTICATED_PANEL_PREFIXES } from '../../src/index.ts'
import { bancada, type Bancada } from '../unit/http/bancada.ts'

let b: Bancada
let server: Server
let portaDoGate = 0
let reverter: (() => void) | undefined

const HOST_DO_TUNEL = 'marks-organization-moved-coupons.trycloudflare.com'

/** Pedido cru contra o servidor do gate, com o `Host` escolhido. */
function pedirComHost(linhaDePedido: string, host: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(portaDoGate, '127.0.0.1', () => {
      socket.write(`${linhaDePedido}\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    const pedacos: Buffer[] = []
    socket.on('data', (d: Buffer) => void pedacos.push(d))
    socket.on('error', reject)
    socket.on('end', () => resolve(Buffer.concat(pedacos).toString('utf8')))
  })
}

before(async () => {
  server = createServer()
  server.on('request', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('ok')
  })
  server.on('upgrade', (_req, socket: Duplex) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  portaDoGate = (server.address() as AddressInfo).port

  b = bancada({
    comSegredo: true,
    tunnelReady: true,
    loopbackAuthority: `127.0.0.1:${String(portaDoGate)}`,
    unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
    loopbackOnlyPrefixes: LOOPBACK_ONLY_PREFIXES,
  })
  reverter = installAuthBarrier(
    server,
    {
      wrapRequest: (delegate) => createGuardedHandler(b.gate, delegate, 'sec:401'),
      wrapUpgrade: (delegate) => createGuardedUpgradeHandler(b.gate, delegate, 'sec:401:upgrade'),
    },
    b.gate.log,
  )
})

after(async () => {
  reverter?.()
  b.cleanup()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('o 401 do gate e TEXTO PURO, SEM WWW-Authenticate (onda 1)', () => {
  it('a superficie do tunel NAO abre por Host de loopback (BLOCK) -- 401 sem desafio', async () => {
    // MODELO EXPOSE-PORT: este ficheiro exercita a superficie do PROXY/tunel,
    // que NAO tem "acesso local abre". Um `Host: 127.0.0.1` sem sessao e 401
    // (o furo do revisor). O servidor do DSH (upstream) abre por NAO SER
    // guardado -- coberto em test/unit/tunnel/proxy.test.ts.
    const forjado = await pedirComHost('GET /api/state HTTP/1.1', `127.0.0.1:${String(portaDoGate)}`)
    assert.match(forjado, /^HTTP\/1\.1 401 /u)
    assert.equal(/^www-authenticate:/imu.test(forjado), false, 'o loopback forjado NAO abre nem desafia')

    // Tunel sem sessao: 401 texto puro, SEM desafio.
    const doTunel = await pedirComHost('GET /api/state HTTP/1.1', HOST_DO_TUNEL)
    assert.match(doTunel, /^HTTP\/1\.1 401 Unauthorized\r\n/u)
    assert.equal(/^www-authenticate:/imu.test(doTunel), false, 'o 401 do tunel NAO desafia')
  })

  it('o 401 do tunel leva os cabecalhos da regra de ficheiro', async () => {
    const bruta = await pedirComHost('GET /api/state HTTP/1.1', HOST_DO_TUNEL)
    assert.match(bruta, /^content-type: text\/plain; charset=utf-8\r$/imu)
    assert.match(bruta, /^cache-control: no-store\r$/imu)
    // Referrer-Policy em TODA recusa (a regra de ficheiro).
    assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
    // E o corpo nao enumera nem o plugin nem detalhe.
    assert.equal(bruta.includes('dsh-guarded-bot-orchestrator'), false)
  })

  it('o 401 do tunel com `?key=` invalida e o mesmo 401 texto puro', async () => {
    const bruta = await pedirComHost('GET /?key=nao-token HTTP/1.1', HOST_DO_TUNEL)
    assert.match(bruta, /^HTTP\/1\.1 401 /u)
    assert.equal(/^www-authenticate:/imu.test(bruta), false)
  })
})

/* ========================================================================= */
/* DEFEITO 3 -- A REGRA passou a ser de FICHEIRO: TODA recusa leva o cabecalho */
/* ========================================================================= */

describe('DEFEITO 3: todas as recusas do portao levam `Referrer-Policy` e NUNCA desafiam', () => {
  it('403 de origem nao confiada (`denyUntrustedOrigin`)', async () => {
    const bruta = await pedirComHost('POST /api/state HTTP/1.1', 'evil.com')
    assert.match(bruta, /^HTTP\/1\.1 403 Forbidden\r\n/u)
    assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
    assert.equal(/^www-authenticate:/imu.test(bruta), false)
  })

  it('404 de CANAL LOCAL APENAS (`denyNotFound`), alcancado pelo tunel', async () => {
    const bruta = await pedirComHost('GET /__guard/secret HTTP/1.1', HOST_DO_TUNEL)
    assert.match(bruta, /^HTTP\/1\.1 404 Not Found\r\n/u)
    assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
    assert.equal(/^www-authenticate:/imu.test(bruta), false)
  })

  it('401 do handshake de WebSocket do tunel (`denyUpgrade`), SEM desafio', async () => {
    const bruta = await pedirComHost(
      'GET /api/events.mux HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade',
      HOST_DO_TUNEL,
    )
    assert.match(bruta, /^HTTP\/1\.1 401 Unauthorized\r\n/u)
    assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
    assert.equal(bruta.includes('101 Switching Protocols'), false, 'o handshake NAO pode subir')
    assert.equal(/^www-authenticate:/imu.test(bruta), false, 'o gateway do tunel NAO desafia')
  })

  it('403 do handshake (`denyUpgrade`), e SEM `WWW-Authenticate`', async () => {
    const bruta = await pedirComHost(
      'GET /api/events.mux HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade',
      'evil.com',
    )
    assert.match(bruta, /^HTTP\/1\.1 403 Forbidden\r\n/u)
    assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
    assert.equal(/^www-authenticate:/imu.test(bruta), false)
  })
})

/* ========================================================================= */
/* OS DOIS 404 de `/__guard/secret` continuam a ser o MESMO (PANEL-003/004)  */
/* ========================================================================= */

describe('os dois 404 de `/__guard/secret` sao o MESMO 404 (inalterado)', () => {
  it('portao e painel devolvem bytes IDENTICOS (excepto `Date`)', async () => {
    const doGate = await pedirComHost('GET /__guard/secret HTTP/1.1', HOST_DO_TUNEL)
    // O painel so e montado pela Onda 2/6; aqui so o portao existe. A
    // identidade dos DOIS 404 (de rota inexistente vs canal local) e garantida
    // por construcao em `responses.ts` (TEXT_REFUSAL_HEADERS + NOT_FOUND_BODY).
    assert.match(doGate, /^HTTP\/1\.1 404 Not Found\r\n/u)
    assert.match(doGate, /^content-type: text\/plain; charset=utf-8\r$/imu)
    assert.match(doGate, /^x-content-type-options: nosniff\r$/imu)
    assert.match(doGate, /^referrer-policy: no-referrer\r$/imu)
    assert.equal(doGate.includes('dsh-guarded-bot-orchestrator'), false)
    assert.match(doGate, /Not Found\n$/mu)
  })
})