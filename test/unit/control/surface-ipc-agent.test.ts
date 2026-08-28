/**
 * `src/control/surface-ipc.ts` — as TRES intencoes de AGENTE (EMENDA
 * ONDA-4-AGENTS-HOST), no corte do transportador.
 *
 * Preso aqui: a semantica de controlo do contrato —
 *
 *   - `agent.dispatch` AUMENTA exposicao (execucao de codigo no host) ->
 *     EXIGE nonce de 2 etapas: sem nonce (ou nonce invalido/expirado) o
 *     dispatch e `rejected NONCE_INVALID` e o registry NUNCA e consultado;
 *     com nonce valido, o registry recebe a skill/prompt/origem e o ack e
 *     `accepted`;
 *   - a recusa de POLITICA do registry (allowlist/teto/harness) vira um
 *     `error` com mensagem ACCIONAVEL (o vocabulario fechado de codigos nao
 *     tem "skill nao autorizada" — a mensagem e o texto que o worker mostra);
 *   - `agent.status` (leitura pura, sem nonce) difunde `agent.report` e
 *     responde `noop`; sem registry fiado, INTERNAL;
 *   - `agent.cancel` REDUZ -> dispensa nonce: id conhecido = `accepted`,
 *     desconhecido = `noop` idempotente; sem registry fiado, INTERNAL.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import type { IpcIntentMessage, IpcMessageToWorker } from '../../../src/contracts/ipc.ts'
import { createConfirmService } from '../../../src/control/confirm.ts'
import { criarRespondedorIpc } from '../../../src/control/surface-ipc.ts'
import type { AgentRegistry } from '../../../src/agents/registry.ts'
import { FakeClock } from '../../support/clock.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'

/* ========================================================================== */
/* Registry FALSO: o comportamento real (allowlist/teto/dispose) vive em       */
/* test/unit/agents/registry.test.ts — aqui so a FORMA que a superficie usa.   */
/* ========================================================================== */

interface RegistryFake extends AgentRegistry {
  despachos: Array<{ skill: string; prompt: string; origem: string }>
  vereditoDoDespacho: ReturnType<AgentRegistry['despachar']>
  cancelamentos: Array<{ agentId: string; origem: string }>
  vereditoDoCancelamento: boolean
  relatoriosChamados: { contagem: number }
}

function registryFake(opcoes: {
  vereditoDoDespacho?: ReturnType<AgentRegistry['despachar']>
  vereditoDoCancelamento?: boolean
} = {}): RegistryFake {
  const despachos: RegistryFake['despachos'] = []
  const cancelamentos: RegistryFake['cancelamentos'] = []
  const relatoriosChamados: { contagem: number } = { contagem: 0 }
  return {
    despachos,
    cancelamentos,
    relatoriosChamados,
    vereditoDoDespacho: opcoes.vereditoDoDespacho ?? { ok: true },
    vereditoDoCancelamento: opcoes.vereditoDoCancelamento ?? true,
    despachar(pedido) {
      despachos.push(pedido)
      return this.vereditoDoDespacho
    },
    estado: () => [],
    cancelar(agentId, origem) {
      cancelamentos.push({ agentId, origem })
      return this.vereditoDoCancelamento
    },
    dispose: (): void => {},
  }
}

interface Bancada {
  responder: ReturnType<typeof criarRespondedorIpc>
  auditoria: AuditEvent[]
  relatorios: { contagem: number }
  registry: RegistryFake
  emitirNonceReset(): string
}

function fazerBancada(opcoes: {
  registry?: RegistryFake | undefined
  confirm?: ReturnType<typeof createConfirmService> | undefined
} = {}): Bancada {
  const clock = new FakeClock(1_000)
  const auditoria: AuditEvent[] = []
  const relatorios: { contagem: number } = { contagem: 0 }
  const registry = opcoes.registry ?? registryFake()
  const confirm = opcoes.confirm ?? createConfirmService({ now: () => clock.now() })

  const responder = criarRespondedorIpc({
    controller: undefined, // modo loopback: o tunel nao participa das intents de agente
    modoTunel: false,
    pareado: () => true,
    audit: { append: (evento) => auditoria.push(evento) },
    log: createFakeLogger()('ctl'),
    agora: () => clock.now(),
    reemitirEstado: (): void => {},
    aposEmergencia: (): void => {},
    confirm,
    agentes: registry,
    relatorioDeAgentes: (): void => {
      relatorios.contagem += 1
    },
  })

  return {
    responder,
    auditoria,
    relatorios,
    registry,
    emitirNonceReset: (): string => confirm.issue('reset').valor,
  }
}

function intent(overrides: Partial<IpcIntentMessage> = {}): IpcIntentMessage {
  return {
    v: 2,
    type: 'intent',
    intent: 'agent.dispatch',
    requestId: 'req-agente',
    from: '123',
    chat: '456',
    ...overrides,
  }
}

const ACK = (resposta: IpcMessageToWorker): { result: string; code?: string | undefined } =>
  resposta.type === 'ack'
    ? resposta.code === undefined
      ? { result: resposta.result }
      : { result: resposta.result, code: resposta.code }
    : { result: `!${resposta.type}` }

/** Estreita a resposta para o ramo `error`, lancando se nao for um. */
function comoErro(resposta: IpcMessageToWorker): Extract<IpcMessageToWorker, { type: 'error' }> {
  assert.equal(resposta.type, 'error')
  return resposta as Extract<IpcMessageToWorker, { type: 'error' }>
}

/* ========================================================================== */
/* agent.dispatch — AUMENTA exposicao: nonce OBRIGATORIO (2 etapas)           */
/* ========================================================================== */

describe('agent.dispatch', () => {
  it('SEM nonce: rejected NONCE_INVALID e o registry NUNCA e consultado', () => {
    const h = fazerBancada()

    const resposta = h.responder(intent({ params: { skill: 'deep-orchestrator-agent-skill', prompt: 'dispara' } }))

    assert.deepEqual(ACK(resposta), { result: 'rejected', code: 'NONCE_INVALID' })
    assert.equal(h.registry.despachos.length, 0, 'sem confirmacao nao ha dispatch')
  })

  it('com nonce VALIDO: accepted e o registry recebe skill/prompt/origem', () => {
    const h = fazerBancada()

    const resposta = h.responder(
      intent({
        nonce: h.emitirNonceReset(),
        params: { skill: 'deep-orchestrator-agent-skill', prompt: 'dispara agora' },
      }),
    )

    assert.deepEqual(ACK(resposta), { result: 'accepted' })
    assert.equal(h.registry.despachos.length, 1)
    assert.deepEqual(h.registry.despachos[0], {
      skill: 'deep-orchestrator-agent-skill',
      prompt: 'dispara agora',
      origem: 'telegram:123',
    })
  })

  it('nonce REPETIDO (ja consumido): rejected NONCE_INVALID (uso unico, CTL-021)', () => {
    const h = fazerBancada()
    const nonce = h.emitirNonceReset()
    h.responder(intent({ nonce, params: { skill: 's', prompt: 'p' } }))

    const resposta = h.responder(intent({ nonce, params: { skill: 's', prompt: 'p' } }))

    assert.deepEqual(ACK(resposta), { result: 'rejected', code: 'NONCE_INVALID' })
    assert.equal(h.registry.despachos.length, 1, 'o segundo dispatch nao passou')
  })

  it('recusa de POLITICA do registry vira error com a mensagem accionavel (allowlist)', () => {
    const h = fazerBancada({ registry: registryFake({ vereditoDoDespacho: { ok: false, motivo: 'skill-nao-permitida' } }) })

    const resposta = h.responder(intent({ nonce: h.emitirNonceReset(), params: { skill: 'x', prompt: 'p' } }))

    const erro = comoErro(resposta)
    assert.ok(erro.message.includes('nao esta autorizada'), erro.message)
    assert.equal(erro.requestId, 'req-agente', 'o erro correlaciona pelo requestId')
  })

  it('recusa por TETO vira error com a mensagem de espera/cancelamento', () => {
    const h = fazerBancada({ registry: registryFake({ vereditoDoDespacho: { ok: false, motivo: 'teto-atingido' } }) })

    const resposta = h.responder(intent({ nonce: h.emitirNonceReset(), params: { skill: 'x', prompt: 'p' } }))

    const erro = comoErro(resposta)
    assert.ok(erro.message.includes('maxRuns'))
  })

  it('recusa por HARNESS indisponivel vira error INTERNAL', () => {
    const h = fazerBancada({ registry: registryFake({ vereditoDoDespacho: { ok: false, motivo: 'harness-indisponivel' } }) })

    const resposta = h.responder(intent({ nonce: h.emitirNonceReset(), params: { skill: 'x', prompt: 'p' } }))

    const erro = comoErro(resposta)
    assert.equal(erro.code, 'INTERNAL')
  })

  it('SEM registry fiado: error INTERNAL fail-closed, mesmo com nonce valido', () => {
    const clock = new FakeClock(1_000)
    const confirm = createConfirmService({ now: () => clock.now() })
    const responder = criarRespondedorIpc({
      controller: undefined,
      modoTunel: false,
      pareado: () => true,
      audit: { append: (): void => {} },
      log: createFakeLogger()('ctl'),
      agora: () => clock.now(),
      reemitirEstado: (): void => {},
      aposEmergencia: (): void => {},
      confirm,
    })

    const resposta = responder(intent({ nonce: confirm.issue('reset').valor, params: { skill: 's', prompt: 'p' } }))

    const erro = comoErro(resposta)
    assert.equal(erro.code, 'INTERNAL')
  })

  it('a origem do audit da recusa de identidade e a mesma dos tunel intents (S6)', () => {
    // O fluxo S6 (NOT_PAIRED) e dos intents de agente tambem: a identidade e
    // verificada ANTES do switch. Com pareado=false, nenhuma intent de agente
    // chega ao registry.
    const clock = new FakeClock(1_000)
    const confirm = createConfirmService({ now: () => clock.now() })
    const auditoria: AuditEvent[] = []
    const registry = registryFake()
    const responder = criarRespondedorIpc({
      controller: undefined,
      modoTunel: false,
      pareado: () => false,
      audit: { append: (evento) => auditoria.push(evento) },
      log: createFakeLogger()('ctl'),
      agora: () => clock.now(),
      reemitirEstado: (): void => {},
      aposEmergencia: (): void => {},
      confirm,
      agentes: registry,
    })

    const resposta = responder(intent({ nonce: confirm.issue('reset').valor, params: { skill: 's', prompt: 'p' } }))

    const erro = comoErro(resposta)
    assert.equal(erro.code, 'NOT_PAIRED')
    assert.equal(registry.despachos.length, 0)
    assert.equal(
      auditoria.some((e) => e.evento === 'tunel_intent_nao_pareado:telegram:123' && e.resultado === 'negado'),
      true,
    )
  })
})

/* ========================================================================== */
/* agent.status — leitura pura, sem nonce                                      */
/* ========================================================================== */

describe('agent.status', () => {
  it('responde noop e DIFUNDE o relatorio (a lista chega por agent.report)', () => {
    const h = fazerBancada()

    const resposta = h.responder(intent({ intent: 'agent.status' }))

    assert.deepEqual(ACK(resposta), { result: 'noop' })
    assert.equal(h.relatorios.contagem, 1, 'o relatorio foi difundido')
  })

  it('sem registry fiado: error INTERNAL fail-closed', () => {
    const clock = new FakeClock(1_000)
    const responder = criarRespondedorIpc({
      controller: undefined,
      modoTunel: false,
      pareado: () => true,
      audit: { append: (): void => {} },
      log: createFakeLogger()('ctl'),
      agora: () => clock.now(),
      reemitirEstado: (): void => {},
      aposEmergencia: (): void => {},
    })

    const resposta = responder(intent({ intent: 'agent.status' }))

    const erro = comoErro(resposta)
    assert.equal(erro.code, 'INTERNAL')
  })
})

/* ========================================================================== */
/* agent.cancel — REDUZ: dispensa nonce (CTL-024)                              */
/* ========================================================================== */

describe('agent.cancel', () => {
  it('id conhecido: accepted, sem nonce, e o registry recebe o agentId', () => {
    const h = fazerBancada()

    const resposta = h.responder(intent({ intent: 'agent.cancel', params: { agentId: 'ABCD1234' } }))

    assert.deepEqual(ACK(resposta), { result: 'accepted' })
    assert.deepEqual(h.registry.cancelamentos, [{ agentId: 'ABCD1234', origem: 'telegram:123' }])
  })

  it('id desconhecido: noop idempotente (nao ha o que cancelar)', () => {
    const h = fazerBancada({ registry: registryFake({ vereditoDoCancelamento: false }) })

    const resposta = h.responder(intent({ intent: 'agent.cancel', params: { agentId: 'ZZZZ9999' } }))

    assert.deepEqual(ACK(resposta), { result: 'noop' })
  })

  it('sem registry fiado: error INTERNAL fail-closed', () => {
    const clock = new FakeClock(1_000)
    const responder = criarRespondedorIpc({
      controller: undefined,
      modoTunel: false,
      pareado: () => true,
      audit: { append: (): void => {} },
      log: createFakeLogger()('ctl'),
      agora: () => clock.now(),
      reemitirEstado: (): void => {},
      aposEmergencia: (): void => {},
    })

    const resposta = responder(intent({ intent: 'agent.cancel', params: { agentId: 'ABCD1234' } }))

    const erro = comoErro(resposta)
    assert.equal(erro.code, 'INTERNAL')
  })
})
