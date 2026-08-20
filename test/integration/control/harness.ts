/**
 * ASSENTO do controlador + supervisor REAL (T5.1 contra T3.1).
 *
 * Ficheiro sem sufixo `.test.ts`: nao e executado como suite.
 *
 * Compoe o harness de T3.1 (`test/integration/proc/seat.ts` — processos REAIS
 * com o duble `fake-cloudflared.mjs`, relogio e agendador INJETADOS) com o
 * controlador de T5.1. O `cloudflared` verdadeiro nunca entra aqui (D10).
 *
 * O REPASSE do controlador usa o MESMO `FakeScheduler` do supervisor: os
 * testes disparam-no com `rodarRepasse()`. O warmup do supervisor (descoberta
 * da URL + readiness) corre com temporizadores REAIS contra o duble, pelo que
 * as promocoes a READY esperam `waitFor` real e so depois o repasse converge.
 */

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import { FakeScheduler } from '../../support/child-double.ts'
import { createConfirmService } from '../../../src/control/confirm.ts'
import {
  createTunnelController,
  type DifusaoEstado,
  type TunnelController,
} from '../../../src/control/controller.ts'
import { makeTunnelHarness, type TunnelHarness, type TunnelHarnessOptions } from '../proc/seat.ts'

export interface ControlHarness extends TunnelHarness {
  controlador: TunnelController
  /** Cada difusao de estado emitida pelo controlador, por ordem. */
  difusoes: DifusaoEstado[]
  /** Cada linha de auditoria emitida pelo controlador. */
  auditoria: AuditEvent[]
  /** Cada persistencia de intencao (`desiredState`). */
  intencoes: Array<'READY' | 'STOPPED'>
  emitirNonce(action: 'start' | 'reset'): string
  /** Dispara o repasse de reconciliacao (um tick do FakeScheduler). */
  rodarRepasse(): void
}

export async function makeControlHarness(options: TunnelHarnessOptions = {}): Promise<ControlHarness> {
  const base = await makeTunnelHarness(options)

  const difusoes: DifusaoEstado[] = []
  const auditoria: AuditEvent[] = []
  const intencoes: Array<'READY' | 'STOPPED'> = []
  // O repasse do controlador vive num agendador PROPRIO: o do supervisor esta
  // ocupado pelos temporizadores de reinicio/TTL, e `runLast` do FakeScheduler
  // dispara o ULTIMO agendado — misturar os dois faria o teste disparar o
  // reinicio do cloudflared em vez do repasse.
  const repasse = new FakeScheduler()

  const controlador = createTunnelController({
    // `base.logger` e um CALLABLE: a chamada devolve o objeto com os metodos.
    log: base.logger('controlador'),
    supervisor: base.supervisor,
    confirm: createConfirmService({ now: () => base.clock.now() }),
    agora: () => base.clock.now(),
    scheduler: repasse,
    restritoAtivo: () => false,
    segredoForte: () => true,
    requerConfirmacao: true,
    audit: { append: (evento) => auditoria.push(evento) },
    broadcast: (difusao) => difusoes.push(difusao),
    persistirIntencao: (alvo) => intencoes.push(alvo),
  })

  return {
    ...base,
    controlador,
    difusoes,
    auditoria,
    intencoes,
    emitirNonce: (action) => controlador.emitirNonce(action).valor,
    rodarRepasse: () => repasse.runLast(),
  }
}
