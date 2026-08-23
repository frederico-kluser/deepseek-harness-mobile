/**
 * Bancada dos testes de `worker/providers/telegram/**`.
 *
 * As MESMAS regras de `test/unit/worker/lib/apoio.ts`:
 *  1. Nenhum teste fala com `api.telegram.org` — o duble congelado
 *     `test/support/telegram-server.mjs` escuta em porta efemera.
 *  2. O tempo e INJETADO (nenhum `setTimeout` real no produto).
 *  3. O log e CAPTURADO, para asserir que o token nao sai.
 *
 * O `import()` dinamico do duble e a mesma tecnica de `lib/apoio.ts`:
 * `telegram-server.mjs` e JS com JSDoc e o `tsconfig.json` deste repositorio
 * nao liga `allowJs`; o especificador calculado devolve `any` e a forma e
 * nomeada aqui uma vez.
 */

import { once } from 'node:events'
import { createServer } from 'node:http'

import type { AbortLike, TimeSource } from '../../../../../worker/providers/telegram/interno.ts'
import type { LogFields, WorkerLogger } from '../../../../../worker/providers/telegram/interno.ts'

/** Um token com a FORMA de um token real. Nao existe bot nenhum por tras. */
export const TOKEN_DE_TESTE = '123456789:AAHfalso-so-para-teste_0123456789abcd'

/** Relogio + espera falsos. A espera ANDA com o relogio. */
export class FakeTime implements TimeSource {
  private current: number
  readonly sleeps: number[] = []

  constructor(startAtMs = 0) {
    this.current = startAtMs
  }

  now(): number {
    return this.current
  }

  async sleep(ms: number, signal?: AbortLike): Promise<void> {
    this.sleeps.push(ms)
    if (signal?.aborted === true) return
    if (ms > 0) this.current += ms
    await Promise.resolve()
  }

  advance(ms: number): void {
    this.current += ms
  }
}

export interface LogCapturado {
  readonly logger: WorkerLogger
  readonly lines: string[]
  all(): string
}

/** Logger que junta a um array em vez de escrever. Nivel `debug`, apanha tudo. */
export function captureLog(secrets: readonly string[] = []): LogCapturado {
  const lines: string[] = []
  void secrets
  const record = (level: string) => (message: string, fields?: LogFields) => {
    const extra =
      fields === undefined
        ? ''
        : Object.entries(fields)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => ` ${key}=${String(value)}`)
            .join('')
    lines.push(`${level.toUpperCase()} ${message}${extra}`)
  }
  const logger: WorkerLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  }
  return { logger, lines, all: () => lines.join('\n') }
}

export interface ChamadaFalsa {
  readonly token: string
  readonly method: string
  readonly payload: Record<string, unknown>
}

/** A forma de `startFakeBotApi()` do duble congelado. */
export interface FakeBotApi {
  readonly apiRoot: string
  readonly calls: ChamadaFalsa[]
  readonly state: { pending: unknown[]; messageId: number }
  queueError(
    method: string,
    err: { error_code: number; description: string; parameters?: Record<string, unknown> },
  ): FakeBotApi
  close(): Promise<void>
}

interface ModuloDuble {
  startFakeBotApi(options?: { port?: number; pending?: unknown[] }): Promise<FakeBotApi>
  fakeMessageUpdate(options?: { updateId?: number; fromId?: number; chatId?: number; text?: string }): unknown
  CANONICAL_ERRORS: Record<
    string,
    { error_code: number; description: string; parameters?: Record<string, unknown> }
  >
}

async function carregarDuble(): Promise<ModuloDuble> {
  const href = new URL('../../../../support/telegram-server.mjs', import.meta.url).href
  return (await import(href)) as ModuloDuble
}

/** Arranca o duble numa porta efemera. */
export async function startFakeBotApi(pending: unknown[] = []): Promise<FakeBotApi> {
  const mod = await carregarDuble()
  return mod.startFakeBotApi({ pending })
}

/** Construtor de update de mensagem do duble. */
export async function fakeMessageUpdate(options: {
  updateId?: number
  fromId?: number
  chatId?: number
  text?: string
}): Promise<unknown> {
  const mod = await carregarDuble()
  return mod.fakeMessageUpdate(options)
}

/** Os erros canonicos transcritos de `Client.cpp`, incluindo o 409 e o 429. */
export async function canonicalErrors(): Promise<ModuloDuble['CANONICAL_ERRORS']> {
  const mod = await carregarDuble()
  return mod.CANONICAL_ERRORS
}

/**
 * Espera que `condicao` fique verdadeira, ou falha por prazo. Cede o turno
 * enquanto o I/O do servidor local acontece — nenhum atraso do produto e medido
 * assim (esses passam por {@link FakeTime}).
 */
export async function aguardar(
  condicao: () => boolean,
  descricao: string,
  prazoMs = 5000,
): Promise<void> {
  const fim = Date.now() + prazoMs
  while (!condicao()) {
    if (Date.now() > fim) throw new Error(`prazo esgotado a espera de: ${descricao}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Um servidor que aceita a ligacao e a DESTROI. Simula a queda de rede. */
export interface ServidorMudo {
  readonly apiRoot: string
  close(): Promise<void>
}

/** Destroem o socket apos aceitar — reproduz o `HttpError` com a URL na causa. */
export async function startServidorMudo(): Promise<ServidorMudo> {
  const server = createServer((_req, res) => {
    res.destroy()
  })
  server.on('connection', (socket) => {
    socket.on('error', () => {
      /* socket destruido emite `error`; sem ouvinte o Node derruba a suite. */
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  const porta = typeof addr === 'object' && addr !== null ? addr.port : 0
  return {
    apiRoot: `http://127.0.0.1:${porta}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

/** As chamadas de um metodo, na ordem em que chegaram. */
export function chamadasDe(srv: FakeBotApi, method: string): ChamadaFalsa[] {
  return srv.calls.filter((call) => call.method === method.toLowerCase())
}