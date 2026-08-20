/**
 * `src/secret/generate.ts` -- entropia, alfabeto e apresentacao.
 *
 * A pergunta falsificavel 3 de T2.1 ("o alfabeto exclui 0, 1, 8 e 9?") e
 * respondida por asercao literal, e nao por leitura do codigo.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BASE32_ALPHABET,
  encodeBase32,
  generateSecret,
  groupSecret,
  renderQrAscii,
  renderSecretPanel,
  SECRET_BYTES,
  SECRET_LENGTH,
} from '../../../src/secret/generate.ts'

describe('encodeBase32', () => {
  it('reproduz os vectores do RFC 4648 seccao 10 (sem o padding `=`)', () => {
    const vectors: ReadonlyArray<readonly [string, string]> = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ]
    for (const [input, expected] of vectors) {
      assert.equal(encodeBase32(Buffer.from(input, 'ascii')), expected, input)
    }
  })

  it('os bits de enchimento sao zero (codificacao canonica, RFC 4648 3.5)', () => {
    // 0xff sozinho: 11111 sobra 111 -> completa com 00 -> indice 28 = '4'.
    assert.equal(encodeBase32(Uint8Array.from([0xff])), '74')
    assert.equal(encodeBase32(Uint8Array.from([0x00])), 'AA')
  })
})

describe('BASE32_ALPHABET', () => {
  it('P3: nao contem 0, 1, 8 nem 9 -- os digitos que se confundem a ditar', () => {
    assert.equal(BASE32_ALPHABET, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')
    assert.equal(BASE32_ALPHABET.length, 32)
    for (const ambiguo of ['0', '1', '8', '9']) {
      assert.ok(!BASE32_ALPHABET.includes(ambiguo), `${ambiguo} nao pode estar no alfabeto`)
    }
    // O par `0`/`O` e o par `1`/`l`/`I` deixam de existir porque um dos lados
    // nao esta la: `O`, `I` e `L` ficam, sem digito com que se confundir.
    for (const letra of ['O', 'I', 'L']) assert.ok(BASE32_ALPHABET.includes(letra))
    assert.equal(BASE32_ALPHABET, BASE32_ALPHABET.toUpperCase(), 'sem par maiuscula/minuscula')
    assert.equal(new Set(BASE32_ALPHABET).size, 32, 'sem repetidos')
  })
})

describe('generateSecret', () => {
  it('sao 256 bits, muito acima dos 128 da ASVS 5.0 11.5.1', () => {
    assert.equal(SECRET_BYTES, 32)
    assert.equal(SECRET_BYTES * 8, 256)
    assert.equal(SECRET_LENGTH, Math.ceil((SECRET_BYTES * 8) / 5))
    assert.ok(SECRET_LENGTH * 5 >= SECRET_BYTES * 8)
  })

  it('produz 52 caracteres do alfabeto, sempre', () => {
    for (let i = 0; i < 200; i += 1) {
      const secret = generateSecret()
      assert.equal(secret.length, SECRET_LENGTH)
      assert.ok([...secret].every((c) => BASE32_ALPHABET.includes(c)), secret)
      // O ultimo caractere carrega 4 bits de dados e 1 de enchimento a zero,
      // logo o seu indice no alfabeto e sempre PAR.
      assert.equal(BASE32_ALPHABET.indexOf(secret[SECRET_LENGTH - 1]!) % 2, 0, secret)
    }
  })

  it('nao repete e cobre o alfabeto (sinal de CSPRNG, nao de contador)', () => {
    const secrets = new Set<string>()
    const seen = new Set<string>()
    for (let i = 0; i < 400; i += 1) {
      const secret = generateSecret()
      secrets.add(secret)
      for (const c of secret.slice(0, -1)) seen.add(c)
    }
    assert.equal(secrets.size, 400, 'nenhuma repeticao em 400 geracoes')
    assert.equal(seen.size, 32, 'os 32 simbolos aparecem')
  })
})

describe('groupSecret', () => {
  it('agrupa de 4 em 4 com `-`, que e como se dita', () => {
    assert.equal(groupSecret('MJDN2GVYKP7S4RQA'), 'MJDN-2GVY-KP7S-4RQA')
    assert.equal(groupSecret('ABC'), 'ABC')
    assert.equal(groupSecret(''), '')
    const grouped = groupSecret(generateSecret())
    assert.equal(grouped.length, 64, '13 grupos de 4 mais 12 tracos cabem em 80 colunas')
    assert.equal(grouped.split('-').length, 13)
  })
})

describe('renderSecretPanel', () => {
  it('poe o texto ditavel e o QR na MESMA tela', () => {
    const secret = generateSecret()
    const panel = renderSecretPanel(secret)
    const [first, blank, ...drawing] = panel.split('\n')
    assert.equal(first, groupSecret(secret), 'a primeira linha e o segredo ditavel')
    assert.equal(blank, '', 'uma linha em branco separa-o do QR')
    assert.equal(drawing.join('\n'), renderQrAscii(secret), 'e o resto e o QR do MESMO segredo')
    assert.ok(drawing.length > 10 && drawing[0]!.length <= 80, 'o QR cabe num terminal de 80 colunas')
  })

  it('aceita a polaridade invertida, para fundo claro', () => {
    const secret = generateSecret()
    assert.notEqual(renderSecretPanel(secret, { invert: true }), renderSecretPanel(secret))
    assert.equal(renderSecretPanel(secret, { invert: false }), renderSecretPanel(secret))
  })
})
