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
  formatarQuantidade,
  formatarTempoDeMs,
  haQuantoTempo,
  linhaDeRun,
  MAX_BASE_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TEXTO_MENSAGEM,
  resumoDeMetricas,
  ROTULOS_DE_KIND_DE_RUN,
  ROTULOS_DE_STATUS_DE_AGENTE,
  sanearUmaLinha,
  TETO_DE_RUNS_DO_RELATORIO,
  tempoDeTrabalhoMs,
  TEXTO_DE_AJUDA,
  textoDeEstado,
  textoDeEstadoCurto,
  textoDeFimDeRuns,
  textoDeRelatorioDeAgentes,
  textoDeTarefa,
  totalDeTokens,
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

  it('sem summary: uma linha so (a metrica vira «—» — nunca se estima)', () => {
    assert.equal(linhaDeRun(run, 121_000), '• 01HZABCD — eco — concluído há 2 min · 📊 —')
  })

  it('com summary: a linha do resumo do modelo em baixo', () => {
    assert.equal(
      linhaDeRun({ ...run, summary: 'disse oi' }, 121_000),
      '• 01HZABCD — eco — concluído há 2 min · 📊 —\n   💬 disse oi',
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
        '• 01HZAAAA — eco — rodando há 1 min · 📊 —\n' +
        '• 01HZBBBB — dataviz — concluído há 3 min · 📊 —\n' +
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
    assert.equal(texto, '🤖 Atualização de agentes:\n• 01HZAAAA — eco — falhou há 2 min · 📊 —')
  })
})

describe('Onda 5: sanearUmaLinha — controlos viram espaco (o codec recusa no prompt)', () => {
  it('quebras de linha e tabs viram espaco; o resto intacto', () => {
    assert.equal(sanearUmaLinha('primeira\nsegunda'), 'primeira segunda')
    assert.equal(sanearUmaLinha('a\tb'), 'a b')
    assert.equal(sanearUmaLinha('sem controlos'), 'sem controlos')
  })

  it('TODOS os controlos C0 (0x00-0x1F) e o DEL (0x7F) viram espaco, um a um', () => {
    for (let codigo = 0x00; codigo <= 0x1f; codigo += 1) {
      assert.equal(
        sanearUmaLinha(`a${String.fromCharCode(codigo)}b`),
        'a b',
        `controlo 0x${codigo.toString(16).padStart(2, '0')} devia virar espaco`,
      )
    }
    assert.equal(sanearUmaLinha(`a${String.fromCharCode(0x7f)}b`), 'a b', 'o DEL (0x7F) vira espaco')
  })

  it('o retorno de carro \r vira espaco (um \r\n nao parte a linha em duas)', () => {
    assert.equal(sanearUmaLinha('primeira\r\nsegunda'), 'primeira  segunda')
  })

  it('acentos e espacos NORMAIS ficam intactos (so controlos sao trocados)', () => {
    assert.equal(sanearUmaLinha('faz café com 3  espaços'), 'faz café com 3  espaços')
    assert.equal(sanearUmaLinha('ação ≠  '), 'ação ≠  ')
  })
})

describe('Onda 5: MAX_PROMPT_CHARS — o teto do prompt e o MESMO do codec do canal', () => {
  it('vale 4096, o MAX_TEXTO_MENSAGEM (o teto do codec — um prompt acima seria recusado na forma)', () => {
    assert.equal(MAX_PROMPT_CHARS, 4096)
    assert.equal(MAX_PROMPT_CHARS, MAX_TEXTO_MENSAGEM)
  })

  it('cortarTexto no EXATO limite nao corta; um caracter acima corta com marcador (borda TG-048)', () => {
    const noTeto = 'a'.repeat(MAX_PROMPT_CHARS)
    assert.equal(cortarTexto(noTeto, MAX_PROMPT_CHARS), noTeto, '4096 = intacto, sem marcador')

    const acima = 'a'.repeat(MAX_PROMPT_CHARS + 1)
    const cortado = cortarTexto(acima, MAX_PROMPT_CHARS)
    assert.equal(cortado.length, MAX_PROMPT_CHARS, '4097 -> 4096 por construcao (slice + marcador)')
    assert.equal(cortado.slice(0, -1), 'a'.repeat(MAX_PROMPT_CHARS - 1))
    assert.equal(cortado.at(-1), '…')
  })
})

describe('Onda 5: haQuantoTempo — as bordas do relogio do /agentes', () => {
  it('as bordas de 1 min e de 1 h sao exactas (59.999 vs 60.000, 3.599.999 vs 3.600.000)', () => {
    assert.equal(haQuantoTempo(59_999), 'há menos de 1 min')
    assert.equal(haQuantoTempo(60_000), 'há 1 min')
    assert.equal(haQuantoTempo(3_599_999), 'há 59 min')
    assert.equal(haQuantoTempo(3_600_000), 'há 1 h')
    assert.equal(haQuantoTempo(7_200_000), 'há 2 h')
    assert.equal(haQuantoTempo(5_400_000), 'há 1 h 30 min')
  })
})

describe('Onda 5: linhaDeRun — bordas do resumo e do nascimento', () => {
  const run = {
    id: '01HZABCD',
    skill: 'eco',
    status: 'done' as const,
    startedAt: 1_000,
  }

  it('summary VAZIO e tratado como ausente: so a linha base', () => {
    assert.equal(linhaDeRun({ ...run, summary: '' }, 121_000), '• 01HZABCD — eco — concluído há 2 min · 📊 —')
  })

  it('run acabado de nascer (startedAt == agora): «agora mesmo», nunca «há agora»', () => {
    assert.equal(linhaDeRun({ ...run, status: 'running' }, 1_000), '• 01HZABCD — eco — rodando agora mesmo · 📊 —')
  })
})

describe('Onda 5: textoDeFimDeRuns — a notificacao proativa com VARIOS runs', () => {
  it('uma linha por run terminado, na ordem, sob o titulo proprio', () => {
    const agora = 10 * 60_000
    const texto = textoDeFimDeRuns(
      [
        { id: '01HZAAAA', skill: 'eco', status: 'done', startedAt: agora - 2 * 60_000, summary: 'oi' },
        { id: '01HZBBBB', skill: 'dataviz', status: 'failed', startedAt: agora - 60_000 },
      ],
      agora,
    )
    assert.equal(
      texto,
      '🤖 Atualização de agentes:\n' +
        '• 01HZAAAA — eco — concluído há 2 min · 📊 —\n' +
        '   💬 oi\n' +
        '• 01HZBBBB — dataviz — falhou há 1 min · 📊 —',
    )
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

/* ========================================================================== */
/* Onda 3 (EMENDA ONDA-2-CONTRATO-CAPACIDADES) — metricas dos runs, o         */
/* detalhe de /status-tarefa e a ajuda                                         */
/* ========================================================================== */

describe('Onda 3: ROTULOS_DE_KIND_DE_RUN — o vocabulario FECHADO do kind', () => {
  it('cobrem os TRES literais do contrato, e nada mais', () => {
    assert.deepEqual(Object.keys(ROTULOS_DE_KIND_DE_RUN).toSorted(), ['agent', 'chat', 'worktree'])
    assert.equal(ROTULOS_DE_KIND_DE_RUN.agent, 'agente')
    assert.equal(ROTULOS_DE_KIND_DE_RUN.chat, 'chat')
    assert.equal(ROTULOS_DE_KIND_DE_RUN.worktree, 'worktree')
  })
})

describe('Onda 3: formatarQuantidade / formatarTempoDeMs — deterministicos', () => {
  it('milhares com ponto (PT-BR), sem depender de locale', () => {
    assert.equal(formatarQuantidade(0), '0')
    assert.equal(formatarQuantidade(999), '999')
    assert.equal(formatarQuantidade(1_234), '1.234')
    assert.equal(formatarQuantidade(1_234_567), '1.234.567')
    assert.equal(formatarQuantidade(1_234.6), '1.235', 'arredonda antes de agrupar')
    assert.equal(formatarQuantidade(-5), '0', 'metrica negativa nao e do harness — vira zero')
  })

  it('ms -> «ms» / «s» / «min s», nas bordas exactas', () => {
    assert.equal(formatarTempoDeMs(0), '0 ms')
    assert.equal(formatarTempoDeMs(320), '320 ms')
    assert.equal(formatarTempoDeMs(999), '999 ms')
    assert.equal(formatarTempoDeMs(1_000), '1 s')
    assert.equal(formatarTempoDeMs(4_300), '4 s')
    assert.equal(formatarTempoDeMs(59_999), '60 s')
    assert.equal(formatarTempoDeMs(60_000), '1 min')
    assert.equal(formatarTempoDeMs(65_000), '1 min 5 s')
    assert.equal(formatarTempoDeMs(120_000), '2 min')
    assert.equal(formatarTempoDeMs(125_000), '2 min 5 s')
  })
})

describe('Onda 3: totalDeTokens / tempoDeTrabalhoMs — so somam o que existe', () => {
  it('sem metricas (ou sem nenhum contador): undefined — a ausencia NAO e zero', () => {
    assert.equal(totalDeTokens(undefined), undefined)
    assert.equal(totalDeTokens({}), undefined)
    assert.equal(totalDeTokens({ turns: 3 }), undefined, 'turnos nao sao tokens')
    assert.equal(tempoDeTrabalhoMs(undefined), undefined)
    assert.equal(tempoDeTrabalhoMs({ ttftMs: 500 }), undefined, 'ttft nao e tempo de trabalho')
  })

  it('somam os QUATRO contadores disjuntos — `decodeTokens` nunca entra (e subconjunto do output)', () => {
    assert.equal(totalDeTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 8, decodeTokens: 1_000 }), 15)
    assert.equal(totalDeTokens({ outputTokens: 234 }), 234, 'so o presente soma')
  })

  it('tempo = llmMs + toolMs presentes (parcial soma parcial, nunca preenche)', () => {
    assert.equal(tempoDeTrabalhoMs({ llmMs: 3_000, toolMs: 1_000 }), 4_000)
    assert.equal(tempoDeTrabalhoMs({ llmMs: 3_000 }), 3_000)
    assert.equal(tempoDeTrabalhoMs({ toolMs: 1_000 }), 1_000)
  })
})

describe('Onda 3: resumoDeMetricas — «tokens total / tempo», ausente = «—»', () => {
  it('sem metricas: «—» (NUNCA estimar/inventar)', () => {
    assert.equal(resumoDeMetricas(undefined), '—')
    assert.equal(resumoDeMetricas({}), '—')
  })

  it('com metricas: os dois componentes, so os que existem', () => {
    assert.equal(resumoDeMetricas({ inputTokens: 6_100, outputTokens: 234 }), '6.334 tokens')
    assert.equal(resumoDeMetricas({ llmMs: 4_300 }), '4 s')
    assert.equal(
      resumoDeMetricas({
        inputTokens: 1_000,
        outputTokens: 234,
        cacheReadTokens: 5_000,
        cacheWriteTokens: 100,
        llmMs: 3_200,
        toolMs: 1_100,
      }),
      '6.334 tokens / 4 s',
    )
  })
})

describe('Onda 3: linhaDeRun enriquecida — kind/worktree quando presentes', () => {
  const run = { id: '01HZABCD', skill: 'eco', status: 'done' as const, startedAt: 1_000 }

  it('kind/worktree AUSENTES nao ganham rotulo; a metrica vira «—»', () => {
    const linha = linhaDeRun(run, 121_000)
    assert.equal(linha, '• 01HZABCD — eco — concluído há 2 min · 📊 —')
    assert.ok(!linha.includes('agente'), 'o rotulo so aparece quando o run traz o kind')
  })

  it('kind/worktree PRESENTES entram na linha, com a metrica resumida', () => {
    assert.equal(
      linhaDeRun(
        {
          ...run,
          kind: 'chat',
          worktree: 'feature-x',
          metrics: { inputTokens: 6_100, outputTokens: 234, llmMs: 4_300 },
        },
        121_000,
      ),
      '• 01HZABCD — eco — concluído há 2 min · chat · wt: feature-x · 📊 6.334 tokens / 4 s',
    )
    assert.match(linhaDeRun({ ...run, kind: 'worktree' }, 121_000), /· worktree ·/u)
    assert.match(linhaDeRun({ ...run, kind: 'agent' }, 121_000), /· agente ·/u)
  })
})

describe('Onda 3: textoDeTarefa — o detalhe pedido por /status-tarefa', () => {
  const agora = 121_000
  const run = {
    id: '01HZABCD',
    skill: 'eco',
    status: 'done' as const,
    startedAt: 1_000,
    kind: 'chat' as const,
    worktree: 'feature-x',
    summary: 'feito',
    metrics: {
      inputTokens: 1_000,
      outputTokens: 234,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 100,
      decodeTokens: 200,
      turns: 3,
      steps: 7,
      llmMs: 3_200,
      toolMs: 1_100,
      ttftMs: 320,
      ttftSteps: 2,
      decodeMs: 2_400,
    },
  }

  it('encontrado: titulo + linha do run + o detalhe COMPLETO das metricas', () => {
    assert.equal(
      textoDeTarefa([run], '01HZABCD', agora),
      '🧩 Tarefa 01HZABCD:\n' +
        '• 01HZABCD — eco — concluído há 2 min · chat · wt: feature-x · 📊 6.334 tokens / 4 s\n' +
        '   💬 feito\n' +
        '   📊 Tokens: entrada 1.000 · saída 234 · cache lido 5.000 · cache escrito 100 · decodificados 200\n' +
        '   ⏱ Tempo: modelo 3 s · ferramentas 1 s · primeiro token 320 ms · decodificação 2 s\n' +
        '   🔁 Turnos 3 · passos 7 · passos com 1º token 2',
    )
  })

  it('sem metricas: cada campo vira «—» — nada se estima', () => {
    const texto = textoDeTarefa([{ id: '01HZABCD', skill: 'eco', status: 'running', startedAt: 1_000 }], '01HZABCD', agora)
    assert.match(texto, /🧩 Tarefa 01HZABCD:/u)
    assert.match(texto, /📊 Tokens: entrada — · saída — · cache lido — · cache escrito — · decodificados —/u)
    assert.match(texto, /⏱ Tempo: modelo — · ferramentas — · primeiro token — · decodificação —/u)
    assert.match(texto, /🔁 Turnos — · passos — · passos com 1º token —/u)
  })

  it('sem correspondencia: «Tarefa <id> nao encontrada (veja /agentes)»', () => {
    assert.equal(textoDeTarefa([run], '01HZMISS', agora), 'Tarefa 01HZMISS não encontrada (veja /agentes)')
    assert.equal(textoDeTarefa([], '01HZABCD', agora), 'Tarefa 01HZABCD não encontrada (veja /agentes)')
  })

  it('o filtro respeita o teto de 64 runs do report (TETO_DE_RUNS_DO_RELATORIO)', () => {
    assert.equal(TETO_DE_RUNS_DO_RELATORIO, 64)
    const runs = Array.from({ length: 65 }, (_, i) => ({
      id: `01HZ${String(i).padStart(4, '0')}`,
      skill: 'eco',
      status: 'running' as const,
      startedAt: 1_000,
    }))
    // O 64o (indice 63) esta DENTRO do teto; o 65o (indice 64) ja nao.
    assert.match(textoDeTarefa(runs, runs[63]!.id, agora), /🧩 Tarefa/u)
    assert.match(textoDeTarefa(runs, runs[64]!.id, agora), /não encontrada/u)
  })
})

describe('Onda 3: MAX_BASE_CHARS e TEXTO_DE_AJUDA', () => {
  it('MAX_BASE_CHARS vale 256 (a higiene de transporte do `base` de worktree.create)', () => {
    assert.equal(MAX_BASE_CHARS, 256)
  })

  it('a ajuda mantem o texto curto do §2 e ADICIONA os comandos de tarefa', () => {
    assert.match(TEXTO_DE_AJUDA, /ℹ️ Este bot controla o acesso ao teu Harness pelo Telegram\./u)
    assert.match(TEXTO_DE_AJUDA, /Usa \/menu para o cartão de controlo e \/status/u)
    for (const comando of ['/novo-chat ', '/novo-chat-wt ', '/worktree ', '/status-tarefa ', '/agentes']) {
      assert.ok(TEXTO_DE_AJUDA.includes(comando), `falta ${comando} na ajuda`)
    }
  })
})