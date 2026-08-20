/**
 * `src/config/bind.ts` -- politica de bind (primeira linha contra a #853).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assertSecureBind, KNOWN_BIND_HOSTS } from '../../../src/config/bind.ts'

describe('assertSecureBind', () => {
  it('recusa binds em todas as interfaces', () => {
    assert.throws(() => assertSecureBind('0.0.0.0', ['127.0.0.1']), /Bind inseguro/u)
    assert.throws(() => assertSecureBind('::', ['127.0.0.1']), /Bind inseguro/u)
    assert.throws(() => assertSecureBind('[::]', ['127.0.0.1']), /Bind inseguro/u)
  })

  it('recusa um host fora de allowedHosts', () => {
    assert.throws(() => assertSecureBind('192.168.1.10', ['127.0.0.1']), /Bind nao autorizado/u)
  })

  it('aceita o loopback declarado na allowlist', () => {
    assert.doesNotThrow(() => assertSecureBind('127.0.0.1', ['127.0.0.1', '::1']))
    assert.doesNotThrow(() => assertSecureBind('::1', ['127.0.0.1', '::1']))
  })

  it('L1: reconhece todas as grafias do bind curinga', () => {
    for (const host of [
      '0',
      '0.0',
      '0.0.0.0',
      '0.0.0.0.',
      '::',
      '::0',
      '[::]',
      '0:0:0:0:0:0:0:0',
      '0000:0000:0000:0000:0000:0000:0000:0000',
      '::ffff:0.0.0.0',
      '  0.0.0.0  ',
    ]) {
      assert.throws(
        () => assertSecureBind(host, ['127.0.0.1', host]),
        /Bind inseguro/u,
        `'${host}' e o curinga e tinha de ser recusado`,
      )
    }
  })

  it('L1: nao confunde enderecos legitimos com o curinga', () => {
    assert.doesNotThrow(() => assertSecureBind('127.0.0.1', ['127.0.0.1']))
    assert.doesNotThrow(() => assertSecureBind('::1', ['::1']))
    assert.doesNotThrow(() => assertSecureBind('10.0.0.7', ['10.0.0.7']))
  })

  it('o conjunto de hosts que o WebServer pode reportar e fechado e conhecido', () => {
    // `WebServer['host']` e a uniao `'127.0.0.1' | '0.0.0.0'`. A cobertura
    // exaustiva e verificada pelo compilador em `src/config/bind.ts`; aqui
    // observa-se o outro lado: exatamente um dos dois e curinga.
    assert.deepEqual([...KNOWN_BIND_HOSTS], ['127.0.0.1', '0.0.0.0'])
    assert.doesNotThrow(() => assertSecureBind(KNOWN_BIND_HOSTS[0], [KNOWN_BIND_HOSTS[0]]))
    assert.throws(
      () => assertSecureBind(KNOWN_BIND_HOSTS[1], [KNOWN_BIND_HOSTS[1]]),
      /Bind inseguro/u,
    )
  })
})
