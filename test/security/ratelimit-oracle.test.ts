/**
 * O BAN NAO PODE VIRAR ORACULO -- suite adversarial de T2.3.
 *
 * Aceite 7 da Onda 2 (`03-ONDAS.md` 7) e RL-005/RL-011/RL-013 de `04-TESTES.md`:
 * depois de 15 falhas a resposta continua a ser `401` com corpo e cabecalhos
 * BYTE A BYTE identicos ao `401` de senha errada, e SEM `Retry-After`.
 *
 * PORQUE COM SOCKET CRU, e nao com `fetch`. `fetch` normaliza a linha de estado,
 * reordena e minuscula cabecalhos e esconde o enquadramento. "Byte a byte" so e
 * uma afirmacao verificavel se os bytes forem lidos do fio. `res.sendDate` fica
 * `false` porque o `Date` e emitido pelo `node:http`, muda a cada segundo e nao
 * faz parte da decisao do gate -- deixa-lo ligado transformaria uma asercao de
 * igualdade numa asercao sobre o relogio.
 *
 * PORQUE NAO HA TESTE DE CRONOMETRO. `04-TESTES.md` 5.1.3 e explicito: medir
 * timing em CI e uma maquina de flake, e a defesa prova-se POR CONSTRUCAO. O que
 * se assere aqui e mais forte do que um p50: (a) o atraso pedido e o MESMO nos
 * quatro casos de falha, (b) a comparacao corre exatamente uma vez em todos eles,
 * e (c) `src/ratelimit/**` nao tem sequer como escrever um cabecalho.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { challengeBasicAuth } from '../../src/http/responses.ts'
import type { Identity } from '../../src/contracts/auth.ts'
import { computeAuthDelayMs, DEFAULT_RATE_LIMIT_POLICY } from '../../src/ratelimit/policy.ts'
import { createFailureTracker, runThrottledAttempt, type FailureTracker } from '../../src/ratelimit/tracker.ts'

const policy = DEFAULT_RATE_LIMIT_POLICY
const REALM = 'DSH'
/** Sob tunel toda a gente e 127.0.0.1: `Identity.ip` vem `undefined` (spike S2). */
const anonymous: Identity = {}
/**
 * Balde IDENTIFICADO -- o unico escopo em que o ban duro se aplica
 * (`policy.ts`, `banAppliesToScope`). E aqui que se prova que o 401 do BAN e
 * byte a byte o 401 de senha errada; sobre o balde global nao ha ban a provar,
 * porque bani-lo seria trancar o dono.
 */
const identificada: Identity = { ip: '198.51.100.77' }

/**
 * As tres razoes que `02-SEGURANCA.md` 6.1 manda tornar indistinguiveis. No gate
 * (T3.3) as tres desaguam na MESMA chamada; aqui prova-se que a saida nao as
 * distingue -- nem no corpo, nem nos cabecalhos, nem no codigo de estado.
 */
type Caso = 'sem-sessao' | 'sessao-expirada' | 'segredo-errado' | 'segredo-certo'

interface Bancada {
  readonly tracker: FailureTracker
  readonly identity: Identity
  readonly delays: number[]
  verifyCalls: number
}

const bancadas = new Map<string, Bancada>()
let server: Server
let port: number

function novaBancada(id: string, falhasPrevias: number, identity: Identity = anonymous): Bancada {
  const tracker = createFailureTracker({
    policy,
    now: () => 0, // relogio parado: nenhum ban expira no meio do teste
    random: () => 1, // full jitter no topo = progressao nominal, deterministica
    maxTrackedIdentities: 64,
  })
  for (let i = 0; i < falhasPrevias; i += 1) tracker.recordFailure(identity)
  const bancada: Bancada = { tracker, identity, delays: [], verifyCalls: 0 }
  bancadas.set(id, bancada)
  return bancada
}

before(async () => {
  server = createServer((req, res) => {
    res.sendDate = false
    const id = String(req.headers['x-bancada'])
    const caso = String(req.headers['x-caso']) as Caso
    const bancada = bancadas.get(id)
    if (bancada === undefined) {
      res.writeHead(500).end('bancada inexistente')
      return
    }

    void (async (): Promise<void> => {
      const outcome = await runThrottledAttempt(
        bancada.tracker,
        bancada.identity,
        () => {
          bancada.verifyCalls += 1
          return caso === 'segredo-certo'
        },
        (ms: number) => {
          bancada.delays.push(ms)
          return Promise.resolve()
        },
      )
      if (outcome.granted) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ok\n')
        return
      }
      // O UNICO caminho de recusa. O mesmo para banido e para senha errada.
      challengeBasicAuth(res, REALM)
    })()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  port = (address as { port: number }).port
})

after(async () => {
  for (const bancada of bancadas.values()) bancada.tracker.dispose()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
})

/** Um pedido por ligacao, escrito a mao, com a resposta lida CRUA do socket. */
function pedidoCru(bancadaId: string, caso: Caso): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n` +
          `X-Bancada: ${bancadaId}\r\nX-Caso: ${caso}\r\n\r\n`,
      )
    })
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })
}

function semOraculo(bytes: Buffer, rotulo: string): void {
  const texto = bytes.toString('latin1')
  assert.equal(texto.startsWith('HTTP/1.1 401 Unauthorized\r\n'), true, `${rotulo}: tem de ser 401`)
  assert.equal(texto.startsWith('HTTP/1.1 429'), false, `${rotulo}: 429 esta PROIBIDO no caminho de auth`)
  assert.equal(/\r\nretry-after\s*:/iu.test(texto), false, `${rotulo}: nenhum Retry-After pode sair no fio`)
}

describe('o 401 do ban e byte a byte o 401 de senha errada', () => {
  it('ACEITE 7: apos 15 falhas a resposta nao muda um unico byte', async () => {
    novaBancada('escada', 0)

    const primeira = await pedidoCru('escada', 'segredo-errado')
    semOraculo(primeira, '1a falha')

    for (let i = 2; i <= 15; i += 1) {
      const resposta = await pedidoCru('escada', 'segredo-errado')
      assert.deepEqual(resposta, primeira, `a falha ${String(i)} mudou os bytes da resposta`)
    }

    const decima_sexta = await pedidoCru('escada', 'segredo-errado')
    assert.deepEqual(decima_sexta, primeira, 'a 16a falha tambem nao muda um byte')

    // E o balde GLOBAL continua NAO banido -- se o ban se aplicasse aqui, 15
    // pedidos anonimos trancavam o dono por uma hora. Ver `auto-dos.test.ts`.
    const bancada = bancadas.get('escada')
    assert.equal(bancada?.tracker.check(anonymous).allowed, true)
  })

  it('ACEITE 7 (balde identificado): o 401 do BAN e byte a byte o de senha errada', async () => {
    novaBancada('ban-ip', 0, identificada)

    const primeira = await pedidoCru('ban-ip', 'segredo-errado')
    semOraculo(primeira, '1a falha (por IP)')
    for (let i = 2; i <= 15; i += 1) await pedidoCru('ban-ip', 'segredo-errado')

    const bancada = bancadas.get('ban-ip')
    assert.equal(bancada?.tracker.check(identificada).allowed, false, 'esta bancada TEM de estar banida')

    const banida = await pedidoCru('ban-ip', 'segredo-errado')
    semOraculo(banida, 'banido')
    assert.deepEqual(banida, primeira, 'o 401 do ban tem de ser IDENTICO ao 401 de senha errada')
  })

  it('RL-011: credencial CORRETA durante o ban devolve exatamente o mesmo 401', async () => {
    novaBancada('ban-com-senha-certa', 15, identificada)
    const bancada = bancadas.get('ban-com-senha-certa')

    const errada = await pedidoCru('ban-com-senha-certa', 'segredo-errado')
    const certa = await pedidoCru('ban-com-senha-certa', 'segredo-certo')

    semOraculo(certa, 'senha certa sob ban')
    assert.deepEqual(certa, errada, 'acertar a senha durante o ban nao pode produzir resposta distinta')
    assert.equal(bancada?.verifyCalls, 2, 'a comparacao correu nos dois casos -- mesmo custo de codigo')
  })

  it('"sem sessao", "sessao expirada" e "segredo errado" sao indistinguiveis no fio', async () => {
    const casos: Caso[] = ['sem-sessao', 'sessao-expirada', 'segredo-errado']
    const respostas: Buffer[] = []

    for (const caso of casos) {
      // Uma bancada por caso, TODAS com a mesma contagem previa: e isso que
      // torna o atraso interno comparavel entre elas.
      novaBancada(`razao-${caso}`, 9)
      respostas.push(await pedidoCru(`razao-${caso}`, caso))
    }

    const [primeira] = respostas
    assert.notEqual(primeira, undefined)
    for (const [i, resposta] of respostas.entries()) {
      semOraculo(resposta, casos[i] ?? '?')
      assert.deepEqual(resposta, primeira, `${String(casos[i])} produziu bytes diferentes`)
    }

    // ... e o TEMPO tambem nao os distingue: o atraso interno pedido foi o mesmo,
    // e e o da escada da contagem -- nao da razao, nem do resultado da comparacao.
    const esperado = computeAuthDelayMs(9, policy, () => 1)
    for (const caso of casos) {
      assert.deepEqual(bancadas.get(`razao-${caso}`)?.delays, [esperado])
      assert.equal(bancadas.get(`razao-${caso}`)?.verifyCalls, 1)
    }
  })

  it('o atraso do caminho banido e o MESMO da escada -- responder mais depressa seria o oraculo', async () => {
    novaBancada('tempo-banido', 15, identificada)
    novaBancada('tempo-normal', 15, identificada)

    await pedidoCru('tempo-banido', 'segredo-certo')
    await pedidoCru('tempo-normal', 'segredo-errado')

    const esperado = computeAuthDelayMs(15, policy, () => 1)
    assert.equal(esperado, policy.maxDelayMs)
    assert.deepEqual(bancadas.get('tempo-banido')?.delays, [esperado])
    assert.deepEqual(bancadas.get('tempo-normal')?.delays, [esperado])
  })
})

describe('prova estrutural: o limitador nao tem como emitir cabecalho nenhum', () => {
  it('nenhum ficheiro de `src/ratelimit/**` toca em `ServerResponse`', () => {
    // GLOB, e nao tres nomes a mao: com a lista fixa, um 4o ficheiro entrava no
    // modulo sem nunca ser examinado.
    const dir = fileURLToPath(new URL('../../src/ratelimit/', import.meta.url))
    const ficheiros = readdirSync(dir).filter((nome) => nome.endsWith('.ts'))
    assert.equal(ficheiros.length >= 3, true, `esperava ao menos 3 fontes, vi ${String(ficheiros.length)}`)

    const proibidos = ['node:http', 'ServerResponse', 'writeHead', 'setHeader', 'statusCode']
    for (const ficheiro of ficheiros) {
      const fonte = readFileSync(fileURLToPath(new URL(ficheiro, new URL(dir, 'file:'))), 'utf8')
      for (const token of proibidos) {
        assert.equal(
          fonte.includes(token),
          false,
          `${ficheiro} refere \`${token}\`: um limitador que escreve resposta pode virar oraculo`,
        )
      }
    }
  })
})
