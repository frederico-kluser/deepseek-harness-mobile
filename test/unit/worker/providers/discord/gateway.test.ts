/**
 * `worker/providers/discord/gateway.ts` — o loop do gateway sobre o WebSocket
 * NATIVO do Node contra o duble local (gateway WS de verdade em `node:http`).
 *
 * Cobre: Hello -> Identify -> READY (com o token e os intents no identify),
 * heartbeat periodico com ACK (op 11), resume apos close recuperavel (4000),
 * invalid session (op 9) e reconnect (op 7), 4004 FATAL (zero reconexoes),
 * 401 no GET /gateway/bot FATAL, e BOOT_TIMEOUT quando o servidor nao responde.
 *
 * O tempo do gateway e REAL por necessidade (timers do WebSocket): os
 * intervalos sao pequenos e as esperas passam por `aguardar`.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'

import {
  CLOSE,
  iniciarGateway,
  INTENTS,
  OP,
} from '../../../../../worker/providers/discord/gateway.ts'
import { criarClienteDiscord } from '../../../../../worker/providers/discord/cliente.ts'
import { captureLog, startFakeDiscord, TOKEN_DE_TESTE, type FakeDiscord } from './apoio.ts'
import { OWNER_CHANNEL, OWNER_SNOWFLAKE } from '../../../../support/fixtures/discord/updates.ts'

const abertos: FakeDiscord[] = []
const servidoresMudos: Server[] = []
after(async () => {
  await Promise.all(abertos.map((srv) => srv.close()))
  for (const srv of servidoresMudos) {
    srv.closeAllConnections()
    srv.close()
    await once(srv, 'close').catch(() => undefined)
  }
})

/** Um servidor que completa o handshake 101 mas NUNCA manda o Hello. */
async function startServidorMudoWs(): Promise<{ url: string; close(): Promise<void> }> {
  // O frameamento do spike e importado DINAMICAMENTE (o mesmo padrao do
  // apoio: `ws-frame.mjs` nao tem declaracao de tipos e o `allowJs` esta
  // desligado; o especificador calculado devolve `any`).
  const wsFrame = (await import(
    new URL('../../../../../scripts/spike/cloudflared/lib/ws-frame.mjs', import.meta.url).href
  )) as {
    FrameParser: new () => { push(chunk: Buffer): Array<{ opcode: number; payload: Buffer }> }
    encodeClose(code: number, reason?: string): Buffer
  }
  const server = createServer((_req, res) => res.destroy())
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => undefined)
    // 1) O 101 TEM de sair: sem ele o WebSocket do undici fica CONNECTING e o
    // socket TCP segura o event loop do runner para sempre. 2) O Hello NAO
    // sai (e o ponto do teste: o prazo de boot dispara). 3) O close handshake
    // do cliente e COMPLETADO — o undici precisa do frame de volta para
    // fechar o TCP apos o `close()` do gateway.
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const parser = new wsFrame.FrameParser()
    socket.on('data', (chunk) => {
      for (const frame of parser.push(chunk)) {
        if (frame.opcode === 0x8 /* close */) {
          socket.end(wsFrame.encodeClose(1000, 'ok'))
        }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  const porta = typeof addr === 'object' && addr !== null ? addr.port : 0
  servidoresMudos.push(server)
  return {
    url: `ws://127.0.0.1:${porta}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close').catch(() => undefined)
    },
  }
}

/** Espera real curta (o gateway usa timers reais). */
async function aguardar(condicao: () => boolean, descricao: string, prazoMs = 5000): Promise<void> {
  const fim = Date.now() + prazoMs
  while (!condicao()) {
    if (Date.now() > fim) throw new Error(`prazo esgotado a espera de: ${descricao}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function bancada(opcoes: { gatewayHeartbeatMs?: number } = {}) {
  return startFakeDiscord({ gatewayHeartbeatMs: opcoes.gatewayHeartbeatMs ?? 100_000 })
}

describe('provider/discord/gateway — hello -> identify -> ready', () => {
  it('identify carrega o token e os intents; READY chega ao onDispatch', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })
    const recebidos: unknown[] = []

    const roda = iniciarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, jitter: () => 0, backoffMs: [10] },
      (p) => recebidos.push(p),
    )
    await aguardar(() => srv.gatewayState.identify.length >= 1, 'o identify chega ao duble')
    await aguardar(() => srv.gatewayState.sessions >= 1, 'o READY do duble chega')

    const identify = srv.gatewayState.identify[0]
    assert.ok(identify !== undefined)
    assert.equal(identify['token'], TOKEN_DE_TESTE)
    const intents = identify['intents']
    assert.equal(typeof intents, 'number')
    assert.equal((intents as number) & INTENTS.GUILD_MESSAGES, INTENTS.GUILD_MESSAGES, 'GUILD_MESSAGES presente')
    assert.equal((intents as number) & INTENTS.DIRECT_MESSAGES, INTENTS.DIRECT_MESSAGES)
    assert.equal((intents as number) & INTENTS.MESSAGE_CONTENT, INTENTS.MESSAGE_CONTENT)
    assert.ok(recebidos.some((p) => (p as { t?: string }).t === 'READY'))

    roda.parar()
    const outcome = await roda.outcome
    assert.equal(outcome.kind, 'stopped')
  })
})

describe('provider/discord/gateway — heartbeat', () => {
  it('heartbeat periodico: envia op 1 e o duble responde op 11 (o worker segue vivo)', async () => {
    const srv = await bancada({ gatewayHeartbeatMs: 80 })
    abertos.push(srv)
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    const roda = iniciarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, jitter: () => 0, backoffMs: [10], heartbeatGrace: 3 },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY')
    await aguardar(() => srv.gatewayState.heartbeats >= 2, 'dois heartbeats com ack')

    roda.parar()
    const outcome = await roda.outcome
    assert.equal(outcome.kind, 'stopped')
    assert.equal(log.lines.some((l) => l.includes('identify enviado')), true)
  })
})

describe('provider/discord/gateway — resume e reconexao', () => {
  it('close 4000 (recuperavel): reconecta e RESUME com o MESMO session_id', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    const roda = iniciarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, jitter: () => 0, backoffMs: [20] },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao (identify)')

    srv.fecharGateway(4000, 'rede caiu')
    await aguardar(() => srv.gatewayState.resumes.length >= 1, 'o resume chega ao duble')

    const resume = srv.gatewayState.resumes[0]
    assert.ok(resume !== undefined)
    assert.equal(resume['session_id'], 'sessao-do-duble')
    assert.equal(resume['token'], TOKEN_DE_TESTE)

    roda.parar()
    const outcome = await roda.outcome
    assert.equal(outcome.kind, 'stopped')
  })

  it('invalid session com d=false: morre a sessao e a proxima conexao IDENTIFICA de novo', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    const roda = iniciarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, jitter: () => 0, backoffMs: [20] },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao')

    srv.enviarRaw({ op: OP.INVALID_SESSION, d: false })
    await aguardar(() => srv.gatewayState.identify.length >= 2, 'segundo identify (a sessao morreu)')

    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
  })

  it('reconnect (op 7): o servidor manda fechar; o worker resume a sessao', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    const roda = iniciarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, jitter: () => 0, backoffMs: [20] },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao')

    srv.enviarRaw({ op: OP.RECONNECT, d: null })
    await aguardar(() => srv.gatewayState.resumes.length >= 1, 'resume apos reconnect')

    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
  })

  it('mensagens entre reconexoes: apos o RESUMED o dispatch segue a chegar', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })
    const recebidos: unknown[] = []

    const roda = iniciarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, jitter: () => 0, backoffMs: [20] },
      (p) => recebidos.push(p),
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao')
    srv.fecharGateway(4000)
    await aguardar(() => srv.gatewayState.resumes.length >= 1, 'resume')
    srv.enfileirarEvento({
      t: 'MESSAGE_CREATE',
      d: { id: 'm1', channel_id: OWNER_CHANNEL, author: { id: OWNER_SNOWFLAKE }, content: '/status' },
    })
    await aguardar(
      () => recebidos.some((p) => (p as { t?: string }).t === 'MESSAGE_CREATE'),
      'dispatch apos resume',
    )

    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
  })
})

describe('provider/discord/gateway — vereditos fatais', () => {
  it('close 4004 (authentication failed): FATAL GATEWAY_UNAUTHORIZED, zero reconexoes', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    const roda = iniciarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, jitter: () => 0, backoffMs: [10] },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao')

    srv.fecharGateway(CLOSE.AUTHENTICATION_FAILED, 'token errado')
    const outcome = await roda.outcome
    assert.equal(outcome.kind, 'fatal')
    if (outcome.kind === 'fatal') {
      assert.equal(outcome.code, 'GATEWAY_UNAUTHORIZED')
      assert.equal(outcome.exitCode, 12)
    }
    assert.equal(srv.gatewayState.identify.length, 1, 'uma unica tentativa: zero reconexoes')
  })

  it('401 no GET /gateway/bot: FATAL sem sequer abrir o websocket', async () => {
    const srv = await bancada()
    abertos.push(srv)
    srv.queueError('gateway', { status: 401, body: { message: '401: Unauthorized', code: 0 } })
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    const roda = iniciarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, jitter: () => 0, backoffMs: [10] },
      () => undefined,
    )
    const outcome = await roda.outcome
    assert.equal(outcome.kind, 'fatal')
    if (outcome.kind === 'fatal') assert.equal(outcome.code, 'GATEWAY_UNAUTHORIZED')
    assert.equal(srv.gatewayState.sessions, 0, 'nenhuma sessao chegou a nascer')
  })

  it('BOOT_TIMEOUT: servidor que nunca responde Hello -> fatal BOOT_TIMEOUT (exit 14)', async () => {
    const mudo = await startServidorMudoWs()
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: 'http://127.0.0.1:1', log: log.logger })

    const roda = iniciarGateway(
      {
        token: TOKEN_DE_TESTE,
        log: log.logger,
        cliente,
        gatewayUrl: mudo.url,
        jitter: () => 0,
        backoffMs: [10],
        bootTimeoutMs: 400,
      },
      () => undefined,
    )
    const outcome = await roda.outcome
    assert.equal(outcome.kind, 'fatal')
    if (outcome.kind === 'fatal') {
      assert.equal(outcome.code, 'BOOT_TIMEOUT')
      assert.equal(outcome.exitCode, 14)
    }
    await mudo.close()
  })
})

describe('provider/discord/gateway — eventos para o onDispatch', () => {
  it('MESSAGE_CREATE chega CRU ao onDispatch; o op 11 (ack) nunca vira dispatch', async () => {
    const srv = await bancada({ gatewayHeartbeatMs: 60 })
    abertos.push(srv)
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })
    const recebidos: unknown[] = []

    const roda = iniciarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, jitter: () => 0, backoffMs: [10] },
      (p) => recebidos.push(p),
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY')
    await aguardar(() => srv.gatewayState.heartbeats >= 1, 'primeiro heartbeat (e o seu ack)')
    srv.enfileirarEvento({
      t: 'MESSAGE_CREATE',
      d: { id: 'm2', channel_id: OWNER_CHANNEL, author: { id: OWNER_SNOWFLAKE }, content: '/status' },
    })
    await aguardar(
      () => recebidos.some((p) => (p as { t?: string }).t === 'MESSAGE_CREATE'),
      'dispatch entregue',
    )

    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
    assert.equal(
      recebidos.some((p) => (p as { op?: number }).op === OP.HEARTBEAT_ACK),
      false,
      'op 11 nao e op 0: o ACK nao vira dispatch',
    )
  })
})
