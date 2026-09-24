/**
 * `src/agents/metrics.ts` — as metricas REAIS por tarefa (ZERO inventada).
 *
 * Preso aqui, com o harness em DUBLE:
 *
 *   - `dobrarUsageDosEventos`: o `TokenUsage` que viaja NO EVENTO
 *     `assistant/message` (NUNCA num resultado de subagente) somado campo a
 *     campo, presente SO quando reportado (ausente = omitido, nunca 0 falso);
 *   - `metricasDasEstatisticas`: a projecao `sessionStats` do harness mapeada
 *     1:1 para `AgentRunMetrics`;
 *   - `daSessao`: a leitura sincrona do report — sessao ausente/ilegivel =
 *     `undefined` (o `metrics` do report fica OMITIDO) e NUNCA lanca.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assistenteDeEvento,
  criarColetorDeMetricas,
  dobrarUsageDosEventos,
  metricasDasEstatisticas,
} from '../../../src/agents/metrics.ts'
import type {
  HarnessSession,
  HarnessSessionEvent,
  HarnessSessionProjections,
  HarnessSessionsService,
  HarnessSessionStatsProjection,
} from '../../../src/agents/harness.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'

/** Um evento `assistant/message` com usage (a unica fonte de tokens). */
function comUsage(usage: Record<string, unknown>): HarnessSessionEvent {
  return { type: 'assistant/message', data: { turn: 1, step: 1, usage } }
}

/* ========================================================================== */
/* O narrowing e a dobragem do usage                                          */
/* ========================================================================== */

describe('assistenteDeEvento — o narrowing obrigarorio do `data: unknown`', () => {
  it('so reconhece `assistant/message` com forma de objeto', () => {
    assert.deepEqual(assistenteDeEvento(comUsage({ inputTokens: 1 })), {
      turn: 1,
      step: 1,
      usage: { inputTokens: 1 },
    })
    assert.equal(assistenteDeEvento({ type: 'user/message', data: { turn: 1 } }), undefined)
    assert.equal(assistenteDeEvento({ type: 'assistant/message', data: null }), undefined)
    assert.equal(assistenteDeEvento({ type: 'assistant/message', data: 'torta' }), undefined)
  })
})

describe('dobrarUsageDosEventos — somas reais, presenca honesta', () => {
  it('soma os campos reportados e OMITE os nunca reportados', () => {
    const uso = dobrarUsageDosEventos([
      comUsage({ inputTokens: 10, outputTokens: 5 }),
      comUsage({ inputTokens: 2, outputTokens: 1, cacheReadTokens: 7 }),
      { type: 'turn/end', data: {} },
    ])

    assert.deepEqual(uso, { inputTokens: 12, outputTokens: 6, cacheReadTokens: 7 })
    assert.equal('cacheWriteTokens' in uso, false, 'nunca reportado = OMITIDO, nunca 0')
  })

  it('sem usage nenhum, devolve vazio (sem zeros fabricados)', () => {
    assert.deepEqual(dobrarUsageDosEventos([
      { type: 'assistant/message', data: { turn: 1, step: 1 } },
      { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [] } } },
    ]), {})
  })

  it('valores tortos (negativos/nao-finitos/nao-numeros) nao contam', () => {
    const uso = dobrarUsageDosEventos([
      comUsage({ inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: '7', cacheWriteTokens: 3 }),
      comUsage({ inputTokens: 4, outputTokens: 2 }),
    ])
    assert.deepEqual(uso, { inputTokens: 4, outputTokens: 2, cacheWriteTokens: 3 })
  })
})

describe('metricasDasEstatisticas — espelho 1:1 de SessionStatsProjection', () => {
  const stats: HarnessSessionStatsProjection = {
    turns: 2,
    steps: 5,
    llmMs: 100,
    toolMs: 40,
    ttftMs: 30,
    ttftSteps: 4,
    decodeMs: 70,
    decodeTokens: 99,
  }

  it('projeta os 8 campos tal e qual', () => {
    assert.deepEqual(metricasDasEstatisticas(stats), stats)
  })

  it('projecao ausente = objeto vazio (o campo `metrics` fica omitido)', () => {
    assert.deepEqual(metricasDasEstatisticas(undefined), {})
  })

  it('um campo torto e omitido sem derrubar os restantes', () => {
    const torto = { ...stats, llmMs: Number.NaN, toolMs: -1 }
    const saida = metricasDasEstatisticas(torto)
    assert.equal('llmMs' in saida, false)
    assert.equal('toolMs' in saida, false)
    assert.equal(saida.turns, 2)
  })
})

/* ========================================================================== */
/* o coletor (a leitura do report)                                            */
/* ========================================================================== */

interface Bancada {
  coletor: ReturnType<typeof criarColetorDeMetricas>
  sessao: HarnessSession
  eventos: HarnessSessionEvent[]
  stats: HarnessSessionStatsProjection | undefined
  getQueLanca: boolean
}

function fazerBancada(opcoes: { semSessoes?: boolean; semProjecoes?: boolean } = {}): Bancada {
  const estado: { eventos: HarnessSessionEvent[]; stats: HarnessSessionStatsProjection | undefined; getQueLanca: boolean } = {
    eventos: [],
    stats: undefined,
    getQueLanca: false,
  }
  const sessao: HarnessSession = {
    id: 'session-1',
    snapshotEvents: () => estado.eventos,
  }
  const sessoes: HarnessSessionsService = {
    create: () => sessao,
    get() {
      if (estado.getQueLanca) throw new Error('store em chamas')
      return sessao
    },
  }
  const projecoes: HarnessSessionProjections = {
    stateOf: () => estado.stats,
  }
  const log = createFakeLogger()
  const coletor = criarColetorDeMetricas({
    sessoes: () => (opcoes.semSessoes === true ? undefined : sessoes),
    projecoes: () => (opcoes.semProjecoes === true ? undefined : projecoes),
    log: log('metricas'),
  })
  return {
    coletor,
    sessao,
    get eventos() {
      return estado.eventos
    },
    set eventos(v) {
      estado.eventos = v
    },
    get stats() {
      return estado.stats
    },
    set stats(v) {
      estado.stats = v
    },
    get getQueLanca() {
      return estado.getQueLanca
    },
    set getQueLanca(v) {
      estado.getQueLanca = v
    },
  }
}

describe('daSessao — o `AgentRunReport.metrics` real', () => {
  it('junta usage (eventos) e estatisticas (projecao) na mesma leitura', () => {
    const h = fazerBancada()
    h.stats = { turns: 1, steps: 2, llmMs: 10, toolMs: 0, ttftMs: 5, ttftSteps: 1, decodeMs: 5, decodeTokens: 8 }
    h.eventos = [comUsage({ inputTokens: 3, outputTokens: 4 })]

    assert.deepEqual(h.coletor.daSessao('session-1'), {
      inputTokens: 3,
      outputTokens: 4,
      turns: 1,
      steps: 2,
      llmMs: 10,
      toolMs: 0,
      ttftMs: 5,
      ttftSteps: 1,
      decodeMs: 5,
      decodeTokens: 8,
    })
  })

  it('sem nada medido = undefined (o report OMITE o campo)', () => {
    const h = fazerBancada()
    assert.equal(h.coletor.daSessao('session-1'), undefined)
  })

  it('sessao desconhecida / id ausente = undefined; leitura a lancar = undefined (nunca rebenta)', () => {
    const h = fazerBancada()
    assert.equal(h.coletor.daSessao('sessao-que-nao-existe'), undefined)
    assert.equal(h.coletor.daSessao(undefined), undefined)
    h.getQueLanca = true
    assert.equal(h.coletor.daSessao('session-1'), undefined)
  })

  it('sem projecoes registadas (composicao sem session-stats) ha SÓ tokens', () => {
    const h = fazerBancada({ semProjecoes: true })
    h.eventos = [comUsage({ outputTokens: 9 })]
    assert.deepEqual(h.coletor.daSessao('session-1'), { outputTokens: 9 })
  })
})
