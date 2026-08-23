/**
 * `worker/surface/ids.ts` — as funcoes PURAS de normalizacao/validacao de
 * identidade neutra da superficie.
 *
 * O contrato (`worker/surface/contract.ts`) diz que `userKey`/`chatKey` sao
 * strings NUNCA vazias, mas um `string` no TIPO nao obriga o runtime: quem
 * garante a regra e este modulo, e `04-TESTES.md` exige que a norma nao seja
 * apenas declarada. Cada caso abaixo exercita o modo de falha REAL (um adaptador
 * que produz chave com espacos ou vazia viola o contrato no runtime).
 *
 * Os DOIS eixos sao a regra da allowlist (TG-002/003): sem `chatKey` nao ha
 * para onde responder, sem `userKey` o eixo que distingue dono de estranho fica
 * vazio. `normalizeIdentity` combina os dois e quebra em `undefined` no PRIMEIRO
 * eixo que falha; `isValidIdentity` e o predicado que decide SEM carregar a
 * identidade — e tem de ser coerente com `normalizeIdentity`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isValidIdentity, normalizeIdentity, normalizeKey } from '../../../../worker/surface/ids.ts'

/* ========================================================================== */
/* normalizeKey                                                               */
/* ========================================================================== */

describe('normalizeKey -- trim antes do nao-vazio, e nada de coercao', () => {
  it('aparado os espacos brancos em volta e devolve a string limpa', () => {
    assert.equal(normalizeKey('  123456  '), '123456')
    assert.equal(normalizeKey('\t user_1 \n'), 'user_1')
    assert.equal(normalizeKey('abc'), 'abc')
  })

  it('o trim acontece ANTES do nao-vazio: so espacos volta como chave vazia', () => {
    // Uma string de so whitespace viraria uma chave vazia se o nao-vazio fosse
    // checado antes do trim -- o bug exacto que o comentario do `ids.ts` nomeia.
    assert.equal(normalizeKey('   '), undefined)
    assert.equal(normalizeKey('\t\n '), undefined)
  })

  it('devolve undefined para tudo o que nao e string ou e vazio', () => {
    for (const value of [undefined, null, '', 42, 0n, true, ['user'], { userKey: 'x' }, Symbol('x')]) {
      assert.equal(normalizeKey(value), undefined, `entrada ${String(value)} nao pode virar chave`)
    }
  })

  it('a chave vazia e o unico string que falha -- strings nao vazios passam', () => {
    assert.equal(normalizeKey(''), undefined)
    assert.equal(normalizeKey(' 0 '), '0', 'um id seria um `number`, mas ja neste modulo e string')
  })
})

/* ========================================================================== */
/* normalizeIdentity                                                          */
/* ========================================================================== */

describe('normalizeIdentity -- os DOIS eixos, sempre', () => {
  it('userKey e chatKey validos combinam numa SurfaceIdentity com os dois trimados', () => {
    assert.deepEqual(normalizeIdentity('  123  ', '  456  '), { userKey: '123', chatKey: '456' })
  })

  it('falha se QUALQUER um dos eixos nao e string nao vazio -- nunca meio-aceita', () => {
    const invalidos = [undefined, null, '', '   ', 42, true] as const
    for (const invalido of invalidos) {
      assert.equal(normalizeIdentity('  usuario ', invalido), undefined, `chat=${String(invalido)}`)
      assert.equal(normalizeIdentity(invalido, '  chat '), undefined, `user=${String(invalido)}`)
    }
  })

  it('os DOIS valores aparecem no resultado, nao so um deles duplicado', () => {
    // A armadilha da DM: `userKey` e `chatKey` sao o mesmo numero so por acaso.
    // Aqui usam-se valores distintos para provar que cada eixo vem da sua fonte.
    const identidade = normalizeIdentity('dono', 'grupo')
    assert.deepEqual(identidade, { userKey: 'dono', chatKey: 'grupo' })
  })
})

/* ========================================================================== */
/* isValidIdentity -- o predicado, coerente com normalizeIdentity             */
/* ========================================================================== */

describe('isValidIdentity -- type guard que espelha normalizeIdentity (e nao o contrario)', () => {
  it('aceita a mesma identidade que normalizeIdentity devolve como valida', () => {
    assert.equal(isValidIdentity({ userKey: 'dono', chatKey: 'grupo' }), true)
    // Com espacos em volta: `normalizeIdentity` aceita apos o trim, e o guard
    // usa a MESMA normalizacao -- por isso tem de concordar.
    assert.equal(isValidIdentity({ userKey: '  dono  ', chatKey: '  grupo ' }), true)
  })

  it('devolve false para tudo o que nao e um objecto com os DOIS eixos validos', () => {
    const invalidos: unknown[] = [
      undefined,
      null,
      'string',
      42,
      [],
      {},
      { userKey: 'dono' },
      { chatKey: 'grupo' },
      { userKey: '', chatKey: 'grupo' },
      { userKey: 'dono', chatKey: '' },
      { userKey: '   ', chatKey: 'grupo' },
    ]
    for (const valor of invalidos) {
      assert.equal(isValidIdentity(valor), false, `valor ${JSON.stringify(valor)} nao pode ser identidade valida`)
    }
  })

  it('mutar um eixo de valido para invalido vira o veredito', () => {
    const identidade: { userKey: string; chatKey: string } = { userKey: 'dono', chatKey: 'grupo' }
    assert.equal(isValidIdentity(identidade), true)
    identidade.userKey = '   '
    assert.equal(isValidIdentity(identidade), false, 'espacos brancos = chave vazia = identidade quebrada')
  })
})