/**
 * `src/http/auth-basic.ts` -- comparacao de credencial em tempo constante.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { verifyBasicAuth } from '../../../src/http/auth-basic.ts'
import { VALID_CREDENTIAL, WRONG_CREDENTIAL } from '../../support/fixtures.ts'

describe('verifyBasicAuth', () => {
  it('aceita apenas a credencial exata', () => {
    assert.equal(verifyBasicAuth(`Basic ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), true)
    assert.equal(verifyBasicAuth(`Basic ${WRONG_CREDENTIAL}`, VALID_CREDENTIAL), false)
  })

  it('recusa cabecalho ausente, esquema errado ou credencial vazia', () => {
    assert.equal(verifyBasicAuth(undefined, VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth('', VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth(`Bearer ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth('Basic ', VALID_CREDENTIAL), false)
  })

  it('nao lanca perante comprimentos diferentes (digest de tamanho fixo)', () => {
    assert.doesNotThrow(() => verifyBasicAuth('Basic a', VALID_CREDENTIAL))
    assert.equal(verifyBasicAuth('Basic a', VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth(`Basic ${VALID_CREDENTIAL}xxxxxxxxxxxx`, VALID_CREDENTIAL), false)
  })

  it('L3: o esquema Basic e comparado sem diferenciar maiusculas (RFC 7235)', () => {
    assert.equal(verifyBasicAuth(`basic ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), true)
    assert.equal(verifyBasicAuth(`BASIC ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), true)
    assert.equal(verifyBasicAuth(`BaSiC ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), true)

    // O payload base64 continua sensivel a maiusculas.
    assert.equal(verifyBasicAuth(`Basic ${VALID_CREDENTIAL.toLowerCase()}`, VALID_CREDENTIAL), false)
    assert.equal(verifyBasicAuth(`Bearer ${VALID_CREDENTIAL}`, VALID_CREDENTIAL), false)
  })

  it('sem credencial configurada NINGUEM passa (fail-closed)', () => {
    // `encodedAuthString` passou a ser opcional (o cordis.patch.yml e Camada 1 /
    // Bundle e nao pode transportar credencial, D19). A unica leitura segura da
    // ausencia e "nenhuma credencial e aceite".
    assert.equal(verifyBasicAuth(`Basic ${VALID_CREDENTIAL}`, undefined), false)
    assert.equal(verifyBasicAuth(`Basic ${VALID_CREDENTIAL}`, ''), false)
    assert.equal(verifyBasicAuth(undefined, undefined), false)
  })
})
