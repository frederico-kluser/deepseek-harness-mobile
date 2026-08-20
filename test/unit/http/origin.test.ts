/**
 * `src/http/origin.ts` -- normalizacao de endereco e allowlist fail-closed.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isTrustedRemote, normalizeRemoteAddress } from '../../../src/http/origin.ts'

describe('allowlist de origens remotas', () => {
  it('nega um socket sem remoteAddress', () => {
    assert.equal(isTrustedRemote(undefined, ['127.0.0.1']), false)
    assert.equal(isTrustedRemote(null, ['127.0.0.1']), false)
    assert.equal(isTrustedRemote('', ['127.0.0.1']), false)
  })

  it('normaliza IPv6-mapeado, loopback IPv6, zone id e parenteses', () => {
    assert.equal(normalizeRemoteAddress('::ffff:127.0.0.1'), '127.0.0.1')
    assert.equal(normalizeRemoteAddress('::1'), '127.0.0.1')
    assert.equal(normalizeRemoteAddress('0:0:0:0:0:0:0:1'), '127.0.0.1')
    assert.equal(normalizeRemoteAddress('[::1]'), '127.0.0.1')
    assert.equal(normalizeRemoteAddress('fe80::1%eth0'), 'fe80::1')
    assert.equal(normalizeRemoteAddress('  10.0.0.7  '), '10.0.0.7')
    assert.equal(normalizeRemoteAddress(undefined), undefined)
  })

  it('uma entrada "::1" na allowlist cobre tambem o loopback IPv4', () => {
    assert.equal(isTrustedRemote('127.0.0.1', ['::1']), true)
    assert.equal(isTrustedRemote('::ffff:127.0.0.1', ['::1']), true)
    assert.equal(isTrustedRemote('10.0.0.7', ['::1']), false)
  })

  it('lista vazia nega TODA a gente, incluindo o loopback (fail-closed)', () => {
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.7']) {
      assert.equal(isTrustedRemote(remote, []), false, `origem ${remote} devia ser recusada`)
    }
  })
})
