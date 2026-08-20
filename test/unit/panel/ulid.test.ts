/**
 * `newUlid` -- o gerador do `requestId` do `ControlIntent` (D29).
 *
 * O QUE ESTA SUITE FALSIFICA:
 *  - a FORMA: 26 caracteres do alfabeto Crockford (sem I, L, O, U);
 *  - o CARIMBO: os primeiros 10 caracteres codificam os 48 bits do relogio
 *    injetado, redondo -- o `requestId` carrega o instante da intencao;
 *  - a UNICIDADE: a parte aleatoria e a dos 80 bits de CSPRNG, e o `random`
 *    injetavel prova que a funcao NAO esconde um `Date.now` proprio;
 *  - a barreira: aleatoriedade curta demais LANCA em vez de produzir lixo.
 *
 * E a chave de idempotencia de D29: `requestId` repetido devolve o resultado
 * da primeira execucao (CTL-020). Dois ULIDs do mesmo instante tem de ser
 * DISTINTOS, ou duas intencoes colidiriam na chave.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { newUlid } from '../../../src/panel/ulid.ts'

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

describe('newUlid', () => {
  it('tem a forma de ULID: 26 caracteres Crockford', () => {
    const ulid = newUlid(1_700_000_000_000)
    assert.match(ulid, FORMA)
    assert.equal(ulid.length, 26)
  })

  it('os primeiros 10 caracteres codificam os 48 bits do relogio injetado', () => {
    const agora = 1_700_000_123_456
    assert.equal(decodificar(newUlid(agora)).ts, BigInt(agora))
    assert.equal(decodificar(newUlid(agora + 37)).ts, BigInt(agora + 37))
  })

  it('com aleatoriedade FIXA, o mesmo relogio produz o MESMO ulid', () => {
    assert.equal(newUlid(1_700_000_000_000, fixo), newUlid(1_700_000_000_000, fixo))
  })

  it('dois ulids do mesmo instante diferem na parte aleatoria -- D29 nao colide', () => {
    const a = decodificar(newUlid(1_700_000_000_000))
    const b = decodificar(newUlid(1_700_000_000_000))
    assert.equal(a.ts, b.ts)
    assert.notEqual(a.aleatorio, b.aleatorio)
  })

  it('instantes diferentes diferem no carimbo, mesmo com a mesma sorte', () => {
    const a = newUlid(1_700_000_000_000, fixo)
    const b = newUlid(1_700_000_000_001, fixo)
    assert.notEqual(a, b)
    assert.equal(decodificar(a).ts + 1n, decodificar(b).ts)
  })

  it('aleatoriedade curta demais LANCA em vez de produzir lixo', () => {
    assert.throws(() => newUlid(1_700_000_000_000, () => new Uint8Array(9)), /curta demais/u)
  })
})
