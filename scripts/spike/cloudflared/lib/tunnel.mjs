// Ciclo de vida do subprocesso cloudflared para o spike.
//
// Disciplinas do plano aplicadas aqui:
//  - A-7: escuta 'error' E 'close'. Em ENOENT o evento 'exit' NUNCA dispara.
//  - A-1: `detached: true` no spawn, para que `process.kill(-pid)` alcance o
//         grupo inteiro em vez de engolir ESRCH.
//  - A-10: a URL vem do endpoint /quicktunnel; o parse de stderr e so fallback.
import { spawn } from 'node:child_process'
import { targetPortOfOwnServer } from './guard.mjs'

/** Regex de referencia do plano para o fallback. */
export const QUICK_TUNNEL_RE = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/

/**
 * @param {{ bin: string, originServer: import('node:net').Server, metricsPort: number,
 *           extraArgs?: string[], onLine?: (fd: string, text: string) => void }} opts
 *
 * `originServer` e o SERVIDOR, nao a porta: a prova de posse acontece aqui, no
 * unico ponto que importa, e nao na boa vontade do chamador.
 */
export function spawnQuickTunnel({ bin, originServer, metricsPort, extraArgs = [], onLine }) {
  const originPort = targetPortOfOwnServer(originServer)
  const args = [
    'tunnel',
    '--no-autoupdate',
    '--metrics',
    `127.0.0.1:${metricsPort}`,
    '--url',
    `http://127.0.0.1:${originPort}`,
    ...extraArgs,
  ]

  const t0 = performance.now()
  const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })

  const state = {
    argv: [bin, ...args],
    pid: child.pid,
    startedAt: t0,
    stdout: { bytes: 0, text: '' },
    stderr: { bytes: 0, text: '' },
    stderrUrl: null,
    stderrUrlMs: null,
    spawnError: null,
    closed: null,
    exited: null,
  }

  child.stdout.on('data', (chunk) => {
    state.stdout.bytes += chunk.length
    state.stdout.text += chunk.toString('utf8')
    onLine?.('stdout', chunk.toString('utf8'))
  })
  child.stderr.on('data', (chunk) => {
    state.stderr.bytes += chunk.length
    const text = chunk.toString('utf8')
    state.stderr.text += text
    if (state.stderrUrl === null) {
      const hit = QUICK_TUNNEL_RE.exec(state.stderr.text)
      if (hit !== null) {
        state.stderrUrl = hit[0]
        state.stderrUrlMs = performance.now() - t0
      }
    }
    onLine?.('stderr', text)
  })

  // A-7: os tres eventos, com 'error' e 'close' como os que decidem.
  child.on('error', (err) => {
    state.spawnError = { code: err.code ?? null, message: err.message }
  })
  child.on('exit', (code, signal) => {
    state.exited = { code, signal, atMs: performance.now() - t0 }
  })
  child.on('close', (code, signal) => {
    state.closed = { code, signal, atMs: performance.now() - t0 }
  })

  return { child, state, args }
}

/** GET no metrics server local, sem lancar em falha de conexao. */
export async function probeMetrics(metricsPort, path, timeoutMs = 2000) {
  const url = `http://127.0.0.1:${metricsPort}${path}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: true, url, status: res.status, body: await res.text() }
  } catch (err) {
    return { ok: false, url, error: `${err.name}: ${err.message}`, cause: err.cause?.code ?? null }
  }
}

/**
 * Polling de /quicktunnel. Aborta cedo se o processo morrer ('close'),
 * em vez de esperar o timeout inteiro.
 */
export async function pollQuickTunnel({ metricsPort, state, timeoutMs = 45000, intervalMs = 250 }) {
  const t0 = performance.now()
  const attempts = []
  for (;;) {
    if (state.spawnError !== null) {
      return { ok: false, reason: 'spawn-error', spawnError: state.spawnError, attempts }
    }
    if (state.closed !== null) {
      return { ok: false, reason: 'process-closed', closed: state.closed, attempts }
    }
    const r = await probeMetrics(metricsPort, '/quicktunnel')
    attempts.push({ atMs: Math.round(performance.now() - t0), ok: r.ok, status: r.status ?? null, cause: r.cause ?? null })
    if (r.ok && r.status === 200) {
      return { ok: true, elapsedMs: Math.round(performance.now() - t0), status: r.status, body: r.body, attempts }
    }
    if (performance.now() - t0 > timeoutMs) {
      return { ok: false, reason: 'timeout', elapsedMs: Math.round(performance.now() - t0), attempts, last: r }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * SIGTERM no GRUPO de processos (-pid). Devolve o que realmente aconteceu,
 * incluindo ESRCH se o grupo ja nao existir.
 */
export function killGroup(child, state, signal = 'SIGTERM') {
  const at = performance.now()
  const result = { signal, sentAtMs: Math.round(at - state.startedAt), killError: null }
  try {
    process.kill(-child.pid, signal)
    result.sent = 'group'
  } catch (err) {
    result.killError = { code: err.code ?? null, message: err.message }
    try {
      process.kill(child.pid, signal)
      result.sent = 'single-pid-fallback'
    } catch (err2) {
      result.sent = 'none'
      result.fallbackError = { code: err2.code ?? null, message: err2.message }
    }
  }
  return result
}

/** Espera 'close' (nunca so 'exit'). */
export function waitClose(child, state, timeoutMs = 40000) {
  if (state.closed !== null) return Promise.resolve(state.closed)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true, afterMs: timeoutMs }), timeoutMs)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, atMs: Math.round(performance.now() - state.startedAt) })
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ error: err.code ?? err.message })
    })
  })
}
