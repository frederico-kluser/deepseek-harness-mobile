/**
 * T6.2 — os metodos do contrato sobre o FIO REAL: `getMe`, `getUpdates`,
 * `sendMessage`, `answerCallbackQuery`, `editMessageText`.
 *
 * Nenhum duplo de API: cada chamada e um pedido HTTP ao servidor falso, e a
 * assercao le o payload que o servidor registou (o que viajou na rede) e a
 * resposta que devolveu.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import {
  aguardar,
  assertSemTokenRealNoAmbiente,
  captureLog,
  chamadasDe,
  fakeMessageUpdate,
  FakeTime,
  startFakeBotApi,
  TOKEN_DE_TESTE,
  type FakeBotApi,
} from './telegram-apoio.ts'
import { createBot } from '../../worker/lib/client.ts'
import { buildPollingOptions, runPolling } from '../../worker/lib/polling.ts'

assertSemTokenRealNoAmbiente()

const abertos: FakeBotApi[] = []
after(async () => {
  await Promise.all(abertos.map((srv) => srv.close()))
})

async function bancada(pending: unknown[] = []): Promise<{ srv: FakeBotApi; bot: ReturnType<typeof createBot> }> {
  const srv = await startFakeBotApi(pending)
  abertos.push(srv)
  const log = captureLog()
  const bot = createBot({
    token: TOKEN_DE_TESTE,
    apiRoot: srv.apiRoot,
    log: log.logger,
    time: new FakeTime(),
  })
  return { srv, bot }
}

describe('e2e metodos — getMe', () => {
  it('devolve o User do duble e o token viaja em /bot<token>/getMe', async () => {
    const { srv, bot } = await bancada()

    const me = await bot.api.getMe()

    assert.equal(me.is_bot, true)
    assert.equal(me.username, 'dsh_spike_bot')
    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0]?.method, 'getme')
    assert.equal(srv.calls[0]?.token, TOKEN_DE_TESTE)
  })
})

describe('e2e metodos — sendMessage / editMessageText / answerCallbackQuery', () => {
  it('sendMessage: chat_id, text e reply_markup no payload; message_id devolvido', async () => {
    const { srv, bot } = await bancada()
    const teclado = { inline_keyboard: [[{ text: 'Ligar', callback_data: 'g1:tunnel.up:abc' }]] }

    const enviada = await bot.api.sendMessage(777000123, 'ola', { reply_markup: teclado })

    assert.equal(enviada.message_id, 101, 'o contador do duble comeca em 100 e incrementa')
    assert.equal(enviada.text, 'ola')
    const chamada = chamadasDe(srv, 'sendMessage')[0]
    assert.ok(chamada !== undefined)
    assert.equal(chamada.payload['chat_id'], 777000123)
    assert.equal(chamada.payload['text'], 'ola')
    assert.deepEqual(chamada.payload['reply_markup'], teclado)
  })

  it('editMessageText: chat_id, message_id e o texto novo no payload', async () => {
    const { srv, bot } = await bancada()
    const enviada = await bot.api.sendMessage(777000123, 'antes')

    // O tipo do grammY unioe `true` ao resultado (o caso "so message_id");
    // o que este teste prova e o PAYLOAD que viajou, nao o corpo da resposta.
    await bot.api.editMessageText(777000123, enviada.message_id, 'depois')

    const chamada = chamadasDe(srv, 'editMessageText')[0]
    assert.ok(chamada !== undefined)
    assert.equal(chamada.payload['chat_id'], 777000123)
    assert.equal(chamada.payload['message_id'], enviada.message_id)
    assert.equal(chamada.payload['text'], 'depois')
  })

  it('answerCallbackQuery: id e texto no payload, resposta true', async () => {
    const { srv, bot } = await bancada()

    const ok = await bot.api.answerCallbackQuery('12345:67890', { text: 'feito', show_alert: false })

    assert.equal(ok, true)
    const chamada = chamadasDe(srv, 'answerCallbackQuery')[0]
    assert.ok(chamada !== undefined)
    assert.equal(chamada.payload['callback_query_id'], '12345:67890')
    assert.equal(chamada.payload['text'], 'feito')
  })
})

describe('e2e metodos — getUpdates no fio', () => {
  it('entrega updates ao middleware, confirma por offset, e allowed_updates so no primeiro', async () => {
    const u1 = await fakeMessageUpdate({ updateId: 1, fromId: 111, chatId: 222, text: '/start' })
    const u2 = await fakeMessageUpdate({ updateId: 2, fromId: 111, chatId: 222, text: '/parear 000000' })
    const { srv, bot } = await bancada([u1, u2])
    const recebidos: unknown[] = []
    bot.on('message', (ctx) => {
      recebidos.push(ctx.update)
    })

    const corrida = runPolling({ bot, log: captureLog().logger, options: buildPollingOptions() })
    await aguardar(() => recebidos.length >= 2, 'os dois updates chegam ao middleware', 8000)
    await bot.stop()
    const outcome = await corrida

    assert.ok(outcome.kind === 'stopped')
    assert.deepEqual(
      recebidos.map((u) => (u as { update_id?: unknown }).update_id),
      [1, 2],
      'na ordem e sem perdas',
    )
    const primeira = recebidos[0] as { message?: { from?: { id?: unknown }; chat?: { id?: unknown } } } | undefined
    assert.equal(primeira?.message?.from?.id, 111)
    assert.equal(primeira?.message?.chat?.id, 222, 'os DOIS eixos da identidade chegam intactos')

    const gus = chamadasDe(srv, 'getUpdates')
    assert.ok(gus.length >= 2)
    assert.deepEqual(
      gus[0]?.payload['allowed_updates'],
      ['message', 'callback_query'],
      'o PRIMEIRO getUpdates carrega allowed_updates',
    )
    for (const g of gus.slice(1)) {
      assert.equal(
        Object.hasOwn(g.payload, 'allowed_updates'),
        false,
        'os seguintes omitem: o servidor ja fixou o valor no primeiro',
      )
    }
    assert.equal(gus[0]?.payload['timeout'], 50)
    assert.equal(gus[0]?.payload['limit'], 100)
    assert.deepEqual(srv.state.pending, [], 'offset positivo confirmou (apagou) os updates no servidor')
  })
})
