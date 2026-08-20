/**
 * O ULID do painel — o `requestId` do `ControlIntent` (D29).
 *
 * Onda 6 (Frente 3): UMA implementacao em `src/` para o `requestId` — a
 * MONOTONICA `createUlidFactory`, que vive em `src/ulid.ts` e e
 * re-exportada daqui (o `newUlid` one-shot delega nela). O que esta suite
 * falsifica:
 *  - a FORMA: 26 caracteres do alfabeto Crockford (sem I, L, O, U);
 *  - o CARIMBO: os primeiros 10 caracteres codificam os 48 bits do relogio
 *    injetado — o `requestId` carrega o instante da intencao;
 *  - a MONOTONICIDADE (regra "monotonic ULID"): a mesma rajada do mesmo
 *    milissegundo incrementa a parte aleatoria — ordem lexicografica estrita
 *    com relogio parado ou a avancar. A implementacao NAO-monotonica (a que
 *    a Frente 3 removeu) morre neste teste;
 *  - a IDENTIDADE com a superficie de UI nativa: o painel e o ui-contrib
 *    IMPORTAM A MESMA fabrica — duplicar a implementacao morre aqui;
 *  - a UNICIDADE: 80 bits de CSPRNG, com o `random` injetavel a provar o
 *    determinismo;
 *  - a barreira: aleatoriedade curta demais LANCA em vez de produzir lixo.
 *
 * E a chave de idempotencia de D29: `requestId` repetido devolve o resultado
 * da primeira execucao (CTL-020). Dois ULIDs do mesmo instante tem de ser
 * DISTINTOS, ou duas intencoes colidiriam na chave.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createUlidFactory, newUlid } from '../../../src/panel/ulid.ts'
import { createUlidFactory as criarDaUiContrib } from '../../../src/ui-contrib/ulid.ts'
import { FakeClock } from '../../support/clock.ts'

/** Alfabeto Crockford, a copia do codigo de producao so para DECODIFICAR. */
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Forma canonica: 26 caracteres Crockford, caixa alta. */
const FORMA = /^[0-9A-HJKMNP-TV-Z]{26}$/u

/** Aleatoriedade fixa: prova o determinismo sem depender do CSPRNG. */
const fixo = (): Uint8Array => new Uint8Array(10).fill(7)

function decodificar(ulid: string): { ts: bigint; aleatorio: bigint } {
  let ts = 0n
  for (const ch of ulid.slice(0, 10)) ts = ts * 32n + BigInt(ALFABETO.indexOf(ch))
  let aleatorio = 0n
  for (const ch of ulid.slice(10)) aleatorio = aleatorio * 32n + BigInt(ALFABETO.indexOf(ch))
  return { ts, aleatorio }
}

describe('o ULID do painel (fabricas partilhada e one-shot)', () => {
  it('Frente 3: o painel e a UI nativa importam A MESMA fabrica — nao ha duplicacao em src/', () => {
    // Duplicar a implementacao em ui-contrib (em vez de re-exportar) morre aqui.
    assert.equal(createUlidFactory, criarDaUiContrib)
  })

  it('a fabrica produz 26 caracteres Crockford', () => {
    const ulid = createUlidFactory(() => 1_700_000_000_000)
    for (let i = 0; i < 100; i += 1) {
      const id = ulid()
      assert.match(id, FORMA, `id gerado invalido: ${id}`)
      assert.equal(id.length, 26)
    }
  })

  it('os primeiros 10 caracteres codificam os 48 bits do relogio injetado', () => {
    const clock = new FakeClock(1_700_000_123_456)
    const ulid = createUlidFactory(() => clock.now())
    assert.equal(decodificar(ulid()).ts, BigInt(1_700_000_123_456))
    clock.advance(37)
    assert.equal(decodificar(ulid()).ts, BigInt(1_700_000_123_493))
  })

  it('MUTACAO dirigida: e monotonico com relogio CONGELADO — a nao-monotonica morre aqui', () => {
    const clock = new FakeClock(7)
    const ulid = createUlidFactory(() => clock.now())
    let anterior = ulid()
    for (let i = 0; i < 200; i += 1) {
      const atual = ulid()
      assert.ok(atual > anterior, `ordem violada com relogio parado: ${atual} <= ${anterior}`)
      anterior = atual
    }
  })

  it('e monotonico quando o relogio avanca (ordem lexicografica)', () => {
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

  it('com aleatoriedade FIXA, o mesmo relogio e o MESMO instante produzem o MESMO ulid', () => {
    const a = createUlidFactory(() => 1_700_000_000_000, fixo)
    const b = createUlidFactory(() => 1_700_000_000_000, fixo)
    assert.equal(a(), b())
  })

  it('dois ulids do mesmo instante diferem na parte aleatoria — D29 nao colide', () => {
    const clock = new FakeClock(1_700_000_000_000)
    const ulid = createUlidFactory(() => clock.now())
    const a = decodificar(ulid())
    const b = decodificar(ulid())
    assert.equal(a.ts, b.ts)
    assert.notEqual(a.aleatorio, b.aleatorio)
  })

  it('instantes diferentes diferem no carimbo, mesmo com a mesma sorte', () => {
    const a = createUlidFactory(() => 1_700_000_000_000, fixo)
    const b = createUlidFactory(() => 1_700_000_000_001, fixo)
    const idA = a()
    const idB = b()
    assert.notEqual(idA, idB)
    assert.equal(decodificar(idA).ts + 1n, decodificar(idB).ts)
  })

  it('aleatoriedade curta demais LANCA em vez de produzir lixo', () => {
    const ulid = createUlidFactory(() => 1_700_000_000_000, () => new Uint8Array(9))
    assert.throws(() => ulid(), /curta demais/u)
  })

  it('newUlid (one-shot do painel) delega na fabrica canonica: forma, carimbo e barreira', () => {
    const agora = 1_700_000_123_456
    const id = newUlid(agora)
    assert.match(id, FORMA)
    assert.equal(id.length, 26)
    assert.equal(decodificar(id).ts, BigInt(agora))
    assert.equal(newUlid(agora, fixo), newUlid(agora, fixo), 'mesmo instante + mesma sorte = mesmo id')
    assert.throws(() => newUlid(agora, () => new Uint8Array(9)), /curta demais/u)
  })
})
