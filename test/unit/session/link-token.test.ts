/**
 * `src/session/link-token.ts` -- a chave no link do portao (onda 1).
 *
 * PROVA as tres falsificaveis do modelo novo:
 *   - REUTILIZAVEL: a mesma chave valida SEM perder (nao e de uso unico);
 *   - revogacao: `revogar()` (chamado pela rotacao do segredo) invalida; um
 *     `emitir()` novo produz uma chave valida nova;
 *   - o token em claro NUNCA sai em serializacao (Q-4).
 */

import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { afterEach, describe, it } from 'node:test'

import { FakeClock } from '../../support/clock.ts'
import {
  createLinkTokenStore,
  encodeBase32,
  LINK_TOKEN_BYTES,
  type LinkTokenStore,
} from '../../../src/session/link-token.ts'

let store: LinkTokenStore | undefined

function abrir(): LinkTokenStore {
  store = createLinkTokenStore({ clock: new FakeClock(0) })
  return store
}

afterEach(() => {
  store?.dispose()
  store = undefined
})

describe('LinkTokenStore: emissao e verificacao', () => {
  it('emite 256 bits em base32 e verifica exatamente o portador emitido', () => {
    const s = abrir()
    const { token, expiraEm } = s.emitir()

    assert.equal(typeof token, 'string')
    assert.ok(token.length > 0)
    // 256 bits -> 32 bytes -> 52 caracteres base32 (ceil(256/5)).
    assert.equal(token.length, Math.ceil((LINK_TOKEN_BYTES * 8) / 5))
    assert.equal(expiraEm, undefined, 'esta implementacao nao impoe TTL (fecha com a rotacao)')
    assert.equal(s.live, 1)
    assert.equal(s.verificar(token), true)
    assert.equal(s.verificar('qualquer-outra-coisa'), false)
  })

  it('base32 usa apenas o alfabeto A-Z e 2-7', () => {
    const s = abrir()
    const { token } = s.emitir()
    assert.match(token, /^[A-Z2-7]+$/u)
  })

  it('encodeBase32 de bytes conhecidos e deterministico', () => {
    assert.equal(encodeBase32(new Uint8Array([0x00])), 'AA')
    assert.equal(encodeBase32(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), '32W353Y')
  })

  it('REUTILIZAVEL: verificar sucessivas NAO consomem nem invalidam a chave', () => {
    const s = abrir()
    const { token } = s.emitir()

    for (let i = 0; i < 5; i += 1) {
      assert.equal(s.verificar(token), true, `a chave continua valida na jogada ${i}`)
    }
    assert.equal(s.live, 1, 'a chave nao e queimada pelo uso')
  })

  it('uma chave emitida por cima da outra coexiste (ate o teto)', () => {
    const s = abrir()
    const a = s.emitir()
    const b = s.emitir()
    assert.equal(s.verificar(a.token), true)
    assert.equal(s.verificar(b.token), true)
  })

  it('candidato fora do alfabeto e recusado em silencio', () => {
    const s = abrir()
    s.emitir()
    for (const lixo of ['', 'a', '<script>', 'a'.repeat(300), null, undefined]) {
      assert.equal(s.verificar(lixo as never), false, JSON.stringify(lixo))
    }
  })
})

describe('LinkTokenStore: revogacao e limpeza (rotacao do segredo)', () => {
  it('revogar() invalida a chave corrente -- o que a rotacao do segredo pede', () => {
    const s = abrir()
    const { token } = s.emitir()
    s.revogar()
    assert.equal(s.verificar(token), false, 'apos revogar a chave morta nao valida')
    assert.equal(s.live, 0)
  })

  it('apos revogar, um emitir() novo produz chave valida nova', () => {
    const s = abrir()
    const { token } = s.emitir()
    s.revogar()
    const novo = s.emitir()
    assert.equal(s.verificar(token), false)
    assert.equal(s.verificar(novo.token), true)
  })

  it('limparTudo() derruba todas as chaves vivas', () => {
    const s = abrir()
    const a = s.emitir()
    const b = s.emitir()
    s.limparTudo()
    assert.equal(s.verificar(a.token), false)
    assert.equal(s.verificar(b.token), false)
    assert.equal(s.live, 0)
  })
})

describe('LinkTokenStore: Q-4 (o token em claro nunca serializa)', () => {
  it('JSON.stringify nao revela o portador', () => {
    const s = abrir()
    const { token } = s.emitir()
    assert.equal(JSON.stringify(s).includes(token), false)
  })

  it('cada token emitido redige `[REDACTED]` nos dois caminhos', () => {
    const s = abrir()
    const emitido = s.emitir()
    assert.equal(JSON.stringify(emitido).includes(emitido.token), false, 'toJSON redige')
    assert.match(JSON.stringify(emitido), /\[REDACTED\]/u)
    assert.equal(inspect(s).includes(emitido.token), false, 'inspect do store redige')
    assert.match(inspect(emitido), /token:\s*'\[REDACTED\]'/u)
  })

  it('dispose e SINCRONO e idempotente; verificar apos dispose fecha em silencio', () => {
    const s = abrir()
    const { token } = s.emitir()
    s.dispose()
    s.dispose()
    assert.equal(s.verificar(token), false)
    assert.throws(() => s.emitir(), /already|ja foi disposto|disposto/u)
  })
})