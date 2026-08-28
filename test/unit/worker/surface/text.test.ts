/**
 * `worker/surface/text.ts` — o texto de estado e os formatadores NEUTROS (onda 2
 * — nucleo). Port fiel do que `test/unit/worker/commands/router.test.ts` e
 * `status.test.ts` (DONO de referencia: T5.2) provam sobre os mesmos helpers, mas
 * contra o modulo neutro. Os textos PT-BR sao BYTE A BYTE os atuais (TG-084).
 *
 * COBRE TG-084 (/status: estado, seq, tunel, ha quanto tempo e quando o TTL
 * expira; sem segredo nem digest), o corte dos 4096 (TG-048) e o ramo das horas
 * de {@link formatarDuracao}.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  cortarTexto,
  formatarDuracao,
  formatarHora,
  haQuantoTempo,
  linhaDeRun,
  ROTULOS_DE_STATUS_DE_AGENTE,
  sanearUmaLinha,
  textoDeEstado,
  textoDeEstadoCurto,
  textoDeFimDeRuns,
  textoDeRelatorioDeAgentes,
} from '../../../../worker/surface/text.ts'

/* ========================================================================== */
/* formatarDuracao — o ramo das horas (deterministico)                         */
/* ========================================================================== */

describe('formatarDuracao', () => {
  it('cobre o ramo das horas, com e sem resto', () => {
    assert.equal(formatarDuracao(0), 'agora')
    assert.equal(formatarDuracao(-5), 'agora')
    assert.equal(formatarDuracao(30_000), 'menos de 1 min')
    assert.equal(formatarDuracao(59_999), 'menos de 1 min')
    assert.equal(formatarDuracao(60_000), '1 min')
    assert.equal(formatarDuracao(59 * 60_000), '59 min')
    assert.equal(formatarDuracao(60 * 60_000), '1 h')
    assert.equal(formatarDuracao(90 * 60_000), '1 h 30 min')
    assert.equal(formatarDuracao(150 * 60_000), '2 h 30 min')
  })
})

/* ========================================================================== */
/* formatarHora — «HH:MM» no fuso local                                         */
/* ========================================================================== */

describe('formatarHora', () => {
  it('formata «HH:MM» com padding a esquerda no fuso local', () => {
    // O fuso local desloca o relogio; asseguramos apenas a FORMA HH:MM e o
    // padding — nunca um valor absoluto dependente do fuso.
    assert.match(formatarHora(5 * 60_000), /^[0-9]{2}:[0-9]{2}$/u)
    const [h, m] = formatarHora(1 * 3_600_000 + 7 * 60_000).split(':')
    assert.ok(h !== undefined && m !== undefined, 'deve partir em HH e MM')
    assert.ok(h.length === 2 && m.length === 2, 'padding a esquerda')
  })
})

/* ========================================================================== */
/* cortarTexto — o limite de 4096 nunca estoura (TG-048)                       */
/* ========================================================================== */

describe('cortarTexto', () => {
  it('texto curto passa intacto; texto longo e cortado', () => {
    assert.equal(cortarTexto('curto'), 'curto')
    const longo = 'x'.repeat(5_000)
    const cortado = cortarTexto(longo)
    assert.ok(cortado.length <= 4_096)
    assert.ok(cortado.endsWith('…'))
  })

  it('aceita um limite por parametro (o limite do CANAL vindo das SurfaceLimits)', () => {
    assert.equal(cortarTexto('short', 100), 'short')
    const cortado = cortarTexto('x'.repeat(200), 100)
    assert.ok(cortado.length <= 100)
    assert.ok(cortado.endsWith('…'))
  })
})

/* ========================================================================== */
/* textoDeEstado — antes da primeira difusao                                   */
/* ========================================================================== */

describe('textoDeEstado', () => {
  it('sem estado ainda, diz desconhecido em vez de inventar (TG-084)', () => {
    const texto = textoDeEstado({ state: undefined, seq: 0 }, 1_000)
    assert.match(texto, /desconhecido/u)
    assert.match(texto, /host ainda não enviou estado/u)
  })

  it('em READY mostra estado, seq, URL, tempo no ar e quando o TTL expira (TG-084)', () => {
    const agora = 5 * 60_000
    const texto = textoDeEstado(
      {
        state: 'READY',
        seq: 7,
        url: 'https://exemplo.trycloudflare.com',
        readyDesde: agora - 2 * 60_000,
        expiresAt: agora + 3 * 60_000,
      },
      agora,
    )
    assert.match(texto, /Estado: online \(READY\)/u)
    assert.match(texto, /Sequência: 7/u)
    assert.match(texto, /Túnel: https:\/\/exemplo\.trycloudflare\.com/u)
    assert.match(texto, /No ar há: 2 min/u)
    assert.match(texto, /Expira: em 3 min/u)
  })

  it('fora de READY nao ha URL: STARTING nao a divulga', () => {
    const texto = textoDeEstado({ state: 'STARTING', seq: 3 }, 1_000)
    assert.match(texto, /Estado: ligando \(STARTING\)/u)
    assert.ok(!texto.includes('https://'), 'a URL so existe em READY')
    assert.ok(!texto.includes('Túnel:'), 'a URL so existe em READY')
  })

  it('nunca expoe segredo nem digest (TG-084)', () => {
    const digest = 'a'.repeat(64)
    const texto = textoDeEstado(
      {
        state: 'READY',
        seq: 9,
        url: 'https://exemplo.trycloudflare.com',
        readyDesde: 1_000,
        expiresAt: 61_000,
      },
      1_000,
    )
    assert.ok(!texto.includes(digest), 'o digest nao pode aparecer')
    assert.ok(!texto.includes('sha256'), 'nenhum material de verificacao')
  })
})

/* ========================================================================== */
/* Onda 5 — OS AGENTES: rotulos, ha-quanto, linhas e o relatorio              */
/* ========================================================================== */

describe('Onda 5: ROTULOS_DE_STATUS_DE_AGENTE — o vocabulario PT-BR fechado', () => {
  it('cobre os QUATRO status do contrato (AgentRunStatus), e so', () => {
    assert.deepEqual(ROTULOS_DE_STATUS_DE_AGENTE, {
      running: 'rodando',
      done: 'concluído',
      failed: 'falhou',
      cancelled: 'cancelado',
    })
  })
})

describe('Onda 5: haQuantoTempo — a forma PT-BR do /agentes', () => {
  it('cobre o agora, minutos e horas', () => {
    assert.equal(haQuantoTempo(0), 'agora mesmo')
    assert.equal(haQuantoTempo(-5), 'agora mesmo')
    assert.equal(haQuantoTempo(30_000), 'há menos de 1 min')
    assert.equal(haQuantoTempo(2 * 60_000), 'há 2 min')
    assert.equal(haQuantoTempo(90 * 60_000), 'há 1 h 30 min')
  })
})

describe('Onda 5: linhaDeRun — id, skill, status, ha-quanto e resumo', () => {
  const run = {
    id: '01HZABCD',
    skill: 'eco',
    status: 'done' as const,
    startedAt: 1_000,
  }

  it('sem summary: uma linha so', () => {
    assert.equal(linhaDeRun(run, 121_000), '• 01HZABCD — eco — concluído há 2 min')
  })

  it('com summary: a linha do resumo do modelo em baixo', () => {
    assert.equal(
      linhaDeRun({ ...run, summary: 'disse oi' }, 121_000),
      '• 01HZABCD — eco — concluído há 2 min\n   💬 disse oi',
    )
  })

  it('os quatro status aparecem com o rotulo PT-BR exacto', () => {
    assert.match(linhaDeRun({ ...run, status: 'running' }, 60_000), /rodando/u)
    assert.match(linhaDeRun({ ...run, status: 'done' }, 60_000), /concluído/u)
    assert.match(linhaDeRun({ ...run, status: 'failed' }, 60_000), /falhou/u)
    assert.match(linhaDeRun({ ...run, status: 'cancelled' }, 60_000), /cancelado/u)
  })
})

describe('Onda 5: textoDeRelatorioDeAgentes — a resposta de /agentes', () => {
  it('lista vazia: «Nenhum agente rodando.»', () => {
    assert.equal(textoDeRelatorioDeAgentes([], 1_000), 'Nenhum agente rodando.')
  })

  it('lista com runs: titulo + uma linha por run, na ordem', () => {
    const agora = 10 * 60_000
    const texto = textoDeRelatorioDeAgentes(
      [
        { id: '01HZAAAA', skill: 'eco', status: 'running', startedAt: agora - 60_000 },
        {
          id: '01HZBBBB',
          skill: 'dataviz',
          status: 'done',
          startedAt: agora - 3 * 60_000,
          summary: 'gráfico pronto',
        },
      ],
      agora,
    )
    assert.equal(
      texto,
      '🤖 Agentes:\n' +
        '• 01HZAAAA — eco — rodando há 1 min\n' +
        '• 01HZBBBB — dataviz — concluído há 3 min\n' +
        '   💬 gráfico pronto',
    )
  })

  it('nunca expoe segredo (S3): so id/skill/status/tempo e o summary do modelo', () => {
    const texto = textoDeRelatorioDeAgentes(
      [{ id: '01HZAAAA', skill: 'eco', status: 'done', startedAt: 1_000, summary: 'sem credenciais' }],
      121_000,
    )
    assert.ok(!texto.includes('token'), 'nenhum material de segredo')
    assert.ok(!texto.includes('sha256'))
  })
})

describe('Onda 5: textoDeFimDeRuns — a notificacao proativa', () => {
  it('titulo proprio + as linhas dos runs que terminaram', () => {
    const texto = textoDeFimDeRuns(
      [{ id: '01HZAAAA', skill: 'eco', status: 'failed', startedAt: 1_000 }],
      121_000,
    )
    assert.equal(texto, '🤖 Atualização de agentes:\n• 01HZAAAA — eco — falhou há 2 min')
  })
})

describe('Onda 5: sanearUmaLinha — controlos viram espaco (o codec recusa no prompt)', () => {
  it('quebras de linha e tabs viram espaco; o resto intacto', () => {
    assert.equal(sanearUmaLinha('primeira\nsegunda'), 'primeira segunda')
    assert.equal(sanearUmaLinha('a\tb'), 'a b')
    assert.equal(sanearUmaLinha('sem controlos'), 'sem controlos')
  })
})

/* ========================================================================== */
/* textoDeEstadoCurto — o texto CURTO do /status/cartao (CONTRATO §5)         */
/* ========================================================================== */

describe('textoDeEstadoCurto — boa-vindas ao dono, 1-3 linhas PT-BR (§5)', () => {
  it('sem estado ainda, diz que o estado ainda e desconhecido', () => {
    const texto = textoDeEstadoCurto({ state: undefined, seq: 0 }, 1_000)
    assert.match(texto, /Estado ainda desconhecido do host/u)
  })

  it('em READY mostra online, link e quando expira — sem Sequencia nem codigo EN', () => {
    const agora = 5 * 60_000
    const texto = textoDeEstadoCurto(
      {
        state: 'READY',
        seq: 7,
        url: 'https://exemplo.trycloudflare.com',
        readyDesde: agora - 3 * 60_000,
        expiresAt: agora + 30 * 60_000,
      },
      agora,
    )
    assert.match(texto, /Túnel \*online\* há 3 min/u)
    assert.match(texto, /Link: https:\/\/exemplo\.trycloudflare\.com/u)
    assert.match(texto, /Expira daqui a 30 min/u)
    assert.ok(!texto.includes('Sequência'), 'o seq/codigo EN termina no log, nao aqui')
    assert.ok(!texto.includes('READY'), 'o codigo EN nao aparece')
  })

  it('STOPPED: nada ficou exposto', () => {
    assert.equal(textoDeEstadoCurto({ state: 'STOPPED', seq: 2 }, 1_000), 'Túnel desligado. Nada ficou exposto.')
  })

  it('FAILED: precisa de accao tua', () => {
    assert.match(textoDeEstadoCurto({ state: 'FAILED', seq: 4 }, 1_000), /Túnel parado por um erro/u)
  })

  it('STARTING/STOPPING/DEGRADED: uma linha curta de transicao, sem segredo', () => {
    assert.match(textoDeEstadoCurto({ state: 'STARTING', seq: 1 }, 1_000), /Túnel a ligar/u)
    assert.match(textoDeEstadoCurto({ state: 'STOPPING', seq: 1 }, 1_000), /Túnel a desligar/u)
    assert.match(textoDeEstadoCurto({ state: 'DEGRADED', seq: 1 }, 1_000), /instável/u)
  })

  it('nunca expoe o digest (TG-084): a URL so em READY', () => {
    const digest = 'a'.repeat(64)
    const texto = textoDeEstadoCurto(
      { state: 'READY', seq: 9, url: 'https://exemplo.trycloudflare.com', readyDesde: 1_000, expiresAt: 61_000 },
      1_000,
    )
    assert.ok(!texto.includes(digest), 'o digest nao pode aparecer')
    assert.ok(!textoDeEstadoCurto({ state: 'STARTING', seq: 1 }, 1_000).includes('https://'), 'URL so em READY')
  })
})