/**
 * `src/secret/store.ts` -- provisao, verificacao e rotacao do segredo.
 *
 * As perguntas falsificaveis 1, 2, 4 e 5 de T2.1 (`03-ONDAS.md` 7) sao
 * respondidas AQUI, por asercao e nao por afirmacao: o segredo nao fica em
 * lado nenhum apos a provisao, o ficheiro de estado tem modo 0600 mesmo com
 * `umask` permissivo, a rotacao revoga as sessoes vivas, e nada do que sai
 * deste modulo contem o segredo em claro.
 */

import assert from 'node:assert/strict'
import { chmodSync, readFileSync, statSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'

import { canonicalizeSecret } from '../../../src/secret/canonical.ts'
import { createSecretStore, SecretAlreadyProvisionedError } from '../../../src/secret/store.ts'
import { digestSecret } from '../../../src/secret/verify.ts'
import { makeTempStateDir, type TempStateDir } from '../../support/state-dir.ts'
import { createFileStateStore, writeRawState } from './state-store-double.ts'

/** Extrai o segredo canonico da tela de apresentacao (primeira linha agrupada). */
function secretFromDisplay(display: string): string {
  return canonicalizeSecret(display.split('\n')[0] ?? '')
}

function makeSessions(): { revokeAll: () => void; calls: number } {
  const spy = { calls: 0, revokeAll: (): void => void (spy.calls += 1) }
  return spy
}

describe('createSecretStore', () => {
  let dir: TempStateDir
  let previousUmask: number

  before(() => {
    // umask PERMISSIVO de proposito: se o 0600 viesse do umask e nao de uma
    // decisao explicita, este teste seria o que o denunciava.
    previousUmask = process.umask(0o000)
    dir = makeTempStateDir()
  })
  after(() => {
    dir.cleanup()
    process.umask(previousUmask)
  })

  it('provisiona 256 bits, persiste SO o digest e mostra o segredo uma vez', () => {
    const store = createSecretStore({ state: createFileStateStore(dir.statePath), sessions: makeSessions() })
    assert.equal(store.hasSecret(), false)

    const { display } = store.provision()
    const secret = secretFromDisplay(display)
    assert.equal(secret.length, 52, '52 caracteres base32 = 256 bits')
    assert.equal(store.hasSecret(), true)

    const raw = readFileSync(dir.statePath, 'utf8')
    assert.equal(JSON.parse(raw).secretDigest, digestSecret(secret))
    assert.ok(!raw.includes(secret), 'o segredo em claro nao pode estar no ficheiro')
    assert.ok(!raw.includes(secret.slice(0, 8)), 'nem um prefixo dele')
  })

  it('P2: o ficheiro do digest fica 0600 mesmo com umask 000', () => {
    const mode = statSync(dir.statePath).mode & 0o777
    assert.equal(mode.toString(8), '600', `modo observado: 0${mode.toString(8)}`)
  })

  it('P1: nada no objeto devolvido guarda o segredo em claro', () => {
    const store = createSecretStore({ state: createFileStateStore(dir.statePath), sessions: makeSessions() })
    const secret = secretFromDisplay(store.rotate().display)
    // O store e o seu proprio despejo: se houvesse campo, cache ou closure
    // exposta com o segredo, ele apareceria numa destas duas leituras.
    assert.equal(JSON.stringify(store), '{}')
    assert.ok(!Object.values(store).some((value) => String(value).includes(secret)))
    assert.equal(store.verify(secret), true, 'o segredo rodado continua a ser o valido')
  })

  it('verifica o segredo em qualquer forma que o dono o escreva', () => {
    const store = createSecretStore({ state: createFileStateStore(dir.statePath), sessions: makeSessions() })
    const display = store.rotate().display
    const grouped = display.split('\n')[0]!
    assert.equal(store.verify(grouped), true, 'agrupado, como aparece na tela')
    assert.equal(store.verify(grouped.toLowerCase()), true, 'em minusculas')
    assert.equal(store.verify(` ${grouped} `), true, 'com espaco a volta')
    assert.equal(store.verify(canonicalizeSecret(grouped)), true, 'corrido')
    // O ultimo caractere trocado por OUTRO -- e nao por um `A` fixo, que uma vez
    // em dezasseis seria o proprio caractere e o teste passava por engano.
    const canonical = canonicalizeSecret(grouped)
    assert.equal(store.verify(`${canonical.slice(0, -1)}${canonical.at(-1) === 'A' ? 'B' : 'A'}`), false)
    assert.equal(store.verify(''), false)
  })

  it('P4: rotate() revoga as sessoes vivas ANTES de publicar o novo digest', () => {
    const sessions = makeSessions()
    const state = createFileStateStore(dir.statePath)
    const store = createSecretStore({ state, sessions })
    const antigo = secretFromDisplay(store.rotate().display)
    assert.equal(sessions.calls, 1, 'revokeAll foi chamado')

    const novo = secretFromDisplay(store.rotate().display)
    assert.equal(sessions.calls, 2)
    assert.equal(store.verify(antigo), false, 'o segredo antigo deixa de servir')
    assert.equal(store.verify(novo), true)
  })

  it('provision() recusa substituir um segredo existente em silencio', () => {
    const store = createSecretStore({ state: createFileStateStore(dir.statePath), sessions: makeSessions() })
    assert.throws(() => store.provision(), SecretAlreadyProvisionedError)
  })

  it('digest persistido malformado PARA em vez de virar "sem segredo"', () => {
    const state = createFileStateStore(dir.statePath)
    const store = createSecretStore({ state, sessions: makeSessions() })
    writeRawState(dir.statePath, JSON.stringify({ version: 1, desiredState: 'STOPPED', secretDigest: 'nao-e-hex' }))
    assert.throws(() => store.hasSecret(), /SecretDigest/u)
    assert.throws(() => store.verify('seja o que for'), /SecretDigest/u)
  })

  it('sem segredo provisionado NINGUEM passa (fail-closed)', () => {
    const vazio = makeTempStateDir()
    try {
      const store = createSecretStore({ state: createFileStateStore(vazio.statePath), sessions: makeSessions() })
      assert.equal(store.verify('QUALQUER-COISA'), false)
      assert.equal(store.hasSecret(), false)
    } finally {
      vazio.cleanup()
    }
  })

  it('P2 (contra-prova): estado com modo 0644 nao carrega', () => {
    const frouxo = makeTempStateDir()
    try {
      writeRawState(frouxo.statePath, JSON.stringify({ version: 1, desiredState: 'STOPPED' }))
      chmodSync(frouxo.statePath, 0o644)
      const store = createSecretStore({ state: createFileStateStore(frouxo.statePath), sessions: makeSessions() })
      assert.throws(() => store.hasSecret(), /0644/u)
    } finally {
      frouxo.cleanup()
    }
  })
})
