/**
 * Bancada dos testes de `worker/surface/commands.ts` (e onde o outbox precisa).
 *
 * TRES REGRAS herdadas de `test/unit/worker/commands/apoio.ts`:
 *  1. Nenhum teste fala com a rede — as chamadas ao emissor sao registadas.
 *  2. O tempo e INJETADO: {@link FakeTime} anda quando o codigo pede para dormir.
 *  3. O log e capturado para se asserir sobre ele (nenhum segredo sai).
 *
 * O CONTEXTO aqui e um duplo de {@link SurfaceCommandContext} — o NUCLEO (onda
 * 2.1) e quem o monta em producao; este apoio so o estenografa para exercitar
 * os comandos neutros isoladamente.
 */

import { randomBytes } from 'node:crypto'

import type {
  SurfaceCommandContext,
  SurfaceCommandLog,
  SurfaceEditOutcome,
  SurfaceIdentity,
  SurfaceSendOptions,
} from '../../../../worker/surface/contract.ts'
import type { IntencaoNeutra } from '../../../../worker/surface/contract.ts'

/** Relogio + espera falsos: a espera ANDA com o relogio. */
export class FakeTime {
  private current: number
  readonly sleeps: number[] = []

  constructor(startAtMs = 1_700_000_000_000) {
    this.current = startAtMs
  }

  now(): number {
    return this.current
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    if (ms > 0) this.current += ms
    await Promise.resolve()
  }

  advance(ms: number): void {
    this.current += ms
  }
}

/** Cede o turno para cadeias de `.then` e microtarefas correrem. */
export async function tick(vezes = 4): Promise<void> {
  for (let i = 0; i < vezes; i += 1) await Promise.resolve()
}

export interface LogCapturado {
  readonly logger: SurfaceCommandLog
  readonly lines: string[]
  all(): string
}

/** Logger que junta a um array. Nao mascara — quem mascara e o codigo sob teste. */
export function capturarLog(): LogCapturado {
  const lines: string[] = []
  const record =
    (level: string) =>
    (message: string, fields?: Readonly<Record<string, unknown>>): void => {
      const extra =
        fields === undefined
          ? ''
          : Object.entries(fields)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => ` ${k}=${String(v)}`)
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

export interface MensagemRegistada {
  readonly chat: string
  readonly texto: string
  readonly opcoes: SurfaceSendOptions | undefined
}

/** Duplo do emissor neutro (o `SurfaceSender` que o nucleo forneceria). */
export class EmissorFalso {
  readonly mensagens: MensagemRegistada[] = []
  editas: Array<{ chat: string; messageId: string; texto: string }> = []
  respostas: Array<{ id: string; outras: { text?: string; showAlert?: boolean } | undefined }> = []
  paradas = 0
  proximoId = 100

  async enviar(chatKey: string, texto: string, opcoes?: SurfaceSendOptions): Promise<string> {
    this.mensagens.push({ chat: chatKey, texto, opcoes })
    this.proximoId += 1
    return String(this.proximoId)
  }

  async editar(chatKey: string, messageId: string, texto: string): Promise<SurfaceEditOutcome> {
    this.editas.push({ chat: chatKey, messageId, texto })
    return 'edited'
  }

  async responder(id: string, outras?: { text?: string; showAlert?: boolean }): Promise<boolean> {
    this.respostas.push({ id, outras })
    return true
  }

  ultimaMensagem(): MensagemRegistada | undefined {
    return this.mensagens.at(-1)
  }

  /** A primeira linha de acao do envio `indice`, se houver. */
  botao(
    indice: number,
  ):
    | { label: string; action: string; token: string; kind: 'confirm' | 'emergency' | undefined }
    | undefined {
    const mensagem = this.mensagens[indice]
    const primeiro = mensagem?.opcoes?.actionRows?.[0]?.[0]
    if (primeiro === undefined) return undefined
    return { label: primeiro.label, action: primeiro.action, token: primeiro.token, kind: primeiro.kind }
  }
}

/** O host visto do contexto: emite nonces (uso unico — semantica ConfirmService). */
export interface HostFalso {
  readonly emitirNonce: (acao: string) => Promise<string | undefined>
  readonly emitidos: string[]
  foiEmitido(nonce: string): boolean
}

export function criarHostFalso(): HostFalso {
  const emitidos = new Set<string>()
  const lista: string[] = []
  return {
    emitirNonce: async () => {
      const nonce = randomBytes(8).toString('base64url')
      emitidos.add(nonce)
      lista.push(nonce)
      return nonce
    },
    emitidos: lista,
    foiEmitido(nonce) {
      return emitidos.has(nonce)
    },
  }
}

/** Duplo do canal: regista os intents neutros enviados. */
export class CanalFalso {
  readonly intents: IntencaoNeutra[] = []
  /** Donos comunicados por `pairingSuccess` (EMENDA ONDA-1-PAREAR-VIA-PAINEL). */
  readonly pareamentos = new Array<{ userKey: string; chatKey: string; pairedAt: number }>()
  falhar = false

  send(intent: unknown): boolean {
    if (this.falhar) return false
    this.intents.push(intent as IntencaoNeutra)
    return true
  }

  pairingSuccess(dono: { userKey: string; chatKey: string; pairedAt: number }): void {
    this.pareamentos.push(dono)
  }
}

export interface BancadaDeComandos {
  readonly time: FakeTime
  readonly log: LogCapturado
  readonly emissor: EmissorFalso
  readonly canal: CanalFalso
  readonly host: HostFalso
  readonly ctx: SurfaceCommandContext
}

export interface OpcoesDaBancada {
  readonly emitirNonce?: (acao: string) => Promise<string | undefined>
}

/**
 * Monta um {@link SurfaceCommandContext} duplo sobre dubles. O nucleo da Onda
 * 2.1 e quem monta o contexto em producao; aqui so se estenografa.
 */
export function montarBancada(opcoes: OpcoesDaBancada = {}): BancadaDeComandos {
  const time = new FakeTime()
  const log = capturarLog()
  const emissor = new EmissorFalso()
  const canal = new CanalFalso()
  const host = criarHostFalso()

  const ctx: SurfaceCommandContext = {
    log: log.logger,
    time,
    ipc: { send: (intent) => canal.send(intent), pairingSuccess: (dono) => canal.pairingSuccess(dono) },
    emitirNonce: opcoes.emitirNonce ?? host.emitirNonce,
    parar: async () => {
      emissor.paradas += 1
    },
    enviar: emissor.enviar.bind(emissor),
    editar: emissor.editar.bind(emissor),
    mostrarEstado: async (chat, texto) => {
      emissor.mensagens.push({ chat, texto, opcoes: undefined })
      emissor.proximoId += 1
      return String(emissor.proximoId)
    },
    responder: emissor.responder.bind(emissor),
    pendente: {
      registar: () => undefined,
      retirar: () => undefined,
    },
    projecao: { ler: () => ({ state: undefined, seq: 0 }) },
    // Antes do pareamento nao ha dono; os comandos que precisam do `dono`
    // (nucleo) injectam-no no contexto real.
    dono: () => undefined,
  }

  const bancada: BancadaDeComandos = {
    time,
    log,
    emissor,
    canal,
    host,
    ctx,
  }

  return bancada
}

/** O `userKey`/`chatKey` do dono nos testes de comando. */
export const OWNER: SurfaceIdentity = { userKey: '111', chatKey: '111' }