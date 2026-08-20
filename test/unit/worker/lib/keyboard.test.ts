/**
 * `worker/lib/keyboard.ts` — o limite em BYTES do `callback_data`, e as duas
 * regras de interaccao.
 *
 * A armadilha dos bytes nao e teorica: `'confirmação'` tem 11 caracteres e 12
 * bytes. Quem contar caracteres passa no teste em ingles e falha em producao no
 * dia em que alguem traduzir uma string.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  answerCallbackAlways,
  assertCallbackData,
  buildInlineKeyboard,
  CALLBACK_DATA_MAX_BYTES,
  callbackDataBytes,
  editMessageTextInPlace,
  isNotModified,
} from '../../../../worker/lib/keyboard.ts'
import { captureLog } from './apoio.ts'

describe('worker/lib/keyboard — callback_data conta BYTES', () => {
  it('o limite e 64 bytes', () => {
    assert.equal(CALLBACK_DATA_MAX_BYTES, 64)
  })

  it('cada acento consome DOIS bytes, e `.length` nao ve a diferenca', () => {
    assert.equal(callbackDataBytes('confirmacao'), 11)
    // `ç` + `ã` = dois acentos = 9 ASCII + 2*2 = 13 bytes.
    assert.equal(callbackDataBytes('confirmação'), 13)
    assert.equal('confirmação'.length, 11, 'os DOIS textos tem 11 caracteres; so um tem 11 bytes')
    assert.equal('confirmacao'.length, 11)
  })

  it('64 bytes passam; 65 nao', () => {
    assert.equal(assertCallbackData('a'.repeat(64)), 'a'.repeat(64))
    assert.throws(() => assertCallbackData('a'.repeat(65)), /CALLBACK_DATA_TOO_LONG/u)
  })

  it('33 caracteres acentuados = 66 bytes: cabem na contagem errada, nao na certa', () => {
    const data = 'á'.repeat(33)
    assert.equal(data.length, 33, 'passaria num teste que contasse caracteres')
    assert.equal(callbackDataBytes(data), 66)
    assert.throws(() => assertCallbackData(data), /66 bytes \(33 caracteres\)/u)
  })

  it('vazio tambem e recusado: a Bot API exige 1-64', () => {
    assert.throws(() => assertCallbackData(''), /CALLBACK_DATA_TOO_LONG/u)
  })

  it('COSTURA T4.4: o `g1:<accao>:<token>` de buildCallbackData passa opaco e cabe', () => {
    // A gramatica e de `worker/auth/guard.ts`; aqui ela nao e conhecida nem
    // validada — so medida. O payload real gasta 24 dos 64 bytes.
    const data = 'g1:tunnel.down:01JBQ2K7Z8'
    assert.ok(callbackDataBytes(data) <= CALLBACK_DATA_MAX_BYTES)
    assert.equal(assertCallbackData(data), data, 'passa intacto: nada aqui reescreve o valor')
    assert.deepEqual(buildInlineKeyboard([[{ text: '🔴 Desligar', data }]]), {
      inline_keyboard: [[{ text: '🔴 Desligar', callback_data: data }]],
    })
  })

  it('o teclado e uma funcao pura, e valida cada botao ao construir', () => {
    const markup = buildInlineKeyboard([
      [
        { text: '🟢 Ligar', data: 'srv:on:v1' },
        { text: '🔴 Desligar', data: 'srv:off:v1' },
      ],
    ])
    assert.deepEqual(markup, {
      inline_keyboard: [
        [
          { text: '🟢 Ligar', callback_data: 'srv:on:v1' },
          { text: '🔴 Desligar', callback_data: 'srv:off:v1' },
        ],
      ],
    })
    assert.throws(() => buildInlineKeyboard([[{ text: 'x', data: 'z'.repeat(100) }]]), /TOO_LONG/u)
  })
})

describe('worker/lib/keyboard — answerCallbackQuery SEMPRE', () => {
  it('o caminho feliz responde', async () => {
    const log = captureLog()
    const vistas: string[] = []
    const ok = await answerCallbackAlways(
      {
        answerCallbackQuery: async (id) => {
          vistas.push(id)
          return Promise.resolve(true as const)
        },
      },
      'cbq-1',
      log.logger,
    )
    assert.equal(ok, true)
    assert.deepEqual(vistas, ['cbq-1'])
  })

  it('«query is too old» NAO derruba o tratamento do update', async () => {
    const log = captureLog()
    const ok = await answerCallbackAlways(
      {
        answerCallbackQuery: () =>
          Promise.reject(new Error('Bad Request: query is too old and response timeout expired')),
      },
      'cbq-2',
      log.logger,
    )
    assert.equal(ok, false, 'diz que nao conseguiu…')
    assert.match(log.all(), /o comando segue/u, '…mas NAO lanca: uma falha cosmetica nao vira funcional')
  })
})

describe('worker/lib/keyboard — edicao in-place', () => {
  it('edita no lugar em vez de mandar mensagem nova', async () => {
    const log = captureLog()
    const vistas: unknown[] = []
    const outcome = await editMessageTextInPlace(
      {
        editMessageText: async (chatId, messageId, text, other) => {
          vistas.push({ chatId, messageId, text, other })
          return Promise.resolve(true)
        },
      },
      { chatId: 7, messageId: 42 },
      'novo estado',
      log.logger,
      buildInlineKeyboard([[{ text: 'ok', data: 'ok' }]]),
    )
    assert.equal(outcome, 'edited')
    assert.equal(vistas.length, 1)
  })

  it('«message is not modified» e `unchanged`, e nao um erro', async () => {
    const log = captureLog()
    const outcome = await editMessageTextInPlace(
      {
        editMessageText: () =>
          Promise.reject(
            Object.assign(new Error('erro'), {
              error_code: 400,
              description: 'Bad Request: message is not modified',
            }),
          ),
      },
      { chatId: 7, messageId: 42 },
      'o mesmo de antes',
      log.logger,
    )
    assert.equal(outcome, 'unchanged')
    assert.equal(log.all(), '', 'nem sequer se regista: e o resultado esperado de duas difusoes iguais')
  })

  it('outra falha e `failed`, registada e NAO lancada', async () => {
    const log = captureLog()
    const outcome = await editMessageTextInPlace(
      {
        editMessageText: () =>
          Promise.reject(
            Object.assign(new Error('erro'), { error_code: 403, description: 'Forbidden: bot was blocked' }),
          ),
      },
      { chatId: 7, messageId: 42 },
      'texto',
      log.logger,
    )
    assert.equal(outcome, 'failed')
    assert.match(log.all(), /editMessageText falhou/u)
  })

  it('isNotModified nao confunde um 400 qualquer com o caso especifico', () => {
    assert.equal(isNotModified({ error_code: 400, description: 'Bad Request: message is not modified' }), true)
    assert.equal(isNotModified({ error_code: 400, description: 'Bad Request: chat not found' }), false)
    assert.equal(isNotModified({ error_code: 500, description: 'message is not modified' }), false)
    assert.equal(isNotModified(new Error('message is not modified')), false)
    assert.equal(isNotModified(null), false)
  })
})
