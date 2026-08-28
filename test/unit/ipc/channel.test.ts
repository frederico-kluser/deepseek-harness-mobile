/**
 * `src/ipc/channel.ts` -- o lado HOST do canal JSONL.
 *
 * As invariantes de `src/contracts/ipc.ts` que este ficheiro cobre:
 *   S1  uma mensagem por linha, UTF-8, terminada em `\n`;
 *   S3  nenhum segredo em payload nenhum, em codificacao nenhuma;
 *   S4  linha malformada e descartada e o canal SOBREVIVE;
 *   S5  o `nonce` viaja opaco (o host recebe-o sem o worker o ter tocado).
 *
 * O que NAO esta aqui: a fiacao ao supervisor (`test/unit/proc/ipc-canal.test.ts`)
 * e o comportamento contra processos REAIS (`test/integration/proc/**`).
 */

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { describe, it } from 'node:test'

import type {
  IpcErrorCode,
  IpcIntentMessage,
  IpcIntentName,
  IpcMessageToWorker,
  IpcPairingSuccessMessage,
  IpcStateMessage,
} from '../../../src/contracts/ipc.ts'
import type { GuardLogger } from '../../../src/logging/logger.ts'
import {
  createHostIpcChannel,
  createIpcLineDecoder,
  IpcChannelError,
  parseIpcLine,
  serializeIpcMessage,
  type HostIpcChannel,
} from '../../../src/ipc/channel.ts'

/* ========================================================================== */
/* Bancada                                                                    */
/* ========================================================================== */

interface Linha {
  level: string
  message: string
}

function makeLog(): { log: GuardLogger; linhas: Linha[] } {
  const linhas: Linha[] = []
  const push =
    (level: string) =>
    (message: string): void => {
      linhas.push({ level, message })
    }
  return {
    linhas,
    log: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') },
  }
}

const ESTADOS: readonly IpcStateMessage['state'][] = [
  'STOPPED',
  'STARTING',
  'READY',
  'DEGRADED',
  'STOPPING',
  'FAILED',
]

const CODIGOS: readonly IpcErrorCode[] = [
  'SHUTDOWN_IN_PROGRESS',
  'EXPOSURE_DISABLED',
  'RESTRICTED_MODE',
  'PROBE_FAILED',
  'TUNNEL_FAILED',
  'NOT_PAIRED',
  'NONCE_INVALID',
  'RATE_LIMITED',
  'INTERNAL',
]

const INTENCOES: readonly IpcIntentName[] = [
  'tunnel.up',
  'tunnel.down',
  'tunnel.status',
  'session.issue',
  'secret.rotate',
  'emergency',
  // EMENDA ONDA-4-AGENTS-HOST: o dispatcher de agentes.
  'agent.dispatch',
  'agent.status',
  'agent.cancel',
]

const INTENCAO: IpcIntentMessage = {
  v: 2,
  type: 'intent',
  intent: 'tunnel.up',
  requestId: '01J0000000000000000000000A',
  from: '123456789',
  chat: '123456789',
}

interface Bancada {
  canal: HostIpcChannel
  /** `stdout` do filho: o teste escreve aqui o que o worker "diz". */
  entrada: PassThrough
  /** `stdin` do filho: o teste le aqui o que o host escreveu. */
  saida: PassThrough
  escrito(): string
  linhas: Linha[]
  recebidas: IpcIntentMessage[]
}

function montar(
  options: {
    onIntent?: (intent: IpcIntentMessage) => IpcMessageToWorker
    maxPendingBytes?: number
    semSaida?: boolean
    secrets?: readonly string[]
  } = {},
): Bancada {
  const { log, linhas } = makeLog()
  const entrada = new PassThrough()
  const saida = new PassThrough()
  const recebidas: IpcIntentMessage[] = []

  const canal = createHostIpcChannel({
    input: entrada,
    output: options.semSaida === true ? undefined : saida,
    log,
    onIntent: (intent): IpcMessageToWorker => {
      recebidas.push(intent)
      if (options.onIntent !== undefined) return options.onIntent(intent)
      return { v: 2, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'STARTING' }
    },
    secrets: (): readonly string[] => options.secrets ?? [],
    ...(options.maxPendingBytes === undefined ? {} : { maxPendingBytes: options.maxPendingBytes }),
  })

  return {
    canal,
    entrada,
    saida,
    linhas,
    recebidas,
    escrito: (): string => saida.read()?.toString() ?? '',
  }
}

/* ========================================================================== */
/* S1 -- enquadramento                                                        */
/* ========================================================================== */

describe('S1: uma mensagem por linha, UTF-8, terminada em \\n', () => {
  it('serializa em JSON compacto com exatamente um \\n no fim', () => {
    const linha = serializeIpcMessage(
      { v: 2, type: 'state', state: 'STOPPED', seq: 42 },
      'to-worker',
    )
    assert.equal(linha.endsWith('\n'), true)
    assert.equal(linha.split('\n').length, 2, 'exatamente um terminador')
    assert.equal(linha.includes('\r'), false, 'sem CR')
    assert.equal(linha.includes('  '), false, 'sem pretty-print')
  })

  it('um \\n DENTRO de um campo nao parte a linha: sai escapado', () => {
    const linha = serializeIpcMessage(
      { v: 2, type: 'error', code: 'INTERNAL', message: 'primeira\nsegunda' },
      'to-worker',
    )
    assert.equal(linha.split('\n').length, 2, 'continua a ser UMA linha')
    assert.equal(linha.includes('\\n'), true, 'a quebra viajou escapada')

    const verdict = parseIpcLine(linha.trimEnd(), 'to-worker')
    assert.equal(verdict.ok, true)
    // Round trip fiel: o texto chega do outro lado com a quebra de volta.
    assert.equal(verdict.ok && verdict.message.type === 'error' && verdict.message.message, 'primeira\nsegunda')
  })

  it('round trip de todas as mensagens dos dois sentidos', () => {
    const todas: IpcMessageToWorker[] = [
      ...ESTADOS.map(
        (state): IpcMessageToWorker =>
          state === 'READY'
            ? { v: 2, type: 'state', state, seq: 1, url: 'https://x.trycloudflare.com', expiresAt: 9 }
            : { v: 2, type: 'state', state, seq: 1 },
      ),
      { v: 2, type: 'ack', requestId: 'r1', result: 'accepted', state: 'STARTING' },
      { v: 2, type: 'ack', requestId: 'r1', result: 'noop', state: 'READY' },
      { v: 2, type: 'ack', requestId: 'r1', result: 'rejected', state: 'STOPPING', code: 'SHUTDOWN_IN_PROGRESS' },
      ...CODIGOS.map((code): IpcMessageToWorker => ({ v: 2, type: 'error', code, message: `erro ${code}` })),
      // EMENDA ONDA-4-AGENTS-HOST: agent.report round-tripa fiel.
      {
        v: 2,
        type: 'agent.report',
        runs: [
          { id: 'ABCD1234', skill: 'deep-orchestrator-agent-skill', status: 'running', startedAt: 1_700_000_000_000 },
          { id: 'EFGH5678', skill: 'surf-plan-agent-skill', status: 'done', startedAt: 1, summary: 'resumo curto' },
          { id: 'IJKL9012', skill: 'html-explainer-agent-skill', status: 'failed', startedAt: 2 },
          { id: 'MNOP3456', skill: '3d-exemplo', status: 'cancelled', startedAt: 3 },
        ],
      },
    ]

    for (const message of todas) {
      const verdict = parseIpcLine(serializeIpcMessage(message, 'to-worker').trimEnd(), 'to-worker')
      assert.equal(verdict.ok, true, `falhou em ${message.type}`)
      assert.deepEqual(verdict.ok ? verdict.message : undefined, message)
    }

    for (const intent of INTENCOES) {
      // EMENDA ONDA-4-AGENTS-HOST: cada intent round-tripa com o corpo que o
      // contrato lhe permite — `agent.dispatch` exige params { skill, prompt },
      // `agent.cancel` exige params { agentId }, `agent.status` nao tem params.
      const message: IpcIntentMessage =
        intent === 'agent.dispatch'
          ? { ...INTENCAO, intent, nonce: 'n-opaco', params: { skill: 'deep-orchestrator-agent-skill', prompt: 'faz isto' } }
          : intent === 'agent.cancel'
            ? { ...INTENCAO, intent, params: { agentId: 'ABCD1234' } }
            : intent === 'agent.status'
              ? { ...INTENCAO, intent }
              : { ...INTENCAO, intent, nonce: 'n-opaco' }
      const verdict = parseIpcLine(serializeIpcMessage(message, 'to-host').trimEnd(), 'to-host')
      assert.deepEqual(verdict.ok ? verdict.message : undefined, message)
    }

    // EMENDA ONDA-1-PAREAR-VIA-PAINEL: `pairing.success` round-trips fiel.
    const success: IpcPairingSuccessMessage = { v: 2, type: 'pairing.success', from: '111', chat: '222', pairedAt: 1_700_000_000_000 }
    const verdictSuccess = parseIpcLine(serializeIpcMessage(success, 'to-host').trimEnd(), 'to-host')
    assert.deepEqual(verdictSuccess.ok ? verdictSuccess.message : undefined, success)
  })
})

/* ========================================================================== */
/* Acumulador                                                                 */
/* ========================================================================== */

describe('o acumulador: uma linha partida entre chunks e reconstruida', () => {
  const LINHA = serializeIpcMessage(INTENCAO, 'to-host')

  it('parte em TODAS as fronteiras possiveis e nao perde nem duplica', () => {
    for (let corte = 1; corte < LINHA.length; corte += 1) {
      const decoder = createIpcLineDecoder({ direction: 'to-host' })
      const primeiro = decoder.push(Buffer.from(LINHA.slice(0, corte), 'utf8'))
      const segundo = decoder.push(Buffer.from(LINHA.slice(corte), 'utf8'))
      const todos = [...primeiro, ...segundo]

      assert.equal(todos.length, 1, `corte em ${String(corte)} deu ${String(todos.length)} vereditos`)
      assert.deepEqual(todos[0], { ok: true, message: INTENCAO })
    }
  })

  it('multiplas mensagens no MESMO chunk saem todas, pela ordem', () => {
    const decoder = createIpcLineDecoder({ direction: 'to-host' })
    const tres = INTENCOES.slice(0, 3).map((intent) =>
      serializeIpcMessage({ ...INTENCAO, intent }, 'to-host'),
    )

    const vereditos = decoder.push(Buffer.from(tres.join(''), 'utf8'))
    assert.equal(vereditos.length, 3)
    assert.deepEqual(
      vereditos.map((v) => (v.ok && v.message.type === 'intent' ? v.message.intent : undefined)),
      INTENCOES.slice(0, 3),
    )
  })

  it('uma mensagem e meia num chunk: a metade fica retida ate ao \\n', () => {
    const decoder = createIpcLineDecoder({ direction: 'to-host' })
    const vereditos = decoder.push(Buffer.from(LINHA + LINHA.slice(0, 10), 'utf8'))

    assert.equal(vereditos.length, 1)
    assert.equal(decoder.pending, 10, 'a cauda ficou no acumulador')
    assert.equal(decoder.push(Buffer.from(LINHA.slice(10), 'utf8')).length, 1)
    assert.equal(decoder.pending, 0)
  })

  it('um carater UTF-8 partido entre dois chunks NAO e corrompido', () => {
    // "acao" com cedilha e til: 2 bytes cada. Partir a meio de um deles com
    // `Buffer.toString()` daria U+FFFD e a linha virava `json-invalido`.
    const message: IpcMessageToWorker = { v: 2, type: 'error', code: 'INTERNAL', message: 'uma acao ficou por concluir' }
    const bytes = Buffer.from(serializeIpcMessage(message, 'to-worker'), 'utf8')

    for (let corte = 1; corte < bytes.length; corte += 1) {
      const decoder = createIpcLineDecoder({ direction: 'to-worker' })
      const todos = [...decoder.push(bytes.subarray(0, corte)), ...decoder.push(bytes.subarray(corte))]
      assert.equal(todos.length, 1, `corte em ${String(corte)}`)
      assert.deepEqual(todos[0], { ok: true, message }, `corte em ${String(corte)} corrompeu o texto`)
    }
  })

  it('linhas em branco nao produzem veredito nenhum (nao sao violacao)', () => {
    const decoder = createIpcLineDecoder({ direction: 'to-host' })
    assert.deepEqual(decoder.push('\n\n\n'), [])
    assert.equal(decoder.push(LINHA).length, 1)
  })

  it('uma linha SEM FIM e cortada, reportada UMA vez, e o canal ressincroniza', () => {
    const decoder = createIpcLineDecoder({ direction: 'to-host', maxLineBytes: 128 })

    const estouro = decoder.push('x'.repeat(200))
    assert.deepEqual(estouro, [{ ok: false, reason: 'forma-invalida' }])
    assert.equal(decoder.pending, 0, 'o acumulador nao pode crescer sem limite')

    // Mais lixo do mesmo estouro nao gera um segundo veredito.
    assert.deepEqual(decoder.push('y'.repeat(200)), [])

    // O `\n` fecha a linha morta; a mensagem SEGUINTE e processada normalmente.
    const depois = decoder.push(`\n${LINHA}`)
    assert.equal(depois.length, 1)
    assert.equal(depois[0]?.ok, true)
  })
})

/* ========================================================================== */
/* S4 -- malformadas                                                          */
/* ========================================================================== */

describe('S4: linha malformada e descartada, e o canal SOBREVIVE', () => {
  const TABELA: ReadonlyArray<{ nome: string; linha: string; reason: string }> = [
    { nome: 'JSON invalido', linha: '{isto nao e json', reason: 'json-invalido' },
    { nome: 'truncada a meio', linha: '{"v":2,"type":"inte', reason: 'json-invalido' },
    { nome: 'versao desconhecida', linha: '{"v":3,"type":"intent"}', reason: 'versao-desconhecida' },
    { nome: 'versao em texto', linha: '{"v":"2","type":"intent"}', reason: 'versao-desconhecida' },
    { nome: 'tipo desconhecido', linha: '{"v":2,"type":"reboot"}', reason: 'tipo-desconhecido' },
    { nome: 'tipo do sentido errado', linha: '{"v":2,"type":"ack","requestId":"r","result":"noop","state":"READY"}', reason: 'tipo-desconhecido' },
    { nome: 'intencao fora do vocabulario', linha: '{"v":2,"type":"intent","intent":"rm.rf","requestId":"r","from":"1","chat":"1"}', reason: 'forma-invalida' },
    { nome: 'from vazio (so espacos)', linha: '{"v":2,"type":"intent","intent":"emergency","requestId":"r","from":"  ","chat":"1"}', reason: 'forma-invalida' },
    { nome: 'from numerico (o formato legado V1) e recusado: V2 exige string', linha: '{"v":2,"type":"intent","intent":"emergency","requestId":"r","from":1,"chat":"1"}', reason: 'forma-invalida' },
    { nome: 'requestId ausente', linha: '{"v":2,"type":"intent","intent":"emergency","from":"1","chat":"1"}', reason: 'forma-invalida' },
    { nome: 'array em vez de objeto', linha: '[{"v":2,"type":"intent"}]', reason: 'forma-invalida' },
    { nome: 'nulo', linha: 'null', reason: 'forma-invalida' },
    { nome: 'numero solto', linha: '7', reason: 'forma-invalida' },
  ]

  for (const caso of TABELA) {
    it(`${caso.nome} -> ${caso.reason}, sem lancar`, () => {
      assert.deepEqual(parseIpcLine(caso.linha, 'to-host'), { ok: false, reason: caso.reason })
    })
  }

  it('a mensagem SEGUINTE a uma malformada e processada, e o canal fica aberto', () => {
    const b = montar()
    for (const caso of TABELA) b.entrada.write(`${caso.linha}\n`)
    b.entrada.write(serializeIpcMessage(INTENCAO, 'to-host'))

    assert.equal(b.recebidas.length, 1, 'a boa passou')
    assert.deepEqual(b.recebidas[0], INTENCAO)
    assert.equal(b.canal.stats.malformed, TABELA.length)
    assert.equal(
      b.linhas.filter((l) => l.level === 'warn' && l.message.includes('descartada')).length,
      TABELA.length,
      'cada descarte e registado',
    )
    // A prova de que o canal nao caiu: a resposta a mensagem boa foi escrita.
    assert.equal(b.escrito().includes('"type":"ack"'), true)
  })

  it('um `__proto__` na linha nao viaja para dentro do host', () => {
    const b = montar()
    b.entrada.write(`${JSON.stringify({ ...INTENCAO, __proto__: { poluido: true }, extra: 'x' })}\n`)

    assert.equal(b.recebidas.length, 1)
    // A mensagem e RECONSTRUIDA: so os campos do contrato sobrevivem.
    assert.deepEqual(b.recebidas[0], INTENCAO)
    assert.equal(Object.hasOwn(b.recebidas[0] ?? {}, 'extra'), false)
    assert.equal(({} as Record<string, unknown>)['poluido'], undefined)
  })

  it('um decisor que LANCA nao derruba o canal e a intencao recebe resposta', () => {
    const b = montar({
      onIntent: (): never => {
        throw new Error('defeito do controlador')
      },
    })
    b.entrada.write(serializeIpcMessage(INTENCAO, 'to-host'))

    const saida = b.escrito()
    assert.equal(saida.includes('"code":"INTERNAL"'), true, 'o ack e SEMPRE emitido')
    assert.equal(saida.includes(INTENCAO.requestId), true)
    assert.equal(b.linhas.some((l) => l.level === 'error' && l.message.includes('lancou')), true)

    // E continua vivo para a mensagem seguinte.
    b.entrada.write(serializeIpcMessage({ ...INTENCAO, requestId: 'r2' }, 'to-host'))
    assert.equal(b.recebidas.length, 2)
  })
})

/* ========================================================================== */
/* V2 — ids NAO-numericos atravessam o canal intactos (EMENDA ONDA-1-IPC-      */
/* ENVELOPE-STRING: o prerequisito do provedor Discord)                        */
/* ========================================================================== */

describe('V2: um id nao-numerico (snowflake) atravessa intent -> host -> ack sem NaN', () => {
  it('uma snowflake que estoura Number.MAX_SAFE_INTEGER viaja byte a byte', () => {
    // 1057992969437413409 > 2^53: `Number(...)` dela perderia precisao (ou
    // viraria um inteiro errado) — e exatamente o que a V2 elimina.
    const snowflake = '1057992969437413409'
    const mensagem: IpcIntentMessage = {
      v: 2,
      type: 'intent',
      intent: 'tunnel.status',
      requestId: '01J0000000000000000000000A',
      from: snowflake,
      chat: snowflake,
    }
    const verdict = parseIpcLine(serializeIpcMessage(mensagem, 'to-host').trimEnd(), 'to-host')
    // O padrao `verdict.ok && ...` e o MESMO do teste S5 do nonce (sem assert
    // de ok isolado antes: a cadeia e a propria assercao de que a linha leu).
    assert.equal(verdict.ok && verdict.message.type === 'intent' && verdict.message.from, snowflake)
    assert.equal(verdict.ok && verdict.message.type === 'intent' && verdict.message.chat, snowflake)
    assert.equal(verdict.ok && verdict.message.type === 'intent' && Number.isNaN(Number(verdict.message.from)), false)
  })

  it('o host decide a intencao da snowflake e responde ack no proprio tick', () => {
    const b = montar({
      onIntent: (intent): IpcMessageToWorker => {
        assert.equal(intent.from, '1057992969437413409')
        assert.equal(intent.chat, '1057992969437413409')
        return { v: 2, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'STARTING' }
      },
    })
    b.entrada.write(
      serializeIpcMessage(
        { v: 2, type: 'intent', intent: 'tunnel.down', requestId: '01J0000000000000000000000A', from: '1057992969437413409', chat: '1057992969437413409' },
        'to-host',
      ),
    )
    assert.equal(b.recebidas.length, 1)
    const saida = b.escrito()
    assert.ok(saida.includes('"type":"ack"'), 'a resposta do host saiu')
    assert.ok(saida.includes('01J0000000000000000000000A'), 'o ack correlaciona pelo requestId')
    b.canal.dispose()
  })
})

/* ========================================================================== */
/* Compatibilidade para a frente: o vocabulario cresce, o despacho nao muda    */
/* ========================================================================== */

describe('um tipo do FUTURO degrada em silencio em vez de partir o canal', () => {
  /**
   * O vocabulario cresce, e JA CRESCEU: o COMMIT PREP 5 acrescentou `notify`
   * e `pairing.challenge` (o digest do codigo de pareamento, gerado no host e
   * verificado no worker — a lacuna que T4.4 reportou). As duas saem da lista
   * de "futuro" e passam a ser tipos VALIDOS, cobertos na tabela de paridade.
   * AQUI fica o que o teste sempre quis medir: um tipo que NINGUEM conhece
   * ainda.
   *
   * O cenario que este teste fixa nao e hipotetico: durante um reinicio do
   * plugin, o processo filho vivo ainda e o do binario ANTERIOR. Uma ponta
   * antiga a receber uma mensagem nova tem de descartar e continuar -- nunca
   * cair, porque cair aqui e derrubar o canal de controlo do dono.
   */
  const FUTURAS: readonly string[] = [
    '{"v":2,"type":"futuro.desconhecido","x":1}',
    '{"v":2,"type":"outro.futuro"}',
  ]

  it('cada uma delas e `tipo-desconhecido`, e nada mais acontece', () => {
    for (const linha of FUTURAS) {
      assert.deepEqual(parseIpcLine(linha, 'to-worker'), { ok: false, reason: 'tipo-desconhecido' })
    }
  })

  it('intercaladas com mensagens conhecidas, so as conhecidas passam', () => {
    const b = montar()
    b.entrada.write(`${FUTURAS[0] ?? ''}\n`)
    b.entrada.write(serializeIpcMessage(INTENCAO, 'to-host'))
    b.entrada.write(`${FUTURAS[1] ?? ''}\n`)
    b.entrada.write(serializeIpcMessage({ ...INTENCAO, requestId: 'r2' }, 'to-host'))

    assert.equal(b.recebidas.length, 2, 'as conhecidas passaram todas')
    assert.equal(b.canal.stats.malformed, 2)
    assert.equal(b.escrito().split('\n').filter((l) => l !== '').length, 2, 'e cada uma recebeu ack')
  })
})

/* ========================================================================== */
/* Forma das mensagens -- as clausulas "sse" do contrato                      */
/* ========================================================================== */

describe('as clausulas SSE do contrato sao impostas nos dois sentidos', () => {
  it('`url` fora de READY e recusada -- e ela e informacao de operacao', () => {
    assert.deepEqual(
      parseIpcLine('{"v":2,"type":"state","state":"STARTING","seq":1,"url":"https://x.com","expiresAt":1}', 'to-worker'),
      { ok: false, reason: 'forma-invalida' },
    )
    assert.throws(
      () =>
        serializeIpcMessage(
          { v: 2, type: 'state', state: 'DEGRADED', seq: 1, url: 'https://x.trycloudflare.com', expiresAt: 1 },
          'to-worker',
        ),
      (error: unknown) => error instanceof IpcChannelError && error.code === 'IPC_MESSAGE_INVALID',
    )
  })

  it('READY SEM `url` tambem e recusado: o "sse" corre nos dois sentidos', () => {
    assert.deepEqual(parseIpcLine('{"v":2,"type":"state","state":"READY","seq":1}', 'to-worker'), {
      ok: false,
      reason: 'forma-invalida',
    })
  })

  it('a URL tem de ser https: um esquema arbitrario nao chega ao Telegram', () => {
    for (const url of ['http://x.trycloudflare.com', 'javascript:alert(1)', 'file:///etc/passwd']) {
      assert.deepEqual(
        parseIpcLine(`{"v":2,"type":"state","state":"READY","seq":1,"expiresAt":1,"url":${JSON.stringify(url)}}`, 'to-worker'),
        { ok: false, reason: 'forma-invalida' },
        url,
      )
    }
  })

  it('`code` presente SSE result==="rejected"', () => {
    assert.deepEqual(
      parseIpcLine('{"v":2,"type":"ack","requestId":"r","result":"accepted","state":"READY","code":"INTERNAL"}', 'to-worker'),
      { ok: false, reason: 'forma-invalida' },
    )
    assert.deepEqual(
      parseIpcLine('{"v":2,"type":"ack","requestId":"r","result":"rejected","state":"READY"}', 'to-worker'),
      { ok: false, reason: 'forma-invalida' },
    )
  })

  it('D29: um `rejected` com SHUTDOWN_IN_PROGRESS atravessa o canal intacto', () => {
    const message: IpcMessageToWorker = {
      v: 2,
      type: 'ack',
      requestId: '01J0000000000000000000000A',
      result: 'rejected',
      state: 'STOPPING',
      code: 'SHUTDOWN_IN_PROGRESS',
    }
    assert.deepEqual(
      parseIpcLine(serializeIpcMessage(message, 'to-worker').trimEnd(), 'to-worker'),
      { ok: true, message },
    )
  })
})

/* ========================================================================== */
/* S5 -- nonce opaco                                                          */
/* ========================================================================== */

describe('S5: o nonce viaja OPACO', () => {
  it('qualquer texto opaco atravessa sem interpretacao', () => {
    for (const nonce of ['01J0X', 'ja-consumido', 'expirado-ha-uma-hora', 'x'.repeat(128)]) {
      const message: IpcIntentMessage = { ...INTENCAO, nonce }
      const verdict = parseIpcLine(serializeIpcMessage(message, 'to-host').trimEnd(), 'to-host')
      assert.equal(verdict.ok && verdict.message.type === 'intent' && verdict.message.nonce, nonce)
    }
  })

  it('a intencao SEM nonce nao ganha um por omissao', () => {
    const verdict = parseIpcLine(serializeIpcMessage(INTENCAO, 'to-host').trimEnd(), 'to-host')
    assert.equal(verdict.ok && Object.hasOwn(verdict.message, 'nonce'), false)
  })
})

/* ========================================================================== */
/* EMENDA ONDA-1-PAREAR-VIA-PAINEL: `pairing.success` worker -> host          */
/* ========================================================================== */

describe('pairing.success (worker -> host): o handshake fecha-com-pairing.owner', () => {
  it('o handler montado recebe o aviso e o RETORNO vira o reply (pairing.owner)', async () => {
    const { log } = makeLog()
    const entrada = new PassThrough()
    const saida = new PassThrough()
    let avisos: IpcPairingSuccessMessage[] = []
    const canal = createHostIpcChannel({
      input: entrada,
      output: saida,
      log,
      secrets: (): readonly string[] => [],
      onIntent: () => ({ v: 2, type: 'ack', requestId: 'r', result: 'accepted', state: 'STARTING' }),
      onPairingSuccess: (msg): IpcMessageToWorker => {
        avisos.push(msg)
        return { v: 2, type: 'pairing.owner', from: msg.from, chat: msg.chat, pairedAt: msg.pairedAt }
      },
    })
    const aviso: IpcPairingSuccessMessage = { v: 2, type: 'pairing.success', from: '111', chat: '222', pairedAt: 1_700_000_000_000 }
    entrada.write(serializeIpcMessage(aviso, 'to-host'))
    await new Promise((r) => setImmediate(r))
    assert.equal(avisos.length, 1)
    assert.deepEqual(avisos[0], aviso)
    const linha = saida.read()?.toString() ?? ''
    assert.ok(linha.includes('"type":"pairing.owner"'), 'o reply do host e pairing.owner')
    assert.ok(linha.includes('"from":"111"') && linha.includes('"chat":"222"'), 'os dois eixos devolvidos como string (V2)')
    canal.dispose()
  })

  it('SEM handler, o canal responde error INTERNAL (fail-closed: nao grava dono nao confirmado)', async () => {
    const { log } = makeLog()
    const entrada = new PassThrough()
    const saida = new PassThrough()
    const canal = createHostIpcChannel({
      input: entrada,
      output: saida,
      log,
      secrets: (): readonly string[] => [],
      onIntent: () => ({ v: 2, type: 'ack', requestId: 'r', result: 'accepted', state: 'STARTING' }),
    })
    const aviso: IpcPairingSuccessMessage = { v: 2, type: 'pairing.success', from: '111', chat: '222', pairedAt: 1_700_000_000_000 }
    entrada.write(serializeIpcMessage(aviso, 'to-host'))
    await new Promise((r) => setImmediate(r))
    const linha = saida.read()?.toString() ?? ''
    assert.ok(linha.includes('"type":"error"'), 'responde error')
    assert.ok(linha.includes('"code":"INTERNAL"'), 'com INTERNAL')
    canal.dispose()
  })

  it('o tipo NAO e legal no sentido errado (to-worker): rejeitado por S4', () => {
    const answer: IpcPairingSuccessMessage = { v: 2, type: 'pairing.success', from: '111', chat: '222', pairedAt: 1_700_000_000_000 }
    // Serializar como to-worker tem de recusar (raio do sentido nao o conhece).
    assert.throws(() => serializeIpcMessage(answer, 'to-worker'), IpcChannelError)
    // E como to-host, parse de um tipo fora da allowlist -> tipo-desconhecido.
    const verdict = parseIpcLine('{"v":2,"type":"pairing.success","from":1,"chat":2,"pairedAt":3}', 'to-worker')
    assert.deepEqual(verdict, { ok: false, reason: 'tipo-desconhecido' })
  })
})

/* ========================================================================== */
/* Backpressure: a triagem por TIPO, que o contrato exige                     */
/* ========================================================================== */

/**
 * Um `Writable` cujos `callback` o teste liberta a mao. E o modelo fiel de um
 * pipe cujo leitor parou: os bytes ficam na fila interna, `writableLength`
 * cresce, e o `'drain'` so chega quando o outro lado volta a ler.
 *
 * (Um `PassThrough` nao serve -- ele passa o que recebe para o lado legivel e
 * `writableLength` fica sempre em zero, ou seja, mente sobre o cenario.)
 */
function saidaControlada(): { stream: Writable; libertar(): void; escrito(): string } {
  /** Enquanto `true`, cada `_write` fica pendurado -- o leitor "parou". */
  let bloqueado = true
  const pendentes: Array<() => void> = []
  const partes: string[] = []

  const stream = new Writable({
    highWaterMark: 256,
    write(chunk, _encoding, callback): void {
      partes.push(String(chunk))
      // Um `Writable` entrega UM chunk de cada vez ao `_write`; libertar so o
      // callback corrente avanca so um. Dai o laco em `libertar()`.
      if (bloqueado) {
        pendentes.push(callback as () => void)
        return
      }
      callback()
    },
  })

  return {
    stream,
    escrito: (): string => partes.join(''),
    libertar: (): void => {
      bloqueado = false
      while (pendentes.length > 0) pendentes.shift()?.()
    },
  }
}

function montarSaturado(maxPendingBytes = 512): {
  canal: HostIpcChannel
  entrada: PassThrough
  saida: Writable
  libertar(): void
  escrito(): string
  linhas: Linha[]
  recebidas: IpcIntentMessage[]
} {
  const { log, linhas } = makeLog()
  const entrada = new PassThrough()
  const { stream, libertar, escrito } = saidaControlada()
  const recebidas: IpcIntentMessage[] = []

  const canal = createHostIpcChannel({
    input: entrada,
    output: stream,
    log,
    secrets: (): readonly string[] => [],
    maxPendingBytes,
    onIntent: (intent): IpcMessageToWorker => {
      recebidas.push(intent)
      return { v: 2, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'STARTING' }
    },
  })

  return { canal, entrada, saida: stream, libertar, escrito, linhas, recebidas }
}

describe('backpressure: `state` coalesce, `ack` e `error` NUNCA sao descartados', () => {
  it('as difusoes de `state` coalescem em vez de crescerem a fila', () => {
    const b = montarSaturado()
    for (let seq = 0; seq < 500; seq += 1) b.canal.send({ v: 2, type: 'state', state: 'STOPPED', seq })

    assert.ok(b.canal.stats.coalesced > 0, 'tem de ter havido coalescencia')
    assert.equal(b.canal.stats.dropped, 0, 'coalescer NAO e descartar')
    assert.ok(b.saida.writableLength <= 512 + 256, `fila em ${String(b.saida.writableLength)}`)
    // F6: UMA linha por EPISODIO. A versao anterior emitia uma por mensagem --
    // 14 771 (~1,6 MB) num so burst, que e trocar memoria por volume de log.
    assert.equal(
      b.linhas.filter((l) => l.level === 'warn' && l.message.includes('saturado')).length,
      1,
      'o aviso de saturacao e um por episodio, nao um por mensagem',
    )
  })

  it('>>> saturado, uma intencao do dono CONTINUA a receber resposta <<<', () => {
    const b = montarSaturado()
    for (let seq = 0; seq < 500; seq += 1) b.canal.send({ v: 2, type: 'state', state: 'STOPPED', seq })

    const antes = b.canal.stats.sent
    const filaAntes = b.saida.writableLength

    // O cenario que o contrato protege: `/emergencia` chega NO estado degradado
    // para que o teto existe. Se o `ack` fosse descartado com o `state`, a
    // intencao executava no host e o dono ficava com a barra eterna.
    b.entrada.write(serializeIpcMessage({ ...INTENCAO, intent: 'emergency' }, 'to-host'))

    assert.equal(b.recebidas.length, 1, 'a intencao foi decidida')
    assert.equal(b.canal.stats.sent, antes + 1, 'e a resposta SAIU')
    assert.ok(b.saida.writableLength > filaAntes, 'os bytes do ack estao mesmo na fila')
    assert.equal(b.canal.stats.dropped, 0)
  })

  it('`error` tambem atravessa o teto suave', () => {
    const b = montarSaturado()
    for (let seq = 0; seq < 500; seq += 1) b.canal.send({ v: 2, type: 'state', state: 'STOPPED', seq })

    const antes = b.canal.stats.sent
    assert.equal(
      b.canal.send({ v: 2, type: 'error', code: 'RATE_LIMITED', message: 'devagar' }),
      true,
    )
    assert.equal(b.canal.stats.sent, antes + 1)
  })

  it('ao drenar sai a difusao MAIS RECENTE, e o resumo e uma linha so', async () => {
    const b = montarSaturado()
    for (let seq = 0; seq < 500; seq += 1) b.canal.send({ v: 2, type: 'state', state: 'STOPPED', seq })
    assert.ok(b.canal.stats.coalesced > 0)

    // O worker volta a ler: o `'drain'` chega e o canal entrega o que reteve.
    b.libertar()
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))

    const linhasEscritas = b.escrito().split('\n').filter((l) => l !== '')
    assert.ok(linhasEscritas.length < 500, `sairam ${String(linhasEscritas.length)} de 500`)

    // O QUE COALESCER SIGNIFICA: nao se perde a ULTIMA. O `seq` mais alto -- o
    // unico estado que ainda descreve a realidade -- TEM de chegar.
    const ultima = linhasEscritas.at(-1) ?? ''
    assert.deepEqual(parseIpcLine(ultima, 'to-worker'), {
      ok: true,
      message: { v: 2, type: 'state', state: 'STOPPED', seq: 499 },
    })

    assert.equal(
      b.linhas.filter((l) => l.level === 'info' && l.message.includes('drenou')).length,
      1,
      'o fim do episodio e UMA linha com o total',
    )
  })

  it('acima do teto DURO o canal declara-se INVIAVEL -- terminal e observavel', () => {
    const b = montarSaturado()
    // Muitos `ack` (que nao coalescem) empurram a fila para lá do teto duro.
    for (let i = 0; i < 200; i += 1) {
      b.entrada.write(
        serializeIpcMessage({ ...INTENCAO, requestId: `01J000000000000000000000${String(i % 10)}` }, 'to-host'),
      )
    }
    // O teto duro deste canal e o valor por omissao (4 MiB); forca-se com um
    // canal proprio de teto minusculo, que e o mesmo caminho de codigo.
    const { log, linhas } = makeLog()
    const { stream } = saidaControlada()
    const canal = createHostIpcChannel({
      input: new PassThrough(),
      output: stream,
      log,
      secrets: (): readonly string[] => [],
      maxPendingBytes: 64,
      overwhelmedBytes: 256,
      onIntent: (i): IpcMessageToWorker => ({
        v: 2,
        type: 'ack',
        requestId: i.requestId,
        result: 'noop',
        state: 'READY',
      }),
    })

    for (let i = 0; i < 100; i += 1) {
      canal.send({ v: 2, type: 'ack', requestId: 'r', result: 'noop', state: 'READY' })
    }

    assert.equal(canal.stats.overwhelmed, true, 'estado TERMINAL observavel')
    assert.equal(canal.send({ v: 2, type: 'ack', requestId: 'r', result: 'noop', state: 'READY' }), false)
    assert.equal(
      linhas.filter((l) => l.level === 'error' && l.message.includes('INVIAVEL')).length,
      1,
      'ruidoso uma vez -- um limite silencioso e um defeito por descobrir',
    )
    canal.dispose()
  })

  it('sem `stdin` o canal grita UMA vez e recusa tudo, sem lancar', () => {
    const b = montar({ semSaida: true })
    assert.equal(b.canal.send({ v: 2, type: 'state', state: 'STOPPED', seq: 1 }), false)
    assert.equal(
      b.linhas.filter((l) => l.level === 'error' && l.message.includes('SEM sentido host->worker')).length,
      1,
    )
  })

  it('uma mensagem que viola o contrato nao sai, e o erro fica no log', () => {
    const b = montar()
    const invalida = { v: 2, type: 'state', state: 'STOPPED', seq: 1, url: 'https://x' } as IpcMessageToWorker
    assert.equal(b.canal.send(invalida), false)
    assert.equal(b.escrito(), '')
    assert.equal(b.linhas.some((l) => l.level === 'error' && l.message.includes('IPC_MESSAGE_INVALID')), true)
  })

  it('o disposer e SINCRONO e IDEMPOTENTE: 3 chamadas = 1 desarme', () => {
    const b = montar()
    assert.equal(b.entrada.listenerCount('data'), 1)

    b.canal.dispose()
    b.canal.dispose()
    b.canal.dispose()

    assert.equal(b.entrada.listenerCount('data'), 0)
    // O absorvedor de 'error' FICA: um EventEmitter sem ele LANCA no host.
    assert.equal(b.entrada.listenerCount('error'), 1)
    assert.equal(b.canal.send({ v: 2, type: 'state', state: 'STOPPED', seq: 1 }), false)
  })

  it('um EPIPE no stdin do filho morto e absorvido, nao propagado', () => {
    const b = montar()
    // Sem absorvedor, isto LANCA e derruba o processo hospedeiro.
    assert.doesNotThrow(() => b.saida.emit('error', new Error('EPIPE')))
    assert.equal(b.linhas.some((l) => l.level === 'debug' && l.message.includes('EPIPE')), true)
  })
})

/* ========================================================================== */
/* F1 -- o log do canal passa por redact()                                    */
/* ========================================================================== */

describe('nada do que este canal escreve no log leva segredo em claro', () => {
  const TOKEN = '7712345678:AAH9zQvJ4Kx7pLmN3rTyUiOpAsDfGhJkLzX'

  /**
   * A ASSIMETRIA QUE ISTO FECHA. `attachStreamLogging` ja mascarava cada linha
   * de `stderr` do FILHO. O mesmo token, impresso pelo HOST ao registar a
   * excecao de um decisor de intencoes, ficava EM CLARO no log do plano de
   * controlo -- e o dono cola o log num relatorio de bug e entrega o bot.
   */
  function comSegredo(lancar: () => never): { linhas: Linha[]; entrada: PassThrough } {
    const { log, linhas } = makeLog()
    const entrada = new PassThrough()
    createHostIpcChannel({
      input: entrada,
      output: new PassThrough(),
      log,
      secrets: (): readonly string[] => [TOKEN],
      onIntent: lancar,
    })
    return { linhas, entrada }
  }

  const FORMAS: ReadonlyArray<readonly [string, () => never]> = [
    [
      'Error com o URL da API do Telegram',
      (): never => {
        throw new Error(`ECONNRESET em https://api.telegram.org/bot${TOKEN}/getUpdates`)
      },
    ],
    [
      'string nua (passa por String(error))',
      (): never => {
        throw `falhou com ${TOKEN}`
      },
    ],
    [
      'objeto com toString',
      (): never => {
        throw { toString: (): string => `bot${TOKEN} recusado` }
      },
    ],
  ]

  for (const [nome, lancar] of FORMAS) {
    it(`${nome}: o token sai MASCARADO`, () => {
      const c = comSegredo(lancar)
      c.entrada.write(serializeIpcMessage(INTENCAO, 'to-host'))

      const registos = c.linhas.map((l) => l.message)
      assert.equal(registos.some((m) => m.includes('lancou')), true, 'o defeito TEM de ser visivel')
      for (const m of registos) {
        assert.equal(m.includes(TOKEN), false, `token em claro: ${m}`)
      }
      assert.equal(registos.some((m) => m.includes('[REDACTED]')), true, 'e visivelmente cortado')
    })
  }

  it('o absorvedor de `error` do stream tambem mascara', () => {
    const { log, linhas } = makeLog()
    const saida = new PassThrough()
    createHostIpcChannel({
      input: new PassThrough(),
      output: saida,
      log,
      secrets: (): readonly string[] => [TOKEN],
      onIntent: (i): IpcMessageToWorker => ({
        v: 2,
        type: 'ack',
        requestId: i.requestId,
        result: 'noop',
        state: 'READY',
      }),
    })

    saida.emit('error', new Error(`EPIPE ao falar com bot${TOKEN}`))
    for (const l of linhas) assert.equal(l.message.includes(TOKEN), false)
  })
})

/* ========================================================================== */
/* V2 — a politica minima de isId: trim + nao vazio + sem controlo + teto     */
/* (EMENDA ONDA-1-IPC-ENVELOPE-STRING: from/chat sao STRING; a forma nao      */
/* valida FORMATO de provedor nenhum — um snowflake do Discord, um id de      */
/* Matrix, um `-100...` de grupo sao todos strings utilizaveis)               */
/* ========================================================================== */

describe('V2 — a politica minima de `from`/`chat` (isId)', () => {
  it('um id de 64 caracteres passa; de 65 cai (MAX_ID_CHARS)', () => {
    const ok = `{"v":2,"type":"intent","intent":"emergency","requestId":"r","from":"${'a'.repeat(64)}","chat":"1"}`
    assert.deepEqual(parseIpcLine(ok, 'to-host'), {
      ok: true,
      message: { v: 2, type: 'intent', intent: 'emergency', requestId: 'r', from: 'a'.repeat(64), chat: '1' },
    })
    const estoura = `{"v":2,"type":"intent","intent":"emergency","requestId":"r","from":"${'a'.repeat(65)}","chat":"1"}`
    assert.deepEqual(parseIpcLine(estoura, 'to-host'), { ok: false, reason: 'forma-invalida' })
  })

  it('carater de controlo em from OU chat e recusado (ruido de terminal nao viaja)', () => {
    // Escapes JSON validos (BEL, CR, LF) que o JSON.parse converte em
    // carateres de controlo reais — e o `hasControlChar` da politica isId
    // recusa. Um `\n` dentro de um id partiria o enquadramento de linha (S1).
    for (const escape of ['\\u0007', '\\r', '\\n']) {
      const comFrom = `{"v":2,"type":"intent","intent":"emergency","requestId":"r","from":"${escape}","chat":"1"}`
      assert.deepEqual(parseIpcLine(comFrom, 'to-host'), { ok: false, reason: 'forma-invalida' }, `from com ${escape}`)
      const comChat = `{"v":2,"type":"intent","intent":"emergency","requestId":"r","from":"1","chat":"${escape}"}`
      assert.deepEqual(parseIpcLine(comChat, 'to-host'), { ok: false, reason: 'forma-invalida' }, `chat com ${escape}`)
    }
  })

  it('um id com espacos em volta passa (trim nao vazio) e viaja como veio', () => {
    // A politica e "trim + nao vazio", nao "ja trimado": o codec VALIDA a
    // forma (a normalizacao acontece na fronteira do provedor, no worker).
    const linha = '{"v":2,"type":"intent","intent":"tunnel.status","requestId":"r","from":"  42  ","chat":"1"}'
    assert.deepEqual(parseIpcLine(linha, 'to-host'), {
      ok: true,
      message: { v: 2, type: 'intent', intent: 'tunnel.status', requestId: 'r', from: '  42  ', chat: '1' },
    })
  })

  it('o id vazio (ou so espacos) nao designa ninguem', () => {
    assert.deepEqual(parseIpcLine('{"v":2,"type":"intent","intent":"emergency","requestId":"r","from":"","chat":"1"}', 'to-host'), {
      ok: false,
      reason: 'forma-invalida',
    })
  })
})

/* ========================================================================== */
/* Tetos de transporte: requestId/nonce/mensagem/url/notify                   */
/* ========================================================================== */

describe('os tetos de transporte do canal', () => {
  it('requestId: 64 passa, 65 cai, carater de controlo cai', () => {
    const ok = `{"v":2,"type":"intent","intent":"tunnel.status","requestId":"${'r'.repeat(64)}","from":"1","chat":"1"}`
    assert.equal(parseIpcLine(ok, 'to-host').ok, true)
    const estoura = `{"v":2,"type":"intent","intent":"tunnel.status","requestId":"${'r'.repeat(65)}","from":"1","chat":"1"}`
    assert.deepEqual(parseIpcLine(estoura, 'to-host'), { ok: false, reason: 'forma-invalida' })
    const comControlo = '{"v":2,"type":"intent","intent":"tunnel.status","requestId":"r\\u0007","from":"1","chat":"1"}'
    assert.deepEqual(parseIpcLine(comControlo, 'to-host'), { ok: false, reason: 'forma-invalida' })
  })

  it('nonce: 128 passa, 129 cai, vazio cai, carater de controlo cai (higiene de transporte, S5)', () => {
    for (const nonce of ['x'.repeat(128), 'opaco-01J']) {
      const linha = `{"v":2,"type":"intent","intent":"tunnel.up","requestId":"r","from":"1","chat":"1","nonce":"${nonce}"}`
      assert.equal(parseIpcLine(linha, 'to-host').ok, true, `nonce de ${String(nonce.length)} chars`)
    }
    const estoura = `{"v":2,"type":"intent","intent":"tunnel.up","requestId":"r","from":"1","chat":"1","nonce":"${'x'.repeat(129)}"}`
    assert.deepEqual(parseIpcLine(estoura, 'to-host'), { ok: false, reason: 'forma-invalida' })
    assert.deepEqual(
      parseIpcLine('{"v":2,"type":"intent","intent":"tunnel.up","requestId":"r","from":"1","chat":"1","nonce":""}', 'to-host'),
      { ok: false, reason: 'forma-invalida' },
    )
    assert.deepEqual(
      parseIpcLine('{"v":2,"type":"intent","intent":"tunnel.up","requestId":"r","from":"1","chat":"1","nonce":"n\\u0007"}', 'to-host'),
      { ok: false, reason: 'forma-invalida' },
    )
  })

  it('`error.message`: 4096 (o limite do Telegram) passa; 4097 cai; CR e controlo caem; LF e legitimo', () => {
    const noLimite = { v: 2, type: 'error', code: 'INTERNAL', message: 'm'.repeat(4096) } as const
    assert.deepEqual(parseIpcLine(serializeIpcMessage(noLimite, 'to-worker').trimEnd(), 'to-worker'), {
      ok: true,
      message: noLimite,
    })
    const acima = JSON.stringify({ v: 2, type: 'error', code: 'INTERNAL', message: 'm'.repeat(4097) })
    assert.deepEqual(parseIpcLine(acima, 'to-worker'), { ok: false, reason: 'forma-invalida' })
    assert.deepEqual(
      parseIpcLine('{"v":2,"type":"error","code":"INTERNAL","message":"com\\r"}', 'to-worker'),
      { ok: false, reason: 'forma-invalida' },
    )
    assert.deepEqual(
      parseIpcLine('{"v":2,"type":"error","code":"INTERNAL","message":"com\\u0007"}', 'to-worker'),
      { ok: false, reason: 'forma-invalida' },
    )
  })

  it('`notify.texto`: 4097 cai e CR cai (o LF multilinha ja e coberto na paridade)', () => {
    assert.deepEqual(
      parseIpcLine(`{"v":2,"type":"notify","texto":"${'t'.repeat(4097)}"}`, 'to-worker'),
      { ok: false, reason: 'forma-invalida' },
    )
    assert.deepEqual(parseIpcLine('{"v":2,"type":"notify","texto":"com\\r"}', 'to-worker'), {
      ok: false,
      reason: 'forma-invalida',
    })
  })

  it('a URL do tunel: 2048 passa, 2049 cai', () => {
    // MAX_URL_CHARS = 2048: `https://` (8) + dominio (2036) + `.com` (4).
    const url = `https://${'u'.repeat(2036)}.com`
    assert.equal(url.length, 2048)
    assert.deepEqual(
      parseIpcLine(`{"v":2,"type":"state","state":"READY","seq":1,"expiresAt":1,"url":"${url}"}`, 'to-worker'),
      { ok: true, message: { v: 2, type: 'state', state: 'READY', seq: 1, url, expiresAt: 1 } },
    )
    const acima = `https://${'u'.repeat(2037)}.com`
    assert.equal(acima.length, 2049)
    assert.deepEqual(
      parseIpcLine(`{"v":2,"type":"state","state":"READY","seq":1,"expiresAt":1,"url":"${acima}"}`, 'to-worker'),
      { ok: false, reason: 'forma-invalida' },
    )
  })

  it('`seq` tem de ser numero finito: null (o JSON nao tem NaN/Infinity), string ou booleano caem', () => {
    for (const seq of ['null', '"9"', 'true']) {
      assert.deepEqual(
        parseIpcLine(`{"v":2,"type":"state","state":"STOPPED","seq":${seq}}`, 'to-worker'),
        { ok: false, reason: 'forma-invalida' },
        `seq=${seq}`,
      )
    }
  })
})

/* ========================================================================== */
/* A escrita tambem defende a linha: um valor que o contrato recusa NAO sai,  */
/* e um BigInt (que o JSON.stringify nao sabe escrever) e recusado ANTES      */
/* ========================================================================== */

describe('a escrita recusa antes de emitir', () => {
  it('um BigInt em `seq` e recusado como IPC_MESSAGE_INVALID (a validacao precede o stringify)', () => {
    const invalida = { v: 2, type: 'state', state: 'STOPPED', seq: 1n } as unknown as IpcMessageToWorker
    assert.throws(
      () => serializeIpcMessage(invalida, 'to-worker'),
      (error: unknown) => error instanceof IpcChannelError && error.code === 'IPC_MESSAGE_INVALID',
    )
  })
})

/* ========================================================================== */
/* EMENDA-COSTURA-5: `nonce.request` SEM tratador -> error INTERNAL (o        */
/* respondedor fail-closed do proprio canal — CTL-023)                        */
/* ========================================================================== */

describe('nonce.request sem tratador montado: fail-closed e visivel', () => {
  it('o canal responde error INTERNAL ecoando o requestId (sem nonce nao autoriza nada)', async () => {
    const b = montar()
    b.entrada.write('{"v":2,"type":"nonce.request","acao":"start","requestId":"req-sem-tratador"}\n')

    await new Promise((resolve) => setImmediate(resolve))
    const saida = b.escrito()
    assert.ok(saida.includes('"type":"error"'), 'a resposta e um error')
    assert.ok(saida.includes('"code":"INTERNAL"'), 'com INTERNAL (fail-closed)')
    assert.ok(saida.includes('req-sem-tratador'), 'o requestId ecoado para o worker correlacionar')
    assert.equal(b.canal.stats.received, 1, 'a linha valida foi recebida')
    b.canal.dispose()
  })

  it('`error` com `requestId` presente round-tripa fiel (o requestId opcional do contrato)', () => {
    const message: IpcMessageToWorker = {
      v: 2,
      type: 'error',
      requestId: 'req-do-erro',
      code: 'RATE_LIMITED',
      message: 'devagar',
    }
    assert.deepEqual(parseIpcLine(serializeIpcMessage(message, 'to-worker').trimEnd(), 'to-worker'), {
      ok: true,
      message,
    })
  })
})

/* ========================================================================== */
/* EMENDA ONDA-4-AGENTS-HOST: o payload `params` e a mensagem `agent.report`   */
/* ========================================================================== */

describe('o payload `params` das intencoes de agente (presente sse a intent o exige)', () => {
  it('agent.dispatch SEM params (ou com skill/prompt ausente) e forma-invalida — fail-closed', () => {
    for (const linha of [
      '{"v":2,"type":"intent","intent":"agent.dispatch","requestId":"r","from":"1","chat":"1"}',
      '{"v":2,"type":"intent","intent":"agent.dispatch","requestId":"r","from":"1","chat":"1","params":{}}',
      '{"v":2,"type":"intent","intent":"agent.dispatch","requestId":"r","from":"1","chat":"1","params":{"prompt":"p"}}',
      '{"v":2,"type":"intent","intent":"agent.dispatch","requestId":"r","from":"1","chat":"1","params":{"skill":"s"}}',
    ]) {
      assert.deepEqual(parseIpcLine(linha, 'to-host'), { ok: false, reason: 'forma-invalida' }, linha)
    }
  })

  it('agent.dispatch com skill fora da grammar (maiuscula/espaco) e forma-invalida', () => {
    for (const skill of ['Skill-Com-Maiuscula', 'com espaço', 'com_underscore', '']) {
      const linha = `{"v":2,"type":"intent","intent":"agent.dispatch","requestId":"r","from":"1","chat":"1","params":${JSON.stringify({ skill, prompt: 'p' })}}`
      assert.deepEqual(parseIpcLine(linha, 'to-host'), { ok: false, reason: 'forma-invalida' }, skill)
    }
  })

  it('agent.cancel sem agentId e forma-invalida; agent.status NAO transporta params', () => {
    assert.deepEqual(
      parseIpcLine('{"v":2,"type":"intent","intent":"agent.cancel","requestId":"r","from":"1","chat":"1","params":{}}', 'to-host'),
      { ok: false, reason: 'forma-invalida' },
    )
    // `agent.status` com params: o campo e DESCARTADO pela reconstrucao (o
    // contrato nao o declara) — a mensagem chega ao consumidor sem ele.
    const verdict = parseIpcLine(
      '{"v":2,"type":"intent","intent":"agent.status","requestId":"r","from":"1","chat":"1","params":{"agentId":"x"}}',
      'to-host',
    )
    assert.equal(verdict.ok, true)
    assert.equal(verdict.ok && Object.hasOwn(verdict.message, 'params'), false)
  })

  it('os params nao viajam nas intents de TUNEL (campo extra descartado pela reconstrucao)', () => {
    const verdict = parseIpcLine(
      '{"v":2,"type":"intent","intent":"emergency","requestId":"r","from":"1","chat":"1","params":{"skill":"x"}}',
      'to-host',
    )
    assert.equal(verdict.ok, true)
    assert.equal(verdict.ok && Object.hasOwn(verdict.message, 'params'), false)
  })

  it('a reconstrucao do params NAO transporta campos inventados', () => {
    const verdict = parseIpcLine(
      '{"v":2,"type":"intent","intent":"agent.dispatch","requestId":"r","from":"1","chat":"1","nonce":"n","params":{"skill":"3d-exemplo","prompt":"p","agentId":"falso","extra":true}}',
      'to-host',
    )
    assert.equal(verdict.ok, true)
    assert.deepEqual(
      verdict.ok && verdict.message.type === 'intent' ? verdict.message.params : undefined,
      { skill: '3d-exemplo', prompt: 'p' },
    )
  })

  it('o prompt tem teto de transporte (4096): acima, forma-invalida', () => {
    const acima = 'p'.repeat(4097)
    const linha = `{"v":2,"type":"intent","intent":"agent.dispatch","requestId":"r","from":"1","chat":"1","params":${JSON.stringify({ skill: 's', prompt: acima })}}`
    assert.deepEqual(parseIpcLine(linha, 'to-host'), { ok: false, reason: 'forma-invalida' })
    const noLimite = 'p'.repeat(4096)
    const ok = `{"v":2,"type":"intent","intent":"agent.dispatch","requestId":"r","from":"1","chat":"1","params":${JSON.stringify({ skill: 's', prompt: noLimite })}}`
    assert.equal(parseIpcLine(ok, 'to-host').ok, true)
  })
})

describe('agent.report (host -> worker)', () => {
  it('round-tripa a lista completa com os quatro status e o summary opcional', () => {
    const mensagem = {
      v: 2,
      type: 'agent.report',
      runs: [
        { id: 'ABCD1234', skill: 'deep-orchestrator-agent-skill', status: 'running', startedAt: 1_700_000_000_000 },
      ],
    } as const
    assert.deepEqual(parseIpcLine(serializeIpcMessage(mensagem, 'to-worker').trimEnd(), 'to-worker'), {
      ok: true,
      message: mensagem,
    })
  })

  it('a lista VAZIA e valida (nao ha runs em memoria)', () => {
    const mensagem = { v: 2, type: 'agent.report', runs: [] } as const
    assert.deepEqual(parseIpcLine(serializeIpcMessage(mensagem, 'to-worker').trimEnd(), 'to-worker'), {
      ok: true,
      message: mensagem,
    })
  })

  it('status fora do vocabulario, skill fora da grammar, id vazio, startedAt nao-numerico: forma-invalida', () => {
    for (const linha of [
      '{"v":2,"type":"agent.report","runs":[{"id":"ABCD1234","skill":"s","status":"rodando","startedAt":1}]}',
      '{"v":2,"type":"agent.report","runs":[{"id":"ABCD1234","skill":"Skill-Maiuscula","status":"done","startedAt":1}]}',
      '{"v":2,"type":"agent.report","runs":[{"id":"","skill":"s","status":"done","startedAt":1}]}',
      '{"v":2,"type":"agent.report","runs":[{"id":"ABCD1234","skill":"s","status":"done","startedAt":"agora"}]}',
      '{"v":2,"type":"agent.report","runs":[{"id":"ABCD1234","skill":"s","status":"done","startedAt":1,"summary":"a\\u0007b"}]}',
      '{"v":2,"type":"agent.report","runs":"nao-e-array"}',
      '{"v":2,"type":"agent.report","runs":[1]}',
    ]) {
      assert.deepEqual(parseIpcLine(linha, 'to-worker'), { ok: false, reason: 'forma-invalida' }, linha)
    }
  })

  it('o summary tem teto (512): acima, forma-invalida', () => {
    const acima = 's'.repeat(513)
    const linha = `{"v":2,"type":"agent.report","runs":[{"id":"ABCD1234","skill":"s","status":"done","startedAt":1,"summary":"${acima}"}]}`
    assert.deepEqual(parseIpcLine(linha, 'to-worker'), { ok: false, reason: 'forma-invalida' })
  })

  it('o array tem teto (64 runs): 65 entradas nao cabem numa linha do canal', () => {
    const runs = Array.from({ length: 64 }, (_, i) => ({ id: `ID${String(i).padStart(6, '0')}`, skill: 's', status: 'running', startedAt: 1 }))
    assert.equal(parseIpcLine(JSON.stringify({ v: 2, type: 'agent.report', runs }), 'to-worker').ok, true)
    runs.push({ id: 'EXTRA00', skill: 's', status: 'running', startedAt: 1 })
    assert.deepEqual(
      parseIpcLine(JSON.stringify({ v: 2, type: 'agent.report', runs }), 'to-worker'),
      { ok: false, reason: 'forma-invalida' },
    )
  })

  it('NUNCA e legal no sentido errado (to-host): rejeitado por S4', () => {
    const mensagem = { v: 2, type: 'agent.report', runs: [] } as const
    assert.throws(() => serializeIpcMessage(mensagem, 'to-host'), IpcChannelError)
  })
})

/* ========================================================================== */
/* Os ultimos caminhos de falha do canal (Onda 4)                              */
/* ========================================================================== */

describe('o handler de pairing.success que LANCA (fail-closed e visivel)', () => {
  it('vira error INTERNAL SEM requestId, e o defeito e registado', async () => {
    const { log, linhas } = makeLog()
    const entrada = new PassThrough()
    const saida = new PassThrough()
    const canal = createHostIpcChannel({
      input: entrada,
      output: saida,
      log,
      secrets: (): readonly string[] => [],
      onIntent: (): IpcMessageToWorker => ({
        v: 2,
        type: 'ack',
        requestId: 'r',
        result: 'accepted',
        state: 'STARTING',
      }),
      onPairingSuccess: (): IpcMessageToWorker => {
        throw new Error('pareamento avariado')
      },
    })
    const aviso: IpcPairingSuccessMessage = {
      v: 2,
      type: 'pairing.success',
      from: '111',
      chat: '222',
      pairedAt: 1_700_000_000_000,
    }
    entrada.write(serializeIpcMessage(aviso, 'to-host'))
    await new Promise((resolve) => setImmediate(resolve))

    const linha = saida.read()?.toString() ?? ''
    const resposta = JSON.parse(linha) as { type: string; code: string; requestId?: unknown }
    assert.equal(resposta.type, 'error')
    assert.equal(resposta.code, 'INTERNAL')
    assert.equal('requestId' in resposta, false, 'sem requestId: o erro nao e de uma intent')
    assert.equal(
      linhas.some((e) => e.level === 'error' && e.message.includes('O decisor de intencoes lancou')),
      true,
      'o defeito do handler e registado (mascarado)',
    )
    canal.dispose()
  })
})

/* ========================================================================== */
/* O drain que chega com a fila AINDA acima do teto suave                      */
/* ========================================================================== */

/** Um `state` READY com URL comprida (~200 bytes) — passa o teto suave. */
function estadoLongo(seq: number): IpcStateMessage {
  return {
    v: 2,
    type: 'state',
    state: 'READY',
    seq,
    url: `https://${'u'.repeat(120)}.trycloudflare.com`,
    expiresAt: 7,
  }
}

describe('o drain que chega com a fila AINDA acima do teto suave', () => {
  it('rearma o drain em vez de entregar a difusao retida fora do espaco', async () => {
    const { log } = makeLog()
    const entrada = new PassThrough()
    // Um Writable cujos `callback` o teste liberta UM de cada vez — o modelo de
    // um pipe cujo leitor voltou a ler SO UMA PARTE do que estava na fila.
    const pendentes: Array<() => void> = []
    const partes: string[] = []
    const saida = new Writable({
      highWaterMark: 64,
      write(chunk, _encoding, callback): void {
        partes.push(String(chunk))
        pendentes.push(callback as () => void)
      },
    })
    const libertarUm = (): void => {
      pendentes.shift()?.()
    }
    const canal = createHostIpcChannel({
      input: entrada,
      output: saida,
      log,
      secrets: (): readonly string[] => [],
      // Teto suave TINUSCULO: qualquer mensagem que fique na fila o ultrapassa.
      maxPendingBytes: 16,
      onIntent: (intent): IpcMessageToWorker => ({
        v: 2,
        type: 'ack',
        requestId: intent.requestId,
        result: 'noop',
        state: 'STOPPED',
      }),
    })

    // 1. estado longo (~200 bytes) entra DIRETO e fica pendurado no `_write`
    //    (leitor parado); a escrita cruza o highWaterMark e arma o needDrain.
    assert.equal(canal.send(estadoLongo(1)), true)
    // 2. um `notify` ESCREVE SEMPRE (nao coalesce): ~28 bytes na fila — o
    //    "resto" que o leitor ainda nao leu.
    assert.equal(canal.send({ v: 2, type: 'notify', texto: 'x' }), true)
    // 3. os `state` seguintes COALESCEM: a fila ja passou o teto suave (16). O
    //    primeiro entra como difusao PENDENTE; o segundo SUBSTITUI-o (o
    //    coalesced so conta a partir do segundo).
    assert.equal(canal.send(estadoLongo(2)), true)
    assert.equal(canal.send(estadoLongo(3)), true)
    assert.equal(canal.stats.coalesced >= 1, true)

    // O leitor volta a ler o estado longo: writableLength cai para os ~28 do
    // notify — abaixo do highWaterMark (64) mas AINDA acima do teto suave
    // (16). O 'drain' dispara e esvaziar TEM de rearmar em vez de entregar a
    // difusao retida.
    libertarUm()
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
    const aposODrainParcial = partes.join('')
    assert.equal(
      aposODrainParcial.includes('"seq":3'),
      false,
      'a difusao retida NAO sai num drain que ainda esta acima do teto suave',
    )
    assert.equal(aposODrainParcial.includes('"type":"notify"'), true, 'o notify ja tinha saido (escreve sempre)')

    // O leitor avanca mais um pouco e o host volta a escrever (um ack — que
    // ESCREVE SEMPRE): a fila cruza o highWaterMark de novo. Quando o notify e
    // o ack saem, o drain seguinte chega com a fila DENTRO do teto suave e a
    // difusao retida (a MAIS RECENTE) e entregue.
    assert.equal(canal.send({ v: 2, type: 'ack', requestId: 'r', result: 'noop', state: 'STOPPED' }), true)
    libertarUm() // o notify
    libertarUm() // o ack
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))

    const final = partes.join('')
    const estados = final
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { type: string; seq?: number })
      .filter((m) => m.type === 'state')
    assert.deepEqual(
      estados.map((e) => e.seq),
      [1, 3],
      'a sequencia e: estado 1 (direto) e estado 3 (a MAIS RECENTE, entregue no drain certo)',
    )
    canal.dispose()
  })
})

describe('a difusao retida quando o output MORRE a meio do episodio', () => {
  it('esvaziar com o output ja nao escrevivel desiste em silencio (a difusao perde-se, o canal nao)', async () => {
    const { log, linhas } = makeLog()
    const entrada = new PassThrough()
    const { stream, libertar, escrito } = saidaControlada()
    const canal = createHostIpcChannel({
      input: entrada,
      output: stream,
      log,
      secrets: (): readonly string[] => [],
      maxPendingBytes: 64,
      onIntent: (intent): IpcMessageToWorker => ({
        v: 2,
        type: 'ack',
        requestId: intent.requestId,
        result: 'accepted',
        state: 'STARTING',
      }),
    })

    // Enche a fila e retem uma difusao (o padrao do episodio de saturacao).
    for (let seq = 0; seq < 200; seq += 1) canal.send({ v: 2, type: 'state', state: 'STOPPED', seq })
    assert.ok(canal.stats.coalesced > 0, 'a difusao esta retida')
    assert.equal(canal.stats.dropped, 0)

    // O OUTPUT MORRE antes de drenar: o 'drain' que chegar nao tem para onde
    // escrever — esvaziar desiste em silencio em vez de lancar.
    stream.destroy()
    libertar()
    stream.emit('drain')
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(escrito().includes('"seq":199'), false, 'a difusao nao saiu (nao ha para onde)')
    assert.equal(
      linhas.some((e) => e.level === 'error'),
      false,
      'desistir de escrever para um stream morto NAO e um erro do canal',
    )
    canal.dispose()
  })
})

describe('o rearm do drain com teto suave DEGENERADO (defesa em profundidade)', () => {
  it('com maxPendingBytes negativo, o drain com a fila vazia REARMA em vez de entregar', async () => {
    // No Node 24 o 'drain' so dispara com a fila COMPLETAMENTE vazia — logo o
    // ramo `porEscrever() > maxPendingBytes` de esvaziar so e alcancavel com um
    // teto suave degenerado (negativo): mesmo vazio, "nao ha espaco". A guarda
    // rearma e nao entrega nada — nao assume que ha espaco so porque drenou.
    const { log } = makeLog()
    const entrada = new PassThrough()
    const { stream, libertar, escrito } = saidaControlada()
    const canal = createHostIpcChannel({
      input: entrada,
      output: stream,
      log,
      secrets: (): readonly string[] => [],
      maxPendingBytes: -1,
      onIntent: (intent): IpcMessageToWorker => ({
        v: 2,
        type: 'ack',
        requestId: intent.requestId,
        result: 'accepted',
        state: 'STARTING',
      }),
    })

    // Acks pendurados na fila ate cruzarem o highWaterMark (256): e a cruzada
    // que arma o needDrain — sem ela o 'drain' nunca e emitido pelo Node.
    for (let i = 0; i < 5; i += 1) {
      canal.send({ v: 2, type: 'ack', requestId: `r${i}`, result: 'accepted', state: 'STARTING' })
    }
    // A fila fica "saturada" mesmo vazia: cada estado coalesce de imediato.
    canal.send({ v: 2, type: 'state', state: 'STOPPED', seq: 1 })
    canal.send({ v: 2, type: 'state', state: 'STOPPED', seq: 2 })
    assert.ok(canal.stats.coalesced >= 1, 'a difusao esta retida mesmo com a fila vazia')

    // O leitor volta a ler: o 'drain' chega com a fila em ZERO — e ainda assim
    // esvaziar rearma (0 > -1) em vez de entregar a difusao retida.
    libertar()
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(
      escrito().includes('"seq":2'),
      false,
      'com o teto degenerado o drain rearma e NAO entrega a difusao retida',
    )
    canal.dispose()
  })
})
