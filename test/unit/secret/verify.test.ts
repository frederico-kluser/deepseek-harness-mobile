/**
 * `src/secret/verify.ts` -- digest e comparacao.
 *
 * A prova ESTATISTICA de tempo constante esta em `timing.test.ts`; aqui prova-se
 * o comportamento: que compara o que deve, que nunca lanca por comprimento e que
 * um digest guardado invalido PARA em vez de abrir.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { toSecretDigest } from '../../../src/brand.ts'
import { canonicalizeSecret } from '../../../src/secret/canonical.ts'
import { generateSecret } from '../../../src/secret/generate.ts'
import { digestSecret, SECRET_DIGEST_BYTES, SecretDigestError, verifySecret } from '../../../src/secret/verify.ts'

describe('digestSecret', () => {
  it('e o sha256 da forma canonica, em hex minusculo de 64 caracteres', () => {
    const secret = 'MJDN-2GVY-KP7S-4RQA'
    const esperado = createHash('sha256').update(canonicalizeSecret(secret), 'utf8').digest('hex')
    assert.equal(digestSecret(secret), esperado)
    assert.match(digestSecret(secret), /^[0-9a-f]{64}$/u)
    assert.equal(SECRET_DIGEST_BYTES, 32)
  })

  it('nao distingue as formas em que o segredo foi escrito', () => {
    const secret = generateSecret()
    assert.equal(digestSecret(secret.toLowerCase()), digestSecret(secret))
    assert.equal(digestSecret(` ${secret} `), digestSecret(secret))
  })
})

describe('verifySecret', () => {
  const secret = generateSecret()
  const digest = digestSecret(secret)

  it('aceita so o segredo certo', () => {
    assert.equal(verifySecret(secret, digest), true)
    // Trocado por OUTRO caractere: um `A` fixo coincidiria com o proprio numa
    // geracao em dezasseis, e o teste passava sem provar nada.
    assert.equal(verifySecret(`${secret.slice(0, -1)}${secret.at(-1) === 'A' ? 'B' : 'A'}`, digest), false)
    assert.equal(verifySecret(generateSecret(), digest), false)
  })

  it('sem digest guardado NINGUEM passa (fail-closed)', () => {
    assert.equal(verifySecret(secret, undefined), false)
    assert.equal(verifySecret('', undefined), false)
  })

  it('nao lanca perante comprimentos diferentes -- e isso que nao vaza o tamanho', () => {
    // `timingSafeEqual` lanca RangeError com buffers de tamanhos diferentes. Como
    // os dois lados sao reduzidos a sha256, o comprimento apresentado nunca chega
    // a ser uma dimensao da comparacao.
    for (const candidate of ['', 'A', 'A'.repeat(5000), secret.slice(0, 10)]) {
      assert.doesNotThrow(() => verifySecret(candidate, digest))
      assert.equal(verifySecret(candidate, digest), false)
    }
  })

  it('digest guardado com tamanho errado PARA (fail loud)', () => {
    // So se chega aqui contornando o construtor de marca -- que e exatamente o
    // caso em que se quer um erro, e nao um `false` que pareceria "senha errada".
    const curto = 'abcd' as unknown as ReturnType<typeof toSecretDigest>
    assert.throws(() => verifySecret(secret, curto), SecretDigestError)
  })

  it('o construtor de marca recusa um digest que nao e sha256 em hex', () => {
    assert.throws(() => toSecretDigest('ZZ'), /SecretDigest/u)
    assert.throws(() => toSecretDigest(digest.toUpperCase()), /SecretDigest/u)
  })
})
