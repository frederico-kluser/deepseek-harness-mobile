/**
 * Bancada dos testes de `worker/commands/**` (T5.2).
 *
 * TRES REGRAS, herdadas da bancada de `worker/lib` (T4.2):
 *
 *  1. **Nenhum teste fala com `api.telegram.org`.** As chamadas ao bot sao
 *     registadas por um duble em memoria; o servidor falso de verdade
 *     (`test/support/telegram-server.mjs`) so aparece num teste de fumo da
 *     costura, via `apiRoot` — nunca o default de producao (TG-069).
 *  2. **O tempo e injetado.** {@link FakeTime} anda quando o codigo sob teste
 *     pede para dormir. Nenhum `setTimeout` real.
 *  3. **O log e capturado.** {@link captureLog} junta as linhas para o teste
 *     asserir sobre elas — em especial que o DIGEST de pareamento nao esta la
 *     (S3-b) e que nenhum segredo sai.
 *
 * A bancada monta a superficie REAL (guard + pareamento + roteador da
 * costura): o que se testa aqui e o codigo de producao, nao um duble dele.
 * O "host" e um duble do lado de la do canal: {@link HostFalso} emite e
 * consome nonces com a semantica de `ConfirmService` (uso unico) e o teste
 * empurra state/ack/error/notify/pairing.challenge pelos tratadores do
 * roteador, como o parser de T4.3 faria.
 */

import { createHash } from 'node:crypto'

import { createIdentityGuard } from '../../../../worker/auth/guard.ts'
import { createPairingChallenge, createPairingReceiver } from '../../../../worker/auth/pairing.ts'
import { criarAllowlistDinamica } from '../../../../worker/commands/costura.ts'
import {
  criarRoteador,
  gerarTokenOpaque,
  type ApiDoBot,
  type EmitirNonce,
  type EnviarOpcoes,
  type Roteador,
} from '../../../../worker/commands/router.ts'
import type { IpcIntentMessage } from '../../../../src/contracts/ipc.ts'
import type { AbortLike, TimeSource } from '../../../../worker/lib/clock.ts'
import type { LogFields, WorkerLogger } from '../../../../worker/lib/log.ts'

/* ========================================================================== */
/* Tempo                                                                       */
/* ========================================================================== */

/** Relogio + espera falsos: a espera ANDA com o relogio (padrao de T4.2). */
export class FakeTime implements TimeSource {
  private current: number
  readonly sleeps: number[] = []

  constructor(startAtMs = 1_700_000_000_000) {
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

/** Cede o turno o suficiente para cadeias de `.then` e microtarefas correrem. */
export async function tick(vezes = 4): Promise<void> {
  for (let i = 0; i < vezes; i += 1) await Promise.resolve()
}

/* ========================================================================== */
/* Log                                                                         */
/* ========================================================================== */

export interface LogCapturado {
  readonly logger: WorkerLogger
  readonly lines: string[]
  all(): string
}

/** Logger que junta a um array. Nao mascara: quem mascara e o codigo sob teste. */
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
  return {
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    lines,
    all: () => lines.join('\n'),
  }
}

/* ========================================================================== */
/* A API do bot (duble)                                                        */
/* ========================================================================== */

export interface MensagemRegistada {
  readonly chat: number
  readonly texto: string
  readonly opcoes: EnviarOpcoes | undefined
}

export interface EdicaoRegistada {
  readonly chat: number
  readonly messageId: number
  readonly texto: string
  readonly opcoes: EnviarOpcoes | undefined
}

export interface RespostaRegistada {
  readonly id: string
  readonly outras: { readonly text?: string; readonly show_alert?: boolean } | undefined
}

/** Duble da `ApiDoBot`: regista tudo e devolve `message_id` monotonico. */
export class FakeApi {
  readonly mensagens: MensagemRegistada[] = []
  readonly edicoes: EdicaoRegistada[] = []
  readonly respostas: RespostaRegistada[] = []
  readonly setMyCommands: unknown[] = []
  /** Liga a falha de rede: `sendMessage` e `editMessageText` passam a rejeitar. */
  falharEnvio = false
  private proximoId = 100

  readonly api: ApiDoBot = {
    sendMessage: async (chat, texto, opcoes) => {
      if (this.falharEnvio) throw new Error('rede em baixo (simulada): sendMessage')
      this.mensagens.push({ chat, texto, opcoes })
      return { message_id: ++this.proximoId }
    },
    editMessageText: async (chat, messageId, texto, opcoes) => {
      if (this.falharEnvio) throw new Error('rede em baixo (simulada): editMessageText')
      this.edicoes.push({ chat, messageId, texto, opcoes })
      return { ok: true }
    },
    answerCallbackQuery: async (id, outras) => {
      this.respostas.push({ id, outras })
      return true
    },
  }

  registrarComandos(comandos: unknown): Promise<unknown> {
    this.setMyCommands.push(comandos)
    return Promise.resolve(true)
  }

  ultimaMensagem(): MensagemRegistada | undefined {
    return this.mensagens.at(-1)
  }
}

/* ========================================================================== */
/* O canal (duble)                                                             */
/* ========================================================================== */

/** Duble do lado worker do canal: regista os intents e pode falhar o send. */
export class FakeIpc {
  readonly intents: IpcIntentMessage[] = []
  falhar = false

  send(intent: IpcIntentMessage): boolean {
    if (this.falhar) return false
    this.intents.push(intent)
    return true
  }
}

/* ========================================================================== */
/* O host (duble do lado de la do canal)                                       */
/* ========================================================================== */

/**
 * O host visto do worker: emite e consome nonces com a semantica de
 * `ConfirmService` (uso unico). E o duplo do que T5.1 fia em producao.
 */
export interface HostFalso {
  readonly emitirNonce: EmitirNonce
  readonly emitidos: string[]
  consumir(nonce: string): boolean
  foiEmitido(nonce: string): boolean
}

export function criarHostFalso(): HostFalso {
  const emitidos = new Set<string>()
  const consumidos = new Set<string>()
  const lista: string[] = []
  return {
    emitirNonce: async (_acao) => {
      const nonce = gerarTokenOpaque()
      emitidos.add(nonce)
      lista.push(nonce)
      return nonce
    },
    emitidos: lista,
    consumir(nonce) {
      if (!emitidos.has(nonce) || consumidos.has(nonce)) return false
      consumidos.add(nonce)
      return true
    },
    foiEmitido(nonce) {
      return emitidos.has(nonce)
    },
  }
}

/* ========================================================================== */
/* A bancada                                                                  */
/* ========================================================================== */

export interface Bancada {
  readonly time: FakeTime
  readonly log: LogCapturado
  readonly api: FakeApi
  readonly ipc: FakeIpc
  readonly host: HostFalso
  readonly roteador: Roteador
  readonly paradas: () => number
  tratar(update: unknown): Promise<void>
}

export interface OpcoesDaBancada {
  /** O codigo de pareamento valido (6 digitos). Default `123456`. */
  readonly codigo?: string
  readonly emitirNonce?: EmitirNonce
  readonly parar?: () => Promise<void>
}

/** Monta a superficie REAL (guard + pareamento + roteador) sobre dubles. */
export function montarBancada(opcoes: OpcoesDaBancada = {}): Bancada {
  const time = new FakeTime()
  const log = captureLog()
  const api = new FakeApi()
  const ipc = new FakeIpc()
  const host = criarHostFalso()
  const codigo = opcoes.codigo ?? '123456'
  const pairing = createPairingReceiver({
    challenge: createPairingChallenge(codigo, time.now() + 5 * 60_000),
    clock: time,
  })
  const guard = createIdentityGuard({ allowlist: criarAllowlistDinamica(pairing) })
  let paradas = 0
  const roteador = criarRoteador({
    log: log.logger,
    time,
    guard,
    pairing,
    ipc: { send: (intent) => ipc.send(intent) },
    api: api.api,
    emitirNonce: opcoes.emitirNonce ?? host.emitirNonce,
    parar: opcoes.parar ?? (async () => {
      paradas += 1
    }),
  })
  return {
    time,
    log,
    api,
    ipc,
    host,
    roteador,
    paradas: () => paradas,
    tratar: (update) => roteador.tratarUpdate(update),
  }
}

/** Digest do codigo — o mesmo sha256 hex que o host envia em `pairing.challenge`. */
export function digestDoCodigo(codigo: string): string {
  return createHash('sha256').update(codigo, 'utf8').digest('hex')
}
