/**
 * `worker/providers/telegram/teclado.ts` — a renderizacao de saida:
 * `ActionRowLayout` -> `InlineKeyboardMarkup`, e a edicao/answer in-place.
 * Port fiel de `worker/lib/keyboard.ts`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ActionRowLayout } from '../../../../../worker/surface/contract.ts'
import {
  answerCallbackAlways,
  assertCallbackData,
  editMessageTextInPlace,
  isNotModified,
  renderActionRowLayout,
  type InlineKeyboardApi,
} from '../../../../../worker/providers/telegram/teclado.ts'
import { captureLog } from './apoio.ts'

describe('provider/telegram/teclado — renderActionRowLayout', () => {
  it('uma ActionRow vira UM botao inline com callback_data `g1:<acao>:<token>`', () => {
    const layout: ActionRowLayout = [[{ label: 'Ligar', action: 'tunnel.up', token: 'ABC' }]]
    const markup = renderActionRowLayout(layout)
    const linha = markup?.inline_keyboard[0]
    const botao = linha?.[0] as { text?: string; callback_data?: string } | undefined
    assert.equal(markup?.inline_keyboard.length, 1)
    assert.equal(botao?.text, 'Ligar')
    assert.equal(botao?.callback_data, 'g1:tunnel.up:ABC')
  })

  it('linha com botao defeituoso (rotulo vazio) e descartada sem derrubar o envio', () => {
    const layout: ActionRowLayout = [[{ label: '', action: 'tunnel.up', token: 'ABC' }]]
    const log = captureLog()
    assert.equal(renderActionRowLayout(layout, log.logger), undefined)
    assert.match(log.all(), /vazio/u)
  })

  it('callback_data acima de 64 bytes e recusado na renderizacao (falha visivel, TG-026)', () => {
    const layout: ActionRowLayout = [[{ label: 'Ok', action: 'emergency', token: 'a'.repeat(80) }]]
    const log = captureLog()
    assert.equal(renderActionRowLayout(layout, log.logger), undefined)
    assert.match(log.all(), /callback_data invalido/u)
  })

  it('actionRows vazio devolve undefined (sem teclado)', () => {
    assert.equal(renderActionRowLayout([]), undefined)
  })
})

describe('provider/telegram/teclado — assertCallbackData (2a linha de defesa dos 64 B)', () => {
  it('aceita no limite de 64 bytes', () => {
    const data = 'g1:tunnel.up:' + 'a'.repeat(40)
    assert.equal(assertCallbackData(data), data)
  })
  it('recusa acima de 64 bytes, em BYTES nao caracteres', () => {
    assert.throws(() => assertCallbackData('g1:tunnel.up:confirmação'.repeat(3)), /BYTES/u)
  })
  it('recusa vazio', () => {
    assert.throws(() => assertCallbackData(''), /vazio/u)
  })
})

describe('provider/telegram/teclado — editMessageTextInPlace', () => {
  function apiEditando(resultado: unknown, falha?: unknown): InlineKeyboardApi {
    return {
      async answerCallbackQuery() {
        return true
      },
      async editMessageText() {
        if (falha !== undefined) throw falha
        return resultado
      },
    }
  }

  it('sucesso devolve edited', async () => {
    const log = captureLog()
    const out = await editMessageTextInPlace(
      apiEditando({ ok: true }),
      { chatId: 1, messageId: 9 },
      'texto',
      log.logger,
    )
    assert.equal(out, 'edited')
  })

  it('message is not modified -> unchanged, NAO falha (resultado esperado)', async () => {
    const log = captureLog()
    const out = await editMessageTextInPlace(
      apiEditando(undefined, { error_code: 400, description: 'Bad Request: message is not modified' }),
      { chatId: 1, messageId: 9 },
      'texto',
      log.logger,
    )
    assert.equal(out, 'unchanged')
    assert.equal(log.lines.length, 0, 'nao regista como erro')
  })

  it('outro erro -> failed e regista', async () => {
    const log = captureLog()
    const out = await editMessageTextInPlace(
      apiEditando(undefined, { error_code: 403, description: 'Forbidden: bot was blocked by the user' }),
      { chatId: 1, messageId: 9 },
      'texto',
      log.logger,
    )
    assert.equal(out, 'failed')
    assert.match(log.all(), /editMessageText falhou/u)
  })

  it('reconhece o 400 "not modified" por substring minuscula', () => {
    assert.equal(isNotModified({ error_code: 400, description: 'Bad Request: MESSAGE IS NOT MODIFIED' }), true)
    assert.equal(isNotModified({ error_code: 403, description: 'message is not modified' }), false)
    assert.equal(isNotModified(null), false)
  })
})

describe('provider/telegram/teclado — answerCallbackAlways (TG-027)', () => {
  it('resolve true quando o canal aceita', async () => {
    const log = captureLog()
    let chamado: string | undefined
    const api: InlineKeyboardApi = {
      async answerCallbackQuery(id) {
        chamado = id
        return true
      },
      async editMessageText() {
        return undefined
      },
    }
    const ok = await answerCallbackAlways(api, 'cq-1', log.logger, { text: 'Ok' })
    assert.equal(ok, true)
    assert.equal(chamado, 'cq-1')
  })

  it('NUNCA lanca em "query is too old" — regista e resolve false', async () => {
    const log = captureLog()
    const api: InlineKeyboardApi = {
      async answerCallbackQuery() {
        throw { error_code: 400, description: 'Bad Request: query is too old and response timeout expired' }
      },
      async editMessageText() {
        return undefined
      },
    }
    const ok = await answerCallbackAlways(api, 'cq-x', log.logger)
    assert.equal(ok, false)
    assert.match(log.all(), /answerCallbackQuery falhou/u)
  })

  it('a NEGACAO vai SEM text (nao e oraculo) e sem showAlert', async () => {
    const log = captureLog()
    let payload: { readonly text?: string; readonly show_alert?: boolean } | undefined
    const api: InlineKeyboardApi = {
      async answerCallbackQuery(_id, outras) {
        payload = outras
        return true
      },
      async editMessageText() {
        return undefined
      },
    }
    await answerCallbackAlways(api, 'cq-1', log.logger)
    assert.equal(payload, undefined, 'sem text nem show_alert na negacao')
  })
})