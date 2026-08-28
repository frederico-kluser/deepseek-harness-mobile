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
  descreverErroDoCliente,
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

describe('provider/discord/cliente — classificarResposta (bordas do corpo)', () => {
  it('2xx e 3xx nao sao erro; 4xx/5xx classificam com code/message do corpo', () => {
    assert.equal(classificarResposta(200, {}), undefined)
    assert.equal(classificarResposta(204, { id: 'x' }), undefined)
    for (const status of [404, 500, 403, 10008 as number]) {
      const erro = classificarResposta(status, { message: 'm', code: 10008 })
      assert.ok(erro instanceof DiscordApiError, `status ${status} classificado`)
      assert.equal(erro.status, status)
      assert.equal(erro.code, 10008)
      assert.equal(erro.message, 'm')
    }
  })

  it('retry_after >= 1000 ja e ms (proxy): nao multiplica por 1000', () => {
    const erro = classificarResposta(429, { retry_after: 2000 })
    assert.ok(erro instanceof DiscordApiError)
    assert.equal(erro.retryAfterMs, 2000, '2000 s seria absurdo: o valor ja esta em ms')
  })

  it('retry_after invalido (negativo, NaN, string, ausente) -> sem espera', () => {
    for (const invalido of [-1, NaN, Infinity, '1.5', null, undefined]) {
      const erro = classificarResposta(429, { retry_after: invalido })
      assert.ok(erro instanceof DiscordApiError, `retry_after ${String(invalido)} classifica na mesma`)
      assert.equal(erro.retryAfterMs, undefined, `retry_after ${String(invalido)} nao vira espera`)
    }
  })

  it('retry_after fracionario em segundos -> ms arredondado', () => {
    const erro = classificarResposta(429, { retry_after: 0.333, global: true })
    assert.ok(erro instanceof DiscordApiError)
    assert.equal(erro.retryAfterMs, 333)
    assert.equal(erro.global, true)
  })

  it('corpo nao-objecto ou com tipos errados: o erro existe sem campos extra', () => {
    for (const corpo of ['texto', 42, null, undefined]) {
      const erro = classificarResposta(500, corpo)
      assert.ok(erro instanceof DiscordApiError)
      assert.equal(erro.code, undefined)
      assert.equal(erro.retryAfterMs, undefined)
      assert.equal(erro.global, undefined)
    }
    // `global` que nao e boolean nao entra no erro.
    const erro = classificarResposta(429, { retry_after: 1, global: 'sim' })
    assert.ok(erro instanceof DiscordApiError)
    assert.equal(erro.global, undefined)
  })

  it('DiscordApiError: a mensagem default nomeia o status; a causa opcional atravessa', () => {
    const erro = new DiscordApiError(503)
    assert.equal(erro.name, 'DiscordApiError')
    assert.equal(erro.message, 'a API do Discord respondeu com HTTP 503')
    const causa = new TypeError('rede')
    const comCausa = new DiscordApiError(0, { cause: causa })
    assert.equal(comCausa.cause, causa)
  })
})

/** Cliente com `fetch` de teste: raiz com barra final + token falso. */
function clienteComBuscar(buscar: typeof fetch): ReturnType<typeof criarClienteDiscord> {
  return criarClienteDiscord({ token: TOKEN_DE_TESTE, apiRoot: 'http://x.test/', log: captureLog().logger, buscar })
}

describe('provider/discord/cliente — fetch injetado (buscar): formas e bordas', () => {

  it('a raiz com barra final e normalizada e o token vai no header, nunca na URL', async () => {
    const urls: string[] = []
    const buscas: Array<{ url: string; authorization: string }> = []
    const buscar = (async (url: string, init?: RequestInit) => {
      urls.push(String(url))
      const headers = init?.headers as Record<string, string> | undefined
      buscas.push({ url: String(url), authorization: headers?.['authorization'] ?? '' })
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 })
    }) as typeof fetch
    const cliente = clienteComBuscar(buscar)
    await cliente.sendMessage('c1', { content: 'x', components: [] })
    assert.equal(urls[0], 'http://x.test/channels/c1/messages', 'barra final cortada, sem duplicar')
    assert.equal(buscas[0]?.authorization, `Bot ${TOKEN_DE_TESTE}`, 'Bearer no header')
    assert.equal(urls[0].includes(TOKEN_DE_TESTE), false, 'nunca na URL')
  })

  it('sendMessage com id nao-STRING no corpo -> DiscordApiError status 0 (fail-closed)', async () => {
    const buscar = (async () => new Response(JSON.stringify({ id: 123456789 }), { status: 200 })) as typeof fetch
    await assert.rejects(clienteComBuscar(buscar).sendMessage('c1', { content: 'x', components: [] }), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 0)
      assert.match(error.message, /nao trouxe id/u)
      return true
    })
  })

  it('editMessage com corpo sem id STRING -> DiscordApiError status 0', async () => {
    const buscar = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch
    await assert.rejects(clienteComBuscar(buscar).editMessage('c1', 'm1', { content: 'x', components: [] }), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 0)
      return true
    })
  })

  it('getGatewayBot: corpo sem url (ou url vazia) -> erro; shards ausente -> 1', async () => {
    const semUrl = (async () => new Response(JSON.stringify({ shards: 2 }), { status: 200 })) as typeof fetch
    await assert.rejects(clienteComBuscar(semUrl).getGatewayBot(), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 0)
      assert.match(error.message, /url utilizavel/u)
      return true
    })
    const urlVazia = (async () => new Response(JSON.stringify({ url: '', shards: 9 }), { status: 200 })) as typeof fetch
    await assert.rejects(clienteComBuscar(urlVazia).getGatewayBot())
    const semShards = (async () => new Response(JSON.stringify({ url: 'ws://g' }), { status: 200 })) as typeof fetch
    assert.deepEqual(await clienteComBuscar(semShards).getGatewayBot(), { url: 'ws://g', shards: 1 })
  })

  it('resposta NAO-JSON do servidor: 200 vira corpo indefinido (id ausente -> status 0)', async () => {
    const buscar = (async () => new Response('isto nao e json', { status: 200 })) as typeof fetch
    await assert.rejects(clienteComBuscar(buscar).sendMessage('c1', { content: 'x', components: [] }), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 0)
      return true
    })
  })

  it('timeout do sinal (AbortSignal.timeout): o abort vira DiscordApiError status 0', async () => {
    const buscar = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }) as typeof fetch
    const cliente = criarClienteDiscord({
      token: TOKEN_DE_TESTE,
      apiRoot: 'http://x.test',
      log: captureLog().logger,
      timeoutMs: 30,
      buscar,
    })
    await assert.rejects(cliente.sendMessage('c1', { content: 'x', components: [] }), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 0, 'sem resposta HTTP = status 0')
      return true
    })
  })

  it('descreverErroDoCliente: loga o status quando e DiscordApiError; senao sem status', () => {
    const log = captureLog()
    descreverErroDoCliente(new DiscordApiError(429, { retryAfterMs: 1500 }), log.logger)
    descreverErroDoCliente(new Error('outra coisa'), log.logger)
    assert.match(log.all(), /status=429/u)
    assert.match(log.all(), /chamada REST do Discord falhou/u)
    const linhasSemStatus = log.lines.filter((l) => l.includes('outra coisa'))
    assert.equal(linhasSemStatus.length, 1)
    assert.equal(linhasSemStatus[0]?.includes('status='), false)
  })
})
