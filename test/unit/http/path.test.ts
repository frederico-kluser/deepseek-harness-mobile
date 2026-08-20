/**
 * `src/http/path.ts` -- canonicalizacao e a relacao "cai sob um prefixo".
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canonicalRequestPath,
  isGuardedPath,
  routeMayServeGuardedPath,
} from '../../../src/http/path.ts'

describe('canonicalizacao de caminho', () => {
  it('canonicaliza //api, /API, percent-encoding e segmentos ..', () => {
    assert.equal(canonicalRequestPath('//api/commands/execute'), '/api/commands/execute')
    assert.equal(canonicalRequestPath('/API'), '/api')
    assert.equal(canonicalRequestPath('/%61pi'), '/api')
    assert.equal(canonicalRequestPath('/%2561pi'), '/api')
    assert.equal(canonicalRequestPath('/x/../api'), '/api')
    assert.equal(canonicalRequestPath('\\api'), '/api')
    assert.equal(canonicalRequestPath('/api/'), '/api')
    assert.equal(canonicalRequestPath(undefined), '/')
  })

  it('isGuardedPath separa /api de /apinfo e ignora a query string', () => {
    assert.equal(isGuardedPath('/api', ['/api']), true)
    assert.equal(isGuardedPath('/api/commands/execute', ['/api']), true)
    assert.equal(isGuardedPath('/api?x=1', ['/api']), true)
    assert.equal(isGuardedPath('/apinfo', ['/api']), false)
    assert.equal(isGuardedPath('/', ['/api']), false)
    assert.equal(isGuardedPath('/qualquer', ['/']), true)
  })

  it('isGuardedPath apanha as mesmas grafias sem apanhar /apinfo', () => {
    assert.equal(isGuardedPath('//api/commands/execute', ['/api']), true)
    assert.equal(isGuardedPath('/API/commands/execute', ['/api']), true)
    assert.equal(isGuardedPath('/%61pi', ['/api']), true)
    assert.equal(isGuardedPath('/apinfo', ['/api']), false)
  })

  it('routeMayServeGuardedPath cobre descendentes E ancestrais por prefixo', () => {
    const prefixes = ['/api']

    assert.equal(routeMayServeGuardedPath({ kind: 'exact', path: '/api/x' }, prefixes), true)
    assert.equal(routeMayServeGuardedPath({ kind: 'prefix', path: '//api' }, prefixes), true)
    assert.equal(routeMayServeGuardedPath({ kind: 'prefix', path: '/' }, prefixes), true)
    assert.equal(routeMayServeGuardedPath({ kind: 'exact', path: '/' }, prefixes), false)
    assert.equal(routeMayServeGuardedPath({ kind: 'prefix', path: '/outra' }, prefixes), false)
    assert.equal(routeMayServeGuardedPath({ kind: 'prefix', path: '/api' }, []), false)
  })
})
