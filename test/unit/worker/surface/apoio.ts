/**
 * Bancada dos testes do NUCLEO NEUTRO da superficie (`test/unit/worker/surface/**`).
 *
 * Port da bancada de `test/unit/worker/commands/apoio.ts` (T5.2), REescrita para a
 * superficie neutra — o que se testa aqui e o `worker/surface/core.ts` de producao
 * (onda 2, nucleo) e os TEXTOS/ACCOES que ele usa, contra EVENTOS NEUTROS
 * ({@link SurfaceEvent}) e dubles de toda a fronteira.
 *
 * TRES REGRAS, herdadas da bancada de T5.2:
 *  1. Nenhum teste fala com a rede (nem Telegram nem IPC real).
 *  2. O tempo e injectado ({@link FakeTime}) — a coalescencia de 1 msg/s e a
 *     espera da recusa de pareamento dormem pelo relogio falso.
 *  3. O log e capturado ({@link captureLog}) para asserir que nada sai (S3-b) e
 *     que descartes sao "contados" na auditoria (TG-089).
 *
 * O que AQUI e duble e o que, em producao, a onda 4 fia:
 *   - {@link FakeSender} — o {@link SurfaceSender} do adaptador (`adapter.sender()`).
 *   - {@link FakeIpc} — o {@link SurfaceIpcBridge} (canal host<-worker).
 *   - {@link HostFalso} — a ponte de nonce (o duplo do `ConfirmService`).
 *   - {@link FakeAuth} — o funil {@link SurfaceAuth} (allowlist + pareamento) que
 *     a onda 2 `auth.ts` implementara; AQUI e um duplo com a semantica minima
 *     (parear 1 dono -> allowlist dos dois eixos, default deny).
 *   - {@link FakeComandos} — o despacho {@link SurfaceComandos} que a onda 2
 *     `commands.ts` implementara; AQUI e um duplo que regista e executa a minima
 *     logica necessaria aos testes (ligar/desligar/emergencia).
 */

import {
  criarNucleo,
  type ComandoPublicado,
  type Nucleo,
  type NucleoDeps,
  type SurfaceAdmissao,
  type SurfaceAuth,
  type SurfaceComandos,
  type SurfaceDono,
  type SurfacePareamentoResultado,
} from '../../../../worker/surface/core.ts'
import { registarComandosPublicados } from '../../../../worker/surface/core.ts'
import { gerarTokenOpaque } from '../../../../worker/surface/tokens.ts'
import type {
  ActionRowLayout,
  EmitirNonce,
  IntencaoNeutra,
  SurfaceActionEvent,
  SurfaceCommandContext,
  SurfaceCommandEvent,
  SurfaceEditOutcome,
  SurfaceEvent,
  SurfaceIdentity,
  SurfaceLimits,
  SurfaceSendOptions,
  SurfaceSender,
} from '../../../../worker/surface/contract.ts'
import type { AbortLike, TimeSource } from '../../../../worker/lib/clock.ts'
import type { LogFields, WorkerLogger } from '../../../../worker/lib/log.ts'

/* ========================================================================== */
/* Identidades neutras                                                         */
/* ========================================================================== */

/** O `userKey`/`chatKey` do dono (o id do Telegram normalizado para string). */
export const DONO = '111'
/** O `userKey`/`chatKey` de um estranho. */
export const ESTRANHO = '222'

/** A identidade do dono, nos DOIS eixos (normal de DM: iguais). */
export const IDENTIDADE_DONO: SurfaceIdentity = { userKey: DONO, chatKey: DONO }

/** Uma comando do dono. */
export function comandoDoDono(texto: string): SurfaceCommandEvent {
  return { kind: 'comando', identity: { userKey: DONO, chatKey: DONO }, text: texto }
}

/** Uma accao (clique num botao) do dono, num chat dado. */
export function accaoDoDono(
  action: SurfaceActionEvent['action'],
  token: string,
  messageTarget?: string,
): SurfaceActionEvent {
  return {
    kind: 'acao',
    identity: { userKey: DONO, chatKey: DONO },
    action,
    token,
    answerTarget: 'cq-1',
    messageTarget,
  }
}

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
/* O sender (duble do adaptador)                                               */
/* ========================================================================== */

export interface MensagemNeutra {
  readonly chat: string
  readonly texto: string
  readonly opcoes: SurfaceSendOptions | undefined
  /** O `messageId` que o sender devolveu (o `messageTarget` de um botao). */
  readonly id: string
}

export interface EdicaoNeutra {
  readonly chat: string
  readonly messageId: string
  readonly texto: string
  readonly opcoes: SurfaceSendOptions | undefined
}

export interface RespostaNeutra {
  readonly id: string
  readonly outras: { readonly text?: string; readonly showAlert?: boolean } | undefined
}

/** Duble do {@link SurfaceSender}: regista tudo e devolve `messageId` monotonico. */
export class FakeSender {
  readonly mensagens: MensagemNeutra[] = []
  readonly edicoes: EdicaoNeutra[] = []
  readonly respostas: RespostaNeutra[] = []
  /** Liga a falha de rede: `send` e `edit` passam a rejeitar. */
  falharEnvio = false
  private proximoId = 100

  readonly sender: SurfaceSender = {
    send: async (chat, texto, opcoes) => {
      if (this.falharEnvio) throw new Error('rede em baixo (simulada): send')
      this.proximoId += 1
      const id = String(this.proximoId)
      this.mensagens.push({ chat, texto, opcoes, id })
      return id
    },
    edit: async (chat, messageId, texto, opcoes) => {
      if (this.falharEnvio) throw new Error('rede em baixo (simulada): edit')
      this.edicoes.push({ chat, messageId, texto, opcoes })
      return 'edited' as SurfaceEditOutcome
    },
    answer: async (id, outras) => {
      this.respostas.push({ id, outras })
      return true
    },
  }

  ultimaMensagem(): MensagemNeutra | undefined {
    return this.mensagens.at(-1)
  }
}

/* ========================================================================== */
/* O canal IPC (duble)                                                         */
/* ========================================================================== */

/** Duble do lado worker do canal: regista os intents NEUTROS e pode falhar o send. */
export class FakeIpc {
  readonly intents: IntencaoNeutra[] = []
  /** Os donos comunicados por `pairingSuccess` (EMENDA ONDA-1-PAREAR-VIA-PAINEL). */
  readonly pareamentos = new Array<{ userKey: string; chatKey: string; pairedAt: number }>()
  falhar = false

  send(pedido: IntencaoNeutra): boolean {
    if (this.falhar) return false
    this.intents.push(pedido)
    return true
  }

  /** O pareamento concluiu no worker: o dono e comunicado ao HOST (fire-and-forget). */
  pairingSuccess(dono: { userKey: string; chatKey: string; pairedAt: number }): void {
    this.pareamentos.push(dono)
  }
}

/* ========================================================================== */
/* O host (duble do lado de la do canal)                                       */
/* ========================================================================== */

export interface HostFalso {
  readonly emitirNonce: EmitirNonce
  readonly emitidos: string[]
  consumir(nonce: string): boolean
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
  }
}

/* ========================================================================== */
/* A auth (duplo do funil)                                                     */
/* ========================================================================== */

export interface AuthEspiao {
  readonly autenticado: boolean
  readonly emRecepcao: boolean
}

/**
 * Duplo do {@link SurfaceAuth}: a semantica MINIMA que o nucleo precisa —
 * parear 1 dono com um codigo fixo -> allowlist dos dois eixos (default deny).
 * A implementacao REAL e da onda 2 (`worker/surface/auth.ts`); aqui so se quer
 * dirigir o nucleo com eventos neutros e asserir o ORDEM do funil.
 */
export class FakeAuth implements SurfaceAuth {
  private dono: SurfaceDono | undefined
  readonly audit: string[] = []
  readonly codigo: string
  readonly desafiosRotacionados: number[] = []
  secoesSemeadas: number

  constructor(codigo = '123456') {
    this.codigo = codigo
    this.secoesSemeadas = 0
  }

  receber(evento: SurfaceCommandEvent): SurfacePareamentoResultado {
    const identidade = evento.identity
    const comando = parseComandoSimples(evento.text)
    if (comando === undefined) return { kind: 'ignorado' }
    if (comando.nome === 'start') {
      return {
        kind: 'boas-vindas',
        reply:
          '👋 Olá. Este bot controla o acesso ao teu Harness pelo Telegram.\n\n' +
          'Antes de mais nada, pareie-o: gere um código no painel e envie:\n' +
          '   /parear 123456\n\n' +
          'Depois, abra o menu para ligar e desligar o túnel.',
        chat: identidade.chatKey,
      }
    }
    if (comando.nome === 'parear') {
      if (this.dono === undefined && comando.arg === this.codigo) {
        this.dono = { userKey: identidade.userKey, chatKey: identidade.chatKey, pairedAt: 1_700_000_000_000 }
        this.audit.push('auditoria evento=pareamento resultado=permitido')
        return {
          kind: 'pareado',
          dono: this.dono,
          reply:
            '✓ Pareado com sucesso! Agora:\n' +
            '  • /menu — painel de controlo\n' +
            '  • /status — estado do túnel\n\n' +
            'Segurança: só este chat pode comandar o bot.',
        }
      }
      this.audit.push('auditoria evento=pareamento resultado=negado')
      // `/parear` SEM argumento e uma SONDA malformada (silenciosa) — o core
      // redireto-o para o fluxo "pedir valor" quando vê `reason==='refuse:malformed'`.
      const malformada = comando.arg.length === 0
      return {
        kind: 'recusado',
        reason: malformada ? 'refuse:malformed' : 'refuse:wrong-code',
        reply: malformada ? undefined : 'Código errado ou expirado. Confere no painel e tenta de novo.',
        delayMs: malformada ? 0 : 250,
        chat: identidade.chatKey,
      }
    }
    return { kind: 'ignorado' }
  }

  /**
   * O caminho REUTILIZAVEL de validacao de um candidato (espelho minimo do
   * receptor real): malformado → `refuse:malformed` (re-ask, sem debitar);
   * 6 dígitos e == codigo (sem dono) → pareado; caso contraio → recusado.
   */
  verificarCandidato(identidade: SurfaceIdentity, candidato: string): SurfacePareamentoResultado {
    const eSeis = candidato.length === 6 && /^\d{6}$/u.test(candidato)
    if (!eSeis) {
      return {
        kind: 'recusado',
        reason: 'refuse:malformed',
        reply: 'Não entendi o código — 6 dígitos, ex.: `123456`.',
        delayMs: 0,
        chat: identidade.chatKey,
      }
    }
    if (this.dono !== undefined) {
      const eDono = this.dono.userKey === identidade.userKey && this.dono.chatKey === identidade.chatKey
      return {
        kind: 'recusado',
        reason: 'refuse:already-paired',
        reply: eDono ? 'Este bate-papo já é o dono deste bot. Para trocar o dono, reset na máquina.' : undefined,
        delayMs: 0,
        chat: identidade.chatKey,
      }
    }
    if (candidato === this.codigo) {
      this.dono = { userKey: identidade.userKey, chatKey: identidade.chatKey, pairedAt: 1_700_000_000_000 }
      return {
        kind: 'pareado',
        dono: this.dono,
        reply:
          '✓ Pareado com sucesso! Agora:\n' +
          '  • /menu — painel de controlo\n' +
          '  • /status — estado do túnel\n\n' +
          'Segurança: só este chat pode comandar o bot.',
      }
    }
    return {
      kind: 'recusado',
      reason: 'refuse:wrong-code',
      reply: 'Código errado ou expirado. Confere no painel e tenta de novo.',
      delayMs: 250,
      chat: identidade.chatKey,
    }
  }

  admitirComando(identidade: SurfaceIdentity): SurfaceAdmissao {
    return this.admitir(identidade)
  }

  admitirAcao(identidade: SurfaceIdentity, _action: string): SurfaceAdmissao {
    return this.admitir(identidade)
  }

  estado(): { status: 'aberto' } | { status: 'fechado'; dono: SurfaceDono } {
    return this.dono === undefined ? { status: 'aberto' } : { status: 'fechado', dono: this.dono }
  }

  rotacionarDesafio(desafio: { readonly expiresAt: number; verify(c: string): boolean }): void {
    this.desafiosRotacionados.push(desafio.expiresAt)
  }

  semearDono(dono: SurfaceDono): void {
    this.dono = dono
    this.secoesSemeadas += 1
  }

  private admitir(identidade: SurfaceIdentity): SurfaceAdmissao {
    const d = this.dono
    if (d === undefined) {
      this.audit.push('auditoria evento=update resultado=negado motivo=deny:not-configured')
      return { admitido: false, motivo: 'not-configured' }
    }
    if (identidade.userKey === d.userKey && identidade.chatKey === d.chatKey) {
      this.audit.push('auditoria evento=update resultado=permitido')
      return { admitido: true }
    }
    this.audit.push('auditoria evento=update resultado=negado motivo=deny:not-allowlisted')
    return { admitido: false, motivo: 'not-allowlisted' }
  }
}

/** Le `/comando argumento` com o sufixo `@bot` descartado — o minimo do duplo. */
function parseComandoSimples(texto: string): { nome: string; arg: string } | undefined {
  const aparado = texto.trim()
  if (!aparado.startsWith('/')) return undefined
  const espaco = aparado.search(/\s/u)
  const cabeca = espaco === -1 ? aparado : aparado.slice(0, espaco)
  const arg = espaco === -1 ? '' : aparado.slice(espaco + 1).trim()
  const arroba = cabeca.indexOf('@')
  const nome = (arroba === -1 ? cabeca.slice(1) : cabeca.slice(1, arroba)).toLowerCase()
  if (nome.length === 0) return undefined
  return { nome, arg }
}

/* ========================================================================== */
/* O despacho de comandos (duplo)                                              */
/* ========================================================================== */

/** O estado do despacho que os testes observam. */
export interface DespachoObservado {
  readonly chamadas: Array<{ nome: string; identidade: SurfaceIdentity }>
  readonly confirmarDesligar: Array<{
    identidade: SurfaceIdentity
    token: string
    answerTarget: string
    messageTarget: string | undefined
  }>
}

/** Duplo do {@link SurfaceComandos}: regista e executa a logica minima. */
export class FakeComandos implements SurfaceComandos {
  readonly estado: DespachoObservado = { chamadas: [], confirmarDesligar: [] }
  readonly contextos: SurfaceCommandContext[] = []
  private ctx: SurfaceCommandContext | undefined

  /** A factory que a onda 4 usara; aqui devolve `this` e guarda o contexto. */
  fabrica(contexto: SurfaceCommandContext): FakeComandos {
    this.ctx = contexto
    this.contextos.push(contexto)
    return this
  }

  async ligar(identidade: SurfaceIdentity): Promise<void> {
    this.estado.chamadas.push({ nome: 'ligar', identidade })
    const nonce = await this.ctx?.emitirNonce('tunnel.up')
    if (nonce === undefined) {
      await this.ctx?.enviar(identidade.chatKey, 'Não foi possível obter a confirmação do host. Tente de novo em alguns segundos.')
      return
    }
    await this.ctx?.enviar(identidade.chatKey, '🟢 Ligar o túnel agora? Quando abrir, o link de acesso chega aqui por si só.', {
      actionRows: [[{ label: '✅ Sim, ligar', action: 'tunnel.up', token: nonce }]],
    })
  }

  async desligar(identidade: SurfaceIdentity): Promise<void> {
    this.estado.chamadas.push({ nome: 'desligar', identidade })
    const token = gerarTokenOpaque()
    await this.ctx?.enviar(identidade.chatKey, '🔴 Desligar o túnel derruba o acesso remoto. Continuar?', {
      actionRows: [[{ label: '✅ Sim, desligar', action: 'tunnel.down', token }]],
    })
  }

  async confirmarDesligar(
    identidade: SurfaceIdentity,
    token: string,
    answerTarget: string,
    messageTarget: string | undefined,
  ): Promise<void> {
    this.estado.confirmarDesligar.push({ identidade, token, answerTarget, messageTarget })
    // TG-027: responder SEMPRE ao clique — inclusive na negacao.
    await this.ctx?.responder(answerTarget)
    // O intent REDUZ exposicao e NAO carrega nonce (CTL-024). O pendente fica
    // registado para o ack editar a propria mensagem do teclado.
    const intent: IntencaoNeutra = {
      intent: 'tunnel.down',
      requestId: gerarTokenOpaque(),
      userKey: identidade.userKey,
      chatKey: identidade.chatKey,
    }
    const aceite = this.ctx?.ipc.send(intent) ?? false
    if (aceite) {
      this.ctx?.pendente.registar(intent.requestId, identidade.chatKey, 'tunnel.down', messageTarget)
    }
  }

  async status(identidade: SurfaceIdentity): Promise<void> {
    this.estado.chamadas.push({ nome: 'status', identidade })
    const intent: IntencaoNeutra = {
      intent: 'tunnel.status',
      requestId: gerarTokenOpaque(),
      userKey: identidade.userKey,
      chatKey: identidade.chatKey,
    }
    const aceite = this.ctx?.ipc.send(intent) ?? false
    if (aceite) {
      this.ctx?.pendente.registar(intent.requestId, identidade.chatKey, 'tunnel.status', undefined)
    }
  }

  async acessar(identidade: SurfaceIdentity): Promise<void> {
    this.estado.chamadas.push({ nome: 'acessar', identidade })
    const intent: IntencaoNeutra = {
      intent: 'session.issue',
      requestId: gerarTokenOpaque(),
      userKey: identidade.userKey,
      chatKey: identidade.chatKey,
    }
    const aceite = this.ctx?.ipc.send(intent) ?? false
    if (aceite) {
      this.ctx?.pendente.registar(intent.requestId, identidade.chatKey, 'session.issue', undefined)
    }
  }

  async rotacionar(identidade: SurfaceIdentity): Promise<void> {
    this.estado.chamadas.push({ nome: 'rotacionar', identidade })
    const nonce = await this.ctx?.emitirNonce('secret.rotate')
    if (nonce !== undefined) {
      await this.ctx?.enviar(identidade.chatKey, '⇄ Gerar chave nova invalida a atual e as sessões abertas. Continuar?', {
        actionRows: [[{ label: '✅ Sim, gerar', action: 'secret.rotate', token: nonce }]],
      })
    }
  }

  async emergencia(identidade: SurfaceIdentity): Promise<void> {
    this.estado.chamadas.push({ nome: 'emergencia', identidade })
    // CTL-024: a acao reduz exposicao, SEM nonce. Idempotente: responde e
    // derruba UMA vez.
    if (this.emergenciaDisparada) return
    this.emergenciaDisparada = true
    this.ctx?.ipc.send({
      intent: 'emergency',
      requestId: gerarTokenOpaque(),
      userKey: identidade.userKey,
      chatKey: identidade.chatKey,
    })
    await this.ctx?.enviar(identidade.chatKey, '🚨 Emergência disparada. Túnel a desligar e este bot vai encerrar.')
    await this.ctx?.parar()
  }

  private emergenciaDisparada = false
}

/* ========================================================================== */
/* A bancada completa                                                          */
/* ========================================================================== */

export interface Bancada {
  readonly time: FakeTime
  readonly log: LogCapturado
  readonly sender: FakeSender
  readonly ipc: FakeIpc
  readonly host: HostFalso
  readonly auth: FakeAuth
  readonly comandos: FakeComandos
  readonly nucleo: Nucleo
  readonly paradas: () => number
  tratar(evento: SurfaceEvent): Promise<void>
  /** Publica a lista canonica (TG-080) contra um registo dado. */
  registrarComandos(registos: unknown[]): Promise<unknown>
}

export interface OpcoesDaBancada {
  /** O codigo de pareamento valido (6 digitos). Default `123456`. */
  readonly codigo?: string
  readonly limites?: SurfaceLimits
  readonly emitirNonce?: EmitirNonce
  readonly parar?: () => Promise<void>
  /** O dono pre-pareado (equivalente a `pairing.owner` do boot). */
  readonly donoInicial?: SurfaceDono | undefined
}

/** Os limites por omissao (os do Telegram, em forma neutra). */
const LIMITES_POR_OMISSAO: SurfaceLimits = Object.freeze({
  maxTextLength: 4_096,
  maxActionRows: 1,
  maxActionPerRow: 1,
  maxActionDataBytes: 64,
  supportsEditing: true,
})

/**
 * Monta o nucleo NEUTRO `worker/surface/core.ts` sobre dubles. O `FakeComandos`
 * recebe o `SurfaceCommandContext` do nucleo via {@link Bancada.montar} — port do
 * `criarOnOff/criarAccess/criarStatus(contexto)` que a onda 4 fara com a commands.
 */
export function montarBancada(opcoes: OpcoesDaBancada = {}): Bancada {
  const time = new FakeTime()
  const log = captureLog()
  const sender = new FakeSender()
  const ipc = new FakeIpc()
  const host = criarHostFalso()
  const auth = new FakeAuth(opcoes.codigo)
  if (opcoes.donoInicial !== undefined) auth.semearDono(opcoes.donoInicial)
  const comandos = new FakeComandos()
  let paradas = 0

  const nucleo = criarNucleo({
    log: log.logger,
    time,
    ipc: {
      send: (intent) => ipc.send(intent),
      pairingSuccess: (dono) => ipc.pairingSuccess(dono),
    },
    sender: sender.sender,
    limites: opcoes.limites ?? LIMITES_POR_OMISSAO,
    emitirNonce: opcoes.emitirNonce ?? host.emitirNonce,
    parar:
      opcoes.parar ??
      (async () => {
        paradas += 1
      }),
    auth,
    comandos: (ctx) => comandos.fabrica(ctx),
  })

  return {
    time,
    log,
    sender,
    ipc,
    host,
    auth,
    comandos,
    nucleo,
    paradas: () => paradas,
    tratar: (evento) => nucleo.tratarEvento(evento),
    registrarComandos: async (registos) => {
      // Devolve a funcao de publicacao que regista contra `registos`.
      const publicado = await registarComandosPublicados({
        setMyCommands: (o) => {
          registos.push(o.commands)
          return Promise.resolve(true)
        },
      })
      return publicado
    },
  }
}

export type { ActionRowLayout, ComandoPublicado, NucleoDeps }