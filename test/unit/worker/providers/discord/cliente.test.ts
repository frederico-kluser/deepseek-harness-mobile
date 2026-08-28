/**
 * `worker/providers/discord/cliente.ts` — o cliente REST via `fetch` contra o
 * duble local (zero rede, zero SDK).
 *
 * Cobre: os QUATRO verbos (gateway/bot, mensagem nova, edicao, callback de
 * interacao), o token no CABECALHO (Bearer — nunca na URL), a classificacao
 * de erro (401, 429 com `retry_after`, rede->status 0) e os ids STRING (D4).
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import {
  classificarResposta,
  criarClienteDiscord,
  DiscordApiError,
} from '../../../../../worker/providers/discord/cliente.ts'
import { captureLog, chamadasDe, startFakeDiscord, TOKEN_DE_TESTE, type FakeDiscord } from './apoio.ts'

const abertos: FakeDiscord[] = []
after(async () => {
  await Promise.all(abertos.map((srv) => srv.close()))
})

async function bancada(): Promise<{ srv: FakeDiscord; cliente: ReturnType<typeof criarClienteDiscord> }> {
  const srv = await startFakeDiscord()
  abertos.push(srv)
  const log = captureLog()
  const cliente = criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })
  return { srv, cliente }
}

describe('provider/discord/cliente — os verbos', () => {
  it('getGatewayBot: GET /gateway/bot com Bearer; devolve url + shards', async () => {
    const { srv, cliente } = await bancada()
    const bot = await cliente.getGatewayBot()
    assert.equal(bot.url, srv.gatewayUrl)
    assert.equal(bot.shards, 1)
    const chamada = chamadasDe(srv, '/gateway/bot')[0]
    assert.ok(chamada !== undefined)
    assert.equal(chamada.authorization, `Bot ${TOKEN_DE_TESTE}`, 'o token viaja no CABECALHO')
    assert.equal(chamada.path.includes(TOKEN_DE_TESTE), false, 'e nunca na URL')
  })

  it('sendMessage: POST /channels/{id}/messages; resolve com o id STRING (D4)', async () => {
    const { srv, cliente } = await bancada()
    const enviada = await cliente.sendMessage('112233445566778899', {
      content: 'ola',
      components: [{ type: 1, components: [] }],
    })
    assert.equal(typeof enviada.id, 'string')
    assert.equal(enviada.id, 'msg-101', 'o contador do duble comeca em 100')
    const chamada = chamadasDe(srv, '/channels/')[0]
    assert.ok(chamada !== undefined)
    assert.equal(chamada.method, 'POST')
    assert.equal(chamada.path, '/channels/112233445566778899/messages')
    assert.deepEqual(chamada.body, { content: 'ola', components: [{ type: 1, components: [] }] })
  })

  it('editMessage: PATCH /channels/{id}/messages/{mid}', async () => {
    const { srv, cliente } = await bancada()
    await cliente.editMessage('c1', 'm9', { content: 'depois', components: [] })
    const chamada = chamadasDe(srv, '/channels/')[0]
    assert.ok(chamada !== undefined)
    assert.equal(chamada.method, 'PATCH')
    assert.equal(chamada.path, '/channels/c1/messages/m9')
  })

  it('answerInteraction: POST /interactions/{id}/{token}/callback', async () => {
    const { srv, cliente } = await bancada()
    await cliente.answerInteraction('i1', 'tok-interacao', { type: 6 })
    const chamada = chamadasDe(srv, '/interactions/')[0]
    assert.ok(chamada !== undefined)
    assert.equal(chamada.path, '/interactions/i1/tok-interacao/callback')
    assert.deepEqual(chamada.body, { type: 6 })
  })
})

describe('provider/discord/cliente — classificacao de erro', () => {
  it('401 -> DiscordApiError status 401 (o gateway decide o fatal)', async () => {
    const { srv, cliente } = await bancada()
    srv.queueError('gateway', { status: 401, body: { message: '401: Unauthorized', code: 0 } })
    await assert.rejects(cliente.getGatewayBot(), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 401)
      return true
    })
  })

  it('429 com retry_after (em SEGUNDOS, a doc atual) -> retryAfterMs normalizado', async () => {
    const { srv, cliente } = await bancada()
    srv.queueError('channels', { status: 429, body: { message: 'rate limited', retry_after: 1.5, global: false } })
    await assert.rejects(cliente.sendMessage('c1', { content: 'x', components: [] }), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 429)
      assert.equal(error.retryAfterMs, 1500, 'segundos -> ms')
      assert.equal(error.global, false)
      return true
    })
  })

  it('rede (servidor sem resposta) -> status 0 (transiente; o transporte nao repete POST)', async () => {
    const { srv, cliente } = await bancada()
    await srv.close()
    // remove do array para o after nao fechar duas vezes (close idempotente na pratica)
    const idx = abertos.indexOf(srv)
    if (idx !== -1) abertos.splice(idx, 1)
    await assert.rejects(cliente.sendMessage('c1', { content: 'x', components: [] }), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 0)
      return true
    })
  })

  it('classificarResposta: 200 -> undefined; erro sem retry_after -> 429 sem espera', () => {
    assert.equal(classificarResposta(200, { id: 'x' }), undefined)
    const semEspera = classificarResposta(429, { message: 'x' })
    assert.ok(semEspera instanceof DiscordApiError)
    assert.equal(semEspera.status, 429)
    assert.equal(semEspera.retryAfterMs, undefined)
    const comEspera = classificarResposta(429, { retry_after: 2 })
    assert.ok(comEspera instanceof DiscordApiError)
    assert.equal(comEspera.retryAfterMs, 2000)
  })
})
