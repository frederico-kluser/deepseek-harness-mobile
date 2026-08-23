/**
 * `worker/surface/actions.ts` — o marcador `alerta:` e as LINHAS DE ACAO neutras
 * (onda 2 — nucleo). Port fiel do comportamento que `test/unit/worker/commands/`
 * [router.status.test] provava sobre `extrairAlerta`/`botoesDoAlerta` de T5.2 —
 * agora contra {@link extrairAlerta} e {@link botoesDeAlerta} NEUTROS.
 *
 * COBRE: a separacao do marcador e do corpo (e o fato de «alerta:» so valer na
 * PRIMEIRA linha); o vocabulario FECHADO de {@link TIPOS_DE_ALERTA} (um tipo
 * desconhecido nao ganha botoes; o corpo e mostrado tal qual); o mapeamento
 * tipo -> linha de accao `emergency` com o ROTULO identico ao atual e token OPACO.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { botoesDeAlerta, extrairAlerta, TIPOS_DE_ALERTA, type TipoDeAlerta } from '../../../../worker/surface/actions.ts'

/* ========================================================================== */
/* extrairAlerta                                                               */
/* ========================================================================== */

describe('extrairAlerta', () => {
  it('separa o marcador da primeira linha do corpo', () => {
    const { tipo, corpo } = extrairAlerta('alerta:auth-falha\nTentativa de acesso falhada.')
    assert.equal(tipo, 'auth-falha')
    assert.equal(corpo, 'Tentativa de acesso falhada.')
  })

  it('devolve tipo undefined e o texto INTEIRO quando nao ha marcador', () => {
    const { tipo, corpo } = extrairAlerta('Apenas texto normal.')
    assert.equal(tipo, undefined)
    assert.equal(corpo, 'Apenas texto normal.')
  })

  it('o marcador so vale na PRIMEIRA linha; a meio e texto normal', () => {
    const { tipo, corpo } = extrairAlerta('texto\nalerta:sessao-nova\ncorpo')
    assert.equal(tipo, undefined, 'ocorreu alerta a meio do corpo')
    assert.equal(corpo, 'texto\nalerta:sessao-nova\ncorpo')
  })

  it('um tipo desconhecido nao e reconhecido (vocabulario fechado)', () => {
    const { tipo, corpo } = extrairAlerta('alerta:desconhecido\ncorpo')
    assert.equal(tipo, undefined)
    assert.equal(corpo, 'corpo')
  })

  it('o vocabulario de TIPOS_DE_ALERTA e FECHADO (os 9 do contrato de T5.4)', () => {
    assert.deepEqual([...TIPOS_DE_ALERTA], [
      'sessao-nova',
      'auth-falha',
      'tunel-ligar',
      'tunel-desligar',
      'ttl-expirado',
      'modo-restrito',
      'magic-suspeito',
      'relatorio',
      'link-magico',
    ])
  })
})

/* ========================================================================== */
/* TIPOS_DE_ALERTA / botoesDeAlerta                                            */
/* ========================================================================== */

describe('botoesDeAlerta', () => {
  it('os tipos que oferecem accao ganham UMA linha emergency com o rotulo igual', () => {
    for (const [tipo, rotulo] of [
      ['sessao-nova', 'Não fui eu'],
      ['auth-falha', 'Derrubar túnel agora'],
      ['ttl-expirado', 'Encerrar'],
      ['relatorio', 'Encerrar'],
    ] as const) {
      const linhas = botoesDeAlerta(tipo)
      assert.equal(linhas.length, 1, tipo)
      const linha = linhas[0]?.[0]
      assert.ok(linha !== undefined, tipo)
      assert.equal(linha.label, rotulo, tipo)
      assert.equal(linha.action, 'emergency', `${tipo}: reduz exposicao, sem nonce (CTL-024)`)
      assert.equal(linha.kind, 'emergency', `${tipo}: a natureza da accao`)
    }
  })

  it('os tipos que nao oferecem accao devolvem teclado vazio', () => {
    const semAccao: TipoDeAlerta[] = [
      'tunel-ligar',
      'tunel-desligar',
      'modo-restrito',
      'magic-suspeito',
      'link-magico',
    ]
    for (const tipo of semAccao) {
      assert.deepEqual(botoesDeAlerta(tipo), [])
    }
    assert.deepEqual(botoesDeAlerta(undefined), [])
  })

  it('o token da linha e OPACO e com a forma do nonce do host (S5)', () => {
    const linhas = botoesDeAlerta('ttl-expirado')
    const token = linhas[0]?.[0]?.token
    assert.ok(token !== undefined)
    assert.ok(token.length > 0)
    // base64url — o alfabeto que o host usa para o nonce e que o parser aceita.
    assert.match(token, /^[A-Za-z0-9_-]+$/u)
  })

  it('gera um token NOVO por chamada (o butao e de uso unico)', () => {
    const a = botoesDeAlerta('auth-falha')[0]?.[0]?.token
    const b = botoesDeAlerta('auth-falha')[0]?.[0]?.token
    assert.ok(a !== undefined && b !== undefined)
    assert.notEqual(a, b)
  })
})