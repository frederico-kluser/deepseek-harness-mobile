/**
 * =============================================================================
 * Testes de `src/index.ts` (dsh-guarded-bot-orchestrator)
 * =============================================================================
 *
 * Executados por `node --test` (Node >= 24 faz *type stripping* nativo, pelo
 * que os ficheiros `.ts` correm sem passo de compilacao).
 *
 * PRINCIPIO: nao se sobe servidor HTTP real nem se lanca Python real. Todas as
 * costuras do Cordis (`Context`, `WebServer`, `SubprocessService`, agendador,
 * `process.kill`) sao DUBLES controlados. O que se testa e o COMPORTAMENTO do
 * portao, nao o `node:http`.
 *
 * Nota sobre os dubles: sao objetos simples convertidos com
 * `as unknown as <Interface>`. A conversao e deliberada -- implementar as
 * assinaturas genericas de `Context` por inteiro num duble nao acrescentaria
 * cobertura nenhuma e so tornaria os testes ilegiveis.
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context, Disposer } from '@deepseek-ai/cordis'
import type { WebHandler, WebServer, WebUpgradeHandler } from '@deepseek-ai/dsh-host-webserver'
import type { ChildProcess, SpawnOptions } from '@deepseek-ai/dsh-host-subprocess'

import {
  apply,
  assertSecureBind,
  assertValidConfig,
  buildWorkerEnv,
  canonicalRequestPath,
  computeBackoffDelay,
  createWorkerSupervisor,
  inject,
  isGuardedPath,
  isTrustedRemote,
  name,
  normalizeRemoteAddress,
  requestsDeniedPermission,
  routeMayServeGuardedPath,
  verifyBasicAuth,
  type Config,
  type Scheduler,
  type SupervisorDeps,
  type TimerHandle,
  type WorkerSupervisor,
} from '../src/index.ts'

/**
 * `assertValidConfig` exige que `worker.cwd` EXISTA (uma falha de spawn por
 * cwd inexistente nao emite `'exit'`, ver A-HIGH). Usa-se o diretorio temporario
 * do sistema, que existe sempre e nao precisa de limpeza.
 */
const WORKER_CWD = tmpdir()

/* ========================================================================== */
/* Credenciais de teste                                                       */
/* ========================================================================== */

const VALID_CREDENTIAL = Buffer.from('admin:s3cr3t').toString('base64')
const WRONG_CREDENTIAL = Buffer.from('admin:errada').toString('base64')

/* ========================================================================== */
/* Dubles                                                                     */
/* ========================================================================== */

interface LogEntry {
  level: string
  scope: string
  message: string
}

class FakeLogger {
  readonly entries: LogEntry[] = []

  info(scope: string, message: string): void {
    this.entries.push({ level: 'info', scope, message })
  }

  warn(scope: string, message: string): void {
    this.entries.push({ level: 'warn', scope, message })
  }

  error(scope: string, message: string): void {
    this.entries.push({ level: 'error', scope, message })
  }

  debug(scope: string, message: string): void {
    this.entries.push({ level: 'debug', scope, message })
  }

  has(level: string, fragment: string): boolean {
    return this.entries.some((entry) => entry.level === level && entry.message.includes(fragment))
  }
}

interface RouteRecord {
  kind: string
  path: string
  handler: WebHandler
}

interface UpgradeRecord {
  path: string
  handler: WebUpgradeHandler
}

class FakeWebServer {
  host = '127.0.0.1'
  port = 3080
  fallbackHandler: WebHandler | undefined = undefined
  readonly routes: RouteRecord[] = []
  readonly upgrades: UpgradeRecord[] = []
  readonly disposed: string[] = []

  register(route: RouteRecord): Disposer {
    this.routes.push(route)
    return (): void => {
      this.disposed.push(`register:${route.path}`)
    }
  }

  registerFallback(handler: WebHandler): Disposer {
    this.fallbackHandler = handler
    return (): void => {
      this.disposed.push('fallback')
    }
  }

  registerUpgrade(route: UpgradeRecord): Disposer {
    this.upgrades.push(route)
    return (): void => {
      this.disposed.push(`upgrade:${route.path}`)
    }
  }

  asWebServer(): WebServer {
    return this as unknown as WebServer
  }
}

/**
 * Duble do `Duplex` de um handshake de upgrade. Num tratador de `'upgrade'`
 * nao ha `ServerResponse`: quem recusa escreve a resposta HTTP CRUA no socket
 * e destroi-o. E isso que se observa aqui.
 */
class FakeSocket {
  written = ''
  destroyed = false

  write(chunk: string): boolean {
    this.written += chunk
    return true
  }

  destroy(): void {
    this.destroyed = true
  }

  asDuplex(): Duplex {
    return this as unknown as Duplex
  }
}

/**
 * Duble de `ChildProcess` FIEL AO `node:child_process` no que interessa ao
 * ciclo de vida.
 *
 * PORQUE ISTO IMPORTA (achado A-HIGH): a versao anterior deste duble tinha
 * `killed = false` fixo e IGNORAVA o `AbortSignal`. A suite exercitava assim um
 * estado que NAO EXISTE em producao, e o teste do tree-kill passava apenas
 * porque o duble mentia -- prova por mutacao: remover a guarda `current.killed`
 * do disposer deixava 49/49 testes a passar, apesar de essa guarda tornar o
 * tree-kill codigo morto e deixar netos orfaos.
 *
 * O que o Node faz de verdade, e que este duble replica:
 *   - ao abortar o `AbortSignal`, `abortChildProcess()` chama `child.kill()`
 *     SINCRONAMENTE (logo `killed` passa a `true` durante o proprio
 *     `abortController.abort()`);
 *   - se esse `kill()` devolver `true`, e emitido um `'error'` com um
 *     AbortError.
 *
 * O que NAO se replica (de proposito): o `'exit'` assincrono, que no Node
 * depende do processo real. Cada teste emite-o explicitamente quando quer.
 */
class FakeChildProcess extends EventEmitter {
  pid: number | undefined
  killed = false
  /** Sinais entregues por `kill()` (observabilidade do duble). */
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = []
  stdout: EventEmitter | null = new EventEmitter()
  stderr: EventEmitter | null = new EventEmitter()

  constructor(pid: number | undefined, signal?: AbortSignal | undefined) {
    super()
    this.pid = pid

    signal?.addEventListener('abort', (): void => {
      if (this.kill()) {
        const abortError = new Error('The operation was aborted')
        abortError.name = 'AbortError'
        this.emit('error', abortError)
      }
    })
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal)
    this.killed = true
    return true
  }
}

interface SpawnRecord {
  command: string
  args: readonly string[]
  options: SpawnOptions | undefined
}

class FakeSubprocessService {
  /** pid atribuido aos filhos criados. `undefined` evita qualquer kill real. */
  pid: number | undefined = undefined
  readonly calls: SpawnRecord[] = []
  readonly children: FakeChildProcess[] = []

  spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess {
    const child = new FakeChildProcess(this.pid, options?.signal)
    this.calls.push({ command, args, options })
    this.children.push(child)
    return child as unknown as ChildProcess
  }

  lastChild(): FakeChildProcess {
    const child = this.children[this.children.length - 1]
    if (child === undefined) throw new Error('nenhum subprocesso foi criado')
    return child
  }
}

type AnyListener = (...args: never[]) => Promise<unknown>

class FakeContext {
  readonly logger = new FakeLogger()
  readonly webServer = new FakeWebServer()
  readonly subprocess = new FakeSubprocessService()
  readonly listeners = new Map<string, AnyListener[]>()
  readonly effects: Disposer[] = []
  interceptedMethods: Record<string, unknown> | undefined = undefined

  intercept(serviceName: string, methods: Record<string, unknown>): unknown {
    assert.equal(serviceName, 'webServer')
    this.interceptedMethods = methods
    return this
  }

  on(event: string, listener: AnyListener): Disposer {
    const bucket = this.listeners.get(event) ?? []
    bucket.push(listener)
    this.listeners.set(event, bucket)
    return (): void => {
      const current = this.listeners.get(event) ?? []
      const index = current.indexOf(listener)
      if (index !== -1) current.splice(index, 1)
    }
  }

  /**
   * Cascata real: cada ouvinte recebe os parametros do evento seguidos de um
   * `next` que avanca para o ouvinte seguinte, terminando no `next` fornecido
   * pelo emissor. Um ouvinte que devolva sem invocar `next` corta a cascata.
   */
  async waterfall(event: string, ...args: unknown[]): Promise<unknown> {
    const bucket = [...(this.listeners.get(event) ?? [])]
    const terminal = args[args.length - 1] as () => Promise<unknown>
    const head = args.slice(0, -1)

    const run = async (index: number): Promise<unknown> => {
      const listener = bucket[index]
      if (listener === undefined) return terminal()
      const forward = async (): Promise<unknown> => run(index + 1)
      return (listener as (...a: unknown[]) => Promise<unknown>)(...head, forward)
    }

    return run(0)
  }

  async parallel(): Promise<void> {
    // Nao usado pelo plugin; existe apenas para completar a superficie.
  }

  effect(factory: () => Disposer): Disposer {
    const disposer = factory()
    this.effects.push(disposer)
    return disposer
  }

  get(serviceName: string): unknown {
    if (serviceName === 'webServer') return this.webServer
    if (serviceName === 'subprocess') return this.subprocess
    return undefined
  }

  asContext(): Context {
    return this as unknown as Context
  }

  methods(): Record<string, unknown> {
    if (this.interceptedMethods === undefined) throw new Error('ctx.intercept nao foi invocado')
    return this.interceptedMethods
  }

  registerFallbackInterceptor(): (this: WebServer, handler: WebHandler) => Disposer {
    return this.methods()['registerFallback'] as (this: WebServer, handler: WebHandler) => Disposer
  }

  registerInterceptor(): (this: WebServer, route: RouteRecord) => Disposer {
    return this.methods()['register'] as (this: WebServer, route: RouteRecord) => Disposer
  }

  registerUpgradeInterceptor(): (this: WebServer, route: UpgradeRecord) => Disposer {
    return this.methods()['registerUpgrade'] as (this: WebServer, route: UpgradeRecord) => Disposer
  }
}

class FakeResponse {
  statusCode: number | undefined = undefined
  readonly headers: Record<string, string> = {}
  body = ''
  ended = false

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status
    if (headers !== undefined) Object.assign(this.headers, headers)
    return this
  }

  end(chunk?: string): this {
    if (chunk !== undefined) this.body += chunk
    this.ended = true
    return this
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse
  }
}

interface RequestOptions {
  remoteAddress?: string | undefined
  authorization?: string | undefined
  method?: string
  url?: string
}

function makeRequest(options: RequestOptions = {}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (options.authorization !== undefined) headers['authorization'] = options.authorization

  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers,
    socket: { remoteAddress: options.remoteAddress },
  } as unknown as IncomingMessage
}

/* ========================================================================== */
/* Agendador falso                                                            */
/* ========================================================================== */

interface ScheduledTask {
  id: number
  delayMs: number
  callback: () => void
  cleared: boolean
  /** Ja disparou. Um temporizador que disparou deixou de estar VIVO. */
  fired: boolean
}

class FakeScheduler implements Scheduler {
  readonly scheduled: ScheduledTask[] = []
  readonly clearedIds: number[] = []
  private nextId = 1

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const task: ScheduledTask = {
      id: this.nextId++,
      delayMs,
      callback,
      cleared: false,
      fired: false,
    }
    this.scheduled.push(task)
    return task
  }

  clearTimeout(handle: TimerHandle): void {
    const task = handle as ScheduledTask
    task.cleared = true
    this.clearedIds.push(task.id)
  }

  /** Temporizadores VIVOS: agendados, por cancelar e ainda por disparar. */
  get pending(): ScheduledTask[] {
    return this.scheduled.filter((task) => !task.cleared && !task.fired)
  }

  runLast(): void {
    const task = this.scheduled[this.scheduled.length - 1]
    if (task === undefined) throw new Error('nenhuma tarefa agendada')
    if (task.cleared) throw new Error('tarefa ja cancelada')
    task.fired = true
    task.callback()
  }

  delays(): number[] {
    return this.scheduled.map((task) => task.delayMs)
  }
}

/* ========================================================================== */
/* Fabricas de configuracao / instalacao                                      */
/* ========================================================================== */

function makeConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    encodedAuthString: VALID_CREDENTIAL,
    realm: 'Secure DSH Interface',
    allowedHosts: ['127.0.0.1', '::1'],
    trustedRemotes: ['127.0.0.1'],
    guardedPrefixes: ['/api'],
    deniedPermissions: ['danger-full-access'],
    worker: {
      command: 'python3',
      args: ['bot_long_polling.py'],
      cwd: WORKER_CWD,
      token: 'token-de-teste',
      backoff: {
        initialDelayMs: 500,
        maxDelayMs: 10000,
        maxAttempts: 10,
        resetAfterMs: 60000,
      },
    },
  }

  return Object.assign(base, overrides)
}

interface Installation {
  ctx: FakeContext
  config: Config
}

function install(overrides: Partial<Config> = {}): Installation {
  const ctx = new FakeContext()
  const config = makeConfig(overrides)
  apply(ctx.asContext(), config)
  return { ctx, config }
}

/** Monta o fallback guardado e devolve o handler que o servidor recebeu. */
function mountFallback(
  ctx: FakeContext,
  originalHandler: WebHandler,
): { handler: WebHandler; disposer: Disposer } {
  const disposer = ctx.registerFallbackInterceptor().call(ctx.webServer.asWebServer(), originalHandler)
  const handler = ctx.webServer.fallbackHandler
  if (handler === undefined) throw new Error('registerFallback nao chegou ao servidor')
  return { handler, disposer }
}

/** Monta uma rota via `register` e devolve o registo efetivamente recebido. */
function mountRoute(
  ctx: FakeContext,
  route: RouteRecord,
): { record: RouteRecord; disposer: Disposer } {
  const disposer = ctx.registerInterceptor().call(ctx.webServer.asWebServer(), route)
  const record = ctx.webServer.routes[ctx.webServer.routes.length - 1]
  if (record === undefined) throw new Error('register nao chegou ao servidor')
  return { record, disposer }
}

/** Monta um handshake de upgrade e devolve o registo efetivamente recebido. */
function mountUpgrade(
  ctx: FakeContext,
  route: UpgradeRecord,
): { record: UpgradeRecord; disposer: Disposer } {
  const disposer = ctx.registerUpgradeInterceptor().call(ctx.webServer.asWebServer(), route)
  const record = ctx.webServer.upgrades[ctx.webServer.upgrades.length - 1]
  if (record === undefined) throw new Error('registerUpgrade nao chegou ao servidor')
  return { record, disposer }
}

/**
 * Corre um handshake de upgrade guardado e espera pela decisao.
 *
 * O tratador de `'upgrade'` e SINCRONO por assinatura (`=> void`) mas decide
 * dentro de uma IIFE assincrona; um `setImmediate` basta para drenar as
 * microtasks dessa cascata antes de observar o socket.
 */
async function runUpgrade(
  handler: WebUpgradeHandler,
  req: IncomingMessage,
): Promise<FakeSocket> {
  const socket = new FakeSocket()
  handler(req, socket.asDuplex(), Buffer.alloc(0))
  await new Promise<void>((resolve) => setImmediate(resolve))
  return socket
}

function makeSupervisorDeps(
  scheduler: FakeScheduler,
  overrides: Partial<SupervisorDeps> = {},
): { deps: SupervisorDeps; kills: Array<[number, string]>; clock: { value: number } } {
  const kills: Array<[number, string]> = []
  const clock = { value: 0 }

  const deps: SupervisorDeps = Object.assign(
    {
      scheduler,
      // `random() === 0` e agora o caso determinista da PROGRESSAO NOMINAL: o
      // jitter passou a ser somado POR CIMA da base (piso = initialDelayMs),
      // em vez de subtraido dela (piso = initialDelayMs/2).
      random: (): number => 0,
      now: (): number => clock.value,
      platform: 'linux' as NodeJS.Platform,
      kill: (pid: number, signal: NodeJS.Signals): void => {
        kills.push([pid, signal])
      },
    },
    overrides,
  )

  return { deps, kills, clock }
}

/* ========================================================================== */
/* 0. Manifesto                                                               */
/* ========================================================================== */

describe('manifesto do plugin', () => {
  it('expoe o nome e as dependencias injetadas exigidas pelo contrato', () => {
    assert.equal(name, 'dsh-guarded-bot-orchestrator')
    assert.deepEqual(inject, ['webServer', 'subprocess', 'logger'])
  })
})

/* ========================================================================== */
/* 1. Barreira de autenticacao sobre o fallback                               */
/* ========================================================================== */

describe('barreira Basic Auth sobre registerFallback', () => {
  it('devolve 401 com WWW-Authenticate quando a credencial esta ausente', async () => {
    const { ctx, config } = install()
    let originalCalled = false

    const { handler } = mountFallback(ctx, (): void => {
      originalCalled = true
    })

    const res = new FakeResponse()
    await handler(makeRequest({ remoteAddress: '127.0.0.1' }), res.asServerResponse())

    assert.equal(res.statusCode, 401)
    assert.equal(
      res.headers['WWW-Authenticate'],
      `Basic realm="${config.realm}", charset="UTF-8"`,
    )
    assert.equal(res.ended, true)
    assert.equal(originalCalled, false, 'o handler original NAO pode ser alcancado')
  })

  it('devolve 401 quando a credencial esta errada', async () => {
    const { ctx } = install()
    let originalCalled = false

    const { handler } = mountFallback(ctx, (): void => {
      originalCalled = true
    })

    const res = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '127.0.0.1', authorization: `Basic ${WRONG_CREDENTIAL}` }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
    assert.equal(originalCalled, false)
  })

  it('deixa passar (pass-through) com a credencial correta', async () => {
    const { ctx } = install()
    let originalCalled = false

    const { handler } = mountFallback(ctx, (_req, res): void => {
      originalCalled = true
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>SPA</html>')
    })

    const res = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '127.0.0.1', authorization: `Basic ${VALID_CREDENTIAL}` }),
      res.asServerResponse(),
    )

    assert.equal(originalCalled, true)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, '<html>SPA</html>')
  })

  it('aceita o loopback entregue como IPv4 mapeado em IPv6', async () => {
    const { ctx } = install()
    let originalCalled = false

    const { handler } = mountFallback(ctx, (): void => {
      originalCalled = true
    })

    const res = new FakeResponse()
    await handler(
      makeRequest({
        remoteAddress: '::ffff:127.0.0.1',
        authorization: `Basic ${VALID_CREDENTIAL}`,
      }),
      res.asServerResponse(),
    )

    assert.equal(originalCalled, true)
  })

  it('propaga o disposer nativo devolvido por registerFallback', () => {
    const { ctx } = install()
    const { disposer } = mountFallback(ctx, (): void => {})

    assert.equal(typeof disposer, 'function')
    assert.equal(disposer(), undefined)
    assert.deepEqual(ctx.webServer.disposed, ['fallback'])
  })

  it('nao consome o corpo da requisicao ao decidir', async () => {
    const { ctx } = install()
    const { handler } = mountFallback(ctx, (): void => {})

    // Um `IncomingMessage` sem qualquer API de stream: se o plugin tentasse ler
    // o corpo (`on('data')`, `read()`, `for await`), este teste rebentava.
    const req = {
      method: 'POST',
      url: '/api/commands/execute',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage

    const res = new FakeResponse()
    await handler(req, res.asServerResponse())

    assert.equal(res.statusCode, 401)
  })
})

/* ========================================================================== */
/* 2. Perimetro de rede (403 / fail-closed)                                   */
/* ========================================================================== */

describe('allowlist de origens remotas', () => {
  it('devolve 403 (e nao 401) a uma origem fora de trustedRemotes', async () => {
    const { ctx } = install()
    let originalCalled = false

    const { handler } = mountFallback(ctx, (): void => {
      originalCalled = true
    })

    const res = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '10.0.0.7', authorization: `Basic ${VALID_CREDENTIAL}` }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 403)
    assert.equal(res.headers['WWW-Authenticate'], undefined, '403 nao pode desafiar credencial')
    assert.equal(originalCalled, false)
  })

  it('trustedRemotes vazio nega TODA a gente (fail-closed), incluindo o loopback', async () => {
    const { ctx } = install({ trustedRemotes: [] })
    let originalCalled = false

    const { handler } = mountFallback(ctx, (): void => {
      originalCalled = true
    })

    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.7']) {
      const res = new FakeResponse()
      await handler(
        makeRequest({ remoteAddress, authorization: `Basic ${VALID_CREDENTIAL}` }),
        res.asServerResponse(),
      )
      assert.equal(res.statusCode, 403, `origem ${remoteAddress} devia ser recusada`)
    }

    assert.equal(originalCalled, false)
    assert.equal(
      ctx.logger.has('warn', 'fail-closed'),
      true,
      'a configuracao inoperante tem de ser sinalizada no arranque',
    )
  })

  it('nega um socket sem remoteAddress', () => {
    assert.equal(isTrustedRemote(undefined, ['127.0.0.1']), false)
    assert.equal(isTrustedRemote(null, ['127.0.0.1']), false)
    assert.equal(isTrustedRemote('', ['127.0.0.1']), false)
  })

  it('normaliza IPv6-mapeado, loopback IPv6, zone id e parenteses', () => {
    assert.equal(normalizeRemoteAddress('::ffff:127.0.0.1'), '127.0.0.1')
    assert.equal(normalizeRemoteAddress('::1'), '127.0.0.1')
    assert.equal(normalizeRemoteAddress('0:0:0:0:0:0:0:1'), '127.0.0.1')
    assert.equal(normalizeRemoteAddress('[::1]'), '127.0.0.1')
    assert.equal(normalizeRemoteAddress('fe80::1%eth0'), 'fe80::1')
    assert.equal(normalizeRemoteAddress('  10.0.0.7  '), '10.0.0.7')
    assert.equal(normalizeRemoteAddress(undefined), undefined)
  })

  it('uma entrada "::1" na allowlist cobre tambem o loopback IPv4', () => {
    assert.equal(isTrustedRemote('127.0.0.1', ['::1']), true)
    assert.equal(isTrustedRemote('::ffff:127.0.0.1', ['::1']), true)
    assert.equal(isTrustedRemote('10.0.0.7', ['::1']), false)
  })
})

/* ========================================================================== */
/* 3. #853 fechada: as rotas /api NAO passam pelo fallback                    */
/* ========================================================================== */

describe('guarda das rotas registadas (mitigacao da discussao #853)', () => {
  it('barra uma rota exact sob /api registada via register()', async () => {
    const { ctx } = install()
    let rpcExecuted = false

    const { record } = mountRoute(ctx, {
      kind: 'exact',
      path: '/api/commands/execute',
      handler: (_req, res): void => {
        rpcExecuted = true
        res.writeHead(200)
        res.end('{"ok":true}')
      },
    })

    // O handler recebido pelo servidor TEM de ser o envelope, nao o original.
    assert.notEqual(record.handler, undefined)

    const res = new FakeResponse()
    await record.handler(
      makeRequest({
        method: 'POST',
        url: '/api/commands/execute',
        remoteAddress: '127.0.0.1',
      }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401, 'a RPC nao autenticada tem de ser barrada')
    assert.equal(rpcExecuted, false, 'commands/execute NAO pode correr sem credencial')
  })

  it('deixa a mesma rota /api passar quando a credencial esta correta', async () => {
    const { ctx } = install()
    let rpcExecuted = false

    const { record } = mountRoute(ctx, {
      kind: 'exact',
      path: '/api/commands/execute',
      handler: (_req, res): void => {
        rpcExecuted = true
        res.writeHead(200)
        res.end('{"ok":true}')
      },
    })

    const res = new FakeResponse()
    await record.handler(
      makeRequest({
        method: 'POST',
        url: '/api/commands/execute',
        remoteAddress: '127.0.0.1',
        authorization: `Basic ${VALID_CREDENTIAL}`,
      }),
      res.asServerResponse(),
    )

    assert.equal(rpcExecuted, true)
    assert.equal(res.statusCode, 200)
  })

  it('barra tambem uma rota prefix sob /api', async () => {
    const { ctx } = install()
    let called = false

    const { record } = mountRoute(ctx, {
      kind: 'prefix',
      path: '/api',
      handler: (): void => {
        called = true
      },
    })

    const res = new FakeResponse()
    await record.handler(
      makeRequest({ url: '/api/session/list', remoteAddress: '127.0.0.1' }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
    assert.equal(called, false)
  })

  it('NAO envolve rotas fora dos prefixos guardados', async () => {
    const { ctx } = install()
    const original: WebHandler = (_req, res): void => {
      res.writeHead(200)
      res.end('pong')
    }

    const { record } = mountRoute(ctx, { kind: 'exact', path: '/healthz', handler: original })

    assert.equal(record.handler, original, 'rota nao guardada tem de seguir intacta')

    const res = new FakeResponse()
    await record.handler(makeRequest({ url: '/healthz' }), res.asServerResponse())
    assert.equal(res.statusCode, 200)
  })

  it('propaga o disposer nativo de register()', () => {
    const { ctx } = install()
    const { disposer } = mountRoute(ctx, {
      kind: 'exact',
      path: '/api/health',
      handler: (): void => {},
    })

    assert.equal(typeof disposer, 'function')
    disposer()
    assert.deepEqual(ctx.webServer.disposed, ['register:/api/health'])
  })

  it('isGuardedPath separa /api de /apinfo e ignora a query string', () => {
    assert.equal(isGuardedPath('/api', ['/api']), true)
    assert.equal(isGuardedPath('/api/commands/execute', ['/api']), true)
    assert.equal(isGuardedPath('/api?x=1', ['/api']), true)
    assert.equal(isGuardedPath('/apinfo', ['/api']), false)
    assert.equal(isGuardedPath('/', ['/api']), false)
    assert.equal(isGuardedPath('/qualquer', ['/']), true)
  })
})

/* ========================================================================== */
/* 4. Veto de elevacao de permissao                                           */
/* ========================================================================== */

describe('veto de danger-full-access', () => {
  it('curto-circuita a cascata sem invocar next()', async () => {
    const { ctx } = install()
    let nextCalled = false

    const result = await ctx
      .asContext()
      .waterfall('security/permission-elevate', '/permission danger-full-access', async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, false, 'o pedido de elevacao tem de ser vetado')
    assert.equal(nextCalled, false, 'next() NAO pode ser invocado num veto')
    assert.equal(ctx.logger.has('error', 'VETO de elevacao de permissao'), true)
  })

  it('deixa passar permissoes que nao constam de deniedPermissions', async () => {
    const { ctx } = install()
    let nextCalled = false

    const result = await ctx
      .asContext()
      .waterfall('security/permission-elevate', '/permission workspace-write', async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, true)
    assert.equal(nextCalled, true)
  })

  it('a analise e por token (nao apanha danger-full-access-audit)', () => {
    assert.equal(
      requestsDeniedPermission('/permission danger-full-access', ['danger-full-access']),
      'danger-full-access',
    )
    assert.equal(
      requestsDeniedPermission('/PERMISSION   DANGER-FULL-ACCESS', ['danger-full-access']),
      'danger-full-access',
    )
    assert.equal(
      requestsDeniedPermission('/permission danger-full-access-audit', ['danger-full-access']),
      undefined,
    )
    assert.equal(requestsDeniedPermission('/permission workspace-write', ['danger-full-access']), undefined)
  })

  it('o veto desaparece quando o disposer do efeito corre (reversibilidade)', async () => {
    const { ctx } = install()
    const vetoDisposer = ctx.effects[0]
    assert.equal(typeof vetoDisposer, 'function')

    vetoDisposer?.()

    let nextCalled = false
    const result = await ctx
      .asContext()
      .waterfall('security/permission-elevate', '/permission danger-full-access', async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, true)
    assert.equal(nextCalled, true, 'sem o ouvinte, a cascata chega ao next terminal')
  })
})

/* ========================================================================== */
/* 5. Cascata http/auth-check                                                 */
/* ========================================================================== */

describe('cascata http/auth-check', () => {
  it('permanece fail-closed quando o ouvinte do plugin e removido', async () => {
    const { ctx } = install()
    const { handler } = mountFallback(ctx, (): void => {})

    // Remove-se o ouvinte de autenticacao (efeito 1): a decisao passa a
    // depender apenas do `next` terminal, que repete a verificacao.
    ctx.effects[1]?.()

    const res = new FakeResponse()
    await handler(makeRequest({ remoteAddress: '127.0.0.1' }), res.asServerResponse())
    assert.equal(res.statusCode, 401)

    const okRes = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '127.0.0.1', authorization: `Basic ${VALID_CREDENTIAL}` }),
      okRes.asServerResponse(),
    )
    assert.equal(okRes.statusCode, undefined, 'com credencial valida o fluxo delega no original')
  })

  it('um ouvinte externo pode vetar mesmo com credencial valida', async () => {
    const { ctx } = install()
    ctx.on('http/auth-check', async (): Promise<boolean> => false)

    const { handler } = mountFallback(ctx, (): void => {
      throw new Error('nao devia ser alcancado')
    })

    const res = new FakeResponse()
    await handler(
      makeRequest({ remoteAddress: '127.0.0.1', authorization: `Basic ${VALID_CREDENTIAL}` }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
  })
})

/* ========================================================================== */
/* 6. Comparacao de credencial                                                */
/* ========================================================================== */

describe('verifyBasicAuth', () => {
  it('aceita apenas a credencial exata', () => {
    assert.equal(verifyBasicAuth(`Basic ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), true)
    assert.equal(verifyBasicAuth(`Basic ${WRONG_CREDENTIAL}`, VALID_CREDENTIAL), false)
  })

  it('recusa cabecalho ausente, esquema errado ou credencial vazia', () => {
    assert.equal(verifyBasicAuth(undefined, VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth('', VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth(`Bearer ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth('Basic ', VALID_CREDENTIAL), false)
  })

  it('nao lanca perante comprimentos diferentes (digest de tamanho fixo)', () => {
    assert.doesNotThrow(() => verifyBasicAuth('Basic a', VALID_CREDENTIAL))
    assert.equal(verifyBasicAuth('Basic a', VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth(`Basic ${VALID_CREDENTIAL}xxxxxxxxxxxx`, VALID_CREDENTIAL), false)
  })
})

/* ========================================================================== */
/* 7. Recuo exponencial                                                       */
/* ========================================================================== */

describe('computeBackoffDelay', () => {
  const backoff = {
    initialDelayMs: 500,
    maxDelayMs: 10000,
    maxAttempts: 10,
    resetAfterMs: 60000,
  }

  it('cresce de 500 ms ate ao teto de 10000 ms e satura', () => {
    // `random() === 0` = sem jitter = progressao nominal exata. (Era `() => 1`
    // quando o jitter era subtraido da base; agora e somado por cima dela.)
    const sequence = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) =>
      computeBackoffDelay(attempt, backoff, () => 0),
    )

    assert.deepEqual(sequence, [500, 1000, 2000, 4000, 8000, 10000, 10000, 10000])
  })

  it('o PISO nunca fica abaixo de initialDelayMs (jitter por cima da base)', () => {
    // Regressao do achado A-LOW: com "equal jitter" (base/2 + random*base/2) o
    // atraso da primeira tentativa descia a 250 ms -- METADE do initialDelayMs
    // de 500 ms que o DSH prescreve como base cronologica inicial imposta.
    for (const random of [0, 0.001, 0.25, 0.5, 0.75, 1]) {
      assert.equal(
        computeBackoffDelay(1, backoff, () => random) >= backoff.initialDelayMs,
        true,
        `random=${random} nao pode produzir atraso abaixo de initialDelayMs`,
      )
    }

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      for (const random of [0, 0.3, 1]) {
        const delay = computeBackoffDelay(attempt, backoff, () => random)
        assert.equal(delay >= backoff.initialDelayMs, true)
        assert.equal(delay <= backoff.maxDelayMs, true)
      }
    }
  })

  it('nunca excede maxDelayMs e o atraso cresce com o jitter', () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const low = computeBackoffDelay(attempt, backoff, () => 0)
      const high = computeBackoffDelay(attempt, backoff, () => 1)
      const mid = computeBackoffDelay(attempt, backoff, () => 0.5)

      assert.equal(high <= backoff.maxDelayMs, true)
      assert.equal(low <= high, true, 'a base e o piso; o jitter so pode somar')
      assert.equal(mid >= low && mid <= high, true)
    }
  })

  it('o jitter dispersa o instante de reinicio (sem thundering herd)', () => {
    const values = new Set<number>()
    for (let i = 0; i < 200; i += 1) values.add(computeBackoffDelay(5, backoff, Math.random))
    assert.equal(values.size > 1, true, 'com jitter os atrasos nao podem coincidir sempre')
  })
})

/* ========================================================================== */
/* 8. Supervisor do subprocesso                                               */
/* ========================================================================== */

describe('supervisor do worker de long-polling', () => {
  it('faz spawn pela costura ctx.subprocess com detached, signal, stdio e cwd', () => {
    const ctx = new FakeContext()
    const config = makeConfig()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), config, deps)
    supervisor.start()

    const call = ctx.subprocess.calls[0]
    assert.notEqual(call, undefined)
    assert.equal(call?.command, 'python3')
    assert.deepEqual(call?.args, ['bot_long_polling.py'])
    assert.equal(call?.options?.cwd, WORKER_CWD)
    assert.deepEqual(call?.options?.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(call?.options?.detached, true, 'sem detached o tree-kill por -pid falha com ESRCH')
    assert.equal(call?.options?.signal instanceof AbortSignal, true)
    assert.equal(call?.options?.env?.['TELEGRAM_BOT_TOKEN'], 'token-de-teste')

    supervisor.dispose()
  })

  it('encaminha stdout/stderr do worker para o logger', () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const child = ctx.subprocess.lastChild()
    child.stdout?.emit('data', Buffer.from('a sondar updates\n'))
    child.stderr?.emit('data', Buffer.from('timeout na rede\n'))

    assert.equal(ctx.logger.has('debug', 'a sondar updates'), true)
    assert.equal(ctx.logger.has('warn', 'timeout na rede'), true)

    supervisor.dispose()
  })

  it('reinicia com a progressao 500 -> 10000 e satura no teto', () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    for (let i = 0; i < 7; i += 1) {
      ctx.subprocess.lastChild().emit('exit', 1, null)
      scheduler.runLast()
    }

    assert.deepEqual(scheduler.delays(), [500, 1000, 2000, 4000, 8000, 10000, 10000])
    assert.equal(ctx.subprocess.calls.length, 8, '1 arranque + 7 reinicios')

    supervisor.dispose()
  })

  it('nao reinicia quando a saida e intencional (signal.aborted)', () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const child = ctx.subprocess.lastChild()
    supervisor.dispose()
    child.emit('exit', null, 'SIGKILL')

    assert.deepEqual(scheduler.scheduled, [], 'desligamento intencional nao agenda reinicio')
    assert.equal(ctx.subprocess.calls.length, 1)
  })

  it('cessa a recuperacao quando o orcamento maxAttempts se esgota', () => {
    const ctx = new FakeContext()
    const config = makeConfig()
    config.worker.backoff.maxAttempts = 3

    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), config, deps)
    supervisor.start()

    for (let i = 0; i < 3; i += 1) {
      ctx.subprocess.lastChild().emit('exit', 1, null)
      scheduler.runLast()
    }

    // A 4a falha ultrapassa o orcamento: nada mais e agendado.
    ctx.subprocess.lastChild().emit('exit', 1, null)

    assert.equal(scheduler.scheduled.length, 3)
    assert.equal(supervisor.attempts, 4)
    assert.equal(ctx.logger.has('error', 'Orcamento de reinicios esgotado'), true)

    supervisor.dispose()
  })

  it('uptime saudavel (resetAfterMs) devolve o atraso ao valor inicial', () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps, clock } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    ctx.subprocess.lastChild().emit('exit', 1, null)
    scheduler.runLast()
    ctx.subprocess.lastChild().emit('exit', 1, null)
    scheduler.runLast()
    assert.deepEqual(scheduler.delays(), [500, 1000])

    // O worker seguinte vive mais do que resetAfterMs antes de cair.
    clock.value += 60000
    ctx.subprocess.lastChild().emit('exit', 1, null)

    assert.deepEqual(scheduler.delays(), [500, 1000, 500])

    supervisor.dispose()
  })

  it('o disposer e SINCRONO, cancela o temporizador e faz tree-kill do grupo', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 4242

    const scheduler = new FakeScheduler()
    const { deps, kills } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    ctx.subprocess.lastChild().emit('exit', 1, null)
    assert.equal(scheduler.pending.length, 1, 'ha um reinicio agendado por cancelar')

    const result: unknown = supervisor.dispose()

    // SINCRONO: devolve `undefined`, jamais um thenable. Se devolvesse uma
    // Promise, a Fiber do Cordis perderia a garantia LIFO.
    assert.equal(result, undefined)
    assert.equal(typeof (result as { then?: unknown } | undefined)?.then, 'undefined')

    // clearTimeout aconteceu: nao fica temporizador pendurado a ressuscitar o
    // worker depois da Fiber ja estar DISPOSED.
    assert.deepEqual(scheduler.clearedIds, [1])
    assert.equal(scheduler.pending.length, 0)

    // Tree-kill: sinal negativo (grupo de processos inteiro) + SIGKILL.
    assert.deepEqual(kills, [[-4242, 'SIGKILL']])
  })

  it('nao invoca process.kill(-pid) no Windows', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 999

    const scheduler = new FakeScheduler()
    const { deps, kills } = makeSupervisorDeps(scheduler, { platform: 'win32' })

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const options = ctx.subprocess.calls[0]?.options
    supervisor.dispose()

    assert.deepEqual(kills, [], 'em Windows o tree-kill e taskkill /T /F dentro do ctx.subprocess')
    assert.equal(options?.signal?.aborted, true, 'o AbortController tem de ter disparado')
  })

  it('engole ESRCH quando o grupo ja nao existe', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 1234

    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler, {
      kill: (): void => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      },
    })

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    assert.doesNotThrow(() => supervisor.dispose())
  })

  it('e reentrante: dispose() repetido nao volta a matar', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 77

    const scheduler = new FakeScheduler()
    const { deps, kills } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()
    supervisor.dispose()
    supervisor.dispose()

    assert.deepEqual(kills, [[-77, 'SIGKILL']])
  })
})

/* ========================================================================== */
/* 9. Ciclo de vida do plugin (ctx.effect)                                    */
/* ========================================================================== */

describe('ciclo de vida sob ctx.effect', () => {
  it('regista tres efeitos e todos devolvem disposers SINCRONOS', () => {
    const { ctx } = install()

    assert.equal(ctx.effects.length, 3, 'veto de permissao + auth-check + worker')

    for (const disposer of ctx.effects) {
      assert.equal(typeof disposer, 'function')
      const result: unknown = disposer()
      assert.equal(result, undefined, 'disposer nao pode devolver Promise (garantia LIFO)')
    }
  })

  it('arranca o worker imediatamente no apply', () => {
    const { ctx } = install()

    assert.equal(ctx.subprocess.calls.length, 1)
    assert.equal(ctx.subprocess.calls[0]?.command, 'python3')
  })

  it('nao deixa temporizadores reais pendurados apos o dispose do efeito', () => {
    const { ctx } = install()

    // O worker cai; como este teste usa o agendador REAL do Node, o unico
    // temporizador possivel e o do reinicio. O disposer tem de o limpar.
    ctx.subprocess.lastChild().emit('exit', 1, null)
    const beforeDispose = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

    ctx.effects[2]?.()

    const afterDispose = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    assert.equal(afterDispose < beforeDispose, true, 'clearTimeout tem de correr no disposer')
  })
})

/* ========================================================================== */
/* 10. Validacao ruidosa no arranque                                          */
/* ========================================================================== */

describe('fail loud at load', () => {
  it('recusa binds em todas as interfaces', () => {
    assert.throws(() => assertSecureBind('0.0.0.0', ['127.0.0.1']), /Bind inseguro/u)
    assert.throws(() => assertSecureBind('::', ['127.0.0.1']), /Bind inseguro/u)
    assert.throws(() => assertSecureBind('[::]', ['127.0.0.1']), /Bind inseguro/u)
  })

  it('recusa um host fora de allowedHosts', () => {
    assert.throws(() => assertSecureBind('192.168.1.10', ['127.0.0.1']), /Bind nao autorizado/u)
  })

  it('aceita o loopback declarado na allowlist', () => {
    assert.doesNotThrow(() => assertSecureBind('127.0.0.1', ['127.0.0.1', '::1']))
    assert.doesNotThrow(() => assertSecureBind('::1', ['127.0.0.1', '::1']))
  })

  it('apply() rebenta quando o servidor esta ligado a 0.0.0.0', () => {
    const ctx = new FakeContext()
    ctx.webServer.host = '0.0.0.0'

    assert.throws(() => apply(ctx.asContext(), makeConfig()), /Bind inseguro/u)
    assert.equal(ctx.subprocess.calls.length, 0, 'nada e alocado se o arranque falha')
  })

  it('recusa configuracao incompleta em vez de preencher por omissao', () => {
    assert.throws(() => assertValidConfig(makeConfig({ encodedAuthString: '' })), /encodedAuthString/u)
    assert.throws(() => assertValidConfig(makeConfig({ allowedHosts: [] })), /allowedHosts/u)
    assert.throws(
      () => assertValidConfig(makeConfig({ realm: 'realm "injetado"' })),
      /realm/u,
    )

    const semComando = makeConfig()
    semComando.worker.command = ''
    assert.throws(() => assertValidConfig(semComando), /worker.command/u)

    const backoffInvalido = makeConfig()
    backoffInvalido.worker.backoff.maxDelayMs = 100
    assert.throws(() => assertValidConfig(backoffInvalido), /maxDelayMs/u)
  })

  it('aceita trustedRemotes vazio (fail-closed e configuracao valida)', () => {
    assert.doesNotThrow(() => assertValidConfig(makeConfig({ trustedRemotes: [] })))
  })
})

/* ========================================================================== */
/* 11. A-CRITICAL / A-HIGH: o tree-kill NAO pode ser codigo morto             */
/* ========================================================================== */

describe('tree-kill do grupo de processos (achado A-CRITICAL)', () => {
  it('o duble replica o Node: abortar chama kill() e poe killed = true', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 4242

    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const child = ctx.subprocess.lastChild()
    assert.equal(child.killed, false, 'antes do abort o filho nao esta morto')

    supervisor.dispose()

    // ESTE e o estado real de producao que o duble anterior escondia: quando o
    // disposer chega a linha do tree-kill, `killed` JA e `true`, porque o Node
    // chama `child.kill()` sincronamente ao processar o abort.
    assert.equal(child.killed, true)
    assert.deepEqual(child.killCalls.length, 1, 'o abort entregou exatamente um kill ao filho')
  })

  it('faz tree-kill do GRUPO mesmo com child.killed ja a true', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 4242

    const scheduler = new FakeScheduler()
    const { deps, kills } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()
    supervisor.dispose()

    // ANTI-REGRESSAO DIRETA. Se alguem reintroduzir a guarda
    // `if (current === undefined || current.killed) return` do exemplo canonico
    // da documentacao, este assert falha: `killed` e `true` neste ponto e o
    // `process.kill(-pid, 'SIGKILL')` nunca corre -- que e exatamente como os
    // netos do worker sobreviviam reparentados ao init.
    assert.deepEqual(kills, [[-4242, 'SIGKILL']], 'o kill do GRUPO (-pid) tem de acontecer')
  })

  it('o disposer continua idempotente: 3 chamadas, 1 kill', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 909

    const scheduler = new FakeScheduler()
    const { deps, kills } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    assert.doesNotThrow(() => {
      supervisor.dispose()
      supervisor.dispose()
      supervisor.dispose()
    })

    assert.deepEqual(kills, [[-909, 'SIGKILL']])
  })
})

/* ========================================================================== */
/* 12. A-HIGH: falha de spawn tem de reiniciar (nao emite 'exit')             */
/* ========================================================================== */

describe('falha de spawn (achado A-HIGH)', () => {
  it("reinicia perante 'error' (ENOENT), evento que NAO vem acompanhado de 'exit'", () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    // Falha de spawn real do Node: error(ENOENT) -> close(code=-2). Nunca 'exit'.
    ctx.subprocess
      .lastChild()
      .emit('error', Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }))

    assert.equal(scheduler.pending.length, 1, 'a falha de spawn TEM de agendar reinicio')
    assert.deepEqual(scheduler.delays(), [500])
    assert.equal(supervisor.attempts, 1, 'e TEM de consumir orcamento')
    assert.equal(ctx.logger.has('error', 'ENOENT'), true)

    scheduler.runLast()
    assert.equal(ctx.subprocess.calls.length, 2, 'o worker volta a ser instanciado')

    supervisor.dispose()
  })

  it("nao reinicia duas vezes quando 'error' e 'exit' disparam na mesma instancia", () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const child = ctx.subprocess.lastChild()
    child.emit('error', new Error('falhou'))
    child.emit('exit', 1, null)

    // Desarme por instancia: um filho consome o orcamento UMA vez.
    assert.equal(scheduler.scheduled.length, 1)
    assert.equal(supervisor.attempts, 1)

    supervisor.dispose()
  })

  it('recusa no arranque um worker.cwd que nao existe', () => {
    const semCwd = makeConfig()
    semCwd.worker.cwd = '/caminho/que/nao/existe/dsh-worker'

    assert.throws(() => assertValidConfig(semCwd), /worker\.cwd/u)
  })

  it('recusa no arranque um worker.cwd que existe mas nao e diretorio', () => {
    const ficheiro = makeConfig()
    // O proprio ficheiro de testes existe e NAO e um diretorio.
    ficheiro.worker.cwd = fileURLToPath(import.meta.url)

    assert.throws(() => assertValidConfig(ficheiro), /nao e um diretorio/u)
  })
})

/* ========================================================================== */
/* 13. A-MEDIUM: substituicao de filho/temporizador e start() idempotente     */
/* ========================================================================== */

describe('substituicao de recursos (achado A-MEDIUM)', () => {
  it('o filho anterior e morto quando um novo o substitui', () => {
    const ctx = new FakeContext()
    ctx.subprocess.pid = 222

    const scheduler = new FakeScheduler()
    const { deps, kills } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    ctx.subprocess.lastChild().emit('exit', 1, null)
    scheduler.runLast() // spawnOnce() -> substitui o filho

    assert.equal(ctx.subprocess.children.length, 2)
    assert.deepEqual(kills, [[-222, 'SIGKILL']], 'o 1o filho nao pode ficar sem kill')

    supervisor.dispose()
    assert.deepEqual(
      kills,
      [
        [-222, 'SIGKILL'],
        [-222, 'SIGKILL'],
      ],
      'o 2o filho e morto pelo disposer',
    )
  })

  it('start() repetido nao instancia um segundo worker', () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()
    supervisor.start()
    supervisor.start()

    assert.equal(ctx.subprocess.calls.length, 1)
    assert.equal(ctx.logger.has('warn', 'start() repetido ignorado'), true)

    supervisor.dispose()
  })

  it('nao deixa dois temporizadores vivos e o disposer nao deixa nenhum', () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    ctx.subprocess.lastChild().emit('exit', 1, null)
    scheduler.runLast()
    ctx.subprocess.lastChild().emit('exit', 1, null)

    assert.equal(scheduler.pending.length, 1, 'so um reinicio pendente de cada vez')

    supervisor.dispose()
    assert.equal(scheduler.pending.length, 0, 'o disposer nao deixa temporizadores vivos')
  })

  it('remove os ouvintes do filho quando ele termina', () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    supervisor.start()

    const child = ctx.subprocess.lastChild()
    assert.equal(child.listenerCount('exit'), 1)
    assert.equal(child.stdout?.listenerCount('data'), 1)

    child.emit('exit', 1, null)

    assert.equal(child.listenerCount('exit'), 0, 'ouvinte de exit tem de ser removido')
    assert.equal(child.stdout?.listenerCount('data'), 0, 'ouvinte de stdout idem')
    assert.equal(
      child.listenerCount('error'),
      1,
      "tem de sobrar o absorvedor de 'error' (um EventEmitter sem ele LANCA)",
    )

    supervisor.dispose()
  })
})

/* ========================================================================== */
/* 14. A-MEDIUM: orcamento esgotado = estado terminal explicito               */
/* ========================================================================== */

describe('estado terminal do orcamento (achado A-MEDIUM)', () => {
  it('expoe `exhausted` e recusa qualquer novo arranque', () => {
    const ctx = new FakeContext()
    const config = makeConfig()
    config.worker.backoff.maxAttempts = 2

    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const supervisor = createWorkerSupervisor(ctx.asContext(), config, deps)
    supervisor.start()

    assert.equal(supervisor.exhausted, false)

    for (let i = 0; i < 2; i += 1) {
      ctx.subprocess.lastChild().emit('exit', 1, null)
      scheduler.runLast()
    }
    ctx.subprocess.lastChild().emit('exit', 1, null) // 3a falha: ultrapassa o orcamento

    assert.equal(supervisor.exhausted, true, 'estado terminal tem de ser observavel')
    assert.equal(ctx.logger.has('error', 'estado terminal'), true)
    assert.equal(ctx.logger.has('error', 'nao expoe auto-desregisto'), true)
    assert.equal(scheduler.pending.length, 0, 'nada mais e agendado')

    supervisor.dispose()
  })
})

/* ========================================================================== */
/* 15. A-LOW: dispose reentrante durante o tratamento da saida                */
/* ========================================================================== */

describe('disposer reentrante (achado A-LOW)', () => {
  it('nao agenda reinicio quando o dispose() acontece DURANTE o tratador de saida', () => {
    const ctx = new FakeContext()
    const scheduler = new FakeScheduler()
    const { deps } = makeSupervisorDeps(scheduler)

    const holder: { supervisor: WorkerSupervisor | undefined } = { supervisor: undefined }

    // O `warn` imediatamente anterior ao agendamento e o ponto de reentrancia:
    // simula um ouvinte de log (ou outra Fiber) que descarta o plugin nesse
    // instante. Sem a re-verificacao de `disposed` antes do setTimeout, o
    // temporizador nascia DEPOIS do clearTimeout do disposer.
    ctx.logger.warn = (_scope: string, message: string): void => {
      if (message.includes('Reinicio')) holder.supervisor?.dispose()
    }

    const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
    holder.supervisor = supervisor
    supervisor.start()

    ctx.subprocess.lastChild().emit('exit', 1, null)

    assert.deepEqual(scheduler.scheduled, [], 'nenhum temporizador pode sobreviver ao disposer')
  })
})

/* ========================================================================== */
/* 16. B-CRITICAL: a credencial universal `undefined:undefined`               */
/* ========================================================================== */

describe('validacao do par descodificado de encodedAuthString (achado B-CRITICAL)', () => {
  it('recusa dW5kZWZpbmVkOnVuZGVmaW5lZA== (= undefined:undefined)', () => {
    const universal = Buffer.from('undefined:undefined').toString('base64')
    assert.equal(universal, 'dW5kZWZpbmVkOnVuZGVmaW5lZA==')

    assert.throws(
      () => assertValidConfig(makeConfig({ encodedAuthString: universal })),
      /literal 'undefined'/u,
    )
  })

  it('recusa o literal undefined/null de qualquer um dos lados', () => {
    for (const par of ['undefined:senha', 'admin:undefined', 'null:senha', 'admin:null']) {
      assert.throws(
        () => assertValidConfig(makeConfig({ encodedAuthString: Buffer.from(par).toString('base64') })),
        /literal/u,
        `'${par}' tinha de ser recusado`,
      )
    }
  })

  it('recusa um par sem ":" ou com um dos lados vazio', () => {
    assert.throws(
      () => assertValidConfig(makeConfig({ encodedAuthString: Buffer.from('semdoispontos').toString('base64') })),
      /separado por ":"/u,
    )
    assert.throws(
      () => assertValidConfig(makeConfig({ encodedAuthString: Buffer.from('admin:').toString('base64') })),
      /vazios/u,
    )
    assert.throws(
      () => assertValidConfig(makeConfig({ encodedAuthString: Buffer.from(':senha').toString('base64') })),
      /vazios/u,
    )
  })

  it('aceita uma credencial legitima', () => {
    assert.doesNotThrow(() => assertValidConfig(makeConfig()))
  })
})

/* ========================================================================== */
/* 17. B-HIGH: ambiente minimo do worker (ADMIN_PASS nao viaja)               */
/* ========================================================================== */

describe('ambiente do worker por allowlist (achado B-HIGH)', () => {
  it('nao propaga ADMIN_USER/ADMIN_PASS nem qualquer outro segredo do plano de controlo', () => {
    const env = buildWorkerEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/dsh',
        LANG: 'pt_PT.UTF-8',
        LC_ALL: 'pt_PT.UTF-8',
        TZ: 'Europe/Lisbon',
        PYTHONUNBUFFERED: '1',
        ADMIN_USER: 'admin',
        ADMIN_PASS: 's3cr3t-do-plano-de-controlo',
        AWS_SECRET_ACCESS_KEY: 'nao-devia-estar-aqui',
        SSH_AUTH_SOCK: '/tmp/agent',
      },
      'token-do-bot',
    )

    assert.equal(env['ADMIN_PASS'], undefined, 'ADMIN_PASS NAO pode chegar ao worker')
    assert.equal(env['ADMIN_USER'], undefined, 'ADMIN_USER NAO pode chegar ao worker')
    assert.equal(env['AWS_SECRET_ACCESS_KEY'], undefined)
    assert.equal(env['SSH_AUTH_SOCK'], undefined)

    assert.equal(env['TELEGRAM_BOT_TOKEN'], 'token-do-bot')
    assert.equal(env['PATH'], '/usr/bin')
    assert.equal(env['HOME'], '/home/dsh')
    assert.equal(env['LANG'], 'pt_PT.UTF-8')
    assert.equal(env['LC_ALL'], 'pt_PT.UTF-8')
    assert.equal(env['TZ'], 'Europe/Lisbon')
    assert.equal(env['PYTHONUNBUFFERED'], '1')
  })

  it('o spawn real do supervisor tambem nao leva ADMIN_PASS', () => {
    const anterior = process.env['ADMIN_PASS']
    process.env['ADMIN_PASS'] = 's3cr3t-do-plano-de-controlo'

    try {
      const ctx = new FakeContext()
      const scheduler = new FakeScheduler()
      const { deps } = makeSupervisorDeps(scheduler)

      const supervisor = createWorkerSupervisor(ctx.asContext(), makeConfig(), deps)
      supervisor.start()

      const env = ctx.subprocess.calls[0]?.options?.env
      assert.notEqual(env, undefined)
      assert.equal(env?.['ADMIN_PASS'], undefined)
      assert.equal(env?.['TELEGRAM_BOT_TOKEN'], 'token-de-teste')

      supervisor.dispose()
    } finally {
      if (anterior === undefined) delete process.env['ADMIN_PASS']
      else process.env['ADMIN_PASS'] = anterior
    }
  })
})

/* ========================================================================== */
/* 18. B-HIGH / B-MEDIUM: avisos ruidosos e validacao de guardedPrefixes      */
/* ========================================================================== */

describe('avisos de arranque e validacao de prefixos', () => {
  it('avisa em voz alta sobre o REQUISITO DE ORDEM DE CARREGAMENTO', () => {
    const { ctx } = install()
    assert.equal(ctx.logger.has('warn', 'REQUISITO DE ORDEM DE CARREGAMENTO'), true)
  })

  it('avisa quando guardedPrefixes esta vazio (parece seguro e nao esta)', () => {
    const { ctx } = install({ guardedPrefixes: [] })
    assert.equal(ctx.logger.has('warn', 'guardedPrefixes esta VAZIO'), true)
  })

  it('avisa quando deniedPermissions esta vazio', () => {
    const { ctx } = install({ deniedPermissions: [] })
    assert.equal(ctx.logger.has('warn', 'deniedPermissions esta VAZIO'), true)
  })

  it("recusa no arranque um prefixo sem '/' inicial", () => {
    assert.throws(() => assertValidConfig(makeConfig({ guardedPrefixes: ['api'] })), /comecar por/u)
    assert.throws(
      () => assertValidConfig(makeConfig({ guardedPrefixes: ['/api', 'admin'] })),
      /guardedPrefixes\[1\]/u,
    )
  })
})

/* ========================================================================== */
/* 19. B-MEDIUM: rota ancestral (`prefix` em `/`) e normalizacao de caminho   */
/* ========================================================================== */

describe('rotas que PODEM servir um prefixo guardado (achado B-MEDIUM)', () => {
  it('canonicaliza //api, /API, percent-encoding e segmentos ..', () => {
    assert.equal(canonicalRequestPath('//api/commands/execute'), '/api/commands/execute')
    assert.equal(canonicalRequestPath('/API'), '/api')
    assert.equal(canonicalRequestPath('/%61pi'), '/api')
    assert.equal(canonicalRequestPath('/%2561pi'), '/api')
    assert.equal(canonicalRequestPath('/x/../api'), '/api')
    assert.equal(canonicalRequestPath('\\api'), '/api')
    assert.equal(canonicalRequestPath('/api/'), '/api')
    assert.equal(canonicalRequestPath(undefined), '/')
  })

  it('isGuardedPath apanha as mesmas grafias sem apanhar /apinfo', () => {
    assert.equal(isGuardedPath('//api/commands/execute', ['/api']), true)
    assert.equal(isGuardedPath('/API/commands/execute', ['/api']), true)
    assert.equal(isGuardedPath('/%61pi', ['/api']), true)
    assert.equal(isGuardedPath('/apinfo', ['/api']), false)
  })

  it('routeMayServeGuardedPath cobre descendentes E ancestrais por prefixo', () => {
    const prefixes = ['/api']

    assert.equal(routeMayServeGuardedPath({ kind: 'exact', path: '/api/x' }, prefixes), true)
    assert.equal(routeMayServeGuardedPath({ kind: 'prefix', path: '//api' }, prefixes), true)
    assert.equal(routeMayServeGuardedPath({ kind: 'prefix', path: '/' }, prefixes), true)
    assert.equal(routeMayServeGuardedPath({ kind: 'exact', path: '/' }, prefixes), false)
    assert.equal(routeMayServeGuardedPath({ kind: 'prefix', path: '/outra' }, prefixes), false)
    assert.equal(routeMayServeGuardedPath({ kind: 'prefix', path: '/api' }, []), false)
  })

  it('uma rota `prefix` em / NAO serve /api/commands/execute sem credencial', async () => {
    const { ctx } = install()
    let rpcExecuted = false

    const original: WebHandler = (_req, res): void => {
      rpcExecuted = true
      res.writeHead(200)
      res.end('{"ok":true}')
    }

    const { record } = mountRoute(ctx, { kind: 'prefix', path: '/', handler: original })
    assert.notEqual(record.handler, original, 'a rota-raiz TEM de ser embrulhada')

    const res = new FakeResponse()
    await record.handler(
      makeRequest({ method: 'POST', url: '/api/commands/execute', remoteAddress: '127.0.0.1' }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
    assert.equal(rpcExecuted, false)
  })

  it('a mesma rota-raiz continua a servir os caminhos NAO guardados', async () => {
    const { ctx } = install()
    let served = false

    const { record } = mountRoute(ctx, {
      kind: 'prefix',
      path: '/',
      handler: (_req, res): void => {
        served = true
        res.writeHead(200)
        res.end('spa')
      },
    })

    const res = new FakeResponse()
    await record.handler(makeRequest({ url: '/index.html' }), res.asServerResponse())

    assert.equal(served, true, 'a rota-raiz nao guardada nao pode passar a exigir senha')
    assert.equal(res.statusCode, 200)
  })

  it('uma rota registada em //api tambem e guardada', async () => {
    const { ctx } = install()
    let rpcExecuted = false

    const { record } = mountRoute(ctx, {
      kind: 'prefix',
      path: '//api/commands',
      handler: (): void => {
        rpcExecuted = true
      },
    })

    const res = new FakeResponse()
    await record.handler(
      makeRequest({ url: '//api/commands/execute', remoteAddress: '127.0.0.1' }),
      res.asServerResponse(),
    )

    assert.equal(res.statusCode, 401)
    assert.equal(rpcExecuted, false)
  })
})

/* ========================================================================== */
/* 20. B-MEDIUM: handshake de WebSocket sob o portao                          */
/* ========================================================================== */

describe('registerUpgrade guardado (achado B-MEDIUM)', () => {
  it('recusa o handshake sem credencial com 401 escrito no socket cru', async () => {
    const { ctx, config } = install()
    let handshakeFeito = false

    const { record } = mountUpgrade(ctx, {
      path: '/ws',
      handler: (): void => {
        handshakeFeito = true
      },
    })

    const socket = await runUpgrade(record.handler, makeRequest({ url: '/ws', remoteAddress: '127.0.0.1' }))

    assert.equal(handshakeFeito, false, 'o WebSocket NAO pode ser estabelecido sem credencial')
    assert.equal(socket.written.startsWith('HTTP/1.1 401 Unauthorized\r\n'), true, socket.written)
    assert.equal(socket.written.includes(`WWW-Authenticate: Basic realm="${config.realm}"`), true)
    assert.equal(socket.written.endsWith('\r\n\r\n'), true, 'a resposta crua precisa da linha em branco')
    assert.equal(socket.destroyed, true)
  })

  it('recusa com 403 (sem desafio) uma origem fora de trustedRemotes', async () => {
    const { ctx } = install()

    const { record } = mountUpgrade(ctx, {
      path: '/ws',
      handler: (): void => {
        throw new Error('nao devia ser alcancado')
      },
    })

    const socket = await runUpgrade(
      record.handler,
      makeRequest({ url: '/ws', remoteAddress: '10.0.0.7', authorization: `Basic ${VALID_CREDENTIAL}` }),
    )

    assert.equal(socket.written.startsWith('HTTP/1.1 403 Forbidden\r\n'), true, socket.written)
    assert.equal(socket.written.includes('WWW-Authenticate'), false, '403 nao desafia credencial')
    assert.equal(socket.destroyed, true)
  })

  it('deixa passar o handshake com credencial valida, com head e socket intactos', async () => {
    const { ctx } = install()
    const recebido: { url: string | undefined; head: number | undefined } = {
      url: undefined,
      head: undefined,
    }

    const { record } = mountUpgrade(ctx, {
      path: '/ws',
      handler: (req, _socket, head): void => {
        recebido.url = req.url
        recebido.head = head.byteLength
      },
    })

    const socket = await runUpgrade(
      record.handler,
      makeRequest({ url: '/ws', remoteAddress: '127.0.0.1', authorization: `Basic ${VALID_CREDENTIAL}` }),
    )

    assert.equal(recebido.url, '/ws')
    assert.equal(recebido.head, 0)
    assert.equal(socket.destroyed, false, 'o handshake aprovado nao pode destruir o socket')
    assert.equal(socket.written, '')
  })

  it('propaga o disposer nativo de registerUpgrade', () => {
    const { ctx } = install()
    const { disposer } = mountUpgrade(ctx, { path: '/ws', handler: (): void => {} })

    assert.equal(typeof disposer, 'function')
    disposer()
    assert.deepEqual(ctx.webServer.disposed, ['upgrade:/ws'])
  })
})

/* ========================================================================== */
/* 21. B-HIGH: tokenizador de permissoes endurecido                           */
/* ========================================================================== */

describe('tokenizador de deniedPermissions endurecido (achado B-HIGH)', () => {
  it('apanha as evasoes que escapavam: _, percent-encoding e pontuacao nas bordas', () => {
    const denied = ['danger-full-access']

    for (const comando of [
      '/permission danger_full_access',
      '/permission danger%2Dfull%2Daccess',
      '/permission danger%252Dfull%252Daccess',
      '/permission .danger-full-access',
      '/permission danger-full-access.',
      '/permission "danger-full-access"',
      '/permission DANGER_FULL_ACCESS',
      '/permission danger.full.access',
      '/permission danger+full+access',
    ]) {
      assert.equal(
        requestsDeniedPermission(comando, denied),
        'danger-full-access',
        `'${comando}' tinha de ser vetado`,
      )
    }
  })

  it('continua a NAO apanhar permissoes distintas (sem falsos positivos)', () => {
    const denied = ['danger-full-access']

    assert.equal(requestsDeniedPermission('/permission danger-full-access-audit', denied), undefined)
    assert.equal(requestsDeniedPermission('/permission workspace-write', denied), undefined)
    assert.equal(requestsDeniedPermission('/permission read-only', denied), undefined)
  })

  it('canonicaliza tambem a agulha vinda da configuracao', () => {
    assert.equal(
      requestsDeniedPermission('/permission danger-full-access', ['DANGER_FULL_ACCESS']),
      'DANGER_FULL_ACCESS',
    )
  })

  it('o veto continua a curto-circuitar a cascata para as grafias evasivas', async () => {
    const { ctx } = install()
    let nextCalled = false

    const result = await ctx
      .asContext()
      .waterfall('security/permission-elevate', '/permission danger%2Dfull%2Daccess', async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, false)
    assert.equal(nextCalled, false)
  })
})

/* ========================================================================== */
/* 22. B-LOW: bind curinga, realm Latin-1 e esquema Basic case-insensitive    */
/* ========================================================================== */

describe('achados B-LOW', () => {
  it('L1: reconhece todas as grafias do bind curinga', () => {
    for (const host of [
      '0',
      '0.0',
      '0.0.0.0',
      '0.0.0.0.',
      '::',
      '::0',
      '[::]',
      '0:0:0:0:0:0:0:0',
      '0000:0000:0000:0000:0000:0000:0000:0000',
      '::ffff:0.0.0.0',
      '  0.0.0.0  ',
    ]) {
      assert.throws(
        () => assertSecureBind(host, ['127.0.0.1', host]),
        /Bind inseguro/u,
        `'${host}' e o curinga e tinha de ser recusado`,
      )
    }
  })

  it('L1: nao confunde enderecos legitimos com o curinga', () => {
    assert.doesNotThrow(() => assertSecureBind('127.0.0.1', ['127.0.0.1']))
    assert.doesNotThrow(() => assertSecureBind('::1', ['::1']))
    assert.doesNotThrow(() => assertSecureBind('10.0.0.7', ['10.0.0.7']))
  })

  it('L2: recusa no arranque um realm nao representavel em Latin-1', () => {
    // Um cabecalho HTTP/1.1 viaja em Latin-1: isto rebentaria dentro do
    // writeHead com ERR_INVALID_CHAR e devolveria resposta vazia em vez de 401.
    assert.throws(() => assertValidConfig(makeConfig({ realm: 'DSH \u{1F512}' })), /realm/u)
    assert.throws(() => assertValidConfig(makeConfig({ realm: 'DSH 你好' })), /realm/u)

    // Latin-1 legitimo continua a passar (acentos do portugues estao abaixo de U+00FF).
    assert.doesNotThrow(() => assertValidConfig(makeConfig({ realm: 'Interface Segura ção' })))
  })

  it('L3: o esquema Basic e comparado sem diferenciar maiusculas (RFC 7235)', () => {
    assert.equal(verifyBasicAuth(`basic ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), true)
    assert.equal(verifyBasicAuth(`BASIC ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), true)
    assert.equal(verifyBasicAuth(`BaSiC ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), true)

    // O payload base64 continua sensivel a maiusculas.
    assert.equal(verifyBasicAuth(`Basic ${VALID_CREDENTIAL.toLowerCase()}`, VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth(`Bearer ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), false)
  })

  it('L3: uma rota /api aceita a credencial com o esquema em minusculas', async () => {
    const { ctx } = install()
    let rpcExecuted = false

    const { record } = mountRoute(ctx, {
      kind: 'exact',
      path: '/api/health',
      handler: (_req, res): void => {
        rpcExecuted = true
        res.writeHead(200)
        res.end('ok')
      },
    })

    const res = new FakeResponse()
    await record.handler(
      makeRequest({
        url: '/api/health',
        remoteAddress: '127.0.0.1',
        authorization: `basic ${VALID_CREDENTIAL}`,
      }),
      res.asServerResponse(),
    )

    assert.equal(rpcExecuted, true)
    assert.equal(res.statusCode, 200)
  })
})
