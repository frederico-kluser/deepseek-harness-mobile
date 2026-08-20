/**
 * `src/session/magic.ts` -- MAG-003, MAG-004 e MAG-005 de `04-TESTES.md` 5.2.2.
 *
 * MAG-001/MAG-002 (o `GET` inerte e o `POST` que consome) sao de T3.4, na Onda
 * 3: aqui nao ha rota nenhuma.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inspect } from 'node:util'

import {
  MAGIC_MAX_LIVE,
  MAGIC_TOKEN_BYTES,
  MAGIC_TTL_MS,
  createMagicStore,
} from '../../../src/session/magic.ts'
import { FakeClock } from '../../support/clock.ts'

const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/u

function makeStore(clock = new FakeClock(0)) {
  return { clock, store: createMagicStore({ clock }) }
}

describe('o mk tem 128 bits de CSPRNG', () => {
  it('22 octetos base64url, sempre diferentes', () => {
    const { store } = makeStore()
    const vistos = new Set<string>()
    for (let i = 0; i < 100; i += 1) {
      const { mk } = store.issue()
      assert.match(mk, BASE64URL_22)
      assert.equal(vistos.has(mk), false, 'mk repetido')
      vistos.add(mk)
      store.consume(mk)
    }
    assert.equal(MAGIC_TOKEN_BYTES * 8, 128)
  })

  it('pede exatamente MAGIC_TOKEN_BYTES a fonte de aleatoriedade', () => {
    const pedidos: number[] = []
    let n = 0
    const store = createMagicStore({
      clock: new FakeClock(0),
      randomBytes: (size) => {
        pedidos.push(size)
        n += 1
        return new Uint8Array(size).fill(n)
      },
    })
    store.issue()
    assert.deepEqual(pedidos, [MAGIC_TOKEN_BYTES])
  })
})

describe('MAG-004 -- TTL de 120 s, medido com relogio injetado', () => {
  it('um milissegundo antes vale; no limite exato, ja nao', () => {
    const { clock, store } = makeStore()
    const { mk, expiraEm } = store.issue()
    assert.equal(expiraEm, MAGIC_TTL_MS)

    clock.advance(MAGIC_TTL_MS - 1)
    assert.equal(store.consume(mk), true)

    const outro = store.issue()
    clock.advance(MAGIC_TTL_MS)
    assert.equal(store.consume(outro.mk), false, 'no limite exato o mk ja morreu')
    assert.equal(MAGIC_TTL_MS, 120_000)
  })

  it('o token expirado sai do mapa mesmo tendo falhado', () => {
    const { clock, store } = makeStore()
    const { mk } = store.issue()
    clock.advance(MAGIC_TTL_MS + 1)
    assert.equal(store.consume(mk), false)
    assert.equal(store.live, 0, 'consumir um expirado tem de o apagar na mesma')
  })
})

describe('MAG-003 -- uso unico', () => {
  it('o segundo consumo do MESMO mk falha', () => {
    const { store } = makeStore()
    const { mk } = store.issue()
    assert.equal(store.consume(mk), true)
    assert.equal(store.consume(mk), false)
    assert.equal(store.consume(mk), false)
  })

  it('queimar um nao queima os outros', () => {
    const { store } = makeStore()
    const a = store.issue()
    const b = store.issue()
    assert.equal(store.consume(a.mk), true)
    assert.equal(store.consume(b.mk), true)
  })

  it('mk desconhecido ou mal formado e apenas false', () => {
    const { store } = makeStore()
    store.issue()
    for (const lixo of ['', 'curto', 'A'.repeat(300), 'com espaco!', 'A'.repeat(22)]) {
      assert.equal(store.consume(lixo), false, `aceitou ${JSON.stringify(lixo)}`)
    }
    assert.equal(store.live, 1)
  })
})

describe('MAG-005 -- SO EM MEMORIA: o mk nao sobrevive ao processo', () => {
  it('um store novo nao conhece o token do store anterior', () => {
    const clock = new FakeClock(0)
    const antigo = createMagicStore({ clock })
    const { mk } = antigo.issue()

    const novo = createMagicStore({ clock })
    assert.equal(novo.consume(mk), false, 'o mk atravessou o reinicio: foi persistido algures')
    assert.equal(antigo.consume(mk), true, 'controlo: no store original ele valia')
  })

  it('revokeAll() e dispose() apagam o que estava vivo', () => {
    const { store } = makeStore()
    const a = store.issue()
    store.revokeAll()
    assert.equal(store.consume(a.mk), false)

    const b = store.issue()
    store.dispose()
    assert.equal(store.consume(b.mk), false)
    assert.equal(store.live, 0)
  })
})

describe('Q-4 -- o mk nao pode vazar por serializacao acidental', () => {
  it('JSON.stringify do token NAO contem o mk', () => {
    const { store } = makeStore()
    const token = store.issue()
    const serializado = JSON.stringify(token)
    assert.equal(serializado.includes(token.mk), false, 'o mk vazou num JSON.stringify')
    assert.equal(serializado.includes('[REDACTED]'), true)
    assert.equal(JSON.parse(serializado).expiraEm, token.expiraEm)
  })

  it('JSON.stringify do proprio store NAO contem nada', () => {
    const { store } = makeStore()
    const token = store.issue()
    const serializado = JSON.stringify(store)
    assert.equal(serializado.includes(token.mk), false)
    assert.equal(serializado, '"[MagicStore REDACTED]"')
  })

  it('util.inspect do token NAO contem o mk -- e este e o caminho de console.log', () => {
    const { store } = makeStore()
    const token = store.issue()
    const impresso = inspect(token)

    // `console.log(token)` NAO passa por `toJSON()`. Fechar so o
    // `JSON.stringify` deixava aberto o habito mais comum de todos.
    assert.equal(impresso.includes(token.mk), false, 'o mk vazou num console.log')
    assert.match(impresso, /mk: '\[REDACTED\]'/u)
  })

  it('util.inspect do proprio store tambem nao mostra nada', () => {
    const { store } = makeStore()
    const token = store.issue()
    const impresso = inspect(store)

    assert.equal(impresso.includes(token.mk), false)
    // Um custom inspect que devolve string e usado VERBATIM, sem aspas.
    assert.equal(impresso, '[MagicStore REDACTED]')
  })

  it('nem sequer o digest interno e alcancavel pelo objeto emitido', () => {
    const { store } = makeStore()
    const token = store.issue()
    assert.deepEqual(Object.keys(token).sort(), ['expiraEm', 'mk', 'toJSON'])
  })
})

describe('Q-2 -- disposer sincrono e idempotente', () => {
  it('emitir depois de disposto LANCA; consumir fecha em silencio', () => {
    const { store } = makeStore()
    const { mk } = store.issue()
    store.dispose()

    assert.equal(store.consume(mk), false)
    assert.throws(() => store.issue(), /ja foi disposto/u)
    assert.doesNotThrow(() => store.dispose())
    assert.doesNotThrow(() => store.revokeAll())
  })
})

describe('limites de memoria', () => {
  it('a emissao varre os expirados', () => {
    const { clock, store } = makeStore()
    store.issue()
    store.issue()
    clock.advance(MAGIC_TTL_MS)
    store.issue()
    assert.equal(store.live, 1)
  })

  it('ao teto, sai o que expira primeiro', () => {
    const { clock, store } = makeStore()
    const primeiro = store.issue()
    for (let i = 1; i < MAGIC_MAX_LIVE; i += 1) {
      clock.advance(1)
      store.issue()
    }
    assert.equal(store.live, MAGIC_MAX_LIVE)

    clock.advance(1)
    const ultimo = store.issue()
    assert.equal(store.live, MAGIC_MAX_LIVE)
    assert.equal(store.consume(primeiro.mk), false, 'o mais antigo tinha de ter saido')
    assert.equal(store.consume(ultimo.mk), true)
  })
})
