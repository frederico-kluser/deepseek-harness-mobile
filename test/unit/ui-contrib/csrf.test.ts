/**
 * Token anti-CSRF da superficie de UI nativa. A doutrina (NIST SP 800-63B-4
 * 5.1.1) e a do painel; este guard e independente de proposito (ver o
 * cabecalho de `src/ui-contrib/csrf.ts`).
 *
 * O que esta suite prova: o token e amarrado ao vinculo (um token da
 * superficie nao vale para outro vinculo), a expiracao e real (relogio
 * injetado), a assinatura nao pode ser adulterada sem invalidar, e lixo de
 * qualquer tipo e recusado sem lancar.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCsrfGuard, CSRF_HEADER_NAME, CSRF_FIELD_NAME } from '../../../src/ui-contrib/csrf.ts'
import { FakeClock } from '../../support/clock.ts'

const VINCULO = 'ui-contrib'

function criarGuard(clock: FakeClock, chave?: Uint8Array) {
  return createCsrfGuard(chave === undefined ? { clock } : { clock, key: chave })
}

describe('csrf da superficie', () => {
  it('emite e verifica um token no vinculo certo', () => {
    const clock = new FakeClock(1_000)
    const guard = criarGuard(clock)
    const token = guard.issue(VINCULO)
    assert.equal(guard.verify(token, VINCULO), true)
  })

  it('um token do vinculo A nao vale no vinculo B', () => {
    const clock = new FakeClock(1_000)
    const guard = criarGuard(clock)
    const token = guard.issue('ui-contrib')
    assert.equal(guard.verify(token, 'outra-superficie'), false)
  })

  it('expirado e recusado (relogio injetado)', () => {
    const clock = new FakeClock(1_000)
    const guard = criarGuard(clock, undefined)
    const token = guard.issue(VINCULO)
    clock.advance(30 * 60 * 1000) // o TTL e exatamente 30 minutos
    assert.equal(guard.verify(token, VINCULO), false)
  })

  it('token dentro do prazo continua valido (nao expira cedo demais)', () => {
    const clock = new FakeClock(1_000)
    const guard = criarGuard(clock)
    const token = guard.issue(VINCULO)
    clock.advance(29 * 60 * 1000)
    assert.equal(guard.verify(token, VINCULO), true)
  })

  it('assinatura adulterada e recusada', () => {
    const clock = new FakeClock(1_000)
    const guard = criarGuard(clock)
    const token = guard.issue(VINCULO)
    // Adultera um caractere NO MEIO da assinatura: o ultimo char de base64url
    // sem padding partilha bits com o penultimo e pode decodificar para os
    // mesmos bytes — o meio nunca pode.
    const meio = Math.floor(token.length / 2)
    const trocado = token[meio] === 'A' ? 'B' : 'A'
    const adulterado = token.slice(0, meio) + trocado + token.slice(meio + 1)
    assert.equal(guard.verify(adulterado, VINCULO), false)
  })

  it('adiantar a expiracao declarada no token e recusado (a expiracao e assinada)', () => {
    const clock = new FakeClock(1_000)
    const guard = criarGuard(clock)
    const token = guard.issue(VINCULO)
    const ponto = token.indexOf('.')
    assert.ok(ponto > 0)
    const expiracao = Number.parseInt(token.slice(0, ponto), 36)
    const adiantado = `${(expiracao + 60_000).toString(36)}.${token.slice(ponto + 1)}`
    assert.equal(guard.verify(adiantado, VINCULO), false)
  })

  it('lixo de todo o tipo e recusado sem lancar', () => {
    const clock = new FakeClock(1_000)
    const guard = criarGuard(clock)
    for (const lixo of [undefined, null, 42, {}, [], '', 'x', '.', '..', 'a'.repeat(200)]) {
      assert.equal(guard.verify(lixo, VINCULO), false, `lixo aceite: ${String(lixo)}`)
    }
  })

  it('chave curta demais falha alto no arranque', () => {
    const clock = new FakeClock(1_000)
    assert.throws(() => criarGuard(clock, new Uint8Array(8)), /curta demais/u)
  })

  it('ttlMs invalido ou nao positivo falha alto no arranque (fail loud, nao na primeira verificacao)', () => {
    const clock = new FakeClock(1_000)
    assert.throws(() => createCsrfGuard({ clock, ttlMs: 0 }), /ttlMs/u)
    assert.throws(() => createCsrfGuard({ clock, ttlMs: Number.NaN }), /ttlMs/u)
    assert.throws(() => createCsrfGuard({ clock, ttlMs: -1 }), /ttlMs/u)
  })

  it('o cabecalho e o campo de corpo tem os nomes da convencao', () => {
    assert.equal(CSRF_HEADER_NAME, 'x-dsh-csrf')
    assert.equal(CSRF_FIELD_NAME, 'csrf')
  })
})
