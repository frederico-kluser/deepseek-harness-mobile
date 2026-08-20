/**
 * PROVA ESTATISTICA de constancia de tempo (`03-ONDAS.md` 7, aceite 6).
 *
 * "Chamamos `timingSafeEqual`" NAO E PROVA. Uma comparacao pode ser constante e
 * o caminho a volta dela nao ser: uma saida antecipada por comprimento, uma
 * normalizacao que faz mais trabalho quando o primeiro caractere bate, um
 * `String.prototype.startsWith` de conveniencia -- qualquer um deles reintroduz
 * o oraculo que o `timingSafeEqual` foi la fechar. O que se mede aqui e o
 * caminho COMPLETO de `verifySecret`, da string apresentada ao booleano.
 *
 * METODO. Duas classes de candidato, ambas ERRADAS e do mesmo comprimento:
 *   A -- difere do segredo no PRIMEIRO caractere;
 *   B -- difere do segredo no ULTIMO caractere.
 * Se houvesse comparacao byte a byte com saida antecipada em qualquer ponto do
 * caminho, B custaria mais do que A e as duas distribuicoes separavam-se.
 *
 * As amostras sao INTERCALADAS (A, B, A, B, ...) e nao medidas em blocos: uma
 * maquina partilhada acelera e abranda ao longo de segundos, e medir uma classe
 * de cada vez atribuiria essa deriva a classe que calhou no mau momento.
 *
 * A estatistica e o U de Mann-Whitney, normalizado em z. E de POSTOS, logo nao
 * assume normalidade nem se deixa arrastar pela cauda pesada que qualquer
 * medicao de tempo tem (uma interrupcao do escalonador multiplica uma amostra
 * por cem; a mediana nem pestaneja).
 *
 * E, sobretudo, HA CONTROLO DE POTENCIA: o ultimo teste corre a MESMA
 * estatistica sobre uma comparacao deliberadamente insegura e exige que ela
 * SEJA detectada. Sem esse controlo, um teste de "nao ha diferenca" passa
 * tambem quando o instrumento e cego -- que e o modo de falha silencioso desta
 * classe de teste.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { generateSecret } from '../../../src/secret/generate.ts'
import { digestSecret, verifySecret } from '../../../src/secret/verify.ts'

/** Amostras por classe. 2000 dao ao U de Mann-Whitney sigma ~= 36 500 postos. */
const N = 2000

/**
 * |z| a partir do qual se declara diferenca.
 *
 * 8 desvios-padrao e p < 1e-15 sob a hipotese nula. Um oraculo real -- uma saida
 * antecipada num de 52 caracteres -- separa as distribuicoes quase por completo
 * e leva o |z| para perto do maximo teorico desta amostra (~55), como o controlo
 * de potencia no fim deste ficheiro demonstra. A folga entre 8 e 55 e o que
 * torna o teste ao mesmo tempo sensivel e nao-instavel.
 */
const Z_LIMIT = 8

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

/**
 * Mede as duas accoes INTERCALADAS, em nanossegundos por chamada.
 *
 * A ORDEM ALTERNA a cada iteracao (A,B depois B,A). Sem isso, a posicao dentro
 * do par vira uma variavel escondida: a primeira chamada depois de ler o relogio
 * mede-se sistematicamente ~1% mais lenta (previsor de saltos e cache ainda
 * frios), e essa diferenca -- que nao tem nada a ver com o codigo em prova --
 * chegava a dar |z| > 16 entre duas accoes IDENTICAS. Alternando, cada classe
 * apanha metade das amostras em cada posicao e o artefacto cancela-se.
 */
function measure(first: () => void, second: () => void, samples: number): { a: number[]; b: number[] } {
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
    const headNs = Number(t1 - t0)
    const tailNs = Number(t2 - t1)
    a.push(firstIsA ? headNs : tailNs)
    b.push(firstIsA ? tailNs : headNs)
  }
  return { a, b }
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((x, y) => x - y)
  return sorted[Math.floor(sorted.length / 2)]!
}

/**
 * Comparacao byte a byte com saida antecipada -- o anti-padrao que
 * `verifySecret` existe para evitar. Serve de controlo de potencia: se o
 * instrumento nao apanhar ISTO, os testes acima nao provam nada.
 */
function naiveEquals(x: string, y: string): boolean {
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false
  return true
}

describe('verifySecret: constancia de tempo', () => {
  const secret = generateSecret()
  const digest = digestSecret(secret)
  const primeiroErrado = `${secret[0] === 'A' ? 'B' : 'A'}${secret.slice(1)}`
  const ultimoErrado = `${secret.slice(0, -1)}${secret.at(-1) === 'A' ? 'B' : 'A'}`

  it(`errar no primeiro e errar no ultimo caractere custam o mesmo (N=${N} por classe)`, (t) => {
    assert.equal(verifySecret(primeiroErrado, digest), false)
    assert.equal(verifySecret(ultimoErrado, digest), false)

    const { a, b } = measure(
      () => void verifySecret(primeiroErrado, digest),
      () => void verifySecret(ultimoErrado, digest),
      N,
    )
    const z = mannWhitneyZ(a, b)
    t.diagnostic(
      `z=${z.toFixed(2)} medianas ${median(a)}ns (1o errado) vs ${median(b)}ns (ultimo errado), N=${N}`,
    )
    assert.ok(Math.abs(z) < Z_LIMIT, `|z|=${Math.abs(z).toFixed(2)} excede ${Z_LIMIT}`)
  })

  it(`acertar e errar custam o mesmo (N=${N} por classe)`, (t) => {
    const { a, b } = measure(
      () => void verifySecret(secret, digest),
      () => void verifySecret(ultimoErrado, digest),
      N,
    )
    const z = mannWhitneyZ(a, b)
    t.diagnostic(`z=${z.toFixed(2)} medianas ${median(a)}ns (certo) vs ${median(b)}ns (errado), N=${N}`)
    assert.ok(Math.abs(z) < Z_LIMIT, `|z|=${Math.abs(z).toFixed(2)} excede ${Z_LIMIT}`)
  })

  it('CONTROLO DE POTENCIA: a mesma estatistica DENUNCIA uma comparacao insegura', (t) => {
    const longo = 'A'.repeat(50_000)
    const difereNoInicio = `B${longo.slice(1)}`
    const { a, b } = measure(
      () => void naiveEquals(difereNoInicio, longo),
      () => void naiveEquals(longo, longo),
      300,
    )
    const z = mannWhitneyZ(a, b)
    t.diagnostic(`z=${z.toFixed(2)} medianas ${median(a)}ns (sai no 1o byte) vs ${median(b)}ns (percorre tudo)`)
    assert.ok(Math.abs(z) > Z_LIMIT, `o instrumento nao detectou um oraculo obvio (|z|=${Math.abs(z).toFixed(2)})`)
  })
})
