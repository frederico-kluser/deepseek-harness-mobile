/**
 * ULID da superficie — o `requestId` e a CHAVE DE IDEMPOTENCIA do
 * `ControlIntent` (D29/CTL-020): repetido, o controlador devolve o resultado
 * da primeira execucao. Dois cliques que gerassem o mesmo `requestId`
 * produziriam idempotencia fantasma — o segundo clique pareceria aceite sem
 * ter acontecido. E por isso que a unicidade e a monotonicidade sao testadas,
 * nao assumidas.
 *
 * Onda 6 (Frente 3): a fabrica NAO e implementada aqui — e re-exportada de
 * `src/ulid.ts` — e este teste prende a paridade com o painel: os
 * dois importam a MESMA funcao (identidade), e a monotonicidade da fabrica
 * canonica e exigida nos DOIS lados (a nao-monotonica morre aqui e no
 * `test/unit/panel/ulid.test.ts`).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createUlidFactory } from '../../../src/ui-contrib/ulid.ts'
import { createUlidFactory as criarDoPainel } from '../../../src/panel/ulid.ts'
import { FakeClock } from '../../support/clock.ts'

/** Base32 de Crockford — o alfabeto da especificacao ULID. */
const FORMA_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u

describe('ulid da superficie', () => {
  it('Frente 3: a UI nativa e o painel importam A MESMA fabrica — nao ha duplicacao em src/', () => {
    // Duplicar a implementacao em panel (em vez de re-exportar) morre aqui.
    assert.equal(createUlidFactory, criarDoPainel)
  })

  it('tem 26 caracteres do alfabeto de Crockford (especificacao ULID)', () => {
    const clock = new FakeClock(1_700_000_000_000)
    const ulid = createUlidFactory(() => clock.now())
    for (let i = 0; i < 100; i += 1) {
      const id = ulid()
      assert.match(id, FORMA_ULID, `id gerado invalido: ${id}`)
    }
  })

  it('nunca repete um id (1000 geracoes no MESMO milissegundo)', () => {
    const clock = new FakeClock(42)
    const ulid = createUlidFactory(() => clock.now())
    const vistos = new Set<string>()
    for (let i = 0; i < 1000; i += 1) {
      const id = ulid()
      assert.equal(vistos.has(id), false, `id repetido: ${id}`)
      vistos.add(id)
    }
  })

  it('e monotonicamente crescente quando o relogio avanca (ordem lexicografica)', () => {
    const clock = new FakeClock(1_700_000_000_000)
    const ulid = createUlidFactory(() => clock.now())
    let anterior = ulid()
    for (let i = 0; i < 500; i += 1) {
      clock.advance(1)
      const atual = ulid()
      assert.ok(atual > anterior, `ordem violada: ${atual} <= ${anterior}`)
      anterior = atual
    }
  })

  it('e monotonicamente crescente mesmo com relogio CONGELADO (regra monotonic ULID)', () => {
    const clock = new FakeClock(7)
    const ulid = createUlidFactory(() => clock.now())
    let anterior = ulid()
    for (let i = 0; i < 200; i += 1) {
      const atual = ulid()
      assert.ok(atual > anterior, `ordem violada com relogio parado: ${atual} <= ${anterior}`)
      anterior = atual
    }
  })

  it('nao repete timestamp quando o relogio anda para tras', () => {
    const clock = new FakeClock(1_000)
    const ulid = createUlidFactory(() => clock.now())
    const primeiro = ulid()
    clock.advance(5)
    ulid()
    clock.set(1_000) // relogio voltou
    const depoisDoRecuo = ulid()
    assert.ok(depoisDoRecuo > primeiro, `o recuo do relogio repetiu timestamp: ${depoisDoRecuo}`)
  })
})
