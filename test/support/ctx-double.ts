/**
 * DUBLES DA COSTURA CORDIS: `ctx.logger`, `ctx.webServer`, o proprio `Context`,
 * e os objetos HTTP (`ServerResponse`, socket de upgrade, `IncomingMessage`).
 *
 * CASA TEMPORARIA -- o layout canonico poe isto em `test/support/**`, que e
 * PREP-OWNED e so existe a partir do COMMIT PREP 2. Ficheiro sem sufixo
 * `.test.ts`: nao e executado como suite.
 *
 * PRINCIPIO: nao se sobe servidor a escutar nem se lanca Python real. O
 * `node:http.Server` E real, porque e exatamente o objeto cujo despacho a
 * barreira troca -- dublar o `EventEmitter` seria dublar o que esta sob teste.
 *
 * Os dubles sao objetos simples convertidos com `as unknown as <Interface>`. A
 * conversao e deliberada: implementar as assinaturas genericas de `Context` por
 * inteiro nao acrescentaria cobertura nenhuma e so tornaria os testes ilegiveis.
 */

import { Server } from 'node:http'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import type { Context, Disposable } from '../../src/dsh/adapter.ts'
import { FakeSubprocessService } from './child-double.ts'

/* ========================================================================== */
/* Logger                                                                     */
/* ========================================================================== */

export interface LogEntry {
  level: string
  scope: string
  message: string
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

type LoggerMethods = Record<LogLevel, (format: unknown, ...param: unknown[]) => void>

/**
 * Duble de `LoggerService`, FIEL a superficie real: e CHAMAVEL
 * (`ctx.logger(name) -> Logger`) e os seus metodos sao PRINTF
 * (`info(format, ...param)`), nao `(scope, message)` como o codigo legado supunha.
 *
 * A reconstrucao de `'%s'` nao e comodidade: e o que PROVA que o wrapper de
 * `src/logging/logger.ts` passa a mensagem como ARGUMENTO em vez de a
 * interpolar. Se alguem voltar a escrever `logger.info(msg)` com um `%` no
 * texto, a reconstrucao deixa de bater.
 */
export interface FakeLoggerService {
  (name?: string): LoggerMethods
  readonly entries: LogEntry[]
  has(level: string, fragment: string): boolean
  /** Substitui um nivel em TODOS os loggers nomeados (ponto de reentrancia). */
  override(level: LogLevel, handler: (scope: string, message: string) => void): void
}

export function createFakeLogger(): FakeLoggerService {
  const entries: LogEntry[] = []
  const overrides = new Map<LogLevel, (scope: string, message: string) => void>()

  const render = (format: unknown, param: unknown[]): string => {
    if (format === '%s' && param.length === 1) return String(param[0])
    return [format, ...param].map((value) => String(value)).join(' ')
  }

  const service = ((name?: string): LoggerMethods => {
    const scope = name ?? 'root'
    const method =
      (level: LogLevel) =>
      (format: unknown, ...param: unknown[]): void => {
        const message = render(format, param)
        const handler = overrides.get(level)
        if (handler !== undefined) {
          handler(scope, message)
          return
        }
        entries.push({ level, scope, message })
      }

    return {
      info: method('info'),
      warn: method('warn'),
      error: method('error'),
      debug: method('debug'),
    }
  }) as FakeLoggerService

  Object.defineProperty(service, 'entries', { value: entries })
  Object.defineProperty(service, 'has', {
    value: (level: string, fragment: string): boolean =>
      entries.some((entry) => entry.level === level && entry.message.includes(fragment)),
  })
  Object.defineProperty(service, 'override', {
    value: (level: LogLevel, handler: (scope: string, message: string) => void): void => {
      overrides.set(level, handler)
    },
  })

  return service
}

/* ========================================================================== */
/* webServer                                                                  */
/* ========================================================================== */

/**
 * Duble do servico `webServer`.
 *
 * O que interessa e o campo `server`: um `node:http.Server` REAL (nunca posto a
 * escutar) com os listeners `request`/`upgrade` que representam "o resto do
 * DSH" -- as tabelas de rota do encaminhador e o assento de fallback vivem todos
 * por baixo deles. A barreira captura-os, substitui-os e, no disposer,
 * reinstala-os -- exatamente como faz contra o servidor verdadeiro.
 */
export class FakeWebServer {
  host = '127.0.0.1'
  port = 3080
  /** Despacho ORIGINAL de `request` (o "resto do DSH", por baixo da barreira). */
  onRequest: (req: IncomingMessage, res: ServerResponse) => void = () => {}
  /** Despacho ORIGINAL de `upgrade`. */
  onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void = () => {}
  readonly server = new Server()

  constructor(options: { withUpgrade?: boolean } = {}) {
    this.server.on('request', (req, res) => {
      this.onRequest(req, res)
    })
    // Um servidor com ZERO listeners de `upgrade` e um caso real (composicao sem
    // WebSocket) e a barreira trata-o de forma diferente -- por isso e opcional.
    if (options.withUpgrade !== false) {
      this.server.on('upgrade', (req, socket, head) => {
        this.onUpgrade(req, socket as Duplex, head)
      })
    }
  }

  /** Despacha um pedido pelo caminho real do `EventEmitter`. */
  emitRequest(req: IncomingMessage, res: ServerResponse): void {
    this.server.emit('request', req, res)
  }

  /** Despacha um handshake pelo caminho real do `EventEmitter`. */
  emitUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.emit('upgrade', req, socket, head)
  }
}

/* ========================================================================== */
/* Context                                                                    */
/* ========================================================================== */

type AnyListener = (...args: never[]) => Promise<unknown>

export class FakeContext {
  readonly logger = createFakeLogger()
  readonly webServer: FakeWebServer
  readonly subprocess = new FakeSubprocessService()
  readonly listeners = new Map<string, AnyListener[]>()
  readonly effects: Disposable[] = []
  readonly effectLabels: Array<string | undefined> = []

  constructor(options: { withUpgrade?: boolean } = {}) {
    this.webServer = new FakeWebServer(options)
  }

  /**
   * ANTI-REGRESSAO DIRETA. `ctx.intercept` e FUSAO DE CONFIGURACAO por servico,
   * nao um envelope de metodos -- e o `webServer` nem sequer resolve essa config
   * (`grep -c resolveConfig` no `lib/index.js` dele devolve 0). Qualquer chamada
   * aqui significa que a barreira voltou ao mecanismo que compila em silencio e
   * nao faz nada.
   */
  intercept(): never {
    throw new Error(
      'ctx.intercept NAO envolve metodos de servico: e fusao de configuracao (cordis ' +
        'context.ts:141-145) e o webServer nao a resolve. A barreira e dona do despacho.',
    )
  }

  on(event: string, listener: AnyListener): () => boolean {
    const bucket = this.listeners.get(event) ?? []
    bucket.push(listener)
    this.listeners.set(event, bucket)
    return (): boolean => {
      const current = this.listeners.get(event) ?? []
      const index = current.indexOf(listener)
      if (index !== -1) current.splice(index, 1)
      return index !== -1
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

  effect(factory: () => Disposable, label?: string): Disposable {
    const disposer = factory()
    this.effects.push(disposer)
    this.effectLabels.push(label)
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
}

/* ========================================================================== */
/* Resposta, socket e requisicao                                              */
/* ========================================================================== */

export class FakeResponse {
  statusCode: number | undefined = undefined
  readonly headers: Record<string, string> = {}
  body = ''
  ended = false
  headersSent = false

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status
    this.headersSent = true
    if (headers !== undefined) Object.assign(this.headers, headers)
    return this
  }

  end(chunk?: string): this {
    if (chunk !== undefined) this.body += chunk
    this.ended = true
    return this
  }

  destroy(): void {
    this.ended = true
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse
  }
}

/**
 * Duble do `Duplex` de um handshake de upgrade. Num tratador de `'upgrade'` nao
 * ha `ServerResponse`: quem recusa escreve a resposta HTTP CRUA no socket e
 * destroi-o. E isso que se observa aqui.
 */
export class FakeSocket {
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

export interface RequestOptions {
  remoteAddress?: string | undefined
  authorization?: string | undefined
  method?: string
  url?: string
}

export function makeRequest(options: RequestOptions = {}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (options.authorization !== undefined) headers['authorization'] = options.authorization

  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers,
    socket: { remoteAddress: options.remoteAddress },
  } as unknown as IncomingMessage
}
