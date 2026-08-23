/**
 * =============================================================================
 * T6.1 — O CICLO COMPLETO DO TUNEL: start -> READY -> 401/200 PELA URL DO TUNEL
 *        -> stop, sem processo orfao. (O ficheiro que o plano nomeia.)
 * =============================================================================
 *
 * DONO: T6.1. Territorio exclusivo: `test/e2e/tunnel-*.test.ts`.
 *
 * A PERGUNTA FALSIFICAVEL (e por que nao e "curl ao loopback chamado de e2e")
 * -----------------------------------------------------------------------------
 *   "Com o tunel ligado, um pedido sem credencial VINDO DE FORA devolve 401, e
 *    com sessao devolve 200 — e depois de o tunel cair, o MESMO pedido devolve
 *    403?"
 *
 * O pedido NAO e um curl ao loopback: ele e construido a partir da URL que a
 * descoberta extraiu do processo do dublê, viaja em ABSOLUTE-FORM
 * (`GET https://<hostname>/api/state`) ate uma BORDA FALSA que faz o papel do
 * `cloudflared` + da borda da Cloudflare (reescreve `Host`, acrescenta
 * `CF-Connecting-IP`, recusa quem o enviar — o caso R3 medido), e so a borda
 * fala com a ORIGEM, em 127.0.0.1. O que o portao vê e exatamente o que vê em
 * producao: um socket loopback com `Host` = nome publico do tunel.
 *
 * O DESCRIMINADOR QUE PROVA QUE O PEDIDO REALMENTE USOU O TUNEL:
 * depois de `stop()`, a MESMA requisicao pela URL do tunel devolve 403 (o
 * nome saiu da allowlist de `Host`), enquanto um pedido DIRETO ao loopback
 * continua a devolver 401 (o portao continua armado). Um teste que "curl ao
 * loopback e chama de e2e" nao conseguiria produzir esse par: o loopback nao
 * muda quando o tunel cai.
 *
 * O QUE E REAL E O QUE E DUBLE (D10)
 * -----------------------------------------------------------------------------
 *   REAL:  o processo do dublê (`test/bin/fake-cloudflared.mjs`, prep-owned),
 *          o supervisor (`createTunnelSupervisor`), a descoberta
 *          (`createTunnelDiscovery`), o probe fail-closed
 *          (`createHttpProbeTransport`), a barreira (`installAuthBarrier`),
 *          o portao (`createGuardedHandler`/Upgrade), o store e as sessoes.
 *   DUBLE: o executavel do tunel (dublê congelado) e a BORDA (a caixa preta
 *          que no produto e a Cloudflare). Nenhum byte sai de 127.0.0.1: o
 *          hostname `*.trycloudflare.com` e so um nome na allowlist.
 *
 * PORQUE O READINESS DESSA SUITE NAO ATRAVESSA O TUNEL (e nao e batota)
 * -----------------------------------------------------------------------------
 * A readiness de producao sonda a URL PUBLICA — mas essa URL pertence a
 * Cloudflare, e sondá-la em CI sem rede e impossivel por definicao. Aqui a
 * readiness sonda a ORIGEM em loopback (a mesma pergunta: "a aplicacao
 * responde?"). A sondagem ATRAVES do tunel real e a re-confirmacao de
 * `test/live/**` (quick-tunnel.test.ts), que usa a readiness REAL sobre a URL
 * publica.
 *
 * Strip-only mode (`node --test` corre os .ts sem os compilar): sem enum,
 * sem namespace, sem parameter properties. Import relativo leva `.ts`.
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as timersSleep } from 'node:timers/promises'

import type { Context, SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '../../src/dsh/adapter.ts'
import { createGuardedHandler, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { installAuthBarrier } from '../../src/http/intercept.ts'
import { LOOPBACK_ONLY_PREFIXES, UNAUTHENTICATED_PANEL_PREFIXES } from '../../src/index.ts'
import { defaultSupervisorDeps } from '../../src/proc/supervisor.ts'
import { createHttpProbeTransport } from '../../src/tunnel/probe.ts'
import { createTunnelDiscovery, probeHttp } from '../../src/tunnel/discover.ts'
import { createTunnelReadiness, defaultReadinessDeps } from '../../src/tunnel/readiness.ts'
import { createTunnelSupervisor, type TunnelSupervisor } from '../../src/tunnel/supervisor.ts'
import { createStateStore, type StateStoreHandle } from '../../src/state/store.ts'
import { makeTempStateDir, type TempStateDir } from '../../test/support/state-dir.ts'
import { createFakeLogger } from '../../test/support/ctx-double.ts'
import { bancada, basic, OWNER_SECRET, type Bancada } from '../../test/unit/http/bancada.ts'

/** O dublê CONGELADO (prep-owned). NUNCA editado por esta suite (D15). */
const DOUBLE_PATH = fileURLToPath(new URL('../bin/fake-cloudflared.mjs', import.meta.url))

/** O IP real do cliente, como a borda o entrega (o mesmo do spike S2). */
const CLIENT_IP = '203.0.113.9'

/** Reserva uma porta livre soltando-a a seguir. Nunca uma porta fixa. */
async function reservePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('sem porta')
  return address.port
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

/** `-pid` alveja o GRUPO inteiro. ESRCH significa "ja nao existe": objetivo cumprido. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    void error
  }
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
 * POR-HANDLE: espera o fecho de CADA processo que esta suite spawnou.
 *
 * NAO ha pgrep global aqui, de proposito: o orquestrador corre ondas e
 * subwaves em PARALELO na mesma maquina (condicao normal do gate) e um pgrep
 * nao escopado contaria os processos de outra suite como residuo nosso — o
 * padrao `fake-cloudflared` no cmdline ate casa com processos que nunca
 * criamos. O sinal autoritativo do fecho e o `done` do HANDLE que o spawn
 * devolveu: ele resolve no `'close'` do processo, imune a reciclagem de pids
 * entre suites. A varredura GLOBAL de orfaos e responsabilidade do job
 * test-e2e do CI, nao do teste.
 */
async function assertFechados(filhos: readonly RealSubprocessHandle[], timeoutMs: number): Promise<void> {
  for (const filho of filhos) {
    const fechou = await Promise.race([
      filho.done.then(
        () => true,
        () => true,
      ),
      timersSleep(timeoutMs).then(() => false),
    ])
    assert.equal(
      fechou,
      true,
      'o processo que esta suite spawnou (pid ' + String(filho.pid) + ') tem de ter fechado',
    )
  }
}

/**
 * Assento de subprocesso REAL (o mesmo molde da suite irmã tunnel-discovery):
 * `done` resolve no FECHO, `terminate()` escala SIGTERM -> graceMs -> SIGKILL
 * sobre o GRUPO, e o `stdio` vem do spec.
 */
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

describe('T6.1 — ciclo completo do tunel com processos REAIS', () => {
  let b: Bancada
  let origin: Server
  let originPort = 0
  let edge: Server
  let edgePort = 0
  let reverter: (() => void) | undefined
  let supervisor: TunnelSupervisor
  let service: RealSubprocessService
  let storeHandle: StateStoreHandle
  let stateDir: TempStateDir
  /** A URL extraida da descoberta — a origem de TODOS os pedidos "de fora". */
  let tunnelUrl = ''
  let tunnelHost = ''
  /** Quantas vezes o despacho original foi alcancado (so 200 passa por ele). */
  let alcancouODespacho = 0

  /** Um pedido PELA URL PUBLICA do tunel — atravessa a borda, em absolute-form. */
  function pedirPelaTunelUrl(
    path: string,
    options: { readonly method?: string; readonly headers?: Record<string, string>; readonly host?: string } = {},
  ): Promise<Resposta> {
    const host = options.host ?? tunnelHost
    return new Promise<Resposta>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: edgePort,
          // absolute-form: a LINHA DE PEDIDO carrega a URL publica do tunel
          // (`GET https://<hostname>/api/state`), como um cliente real.
          path: 'https://' + host + path,
          method: options.method ?? 'GET',
          headers: { host, ...options.headers },
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

  /** O mesmo pedido DIRETO ao loopback — sem passar pela borda. */
  function pedirNoLoopback(path: string): Promise<Resposta> {
    return new Promise<Resposta>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: originPort,
          path,
          method: 'GET',
          headers: { host: '127.0.0.1:' + String(originPort) },
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
    /* --- A ORIGEM: um node:http.Server REAL com a barreira instalada, como
           em producao (src/index.ts). O despacho original responde 200 —
           so quem passar o portao o alcanca. --- */
    origin = createServer((_req, res) => {
      alcancouODespacho += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"superficie":"origem-e2e"}')
    })
    origin.on('upgrade', (_req, socket) => {
      socket.destroy()
    })
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()))
    originPort = (origin.address() as AddressInfo).port

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
        wrapRequest: (delegate) => createGuardedHandler(b.gate, delegate, 'e2e:request'),
        wrapUpgrade: (delegate) => createGuardedUpgradeHandler(b.gate, delegate, 'e2e:upgrade'),
      },
      b.gate.log,
    )

    /* --- ESTADO REAL + SUPERVISOR REAL, com processo REAL (o dublê). --- */
    stateDir = makeTempStateDir()
    storeHandle = createStateStore({ paths: { dir: stateDir.path, file: stateDir.statePath } })
    service = new RealSubprocessService()
    const logger = createFakeLogger()
    const ctx = { subprocess: service, logger } as unknown as Context
    const metricsPort = await reservePort()

    supervisor = createTunnelSupervisor({
      ctx,
      config: { mode: 'quick', ttlMinutes: 60, binaryPath: DOUBLE_PATH },
      resolveOrigin: () => origin,
      allocateMetricsPort: () => metricsPort,
      probe: {
        transport: createHttpProbeTransport({ host: '127.0.0.1', port: originPort, timeoutMs: 2000 }),
        newCanaryToken: () => 'canario-e2e-' + randomBytes(8).toString('hex'),
      },
      discovery: createTunnelDiscovery(),
      readiness: createTunnelReadiness({
        ...defaultReadinessDeps,
        // Offline (D10): a aplicacao responde na ORIGEM em loopback. A versao
        // que atravessa a borda real vive em test/live/**.
        probeUrl: async (_target: URL, signal: AbortSignal, timeoutMs: number) =>
          probeHttp({
            target: new URL('http://127.0.0.1:' + String(originPort) + '/'),
            signal,
            timeoutMs,
            maxBodyBytes: 0,
          }),
      }),
      store: storeHandle.store,
      tunnelOrigin: b.tunnelOrigin,
      sessions: { revokeAll: () => undefined },
      audit: { append: () => undefined },
      notifyOwner: () => undefined,
      proc: defaultSupervisorDeps,
    })

    /* --- A BORDA FALSA: o `cloudflared` + a borda da Cloudflare, em caixa
           preta. Reescreve `Host` para o nome publico, acrescenta os
           cabecalhos da borda e RECUSA quem enviar `CF-Connecting-IP`
           (R3, medido: `error code: 1000`). --- */
    edge = createServer((entrada: IncomingMessage, saida: ServerResponse) => {
      if (entrada.headers['cf-connecting-ip'] !== undefined) {
        saida.writeHead(403, { 'content-type': 'text/plain' })
        saida.end('error code: 1000\n')
        return
      }
      // O alvo vem da LINHA DE PEDIDO em absolute-form (`GET https://<host>/path`):
      // e o host do proprio pedido que decide para onde a borda encaminha e com
      // que `Host` — nunca uma variavel capturada, que ainda nao existe antes
      // de o tunel publicar (e seria um `Host` vazio, um pedido ilegal).
      const alvo = new URL(entrada.url ?? '/', 'http://127.0.0.1:' + String(edgePort))
      const headers: Record<string, string> = {}
      for (const [nome, valor] of Object.entries(entrada.headers)) {
        if (typeof valor === 'string') headers[nome] = valor
      }
      headers['host'] = alvo.host
      headers['x-forwarded-proto'] = 'https'
      headers['cf-connecting-ip'] = CLIENT_IP
      headers['x-forwarded-for'] =
        entrada.headers['x-forwarded-for'] === undefined ? CLIENT_IP : String(entrada.headers['x-forwarded-for']) + ',' + CLIENT_IP

      const encaminhado = request(
        {
          host: '127.0.0.1',
          port: originPort,
          path: alvo.pathname + alvo.search,
          method: entrada.method,
          headers,
        },
        (resposta) => {
          saida.writeHead(resposta.statusCode ?? 502, resposta.headers)
          resposta.pipe(saida)
        },
      )
      encaminhado.on('error', () => {
        saida.writeHead(502)
        saida.end()
      })
      entrada.pipe(encaminhado)
    })
    await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', () => resolve()))
    edgePort = (edge.address() as AddressInfo).port
  })

  after(async () => {
    reverter?.()
    supervisor.dispose()
    service.killAll()
    await service.settleAll()
    b.cleanup()
    storeHandle.dispose()
    stateDir.cleanup()
    await closeServer(origin)
    await closeServer(edge)
    // POR-HANDLE, e nao pgrep global: o `after` mata TUDO o que esta suite
    // criou (killAll + fecho) e assere pelo `done` de cada handle — imune a
    // suites paralelas na mesma maquina e a pids reciclados.
    await assertFechados(service.children, 5_000)
  })

  it('start -> READY -> 401/200 pela URL do tunel -> stop -> 403, sem orfaos', async () => {
    /* ---------- 1. ANTES do start: o nome do tunel nao existe na allowlist. */
    const antes = await pedirPelaTunelUrl('/api/state', { host: 'ainda-nao-existe.trycloudflare.com' })
    assert.equal(antes.status, 403, 'sem tunel publicado, o Host do tunel e recusado no perimetro')
    assert.equal(alcancouODespacho, 0)
    /* ---------- 2. start -> READY (probe fail-closed primeiro, spawn depois). */
    await supervisor.start()
    const pronto = await waitFor(() => supervisor.snapshot().state === 'READY', { timeoutMs: 20_000 })
    assert.equal(pronto, true, 'o tunel devia ter ficado READY')
    const snap = supervisor.snapshot()
    assert.equal(snap.state, 'READY')
    assert.ok(snap.info !== undefined, 'READY tem de divulgar a URL')
    tunnelUrl = snap.info.url
    tunnelHost = new URL(tunnelUrl).host
    // A URL foi EXTRAIDA do processo real: esquema https:// + hostname publico.
    assert.match(tunnelUrl, /^https:\/\/[-a-z0-9]+\.trycloudflare\.com$/u)
    assert.equal(b.tunnelOrigin.current(), tunnelUrl, 'READY publicou a URL no registo que o portao le')

    /* ---------- 3. PELA URL DO TUNEL: 401 sem credencial. ---------- */
    const semCredencial = await pedirPelaTunelUrl('/api/state')
    assert.equal(semCredencial.status, 401, 'sem credencial, o portao responde 401')
    // Onda 1: o 401 do tunel NAO emite `WWW-Authenticate` (nunca mais o popup).
    assert.equal(semCredencial.challenge, undefined, 'o 401 do tunel NAO traz desafio')
    assert.equal(alcancouODespacho, 0, 'o 401 nao alcanca o despacho')

    /* ---------- 4. PELA URL DO TUNEL: 200 com SESSAO. ---------- */
    const comSessao = await pedirPelaTunelUrl('/api/state', { headers: { cookie: b.emitirSessao() } })
    assert.equal(comSessao.status, 200, 'com sessao, o portao deixa passar')
    assert.equal(comSessao.body, '{"superficie":"origem-e2e"}', 'o despacho original foi alcancado')
    assert.equal(alcancouODespacho, 1)

    /* ---------- 5. PELA URL DO TUNEL: 200 com credencial basica. ---------- */
    const comCredencial = await pedirPelaTunelUrl('/api/state', { headers: { authorization: basic(OWNER_SECRET) } })
    assert.equal(comCredencial.status, 200)
    assert.equal(alcancouODespacho, 2)

    /* ---------- 6. Host que NAO e o publicado: 403 no perimetro. ---------- */
    const hostEstranho = await pedirPelaTunelUrl('/api/state', { host: 'outro-tunel.trycloudflare.com' })
    assert.equal(hostEstranho.status, 403, 'a allowlist de Host so tem o nome publicado')
    assert.equal(alcancouODespacho, 2)

    /* ---------- 7. stop: o tunel cai e o nome sai da allowlist. ---------- */
    supervisor.stop()
    const parado = await waitFor(() => supervisor.snapshot().state === 'STOPPED')
    assert.equal(parado, true)
    assert.equal(b.tunnelOrigin.current(), undefined, 'parado, o nome publico sai do registo')

    /* ---------- 8. O DESCRIMINADOR: pela URL -> 403; direto -> 401. ---------- */
    const depois = await pedirPelaTunelUrl('/api/state')
    assert.equal(depois.status, 403, 'depois de stop, o Host do tunel e recusado no perimetro')
    const direto = await pedirNoLoopback('/api/state')
    assert.equal(direto.status, 401, 'o portao continua armado no loopback')
    assert.equal(alcancouODespacho, 2, 'nem o 403 nem o 401 alcancam o despacho')

    /* ---------- 9. SEM PROCESSO ORFAO: o dublê saiu de vez. ---------- */
    assert.equal(service.children.length, 1, 'exatamente um processo de tunel foi spawnado')
    const child = service.children[0]
    assert.ok(child !== undefined, 'o unico filho tem de existir')
    // POR-HANDLE: o fecho do processo que ESTA suite criou, e nao um pgrep
    // global (ver o cabecalho de assertFechados).
    await assertFechados([child], 10_000)
  })
})
