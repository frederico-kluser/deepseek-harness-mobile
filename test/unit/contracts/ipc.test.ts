/**
 * `src/contracts/ipc.ts` — o CONTRATO congelado do canal host <-> worker.
 *
 * O ficheiro e quase so tipos; o unico valor em runtime e
 * {@link IPC_PROTOCOL_VERSION}. O que este teste prende e a LIGACAO entre o
 * valor congelado e o comportamento dos DOIS codecs (host `src/ipc/channel.ts`
 * e worker `worker/ipc.ts`):
 *
 *   - o constante e 2 (V2 — EMENDA ONDA-1-IPC-ENVELOPE-STRING);
 *   - o codec aceita EXATAMENTE a versao do contrato: uma mensagem montada com
 *     a constante round-tripa fiel, e a versao ANTERIOR (v:1, o envelope
 *     numerico legado) e a versao FUTURA caem na regra S4 — linha descartada,
 *     canal sobrevive. E isso que torna o bump de V1 -> V2 seguro: uma ponta
 *     antiga descarta a linha nova em vez de partir;
 *   - as QUATRO razoes de recusa do veredito sao as do contrato, produzidas
 *     por comportamento (S4 e um tipo de retorno, nao excecao);
 *   - uma snowflake do Discord (> 2^53) atravessa os DOIS codecs byte a byte,
 *     sem `Number(...)` nem truncagem (criterio de aceite 1 da onda).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { IPC_PROTOCOL_VERSION } from '../../../src/contracts/ipc.ts'
import {
  parseIpcLine as parseHost,
  serializeIpcMessage as serializeHost,
} from '../../../src/ipc/channel.ts'
import {
  parseWorkerIpcLine as parseWorker,
  serializeWorkerIpcMessage as serializeWorker,
} from '../../../worker/ipc.ts'

describe('o contrato IPC V2 — `IPC_PROTOCOL_VERSION`', () => {
  it('esta congelado em 2 (o envelope from/chat passou de number a string)', () => {
    // A EMENDA ONDA-1-IPC-ENVELOPE-STRING subiu a versao de 1 para 2: o
    // envelope V1 transportava `from`/`chat` numericos (heranca Telegram) e a
    // V2 transporta a string ja normalizada na fronteira do provedor.
    assert.equal(IPC_PROTOCOL_VERSION, 2)
  })

  it('e a MESMA constante que os dois codecs exigem: round trip fiel nos dois sentidos', () => {
    // Montada com a constante do contrato — nao com o literal `2` — a mensagem
    // atravessa o codec do host e o do worker byte a byte, sem divergir.
    const intent = {
      v: IPC_PROTOCOL_VERSION,
      type: 'intent',
      intent: 'tunnel.status',
      requestId: '01J0000000000000000000000A',
      from: '123456789',
      chat: '-1001234567890',
    } as const

    const linhaHost = serializeHost(intent, 'to-host')
    const linhaWorker = serializeWorker(intent, 'to-host')
    assert.equal(linhaWorker, linhaHost, 'os dois codecs serializam a mesma linha')

    const viaHost = parseHost(linhaHost.trimEnd(), 'to-host')
    const viaWorker = parseWorker(linhaWorker.trimEnd(), 'to-host')
    assert.deepEqual(viaWorker, viaHost, 'os dois codecs dao o mesmo veredito')
    assert.equal(viaHost.ok, true)
    assert.deepEqual(viaHost.ok ? viaHost.message : undefined, intent)
  })
})

describe('S4 para a versao errada no fio — o bump V1 -> V2 e seguro', () => {
  it('v:1 (o envelope numerico LEGADO) e descartado como versao-desconhecida', () => {
    // Uma ponta antiga (binario anterior durante um reinicio) manda o envelope
    // V1 com ids NUMERICOS. A ponta nova nao o entende e descarta — nunca parte.
    const linhasV1 = [
      '{"v":1,"type":"intent","intent":"tunnel.up","requestId":"r","from":123456789,"chat":123456789}',
      '{"v":1,"type":"state","state":"STOPPED","seq":1}',
      '{"v":1,"type":"ack","requestId":"r","result":"accepted","state":"STARTING"}',
    ]
    for (const linha of linhasV1) {
      assert.deepEqual(parseHost(linha, 'to-host'), { ok: false, reason: 'versao-desconhecida' })
      assert.deepEqual(parseWorker(linha, 'to-host'), { ok: false, reason: 'versao-desconhecida' })
    }
  })

  it('v:2 EXIGE ids string: o mesmo intent com `from` numerico e recusado (forma-invalida)', () => {
    // A verificacao de versao passa (e 2), mas a FORMA do envelope V2 pede
    // string — um numero no lugar de `from` nao e aceite em lado nenhum.
    const linha = '{"v":2,"type":"intent","intent":"tunnel.up","requestId":"r","from":1,"chat":"1"}'
    assert.deepEqual(parseHost(linha, 'to-host'), { ok: false, reason: 'forma-invalida' })
    assert.deepEqual(parseWorker(linha, 'to-host'), { ok: false, reason: 'forma-invalida' })
  })

  it('v:3 (futura) tambem cai em S4, nos DOIS codecs e nos DOIS sentidos', () => {
    for (const direction of ['to-host', 'to-worker'] as const) {
      assert.deepEqual(parseHost('{"v":3,"type":"intent","intent":"tunnel.up","requestId":"r","from":"1","chat":"1"}', direction), {
        ok: false,
        reason: 'versao-desconhecida',
      })
      assert.deepEqual(parseWorker('{"v":3,"type":"intent","intent":"tunnel.up","requestId":"r","from":"1","chat":"1"}', direction), {
        ok: false,
        reason: 'versao-desconhecida',
      })
    }
  })
})

describe('o veredito do contrato — as QUATRO razoes, produzidas por comportamento', () => {
  const RACOES: ReadonlyArray<readonly [string, 'json-invalido' | 'versao-desconhecida' | 'tipo-desconhecido' | 'forma-invalida']> = [
    ['{nao sou json', 'json-invalido'],
    ['{"v":2,"type":"inte', 'json-invalido'],
    ['{"v":9,"type":"intent"}', 'versao-desconhecida'],
    ['{"v":2,"type":"reboot"}', 'tipo-desconhecido'],
    ['{"v":2,"type":"intent","intent":"rm.rf","requestId":"r","from":"1","chat":"1"}', 'forma-invalida'],
  ]

  it('cada linha malformada devolve `{ ok: false, reason }` — S4 e veredito, nao excecao', () => {
    for (const [linha, razao] of RACOES) {
      assert.deepEqual(parseHost(linha, 'to-host'), { ok: false, reason: razao }, linha)
      assert.deepEqual(parseWorker(linha, 'to-host'), { ok: false, reason: razao }, linha)
    }
  })
})

describe('o criterio de aceite 1: uma snowflake atravessa os dois codecs sem perda', () => {
  it('1057992969437413409 (> 2^53) viaja byte a byte em `from`/`chat` — sem NaN, sem truncar', () => {
    const snowflake = '1057992969437413409'
    const intent = {
      v: IPC_PROTOCOL_VERSION,
      type: 'intent',
      intent: 'emergency',
      requestId: '01J0000000000000000000000A',
      from: snowflake,
      chat: snowflake,
    } as const

    for (const [nome, parse, serialize] of [
      ['host', parseHost, serializeHost],
      ['worker', parseWorker, serializeWorker],
    ] as const) {
      const linha = serialize(intent, 'to-host')
      assert.equal(linha.includes(snowflake), true, `${nome}: a snowflake esta na linha`)
      const verdict = parse(linha.trimEnd(), 'to-host')
      assert.equal(verdict.ok, true, `${nome}: a linha le`)
      assert.equal(verdict.ok && verdict.message.type === 'intent' && verdict.message.from, snowflake)
      assert.equal(verdict.ok && verdict.message.type === 'intent' && verdict.message.chat, snowflake)
      // A prova de que o cast numerico da V1 teria perdido o valor:
      assert.equal(String(Number(snowflake)) === snowflake, false, 'a snowflake NAO e um numero seguro')
      assert.equal(Number.isNaN(Number(verdict.ok && verdict.message.type === 'intent' ? verdict.message.from : '')), false)
    }
  })
})

describe('EMENDA ONDA-4-AGENTS-HOST: as intents de agente e o agent.report nos DOIS codecs', () => {
  it('agent.dispatch com params round-tripa fiel nos dois codecs, byte a byte', () => {
    const intent = {
      v: IPC_PROTOCOL_VERSION,
      type: 'intent',
      intent: 'agent.dispatch',
      requestId: '01J0000000000000000000000A',
      from: '123456789',
      chat: '-1001234567890',
      nonce: 'nonce-opaco',
      params: { skill: 'deep-orchestrator-agent-skill', prompt: 'faz o relatorio' },
    } as const

    const linhaHost = serializeHost(intent, 'to-host')
    const linhaWorker = serializeWorker(intent, 'to-host')
    assert.equal(linhaWorker, linhaHost, 'os dois codecs serializam a mesma linha')
    assert.deepEqual(parseHost(linhaHost.trimEnd(), 'to-host'), parseWorker(linhaWorker.trimEnd(), 'to-host'))
  })

  it('agent.report round-tripa fiel nos dois codecs (o worker precisa de conhecer a mensagem)', () => {
    const report = {
      v: IPC_PROTOCOL_VERSION,
      type: 'agent.report',
      runs: [
        { id: 'ABCD1234', skill: 'deep-orchestrator-agent-skill', status: 'done', startedAt: 1_700_000_000_000, summary: 'resumo' },
      ],
    } as const

    const linhaHost = serializeHost(report, 'to-worker')
    const linhaWorker = serializeWorker(report, 'to-worker')
    assert.equal(linhaWorker, linhaHost, 'os dois codecs serializam a mesma linha')
    assert.deepEqual(parseHost(linhaHost.trimEnd(), 'to-worker'), parseWorker(linhaWorker.trimEnd(), 'to-worker'))
  })
})
