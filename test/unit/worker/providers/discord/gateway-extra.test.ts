/**
 * `worker/providers/discord/gateway.ts` — os vereditos e o batimento que o
 * `gateway.test.ts` nao cobre (2.a leva): close codes INDIVIDUAIS (4013/4014
 * fatais; 1000/1001 invalidam a sessao; 1006/4009 retomam), invalid session
 * com d=true, o `seq` no resume e no heartbeat, o backoff real com escalada
 * e teto, a recuperacao de 429 no GET /gateway/bot, a rede no /gateway/bot
 * (backoff ate BOOT_TIMEOUT), o zombie (heartbeat sem ack), e a escolha da
 * `resume_gateway_url` do READY.
 *
 * Como no `gateway.test.ts`: o tempo do websocket e REAL (intervalos pequenos,
 * esperas por `aguardar`); o `sleep` do backoff e o UNICO tempo injetavel
 * (FakeTime) e e usado num teste proprio. Rode este ficheiro SOZINHO (ou com
 * poucos ficheiros) — como o irmao `gateway.test.ts`, pendura em lotes grandes.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'

import {
  CLOSE,
  DEFAULT_BACKOFF_MS,
  iniciarGateway,
  OP,
} from '../../../../../worker/providers/discord/gateway.ts'
import { criarClienteDiscord } from '../../../../../worker/providers/discord/cliente.ts'
import { captureLog, FakeTime, startFakeDiscord, TOKEN_DE_TESTE, type FakeDiscord } from './apoio.ts'

const abertos: FakeDiscord[] = []
const servidoresMedidos: Server[] = []
const rodasVivas: Array<{ parar: () => void; outcome: Promise<unknown> }> = []
after(async () => {
  // Mesmo quando um assert falhou no meio do teste: um gateway vivo (socket +
  // heartbeats) seguraria o event loop do runner para sempre.
  for (const roda of rodasVivas) roda.parar()
  await Promise.all(rodasVivas.map((roda) => roda.outcome.catch(() => undefined)))
  await Promise.all(abertos.map((srv) => srv.close()))
  for (const srv of servidoresMedidos) {
    srv.closeAllConnections()
    srv.close()
    await once(srv, 'close').catch(() => undefined)
  }
})

/** Cria o loop com registo no `after` (para o parar de seguranca). */
function ligarGateway(deps: Parameters<typeof iniciarGateway>[0], onDispatch: (payload: unknown) => void) {
  const roda = iniciarGateway(deps, onDispatch)
  rodasVivas.push(roda)
  return roda
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

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

/** O cliente REST do duble, com o logger. */
function clienteDo(srv: FakeDiscord) {
  return criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: captureLog().logger })
}

interface FrameDoCliente {
  readonly opcode: number
  readonly payload: Buffer
}

interface ModuloWsFrame {
  FrameParser: new () => { push(chunk: Buffer): FrameDoCliente[] }
  encodeText(payload: string): Buffer
  encodeClose(code: number, reason?: string): Buffer
}

let modWsFrame: ModuloWsFrame | undefined
async function importWsFrame(): Promise<ModuloWsFrame> {
  if (modWsFrame === undefined) {
    modWsFrame = (await import(
      new URL('../../../../../scripts/spike/cloudflared/lib/ws-frame.mjs', import.meta.url).href
    )) as ModuloWsFrame
  }
  return modWsFrame
}

/**
 * Servidor gateway SOB MEDIDA: regista os caminhos dos upgrades, os identifies,
 * os resumes e os heartbeats (com o `d` que o cliente mandou); pode NAO
 * confirmar heartbeats (zombie), responder a op 1 e ser fechado com qualquer
 * close code. O READY devolve um `resume_gateway_url` proprio (`/resume`).
 */
interface GatewayMedido {
  readonly url: string
  readonly upgradePaths: string[]
  readonly identifies: Array<Record<string, unknown>>
  readonly resumes: Array<Record<string, unknown>>
  readonly heartbeats: Array<{ d: unknown }>
  enviar(payload: Record<string, unknown>): void
  fechar(code: number, motivo?: string): void
  close(): Promise<void>
}

async function startGatewayMedido(
  opcoes: { heartbeatMs?: number; acksHeartbeats?: boolean } = {},
): Promise<GatewayMedido> {
  const wsFrame = await importWsFrame()
  const heartbeatMs = opcoes.heartbeatMs ?? 100_000
  const acks = opcoes.acksHeartbeats ?? true

  const upgradePaths: string[] = []
  const identifies: Array<Record<string, unknown>> = []
  const resumes: Array<Record<string, unknown>> = []
  const heartbeats: Array<{ d: unknown }> = []
  let socketAtivo: Duplex | undefined
  let seq = 0

  const server = createServer((_req, res) => res.destroy())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  const porta = typeof addr === 'object' && addr !== null ? addr.port : 0
  const url = `ws://127.0.0.1:${porta}`
  servidoresMedidos.push(server)

  server.on('upgrade', (req, socket) => {
    upgradePaths.push(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socketAtivo = socket
    socket.on('error', () => undefined)

    const enviar = (payload: Record<string, unknown>): void => {
      if (socket.writable) socket.write(wsFrame.encodeText(JSON.stringify(payload)))
    }

    const tratarFrame = (frame: FrameDoCliente): void => {
      if (frame.opcode === 0x8 /* close */) {
        // Ecoa o MESMO close code do cliente: o undici reporta no evento
        // 'close' o code da frame que RECEBE (1000 invalidaria a sessao).
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000
        socket.end(wsFrame.encodeClose(code, 'ok'))
        return
      }
      if (frame.opcode !== 0x1 /* text */) return
      let json: { op?: number; d?: unknown }
      try {
        json = JSON.parse(frame.payload.toString('utf8')) as { op?: number; d?: unknown }
      } catch {
        return
      }
      const op = json.op
      if (op === 1) {
        heartbeats.push({ d: json.d })
        if (acks) enviar({ op: 11, d: null })
        return
      }
      if (op === 2) {
        identifies.push((json.d ?? {}) as Record<string, unknown>)
        seq += 1
        enviar({
          op: 0,
          t: 'READY',
          s: seq,
          d: {
            session_id: 'sessao-medida',
            resume_gateway_url: `ws://127.0.0.1:${porta}/resume`,
            user: { id: '1300000000000000001', username: 'bot', bot: true },
          },
        })
        return
      }
      if (op === 6) {
        resumes.push((json.d ?? {}) as Record<string, unknown>)
        seq += 1
        enviar({ op: 0, t: 'RESUMED', s: seq, d: {} })
        return
      }
    }

    const parser = new wsFrame.FrameParser()
    socket.on('data', (chunk) => {
      for (const frame of parser.push(chunk)) tratarFrame(frame)
    })
    enviar({ op: 10, d: { heartbeat_interval: heartbeatMs } })
  })

  return {
    url,
    upgradePaths,
    identifies,
    resumes,
    heartbeats,
    enviar: (payload) => {
      const socket = socketAtivo
      if (socket !== undefined && socket.writable) socket.write(wsFrame.encodeText(JSON.stringify(payload)))
    },
    fechar: (code, motivo = 'fechado pelo servidor medido') => {
      const socket = socketAtivo
      if (socket !== undefined) socket.end(wsFrame.encodeClose(code, motivo))
    },
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close').catch(() => undefined)
    },
  }
}

describe('provider/discord/gateway — close codes fatais (individualmente)', () => {
  for (const [code, nome] of [
    [CLOSE.INVALID_INTENTS, '4013 (intents invalidos)'],
    [CLOSE.DISALLOWED_INTENTS, '4014 (intent privilegiado nao aprovado)'],
  ] as const) {
    it(`close ${nome}: FATAL GATEWAY_UNAUTHORIZED exit 12, zero reconexoes`, async () => {
      const srv = await bancada()
      abertos.push(srv)
      const log = captureLog()
      const roda = ligarGateway(
        { token: TOKEN_DE_TESTE, log: log.logger, cliente: clienteDo(srv), jitter: () => 0, backoffMs: [10] },
        () => undefined,
      )
      await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao')
      srv.fecharGateway(code, 'veredito do servidor')
      const outcome = await roda.outcome
      assert.equal(outcome.kind, 'fatal')
      if (outcome.kind === 'fatal') {
        assert.equal(outcome.code, 'GATEWAY_UNAUTHORIZED')
        assert.equal(outcome.exitCode, 12)
      }
      assert.equal(srv.gatewayState.identify.length, 1, 'uma unica tentativa: zero reconexoes')
      assert.match(log.all(), new RegExp(`close ${String(code)}`, 'u'), 'a causa nomeia o close')
    })
  }
})

describe('provider/discord/gateway — 1000/1001 invalidam a sessao', () => {
  it('close 1000: a sessao e INVALIDADA — a proxima conexao IDENTIFICA de novo', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const roda = ligarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente: clienteDo(srv), jitter: () => 0, backoffMs: [20] },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao')
    srv.fecharGateway(CLOSE.NORMAL, 'fim normal')
    await aguardar(() => srv.gatewayState.identify.length >= 2, 'segundo identify (a sessao morreu)')
    assert.equal(srv.gatewayState.resumes.length, 0, '1000 nao retoma: invalida a sessao')
    assert.ok(log.lines.some((l) => l.includes('sessao foi invalidada')))
    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
  })

  it('close 1001 (going away): mesmo tratamento do 1000 — identify novo', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const roda = ligarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente: clienteDo(srv), jitter: () => 0, backoffMs: [20] },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao')
    srv.fecharGateway(CLOSE.GOING_AWAY, 'bye')
    await aguardar(() => srv.gatewayState.identify.length >= 2, 'segundo identify')
    assert.equal(srv.gatewayState.resumes.length, 0)
    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
  })
})

describe('provider/discord/gateway — close codes recuperaveis (resume)', () => {
  for (const code of [CLOSE.ABNORMAL, CLOSE.SESSION_TIMED_OUT]) {
    it(`close ${String(code)}: a sessao e retomada (resume) — a sessao vive`, async () => {
      const srv = await bancada()
      abertos.push(srv)
      const log = captureLog()
      const roda = ligarGateway(
        { token: TOKEN_DE_TESTE, log: log.logger, cliente: clienteDo(srv), jitter: () => 0, backoffMs: [20] },
        () => undefined,
      )
      await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao')
      srv.fecharGateway(code, 'queda')
      await aguardar(() => srv.gatewayState.resumes.length >= 1, `resume apos close ${String(code)}`)
      assert.equal(srv.gatewayState.identify.length, 1, 'nunca re-identificou: a sessao continuou')
      roda.parar()
      assert.equal((await roda.outcome).kind, 'stopped')
    })
  }
})

describe('provider/discord/gateway — invalid session com d=true', () => {
  it('op 9 com d=true: a sessao PODE ser retomada — a proxima conexao faz resume', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const roda = ligarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente: clienteDo(srv), jitter: () => 0, backoffMs: [20] },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'primeira sessao')
    srv.enviarRaw({ op: OP.INVALID_SESSION, d: true })
    await aguardar(() => srv.gatewayState.resumes.length >= 1, 'resume (d=true nao mata a sessao)')
    assert.equal(srv.gatewayState.identify.length, 1)
    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
  })
})

describe('provider/discord/gateway — o seq viaja no resume e no heartbeat', () => {
  it('o resume carrega o ULTIMO seq visto (os eventos perdidos re-playam)', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const roda = ligarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente: clienteDo(srv), jitter: () => 0, backoffMs: [20] },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY (seq 1 no duble)')
    srv.enfileirarEvento({ t: 'MESSAGE_CREATE', d: { id: 'm1' } }) // seq 2
    srv.enfileirarEvento({ t: 'MESSAGE_CREATE', d: { id: 'm2' } }) // seq 3
    srv.fecharGateway(4000, 'rede')
    await aguardar(() => srv.gatewayState.resumes.length >= 1, 'resume')
    const resume = srv.gatewayState.resumes[0]
    assert.ok(resume !== undefined)
    assert.equal(resume['session_id'], 'sessao-do-duble')
    assert.equal(resume['seq'], 3, 'o seq do resume e o do ultimo dispatch')
    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
  })

  it('o heartbeat envia o ultimo seq visto; o seq cresce com os dispatches (servidor medido)', async () => {
    const srv = await startGatewayMedido({ heartbeatMs: 40 })
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: 'http://127.0.0.1:1', log: log.logger })
    const roda = ligarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, gatewayUrl: srv.url, jitter: () => 0, backoffMs: [10] },
      () => undefined,
    )
    await aguardar(() => srv.identifies.length >= 1, 'identify no servidor medido')
    await aguardar(() => srv.heartbeats.some((h) => h.d === 1), 'heartbeat com o seq do READY (1)')
    srv.enviar({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm1' } })
    await aguardar(() => srv.heartbeats.some((h) => h.d === 2), 'heartbeat com o seq do dispatch (2)')
    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
    await srv.close()
  })

  it('op 1 (o servidor pede um heartbeat imediato): responde JA, sem esperar o intervalo', async () => {
    const srv = await startGatewayMedido({ heartbeatMs: 100_000 }) // intervalo enorme
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: 'http://127.0.0.1:1', log: log.logger })
    const roda = ligarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, gatewayUrl: srv.url, jitter: () => 0, backoffMs: [10] },
      () => undefined,
    )
    await aguardar(() => srv.identifies.length >= 1, 'identify')
    await aguardar(() => srv.heartbeats.length >= 1, 'primeiro heartbeat (jitter 0)')
    const antes = srv.heartbeats.length
    srv.enviar({ op: 1, d: null })
    await aguardar(() => srv.heartbeats.length >= antes + 1, 'heartbeat imediato em resposta ao op 1')
    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
    await srv.close()
  })
})

describe('provider/discord/gateway — o backoff real', () => {
  it('a escalada padrao e finita e com teto: 1,2,4,8,16,30 (s)', () => {
    assert.deepEqual(DEFAULT_BACKOFF_MS, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
  })

  it('reconexoes sucessivas sobem a espera (20,40,80) e DEPOIS ficam no teto (80)', async () => {
    const srv = await bancada()
    abertos.push(srv)
    const log = captureLog()
    const tempo = new FakeTime() // o sleep do backoff e o UNICO tempo injectado
    const roda = ligarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente: clienteDo(srv), jitter: () => 0, backoffMs: [20, 40, 80], time: tempo },
      () => undefined,
    )
    // 4 sessoes: identify, 1000, identify, 1000, identify, 1000, identify.
    for (let sessao = 1; sessao <= 4; sessao += 1) {
      await aguardar(() => srv.gatewayState.identify.length >= sessao, `sessao ${sessao}`)
      srv.fecharGateway(1000, 'fim normal')
    }
    // A 4.a espera so entra no log DEPOIS de a 4.a sessao fechar.
    await aguardar(
      () => log.lines.filter((l) => l.includes('nova tentativa com backoff')).length >= 4,
      'quatro esperas registadas',
    )

    const esperas = log.lines
      .filter((l) => l.includes('nova tentativa com backoff'))
      .map((l) => /espera_ms=(\d+)/u.exec(l)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number)
    assert.deepEqual(esperas.slice(0, 3), [20, 40, 80], 'a escalada sobe na ordem da lista')
    assert.ok(esperas.length >= 4, 'houve pelo menos 4 esperas')
    assert.ok(esperas.slice(3).every((v) => v === 80), 'a 4.a espera e o TETO da lista (cap)')

    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
  })
})

describe('provider/discord/gateway — falhas do GET /gateway/bot', () => {
  it('429 no GET /gateway/bot: NAO e fatal — o loop espera o backoff e RECUPERA', async () => {
    const srv = await bancada()
    abertos.push(srv)
    srv.queueError('gateway', { status: 429, body: { message: 'rate limited', retry_after: 0.05, global: false } })
    const log = captureLog()
    const roda = ligarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente: clienteDo(srv), jitter: () => 0, backoffMs: [20] },
      () => undefined,
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'a segunda tentativa do /gateway/bot chega a READY')
    assert.ok(log.lines.some((l) => l.includes('falha ao obter a URL do gateway')), 'o 429 e logado')
    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
  })

  it('REDE no GET /gateway/bot (status 0): retenta com backoff ate o BOOT_TIMEOUT (exit 14)', async () => {
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: 'http://127.0.0.1:1', log: log.logger })
    const roda = ligarGateway(
      {
        token: TOKEN_DE_TESTE,
        log: log.logger,
        cliente,
        jitter: () => 0,
        backoffMs: [20],
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
    assert.ok(log.lines.some((l) => l.includes('falha ao obter a URL do gateway')), 'a rede e logada e retentada')
  })
})

describe('provider/discord/gateway — zombie: heartbeat sem ack fecha e resume', () => {
  it('sem ack em grace * intervalo a sessao e fechada (4000) e RETOMADA', async () => {
    const srv = await startGatewayMedido({ heartbeatMs: 40, acksHeartbeats: false })
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: 'http://127.0.0.1:1', log: log.logger })
    const roda = ligarGateway(
      {
        token: TOKEN_DE_TESTE,
        log: log.logger,
        cliente,
        gatewayUrl: srv.url,
        jitter: () => 0,
        backoffMs: [10],
        heartbeatGrace: 2,
      },
      () => undefined,
    )
    await aguardar(() => srv.identifies.length >= 1, 'identify')
    // 40 ms * 2 (grace) * 2 disparos do vigia ~ 160 ms: o zombie fecha a sessao.
    await aguardar(() => srv.resumes.length >= 1, 'a sessao e retomada apos o zombie', 3000)
    // O motivo do close nao vai ao log; a assinatura do zombie e o proprio
    // cliente a fechar com 4000 (o servidor medido NUNCA fecha sozinho) e o
    // warn de reconexao a carrega-lo.
    assert.ok(
      log.lines.some((l) => l.includes('a reconectar') && l.includes('close=4000')),
      'o zombie e detectado e logado (close 4000 pelo vigia de ack)',
    )
    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
    await srv.close()
  })
})

describe('provider/discord/gateway — a retomada usa a resume_gateway_url do READY', () => {
  it('apos close recuperavel o cliente conecta ao URL de resume, nao ao original', async () => {
    const srv = await startGatewayMedido({ heartbeatMs: 100_000 })
    const log = captureLog()
    const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: 'http://127.0.0.1:1', log: log.logger })
    const roda = ligarGateway(
      { token: TOKEN_DE_TESTE, log: log.logger, cliente, gatewayUrl: srv.url, jitter: () => 0, backoffMs: [10] },
      () => undefined,
    )
    await aguardar(() => srv.identifies.length >= 1, 'primeira conexao (no URL original)')
    srv.fechar(4000, 'rede')
    await aguardar(() => srv.resumes.length >= 1, 'resume no URL do READY', 3000)
    assert.deepEqual(srv.upgradePaths.slice(0, 2), ['/', '/resume'], 'a 2.a conexao usa o resume_gateway_url')
    const resume = srv.resumes[0]
    assert.ok(resume !== undefined)
    assert.equal(resume['session_id'], 'sessao-medida')
    roda.parar()
    assert.equal((await roda.outcome).kind, 'stopped')
    await srv.close()
  })
})
