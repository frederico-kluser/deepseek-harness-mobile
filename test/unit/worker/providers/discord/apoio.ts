/**
 * Bancada dos testes de `worker/providers/discord/**`.
 *
 * As MESMAS regras de `test/unit/worker/providers/telegram/apoio.ts`:
 *  1. Nenhum teste fala com `discord.com` — o duble `test/support/discord-server.mjs`
 *     escuta em porta efemera (REST + gateway WS no mesmo listener);
 *  2. O tempo e INJETADO onde o produto o usa (`sleep` do backoff/retry);
 *     os timers do WEBSOCKET (heartbeat) sao reais — os testes do gateway usam
 *     intervalos pequenos e {@link aguardar}, nunca FakeTime (um FakeTime
 *     resolveria `sleep` instantaneamente e o heartbeat nunca pulsaria);
 *  3. O log e CAPTURADO, para asserir que o token nao sai.
 *
 * O `import()` dinamico do duble e a mesma tecnica do apoio do telegram:
 * `discord-server.mjs` e JS e o `tsconfig.json` nao liga `allowJs`; o
 * especificador calculado devolve `any` e a forma e nomeada aqui uma vez.
 */

import type { AbortLike, TimeSource } from '../../../../../worker/providers/discord/interno.ts'
import type { LogFields, WorkerLogger } from '../../../../../worker/providers/discord/interno.ts'

/** Um token com a FORMA de um token real (longo, base64url). Nao existe bot. */
export const TOKEN_DE_TESTE = 'dsh_bot_token_falso_para_teste_sem_conta_real_0123456789abcdefghij'

/**
 * A GUARDA ANTI-TOKEN-REAL (espelho do telegram): a suite recusa-se a correr
 * com `DISCORD_BOT_TOKEN` no ambiente do runner — um token real no ambiente
 * significa que alguem o exportou por engano, e um teste descuidado poderia
 * leva-lo ao log.
 */
export function assertSemTokenRealNoAmbiente(): void {
  const presente = process.env['DISCORD_BOT_TOKEN']
  if (presente !== undefined && presente.trim() !== '') {
    throw new Error(
      'Testes do Discord ABORTADOS: DISCORD_BOT_TOKEN esta definido no ambiente do runner. ' +
        'Esta suite so corre com o token falso passado por ambiente CONTROLADO.',
    )
  }
}

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
  const logger: WorkerLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  }
  return { logger, lines, all: () => lines.join('\n') }
}

/** Uma chamada REST que chegou ao duble. */
export interface ChamadaDiscord {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown> | undefined
  /** O valor cru do cabecalho Authorization (Bearer <token>). */
  readonly authorization: string
}

/** A forma de `startFakeDiscord()` do duble congelado. */
export interface FakeDiscord {
  readonly apiRoot: string
  readonly gatewayUrl: string
  readonly calls: ChamadaDiscord[]
  readonly estado: { messageId: number }
  readonly gatewayState: {
    identify: Array<Record<string, unknown> | undefined>
    resumes: Array<Record<string, unknown> | undefined>
    heartbeats: number
    sessions: number
    seq: number
  }
  queueError(chave: string, err: { status: number; body: Record<string, unknown> }): FakeDiscord
  enfileirarEvento(payload: { t?: string; d?: Record<string, unknown> }): FakeDiscord
  enviarRaw(payload: Record<string, unknown>): FakeDiscord
  fecharGateway(code?: number, motivo?: string): FakeDiscord
  close(): Promise<void>
}

interface ModuloDuble {
  startFakeDiscord(options?: {
    port?: number
    gatewayHeartbeatMs?: number
    sessionId?: string
  }): Promise<FakeDiscord>
}

async function carregarDuble(): Promise<ModuloDuble> {
  const href = new URL('../../../../support/discord-server.mjs', import.meta.url).href
  return (await import(href)) as ModuloDuble
}

/** Arranca o duble numa porta efemera (REST + gateway WS no mesmo listener). */
export async function startFakeDiscord(options: {
  gatewayHeartbeatMs?: number
  sessionId?: string
} = {}): Promise<FakeDiscord> {
  const mod = await carregarDuble()
  return mod.startFakeDiscord(options)
}

/**
 * Espera que `condicao` fique verdadeira, ou falha por prazo. Cede o turno
 * enquanto o I/O do servidor local acontece — nenhum atraso do produto e
 * medido assim (o heartbeat do gateway e real e curto nos testes que o usam).
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

/** As chamadas REST de um prefixo de path, na ordem em que chegaram. */
export function chamadasDe(srv: FakeDiscord, prefixo: string): ChamadaDiscord[] {
  return srv.calls.filter((call) => call.path.startsWith(prefixo))
}
