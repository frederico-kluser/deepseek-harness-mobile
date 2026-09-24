/**
 * VARIANTES SOBREVIVENTES da limpeza da onda 1 (FOCO 2) — o comportamento que
 * passou pela remocao do segundo provedor e nao tinha assercao propria.
 *
 * A onda 1 apagou o ramo do provedor removido em `texts.ts`, `onboarding.ts`
 * e `sonda.ts` e deixou a superficie provider-aware COM UM SO PROVEDOR: os
 * parametros `provedor`/`ProviderId` continuam nas assinaturas (o mecanismo
 * multi-provedor fica intacto de proposito), mas todo o valor agora resolve
 * para o texto/transporte do telegram. Os testes de remocao ja provam que o
 * ramo saiu; o que faltava e provar que a VARIANTE EXPLICITA (`provedor:
 * 'telegram'`) e IDENTICA a omissao — o contrato D1 «quem chama sem provedor
 * corre exatamente como antes» — e que o mapa de causas da sonda sobreviveu
 * INTEIRO (so o ramo removido saiu dele).
 *
 * Sem a palavra do provedor removido em lado nenhum (o golden master varre
 * `test/**` tambem — ver `golden-master.test.ts`).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  textoSemDono,
  textoSemToken,
  textoPronto,
  textoTokenInvalido,
  TITULO_SEM_TOKEN,
  TITULO_TOKEN_INVALIDO,
  tituloSemToken,
  tituloTokenInvalido,
} from '../../../src/telegram/texts.ts'
import {
  proximoPasso,
  type RetratoDoAmbiente,
} from '../../../src/telegram/onboarding.ts'
import { criarSonda, API_ROOT_PADRAO } from '../../../src/onboarding/sonda.ts'

/* -------------------------------------------------------------------------- */
/* Fixtures — sem literais com forma de token (regra dos spikes/telegram.md 0) */
/* -------------------------------------------------------------------------- */

const TOKEN = `123456789${':'}${'A'.repeat(2)}${'b'.repeat(33)}`
const BOT = { id: 123_456_789, username: 'meu_painel_bot' }
const CAMINHO = '~/.dsh/guarded-bot/secrets.env'
const OPCOES = { caminhoSecretsEnv: CAMINHO, minutosDoCodigo: 5 }

const SEM_TOKEN: RetratoDoAmbiente = { token: undefined, getMe: undefined, dono: undefined }

const TOKEN_INVALIDO: RetratoDoAmbiente = {
  token: { origem: 'secrets.env', formato: { valido: true, botId: 123_456_789 } },
  getMe: {
    ok: false,
    falha: {
      causa: 'recusado',
      httpStatus: 401,
      errorCode: 401,
      description: 'Unauthorized: invalid token specified',
    },
  },
  dono: undefined,
}

const SEM_DONO: RetratoDoAmbiente = {
  token: { origem: 'secrets.env', formato: { valido: true, botId: BOT.id } },
  getMe: { ok: true, bot: BOT },
  dono: undefined,
}

const PRONTO: RetratoDoAmbiente = {
  ...SEM_DONO,
  dono: { ownerUserId: '111', ownerChatId: '222', pairedAt: 1 },
}

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

/* -------------------------------------------------------------------------- */
/* Variantes de texto — provedor explicito === omissao (D1)                    */
/* -------------------------------------------------------------------------- */

describe('textos: a variante provedor="telegram" explicita e IDENTICA a omissao', () => {
  it('os titulos aceitam o provedor explicito e devolvem a constante congelada', () => {
    // O parametro sobreviveu a limpeza (`_provedor`); o valor explicito nao
    // pode mudar uma virgula do texto.
    assert.equal(tituloSemToken('telegram'), TITULO_SEM_TOKEN)
    assert.equal(tituloSemToken('telegram'), tituloSemToken())
    assert.equal(tituloTokenInvalido('telegram'), TITULO_TOKEN_INVALIDO)
    assert.equal(tituloTokenInvalido('telegram'), tituloTokenInvalido())
  })

  it('textoSemToken: com provedor explicito e byte a byte o do telegram (@BotFather)', () => {
    const variante = textoSemToken({ ...OPCOES, provedor: 'telegram' })
    assert.equal(variante, textoSemToken(OPCOES))
    assert.ok(variante.includes('@BotFather'), 'os rotulos do canal certo ficaram')
  })

  it('textoTokenInvalido: o provedor explicito nao muda o diagnostico em NENHUM estado', () => {
    // O ponto de escolha por provedor sobreviveu dentro desta funcao; com um
    // so provedor, o canal citado e sempre o mesmo.
    for (const retrato of [SEM_TOKEN, TOKEN_INVALIDO, SEM_DONO, PRONTO]) {
      assert.equal(
        textoTokenInvalido(retrato, { provedor: 'telegram' }),
        textoTokenInvalido(retrato, {}),
        'a variante explicita divergiu da omissao',
      )
    }
    assert.ok(textoTokenInvalido(TOKEN_INVALIDO, { provedor: 'telegram' }).includes('Telegram'))
  })

  it('textoSemDono e textoPronto: o provedor explicito nao muda o texto (codigo/minutos fiéis)', () => {
    const comProvedor = textoSemDono('meu_painel_bot', {
      ...OPCOES,
      provedor: 'telegram',
      codigo: '481516',
      minutosDoCodigo: 3,
    })
    assert.equal(
      comProvedor,
      textoSemDono('meu_painel_bot', { ...OPCOES, codigo: '481516', minutosDoCodigo: 3 }),
    )
    assert.ok(comProvedor.includes('481516'))
    assert.ok(comProvedor.includes('3 minutos'))
    assert.equal(textoPronto('meu_painel_bot', { ...OPCOES, provedor: 'telegram' }), textoPronto('meu_painel_bot', OPCOES))
  })
})

describe('onboarding: proximoPasso com provedor explicito nao muda titulo nem texto', () => {
  it('os quatro estados resolvem igual com e sem `provedor: "telegram"`', () => {
    for (const retrato of [SEM_TOKEN, TOKEN_INVALIDO, SEM_DONO, PRONTO]) {
      const variante = proximoPasso(retrato, { ...OPCOES, provedor: 'telegram', codigo: '481516' })
      const omissao = proximoPasso(retrato, { ...OPCOES, codigo: '481516' })
      assert.equal(variante.estado, omissao.estado)
      assert.equal(variante.titulo, omissao.titulo)
      assert.equal(variante.texto, omissao.texto)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Sonda: o mapa de causas sobreviveu INTEIRO (so o ramo removido saiu)        */
/* -------------------------------------------------------------------------- */

describe('sonda: criarSonda — mapa de causas completo e opcoes passadas ao transporte', () => {
  it('404 (rota-inexistente) -> token-invalido (o token nem forma uma rota valida)', async () => {
    const stub = fetchStub(() =>
      new Response(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }), { status: 404 }),
    )
    assert.deepEqual(await criarSonda('telegram', { buscar: stub.buscar }).verificar(TOKEN), {
      ok: false,
      erro: 'token-invalido',
    })
  })

  it('409 (conflito) -> indisponivel (outra instancia a fazer long polling)', async () => {
    const stub = fetchStub(() =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 409,
          description: 'Conflict: terminated by other getUpdates request',
        }),
        { status: 409 },
      ),
    )
    assert.deepEqual(await criarSonda('telegram', { buscar: stub.buscar }).verificar(TOKEN), {
      ok: false,
      erro: 'indisponivel',
    })
  })

  it('429 (limite-de-taxa) -> indisponivel (sem retry aqui: quem decide e o chamador)', async () => {
    const stub = fetchStub(() =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 3',
          parameters: { retry_after: 3 },
        }),
        { status: 429 },
      ),
    )
    assert.deepEqual(await criarSonda('telegram', { buscar: stub.buscar }).verificar(TOKEN), {
      ok: false,
      erro: 'indisponivel',
    })
  })

  it('500 com corpo nao-JSON -> indisponivel (houve resposta e nao se percebeu)', async () => {
    const stub = fetchStub(() => new Response('<html>proxy bloqueou</html>', { status: 500 }))
    assert.deepEqual(await criarSonda('telegram', { buscar: stub.buscar }).verificar(TOKEN), {
      ok: false,
      erro: 'indisponivel',
    })
  })

  it('a apiRoot das opcoes chega ao transporte (POST /bot<token>/getMe, barra final aparada)', async () => {
    const stub = fetchStub(() =>
      new Response(JSON.stringify({ ok: true, result: BOT }), { status: 200 }),
    )
    await criarSonda('telegram', { apiRoot: 'http://duplo.invalid/', buscar: stub.buscar }).verificar(TOKEN)
    const pedido = stub.pedidos[0]
    assert.ok(pedido !== undefined, 'a sonda chamou o transporte')
    assert.equal(pedido.url, `http://duplo.invalid/bot${TOKEN}/getMe`)
    assert.equal(pedido.init === undefined ? undefined : pedido.init.method, 'POST')
  })

  it('sem apiRoot, a sonda fala com a raiz PUBLICA (API_ROOT_PADRAO)', async () => {
    const stub = fetchStub(() =>
      new Response(JSON.stringify({ ok: true, result: BOT }), { status: 200 }),
    )
    await criarSonda('telegram', { buscar: stub.buscar }).verificar(TOKEN)
    const pedido = stub.pedidos[0]
    assert.ok(pedido !== undefined, 'a sonda chamou o transporte')
    assert.equal(pedido.url, `${API_ROOT_PADRAO}/bot${TOKEN}/getMe`)
  })
})
