#!/usr/bin/env node
// Origem HTTP+WebSocket propria do spike. NUNCA e o DSH real.
//
// Registra CRU tudo o que chega (req.rawHeaders preserva ordem e duplicatas) e
// responde com esses mesmos headers, para que o cliente externo tambem veja o
// que a borda entregou. E o instrumento de medicao do spike S2.
//
// Uso isolado:  node scripts/spike/cloudflared/origin.mjs [--port N]
// Uso embutido: import { startOrigin } from './origin.mjs'
import http from 'node:http'
import crypto from 'node:crypto'
import { assertTargetPortAllowed, reserveFreePort } from './lib/guard.mjs'
import { FrameParser, OPCODE, encodeText, encodeClose } from './lib/ws-frame.mjs'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {{ port?: number, host?: string, onEvent?: (e: object) => void }} opts
 * @returns {Promise<{ server: http.Server, port: number, events: object[], close: () => Promise<void> }>}
 */
export async function startOrigin(opts = {}) {
  const host = opts.host ?? '127.0.0.1'
  const events = []
  const emit = (event) => {
    events.push(event)
    opts.onEvent?.(event)
  }

  const server = http.createServer((req, res) => {
    const event = {
      at: nowIso(),
      kind: 'http',
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      remoteAddress: req.socket.remoteAddress,
      remotePort: req.socket.remotePort,
      rawHeaders: req.rawHeaders,
    }
    emit(event)
    const body = `${JSON.stringify({ origin: 'spike-own-origin', seen: event }, null, 2)}\n`
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
  })

  // WebSocket: handshake manual + payload de aplicacao nos DOIS sentidos.
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key']
    emit({
      at: nowIso(),
      kind: 'upgrade',
      method: req.method,
      url: req.url,
      remoteAddress: req.socket.remoteAddress,
      rawHeaders: req.rawHeaders,
    })
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.setNoDelay(true)

    const parser = new FrameParser()
    // Sentido SERVIDOR -> CLIENTE, sem ninguem pedir: e o que prova que o tunel
    // nao e half-duplex. Espelha a telemetria push do DSH.
    const greeting = `SRV-PUSH:${crypto.randomBytes(6).toString('hex')}`
    socket.write(encodeText(greeting))
    emit({ at: nowIso(), kind: 'ws-server-sent', payload: greeting })

    if (head && head.length > 0) handleChunk(head)
    socket.on('data', handleChunk)
    socket.on('error', (err) => emit({ at: nowIso(), kind: 'ws-socket-error', message: err.message }))
    socket.on('close', () => emit({ at: nowIso(), kind: 'ws-close' }))

    function handleChunk(chunk) {
      let frames
      try {
        frames = parser.push(chunk)
      } catch (err) {
        emit({ at: nowIso(), kind: 'ws-parse-error', message: err.message })
        socket.destroy()
        return
      }
      for (const frame of frames) {
        if (frame.opcode === OPCODE.TEXT) {
          const text = frame.payload.toString('utf8')
          emit({ at: nowIso(), kind: 'ws-server-received', payload: text, bytes: frame.payload.length })
          const echo = `SRV-ECHO:${text}`
          socket.write(encodeText(echo))
          emit({ at: nowIso(), kind: 'ws-server-sent', payload: echo })
        } else if (frame.opcode === OPCODE.PING) {
          socket.write(encodeText(`SRV-PONGTEXT:${frame.payload.toString('utf8')}`))
        } else if (frame.opcode === OPCODE.CLOSE) {
          socket.end(encodeClose(1000, 'bye'))
        }
      }
    }
  })

  const port = opts.port ?? (await reserveFreePort(host))
  assertTargetPortAllowed(port)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return {
    server,
    port: server.address().port,
    events,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

// Modo CLI: sobe e fica de pe, imprimindo os eventos em JSONL.
if (import.meta.url === `file://${process.argv[1]}`) {
  const idx = process.argv.indexOf('--port')
  const port = idx >= 0 ? Number(process.argv[idx + 1]) : undefined
  const origin = await startOrigin({ port, onEvent: (e) => console.log(JSON.stringify(e)) })
  console.error(`[origin] escutando em http://127.0.0.1:${origin.port} (origem PROPRIA do spike)`)
  process.on('SIGTERM', () => origin.close().then(() => process.exit(0)))
  process.on('SIGINT', () => origin.close().then(() => process.exit(0)))
}
