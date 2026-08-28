/**
 * Servidor Discord FALSO — REST + gateway WebSocket num unico `node:http`.
 * Insumo direto dos testes do adaptador discord (unitarios + e2e), no padrao
 * de `telegram-server.mjs`: Node puro, ESM, zero dependencias, porta efemera.
 *
 * PORQUE UM SERVIDOR SO: o `GET /gateway/bot` do REST devolve a URL do
 * gateway — no duble, `ws://127.0.0.1:<mesma porta>` (o `upgrade` do http e
 * o mesmo listener). O worker aponta para o duble inteiro com UMA variavel
 * (`DISCORD_API_ROOT`), e o fluxo de producao (REST -> url -> WS) fica fiel.
 *
 * Contrato replicado da API real (docs.discord.com, v10):
 *   - REST: `GET /gateway/bot` -> `{url, shards, session_start_limit}`;
 *     `POST /channels/{id}/messages` -> `{id, channel_id, content}`;
 *     `PATCH /channels/{id}/messages/{mid}` -> `{id, ...}`;
 *     `POST /interactions/{id}/{token}/callback` -> `{id}`;
 *     erros: `{"message","code",...}` com HTTP == status (429 ganha
 *     `retry_after` em SEGUNDOS, a doc atual);
 *   - gateway: handshake 101 (RFC 6455), Hello (op 10) com `heartbeat_interval`
 *     configuravel, ack de heartbeat (op 11), READY apos identify (op 2),
 *     RESUMED apos resume (op 6); o teste enfileira dispatches e fecha o
 *     socket com o close code que quiser.
 *
 * O frameamento WS (RFC 6455) e importado do spike que o repo ja mediu
 * (`scripts/spike/cloudflared/lib/ws-frame.mjs`): `FrameParser` desmascara os
 * frames do cliente e `encodeText` emite frames de servidor nao mascarados.
 *
 * Uso programatico:
 *   const srv = await startFakeDiscord({ gatewayHeartbeatMs: 100 });
 *   srv.apiRoot          // -> "http://127.0.0.1:<porta>"
 *   srv.gatewayUrl       // -> "ws://127.0.0.1:<porta>"  (o que /gateway/bot devolve)
 *   srv.calls            // -> [{ method, path, body, authorization }] (REST)
 *   srv.gatewayState     // -> { identify: [...], resumes: [...], heartbeats: n, sessions: n }
 *   srv.enfileirarEvento({ t: 'MESSAGE_CREATE', d: {...} })  // dispatch ao worker
 *   srv.fecharGateway(4000, 'motivo')  // fecha o socket ativo
 *   srv.queueError('channels', { status: 429, body: {...} })
 *   await srv.close();
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'

import { encodeClose, encodeText, FrameParser } from '../../scripts/spike/cloudflared/lib/ws-frame.mjs'

/** O GUID do handshake (RFC 6455 §1.3). */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Sequencia do gateway: cada dispatch incrementa. */
function proximaSequencia(state) {
  state.seq += 1
  return state.seq
}

/** Le o corpo JSON de um pedido. */
async function lerCorpo(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return { __raw: raw }
  }
}

/** Envia um JSON como frame de texto (lado servidor, nao mascarado). */
function enviarJson(socket, objeto) {
  if (socket.writable) socket.write(encodeText(JSON.stringify(objeto)))
}

/**
 * Arranca o duble numa porta efemera.
 *
 * `gatewayHeartbeatMs`: o `heartbeat_interval` do Hello (padrao 100_000 —
 * grande de proposito para o teste que nao fala de heartbeat nao ser
 * incomodado; o teste do heartbeat passa 50-100).
 */
export async function startFakeDiscord({
  port = 0,
  gatewayHeartbeatMs = 100_000,
  sessionId = 'sessao-do-duble',
} = {}) {
  const calls = []
  const errorQueue = new Map() // path -> fila de {status, body}
  const gatewayState = {
    identify: [],
    resumes: [],
    heartbeats: 0,
    sessions: 0,
    seq: 0,
  }
  const gatewaySockets = [] // todos os sockets abertos (resume re-conecta)
  let gatewaySocket = null // o socket ativo (o mais recente)

  const enviarParaGateway = (socket, t, d) => {
    enviarJson(socket, { op: 0, t, s: proximaSequencia(gatewayState), d })
  }

  function tratarFrameDoCliente(socket, frame) {
    if (frame.opcode === 0x8 /* close */) {
      socket.end()
      return
    }
    if (frame.opcode !== 0x1 /* text */) return
    let json
    try {
      json = JSON.parse(frame.payload.toString('utf8'))
    } catch {
      return
    }
    const op = json.op
    if (op === 1) {
      // Heartbeat do cliente: ACK (op 11) — o zombie detection depende disto.
      gatewayState.heartbeats += 1
      enviarJson(socket, { op: 11, d: null })
      return
    }
    if (op === 2) {
      // Identify: registra e responde READY (a sessao nasce).
      gatewayState.identify.push(json.d)
      gatewayState.sessions += 1
      gatewayState.sessionId = typeof json.d?.session_id === 'string' ? json.d.session_id : sessionId
      enviarParaGateway(socket, 'READY', {
        session_id: gatewayState.sessionId,
        resume_gateway_url: `ws://127.0.0.1:${porta}/resume`,
        user: { id: '1300000000000000001', username: 'dsh_spike_bot', bot: true },
      })
      return
    }
    if (op === 6) {
      // Resume: registra e responde RESUMED (eventos re-playados, em tese).
      gatewayState.resumes.push(json.d)
      enviarParaGateway(socket, 'RESUMED', {})
      return
    }
  }

  function conectarGateway(socket) {
    gatewaySockets.push(socket)
    gatewaySocket = socket
    const parser = new FrameParser()
    socket.on('data', (chunk) => {
      for (const frame of parser.push(chunk)) tratarFrameDoCliente(socket, frame)
    })
    socket.on('close', () => {
      if (gatewaySocket === socket) gatewaySocket = null
    })
    socket.on('error', () => undefined)
    // O Hello abre a sessao: o heartbeat_interval vem nele (doc oficial).
    enviarJson(socket, { op: 10, d: { heartbeat_interval: gatewayHeartbeatMs } })
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const authorization = String(req.headers['authorization'] ?? '')
      const body = await lerCorpo(req)

      // O registro da chamada (para o teste asserir o que viajou na rede).
      calls.push({ method: req.method ?? 'GET', path, body, authorization })

      // Erro enfileirado (429 com retry_after, 401, ...).
      const chave = path.split('/')[1] ?? ''
      const fila = errorQueue.get(chave)
      if (fila !== undefined && fila.length > 0) {
        const err = fila.shift()
        res.writeHead(err.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(err.body))
        return
      }

      if (req.method === 'GET' && path === '/gateway/bot') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            url: `ws://127.0.0.1:${porta}`,
            shards: 1,
            session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 },
          }),
        )
        return
      }

      const mMsg = /^\/channels\/([^/]+)\/messages$/.exec(path)
      if (mMsg !== null && req.method === 'POST') {
        const channelId = mMsg[1]
        const id = `msg-${++estado.messageId}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id, channel_id: channelId, content: body?.content ?? '', components: body?.components ?? [] }))
        return
      }

      const mEdit = /^\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(path)
      if (mEdit !== null && req.method === 'PATCH') {
        const [, channelId, messageId] = mEdit
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: messageId, channel_id: channelId, content: body?.content ?? '', components: body?.components ?? [] }))
        return
      }

      const mCb = /^\/interactions\/([^/]+)\/([^/]+)\/callback$/.exec(path)
      if (mCb !== null && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: mCb[1] }))
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'rota desconhecida no duble', code: 0 }))
    })()
  })

  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '')
    if (key === '') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    conectarGateway(socket)
  })

  const estado = { messageId: 100 }
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  const porta = typeof addr === 'object' && addr !== null ? addr.port : port

  return {
    server,
    port: porta,
    apiRoot: `http://127.0.0.1:${porta}`,
    gatewayUrl: `ws://127.0.0.1:${porta}`,
    calls,
    estado,
    gatewayState,
    /** Enfileira UM erro REST para a proxima chamada cujo path comeca pela chave. */
    queueError(chave, err) {
      if (!errorQueue.has(chave)) errorQueue.set(chave, [])
      errorQueue.get(chave).push(err)
      return this
    },
    /** Envia UM dispatch (op 0) ao socket gateway ativo. */
    enfileirarEvento(payload) {
      const socket = gatewaySocket
      if (socket === null || socket === undefined) {
        throw new Error('enfileirarEvento sem conexao gateway ativa')
      }
      enviarParaGateway(socket, payload.t ?? 'MESSAGE_CREATE', payload.d ?? {})
      return this
    },
    /** Envia UM payload CRU (opcode 7/9, hello, ...) ao socket gateway ativo. */
    enviarRaw(payload) {
      const socket = gatewaySocket
      if (socket === null || socket === undefined) {
        throw new Error('enviarRaw sem conexao gateway ativa')
      }
      enviarJson(socket, payload)
      return this
    },
    /** Fecha o socket gateway ativo com o close code dado (ex.: 4000, 4004). */
    fecharGateway(code = 1000, motivo = 'fechado pelo duble') {
      const socket = gatewaySocket
      if (socket !== null && socket !== undefined) {
        try {
          socket.end(encodeClose(code, motivo))
        } catch {
          socket.destroy()
        }
      }
      return this
    },
    async close() {
      for (const socket of gatewaySockets) {
        try {
          socket.destroy()
        } catch {
          // ja fechado
        }
      }
      server.close()
      await once(server, 'close')
    },
  }
}
