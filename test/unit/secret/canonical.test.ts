/**
 * `src/secret/canonical.ts` -- a forma unica sobre a qual se calcula o digest.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalizeSecret } from '../../../src/secret/canonical.ts'

describe('canonicalizeSecret', () => {
  it('junta as formas em que o mesmo segredo pode ser escrito', () => {
    const canonical = 'MJDN2GVYKP7S4RQA'
    for (const escrita of [
      'MJDN-2GVY-KP7S-4RQA',
      'mjdn-2gvy-kp7s-4rqa',
      'MJDN 2GVY KP7S 4RQA',
      '  MJDN-2GVY-KP7S-4RQA  ',
      'MJDN 2GVY KP7S 4RQA', // espacos INQUEBRAVEIS (U+00A0), como um telemovel cola
      'MJDN\t2GVY\nKP7S\r4RQA',
      'MJDN‐2GVY–KP7S—4RQA',
      'MJDN−2GVY-KP7S-4RQA',
      canonical,
    ]) {
      assert.equal(canonicalizeSecret(escrita), canonical, JSON.stringify(escrita))
    }
  })

  it('e idempotente', () => {
    const uma = canonicalizeSecret(' abc-def ')
    assert.equal(canonicalizeSecret(uma), uma)
  })

  it('NAO traduz 0 para O nem 1 para I (RFC 4648 3.4: "by default it should not")', () => {
    // O alfabeto nao tem `0` nem `1`; quem os escreve escreveu outra coisa, e a
    // recusa e mais honesta do que adivinhar qual das duas letras ele queria.
    assert.equal(canonicalizeSecret('0O1IL'), '0O1IL')
  })

  it('corta a entrada absurda em vez de hashear megabytes', () => {
    assert.equal(canonicalizeSecret('A'.repeat(10_000)).length, 512)
    // O corte e por comprimento FIXO: nao depende de nenhum byte do segredo.
    assert.equal(canonicalizeSecret('-'.repeat(10_000)), '')
  })

  it('a cadeia vazia continua vazia', () => {
    assert.equal(canonicalizeSecret(''), '')
  })
})
