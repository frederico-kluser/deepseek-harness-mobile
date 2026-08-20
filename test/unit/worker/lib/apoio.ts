/**
 * Bancada dos testes de `worker/lib/**`.
 *
 * TRES REGRAS, e nenhuma delas e estilo:
 *
 *  1. **Nenhum teste fala com `api.telegram.org`.** O duble e
 *     `test/support/telegram-server.mjs` (CONGELADO no PREP 2), um servidor HTTP
 *     local de verdade — nao um mock de rede — que implementa a maquina de
 *     estados do `tdlib/telegram-bot-api`. Ele escuta em PORTA EFEMERA
 *     (`listen(0)`), portanto duas corridas em paralelo nao se pisam.
 *
 *  2. **O tempo e injetado.** {@link FakeTime} anda quando o codigo sob teste
 *     pede para dormir, e nao antes. Nenhum `setTimeout` real, nenhuma
 *     tolerancia, nenhum teste intermitente.
 *
 *  3. **O log e capturado, nao impresso.** {@link captureLog} devolve as linhas
 *     para que o teste possa asserir sobre elas — em especial que o TOKEN nao
 *     esta la.
 *
 * PORQUE O `import()` DINAMICO DO DUBLE: `telegram-server.mjs` e JavaScript com
 * JSDoc e o `tsconfig.json` deste repositorio nao liga `allowJs`. Um `import`
 * estatico daria `TS7016` ("could not find a declaration file"), e a alternativa
 * seria mexer no `tsconfig.json` — que e partilhado com as outras tres
 * sub-tarefas desta onda. O especificador calculado faz o TypeScript devolver
 * `any`, e a forma volta a ser nomeada aqui, uma vez, em {@link FakeBotApi}.
 */

import { once } from 'node:events'
import { createServer } from 'node:http'

import type { AbortLike, TimeSource } from '../../../../worker/lib/clock.ts'
import type { LogFields, WorkerLogger } from '../../../../worker/lib/log.ts'

/** Um token com a FORMA de um token real. Nao existe bot nenhum por tras. */
export const TOKEN_DE_TESTE = '123456789:AAHfalso-so-para-teste_0123456789abcd'

/** Relogio + espera falsos. A espera ANDA com o relogio: e o que TG-049 mede. */
export class FakeTime implements TimeSource {
  private current: number
  /** Cada `sleep` pedido, em ms, pela ordem em que foi pedido. */
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
    // Cede o turno para que a ordem entre tarefas concorrentes seja a real.
    await Promise.resolve()
  }

  /** Anda com o relogio sem passar por `sleep` (para simular tempo de execucao). */
  advance(ms: number): void {
    this.current += ms
  }
}

export interface LinhaDeLog {
  readonly level: string
  readonly text: string
}

export interface LogCapturado {
  readonly logger: WorkerLogger
  /** As linhas cruas, exatamente como iriam para o `stderr`. */
  readonly lines: string[]
  /** Tudo junto — para o teste "o token nao aparece em lado nenhum". */
  all(): string
}

/** Logger que junta a um array em vez de escrever. Nivel `debug`, apanha tudo. */
export function captureLog(secrets: readonly string[] = []): LogCapturado {
  const lines: string[] = []
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
  // O logger de captura NAO mascara: quem mascara e o codigo sob teste. Se ele
  // falhar, o teste tem de VER o segredo aqui — mascarar na bancada esconderia
  // exatamente o defeito que se procura.
  void secrets
  const logger: WorkerLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  }
  return { logger, lines, all: () => lines.join('\n') }
}

/** Uma chamada que chegou ao duble. */
export interface ChamadaFalsa {
  readonly token: string
  readonly method: string
  readonly payload: Record<string, unknown>
}

/** A forma de `startFakeBotApi()` do duble congelado, nomeada deste lado. */
export interface FakeBotApi {
  /** Sem barra final: o grammY recusa uma. */
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
  fakeMessageUpdate(options?: {
    updateId?: number
    fromId?: number
    chatId?: number
    text?: string
  }): unknown
  CANONICAL_ERRORS: Record<
    string,
    { error_code: number; description: string; parameters?: Record<string, unknown> }
  >
}

async function carregarDuble(): Promise<ModuloDuble> {
  const href = new URL('../../../support/telegram-server.mjs', import.meta.url).href
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
 * Espera que `condicao` fique verdadeira, ou falha por prazo.
 *
 * ISTO NAO E "esperar tempo real do produto": e ceder o turno enquanto o I/O do
 * servidor local acontece. Nenhum atraso do codigo sob teste e medido assim —
 * esses passam todos por {@link FakeTime}.
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
  /** Quantas ligacoes chegaram a ser aceites antes de morrerem. */
  readonly ligacoes: () => number
  close(): Promise<void>
}

/**
 * PORQUE DESTRUIR O SOCKET E NAO RECUSAR A PORTA: um `ECONNREFUSED` falha no
 * `connect` e nunca chega a haver pedido HTTP. Destruir DEPOIS de aceitar
 * reproduz o caso real — Wi-Fi que cai a meio, portatil que suspende — em que o
 * `fetch` ja partiu e morre a espera da resposta. E o caminho que produz o
 * `HttpError` com a URL (e o token) dentro da causa.
 */
export async function startServidorMudo(): Promise<ServidorMudo> {
  let ligacoes = 0
  const server = createServer((req, res) => {
    ligacoes += 1
    res.destroy()
  })
  server.on('connection', (socket) => {
    socket.on('error', () => {
      // Um socket destruido emite `error` do lado do servidor; sem ouvinte, o
      // Node promove-o a excecao nao tratada e derruba a suite inteira.
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  const porta = typeof addr === 'object' && addr !== null ? addr.port : 0
  return {
    apiRoot: `http://127.0.0.1:${porta}`,
    ligacoes: () => ligacoes,
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
