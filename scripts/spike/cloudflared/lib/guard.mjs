// Guarda de exposicao do spike de cloudflared.
//
// Motivo de existir: `cloudflared --url http://localhost:PORT` publica na internet,
// sem confirmacao, o que estiver naquela porta. Durante a pesquisa que originou o
// plano isso expos o DeepSeek Harness real do usuario publicamente por ~40 segundos.
//
// O QUE ESTA GUARDA GARANTE, LITERALMENTE
// ---------------------------------------
// O alvo de um tunel nao pode ser nomeado por numero. A unica forma de nomear um
// alvo e entregar um `net.Server` DESTE processo, ja em escuta — e a porta sai de
// `server.address()`. Isso e uma allowlist de verdade, e nao uma blocklist de uma
// porta so: um servidor em escuta prova posse por construcao, porque `listen()`
// numa porta que outro processo ja serve falha com `EADDRINUSE` antes de existir.
// Nao ha sobrecarga que aceite um inteiro; passar `3080` nao compila em runtime.
//
// A blocklist `FORBIDDEN_TARGET_PORTS` continua existindo como defesa em
// profundidade — cobre o caso em que o proprio spike, por acidente, abrisse um
// servidor na porta do DSH.
import net from 'node:net'

/** Portas que NUNCA podem ser alvo de um tunel a partir deste repositorio. */
export const FORBIDDEN_TARGET_PORTS = new Set([3080])

export class ExposureGuardError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ExposureGuardError'
  }
}

/** Defesa em profundidade: recusa portas da blocklist e valores fora de faixa. */
export function assertTargetPortAllowed(port) {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ExposureGuardError(`porta alvo invalida: ${port}`)
  }
  if (FORBIDDEN_TARGET_PORTS.has(n)) {
    throw new ExposureGuardError(
      `RECUSADO: a porta ${n} e reservada ao DeepSeek Harness real do usuario. ` +
        'Um tunel apontado para ela publicaria o DSH na internet.',
    )
  }
  return n
}

/**
 * UNICA forma de nomear o alvo de um tunel neste repositorio.
 *
 * Recebe o servidor — nao a porta — e devolve a porta em que ELE esta escutando.
 * Recusa qualquer coisa que nao seja um `net.Server` deste processo em escuta,
 * o que exclui por construcao qualquer porta servida por outro processo.
 *
 * @param {net.Server} server servidor aberto por este processo, ja em escuta
 * @returns {number} porta que pode ser tunelada
 */
export function targetPortOfOwnServer(server) {
  if (!(server instanceof net.Server)) {
    throw new ExposureGuardError(
      'RECUSADO: o alvo de um tunel precisa ser um net.Server deste processo, ' +
        `nao ${typeof server === 'object' ? 'um objeto qualquer' : typeof server}. ` +
        'Nao existe caminho que aceite um numero de porta: e isso que impede ' +
        'apontar o tunel para um servico que este processo nao abriu.',
    )
  }
  if (server.listening !== true) {
    throw new ExposureGuardError(
      'RECUSADO: o servidor alvo nao esta em escuta; sem listen() bem-sucedido ' +
        'nao ha prova de posse da porta.',
    )
  }
  const addr = server.address()
  if (addr === null || typeof addr !== 'object' || typeof addr.port !== 'number') {
    throw new ExposureGuardError('RECUSADO: o servidor alvo nao expoe uma porta TCP.')
  }
  return assertTargetPortAllowed(addr.port)
}

/**
 * Reserva uma porta alta livre: abre em :0, le a porta atribuida pelo SO e fecha.
 * Serve so para a porta de METRICAS (que e endereco de escuta do cloudflared, nao
 * alvo de tunel). O alvo do tunel nunca passa por aqui.
 */
export function reserveFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, host, () => {
      const { port } = srv.address()
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

/** true se nada estiver escutando em host:port neste instante. */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    const done = (free) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(free)
    }
    sock.setTimeout(1500)
    sock.on('connect', () => done(false))
    sock.on('timeout', () => done(true))
    sock.on('error', () => done(true))
  })
}
