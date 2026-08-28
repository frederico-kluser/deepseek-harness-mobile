/**
 * BANCADA dos testes E2E do Discord — ficheiro SEM sufixo `.test.ts`, por
 * isso o glob de `test:e2e` nunca o corre como suite: e apoio.
 *
 * Espelho de `telegram-apoio.ts`: o entrypoint REAL (`worker/telegram-bot.ts`)
 * e SPAWNED com o ambiente CONSTRUIDO como o host o constroi
 * (`src/proc/env.ts`: allowlist + token + marca `DSH_GUARD_IPC`), apontando
 * para o duble `test/support/discord-server.mjs` (REST + gateway WS no mesmo
 * listener). O `DSH_GUARD_PROVIDER=discord` e a variavel que faz o registry do
 * worker resolver o adaptador discord (a linha desta Onda 3).
 *
 * O canal IPC e REAL: o worker escreve JSONL no `stdout` e le do `stdin` — o
 * teste envia `pairing.owner` pelo stdin (semear o dono) e observa as
 * `intent` no stdout.
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** Um token com a FORMA de um token real. Nao existe bot nenhum por tras. */
export const TOKEN_DE_TESTE_DISCORD =
  'dsh_bot_token_falso_para_teste_sem_conta_real_0123456789abcdefghij'

/** Os eixos do dono sintetico (snowflakes STRING — D4). */
export const DONO = { from: '1057992969437413409', chat: '112233445566778899' }

/**
 * A GUARDA ANTI-TOKEN-REAL (espelho do telegram): a suite recusa-se a correr
 * com `DISCORD_BOT_TOKEN` no ambiente do runner.
 */
export function assertSemTokenRealNoAmbiente(): void {
  const presente = process.env['DISCORD_BOT_TOKEN']
  if (presente !== undefined && presente.trim() !== '') {
    throw new Error(
      'E2E do Discord ABORTADO: DISCORD_BOT_TOKEN esta definido no ambiente do runner. ' +
        'Esta suite so corre com o token falso passado por ambiente CONTROLADO.',
    )
  }
}

/** A forma de `startFakeDiscord()` do duble. */
export interface FakeDiscordE2E {
  readonly apiRoot: string
  readonly gatewayUrl: string
  readonly calls: Array<{
    method: string
    path: string
    body: Record<string, unknown> | undefined
    authorization: string
  }>
  readonly gatewayState: {
    identify: Array<Record<string, unknown> | undefined>
    resumes: Array<Record<string, unknown> | undefined>
    heartbeats: number
    sessions: number
  }
  queueError(chave: string, err: { status: number; body: Record<string, unknown> }): FakeDiscordE2E
  enfileirarEvento(payload: { t?: string; d?: Record<string, unknown> }): FakeDiscordE2E
  enviarRaw(payload: Record<string, unknown>): FakeDiscordE2E
  fecharGateway(code?: number, motivo?: string): FakeDiscordE2E
  close(): Promise<void>
}

interface ModuloDuble {
  startFakeDiscord(options?: { port?: number; gatewayHeartbeatMs?: number; sessionId?: string }): Promise<FakeDiscordE2E>
}

async function carregarDuble(): Promise<ModuloDuble> {
  const href = new URL('../support/discord-server.mjs', import.meta.url).href
  return (await import(href)) as ModuloDuble
}

/** Arranca o duble numa porta efemera. */
export async function startFakeDiscord(opcoes: { gatewayHeartbeatMs?: number } = {}): Promise<FakeDiscordE2E> {
  const mod = await carregarDuble()
  return mod.startFakeDiscord(opcoes)
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
  /** Escreve UMA linha JSONL no stdin (canal host -> worker). */
  escrever(mensagem: Record<string, unknown>): void
  /** Fecha o stdin (EOF) — o dead-man's switch do worker (`worker/ipc.ts`). */
  encerrar(): void
  /** SIGTERM; passado o prazo, SIGKILL. Idempotente. */
  parar(): Promise<void>
}

/** O ambiente do filho, CONSTRUIDO e nunca herdado (allowlist do host). */
function ambienteDoHost(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const chave of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ'] as const) {
    const valor = process.env[chave]
    if (valor !== undefined) env[chave] = valor
  }
  return { ...env, ...extra }
}

/**
 * Spawna o worker REAL em modo DISCORD contra o duble.
 *
 * `stdio` em `'pipe'` nos tres canais, como o host faz: o `stdin` aberto e o
 * que mantem o dead-man's switch armado — `encerrar()` produz EOF e o worker
 * termina sozinho.
 */
export function spawnWorkerDiscord(deps: { srv: FakeDiscordE2E; argvExtra?: readonly string[] }): WorkerFilho {
  const { srv } = deps
  const raiz = new URL('../..', import.meta.url).pathname
  const entrypoint = new URL('../../worker/telegram-bot.ts', import.meta.url).pathname

  let acumuladoStdout = ''
  let acumuladoStderr = ''

  const child = spawn(process.execPath, [entrypoint, ...(deps.argvExtra ?? [])], {
    cwd: raiz,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: ambienteDoHost({
      DISCORD_BOT_TOKEN: TOKEN_DE_TESTE_DISCORD,
      DISCORD_API_ROOT: srv.apiRoot,
      DSH_GUARD_PROVIDER: 'discord',
      DSH_GUARD_IPC: '1',
    }),
  })
  child.stdout?.on('data', (d: Buffer) => {
    acumuladoStdout += d
  })
  child.stderr?.on('data', (d: Buffer) => {
    acumuladoStderr += d
  })

  // Kill de seguranca: se o processo nao fechar sozinho, a promessa resolve
  // com `pendurado: true` em vez de pendurar a suite.
  let resolvida = false
  let pendurado = false
  const watchdog = setTimeout(() => {
    pendurado = true
    try {
      child.kill('SIGKILL')
    } catch {
      // processo ja morreu; o 'close' resolve a promessa
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
    child.on('error', () => undefined)
  })

  return {
    child,
    stdout: () => acumuladoStdout,
    stderr: () => acumuladoStderr,
    saida,
    escrever: (mensagem) => {
      try {
        child.stdin?.write(`${JSON.stringify(mensagem)}\n`)
      } catch {
        // stdin ja fechado: nada a fazer
      }
    },
    encerrar: () => {
      try {
        child.stdin?.end()
      } catch {
        // stdin ja fechado: nada a fazer
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
          } catch {
            // morreu entretanto
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

/**
 * Espera que `condicao` fique verdadeira, ou falha por prazo.
 */
export async function aguardar(
  condicao: () => boolean,
  descricao: string,
  prazoMs = 8000,
): Promise<void> {
  const fim = Date.now() + prazoMs
  while (!condicao()) {
    if (Date.now() > fim) throw new Error(`prazo esgotado a espera de: ${descricao}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** As chamadas REST de um prefixo de path, na ordem em que chegaram. */
export function chamadasDe(srv: FakeDiscordE2E, prefixo: string): FakeDiscordE2E['calls'] {
  return srv.calls.filter((call) => call.path.startsWith(prefixo))
}
