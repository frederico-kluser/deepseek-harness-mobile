/**
 * `src/permissions/deny.ts` -- tokenizador de permissoes recusadas.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { requestsDeniedPermission } from '../../../src/permissions/deny.ts'

describe('deteccao de permissao recusada', () => {
  it('a analise e por token (nao apanha danger-full-access-audit)', () => {
    assert.equal(
      requestsDeniedPermission('/permission danger-full-access', ['danger-full-access']),
      'danger-full-access',
    )
    assert.equal(
      requestsDeniedPermission('/PERMISSION   DANGER-FULL-ACCESS', ['danger-full-access']),
      'danger-full-access',
    )
    assert.equal(
      requestsDeniedPermission('/permission danger-full-access-audit', ['danger-full-access']),
      undefined,
    )
    assert.equal(
      requestsDeniedPermission('/permission workspace-write', ['danger-full-access']),
      undefined,
    )
  })
})

describe('tokenizador de deniedPermissions endurecido (achado B-HIGH)', () => {
  it('apanha as evasoes que escapavam: _, percent-encoding e pontuacao nas bordas', () => {
    const denied = ['danger-full-access']

    for (const comando of [
      '/permission danger_full_access',
      '/permission danger%2Dfull%2Daccess',
      '/permission danger%252Dfull%252Daccess',
      '/permission .danger-full-access',
      '/permission danger-full-access.',
      '/permission "danger-full-access"',
      '/permission DANGER_FULL_ACCESS',
      '/permission danger.full.access',
      '/permission danger+full+access',
    ]) {
      assert.equal(
        requestsDeniedPermission(comando, denied),
        'danger-full-access',
        `'${comando}' tinha de ser vetado`,
      )
    }
  })

  it('continua a NAO apanhar permissoes distintas (sem falsos positivos)', () => {
    const denied = ['danger-full-access']

    assert.equal(requestsDeniedPermission('/permission danger-full-access-audit', denied), undefined)
    assert.equal(requestsDeniedPermission('/permission workspace-write', denied), undefined)
    assert.equal(requestsDeniedPermission('/permission read-only', denied), undefined)
  })

  it('canonicaliza tambem a agulha vinda da configuracao', () => {
    assert.equal(
      requestsDeniedPermission('/permission danger-full-access', ['DANGER_FULL_ACCESS']),
      'DANGER_FULL_ACCESS',
    )
  })
})
