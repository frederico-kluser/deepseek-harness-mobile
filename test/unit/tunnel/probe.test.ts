/**
 * `src/tunnel/probe.ts` -- TUN-020 a TUN-025 (04-TESTES.md 5.4.6 / D11).
 *
 * O CONTROLO MAIS IMPORTANTE DA ONDA, e a razao esta escrita no plano com data:
 * durante a pesquisa, a porta 3080 ja estava ocupada pelo DSH do utilizador, o
 * origin de teste nao conseguiu bindar, e o quick tunnel expos o Harness REAL,
 * publicamente e sem autenticacao, durante ~40 segundos.
 *
 * Estes casos verificam o VEREDITO. Que nenhum `spawn` acontece quando o veredito
 * reprova esta em `supervisor.test.ts`, e contra um transporte HTTP real em
 * `test/integration/tunnel/probe.test.ts`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ProbeId } from '../../../src/contracts/tunnel.ts'
import {
  buildProbePlan,
  CANARY_PATH_PREFIX,
  DEFAULT_API_READ_PATH,
  judgeProbe,
  runGateProbe,
  type ProbeRequest,
  type ProbeTransport,
  type ProbeTransportResult,
} from '../../../src/tunnel/probe.ts'

const TODAS: readonly ProbeId[] = [
  'spa-fallback',
  'api-rpc',
  'websocket-upgrade',
  'unguarded-canary',
]

/** Transporte falso: cada sonda devolve o que o teste mandar. Zero sockets. */
function fakeTransport(
  byProbe: Partial<Record<ProbeId, ProbeTransportResult>>,
  seen: ProbeRequest[] = [],
): ProbeTransport {
  return {
    send(request: ProbeRequest): Promise<ProbeTransportResult> {
      seen.push(request)
      return Promise.resolve(byProbe[request.probe] ?? { kind: 'response', status: 401 })
    },
  }
}

function run(byProbe: Partial<Record<ProbeId, ProbeTransportResult>>) {
  return runGateProbe({
    transport: fakeTransport(byProbe),
    canaryToken: 'deadbeef',
    signal: new AbortController().signal,
  })
}

describe('as quatro sondas, na forma exigida por D11', () => {
  it('sao quatro, anonimas, e na ordem canonica', () => {
    const plan = buildProbePlan('abc123')
    assert.deepEqual(
      plan.map((probe) => probe.probe),
      TODAS,
    )
    for (const probe of plan) {
      // ANONIMAS: uma sonda com credencial mediria "a aplicacao responde a quem
      // TEM credencial", que e a pergunta errada.
      const headers = Object.keys(probe.headers).map((key) => key.toLowerCase())
      assert.equal(headers.includes('authorization'), false)
      assert.equal(headers.includes('cookie'), false)
    }
  })

  it('sonda 2 e um POST de LEITURA sob /api, com corpo vazio', () => {
    const [, apiRpc] = buildProbePlan('abc123')
    assert.equal(apiRpc?.method, 'POST')
    assert.equal(apiRpc?.path.startsWith('/api/'), true)
    assert.equal(apiRpc?.path, DEFAULT_API_READ_PATH)
    // Se o gate estiver desarmado, o pedido CHEGA a aplicacao. Uma sonda que
    // escrevesse deixaria efeito colateral no cenario em que ja ha um problema.
    assert.equal(apiRpc?.body, '')
  })

  it('sonda 3 pede o upgrade de WebSocket', () => {
    const [, , upgrade] = buildProbePlan('abc123')
    assert.equal(upgrade?.headers['upgrade'], 'websocket')
    assert.equal(upgrade?.headers['connection'], 'Upgrade')
  })

  it('sonda 4 vai a um caminho FORA de guardedPrefixes, com sufixo aleatorio', () => {
    const [, , , canary] = buildProbePlan('token-unico-do-arranque')
    assert.equal(canary?.path, `${CANARY_PATH_PREFIX}token-unico-do-arranque`)
    assert.equal(canary?.path.startsWith('/api'), false, 'tem de estar FORA de /api')
  })
})

describe('TUN-024: as quatro devolvem 401 -> o tunel pode subir', () => {
  it('passa, e o resultado das QUATRO fica disponivel para a auditoria', async () => {
    const result = await run({})

    assert.equal(result.passed, true)
    assert.equal(result.failure, undefined)
    assert.equal(result.outcomes.length, 4)
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.probe),
      TODAS,
    )
    assert.equal(
      result.outcomes.every((outcome) => outcome.passed && outcome.status === 401),
      true,
    )
  })
})

describe('TUN-020: sonda 1 devolve 200 (gate desarmado no fallback)', () => {
  it('reprova e a mensagem NOMEIA a sonda', async () => {
    const result = await run({ 'spa-fallback': { kind: 'response', status: 200 } })

    assert.equal(result.passed, false)
    assert.equal(result.failure?.code, 'PROBE_FAILED')
    assert.equal(result.failure?.probe, 'spa-fallback')
    assert.equal(result.failure?.message.includes('spa-fallback'), true)
    assert.equal(result.failure?.retryable, false)
  })
})

describe('TUN-021: sonda 2 devolve 200 -- o gate cobre `/` mas nao `/api`', () => {
  it('reprova, e ESTE e o caso realista', async () => {
    // `/` vem do `registerFallback` de `dsh-host-frontend-static` e `/api` e um
    // prefixo nomeado de `dsh-client-connection`: outro pacote, outro momento de
    // registo. Provar `/` NAO prova `/api`, e o roteador consulta as tabelas
    // nomeadas ANTES do fallback.
    const result = await run({ 'api-rpc': { kind: 'response', status: 200 } })

    assert.equal(result.passed, false)
    assert.equal(result.failure?.probe, 'api-rpc')
    assert.equal(result.failure?.message.includes('api-rpc'), true)
    // A sonda 1 passou -- e e exatamente por isso que uma sonda so nao chega.
    assert.equal(result.outcomes[0]?.passed, true)
  })
})

describe('TUN-022: sonda 3 completa o handshake sem credencial', () => {
  it('101 reprova: um WebSocket aberto sem credencial e bloqueio de subida', async () => {
    const result = await run({ 'websocket-upgrade': { kind: 'response', status: 101 } })

    assert.equal(result.passed, false)
    assert.equal(result.failure?.probe, 'websocket-upgrade')
    assert.equal(result.outcomes[2]?.status, 101)
  })

  it('socket destruido pelo gate PASSA -- e a recusa crua do tratador de upgrade', async () => {
    const result = await run({ 'websocket-upgrade': { kind: 'destroyed' } })

    assert.equal(result.passed, true)
    assert.equal(result.outcomes[2]?.status, null, 'null = socket destruido, por contrato')
  })

  it('mas socket destruido nas OUTRAS sondas reprova: nao houve medicao', () => {
    for (const probe of ['spa-fallback', 'api-rpc', 'unguarded-canary'] as const) {
      assert.equal(judgeProbe(probe, { kind: 'destroyed' }).passed, false)
    }
  })
})

describe('TUN-023: sonda 4 devolve 404 em vez de 401', () => {
  it('reprova, e a mensagem explica que o pedido nao passou pelo portao', async () => {
    const result = await run({ 'unguarded-canary': { kind: 'response', status: 404 } })

    assert.equal(result.passed, false)
    assert.equal(result.failure?.probe, 'unguarded-canary')
    // 404 significa que o pedido chegou ao ROTEADOR: o portao nao e universal.
    assert.equal(result.failure?.message.includes('sem passar pelo portao'), true)
  })
})

describe('TUN-025: o probe e fail-closed ATE no seu proprio erro', () => {
  it('erro de rede numa sonda reprova o conjunto', async () => {
    const result = await run({ 'spa-fallback': { kind: 'error', reason: 'ECONNREFUSED' } })
    assert.equal(result.passed, false)
    assert.equal(result.outcomes[0]?.status, null)
  })

  it('EXCEPCAO dentro do transporte reprova, e `runGateProbe` NAO lanca', async () => {
    const result = await runGateProbe({
      transport: {
        send: (): Promise<ProbeTransportResult> => {
          throw new Error('o transporte explodiu')
        },
      },
      canaryToken: 'x',
      signal: new AbortController().signal,
    })

    // Nunca "nao consegui medir, entao deixa subir". Uma excepcao que escapasse
    // daqui viraria, num `catch` distraido la em cima, exatamente essa frase.
    assert.equal(result.passed, false)
    assert.equal(result.outcomes.length, 4, 'as quatro continuam a ser relatadas')
  })

  it('um 200 em QUALQUER sonda reprova -- e nenhum codigo que nao seja 401 passa', () => {
    for (const probe of TODAS) {
      for (const status of [200, 204, 301, 403, 404, 500]) {
        assert.equal(
          judgeProbe(probe, { kind: 'response', status }).passed,
          false,
          `${probe} nao pode passar com ${String(status)}`,
        )
      }
      assert.equal(judgeProbe(probe, { kind: 'response', status: 401 }).passed, true)
    }
  })
})

describe('as quatro correm SEMPRE, mesmo depois da primeira reprovar', () => {
  it('um relatorio parcial esconderia se o portao falha numa superficie ou em todas', async () => {
    const seen: ProbeRequest[] = []
    const result = await runGateProbe({
      transport: fakeTransport({ 'spa-fallback': { kind: 'response', status: 200 } }, seen),
      canaryToken: 'x',
      signal: new AbortController().signal,
    })

    assert.equal(seen.length, 4)
    assert.equal(result.outcomes.length, 4)
    // A falha reportada e a PRIMEIRA, que e a que o dono precisa de ver primeiro.
    assert.equal(result.failure?.probe, 'spa-fallback')
  })
})
