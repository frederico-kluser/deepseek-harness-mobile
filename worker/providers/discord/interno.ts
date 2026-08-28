/**
 * INTERNO do adaptador discord (`worker/providers/discord/**`).
 *
 * Port fiel dos pequenos auxiliares que os ficheiros de referencia
 * (`worker/lib/*` e o `interno.ts` do telegram) fornecem ao processo orientado
 * por provedor. A regra da fronteira D4 (§0 de `worker/surface/contract.ts`)
 * proibe o adaptador de IMPORTAR de `worker/lib/*`, de `worker/auth/*` ou de
 * OUTRO provedor — esses ficheiros sao donos de outras ondas e o adaptador
 * PORTEIA deles, nao os consume. Para nao depender de uma politica de import
 * por-aviso, os auxiliares estruturais de que todo o diretorio precisa
 * (relogio, espera, logger, mascaramento, erro tipado e codigos de saida)
 * vivem AQUI, uma unica vez.
 *
 * ===========================================================================
 * PORQUE RELOGIO E LOGGER SAO TIPOS E NAO IMPORTS
 * ===========================================================================
 * `worker/lib/clock.ts` e `worker/lib/log.ts` satisfazem estes tipos
 * estruturais sem cast: `WorkerClock`/`Sleeper`/`TimeSource` e `WorkerLogger`.
 * ===========================================================================
 */

/** Sinal de cancelamento, ESTRUTURAL (mesma razao de `worker/lib/clock.ts`). */
export interface AbortLike {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
  removeEventListener(type: 'abort', listener: () => void): void
}

/** Quem sabe esperar. `signal` encurta a espera — usado na paragem. */
export interface Sleeper {
  sleep(ms: number, signal?: AbortLike): Promise<void>
}

/** Origem do tempo. */
export interface WorkerClock {
  now(): number
}

/** As duas coisas juntas, que e o que quase todo o consumidor quer. */
export interface TimeSource extends WorkerClock, Sleeper {}

export const systemTime: TimeSource = {
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortLike): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!(ms > 0) || signal?.aborted === true) {
        resolve()
        return
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort)
    }),
}

/** Campos estruturados de uma linha de log. */
export type LogFields = Readonly<Record<string, unknown>>

/**
 * Logger humano do worker — ESTRUTURAL (satisfaz `WorkerLogger` de
 * `worker/lib/log.ts` sem cast): os QUATRO niveis, uma linha por chamada.
 */
export interface WorkerLogger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

/**
 * Logger que acumula em memoria — usado apenas nos testes do adaptador e no
 * arranque quando o boot ainda nao tem o logger de producao.
 */
export function criarLoggerMemoria(sink: (line: string) => void = (line) => process.stderr.write(line)): WorkerLogger {
  function registrar(level: string): (message: string, fields?: LogFields) => void {
    return (message, fields) => {
      const extra =
        fields === undefined
          ? ''
          : Object.entries(fields)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => ` ${key}=${String(value)}`)
              .join('')
      sink(`${level.toUpperCase()} ${message}${extra}`)
    }
  }
  return {
    debug: registrar('debug'),
    info: registrar('info'),
    warn: registrar('warn'),
    error: registrar('error'),
  }
}

/* ========================================================================== */
/* MASCARAMENTO (port de `worker/lib/redact.ts`)                              */
/* ========================================================================== */

/** Substituto visivel: um log com isto diz ao operador que houve corte. */
export const REDACTED = '[REDACTED]'

const MIN_LITERAL_LENGTH = 8

const SECRET_SHAPES: ReadonlyArray<{ pattern: RegExp; keep: string }> = [
  { pattern: /((?<!\d)\d{6,12}:)([A-Za-z0-9_-]{20,})/gu, keep: '$1' },
  { pattern: /((?:proxy-)?authorization\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
  { pattern: /((?:set-)?cookie\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
  { pattern: /(?<![\w.~-])\/(?:(?:home|Users)\/[^/\s"'<>)\];,:]+|root)(?![\w-])/gu, keep: '' },
]

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Devolve `text` com os segredos mascarados (literais conhecidos + formas).
 */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let result = text
  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.length < MIN_LITERAL_LENGTH) continue
    result = result.replace(new RegExp(escapeForRegExp(secret), 'gu'), REDACTED)
  }
  for (const { pattern, keep } of SECRET_SHAPES) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), `${keep}${REDACTED}`)
  }
  return result
}

/**
 * Descricao segura de um valor arbitrario para log. PASSA SEMPRE por
 * `redact` — e por aqui que a mensagem do transporte, com a URL dentro da
 * causa, tentaria sair.
 */
export function describeForLog(value: unknown, knownSecrets: readonly string[] = []): string {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? '' : ` <- ${describeForLog(value.cause, knownSecrets)}`
    return redact(`${value.name}: ${value.message}${cause}`, knownSecrets)
  }
  if (typeof value === 'string') return redact(value, knownSecrets)
  if (value === null || value === undefined || typeof value !== 'object') {
    return redact(String(value), knownSecrets)
  }
  try {
    return redact(JSON.stringify(value), knownSecrets)
  } catch (error) {
    return redact(`[nao serializavel: ${error instanceof Error ? error.name : 'desconhecido'}]`)
  }
}

/* ========================================================================== */
/* ERRO TIPADO E CODIGOS DE SAIDA (port de `worker/lib/errors.ts`)            */
/* ========================================================================== */

export const WORKER_LOG_NAME = 'dsh-guard-messenger/worker'

/**
 * Vocabulario FECHADO de causas do adaptador discord. Espelha o
 * `WorkerErrorCode` de `worker/lib/errors.ts` e o `ProviderErrorCode` do
 * telegram, com os vereditos proprios deste canal:
 *
 *   - `GATEWAY_UNAUTHORIZED` — o token foi recusado (401 no `GET /gateway/bot`
 *     ou close 4004/4013/4014 do gateway): TERMINAL, espelho do 401 do
 *     telegram (exit 12);
 *   - `BOOT_TIMEOUT` — o gateway nao chegou a READY no prazo: espelho do 45 s
 *     do telegram (exit 14);
 *   - `GATEWAY_FAILED` — qualquer outro erro terminal do loop do gateway;
 *   - `CUSTOM_ID_TOO_LONG` — o payload de um botao estourou os 100 bytes do
 *     `custom_id` (falha ALTO na construcao, TG-026).
 */
export type ProviderErrorCode =
  | 'TOKEN_MISSING'
  | 'TOKEN_IN_ARGV'
  | 'GATEWAY_UNAUTHORIZED'
  | 'GATEWAY_FAILED'
  | 'BOOT_TIMEOUT'
  | 'CUSTOM_ID_TOO_LONG'

export class ProviderError extends Error {
  override readonly name = 'ProviderError'
  readonly code: ProviderErrorCode

  constructor(code: ProviderErrorCode, detail: string, options?: { readonly cause?: unknown }) {
    super(`[${WORKER_LOG_NAME}] ${code}: ${detail}`, options)
    this.code = code
  }
}

export const WORKER_EXIT = Object.freeze({
  OK: 0,
  CONFIG: 10,
  CONFLICT: 11,
  UNAUTHORIZED: 12,
  POLLING: 13,
  BOOT_TIMEOUT: 14,
})

/** Codigo de saida que corresponde a cada causa terminal. */
export function exitCodeFor(code: ProviderErrorCode): number {
  switch (code) {
    case 'TOKEN_MISSING':
    case 'TOKEN_IN_ARGV':
      return WORKER_EXIT.CONFIG
    case 'GATEWAY_UNAUTHORIZED':
      return WORKER_EXIT.UNAUTHORIZED
    case 'BOOT_TIMEOUT':
      return WORKER_EXIT.BOOT_TIMEOUT
    case 'GATEWAY_FAILED':
    case 'CUSTOM_ID_TOO_LONG':
      return WORKER_EXIT.POLLING
  }
}
