/**
 * Log HUMANO do worker — e a metade que sustenta a invariante S2.
 *
 * ===========================================================================
 * S2 — DISCIPLINA DE FLUXO. TODO log humano vai para `stderr`.
 * ===========================================================================
 * `src/contracts/ipc.ts` S2: «O worker escreve EXCLUSIVAMENTE JSONL em
 * `stdout`. TODO log humano vai para `stderr`.» Regra de uma linha — mas
 * violada, o parser do pai passa a ver ruido, e **o modo de falha e
 * silencioso**: o canal parece vivo e as mensagens somem.
 *
 * Por isso este modulo NAO expoe forma nenhuma de escrever em `stdout`, e o
 * `sink` por omissao esta pregado a `process.stderr`. `console.log` escreve em
 * `stdout` e por isso NAO aparece em lado nenhum de `worker/`. (A implementacao
 * do lado JSONL e de T4.3; aqui so se respeita a disciplina.)
 *
 * NOTA sobre o grammY: o `debug` que ele usa (`out/platform.node.js`) escreve
 * em `process.stderr`, e so quando `DEBUG` esta no ambiente — variavel que
 * `WORKER_ENV_ALLOWLIST` nao deixa passar. Ou seja, nem por ai o `stdout` e
 * contaminado.
 *
 * ===========================================================================
 * NADA DE ESTADO GLOBAL DE MODULO
 * ===========================================================================
 * Nao ha logger de modulo. Quem quer registar recebe um; quem testa passa um
 * `sink` que junta a um array. O fornecedor de segredos e uma FUNCAO e nao uma
 * lista, porque o token pode ser rodado em runtime e uma lista capturada no
 * arranque deixaria de mascarar exatamente o valor novo.
 */

import { systemTime, type WorkerClock } from './clock.ts'
import { describeForLog, redact } from './redact.ts'
import { WORKER_LOG_NAME } from './errors.ts'

/** Niveis, do mais barulhento ao mais grave. A ordem e a do array. */
export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error'] as const)

export type WorkerLogLevel = (typeof LOG_LEVELS)[number]

/** Campos estruturados de uma linha. Valores passam por {@link describeForLog}. */
export type LogFields = Readonly<Record<string, unknown>>

export interface WorkerLogger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

export interface WorkerLoggerOptions {
  /**
   * Para onde vai a linha ja formatada (com `\n`). Omitido, `process.stderr`.
   * NUNCA `process.stdout` — ver S2 no cabecalho.
   */
  readonly sink?: (line: string) => void
  /** Segredos literais a mascarar. FUNCAO, para acompanhar rotacao. */
  readonly secrets?: () => readonly string[]
  readonly clock?: WorkerClock
  /** Abaixo deste nivel nao se escreve nada. Omitido, `info`. */
  readonly level?: WorkerLogLevel
}

function rank(level: WorkerLogLevel): number {
  return LOG_LEVELS.indexOf(level)
}

/** Serializa os campos como ` chave=valor`, na ordem em que foram declarados. */
function formatFields(fields: LogFields, secrets: readonly string[]): string {
  let out = ''
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    out += ` ${key}=${describeForLog(value, secrets)}`
  }
  return out
}

/**
 * Cria um logger. Uma linha por chamada, sempre terminada em `\n`.
 *
 * O `\n` e obrigatorio e nao decorativo: sem ele duas escritas concorrentes em
 * `stderr` colam-se e o operador le uma linha que nunca existiu.
 */
export function createWorkerLogger(options: WorkerLoggerOptions = {}): WorkerLogger {
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stderr.write(line)
    })
  const secretsOf = options.secrets ?? ((): readonly string[] => [])
  const clock = options.clock ?? systemTime
  const minimum = rank(options.level ?? 'info')

  function write(level: WorkerLogLevel, message: string, fields?: LogFields): void {
    if (rank(level) < minimum) return
    const secrets = secretsOf()
    const stamp = new Date(clock.now()).toISOString()
    const body = redact(message, secrets)
    const extra = fields === undefined ? '' : formatFields(fields, secrets)
    sink(`${stamp} ${level.toUpperCase()} [${WORKER_LOG_NAME}] ${body}${extra}\n`)
  }

  return {
    debug: (message, fields) => {
      write('debug', message, fields)
    },
    info: (message, fields) => {
      write('info', message, fields)
    },
    warn: (message, fields) => {
      write('warn', message, fields)
    },
    error: (message, fields) => {
      write('error', message, fields)
    },
  }
}
