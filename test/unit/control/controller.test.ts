/**
 * `src/control/controller.ts` — a maquina de estados UNICA, contra um
 * supervisor DUBLE (o processo real entra em `test/integration/control/`).
 *
 * Presos aqui: a tabela de transicoes legais (CTL-001..015), a idempotencia
 * por `requestId` (CTL-020), o nonce (CTL-021..024), a reconciliacao com a
 * morte externa (CTL-025), a serializacao da fila (CTL-028) e o caso concreto
 * de 01-ARQUITETURA 9.3 (up do bot + down da UI a 5 ms). O relogio e o
 * agendador sao INJETADOS (04-TESTES.md 8.1) — nenhum cronometro real.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import type { ControlIntent } from '../../../src/contracts/control.ts'
import type { TunnelSnapshot } from '../../../src/contracts/tunnel.ts'
import { createConfirmService } from '../../../src/control/confirm.ts'
import {
  createTunnelController,
  type ControladorDeps,
  type DifusaoEstado,
  type TunnelController,
} from '../../../src/control/controller.ts'
import type { GuardLogger } from '../../../src/logging/logger.ts'
import type { TunnelSupervisor } from '../../../src/tunnel/supervisor.ts'
import { FakeScheduler } from '../../support/child-double.ts'
import { flush } from '../../support/fixtures.ts'
import { FakeClock } from '../../support/clock.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'

/* ========================================================================= */
/* Duble do supervisor: o teste controla o snapshot (a "verdade do processo") */
/* ========================================================================= */

class FakeSupervisor implements TunnelSupervisor {
  snapshotAtual: TunnelSnapshot = { state: 'STOPPED', attempts: 0 }
  startCalls = 0
  stopCalls = 0
  disposed = false
  /** `'imediato-starting'`: start resolve logo com STARTING; `'manual'`: espera o teste. */
  modoStart: 'imediato-starting' | 'imediato-failed' | 'manual' = 'imediato-starting'
  private pendentes: Array<(snap: TunnelSnapshot) => void> = []

  start(): Promise<TunnelSnapshot> {
    this.startCalls += 1
    if (this.modoStart === 'manual') {
      return new Promise((resolve) => {
        this.pendentes.push(resolve)
      })
    }
    const snap: TunnelSnapshot =
      this.modoStart === 'imediato-failed'
        ? {
            state: 'FAILED',
            failure: { code: 'PROBE_FAILED', message: 'o gate nao esta armado', retryable: false, probe: 'spa-fallback' },
            attempts: 0,
          }
        : { state: 'STARTING', attempts: 0 }
    this.snapshotAtual = snap
    return Promise.resolve(snap)
  }

  resolverStartCom(snap: TunnelSnapshot): void {
    const resolver = this.pendentes.shift()
    if (resolver === undefined) throw new Error('nenhum start pendente no duble')
    this.snapshotAtual = snap
    resolver(snap)
  }

  stop(): void {
    this.stopCalls += 1
    this.snapshotAtual = { state: 'STOPPED', attempts: this.snapshotAtual.attempts }
  }

  dispose(): void {
    this.disposed = true
    this.snapshotAtual = { state: 'STOPPED', attempts: 0 }
  }

  snapshot(): TunnelSnapshot {
    return this.snapshotAtual
  }

  /** O teste simula a morte externa / a promocao: muda o snapshot do processo. */
  definirObservado(snap: TunnelSnapshot): void {
    this.snapshotAtual = snap
  }
}

/* ========================================================================= */
/* Bancada                                                                   */
/* ========================================================================= */

const URL_READY = 'https://x-do-duble.trycloudflare.com'

function snapReady(): TunnelSnapshot {
  return {
    state: 'READY',
    info: { url: URL_READY, startedAt: 1_000, mode: 'quick' },
    attempts: 0,
    expiresAt: 5_000,
  }
}

let sequencia = 0
function intent(overrides: Partial<ControlIntent> = {}): ControlIntent {
  sequencia += 1
  return {
    action: 'start',
    requestedBy: 'telegram:123',
    requestId: `req-${String(sequencia).padStart(4, '0')}`,
    at: 1_000,
    ...overrides,
  }
}

interface Bancada {
  controlador: TunnelController
  supervisor: FakeSupervisor
  scheduler: FakeScheduler
  clock: FakeClock
  difusoes: DifusaoEstado[]
  auditoria: AuditEvent[]
  intencoes: Array<'READY' | 'STOPPED'>
  log: GuardLogger
}

function fazerBancada(overrides: Partial<ControladorDeps> = {}): Bancada {
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler()
  // O supervisor EFETIVO e o que a bancada devolve: um override nao pode
  // deixar o teste a mexer numa instancia que o controlador nao usa.
  // O teste so sobrepoe o supervisor com um FakeSupervisor (o contrato da
  // bancada e o duble; o processo real entra na integracao).
  const supervisor = (overrides.supervisor ?? new FakeSupervisor()) as FakeSupervisor
  const difusoes: DifusaoEstado[] = []
  const auditoria: AuditEvent[] = []
  const intencoes: Array<'READY' | 'STOPPED'> = []
  // `createFakeLogger()` e um CALLABLE: os metodos `info/warn/error/debug`
  // vivem no objeto que a chamada devolve — e esse que e um `GuardLogger`.
  const log = createFakeLogger()('ctl')

  const controlador = createTunnelController({
    log,
    supervisor,
    confirm: createConfirmService({
      now: () => clock.now(),
      randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    }),
    agora: () => clock.now(),
    scheduler,
    restritoAtivo: () => false,
    segredoForte: () => true,
    requerConfirmacao: true,
    audit: { append: (evento) => auditoria.push(evento) },
    broadcast: (difusao) => difusoes.push(difusao),
    persistirIntencao: (alvo) => intencoes.push(alvo),
    ...overrides,
  })

  return { controlador, supervisor, scheduler, clock, difusoes, auditoria, intencoes, log }
}

/** Dispara o repasse de reconciliacao agendado (um tick do FakeScheduler). */
function rodarRepasse(h: Bancada): void {
  h.scheduler.runLast()
}

/** Sobe o tunel ate READY, passando pelo repasse, e devolve os factos. */
async function subirAteReady(h: Bancada): Promise<void> {
  const nonce = h.controlador.emitirNonce('start')
  const r = await h.controlador.despachar(intent({ nonce: nonce.valor }))
  assert.equal(r.estado, 'STARTING')
  h.supervisor.definirObservado(snapReady())
  rodarRepasse(h)
  assert.equal(h.controlador.snapshot().state, 'READY')
}

/* ========================================================================= */
/* A tabela de transicoes (CTL-001..015)                                      */
/* ========================================================================= */

describe('CTL-001: STOPPED + start -> STARTING, com seq++', () => {
  it('o spawn acontece uma vez e o seq avanca', async () => {
    const h = fazerBancada()
    const nonce = h.controlador.emitirNonce('start')

    const resultado = await h.controlador.despachar(intent({ nonce: nonce.valor }))

    assert.equal(resultado.estado, 'STARTING')
    assert.equal(resultado.idempotente, false)
    assert.equal(h.supervisor.startCalls, 1)
    assert.deepEqual(h.difusoes.map((d) => d.estado), ['STARTING'])
    assert.equal(h.difusoes[0]?.seq, 1)
    assert.equal(h.controlador.snapshot().seq, 1)
    assert.deepEqual(h.intencoes, ['READY'], 'a intencao persistida segue o start')
  })
})

describe('CTL-002: STARTING + start -> STARTING, seq inalterado', () => {
  it('um segundo start nao spawna e nao avanca o seq', async () => {
    const h = fazerBancada()
    const primeiro = h.controlador.emitirNonce('start')
    await h.controlador.despachar(intent({ nonce: primeiro.valor }))

    const segundo = h.controlador.emitirNonce('start')
    const resultado = await h.controlador.despachar(intent({ nonce: segundo.valor }))

    assert.equal(resultado.estado, 'STARTING')
    assert.equal(h.supervisor.startCalls, 1, 'nunca nasce um segundo cloudflared')
    assert.equal(h.controlador.snapshot().seq, 1, 'seq inalterado')
  })
})

describe('CTL-003: READY + start -> READY, resposta repete a URL vigente', () => {
  it('o no-op devolve a URL sem transicionar', async () => {
    const h = fazerBancada()
    await subirAteReady(h)
    const seqAntes = h.controlador.snapshot().seq

    const nonce = h.controlador.emitirNonce('start')
    const resultado = await h.controlador.despachar(intent({ nonce: nonce.valor }))

    assert.equal(resultado.estado, 'READY')
    assert.equal(resultado.url, URL_READY)
    assert.equal(h.controlador.snapshot().seq, seqAntes, 'seq inalterado')
    assert.equal(h.supervisor.startCalls, 1)
  })
})

describe('CTL-004: STOPPED + stop -> noop', () => {
  it('nada e derrubado e o seq nao avanca', async () => {
    const h = fazerBancada()

    const resultado = await h.controlador.despachar(intent({ action: 'stop' }))

    assert.equal(resultado.estado, 'STOPPED')
    assert.equal(h.supervisor.stopCalls, 0)
    assert.equal(h.controlador.snapshot().seq, 0)
  })
})

describe('CTL-005/006: stop durante STARTING/READY -> STOPPING', () => {
  it('STARTING + stop: a paragem cancela o warmup em curso', async () => {
    const h = fazerBancada()
    const nonce = h.controlador.emitirNonce('start')
    await h.controlador.despachar(intent({ nonce: nonce.valor }))

    const resultado = await h.controlador.despachar(intent({ action: 'stop' }))

    assert.equal(resultado.estado, 'STOPPING')
    assert.equal(h.supervisor.stopCalls, 1)
    assert.equal(h.controlador.snapshot().seq, 2)
  })

  it('READY + stop: STOPPING; o repasse confirma STOPPED', async () => {
    const h = fazerBancada()
    await subirAteReady(h)

    const resultado = await h.controlador.despachar(intent({ action: 'stop' }))
    assert.equal(resultado.estado, 'STOPPING')

    rodarRepasse(h)
    assert.equal(h.controlador.snapshot().state, 'STOPPED')
    assert.deepEqual(h.intencoes.at(-1), 'STOPPED', 'a intencao persistida segue a paragem')
  })
})

describe('CTL-007: STOPPING + start -> rejeitado SHUTDOWN_IN_PROGRESS, sem fila', () => {
  it('a rejeicao e imediata, o seq nao muda e nenhum spawn acontece depois', async () => {
    const h = fazerBancada()
    const nonce = h.controlador.emitirNonce('start')
    await h.controlador.despachar(intent({ nonce: nonce.valor }))
    await h.controlador.despachar(intent({ action: 'stop' }))
    assert.equal(h.controlador.snapshot().state, 'STOPPING')
    const seqAntes = h.controlador.snapshot().seq

    const resultado = await h.controlador.despachar(intent({ nonce: h.controlador.emitirNonce('start').valor }))

    assert.equal(resultado.recusa, 'SHUTDOWN_IN_PROGRESS')
    assert.equal(resultado.estado, 'STOPPING')
    assert.equal(h.controlador.snapshot().seq, seqAntes, 'seq inalterado')
    assert.equal(h.supervisor.startCalls, 1, 'nenhum spawn a mais')

    // A paragem conclui e o start REJEITADO nao e reconciliado depois (D29).
    rodarRepasse(h)
    assert.equal(h.controlador.snapshot().state, 'STOPPED')
    assert.equal(h.supervisor.startCalls, 1, 'nenhuma reconciliacao pos-paragem')
  })
})

describe('CTL-008: DEGRADED + orcamento esgotado -> FAILED (terminal)', () => {
  it('a morte externa converge para DEGRADED e o fim do orcamento para FAILED', async () => {
    const h = fazerBancada()
    await subirAteReady(h)

    h.supervisor.definirObservado({ state: 'DEGRADED', failure: { code: 'PROCESS_EXITED', message: 'caiu', retryable: true }, attempts: 3 })
    rodarRepasse(h)
    assert.equal(h.controlador.snapshot().state, 'DEGRADED')

    h.supervisor.definirObservado({
      state: 'FAILED',
      failure: { code: 'BUDGET_EXHAUSTED', message: 'orcamento esgotado', retryable: false },
      attempts: 4,
    })
    rodarRepasse(h)
    assert.equal(h.controlador.snapshot().state, 'FAILED')
    assert.equal(h.controlador.snapshot().failure?.code, 'BUDGET_EXHAUSTED')
  })
})

describe('CTL-009: start sem segredo forte -> recusado, spawn nao acontece', () => {
  it('recusa SEM_SEGREDO_FORTE sem tocar no supervisor', async () => {
    const h = fazerBancada({ segredoForte: () => false })
    const nonce = h.controlador.emitirNonce('start')

    const resultado = await h.controlador.despachar(intent({ nonce: nonce.valor }))

    assert.equal(resultado.recusa, 'SEM_SEGREDO_FORTE')
    assert.equal(h.supervisor.startCalls, 0, 'o spawn nao acontece (TENSAO-002)')
  })
})

describe('CTL-010: seq estritamente crescente', () => {
  it('toda sequencia de comandos avanca o seq sem nunca repetir', async () => {
    const h = fazerBancada()
    await subirAteReady(h) // STOPPED -> STARTING (1) -> READY (2)
    await h.controlador.despachar(intent({ action: 'stop' })) // -> STOPPING (3)
    rodarRepasse(h) // -> STOPPED (4)

    const nonce = h.controlador.emitirNonce('start')
    await h.controlador.despachar(intent({ nonce: nonce.valor })) // -> STARTING (5)
    h.supervisor.definirObservado(snapReady())
    rodarRepasse(h) // -> READY (6)

    const seqs = h.difusoes.map((d) => d.seq)
    for (let i = 1; i < seqs.length; i += 1) {
      assert.equal(seqs[i]! > seqs[i - 1]!, true, `seq ${String(seqs[i])} apos ${String(seqs[i - 1])}`)
    }
    assert.equal(h.controlador.snapshot().seq, 6)
  })
})

describe('CTL-011: FAILED + start -> recusado TERMINAL_SEM_RESET', () => {
  it('terminal e terminal: o start nem consome o nonce', async () => {
    const h = fazerBancada({ supervisor: new FakeSupervisor() })
    h.supervisor.modoStart = 'imediato-failed'
    const primeiro = h.controlador.emitirNonce('start')
    const falha = await h.controlador.despachar(intent({ nonce: primeiro.valor }))
    assert.equal(falha.estado, 'FAILED')

    const resultado = await h.controlador.despachar(intent({}))
    assert.equal(resultado.recusa, 'TERMINAL_SEM_RESET')
    assert.equal(h.supervisor.startCalls, 1, 'o sistema NAO se auto-cura em loop')
  })
})

describe('CTL-012: reset() humano em FAILED -> STOPPED', () => {
  it('reset e o UNICO caminho de saida do FAILED', async () => {
    const h = fazerBancada({ supervisor: new FakeSupervisor() })
    h.supervisor.modoStart = 'imediato-failed'
    await h.controlador.despachar(intent({ nonce: h.controlador.emitirNonce('start').valor }))
    assert.equal(h.controlador.snapshot().state, 'FAILED')

    const nonce = h.controlador.emitirNonce('reset')
    const resultado = await h.controlador.despachar(intent({ action: 'reset', nonce: nonce.valor }))

    assert.equal(resultado.estado, 'STOPPED')
    assert.equal(h.controlador.snapshot().seq, 2, 'FAILED -> STOPPED transiciona com seq novo')
    assert.equal(h.supervisor.stopCalls, 1, 'o supervisor e alinhado (registo limpo)')
  })

  it('reset sem nonce e recusado (NONCE_AUSENTE)', async () => {
    const h = fazerBancada({ supervisor: new FakeSupervisor() })
    h.supervisor.modoStart = 'imediato-failed'
    await h.controlador.despachar(intent({ nonce: h.controlador.emitirNonce('start').valor }))

    const resultado = await h.controlador.despachar(intent({ action: 'reset' }))
    assert.equal(resultado.recusa, 'NONCE_AUSENTE')
    assert.equal(h.controlador.snapshot().state, 'FAILED')
  })

  it('reset fora do FAILED e um no-op (nada a repor)', async () => {
    const h = fazerBancada()
    const resultado = await h.controlador.despachar(intent({ action: 'reset' }))
    assert.equal(resultado.estado, 'STOPPED')
    assert.equal(h.controlador.snapshot().seq, 0)
  })
})

describe('CTL-013: probe reprovado -> STOPPED -> FAILED sem passar por STARTING', () => {
  it('nenhuma difusao observa STARTING quando o probe reprova', async () => {
    const h = fazerBancada({ supervisor: new FakeSupervisor() })
    h.supervisor.modoStart = 'imediato-failed'

    const resultado = await h.controlador.despachar(intent({ nonce: h.controlador.emitirNonce('start').valor }))

    assert.equal(resultado.estado, 'FAILED')
    assert.equal(h.difusoes.some((d) => d.estado === 'STARTING'), false, 'CTL-013: sem STARTING')
    assert.deepEqual(h.difusoes.map((d) => d.estado), ['FAILED'])
  })
})

describe('CTL-014: TTL expirado em READY -> STOPPING -> STOPPED, intencao STOPPED', () => {
  it('a queda sem intent sintetiza a sequencia canonica', async () => {
    const h = fazerBancada()
    await subirAteReady(h)

    // O supervisor derrubou (TTL): o snapshot dele salta direto para STOPPED.
    h.supervisor.definirObservado({ state: 'STOPPED', attempts: 0 })
    rodarRepasse(h)

    const estados = h.difusoes.slice(-2).map((d) => d.estado)
    assert.deepEqual(estados, ['STOPPING', 'STOPPED'])
    assert.equal(h.controlador.snapshot().state, 'STOPPED')
    assert.deepEqual(h.intencoes.at(-1), 'STOPPED')
  })
})

describe('CTL-015: modo restrito + start -> recusado, nenhum spawn', () => {
  it('a recusa vale para QUALQUER superficie e o spawn nao acontece', async () => {
    const h = fazerBancada({ restritoAtivo: () => true })

    const resultado = await h.controlador.despachar(intent({ nonce: h.controlador.emitirNonce('start').valor }))

    assert.equal(resultado.recusa, 'MODO_RESTRITO')
    assert.equal(h.supervisor.startCalls, 0, 'nenhum spawn')
  })
})

describe('CTL-033/034: o start de boot NAO exige nonce (a intencao persistida ja foi confirmada)', () => {
  it('boot a partir de STOPPED com requerConfirmacao: true e SEM nonce spawna', async () => {
    const h = fazerBancada()

    const resultado = await h.controlador.despachar(intent({ requestedBy: 'boot' }))

    assert.equal(resultado.recusa, undefined, 'a origem boot nao pode ser recusada por nonce ausente')
    assert.equal(resultado.estado, 'STARTING')
    assert.equal(h.supervisor.startCalls, 1)
    assert.deepEqual(h.intencoes, ['READY'], 'a intencao persistida segue o start de boot')
  })

  it('boot em STARTING e no-op idempotente, sem consumir nonce nenhum', async () => {
    const h = fazerBancada()
    await h.controlador.despachar(intent({ requestedBy: 'boot' }))

    const segundo = await h.controlador.despachar(intent({ requestedBy: 'boot' }))

    assert.equal(segundo.estado, 'STARTING')
    assert.equal(segundo.recusa, undefined)
    assert.equal(h.supervisor.startCalls, 1, 'nunca nasce um segundo cloudflared')
  })

  it('boot NAO e o bypass do modo restrito (reinicar o DSH nao desarma o teto)', async () => {
    const h = fazerBancada({ restritoAtivo: () => true })

    const resultado = await h.controlador.despachar(intent({ requestedBy: 'boot' }))

    assert.equal(resultado.recusa, 'MODO_RESTRITO')
    assert.equal(h.supervisor.startCalls, 0, 'nenhum spawn')
  })

  it('boot NAO dispensa o segredo forte (pre-condicao da tabela, CTL-009)', async () => {
    const h = fazerBancada({ segredoForte: () => false })

    const resultado = await h.controlador.despachar(intent({ requestedBy: 'boot' }))

    assert.equal(resultado.recusa, 'SEM_SEGREDO_FORTE')
    assert.equal(h.supervisor.startCalls, 0, 'nenhum spawn')
  })

  it('a origem de superficie continua a exigir nonce com a mesma configuracao (CTL-023)', async () => {
    const h = fazerBancada()

    const resultado = await h.controlador.despachar(intent({ requestedBy: 'telegram:999' }))

    assert.equal(resultado.recusa, 'NONCE_AUSENTE')
    assert.equal(h.supervisor.startCalls, 0, 'o spawn nao acontece sem confirmacao de superficie')
  })
})

/* ========================================================================= */
/* Idempotencia e nonce                                                      */
/* ========================================================================= */

describe('CTL-020: requestId repetido devolve o resultado da primeira execucao', () => {
  it('nenhum segundo efeito colateral — nem o nonce e re-consumido', async () => {
    const h = fazerBancada()
    const reqId = 'req-repetido'
    const nonce = h.controlador.emitirNonce('start')
    const primeiro = await h.controlador.despachar(intent({ requestId: reqId, nonce: nonce.valor }))
    assert.equal(primeiro.estado, 'STARTING')

    const segundo = await h.controlador.despachar(intent({ requestId: reqId }))

    assert.equal(segundo.idempotente, true)
    assert.equal(segundo.estado, primeiro.estado)
    assert.equal(h.supervisor.startCalls, 1, 'o requestId repetido NUNCA re-executa')
  })
})

describe('CTL-021: nonce repetido e recusado mesmo com requestId novo', () => {
  it('o replay cai em NONCE_INVALIDO e nao spawna', async () => {
    const h = fazerBancada()
    const nonce = h.controlador.emitirNonce('start')
    await h.controlador.despachar(intent({ nonce: nonce.valor }))

    const replay = await h.controlador.despachar(intent({ nonce: nonce.valor }))

    assert.equal(replay.recusa, 'NONCE_INVALIDO')
    assert.equal(h.supervisor.startCalls, 1)
  })
})

describe('CTL-022: nonce expirado (TTL 60 s, relogio injetado)', () => {
  it('o relogio avancado recusa com NONCE_EXPIRADO e nada muda', async () => {
    const h = fazerBancada()
    const nonce = h.controlador.emitirNonce('start')

    h.clock.advance(60_001)
    const resultado = await h.controlador.despachar(intent({ nonce: nonce.valor }))

    assert.equal(resultado.recusa, 'NONCE_EXPIRADO')
    assert.equal(h.supervisor.startCalls, 0)
    assert.equal(h.controlador.snapshot().state, 'STOPPED')
  })
})

describe('CTL-023: /ligar sem confirmacao e recusado e o spawn nao acontece', () => {
  it('NONCE_AUSENTE cobre a ausencia do nonce', async () => {
    const h = fazerBancada()

    const resultado = await h.controlador.despachar(intent({ nonce: undefined }))

    assert.equal(resultado.recusa, 'NONCE_AUSENTE')
    assert.equal(h.supervisor.startCalls, 0)
  })
})

describe('CTL-024: stop nao exige nonce', () => {
  it('a acao que reduz exposicao funciona de primeira, em panico', async () => {
    const h = fazerBancada()
    await subirAteReady(h)

    const resultado = await h.controlador.despachar(intent({ action: 'stop', nonce: undefined }))

    assert.equal(resultado.estado, 'STOPPING')
    assert.equal(h.supervisor.stopCalls, 1)
  })
})

describe('CTL-025: morte externa converge — o estado nunca mente READY', () => {
  it('o cloudflared morto por fora derruba o READY em DEGRADED pelo repasse', async () => {
    const h = fazerBancada()
    await subirAteReady(h)

    h.supervisor.definirObservado({ state: 'DEGRADED', failure: { code: 'PROCESS_EXITED', message: 'caiu', retryable: true }, attempts: 1 })
    rodarRepasse(h)

    assert.equal(h.controlador.snapshot().state, 'DEGRADED', 'converge, nunca mente READY')
    assert.equal(h.controlador.snapshot().info, undefined, 'a URL so existe em READY')
  })
})

/* ========================================================================= */
/* Serializacao e a corrida de 9.3                                            */
/* ========================================================================= */

describe('01-ARQ 9.3: up do bot e down da UI a 5 ms, estado STOPPED', () => {
  it('o down serializa atras do up e e avaliado contra o STARTING que ele produz', async () => {
    const h = fazerBancada()
    h.supervisor.modoStart = 'manual'

    const up = h.controlador.despachar(intent({ nonce: h.controlador.emitirNonce('start').valor }))
    const down = h.controlador.despachar(intent({ action: 'stop' }))

    // A fila processa em microtask: o up so spawna depois de a cadeia correr.
    await flush()
    h.supervisor.resolverStartCom({ state: 'STARTING', attempts: 0 })

    const resultadoUp = await up
    assert.equal(resultadoUp.estado, 'STARTING')
    const resultadoDown = await down
    assert.equal(resultadoDown.estado, 'STOPPING', 'o down ve o STARTING, nunca o STOPPED')
    assert.equal(h.supervisor.stopCalls, 1)

    // Ambas as superficies convergem para STOPPED com seq 3.
    rodarRepasse(h)
    assert.equal(h.controlador.snapshot().state, 'STOPPED')
    assert.equal(h.controlador.snapshot().seq, 3)
    // A promocao tardia nao existe: o supervisor nunca foi READY.
    assert.equal(h.difusoes.some((d) => d.estado === 'READY'), false)
  })
})

describe('CTL-018: start simultaneo das duas superficies -> UM UNICO spawn', () => {
  it('a segunda intent e no-op idempotente sobre o estado que a primeira produziu', async () => {
    const h = fazerBancada()
    h.supervisor.modoStart = 'manual'

    const telegram = h.controlador.despachar(intent({ requestId: 'req-telegram', nonce: h.controlador.emitirNonce('start').valor }))
    const painel = h.controlador.despachar(intent({ requestId: 'req-painel', nonce: h.controlador.emitirNonce('start').valor }))

    await flush()
    h.supervisor.resolverStartCom({ state: 'STARTING', attempts: 0 })

    const r1 = await telegram
    const r2 = await painel
    assert.equal(r1.estado, 'STARTING')
    assert.equal(r2.estado, 'STARTING', 'a segunda intent nao transiciona')
    assert.equal(h.supervisor.startCalls, 1, 'UM UNICO spawn de cloudflared')
  })
})

describe('CTL-028: a fila e de um — nunca ha duas transicoes em voo', () => {
  it('um stop que chega durante o probe espera a vez e nao vira no-op', async () => {
    const h = fazerBancada()
    h.supervisor.modoStart = 'manual'

    const up = h.controlador.despachar(intent({ nonce: h.controlador.emitirNonce('start').valor }))
    const down = h.controlador.despachar(intent({ action: 'stop' }))
    // Um terceiro stop (a mesma intencao repetida) tambem serializa.
    const down2 = h.controlador.despachar(intent({ action: 'stop' }))

    await flush()
    h.supervisor.resolverStartCom({ state: 'STARTING', attempts: 0 })

    assert.equal((await up).estado, 'STARTING')
    assert.equal((await down).estado, 'STOPPING')
    assert.equal((await down2).estado, 'STOPPING', 'ja esta a parar: accepted sem nova transicao')
    assert.equal(h.supervisor.stopCalls, 1)
  })
})

describe('decidirSincrono: a decisao no proprio tick que o canal IPC exige', () => {
  it('start em STOPPING e recusado NA CHEGADA, sem fila (D29)', async () => {
    const h = fazerBancada()
    await subirAteReady(h)
    await h.controlador.despachar(intent({ action: 'stop' }))
    assert.equal(h.controlador.snapshot().state, 'STOPPING')

    const veredito = h.controlador.decidirSincrono(intent({ nonce: h.controlador.emitirNonce('start').valor }))
    assert.notEqual(veredito, null)
    assert.equal(veredito?.recusa, 'SHUTDOWN_IN_PROGRESS')
  })

  it('start em STOPPED devolve null (o probe corre na fila)', () => {
    const h = fazerBancada()
    const veredito = h.controlador.decidirSincrono(intent({ nonce: h.controlador.emitirNonce('start').valor }))
    assert.equal(veredito, null)
  })

  it('stop em READY e aplicado de forma sincrona', async () => {
    const h = fazerBancada()
    await subirAteReady(h)

    const veredito = h.controlador.decidirSincrono(intent({ action: 'stop' }))
    assert.notEqual(veredito, null)
    assert.equal(veredito?.estado, 'STOPPING')
    assert.equal(h.supervisor.stopCalls, 1)
    assert.equal(h.controlador.snapshot().seq, 3)
  })
})

describe('CTL-020: a janela de idempotencia regista TAMBEM no caminho sincrono', () => {
  it('requestId repetido em decidirSincrono devolve o resultado da primeira execucao, sem segundo efeito', async () => {
    const h = fazerBancada()
    await subirAteReady(h)
    const reqId = 'req-sync-repetido'

    const primeiro = h.controlador.decidirSincrono(intent({ action: 'stop', requestId: reqId }))
    assert.notEqual(primeiro, null)
    assert.equal(primeiro?.estado, 'STOPPING')
    assert.equal(h.supervisor.stopCalls, 1)

    const segundo = h.controlador.decidirSincrono(intent({ action: 'stop', requestId: reqId }))
    assert.notEqual(segundo, null)
    assert.equal(segundo?.idempotente, true, 'o repetido carrega a marcacao de idempotencia')
    // O `assert` anterior ja estreitou `segundo` para nao-nulo: sem `?.`.
    assert.equal(segundo.estado, 'STOPPING')
    assert.equal(h.supervisor.stopCalls, 1, 'nenhum segundo efeito colateral no caminho sincrono')
    assert.equal(h.auditoria.filter((e) => e.evento === 'tunel_desligar:telegram:123').length, 1, 'a repeticao nao re-audita')
  })

  it('a rejeicao sincrona D29 (SHUTDOWN_IN_PROGRESS) tambem fica na janela', async () => {
    const h = fazerBancada()
    await subirAteReady(h)
    await h.controlador.despachar(intent({ action: 'stop' }))
    assert.equal(h.controlador.snapshot().state, 'STOPPING')
    const reqId = 'req-d29-repetido'

    const primeiro = h.controlador.decidirSincrono(intent({ requestId: reqId }))
    assert.equal(primeiro?.recusa, 'SHUTDOWN_IN_PROGRESS')
    // Uma linha de `tunel_ligar` da subida original + uma da rejeicao D29.
    const linhas = h.auditoria.filter((e) => e.evento === 'tunel_ligar:telegram:123').length

    const segundo = h.controlador.decidirSincrono(intent({ requestId: reqId }))
    assert.equal(segundo?.idempotente, true)
    // O `assert` anterior ja estreitou `segundo` para nao-nulo: sem `?.`.
    assert.equal(segundo.recusa, 'SHUTDOWN_IN_PROGRESS')
    assert.equal(
      h.auditoria.filter((e) => e.evento === 'tunel_ligar:telegram:123').length,
      linhas,
      'a rejeicao repetida devolve o primeiro resultado sem re-auditar',
    )
  })

  it('a repeticao por despachar de um requestId ja decidido em sincrono devolve idempotente', async () => {
    const h = fazerBancada()
    await subirAteReady(h)
    const reqId = 'req-cruzado'

    const primeiro = h.controlador.decidirSincrono(intent({ action: 'stop', requestId: reqId }))
    assert.equal(primeiro?.estado, 'STOPPING')

    const segundo = await h.controlador.despachar(intent({ action: 'stop', requestId: reqId }))
    assert.equal(segundo.idempotente, true)
    assert.equal(segundo.estado, 'STOPPING')
    assert.equal(h.supervisor.stopCalls, 1, 'a execucao nao se repete entre caminhos')
  })
})

describe('origem no audit (CTL-031) e ciclo de vida', () => {
  it('toda acao auditada carrega a origem pre-formatada da superficie', async () => {
    const h = fazerBancada()
    const nonce = h.controlador.emitirNonce('start')
    await h.controlador.despachar(intent({ requestedBy: 'panel:abc123', nonce: nonce.valor }))
    await h.controlador.despachar(intent({ action: 'stop', requestedBy: 'telegram:987' }))

    const eventos = h.auditoria.map((e) => e.evento)
    assert.equal(eventos.includes('tunel_ligar:panel:abc123'), true)
    assert.equal(eventos.includes('tunel_desligar:telegram:987'), true)
    assert.equal(eventos.some((e) => e.includes('anonimo') || e.endsWith(':')), false, 'nenhuma transicao anonima')
  })

  it('dispose e sincrono, idempotente, desarma o repasse e derruba o supervisor', async () => {
    const h = fazerBancada()
    await subirAteReady(h)
    assert.equal(h.scheduler.pending.length, 1, 'o repasse esta armado em READY')

    const resultado: unknown = h.controlador.dispose()
    h.controlador.dispose()

    assert.equal(resultado, undefined, 'Q-2: disposer sincrono')
    assert.equal(h.supervisor.disposed, true)
    assert.equal(h.scheduler.pending.length, 0, 'nenhum temporizador vivo apos o dispose')
  })
})
