/**
 * T6.2 — pergunta falsificavel 2: um token REAL pode vazar para o teste por env?
 *
 * A resposta e a guarda {@link assertSemTokenRealNoAmbiente}, chamada no TOPO de
 * CADA ficheiro `telegram-*.test.ts`. O `node --test` corre cada ficheiro num
 * processo proprio que HERDA o ambiente do runner: se alguem tiver exportado
 * `TELEGRAM_BOT_TOKEN` no terminal, a primeira linha de cada ficheiro lanca e a
 * suite inteira fica vermelha com a causa certa — em vez de um token real a
 * circular pelo log do runner, que nao tem mascaramento nenhum.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assertSemTokenRealNoAmbiente, TOKEN_DE_TESTE } from './telegram-apoio.ts'

// A guarda corre AQUI, no proprio ficheiro que a testa — e, por simetria, no
// topo de todos os outros `telegram-*.test.ts` deste directorio.
assertSemTokenRealNoAmbiente()

describe('e2e guarda anti-token-real', () => {
  it('com o runner limpo, a guarda passa em silencio', () => {
    assert.doesNotThrow(() => assertSemTokenRealNoAmbiente())
  })

  it('com TELEGRAM_BOT_TOKEN no ambiente do runner, a guarda ABORTA — com o nosso token falso OU com qualquer outro', () => {
    const anterior = process.env['TELEGRAM_BOT_TOKEN']
    delete process.env['TELEGRAM_BOT_TOKEN']
    try {
      // O token FALSO tambem dispara: a guarda nao distingue "real" de "falso"
      // por forma — o formato do BotFather nao e garantia de nada (ver o
      // cabecalho de `telegram-apoio.ts`). O runner corre SEM a variavel.
      process.env['TELEGRAM_BOT_TOKEN'] = TOKEN_DE_TESTE
      assert.throws(() => assertSemTokenRealNoAmbiente(), /ABORTADO/u)
      process.env['TELEGRAM_BOT_TOKEN'] = '999999999:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      assert.throws(() => assertSemTokenRealNoAmbiente(), /ABORTADO/u)
    } finally {
      if (anterior === undefined) delete process.env['TELEGRAM_BOT_TOKEN']
      else process.env['TELEGRAM_BOT_TOKEN'] = anterior
    }
    // Ambiente restaurado: a guarda volta a passar.
    assert.doesNotThrow(() => assertSemTokenRealNoAmbiente())
  })

  it('um valor so de espacos NAO e token: a guarda ignora-o', () => {
    const anterior = process.env['TELEGRAM_BOT_TOKEN']
    delete process.env['TELEGRAM_BOT_TOKEN']
    try {
      process.env['TELEGRAM_BOT_TOKEN'] = '   '
      assert.doesNotThrow(() => assertSemTokenRealNoAmbiente())
    } finally {
      if (anterior === undefined) delete process.env['TELEGRAM_BOT_TOKEN']
      else process.env['TELEGRAM_BOT_TOKEN'] = anterior
    }
  })
})
