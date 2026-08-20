/**
 * `src/session/store.ts` -- SESS-001, SESS-003, SESS-004, SESS-005, SESS-008,
 * SESS-009 de `04-TESTES.md` 5.2.
 *
 * TODO o tempo aqui vem do `FakeClock` do PREP: nenhum teste espera 60 min nem
 * 8 h, e nenhum falsifica `Date.now()` globalmente -- falsificar o relogio do
 * processo contaminaria toda a suite e o proximo teste a ler a hora herdava a
 * mentira.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inspect } from 'node:util'

import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_ID_BYTES,
  SESSION_MAX_LIVE,
  createSessionStore,
  systemClock,
} from '../../../src/session/store.ts'
import { FakeClock } from '../../support/clock.ts'

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/u

function makeStore(clock = new FakeClock(0)) {
  return { clock, store: createSessionStore({ clock }) }
}

describe('SESS-001 -- o id e opaco, de CSPRNG, com >=128 bits', () => {
  it('emite 43 octetos base64url (256 bits) e nunca repete', () => {
    const { store } = makeStore()
    const vistos = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      const id: string = store.create()
      assert.match(id, BASE64URL_43, 'id fora do alfabeto base64url de 43 octetos')
      assert.equal(vistos.has(id), false, 'id repetido: a fonte nao e CSPRNG')
      vistos.add(id)
      store.revoke(id)
    }
    assert.equal(vistos.size, 200)
  })

  it('pede exatamente SESSION_ID_BYTES a fonte de aleatoriedade', () => {
    const pedidos: number[] = []
    let n = 0
    const store = createSessionStore({
      clock: new FakeClock(0),
      randomBytes: (size) => {
        pedidos.push(size)
        n += 1
        return new Uint8Array(size).fill(n)
      },
    })
    store.create()
    assert.deepEqual(pedidos, [SESSION_ID_BYTES])
    assert.equal(SESSION_ID_BYTES * 8, 256)
    assert.equal(SESSION_ID_BYTES * 8 >= 128, true, 'ASVS 7.2.3 exige >=128 bits')
  })

  it('nao toca em Math.random em caminho nenhum', () => {
    const original = Math.random
    let chamadas = 0
    Math.random = () => {
      chamadas += 1
      return original()
    }
    try {
      const { store } = makeStore()
      const id: string = store.create()
      store.validate(id)
      store.regenerate(id)
    } finally {
      Math.random = original
    }
    assert.equal(chamadas, 0, 'Math.random NAO e um CSPRNG')
  })

  it('o id em claro nao fica no store: o idHash e um digest curto e estavel', () => {
    const { store } = makeStore()
    const id: string = store.create()
    const primeira = store.validate(id)
    const segunda = store.validate(id)
    assert.notEqual(primeira, null)
    assert.match(primeira?.idHash ?? '', /^[0-9a-f]{16}$/u)
    assert.equal(primeira?.idHash, segunda?.idHash, 'o hash tem de ser estavel')
    assert.equal(id.includes(primeira?.idHash ?? 'x'), false, 'o hash nao pode ser um pedaco do id')

    const outro: string = store.create()
    assert.notEqual(store.validate(outro)?.idHash, primeira?.idHash)
  })

  it('o relogio de producao existe e anda', () => {
    const antes = Date.now()
    const agora = systemClock.now()
    assert.equal(agora >= antes, true)
  })
})

describe('Q-4 -- a sessao devolvida nao vaza o id por serializacao acidental', () => {
  it('JSON.stringify da sessao NAO contem o id', () => {
    const { store } = makeStore()
    const id: string = store.create()
    const serializada = JSON.stringify(store.validate(id))

    assert.equal(serializada.includes(id), false, 'o id de sessao vazou num JSON.stringify')
    assert.equal(JSON.parse(serializada).id, '[REDACTED]')
  })

  it('util.inspect da sessao NAO contem o id -- e este e o caminho de console.log', () => {
    const { store } = makeStore()
    const id: string = store.create()
    const impressa = inspect(store.validate(id))

    // `console.log(obj)` formata por `util.inspect`, NAO por `toJSON()`.
    // Fechar so o `JSON.stringify` era fechar a porta e deixar a janela aberta.
    assert.equal(impressa.includes(id), false, 'o id de sessao vazou num console.log')
    assert.match(impressa, /id: '\[REDACTED\]'/u)
  })

  it('o idHash sobrevive as duas redaccoes: e o que o audit log consome', () => {
    const { store } = makeStore()
    const id: string = store.create()
    const sessao = store.validate(id)
    const idHash = sessao?.idHash ?? ''

    assert.match(idHash, /^[0-9a-f]{16}$/u)
    assert.equal(JSON.stringify(sessao).includes(idHash), true)
    assert.equal(inspect(sessao).includes(idHash), true)
  })

  it('quem precisa mesmo do id pede-o pelo nome -- gesto deliberado, nao acidente', () => {
    const { store } = makeStore()
    const id: string = store.create()
    assert.equal(store.validate(id)?.id, id)
  })
})

describe('SESS-003 -- inatividade de 60 min, MEDIDA com relogio injetado', () => {
  it('um segundo antes do limite ainda vale; no limite exato, morre', () => {
    const { clock, store } = makeStore()
    const id: string = store.create()

    clock.advance(SESSION_IDLE_TIMEOUT_MS - 1000)
    assert.notEqual(store.validate(id), null, 'ainda dentro da janela de inatividade')

    // O `validate` acima renovou o ultimo uso: recomeca a contagem.
    clock.advance(SESSION_IDLE_TIMEOUT_MS)
    assert.equal(store.validate(id), null, 'no limite exato a sessao tem de morrer')
    assert.equal(store.live, 0, 'a sessao expirada tem de sair do mapa')
  })

  it('a constante e LIDA: com 59 min de uso repetido a sessao sobrevive 4 h', () => {
    const { clock, store } = makeStore()
    const id: string = store.create()
    for (let i = 0; i < 4; i += 1) {
      clock.advance(59 * 60 * 1000)
      assert.notEqual(store.validate(id), null, `renovacao ${i} falhou`)
    }
    assert.equal(SESSION_IDLE_TIMEOUT_MS, 60 * 60 * 1000)
  })

  it('um relogio que anda PARA TRAS nao estica a janela', () => {
    const { clock, store } = makeStore()
    const id: string = store.create()

    clock.advance(30 * 60 * 1000)
    assert.notEqual(store.validate(id), null)

    clock.set(0)
    const sessao = store.validate(id)
    assert.equal(sessao?.ultimoUsoEm, 30 * 60 * 1000, 'o ultimo uso nunca pode recuar')

    clock.set(30 * 60 * 1000 + SESSION_IDLE_TIMEOUT_MS)
    assert.equal(store.validate(id), null)
  })
})

describe('SESS-004 -- teto absoluto de 8 h, INDEPENDENTE de atividade', () => {
  it('uso a cada 30 min nao adia a morte as 8 h', () => {
    const { clock, store } = makeStore()
    const id: string = store.create()

    for (let decorrido = 0; decorrido < SESSION_ABSOLUTE_TIMEOUT_MS - 30 * 60 * 1000; ) {
      clock.advance(30 * 60 * 1000)
      decorrido += 30 * 60 * 1000
      assert.notEqual(store.validate(id), null, `morreu cedo demais aos ${decorrido} ms`)
    }

    clock.advance(30 * 60 * 1000)
    assert.equal(store.validate(id), null, 'as 8 h a sessao morre com ou sem atividade')
    assert.equal(SESSION_ABSOLUTE_TIMEOUT_MS, 8 * 60 * 60 * 1000)
  })
})

describe('SESS-005 -- regeneracao APOS autenticar (anti session-fixation)', () => {
  it('o id apresentado antes do login deixa de valer no instante do login', () => {
    const { store } = makeStore()
    const plantado: string = store.create()
    assert.notEqual(store.validate(plantado), null, 'pre-condicao: o id plantado valia')

    const novo: string = store.regenerate(plantado)

    assert.notEqual(novo, plantado, 'o id TEM de mudar apos autenticar')
    assert.equal(store.validate(plantado), null, 'o id pre-login continuou valido')
    assert.notEqual(store.validate(novo), null)
    assert.equal(store.live, 1, 'a regeneracao nao pode deixar as duas vivas')
  })

  it('regenerar sem id apresentado e o mesmo que create()', () => {
    const { store } = makeStore()
    const a: string = store.regenerate(undefined)
    const b: string = store.create()
    assert.notEqual(a, b)
    assert.equal(store.live, 2)
  })

  it('um id apresentado que nem sequer tem a forma de id nao rebenta nada', () => {
    const { store } = makeStore()
    const novo: string = store.regenerate('nao-e-um-id')
    assert.notEqual(store.validate(novo), null)
    assert.equal(store.live, 1)
  })

  it('COMPORTAMENTO MEDIDO: apresentar lixo nao revoga nada, e isso nao abre fixation', () => {
    const { store } = makeStore()
    const viva: string = store.create()

    const novo: string = store.regenerate('!!!invalido!!!')

    // Fica UMA A MAIS: o lixo nao apagou nada. Nao e buraco de fixation --
    // todo id vivo e base64url de 43 octetos e casa SEMPRE com a forma, logo o
    // que nao casa nunca esteve no mapa e nao havia nada para revogar.
    assert.equal(store.live, 2)
    assert.notEqual(store.validate(viva), null, 'a sessao anterior sobrevive, de proposito')
    assert.notEqual(store.validate(novo), null)

    // A invariante verdadeira e esta: apresentado um id REAL, ele morre.
    store.regenerate(viva)
    assert.equal(store.validate(viva), null)
  })

  it('regenerar revoga UMA, nao todas: o telemovel nao cai quando o portatil entra', () => {
    const { store } = makeStore()
    const telemovel: string = store.create()
    const antigoPortatil: string = store.create()

    store.regenerate(antigoPortatil)

    assert.notEqual(store.validate(telemovel), null, 'regenerate nao e um revokeAll disfarcado')
    assert.equal(store.validate(antigoPortatil), null)
  })
})

describe('SESS-008/SESS-009 -- revogacao do lado do servidor', () => {
  it('revoke() invalida uma; devolve false a segunda vez', () => {
    const { store } = makeStore()
    const id: string = store.create()
    const outra: string = store.create()

    assert.equal(store.revoke(id), true)
    assert.equal(store.revoke(id), false)
    assert.equal(store.validate(id), null)
    assert.notEqual(store.validate(outra), null, 'o logout de uma nao derruba as outras')
  })

  it('revoke() de lixo devolve false sem tocar no mapa', () => {
    const { store } = makeStore()
    store.create()
    assert.equal(store.revoke('curto'), false)
    assert.equal(store.live, 1)
  })

  it('revokeAll() derruba TODAS (rotacao de segredo, queda do tunel)', () => {
    const { store } = makeStore()
    const ids: string[] = [store.create(), store.create(), store.create()]
    store.revokeAll()
    for (const id of ids) assert.equal(store.validate(id), null)
    assert.equal(store.live, 0)
  })
})

describe('validate() perante entrada hostil', () => {
  it('recusa em silencio o que nao tem a forma de um id', () => {
    const { store } = makeStore()
    store.create()
    for (const lixo of ['', 'curto', 'a'.repeat(257), 'com espaco aqui dentro!', '../../etc/passwd']) {
      assert.equal(store.validate(lixo), null, `aceitou ${JSON.stringify(lixo)}`)
    }
  })

  it('um id bem formado mas desconhecido e apenas null', () => {
    const { store } = makeStore()
    assert.equal(store.validate('A'.repeat(43)), null)
  })
})

describe('Q-2 -- disposer SINCRONO e idempotente', () => {
  it('apos dispose(): validate fecha em silencio, emitir LANCA', () => {
    const { store } = makeStore()
    const id: string = store.create()

    store.dispose()

    assert.equal(store.validate(id), null, 'leitura tardia tem de ser fail-closed, nao crash')
    assert.equal(store.live, 0)
    assert.throws(() => store.create(), /ja foi disposto/u)
    assert.throws(() => store.regenerate(id), /ja foi disposto/u)
  })

  it('dispose() duas vezes nao lanca, e revoke/revokeAll continuam inertes', () => {
    const { store } = makeStore()
    const id: string = store.create()
    store.dispose()
    assert.doesNotThrow(() => store.dispose())
    assert.equal(store.revoke(id), false)
    assert.doesNotThrow(() => store.revokeAll())
  })
})

describe('limites de memoria', () => {
  it('a emissao varre as expiradas em vez de as acumular', () => {
    const { clock, store } = makeStore()
    store.create()
    store.create()
    assert.equal(store.live, 2)

    clock.advance(SESSION_IDLE_TIMEOUT_MS)
    store.create()
    assert.equal(store.live, 1, 'as duas expiradas tinham de ter saido na varredura')
  })

  it('ao teto, sai a sessao de uso mais antigo', () => {
    const { clock, store } = makeStore()
    const primeiro: string = store.create()
    for (let i = 1; i < SESSION_MAX_LIVE; i += 1) {
      clock.advance(1000)
      store.create()
    }
    assert.equal(store.live, SESSION_MAX_LIVE)

    clock.advance(1000)
    const ultimo: string = store.create()
    assert.equal(store.live, SESSION_MAX_LIVE)
    assert.equal(store.validate(primeiro), null, 'a mais antiga tinha de ter saido')
    assert.notEqual(store.validate(ultimo), null)
  })
})
