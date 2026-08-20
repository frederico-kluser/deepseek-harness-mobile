/**
 * =============================================================================
 * TIMING DA COMPARACAO -- PROVA ESTATISTICA COM N SUFICIENTE. Suite T6.3.
 * =============================================================================
 *
 * A pergunta falsificavel (1) de T6.3: "timing com N suficiente ou uma
 * opiniao?". Este ficheiro e a resposta: N=2000 por classe, intercaladas, com
 * o U de Mann-Whitney em z E um CONTROL0 DE POTENCIA. Sem o controlo, um
 * teste de "nao ha diferenca" passa tambem quando o instrumento e cego -- o
 * modo de falha silencioso desta classe.
 *
 * DIFERENCA FACE AO TESTE DE UNIDADE (test/unit/secret/timing.test.ts): ali
 * mede-se `verifySecret` em isolamento. AQUI mede-se o caminho COMPLETO do
 * portao -- `verifyBasicAuth` (a credencial estatica do manifesto) e o
 * `presentedSecret` + `verifySecret` (o segredo do dono) -- porque e o caminho
 * que o atacante ve, e um atalho em QUALQUER ponto dele reintroduz o oraculo.
 *
 * ESTATISTICA: U de Mann-Whitney normalizado em z. DE POSTOS, logo nao
 * assume normalidade nem se deixa arrastar pela cauda pesada do tempo (uma
 * interrupcao do escalonador multiplica uma amostra por cem; a mediana nem
 * pestaneja). Amostras INTERCALADAS (A,B,A,B,...) e alternando a ordem a cada
 * par: uma maquina partilhada acelera e abranda ao longo de segundos, e medir
 * uma classe de cada vez atribuiria essa deriva a classe que calhou no mau
 * momento.
 *
 * Z_LIMIT = 10 (p < 1e-23 sob a hipotese nula). Um oraculo real separa as
 * distribuicoes quase por completo e leva o |z| para perto do maximo teorico
 * desta amostra (~55) -- a folga entre 10 e 55 e o que torna o teste ao mesmo
 * tempo sensivel e nao-instavel. A folga adicional face ao 8 do teste de
 * unidade existe porque esta suite corre num ambiente com mais ruido de
 * escalonador (o portao de T6.3 levanta servidores reais no MESMO processo).
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { verifyBasicAuth } from '../../src/http/auth-basic.ts'
import { generateSecret } from '../../src/secret/generate.ts'
import { digestSecret, verifySecret } from '../../src/secret/verify.ts'
import { canonicalizeSecret } from '../../src/secret/canonical.ts'

/** Amostras por classe. 2000 dao ao U de Mann-Whitney sigma ~= 36 500 postos. */
const N = 2000
const Z_LIMIT = 10

/** U de Mann-Whitney em z, com postos medios nos empates. */
function mannWhitneyZ(a: readonly number[], b: readonly number[]): number {
  const pooled = [...a.map((v) => ({ v, first: true })), ...b.map((v) => ({ v, first: false }))]
  pooled.sort((x, y) => x.v - y.v)
  let rankSum = 0
  for (let i = 0; i < pooled.length; ) {
    let j = i
    while (j + 1 < pooled.length && pooled[j + 1]!.v === pooled[i]!.v) j += 1
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) if (pooled[k]!.first) rankSum += rank
    i = j + 1
  }
  const u = rankSum - (a.length * (a.length + 1)) / 2
  const mean = (a.length * b.length) / 2
  const deviation = Math.sqrt((a.length * b.length * (a.length + b.length + 1)) / 12)
  return (u - mean) / deviation
}

/** Mede duas acoes INTERCALADAS, em nanossegundos por chamada, alternando a ordem. */
function measure(
  first: () => void,
  second: () => void,
  samples: number,
): { a: number[]; b: number[] } {
  for (let i = 0; i < 500; i += 1) {
    first()
    second()
  }
  const a: number[] = []
  const b: number[] = []
  for (let i = 0; i < samples; i += 1) {
    const firstIsA = i % 2 === 0
    const head = firstIsA ? first : second
    const tail = firstIsA ? second : first
    const t0 = process.hrtime.bigint()
    head()
    const t1 = process.hrtime.bigint()
    tail()
    const t2 = process.hrtime.bigint()
    a.push(firstIsA ? Number(t1 - t0) : Number(t2 - t1))
    b.push(firstIsA ? Number(t2 - t1) : Number(t1 - t0))
  }
  return { a, b }
}

/** Comparacao byte a byte com saida antecipada -- o anti-padrao (controlo de potencia). */
function naiveEquals(x: string, y: string): boolean {
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false
  return true
}

function mediana(values: readonly number[]): number {
  const sorted = values.toSorted((x, y) => x - y)
  return sorted[Math.floor(sorted.length / 2)]!
}

describe('verifyBasicAuth -- constancia de tempo do caminho da CREDENCIAL ESTATICA', () => {
  const credencial = 's3cr3t-256-bits-base64url-opaco-que-nao-e-nada-previsivel-1234567890'
  const primeiroErrado = 'a' + credencial.slice(1)
  const ultimoErrado = credencial.slice(0, -1) + (credencial.at(-1) === 'z' ? 'a' : 'z')

  it(`errar no primeiro e errar no ultimo caracter custam o mesmo (N=${N})`, (t) => {
    // PRE-COMPUTADOS FORA da medicao: construir o cabecalho (base64 + Buffer)
    // DENTRO do closure medido adiciona ruido de alocacao a cada amostra.
    const primeiro = `Basic ${Buffer.from('u:' + primeiroErrado).toString('base64')}`
    const ultimo = `Basic ${Buffer.from('u:' + ultimoErrado).toString('base64')}`
    assert.equal(verifyBasicAuth(primeiro, credencial), false)
    assert.equal(verifyBasicAuth(ultimo, credencial), false)
    const { a, b } = measure(
      () => void verifyBasicAuth(primeiro, credencial),
      () => void verifyBasicAuth(ultimo, credencial),
      N,
    )
    const z = mannWhitneyZ(a, b)
    t.diagnostic(`z=${z.toFixed(2)} medianas ${mediana(a)}ns vs ${mediana(b)}ns, N=${N}`)
    assert.ok(Math.abs(z) < Z_LIMIT, `|z|=${Math.abs(z).toFixed(2)} excede ${Z_LIMIT}`)
  })

  it('CONTROLO DE POTENCIA: a mesma estatistica DENUNCIA uma comparacao insegura', (t) => {
    const longo = 'A'.repeat(50_000)
    const difereNoInicio = 'B' + longo.slice(1)
    const { a, b } = measure(
      () => void naiveEquals(difereNoInicio, longo),
      () => void naiveEquals(longo, longo),
      300,
    )
    const z = mannWhitneyZ(a, b)
    t.diagnostic(`z=${z.toFixed(2)} medianas ${mediana(a)}ns vs ${mediana(b)}ns`)
    assert.ok(Math.abs(z) > Z_LIMIT, `o instrumento nao detectou um oraculo obvio (|z|=${Math.abs(z).toFixed(2)})`)
  })
})

describe('verifySecret -- o caminho do SEGREDO DO DONO (canonicalizacao + digest + timingSafeEqual)', () => {
  const segredo = canonicalizeSecret(generateSecret())
  const digest = digestSecret(segredo)
  const primeiroErrado = (segredo[0] === 'A' ? 'B' : 'A') + segredo.slice(1)
  const ultimoErrado = segredo.slice(0, -1) + (segredo.at(-1) === 'A' ? 'B' : 'A')

  it(`errar no primeiro e errar no ultimo custam o mesmo (N=${N})`, (t) => {
    assert.equal(verifySecret(primeiroErrado, digest), false)
    assert.equal(verifySecret(ultimoErrado, digest), false)
    const { a, b } = measure(
      () => void verifySecret(primeiroErrado, digest),
      () => void verifySecret(ultimoErrado, digest),
      N,
    )
    const z = mannWhitneyZ(a, b)
    t.diagnostic(`z=${z.toFixed(2)} medianas ${mediana(a)}ns vs ${mediana(b)}ns, N=${N}`)
    assert.ok(Math.abs(z) < Z_LIMIT, `|z|=${Math.abs(z).toFixed(2)} excede ${Z_LIMIT}`)
  })

  it(`acertar e errar custam o mesmo (N=${N})`, (t) => {
    const { a, b } = measure(
      () => void verifySecret(segredo, digest),
      () => void verifySecret(ultimoErrado, digest),
      N,
    )
    const z = mannWhitneyZ(a, b)
    t.diagnostic(`z=${z.toFixed(2)} medianas ${mediana(a)}ns vs ${mediana(b)}ns, N=${N}`)
    assert.ok(Math.abs(z) < Z_LIMIT, `|z|=${Math.abs(z).toFixed(2)} excede ${Z_LIMIT}`)
  })
})

