/**
 * TUN-020 a TUN-025 contra um servidor HTTP REAL, em porta EFEMERA.
 *
 * Os testes unitarios de `test/unit/tunnel/probe.test.ts` provam o VEREDITO com
 * um transporte falso. Aqui prova-se o TRANSPORTE: que `createHttpProbeTransport`
 * distingue, sobre sockets de verdade, um `401`, um `101`, um socket destruido
 * pelo tratador de upgrade e um erro de rede. Confundir os dois ultimos ou
 * deixava passar um gate desarmado, ou impedia o tunel de subir com o gate armado.
 *
 * Cada servidor usa `listen(0)`: porta efemera atribuida pelo SO. NUNCA a 3080,
 * NUNCA uma porta fixa, e nunca uma porta que este teste nao tenha aberto.
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { after, describe, it } from 'node:test'

import {
  createHttpProbeTransport,
  runGateProbe,
  type ProbeTransport,
} from '../../../src/tunnel/probe.ts'

const servidores: Server[] = []
after(() => {
  for (const server of servidores) server.close()
})

interface GateBehaviour {
  /** Codigo devolvido a `GET /`. `401` = fallback guardado. */
  raiz?: number
  /** Codigo devolvido a qualquer coisa sob `/api`. */
  api?: number
  /** Codigo devolvido a um caminho desconhecido (o canario). */
  desconhecido?: number
  /** `'destroy'` = o gate recusa o handshake; `'accept'` = completa com 101. */
  upgrade?: 'destroy' | 'accept' | 'reject-401'
}

async function subirGate(behaviour: GateBehaviour): Promise<ProbeTransport> {
  const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const status =
      path === '/'
        ? (behaviour.raiz ?? 401)
        : path.startsWith('/api')
          ? (behaviour.api ?? 401)
          : (behaviour.desconhecido ?? 401)
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end('x')
  })

  server.on('upgrade', (_req: IncomingMessage, socket: Duplex): void => {
    const modo = behaviour.upgrade ?? 'destroy'
    if (modo === 'accept') {
      // Handshake COMPLETO sem credencial nenhuma: e a superficie desarmada.
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      )
      return
    }
    if (modo === 'reject-401') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    }
    // O tratador do gate escreve a recusa CRUA e destroi o socket.
    socket.destroy()
  })

  servidores.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('sem porta')
  assert.notEqual(address.port, 3080, 'nenhum teste desta suite toca na porta do DSH real')

  return createHttpProbeTransport({ host: '127.0.0.1', port: address.port, timeoutMs: 2000 })
}

function correr(transport: ProbeTransport) {
  return runGateProbe({
    transport,
    canaryToken: 'canario-de-integracao',
    signal: new AbortController().signal,
  })
}

describe('TUN-024: gate ARMADO em todas as quatro superficies', () => {
  it('as quatro devolvem 401 (ou socket destruido) e o probe passa', async () => {
    const result = await correr(await subirGate({}))

    assert.equal(result.passed, true, JSON.stringify(result.outcomes))
    assert.deepEqual(
      result.outcomes.map((outcome) => [outcome.probe, outcome.passed]),
      [
        ['spa-fallback', true],
        ['api-rpc', true],
        ['websocket-upgrade', true],
        ['unguarded-canary', true],
      ],
    )
    // Sonda 3: `null` = socket destruido, que e a recusa crua do tratador de upgrade.
    assert.equal(result.outcomes[2]?.status, null)
  })

  it('um gate que responde 401 TAMBEM no upgrade passa (as duas formas valem)', async () => {
    const result = await correr(await subirGate({ upgrade: 'reject-401' }))
    assert.equal(result.passed, true)
  })
})

describe('TUN-020: o fallback da SPA responde 200', () => {
  it('reprova nomeando `spa-fallback`', async () => {
    const result = await correr(await subirGate({ raiz: 200 }))

    assert.equal(result.passed, false)
    assert.equal(result.failure?.probe, 'spa-fallback')
    assert.equal(result.outcomes[0]?.status, 200)
  })
})

describe('TUN-021: o gate cobre `/` mas NAO `/api` — o caso realista', () => {
  it('reprova nomeando `api-rpc`, mesmo com a sonda 1 a passar', async () => {
    // `/` vem do `registerFallback` do frontend estatico e `/api` e um prefixo
    // nomeado de outro pacote. O roteador consulta as tabelas nomeadas ANTES do
    // fallback: provar `/` nao prova `/api`, e foi essa diferenca que expos o
    // DSH real durante ~40 s.
    const result = await correr(await subirGate({ api: 200 }))

    assert.equal(result.outcomes[0]?.passed, true, 'a sonda 1 passa...')
    assert.equal(result.passed, false, '...e mesmo assim o tunel nao sobe')
    assert.equal(result.failure?.probe, 'api-rpc')
  })
})

describe('TUN-022: o handshake de WebSocket completa sem credencial', () => {
  it('101 reprova, e o transporte reconhece o upgrade aceite', async () => {
    const result = await correr(await subirGate({ upgrade: 'accept' }))

    assert.equal(result.passed, false)
    assert.equal(result.failure?.probe, 'websocket-upgrade')
    assert.equal(result.outcomes[2]?.status, 101)
  })
})

describe('TUN-023: o canario devolve 404 em vez de 401', () => {
  it('reprova: um 404 significa que o pedido chegou ao roteador', async () => {
    const result = await correr(await subirGate({ desconhecido: 404 }))

    assert.equal(result.passed, false)
    assert.equal(result.failure?.probe, 'unguarded-canary')
    assert.equal(result.outcomes[3]?.status, 404)
    assert.equal(result.failure?.message.includes('sem passar pelo portao'), true)
  })
})

describe('TUN-025: fail-closed no proprio erro de rede', () => {
  it('origem inalcancavel (ninguem a escutar) reprova, e nao lanca', async () => {
    // Uma porta que ninguem serve: `ECONNREFUSED` ANTES de a ligacao existir.
    // Isto NAO pode ser lido como "socket destruido pelo gate".
    const transport = createHttpProbeTransport({ host: '127.0.0.1', port: 1, timeoutMs: 500 })

    const result = await correr(transport)

    assert.equal(result.passed, false)
    assert.equal(
      result.outcomes.every((outcome) => !outcome.passed && outcome.status === null),
      true,
    )
    // Nem sequer a sonda 3, que aceita socket destruido, pode passar aqui: a
    // ligacao nunca chegou a estabelecer-se, logo nao houve medicao nenhuma.
    assert.equal(result.outcomes[2]?.passed, false)
  })

  it('origem que aceita a ligacao e nunca responde: timeout reprova', async () => {
    const server = createServer(() => {
      // Aceita e cala-se: e o modo de falha em que "nao consegui medir" tentaria
      // virar "entao deixa subir".
    })
    servidores.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('sem porta')

    const result = await correr(
      createHttpProbeTransport({ host: '127.0.0.1', port: address.port, timeoutMs: 150 }),
    )

    assert.equal(result.passed, false)
  })
})
