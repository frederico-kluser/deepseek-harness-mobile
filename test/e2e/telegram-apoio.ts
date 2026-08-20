/**
 * BANCADA dos testes E2E do Telegram (T6.2) — ficheiro SEM sufixo `.test.ts`,
 * por isso o glob de `test:e2e` (so `*.test.ts` em `test/e2e/`) nunca o corre
 * como suite: e apoio.
 *
 * O QUE ESTA SUITE E — E O QUE OS UNITARIOS NAO FAZEM
 * ---------------------------------------------------------------------------
 * E2E aqui significa duas coisas que `test/unit/worker/**` nao fazem:
 *
 *   1. PROCESSO REAL. O entrypoint `worker/telegram-bot.ts` e SPAWNED com o
 *      `node` deste repositorio (type stripping do Node 24), com o ambiente
 *      CONSTRUIDO como o host o constroi (`src/proc/env.ts`: allowlist + token
 *      + marca `DSH_GUARD_IPC`) e o processo inteiro — boot, polling, codigo de
 *      saida — observado. Nada disto passa por `runTelegramWorker` com runtime
 *      injetado: e o ficheiro real a correr, com a costura de producao ligada.
 *
 *   2. FIO REAL. O duble congelado `test/support/telegram-server.mjs` escuta
 *      numa porta efemera e o grammY aponta para la por `apiRoot`. Toda a
 *      assercao sobre payload passa pelo JSON que viajou na rede, e nao por um
 *      duplo de API ou por um `prev` guionado.
 *
 * AS TRES REGRAS de `test/unit/worker/lib/apoio.ts` valem aqui igual:
 *   - nenhum teste fala com `api.telegram.org`; nao ha token real, nao ha rede;
 *   - o tempo e INJETADO (`FakeTime`) em todo o caminho que este repositorio
 *     controla — o unico sono real e o do grammY no 429 do polling, que e o
 *     proprio facto a medir (`telegram-429.test.ts`);
 *   - o log e capturado, para se poder asserir que o TOKEN nunca sai.
 *
 * PORQUE O `import()` DINAMICO DO DUBLE: o mesmo motivo de
 * `test/unit/worker/lib/apoio.ts` — `telegram-server.mjs` nao tem declaracao de
 * tipos e o `tsconfig.json` nao liga `allowJs`; o especificador calculado
 * devolve `any` e a forma volta a ser nomeada aqui em {@link FakeBotApi}.
 */

import { spawn, type ChildProcess } from 'node:child_process'

import type { AbortLike, TimeSource } from '../../worker/lib/clock.ts'
import type { LogFields, WorkerLogger } from '../../worker/lib/log.ts'

/** Um token com a FORMA de um token real. Nao existe bot nenhum por tras. */
export const TOKEN_DE_TESTE = '123456789:AAHfalso-so-para-teste_0123456789abcd'

/**
 * A GUARDA ANTI-TOKEN-REAL, chamada no TOPO de cada ficheiro `telegram-*.test.ts`
 * (a pergunta falsificavel 2 da tarefa).
 *
 * O servidor falso regista o token de cada chamada e o teste passa-o por
 * ambiente CONTROLADO — nunca pelo `process.env` do runner. Se alguem tiver
 * exportado um token real no ambiente, a suite tem de se recusar a correr ao
 * lado dele: basta um teste descuidado que leia `process.env` para o token viajar
 * para o log, e o log do runner e um destino sem mascaramento.
 *
 * FAIL-CLOSED DE PROPOSITO: a guarda dispara com QUALQUER valor na variavel —
 * inclusive o nosso `TOKEN_DE_TESTE`. A distincao "real vs falso" nao e feita
 * aqui porque o formato do token do BotFather nao e garantia de nada
 * (`worker/lib/token.ts` usa a forma so para DETETAR, nunca para validar): o
 * unico juiz de um token e o `getMe`, e o `getMe` nao corre contra o Telegram.
 * O que se exige e que o runner corra SEM a variavel, e ponto.
 */
export function assertSemTokenRealNoAmbiente(): void {
  const presente = process.env['TELEGRAM_BOT_TOKEN']
  if (presente !== undefined && presente.trim() !== '') {
    throw new Error(
      'E2E do Telegram ABORTADO: TELEGRAM_BOT_TOKEN esta definido no ambiente do runner. ' +
        'Esta suite so corre com o token falso passado por ambiente CONTROLADO ' +
        '(TOKEN_DE_TESTE, nunca pelo process.env). Um token real no ambiente significa ' +
        'que alguem o exportou por engano — recusa-se a correr ao lado dele.',
    )
  }
}

/** Relogio + espera falsos. A espera ANDA com o relogio: e o que o 429 mede. */
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

export interface LogCapturado {
  readonly logger: WorkerLogger
  /** As linhas cruas, exatamente como iriam para o `stderr`. */
  readonly lines: string[]
  /** Tudo junto — para o teste "o token nao aparece em lado nenhum". */
  all(): string
}

/** Logger que junta a um array em vez de escrever. Nivel `debug`, apanha tudo. */
export function captureLog(): LogCapturado {
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
  const logger: WorkerLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  }
  return { logger, lines, all: () => lines.join('\n') }
}

/**
 * Espera que `condicao` fique verdadeira, ou falha por prazo.
 *
 * ISTO NAO E "esperar tempo real do produto": e ceder o turno enquanto o I/O do
 * servidor local acontece. Nenhum atraso do codigo sob teste e medido assim —
 * esses passam por {@link FakeTime} ou sao o facto a medir (o 429 do polling).
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
  const href = new URL('../support/telegram-server.mjs', import.meta.url).href
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

/** As chamadas de um metodo, na ordem em que chegaram. */
export function chamadasDe(srv: FakeBotApi, method: string): ChamadaFalsa[] {
  return srv.calls.filter((call) => call.method === method.toLowerCase())
}

export interface SaidaDeProcesso {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** `true` se o processo so saiu gracas ao kill de seguranca. */
  readonly pendurado: boolean
}

export interface WorkerFilho {
  readonly child: ChildProcess
  readonly stdout: () => string
  readonly stderr: () => string
  /** Resolve no fecho do processo. NUNCA fica pendurado: ha kill de seguranca. */
  readonly saida: Promise<SaidaDeProcesso>
  /** Fecha o stdin (EOF) — o dead-man's switch do worker (`worker/ipc.ts`). */
  encerrar(): void
  /** SIGTERM; passado o prazo, SIGKILL. Idempotente. */
  parar(): Promise<void>
}

/**
 * O ambiente do filho, CONSTRUIDO e nunca herdado — o mesmo criterio de
 * `src/proc/env.ts` (allowlist), com o token falso e a marca do canal IPC.
 *
 * `NODE_OPTIONS` fica DELIBERADAMENTE de fora: ela aceita `--require`, ou seja,
 * carga de codigo arbitrario no filho (`worker/lib/token.ts` documenta o
 * mesmo veto do lado do host).
 */
function ambienteDoHost(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const chave of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ'] as const) {
    const valor = process.env[chave]
    if (valor !== undefined) env[chave] = valor
  }
  return { ...env, ...extra }
}

/**
 * Spawna o worker REAL contra o servidor falso.
 *
 * `stdio` em `'pipe'` nos tres canais, como o host faz (`src/proc/worker.ts`):
 * o `stdin` aberto e o que mantem o dead-man's switch armado — fechar o lado
 * do pai (`encerrar()`) produz EOF e o worker termina sozinho, que e o
 * desligamento limpo deste processo.
 */
export function spawnWorkerProcess(deps: { srv: FakeBotApi; argvExtra?: readonly string[] }): WorkerFilho {
  const { srv } = deps
  const raiz = new URL('../..', import.meta.url).pathname
  const entrypoint = new URL('../../worker/telegram-bot.ts', import.meta.url).pathname

  let acumuladoStdout = ''
  let acumuladoStderr = ''

  const child = spawn(process.execPath, [entrypoint, ...(deps.argvExtra ?? [])], {
    cwd: raiz,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: ambienteDoHost({
      TELEGRAM_BOT_TOKEN: TOKEN_DE_TESTE,
      TELEGRAM_API_ROOT: srv.apiRoot,
      DSH_GUARD_IPC: '1',
    }),
  })
  child.stdout?.on('data', (d: Buffer) => {
    acumuladoStdout += d
  })
  child.stderr?.on('data', (d: Buffer) => {
    acumuladoStderr += d
  })

  // Se o processo nao fechar sozinho (um caminho de erro inesperado deixou um
  // handle vivo), o kill de seguranca resolve a promessa em vez de pendurar a
  // suite. O `pendurado` no resultado torna o teste vermelho por causa certa.
  let resolvida = false
  let pendurado = false
  const watchdog = setTimeout(() => {
    pendurado = true
    try {
      child.kill('SIGKILL')
      // Processo ja morreu; o 'close' resolve a promessa. O selector conta
      // statements e nao ve comentarios, entao a excecao vai explicita.
      // eslint-disable-next-line no-restricted-syntax
    } catch {
      // Processo ja morreu; o 'close' resolve a promessa.
    }
  }, 20_000)
  watchdog.unref()

  const saida = new Promise<SaidaDeProcesso>((resolve) => {
    child.on('close', (code, signal) => {
      if (resolvida) return
      resolvida = true
      clearTimeout(watchdog)
      resolve({ code, signal, pendurado })
    })
    // Um erro de spawn e seguido de 'close'; quem resolve e sempre o 'close'.
    child.on('error', () => undefined)
  })

  return {
    child,
    stdout: () => acumuladoStdout,
    stderr: () => acumuladoStderr,
    saida,
    encerrar: () => {
      try {
        child.stdin?.end()
        // stdin ja fechado: nada a fazer. Excecao mitigada de proposito.
        // eslint-disable-next-line no-restricted-syntax
      } catch {
        // stdin ja fechado: nada a fazer.
      }
    },
    parar: async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill('SIGTERM')
      } catch {
        return
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL')
            // morreu entretanto. Excecao mitigada de proposito.
            // eslint-disable-next-line no-restricted-syntax
          } catch {
            // morreu entretanto.
          }
          resolve()
        }, 2000)
        t.unref()
        child.once('close', () => {
          clearTimeout(t)
          resolve()
        })
      })
    },
  }
}
