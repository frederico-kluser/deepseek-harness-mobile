/**
 * =============================================================================
 * T6.1 — QUICK TUNNEL REAL (`test/live/**`): rede verdadeira, opt-in, NUNCA PR.
 * =============================================================================
 *
 * DONO: T6.1. Territorio exclusivo: `test/live/**`.
 *
 * O QUE ESTA SUITE FAZ QUE NENHUMA OUTRA PODE
 * -----------------------------------------------------------------------------
 * `test/e2e/**` prova o tunel com DUBLES e nunca toca na rede. Esta suite faz o
 * contrario: sobe um quick tunnel DE VERDADE (`cloudflared tunnel --url`) e
 * ataca a URL PUBLICA `https://<hostname>.trycloudflare.com` que a internet
 * inteira consegue ver. As tres perguntas falsificaveis do plano:
 *
 *   1. o teste ataca a URL PUBLICA (sim: https + DNS + TLS reais ate a borda
 *      da Cloudflare e volta) ou faz curl ao loopback e chama-lhe e2e?
 *   2. o WebSocket transportou payload de APLICACAO nos DOIS sentidos (sim:
 *      um texto do cliente volta ECOADO e o servidor EMPURRA outro texto — o
 *      ude nao passa de 101)? Isto re-confirma o spike S3 ("o WebSocket de
 *      telemetria do DSH atravessa um quick tunnel com trafego bidirecional").
 *   3. o teste so corre quando alguem o pediu? (sim: sem
 *      `DSH_GUARD_LIVE_TESTS=1` a suite INTEIRA salta; o workflow `live.yml`
 *      so dispara por `workflow_dispatch` com esse input — nunca em PR.)
 *
 * A PORTA DEDICADA — A REGRA QUE ESTE FICHEIRO EXISTE PARA FAZER CUMPRIR
 * -----------------------------------------------------------------------------
 * `cloudflared --url http://127.0.0.1:PORTA` publica na internet o que estiver
 * NAQUELA porta, sem perguntar nada. Foi assim que a pesquisa expos o DSH real
 * do utilizador por ~40 s (09-DECISOES-CANONICAS.md D10). Logo:
 *
 *   - a origem desta suite e um `node:http.Server` QUE O TESTE ABRE numa porta
 *     EFEMERA de 127.0.0.1 — nunca a 3080 real, nunca uma porta que o teste
 *     nao possua. O teste assere `originPort !== 3080` mesmo assim.
 *   - o tunel publica SO essa porta; quando o teste acaba, o tunel cai e a
 *     porta deixa de estar ligada a nada.
 *
 * O GUARD (a outra metade da regra "nunca em PR")
 * -----------------------------------------------------------------------------
 * `live.yml` (prep-owned) so dispara por `workflow_dispatch` e exige o input
 * `DSH_GUARD_LIVE_TESTS=1`. Este ficheiro nao confia nisso: sem a variavel no
 * ambiente, a suite INTEIRA salta — cinto e suspensorios, porque um tunel real
 * por engano num PR de fork exporia uma porta durante minutos.
 *
 * Strip-only mode (`node --test` corre os .ts sem os compilar): sem enum,
 * sem namespace, sem parameter properties. Import relativo leva `.ts`.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as timersSleep } from 'node:timers/promises'
import type { Duplex } from 'node:stream'

import type { Context, SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '../../src/dsh/adapter.ts'
import { createGuardedHandler, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { installAuthBarrier } from '../../src/http/intercept.ts'
import { LOOPBACK_ONLY_PREFIXES, UNAUTHENTICATED_PANEL_PREFIXES } from '../../src/index.ts'
import { defaultSupervisorDeps } from '../../src/proc/supervisor.ts'
import { createHttpProbeTransport } from '../../src/tunnel/probe.ts'
import { createTunnelDiscovery } from '../../src/tunnel/discover.ts'
import { createTunnelReadiness } from '../../src/tunnel/readiness.ts'
import { createTunnelSupervisor, type TunnelSupervisor } from '../../src/tunnel/supervisor.ts'
import { createStateStore, type StateStoreHandle } from '../../src/state/store.ts'
import { makeTempStateDir, type TempStateDir } from '../../test/support/state-dir.ts'
import { createFakeLogger } from '../../test/support/ctx-double.ts'
import { bancada, type Bancada } from '../../test/unit/http/bancada.ts'

/** A suite so existe quando alguem a pediu explicitamente. */
const LIVE_GUARDED = process.env.DSH_GUARD_LIVE_TESTS === '1'

/** Versao medida na Onda 0 (08-PESQUISA-E-FONTES.md). Pino fixo, sem tag movel. */
const CLOUDFLARED_RELEASE = '2026.7.3'

/** Payload que o servidor EMPURRA (direccao servidor -> cliente). */
const PUSH_DO_SERVIDOR = 'push-do-servidor-live-e2e'

/** Reserva uma porta livre soltando-a a seguir. Nunca uma porta fixa. */
async function reservePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('sem porta')
  return address.port
}

/** Espera ATIVA por uma condicao (o predicado pode ser assincrono). */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 15_000, stepMs = 25 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await timersSleep(stepMs)
  }
  return predicate()
}

/**
 * Resolve o binario REAL do `cloudflared`: `CLOUDFLARED_BINARY` -> `which`
 * -> download do release pinado. Se nada resultar, LANCIA com instrucao — quem
 * disparou a suite pediu rede verdadeira; "salta porque nao ha binario" seria
 * esconder um ambiente partido atras de um skip verde.
 */
async function resolveCloudflaredBinary(): Promise<string> {
  const declared = process.env.CLOUDFLARED_BINARY?.trim()
  if (declared !== undefined && declared.length > 0) return declared

  const which = spawnSync('which', ['cloudflared'])
  if (which.status === 0) {
    const found = which.stdout.toString().trim()
    if (found.length > 0) return found
  }

  const url =
    'https://github.com/cloudflare/cloudflared/releases/download/' +
    CLOUDFLARED_RELEASE +
    '/cloudflared-linux-amd64'
  const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-cloudflared-'))
  const dest = join(dir, 'cloudflared')
  const response = await fetch(url)
  if (!response.ok || response.body === null) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(
      'nao foi possivel obter o cloudflared ' +
        CLOUDFLARED_RELEASE +
        ' (HTTP ' +
        String(response.status) +
        '). Instale-o e aponte CLOUDFLARED_BINARY, ou verifique a rede.',
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(dest, bytes)
  chmodSync(dest, 0o700)
  return dest
}

/* ========================================================================== */
/* WebSocket minimo e HONESTO (RFC 6455) — sem dependencia nenhuma            */
/* ========================================================================== */
/**
 * NAO ha pacote de WebSocket instalado (o projeto tem UMA dependencia, o
 * grammY, e package.json e territorio de T6.3). O RFC 6455 e simples para
 * payloads pequenos, e um teste "vivo" que fia num `ws` inventado deixaria de
 * medir o que mede. As frames com payload < 126 bytes usam o formato curto; o
 * decodificador suporta tambem o comprimento de 16 bits por robustez.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function wsAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

interface WsFrame {
  readonly opcode: number
  readonly payload: Buffer
  readonly rest: Buffer
}

/** Descodifica UMA frame completa; `null` enquanto faltarem bytes. */
function decodeWsFrame(buffer: Buffer): WsFrame | null {
  if (buffer.length < 2) return null
  // `noUncheckedIndexedAccess` nao estreita por `length`: a leitura guardada
  // e a forma de o compilador aceitar o que o `length < 2` ja provou.
  const b0 = buffer[0]
  const b1 = buffer[1]
  if (b0 === undefined || b1 === undefined) return null
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let length = b1 & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const high = buffer.readUInt32BE(2)
    const low = buffer.readUInt32BE(6)
    if (high !== 0 || low > 0x7fffffff) throw new Error('frame de websocket demasiado grande')
    length = low
    offset = 10
  }
  let mask: Buffer | undefined
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return null
  const raw = buffer.subarray(offset, offset + length)
  let payload: Buffer = raw
  if (masked && mask !== undefined) {
    payload = Buffer.from(raw)
    for (let i = 0; i < payload.length; i++) {
      payload.writeUInt8(raw.readUInt8(i) ^ mask.readUInt8(i % 4), i)
    }
  }
  return { opcode, payload, rest: buffer.subarray(offset + length) }
}

/** Frame servidor -> cliente (SEM mascara — e o que o RFC manda). */
function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  const header = Buffer.alloc(4)
  header[0] = 0x80 | opcode
  header[1] = 126
  header.writeUInt16BE(length, 2)
  return Buffer.concat([header, payload])
}

/** Frame cliente -> servidor (COM mascara — exigida pelo RFC 6455). */
function encodeMaskedWsFrame(opcode: number, payload: Buffer, mask: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length])
  } else {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  }
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i++) {
    masked.writeUInt8(payload.readUInt8(i) ^ mask.readUInt8(i % 4), i)
  }
  return Buffer.concat([header, mask, masked])
}

/**
 * Instala o ECO WebSocket na origem (o despacho original, so alcancado depois
 * de o portao deixar passar a sessao). O texto do cliente volta ECOADO e o
 * servidor EMPURRA `pushPayload` sem ninguem pedir — os DOIS sentidos.
 */
function installWsEcho(server: Server, pushPayload: string): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' +
        wsAccept(key) +
        '\r\n\r\n',
    )
    let pending: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        const frame = decodeWsFrame(pending)
        if (frame === null) break
        pending = frame.rest
        if (frame.opcode === 0x8) {
          // close: responde e fecha.
          socket.end(encodeWsFrame(0x8, Buffer.alloc(0)))
          return
        }
        if (frame.opcode === 0x1) socket.write(encodeWsFrame(0x1, frame.payload))
        // ping (0x9) e pong (0xA) sao ignorados: o teste mede payload, nao
        // controlo.
      }
    })
    socket.on('error', () => socket.destroy())
    const push = setTimeout(() => {
      if (!socket.destroyed) socket.write(encodeWsFrame(0x1, Buffer.from(pushPayload, 'utf8')))
    }, 300)
    push.unref()
  })
}

/* ========================================================================== */
/* Assento de subprocesso REAL (o mesmo molde das suites e2e)                 */
/* ========================================================================== */

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    void error
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

class RealSubprocessHandle {
  readonly child: ChildProcess
  readonly done: Promise<SubprocessOutcome>
  private readonly spec: SubprocessSpawnSpec
  private terminated = false
  private killTimer: ReturnType<typeof setTimeout> | undefined

  constructor(spec: SubprocessSpawnSpec) {
    this.spec = spec
    this.child = spawn(spec.argv[0] ?? '', spec.argv.slice(1), {
      cwd: spec.cwd,
      detached: true,
      stdio: [
        spec.stdio.stdin === 'pipe' ? 'pipe' : 'ignore',
        spec.stdio.stdout === 'pipe' ? 'pipe' : 'ignore',
        spec.stdio.stderr === 'pipe' ? 'pipe' : 'ignore',
      ],
      env: { ...process.env, ...spec.env } as NodeJS.ProcessEnv,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })

    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      let spawnError: Error | undefined
      let didSpawn = false
      this.child.on('spawn', (): void => {
        didSpawn = true
      })
      this.child.on('error', (error: Error): void => {
        if (!didSpawn) spawnError = error
      })
      this.child.on('close', (code, signal): void => {
        if (this.killTimer !== undefined) clearTimeout(this.killTimer)
        if (spawnError !== undefined) {
          reject(spawnError)
          return
        }
        resolve({ exitCode: code, signal })
      })
    })
  }

  get pid(): number {
    return this.child.pid ?? -1
  }

  get stderr(): NodeJS.ReadableStream | undefined {
    return this.child.stderr ?? undefined
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    const { pid } = this
    if (pid <= 0) return
    signalGroup(pid, 'SIGTERM')
    this.killTimer = setTimeout(() => signalGroup(pid, 'SIGKILL'), this.spec.graceMs)
    this.killTimer.unref()
  }

  async waitForExit(): Promise<boolean> {
    return this.done.then(
      () => true,
      () => true,
    )
  }
}

class RealSubprocessService {
  readonly children: RealSubprocessHandle[] = []

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = new RealSubprocessHandle(spec)
    this.children.push(handle)
    return handle as unknown as SubprocessHandle
  }

  killAll(): void {
    for (const child of this.children) {
      if (child.pid > 0) signalGroup(child.pid, 'SIGKILL')
    }
  }

  async settleAll(): Promise<void> {
    await Promise.race([
      Promise.all(this.children.map((child) => child.done.catch(() => undefined))),
      timersSleep(10_000),
    ])
  }
}

interface Resposta {
  readonly status: number
  readonly body: string
  readonly challenge: string | undefined
}

describe(
  'T6.1 — quick tunnel REAL (test/live/**, opt-in DSH_GUARD_LIVE_TESTS=1)',
  { skip: LIVE_GUARDED ? false : 'DSH_GUARD_LIVE_TESTS != 1: a suite live requer opt-in explicito e nunca corre em PR' },
  () => {
    let b: Bancada
    let origin: Server
    let originPort = 0
    let reverter: (() => void) | undefined
    let supervisor: TunnelSupervisor
    let service: RealSubprocessService
    let storeHandle: StateStoreHandle
    let stateDir: TempStateDir
    let tunnelUrl = ''
    let tunnelHost = ''
    /** O pid do processo do tunel REAL, capturado no fim do before. */
    let tunelPid = -1
    /**
     * Disposers na ORDEM certa (o inverso da criacao). O padrao do repositorio
     * (test/integration/**): as closures capturam variaveis ja atribuidas, o que
     * evita cadeias opcionais desnecessarias e mantem o after() curto.
     */
    const limpezas: Array<() => void | Promise<void>> = []

    /** Um pedido HTTPS pela URL PUBLICA do tunel — a internet inteira o ve. */
    function pedirPublico(
      path: string,
      options: { readonly method?: string; readonly headers?: Record<string, string> } = {},
    ): Promise<Resposta> {
      return new Promise<Resposta>((resolve, reject) => {
        const req = httpsRequest(
          {
            host: tunnelHost,
            path,
            method: options.method ?? 'GET',
            headers: options.headers,
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => {
              body += chunk
            })
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body,
                challenge: res.headers['www-authenticate'],
              }),
            )
          },
        )
        req.on('error', reject)
        req.end()
      })
    }

    before(async () => {
      // Guarda de maquina: sem binario real, sem suite. LANCIA (instrucao no
      // erro), porque quem disparou pediu rede e "saltar" esconderia o problema.
      const cloudflaredPath = await resolveCloudflaredBinary()

      /* --- A ORIGEM: porta DEDICADA efemera (nunca a 3080 real) + eco WS. --- */
      origin = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"superficie":"origem-live"}')
      })
      installWsEcho(origin, PUSH_DO_SERVIDOR)
      await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()))
      originPort = (origin.address() as AddressInfo).port
      assert.notEqual(originPort, 3080, 'porta dedicada: o quick tunnel NUNCA aponta para a 3080 real')

      b = bancada({
        comSegredo: true,
        unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
        loopbackOnlyPrefixes: LOOPBACK_ONLY_PREFIXES,
        loopbackAuthority: '127.0.0.1:' + String(originPort),
        config: {
          exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: true },
          tunnel: { mode: 'quick', ttlMinutes: 60 },
        },
      })

      reverter = installAuthBarrier(
        origin,
        {
          wrapRequest: (delegate) => createGuardedHandler(b.gate, delegate, 'live:request'),
          wrapUpgrade: (delegate) => createGuardedUpgradeHandler(b.gate, delegate, 'live:upgrade'),
        },
        b.gate.log,
      )

      /* --- SUPERVISOR REAL, com READINESS REAL (sonda a URL PUBLICA). --- */
      stateDir = makeTempStateDir()
      storeHandle = createStateStore({ paths: { dir: stateDir.path, file: stateDir.statePath } })
      service = new RealSubprocessService()
      const logger = createFakeLogger()
      const ctx = { subprocess: service, logger } as unknown as Context
      const metricsPort = await reservePort()

      supervisor = createTunnelSupervisor({
        ctx,
        config: { mode: 'quick', ttlMinutes: 60, binaryPath: cloudflaredPath },
        resolveOrigin: () => origin,
        allocateMetricsPort: () => metricsPort,
        probe: {
          transport: createHttpProbeTransport({ host: '127.0.0.1', port: originPort, timeoutMs: 2000 }),
          newCanaryToken: () => 'canario-live-' + randomBytes(8).toString('hex'),
        },
        discovery: createTunnelDiscovery(),
        // A readiness REAL: atravessa a borda da Cloudflare e volta. E aqui que
        // a suite e2e nao pode chegar e esta pode.
        readiness: createTunnelReadiness(),
        store: storeHandle.store,
        tunnelOrigin: b.tunnelOrigin,
        sessions: { revokeAll: () => undefined },
        audit: { append: () => undefined },
        notifyOwner: () => undefined,
        proc: defaultSupervisorDeps,
      })

      await supervisor.start()
      const pronto = await waitFor(() => supervisor.snapshot().state === 'READY', { timeoutMs: 120_000 })
      assert.equal(pronto, true, 'o quick tunnel real devia ter ficado READY')
      const snap = supervisor.snapshot()
      assert.ok(snap.info !== undefined, 'READY tem de divulgar a URL')
      tunnelUrl = snap.info.url
      tunnelHost = new URL(tunnelUrl).host
      assert.match(tunnelUrl, /^https:\/\/[-a-z0-9]+\.trycloudflare\.com$/u)

      // Os disposers, na ordem certa: o supervisor primeiro (mata o filho), a
      // rede de seguranca do service a seguir, o estado, a bancada, a barreira,
      // e so no fim o servidor de origem.
      limpezas.push(() => supervisor.dispose())
      limpezas.push(() => service.killAll())
      limpezas.push(async () => {
        await service.settleAll()
      })
      limpezas.push(() => storeHandle.dispose())
      limpezas.push(() => stateDir.cleanup())
      limpezas.push(() => b.cleanup())
      limpezas.push(() => reverter?.())
      limpezas.push(
        () => new Promise<void>((resolve) => origin.close(() => resolve())),
      )
      tunelPid = service.children[0]?.pid ?? -1
    }, { timeout: 240_000 })

    after(async () => {
      for (const limpeza of limpezas) await limpeza()

      // O processo do tunel REAL saiu de vez. (A varredura global
      // `! pgrep -f cloudflared` e passo do workflow live.yml.)
      if (tunelPid > 0) {
        const saiu = await waitFor(() => !isAlive(tunelPid), { timeoutMs: 15_000 })
        assert.equal(saiu, true, 'o cloudflared real tem de ter saido apos stop')
      }

      // Facto medido (08-PESQUISA §8): apos SIGTERM a URL publica deixa de
      // servir a aplicacao (HTTP 530 imediato). Prova-se o que interessa: o
      // nosso servico NAO esta mais publicamente alcancavel por esse nome.
      if (tunnelHost.length > 0) {
        const morto = await waitFor(
          async (): Promise<boolean> => {
            try {
              const resposta = await pedirPublico('/')
              return resposta.status >= 500 || resposta.status === 0
            } catch (error) {
              void error
              return true // ligacao recusada/tempo esgotado: o tunel morreu
            }
          },
          { timeoutMs: 20_000, stepMs: 1000 },
        )
        assert.equal(morto, true, 'a URL publica deixou de servir a aplicacao depois de stop')
      }
    }, { timeout: 60_000 })

    it('401 sem credencial / 200 com sessao, PELA URL PUBLICA', { timeout: 120_000 }, async () => {
      const semCredencial = await pedirPublico('/api/state')
      assert.equal(semCredencial.status, 401, 'sem credencial, o portao responde 401 pela internet')
      assert.ok(
        semCredencial.challenge !== undefined && semCredencial.challenge.includes('Basic'),
        'o 401 vem com WWW-Authenticate',
      )

      const comSessao = await pedirPublico('/api/state', { headers: { cookie: b.emitirSessao() } })
      assert.equal(comSessao.status, 200, 'com sessao, o pedido atravessa o tunel ate a origem')
      assert.equal(comSessao.body, '{"superficie":"origem-live"}', 'o despacho original foi alcancado')
    })

    it('WebSocket com payload nos DOIS sentidos atraves do tunel REAL (re-confirma S3)', { timeout: 120_000 }, async () => {
      const key = randomBytes(16).toString('base64')
      const session = b.emitirSessao()

      const socket = await new Promise<Duplex>((resolve, reject) => {
        const req = httpsRequest({
          host: tunnelHost,
          path: '/ws-echo',
          method: 'GET',
          headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': key,
            cookie: session,
          },
        })
        req.on('upgrade', (res: IncomingMessage, upgraded: Duplex) => {
          // O accept tem de fechar com a chave que ENVIAMOS: prova que quem
          // respondeu 101 e o nosso despacho, e nao um proxy qualquer.
          assert.equal(res.headers['sec-websocket-accept'], wsAccept(key))
          resolve(upgraded)
        })
        req.on('response', (res: IncomingMessage) => {
          res.resume()
          reject(new Error('esperado 101 Switching Protocols, obtido ' + String(res.statusCode)))
        })
        req.on('error', reject)
        req.end()
      })

      // O colecionador de frames, ligado antes de qualquer envio.
      const frames: Array<{ opcode: number; payload: string }> = []
      let pending: Buffer = Buffer.alloc(0)
      socket.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        for (;;) {
          const frame = decodeWsFrame(pending)
          if (frame === null) break
          pending = frame.rest
          frames.push({ opcode: frame.opcode, payload: frame.payload.toString('utf8') })
        }
      })
      socket.on('error', () => undefined)

      // Direccao cliente -> servidor: texto de aplicacao que TEM de voltar.
      const echoPayload = 'ping-e2e-' + randomBytes(6).toString('hex')
      const mask = randomBytes(4)
      socket.write(encodeMaskedWsFrame(0x1, Buffer.from(echoPayload, 'utf8'), mask))

      const ecoVoltou = await waitFor(
        () => frames.some((frame) => frame.opcode === 1 && frame.payload === echoPayload),
        { timeoutMs: 20_000 },
      )
      assert.equal(ecoVoltou, true, 'o payload do cliente tem de atravessar o tunel e voltar ECOADO')

      // Direccao servidor -> cliente: o servidor EMPURRA sem ninguem pedir.
      const pushChegou = await waitFor(
        () => frames.some((frame) => frame.opcode === 1 && frame.payload === PUSH_DO_SERVIDOR),
        { timeoutMs: 20_000 },
      )
      assert.equal(pushChegou, true, 'o payload empurrado pelo servidor tem de atravessar o tunel')

      socket.end(encodeMaskedWsFrame(0x8, Buffer.alloc(0), mask))
    })
  },
)
