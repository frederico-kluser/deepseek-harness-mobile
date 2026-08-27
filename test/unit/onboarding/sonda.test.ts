/**
 * `src/onboarding/sonda.ts` — a sonda provider-aware: o probe comum por
 * provedor (`criarSonda`), a sonda discord (fetch puro, sem SDK) e a raiz da
 * API por provedor (`apiRootDe`).
 *
 * O transporte telegram (`criarSondaHttp`/`getMe`/`getUpdates`) e testado a
 * fundo em `test/unit/telegram/onboarding.test.ts` (contra o duplo local da
 * Bot API); aqui prova-se a FABRICA e o RAMO DISCORD — com `fetch` STUB, sem
 * rede nenhuma (nunca discord.com).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  apiRootDe,
  criarSonda,
  criarSondaDiscord,
  criarSondaHttp,
  DISCORD_API_ROOT_PADRAO,
  type OpcoesDeSondaDeProvedor,
} from '../../../src/onboarding/sonda.ts'
import { criarSondaHttp as criarSondaHttpReexportado } from '../../../src/telegram/onboarding.ts'

const TOKEN_DISCORD = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.Gf3x9.token.secreto'
const TOKEN_TELEGRAM = '123456789:AAsegredoDoBotTelegram'

/** Um `fetch` stub: devolve a resposta dada e REGISTA o pedido. */
function fetchStub(
  resposta: () => Response | Promise<Response>,
): { buscar: typeof fetch; pedidos: Array<{ url: string; init?: RequestInit | undefined }> } {
  const pedidos: Array<{ url: string; init?: RequestInit | undefined }> = []
  return {
    pedidos,
    buscar: async (url, init) => {
      pedidos.push({ url: String(url), init })
      return await resposta()
    },
  }
}

/** Resposta JSON do Discord (o corpo de `/users/@me`). */
function respostaDiscord(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('criarSonda -- probe comum do provedor', () => {
  it('discord: 200 {username} -> ok com botNome, e o pedido e GET /users/@me com Bearer', async () => {
    const stub = fetchStub(() => respostaDiscord(200, { id: '123', username: 'meu_painel_bot' }))
    const sonda = criarSonda('discord', { buscar: stub.buscar })

    const prova = await sonda.verificar(TOKEN_DISCORD)

    assert.deepEqual(prova, { ok: true, botNome: 'meu_painel_bot' })
    assert.equal(stub.pedidos.length, 1)
    const pedido = stub.pedidos[0]
    assert.ok(pedido !== undefined)
    const init = pedido.init
    assert.ok(init !== undefined, 'o fetch stub recebeu as opcoes do pedido')
    // A FORMA do transporte discord: o token no CABECALHO, nunca no URL —
    // o oposto do telegram (`/bot<token>/<metodo>`). Sem isto, o token do
    // discord iria no caminho de um URL (TG-069 tem outra cara aqui).
    assert.equal(pedido.url, `${DISCORD_API_ROOT_PADRAO}/users/@me`)
    assert.equal(init.method, 'GET')
    const cabecalhos = new Headers(init.headers)
    assert.equal(cabecalhos.get('authorization'), `Bearer ${TOKEN_DISCORD}`)
  })

  it('discord: 401 -> falha token-invalido', async () => {
    const stub = fetchStub(() => respostaDiscord(401, { message: '401: Unauthorized' }))
    const prova = await criarSonda('discord', { buscar: stub.buscar }).verificar(TOKEN_DISCORD)
    assert.deepEqual(prova, { ok: false, erro: 'token-invalido' })
  })

  it('discord: sem resposta (rede) -> falha rede, e a mensagem do fetch (com o URL) e descartada', async () => {
    const stub = fetchStub(() => {
      throw new Error(`fetch failed: ${DISCORD_API_ROOT_PADRAO}/users/@me`)
    })
    const sonda = criarSonda('discord', { buscar: stub.buscar })
    const prova = await sonda.verificar(TOKEN_DISCORD)
    assert.deepEqual(prova, { ok: false, erro: 'rede' })
    assert.ok(!JSON.stringify(prova).includes(DISCORD_API_ROOT_PADRAO))
  })

  it('discord: 500 inesperado -> falha indisponivel', async () => {
    const stub = fetchStub(() => respostaDiscord(500, { message: 'Internal Server Error' }))
    const prova = await criarSonda('discord', { buscar: stub.buscar }).verificar(TOKEN_DISCORD)
    assert.deepEqual(prova, { ok: false, erro: 'indisponivel' })
  })

  it('discord: 200 sem username (corpo nao-User) -> ok sem botNome (espelho do caso telegram)', async () => {
    const stub = fetchStub(() => respostaDiscord(200, { id: '123' }))
    const prova = await criarSonda('discord', { buscar: stub.buscar }).verificar(TOKEN_DISCORD)
    assert.deepEqual(prova, { ok: true })
  })

  it('discord: a raiz da API aceita barra final (o duplo de teste pode traze-la)', async () => {
    const stub = fetchStub(() => respostaDiscord(200, { username: 'x' }))
    await criarSonda('discord', { apiRoot: 'http://127.0.0.1:9/api/v10/', buscar: stub.buscar }).verificar(
      TOKEN_DISCORD,
    )
    assert.equal(stub.pedidos[0]?.url, 'http://127.0.0.1:9/api/v10/users/@me')
  })

  it('telegram: 200 com identidade -> ok com botNome (a MESMA logica do getMe, sem duplicar)', async () => {
    const stub = fetchStub(() =>
      new Response(JSON.stringify({ ok: true, result: { id: 123456789, username: 'meu_painel_bot' } }), {
        status: 200,
      }),
    )
    const prova = await criarSonda('telegram', { buscar: stub.buscar }).verificar(TOKEN_TELEGRAM)
    assert.deepEqual(prova, { ok: true, botNome: 'meu_painel_bot' })
    // O transporte telegram manda o token no CAMINHO do URL — a forma da API.
    assert.ok(stub.pedidos[0]?.url.includes(`/bot${TOKEN_TELEGRAM}/getMe`))
  })

  it('telegram: 401 -> falha token-invalido', async () => {
    const stub = fetchStub(() =>
      new Response(
        JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized: invalid token specified' }),
        { status: 401 },
      ),
    )
    const prova = await criarSonda('telegram', { buscar: stub.buscar }).verificar(TOKEN_TELEGRAM)
    assert.deepEqual(prova, { ok: false, erro: 'token-invalido' })
  })

  it('telegram: 200 sem username (bot existe sem @username) -> ok sem botNome (verde legitimo)', async () => {
    const stub = fetchStub(() => new Response(JSON.stringify({ ok: true, result: { id: 123 } }), { status: 200 }))
    const prova = await criarSonda('telegram', { buscar: stub.buscar }).verificar(TOKEN_TELEGRAM)
    assert.deepEqual(prova, { ok: true })
  })

  it('telegram: falha de rede -> erro rede', async () => {
    const stub = fetchStub(() => {
      throw new Error('fetch failed')
    })
    const prova = await criarSonda('telegram', { buscar: stub.buscar }).verificar(TOKEN_TELEGRAM)
    assert.deepEqual(prova, { ok: false, erro: 'rede' })
  })
})

describe('criarSondaDiscord -- o transporte discord em si (fetch puro, sem SDK)', () => {
  it('o token viaja no cabecalho Authorization: Bearer e em mais lado nenhum', async () => {
    const stub = fetchStub(() => respostaDiscord(200, { username: 'bot' }))
    await criarSondaDiscord({ buscar: stub.buscar }).verificar(TOKEN_DISCORD)
    const pedido = stub.pedidos[0]
    assert.ok(pedido !== undefined)
    const url = pedido.url
    assert.ok(!url.includes(TOKEN_DISCORD), 'o token NAO pode estar no URL')
    assert.ok(!url.includes(encodeURIComponent(TOKEN_DISCORD)), 'nem codificado')
    const cabecalhos = new Headers(pedido.init?.headers)
    assert.equal(cabecalhos.get('authorization'), `Bearer ${TOKEN_DISCORD}`)
  })

  it('401 -> token-invalido (o unico juiz do valor e a API)', async () => {
    const stub = fetchStub(() => respostaDiscord(401, { message: '401: Unauthorized' }))
    const prova = await criarSondaDiscord({ buscar: stub.buscar }).verificar(TOKEN_DISCORD)
    assert.equal(prova.ok, false)
    assert.equal(prova.erro, 'token-invalido')
  })
})

describe('apiRootDe -- a raiz da API por provedor (espelho do worker)', () => {
  it('telegram le TELEGRAM_API_ROOT; discord le DISCORD_API_ROOT', () => {
    const ambiente = {
      TELEGRAM_API_ROOT: 'http://127.0.0.1:1/telegram',
      DISCORD_API_ROOT: 'http://127.0.0.1:1/discord',
    }
    assert.equal(apiRootDe('telegram', ambiente), 'http://127.0.0.1:1/telegram')
    assert.equal(apiRootDe('discord', ambiente), 'http://127.0.0.1:1/discord')
  })

  it('ausente ou so espacos = a raiz publica (undefined)', () => {
    assert.equal(apiRootDe('discord', {}), undefined)
    assert.equal(apiRootDe('discord', { DISCORD_API_ROOT: '   ' }), undefined)
    assert.equal(apiRootDe('telegram', { DISCORD_API_ROOT: 'http://x' }), undefined)
  })
})

describe('o transporte telegram portado continua no mesmo lugar para quem ja importava', () => {
  it('criarSondaHttp importado de onboarding.ts e o MESMO de sonda.ts (sem duplicacao)', async () => {
    const opcoes: OpcoesDeSondaDeProvedor = {
      buscar: async () =>
        new Response(JSON.stringify({ ok: true, result: { id: 123456789, username: 'u' } }), { status: 200 }),
    }
    const viaSonda = await criarSondaHttp(opcoes).getMe(TOKEN_TELEGRAM)
    const viaOnboarding = await criarSondaHttpReexportado(opcoes).getMe(TOKEN_TELEGRAM)
    assert.deepEqual(viaOnboarding, viaSonda)
  })
})
