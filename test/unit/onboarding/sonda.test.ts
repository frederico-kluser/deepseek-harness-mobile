/**
 * `src/onboarding/sonda.ts` — a sonda provider-aware: o probe comum por
 * provedor (`criarSonda`) e a raiz da API por provedor (`apiRootDe`).
 *
 * O transporte telegram (`criarSondaHttp`/`getMe`/`getUpdates`) e testado a
 * fundo em `test/unit/telegram/onboarding.test.ts` (contra o duplo local da
 * Bot API); aqui prova-se a FABRICA — com `fetch` STUB, sem rede nenhuma.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  apiRootDe,
  criarSonda,
  criarSondaHttp,
  type OpcoesDeSondaDeProvedor,
} from '../../../src/onboarding/sonda.ts'
import { criarSondaHttp as criarSondaHttpReexportado } from '../../../src/telegram/onboarding.ts'

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

describe('criarSonda -- probe comum do provedor', () => {
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

describe('apiRootDe -- a raiz da API por provedor (espelho do worker)', () => {
  it('telegram le TELEGRAM_API_ROOT', () => {
    const ambiente = {
      TELEGRAM_API_ROOT: 'http://127.0.0.1:1/telegram',
    }
    assert.equal(apiRootDe('telegram', ambiente), 'http://127.0.0.1:1/telegram')
  })

  it('ausente ou so espacos = a raiz publica (undefined)', () => {
    assert.equal(apiRootDe('telegram', {}), undefined)
    assert.equal(apiRootDe('telegram', { TELEGRAM_API_ROOT: '   ' }), undefined)
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

describe('bordas do contrato provider-aware (Onda 2) -- timeout e raiz da API', () => {
  it('(a) o MESMO teto vale no probe telegram (o abort colapsa em rede)', async () => {
    const comeco = Date.now()
    const sonda = criarSonda('telegram', {
      buscar: async (_url, init) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(init.signal?.reason ?? new Error('abortado'))
          })
        })
        return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'x' } }), { status: 200 })
      },
      timeoutMs: 25,
    })
    const prova = await sonda.verificar(TOKEN_TELEGRAM)
    assert.deepEqual(prova, { ok: false, erro: 'rede' })
    assert.ok(Date.now() - comeco < 300, 'o abort do getMe telegram tambem corta')
  })

  it('apiRootDe: espacos em volta sao aparados; a barra final passa INTACTA (o trim e so de espacos)', () => {
    // Quem aparar a barra final aqui quebraria o contrato do `replace` que
    // vive nas sondas: `apiRootDe` devolve o que o ambiente diz, e a sondas
    // normalizam. O trim de espacos e para um `TELEGRAM_API_ROOT="  x  "` nao
    // virar um URL com espacos.
    const ambiente = { TELEGRAM_API_ROOT: '  http://127.0.0.1:9/api/v10/  ' }
    assert.equal(apiRootDe('telegram', ambiente), 'http://127.0.0.1:9/api/v10/')
  })
})
