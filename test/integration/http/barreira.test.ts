/**
 * =============================================================================
 * A BARREIRA CONTRA SOCKETS REAIS -- os TRES caminhos, com requisicoes de rede.
 * =============================================================================
 *
 * Reproduz, dentro da suite, as quatro fases do laboratorio de S12
 * (`scripts/spike/intercept/`):
 *
 *   A  linha de base, sem barreira                       -> 200 / upgrade
 *   B  barreira instalada DEPOIS de todos os registos    -> 401
 *   C  barreira instalada, com credencial valida         -> 200 / upgrade
 *   D  disposer sincrono executado                       -> volta a A
 *
 * A superficie imita a composicao Web medida: uma rota `exact`, dois prefixos
 * nomeados (`/api`, `/plugins`), o assento de fallback (a SPA) e um upgrade. O
 * `node:http.Server` E real e ESTA A ESCUTAR: e a unica forma de provar que o
 * caminho `upgrade` do Node passa mesmo pelo nosso listener.
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'

import { apply } from '../../../src/index.ts'
import { FakeContext } from '../../support/ctx-double.ts'
import { EFFECT, makeConfig, VALID_CREDENTIAL, WRONG_CREDENTIAL } from '../../support/fixtures.ts'

const ctx = new FakeContext()
let port = 0

/**
 * RAIZ DE ESTADO DESCARTAVEL, e nao a do utilizador.
 *
 * `apply()` nao toca no disco -- a pilha de autenticacao e montada no PRIMEIRO
 * pedido. Mas este ficheiro FAZ pedidos, logo a pilha nasce mesmo: sem estas
 * duas variaveis, correr a suite escreveria `state.json` e `audit.log` em
 * `~/.dsh` da maquina de quem a corre. O `node --test` da a cada ficheiro o seu
 * proprio processo, logo isto nao contamina mais nenhum.
 */
const stateRoot = mkdtempSync(join(tmpdir(), 'dsh-guard-barreira-'))
process.env['DSH_HOME'] = stateRoot
process.env['DSH_GUARD_AUDIT_LOG'] = join(stateRoot, 'audit.log')

/** As rotas que o "resto do DSH" serve por baixo do despacho. */
function router(url: string): { status: number; body: string } {
  if (url.startsWith('/api')) return { status: 200, body: '{"rota":"api"}' }
  if (url.startsWith('/plugins')) return { status: 200, body: '{"rota":"plugins"}' }
  if (url === '/__dsh_invariant_probe__') return { status: 200, body: 'probe' }
  return { status: 200, body: '<html>SPA</html>' } // assento de fallback
}

interface Resposta {
  status: number
  challenge: string | undefined
}

function pedir(path: string, authorization?: string): Promise<Resposta> {
  return new Promise<Resposta>((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (authorization !== undefined) headers['authorization'] = authorization

    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume()
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          challenge: res.headers['www-authenticate'],
        }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

interface RespostaUpgrade {
  resultado: 'upgrade' | 'resposta'
  status: number
}

function pedirUpgrade(path: string, authorization?: string): Promise<RespostaUpgrade> {
  return new Promise<RespostaUpgrade>((resolve, reject) => {
    const headers: Record<string, string> = { connection: 'Upgrade', upgrade: 'websocket' }
    if (authorization !== undefined) headers['authorization'] = authorization

    let settled = false
    const req = request({ host: '127.0.0.1', port, path, headers })

    req.on('upgrade', (_res, socket) => {
      settled = true
      socket.destroy()
      resolve({ resultado: 'upgrade', status: 101 })
    })
    req.on('response', (res) => {
      settled = true
      res.resume()
      resolve({ resultado: 'resposta', status: res.statusCode ?? 0 })
    })
    req.on('error', (error) => {
      if (!settled) reject(error)
    })
    req.end()
  })
}

before(async () => {
  ctx.webServer.onRequest = (req, res): void => {
    const { status, body } = router(req.url ?? '/')
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(body)
  }
  ctx.webServer.onUpgrade = (_req, socket): void => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  }

  await new Promise<void>((resolve) => {
    ctx.webServer.server.listen(0, '127.0.0.1', resolve)
  })
  port = (ctx.webServer.server.address() as AddressInfo).port
})

after(async () => {
  for (const disposer of [...ctx.effects].reverse()) disposer()
  await new Promise<void>((resolve) => {
    ctx.webServer.server.close(() => resolve())
  })
  rmSync(stateRoot, { recursive: true, force: true })
})

describe('FASE A -- linha de base, sem barreira', () => {
  it('as quatro superficies respondem sem credencial nenhuma', async () => {
    assert.equal((await pedir('/')).status, 200, 'fallback (SPA)')
    assert.equal((await pedir('/api/state')).status, 200, 'rota nomeada por prefixo')
    assert.equal((await pedir('/__dsh_invariant_probe__')).status, 200, 'rota nomeada exact')
    assert.deepEqual(await pedirUpgrade('/api/events.mux'), { resultado: 'upgrade', status: 101 })
  })
})

describe('FASE B -- barreira instalada DEPOIS de todos os registos', () => {
  it('instala-se sem exigencia de ordem de carregamento', () => {
    // O servidor ja esta a escutar e ja tem todo o despacho montado. E este o
    // cenario que refuta a exigencia de ordem que o codigo antigo avisava.
    apply(ctx.asContext(), makeConfig())
    // veto + auth-check + barreira + controlador (T5.1) + worker.
    assert.equal(ctx.effects.length, 5)
  })

  // ONDA 1 (remocao do login): a barreira de credencial vive na superficie do
  // TUNEL, nao no loopback. Estes pedidos usam `Host: 127.0.0.1` (o bind
  // local) e por isso a Onda 1 abre-os DIRETO, sem desafio. A barreira do
  // TUNEL (401 sem `WWW-Authenticate`) e provada em test/integration/http/
  // tunel.test.ts e test/security/*. Aqui o que se prende e que o ACESSO LOCAL
  // abre e NUNCA emite `WWW-Authenticate`.

  it('o ACESSO LOCAL abre e NAO emite WWW-Authenticate', async () => {
    const assento = await pedir('/')
    assert.equal(assento.status, 200, 'o acesso local abre direto (onda 1)')
    assert.equal(assento.challenge, undefined, 'nenhum desafio no acesso local')
    assert.equal((await pedir('/api/state')).status, 200)
    assert.equal((await pedir('/plugins/x')).status, 200)
    assert.equal((await pedir('/__dsh_invariant_probe__')).status, 200)
  })

  it('o HANDSHAKE DE UPGRADE local abre', async () => {
    assert.deepEqual(await pedirUpgrade('/api/events.mux'), { resultado: 'upgrade', status: 101 })
  })

  it('as grafias evasivas do caminho abrem localmente (sem oraculo de rota)', async () => {
    assert.equal((await pedir('//api/state')).status, 200)
    assert.equal((await pedir('/API/state')).status, 200)
    assert.equal((await pedir('/%61pi/state')).status, 200)
  })

  it('o acesso local abre mesmo com uma CREDENCIAL errada (a barreira e do tunel)', async () => {
    assert.equal((await pedir('/api/state', `Basic ${WRONG_CREDENTIAL}`)).status, 200)
    assert.equal((await pedir('/api/state', `Basic ${WRONG_CREDENTIAL}`)).challenge, undefined)
  })
})

describe('FASE C -- com credencial valida o trafego chega aos handlers originais', () => {
  it('os tres caminhos voltam a servir', async () => {
    assert.equal((await pedir('/', `Basic ${VALID_CREDENTIAL}`)).status, 200)
    assert.equal((await pedir('/api/state', `Basic ${VALID_CREDENTIAL}`)).status, 200)
    assert.deepEqual(await pedirUpgrade('/api/events.mux', `Basic ${VALID_CREDENTIAL}`), {
      resultado: 'upgrade',
      status: 101,
    })
  })

  it('o esquema `basic` em minusculas e aceite (RFC 7235)', async () => {
    assert.equal((await pedir('/api/state', `basic ${VALID_CREDENTIAL}`)).status, 200)
  })
})

describe('FASE D -- o disposer sincrono devolve o comportamento exato de A', () => {
  it('reverte os tres caminhos de uma vez', async () => {
    const disposer = ctx.effects[EFFECT.barreira]
    assert.equal(typeof disposer, 'function')
    assert.equal(disposer?.(), undefined, 'o disposer da barreira e SINCRONO')

    assert.equal((await pedir('/')).status, 200)
    assert.equal((await pedir('/api/state')).status, 200)
    assert.equal((await pedir('/__dsh_invariant_probe__')).status, 200)
    assert.deepEqual(await pedirUpgrade('/api/events.mux'), { resultado: 'upgrade', status: 101 })
  })
})
