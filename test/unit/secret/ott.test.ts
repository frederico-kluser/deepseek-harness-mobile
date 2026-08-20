/**
 * `src/secret/ott.ts` -- o token de uso unico que destranca `/__guard/secret`.
 *
 * O TTL e exercido com o `FakeClock` prep-owned (`test/support/clock.ts`): dez
 * minutos de espera real nao sao um teste, sao um bloqueio.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BASE32_ALPHABET } from '../../../src/secret/generate.ts'
import { createOneTimeTokenStore, OTT_BYTES, OTT_TTL_MS } from '../../../src/secret/ott.ts'
import { FakeClock } from '../../support/clock.ts'

function makeStore(ttlMs?: number): { store: ReturnType<typeof createOneTimeTokenStore>; clock: FakeClock } {
  const clock = new FakeClock(1_700_000_000_000)
  const store = ttlMs === undefined
    ? createOneTimeTokenStore({ clock })
    : createOneTimeTokenStore({ clock, ttlMs })
  return { store, clock }
}

describe('createOneTimeTokenStore', () => {
  it('emite 128 bits em base32 e anuncia a validade', () => {
    assert.equal(OTT_BYTES * 8, 128)
    assert.equal(OTT_TTL_MS, 10 * 60 * 1000)
    const { store, clock } = makeStore()
    const { token, expiresAt } = store.issue()
    assert.equal(token.length, Math.ceil((OTT_BYTES * 8) / 5), '26 caracteres de 5 bits')
    assert.ok([...token].every((c) => BASE32_ALPHABET.includes(c)), token)
    assert.equal(expiresAt, clock.now() + OTT_TTL_MS)
    assert.notEqual(store.issue().token, token, 'cada emissao e um valor novo')
  })

  it('destranca UMA vez -- a segunda ja nao', () => {
    const { store } = makeStore()
    const { token } = store.issue()
    assert.equal(store.consume(token), true)
    assert.equal(store.consume(token), false, 'uso unico')
  })

  it('expira aos 10 minutos, nem antes nem depois', () => {
    const { store, clock } = makeStore()
    const { token } = store.issue()
    clock.advance(OTT_TTL_MS - 1)
    const outro = createOneTimeTokenStore({ clock: new FakeClock(0) })
    assert.notEqual(outro.issue().token, token)
    assert.equal(store.consume(token), true, 'um milissegundo antes ainda vale')

    const segundo = makeStore()
    const emitido = segundo.store.issue().token
    segundo.clock.advance(OTT_TTL_MS)
    assert.equal(segundo.store.consume(emitido), false, 'ao segundo exato ja nao vale')
  })

  it('palpite errado NAO queima o token do dono', () => {
    const { store } = makeStore()
    const { token } = store.issue()
    for (let i = 0; i < 5; i += 1) assert.equal(store.consume('ZZZZZZZZZZZZZZZZZZZZZZZZZZ'), false)
    assert.equal(store.consume(''), false)
    assert.equal(store.consume(`${token}A`), false, 'nem sequer um sufixo a mais')
    assert.equal(store.consume(token), true, 'o token do dono continua de pe')
  })

  it('aceita o token como o dono o copia (caixa e brancos)', () => {
    const { store } = makeStore()
    const { token } = store.issue()
    assert.equal(store.consume(` ${token.toLowerCase()} `), true)
  })

  it('emitir de novo invalida o anterior no mesmo instante', () => {
    const { store } = makeStore()
    const primeiro = store.issue().token
    const segundo = store.issue().token
    assert.equal(store.consume(primeiro), false)
    assert.equal(store.consume(segundo), true)
  })

  it('sem token emitido nao ha nada a consumir', () => {
    const { store } = makeStore()
    assert.equal(store.consume('QUALQUERCOISA'), false)
  })

  it('dispose() e sincrono e apaga o token vivo (Q-2)', () => {
    const { store } = makeStore()
    const { token } = store.issue()
    assert.equal(store.dispose(), undefined, 'nao devolve promessa')
    assert.equal(store.consume(token), false)
    assert.doesNotThrow(() => store.dispose(), 'chamar duas vezes e inocuo')
  })

  it('o TTL e injetavel para teste, mas o valor de producao e o do modulo', () => {
    const { store, clock } = makeStore(1_000)
    const { token, expiresAt } = store.issue()
    assert.equal(expiresAt, clock.now() + 1_000)
    clock.advance(1_000)
    assert.equal(store.consume(token), false)
  })
})
