/**
 * `src/tunnel/proxy.ts` -- o PROXY do tunel (modelo expose-port).
 *
 * Prova o modelo PORTA vs UPSTREAM com servidores REAIS em loopback:
 *
 *   (a) `Host: 127.0.0.1:3080` FORJADO pelo tunel sem credencial -> 401 (BLOCK);
 *   (b) `Host` legitimo do tunel sem credencial -> 401 sem `WWW-Authenticate`;
 *   (c) `?key=` valida -> 302 + Set-Cookie + URL limpa, e a chave e reutilizavel;
 *   (d) sessao -> 200, encaminhado para o upstream;
 *   (e) WebSocket: sessao -> encaminha; sem sessao -> recusa sem desafio;
 *   (f) rotate revoga a chave e a sessao -> 401;
 *   (g) o UPSTREAM (porta do DSH) responde 200 direto, SEM gate.
 */

import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { createTunnelProxy, type TunnelProxy } from '../../../src/tunnel/proxy.ts'
import { bancada, FAKE_TUNNEL_ORIGIN, type Bancada } from '../http/bancada.ts'

const HOST_DO_TUNEL = 'marks-organization-moved-coupons.trycloudflare.com'

let aberta: Bancada | undefined
let upstream: Server | undefined
let proxy: TunnelProxy | undefined

function hostDoTunel(): string {
  return HOST_DO_TUNEL
}

async function ouvir(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

interface Resposta {
  status: number
  body: string
  challenge: string | undefined
  location: string | undefined
  setCookie: string | undefined
}

/** Um pedido ao PROXY (como o cloudflared entregaria), com o `Host` escolhido. */
function pedirAoProxy(port: number, path: string, host: string, headers: Record<string, string> = {}): Promise<Resposta> {
  return new Promise<Resposta>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host, ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (d) => void chunks.push(Buffer.from(d)))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            challenge: res.headers['www-authenticate'],
            location: typeof res.headers['location'] === 'string' ? res.headers['location'] : undefined,
            setCookie: Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : undefined,
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function setUpProxy(): Promise<{ proxyPort: number; upstreamPort: number }> {
  aberta = bancada({ comSegredo: true, tunnelReady: true })
  aberta.tunnelOrigin.publish(FAKE_TUNNEL_ORIGIN)

  // O UPSTREAM = o servidor do DSH, que responde direto (SEM gate).
  upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('UPSTREAM-OK')
  })
  upstream.on('upgrade', (_req, socket: Duplex) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.end()
  })
  const upstreamPort = await ouvir(upstream)

  proxy = createTunnelProxy({
    ctx: aberta.ctx.asContext(),
    log: aberta.gate.log,
    config: aberta.config,
    auth: aberta.gate.auth,
    tunnelOrigin: aberta.tunnelOrigin,
    linkToken: aberta.gate.linkToken,
    issueSession: aberta.gate.issueSession,
    upstreamPort,
  })
  // O `listen(0)` do proxy e assincrono: espera ate a porta estar assignada.
  await ateFixar(proxy.server)
  return { proxyPort: (proxy.server.address() as AddressInfo).port, upstreamPort }
}

/** Espera ativamente ate o servidor estar a escutar (porta assignada). */
function ateFixar(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (server.listening && server.address() !== null) {
      resolve()
      return
    }
    const t = setInterval(() => {
      if (server.listening && server.address() !== null) {
        clearInterval(t)
        resolve()
      }
    }, 2)
    server.once('error', reject)
  })
}

afterEach(() => {
  proxy?.dispose()
  proxy = undefined
  upstream?.close()
  upstream = undefined
  aberta?.cleanup()
  aberta = undefined
})

describe('MODELO PORTA: o proxy do tunel (modelo expose-port)', () => {
  it('(a) BLOCK: Host: 127.0.0.1:3080 FORJADO pelo tunel, sem credencial -> 401', async () => {
    const { proxyPort } = await setUpProxy()
    const res = await pedirAoProxy(proxyPort, '/', '127.0.0.1:3080')
    assert.equal(res.status, 401, 'o Host loopback forjado NAO abre o proxy')
    assert.equal(res.challenge, undefined)
    assert.equal(res.body.includes('UPSTREAM-OK'), false, 'nada chegou ao upstream')
  })

  it('(b) Host legitimo do tunel, sem credencial -> 401 sem WWW-Authenticate', async () => {
    const { proxyPort } = await setUpProxy()
    const res = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel())
    assert.equal(res.status, 401)
    assert.equal(res.challenge, undefined, 'sem popup')
    assert.equal(res.body.includes('UPSTREAM-OK'), false)
  })

  it('(c) `?key=` valida -> 302 + Set-Cookie + URL limpa, e a chave e REUTILIZAVEL', async () => {
    const { proxyPort } = await setUpProxy()
    const { token } = aberta!.linkStore.emitir()

    const res = await pedirAoProxy(proxyPort, `/?key=${token}`, hostDoTunel(), { 'x-forwarded-proto': 'https' })
    assert.equal(res.status, 302)
    assert.equal(res.location, '/', 'a URL limpa nao leva a chave')
    assert.ok((res.setCookie ?? '').startsWith('__Host-dsh_sid='), 'a chave troca por sessao')
    assert.equal(res.challenge, undefined)

    // A sessao emitida autoriza a seguir (200 -> upstream).
    const cookie = String(res.setCookie).slice('__Host-dsh_sid='.length).split(';')[0]
    const comSessao = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie: `__Host-dsh_sid=${cookie}` })
    assert.equal(comSessao.status, 200)
    assert.equal(comSessao.body, 'UPSTREAM-OK')

    // A chave permanece valida (nao e de uso unico).
    assert.equal(aberta!.linkStore.verificar(token), true)
  })

  it('(d) sessao valida -> 200 encaminhado ao upstream', async () => {
    const { proxyPort } = await setUpProxy()
    const cookie = aberta!.emitirSessao()
    const res = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'UPSTREAM-OK', 'o proxy encaminhou para o upstream')
  })

  it('(g) o UPSTREAM (porta do DSH) responde 200 direto, SEM gate', async () => {
    const { upstreamPort } = await setUpProxy()
    const res = await pedirAoProxy(upstreamPort, '/', '127.0.0.1:3080')
    assert.equal(res.status, 200, 'o servidor do DSH fica ABERTO (expose-port)')
    assert.equal(res.body, 'UPSTREAM-OK')
    assert.equal(res.challenge, undefined)
  })

  it('(f) rotate revoga a chave E a sessao -> os dois viram 401', async () => {
    const { proxyPort } = await setUpProxy()
    const { token } = aberta!.linkStore.emitir()
    const cookie = aberta!.emitirSessao()

    // Rotacao revoga a chave do link e todas as sessoes (SECRET-008).
    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()

    const porChave = await pedirAoProxy(proxyPort, `/?key=${token}`, hostDoTunel(), { 'x-forwarded-proto': 'https' })
    assert.equal(porChave.status, 401, 'a chave revogada nao autentica')

    const porSessao = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie })
    assert.equal(porSessao.status, 401, 'a sessao revogada nao autentica')
  })
})

describe('WebSocket no proxy (modelo porta)', () => {
  it('(e) sem sessao: recusa 401 sem desafio no socket cru', async () => {
    const { proxyPort } = await setUpProxy()
    const bruto = await empurrarUpgrade(proxyPort, hostDoTunel(), undefined)
    assert.match(bruto, /^HTTP\/1\.1 401 /u)
    assert.equal(bruto.includes('WWW-Authenticate'), false)
    assert.equal(bruto.includes('101 Switching Protocols'), false, 'nao sobe de forma alguma')
  })

  it('(e) com sessao: encaminha o handshake (101) para o upstream', async () => {
    const { proxyPort } = await setUpProxy()
    const cookie = aberta!.emitirSessao()
    const bruto = await empurrarUpgrade(proxyPort, hostDoTunel(), cookie)
    assert.match(bruto, /^HTTP\/1\.1 101 /u)
    assert.equal(bruto.includes('101 Switching Protocols'), true)
  })
})

/** Sobe um handshake cru de WebSocket e devolve a resposta bruta lida. */
function empurrarUpgrade(port: number, host: string, cookie: string | undefined): Promise<string> {
  return new Promise<string>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      const extra = cookie === undefined ? '' : `Cookie: ${cookie}\r\n`
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${FAKE_TUNNEL_ORIGIN}\r\n${extra}\r\n`,
      )
    })
    const pedacos: Buffer[] = []
    const tarde = (): void => resolve(Buffer.concat(pedacos).toString('utf8'))
    socket.on('data', (d: Buffer) => {
      pedacos.push(d)
      const texto = Buffer.concat(pedacos).toString('utf8')
      // Resolve quando a resposta HTTP esta completa (status + cabecalhos).
      if (/HTTP\/1\.1 1\d\d/mu.test(texto) || /HTTP\/1\.1 4\d\d/mu.test(texto)) resolve(texto)
    })
    socket.on('error', tarde)
    socket.on('end', tarde)
  })
}