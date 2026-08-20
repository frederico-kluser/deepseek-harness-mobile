// Spike S3: WebSocket ATRAVES do tunel, com payload de aplicacao nos DOIS sentidos.
//
// Observar o 101 nao prova nada: o 101 e so o handshake. O criterio de aceite e
// (i) um frame que o SERVIDOR enviou sem ninguem pedir chegar ao cliente, e
// (ii) um frame que o CLIENTE enviou voltar ecoado pelo servidor.
// Usa o WebSocket global do Node 24 (sem dependencia nova).
import crypto from 'node:crypto'

/**
 * @param {string} wsUrl  ex.: wss://host.trycloudflare.com/ws
 */
export function runBidirectionalWs(wsUrl, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const nonce = crypto.randomBytes(8).toString('hex')
    const clientPayload = `CLI-SEND:${nonce}`
    const log = []
    const received = []
    const t0 = performance.now()
    let settled = false

    const finish = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const serverPush = received.find((m) => m.startsWith('SRV-PUSH:')) ?? null
      const echo = received.find((m) => m === `SRV-ECHO:${clientPayload}`) ?? null
      try {
        ws.close()
      } catch {
        /* socket ja fechado */
      }
      resolve({
        wsUrl,
        clientPayload,
        received,
        log,
        serverToClient: serverPush,
        clientToServerEchoed: echo,
        bidirectional: serverPush !== null && echo !== null,
        elapsedMs: Math.round(performance.now() - t0),
        ...extra,
      })
    }

    const timer = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs)

    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      finish({ outcome: 'construct-error', error: `${err.name}: ${err.message}` })
      return
    }

    ws.addEventListener('open', () => {
      log.push({ atMs: Math.round(performance.now() - t0), event: 'open (handshake 101 aceito pelo cliente)' })
      ws.send(clientPayload)
      log.push({ atMs: Math.round(performance.now() - t0), event: `client->server enviado: ${clientPayload}` })
    })
    ws.addEventListener('message', (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : '<binario>'
      received.push(text)
      log.push({ atMs: Math.round(performance.now() - t0), event: `server->client recebido: ${text}` })
      const hasPush = received.some((m) => m.startsWith('SRV-PUSH:'))
      const hasEcho = received.some((m) => m === `SRV-ECHO:${clientPayload}`)
      if (hasPush && hasEcho) finish({ outcome: 'bidirecional-confirmado' })
    })
    ws.addEventListener('error', (ev) => {
      log.push({
        atMs: Math.round(performance.now() - t0),
        event: `error: ${ev?.message ?? ev?.error?.message ?? 'sem mensagem'}`,
      })
    })
    ws.addEventListener('close', (ev) => {
      log.push({ atMs: Math.round(performance.now() - t0), event: `close code=${ev.code} reason=${ev.reason}` })
      finish({ outcome: 'fechado-antes-de-completar' })
    })
  })
}
