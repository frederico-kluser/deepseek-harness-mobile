/**
 * O painel de configuracao do token e as metricas de acesso da superficie de
 * UI nativa (`/__guard-ui/api/token`, `/token-state`, `/access` e, Onda 2,
 * `/privacidade` — a checagem AO VIVO de descoberta do bot).
 *
 * As perguntas falsificaveis desta suite:
 *  - POST SEM token (vazio/em branco) -> 400 `token-vazio`, e o `sondar` nao e
 *    chamado (FOMATO antes de rede, TG-061);
 *  - formato invalido (SEM rede) -> 400 `formato-invalido`;
 *  - o `getMe` recusa na rede -> 422 `token-invalido` (paridade com o CLI);
 *  - token aceite -> grava + reinicia o worker e devolve 200 `{ok,handle}`;
 *  - SEM CSRF o POST e recusado com 403, antes de tocar o token;
 *  - O TOKEN NUNCA VAI PARA O CORPO DA RESPOSTA: nem no 200, nem nas recusas.
 *  - `/token-state` devolve so `configurado`+`handle`+`fonte`, nunca o valor;
 *  - `/access` devolve sessoes redigidas (hash, nunca o id) e NUNCA o ?key;
 *  - `/privacidade` (Onda 2) consulta AO VIVO: `ok+handle` (encontrável),
 *    `ok+null` (getMe confirmou sem username -> verde legitimo) e `ok:false`
 *    (indisponivel, NUNCA vira verde); `forcar=true` contorna o cache; o corpo
 *    so tem `ok`+`handle`+`fonte`, nunca o token.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BotEstado } from '../../../src/ui-contrib/bot-state.ts'
import {
  createNativeUiSurface,
  type UiContribBroadcast,
  type UiContribDeps,
} from '../../../src/ui-contrib/surface.ts'
import { CSRF_HEADER_NAME } from '../../../src/ui-contrib/csrf.ts'
import {
  projetarAcesso,
  projetarEstadoToken,
  projetarPrivacidade,
  UI_PATH_ACCESS,
  UI_PATH_PRIVACIDADE,
  UI_PATH_TOKEN,
  UI_PATH_TOKEN_STATE,
  type UiAcessoBruto,
  type UiPrivacidade,
  type UiTokenOps,
} from '../../../src/ui-contrib/routes.ts'
import { FakeClock } from '../../support/clock.ts'

interface RespostaCapturada {
  readonly status: number
  readonly cabecalhos: Readonly<Record<string, string>>
  readonly corpo: Record<string, unknown>
  readonly texto: string
}

interface Bancada {
  readonly gravacoes: string[]
  readonly handlesGravados: ReadonlyArray<string | undefined>
  readonly sondaCalls: string[]
  token(): string
  /** Troca o `tokenOps` injetado por um novo (por paridade com o overrides). */
  reconfigurar(operações: Partial<UiTokenOps>): void
  enviar(
    caminho: string,
    opcoes?: { metodo?: string; token?: string; corpo?: unknown },
  ): Promise<RespostaCapturada>
}

function criarBancada(opOverrides: Partial<UiTokenOps> = {}): Bancada {
  const clock = new FakeClock(1_000_000)
  const rotas = new Map<string, { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }>()
  const gravacoes: string[] = []
  const handlesGravados: Array<string | undefined> = []
  const sondaCalls: string[] = []
  let tokenDoTap = ''
  let operações: UiTokenOps = {
    validarFormato: (bruto: string) => /^\d+:[A-Za-z0-9_-]+$/u.test(bruto.trim()),
    fonte: () => 'secrets' as const,
    sondar: async (token: string) => {
      sondaCalls.push(token)
      // Formato correto mas recusado pela rede: o token "não-existe" na rede.
      if (token.startsWith('987654321:')) return { ok: false, erro: 'token-invalido' }
      return { ok: true, handle: 'meu_bot' }
    },
    gravar: (token: string, handle: string): void => {
      gravacoes.push(token)
      handlesGravados.push(handle)
    },
    estado: () => ({ configurado: false, handle: null, fonte: 'nenhum' }),
    privacidade: async () => ({ ok: true, handle: null, fonte: 'nenhum' } satisfies UiPrivacidade),
    ...opOverrides,
  }

  const deps: UiContribDeps = {
    tapIndex: (transform) => {
      const html = transform('<html><head></head><body></body></html>')
      const m = /<meta name="dsh-guard-ui-csrf" content="([^"]+)">/u.exec(html)
      tokenDoTap = m?.[1] ?? ''
      return () => undefined
    },
    registerRoute: (rota) => {
      rotas.set(rota.path, { handler: rota.handler })
      return () => undefined
    },
    emit: async () => ({ estado: 'STOPPED', idempotente: false }),
    issueNonce: () => ({ valor: 'nonce', expiresAt: clock.now() + 60_000 }),
    subscribe: (listener) => {
      listener({ seq: 1, snapshot: { state: 'STOPPED', attempts: 0 } } satisfies UiContribBroadcast)
      return () => undefined
    },
    now: () => clock.now(),
    botState: (): BotEstado => ({ online: false, motivo: 'sem-chave' }),
    provider: 'telegram',
    tokenOps: operações,
    pairOps: {
      estado: () => ({ pareado: false }),
      gerar: async () => ({ ok: true, codigo: '123456', expiraEm: clock.now() + 60_000 }),
    },
    acesso: () => ({
      conexoesAtivas: 2,
      totalSessoes: 1,
      sessoes: [
        {
          hash: 'a'.repeat(16),
          criadaEm: 1_000_000,
          ultimoUsoEm: 1_000_000,
          userAgent: 'Meu-Navegador/1.0',
          ip: undefined,
        },
      ],
      ipConfiavel: false,
    }),
    agentsOps: {
      listar: () => [],
      cancelar: () => false,
    },
  }
  void createNativeUiSurface(deps)

  const enviar = async (
    caminho: string,
    opcoes: { metodo?: string; token?: string; corpo?: unknown } = {},
  ): Promise<RespostaCapturada> => {
    // A rota registada e por PATH (sem query); a query (ex.: `?forcar=true`)
    // viaja no `req.url` para o handler ler, nao na chave do mapa de rotas.
    const pathSemQuery = caminho.split('?')[0]!
    const rota = rotas.get(pathSemQuery)
    assert.ok(rota !== undefined, `rota nao registada: ${pathSemQuery}`)
    const req = new EventEmitter() as unknown as IncomingMessage
    const bruto = req as unknown as { method: string; url: string; headers: Record<string, string>; destroy(): void }
    bruto.method = opcoes.metodo ?? 'GET'
    bruto.url = caminho
    bruto.headers = opcoes.token === undefined ? {} : { [CSRF_HEADER_NAME]: opcoes.token }
    bruto.destroy = () => undefined

    let status = 0
    let cabecalhos: Record<string, string> = {}
    let texto = ''
    const res = {
      writeHead: (s: number, h: Record<string, string>): void => {
        status = s
        cabecalhos = h
      },
      end: (corpo?: unknown): void => {
        texto = typeof corpo === 'string' ? corpo : String(corpo ?? '')
      },
    } as unknown as ServerResponse

    const pendente = rota.handler(req, res)
    if (opcoes.corpo !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(opcoes.corpo)))
    }
    req.emit('end')
    await pendente

    let corpo: Record<string, unknown> = {}
    if (texto !== '') {
      try {
        corpo = JSON.parse(texto) as Record<string, unknown>
      } catch {
        corpo = {}
      }
    }
    return { status, cabecalhos, texto, corpo }
  }

  return {
    gravacoes,
    handlesGravados,
    sondaCalls,
    token: () => {
      assert.ok(tokenDoTap.length > 0, 'o tap nao emitiu token')
      return tokenDoTap
    },
    reconfigurar: (novas): void => {
      operações = { ...operações, ...novas }
    },
    enviar,
  }
}

describe('POST /__guard-ui/api/token — formato e CSRF', () => {
  it('sem token (vazio) responde 400 token-vazio e NAO sonda a rede', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_TOKEN, {
      metodo: 'POST',
      token: bancada.token(),
      corpo: { token: '   ' },
    })
    assert.equal(resposta.status, 400)
    assert.equal(resposta.corpo.erro, 'token-vazio')
    assert.deepEqual(bancada.sondaCalls, [])
    assert.deepEqual(bancada.gravacoes, [])
  })

  it('formato invalido (sem `:`) responde 400 formato-invalido e NAO sonda', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_TOKEN, {
      metodo: 'POST',
      token: bancada.token(),
      corpo: { token: 'nao-tem-dois-pontos' },
    })
    assert.equal(resposta.status, 400)
    assert.equal(resposta.corpo.erro, 'formato-invalido')
    assert.deepEqual(bancada.sondaCalls, [])
    assert.deepEqual(bancada.gravacoes, [])
  })

  it('SEM CSRF -> 403, antes de sonda ou gravacao', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_TOKEN, {
      metodo: 'POST',
      corpo: { token: '123456789:SuperSegredoSeguro' },
    })
    assert.equal(resposta.status, 403)
    assert.deepEqual(bancada.sondaCalls, [])
    assert.deepEqual(bancada.gravacoes, [])
  })

  it('metodo errado (GET) responde 405 e NAO toca o token', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_TOKEN, { metodo: 'GET' })
    assert.equal(resposta.status, 405)
    assert.deepEqual(bancada.gravacoes, [])
  })
})

describe('POST /__guard-ui/api/token — a rede e a gravacao', () => {
  it('getMe recusa -> 422 token-invalido, e NAO grava nem reinicia', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_TOKEN, {
      metodo: 'POST',
      token: bancada.token(),
      corpo: { token: '987654321:SegredoDaContaErrada' },
    })
    assert.equal(resposta.status, 422)
    assert.equal(resposta.corpo.erro, 'token-invalido')
    assert.deepEqual(bancada.sondaCalls, ['987654321:SegredoDaContaErrada'])
    assert.deepEqual(bancada.gravacoes, [])
  })

  it('token valido -> grava + reinicia e responde 200 {ok:true, handle, fonte:secrets}', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_TOKEN, {
      metodo: 'POST',
      token: bancada.token(),
      corpo: { token: '123456789:SegredoBemFormado' },
    })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.ok, true)
    assert.equal(resposta.corpo.handle, 'meu_bot')
    // O 200 casa com a fonte que o /token-state depois reporta: como so se
    // grava quando nao ha env a sombrear, a fonte do 200 e SEMPRE 'secrets'.
    assert.equal(resposta.corpo.fonte, 'secrets')
    // A gravacao recebe EXATAMENTE o valor que veio no corpo (aparado) e o
    // handle confirmado pelo getMe (e esse handle que o estado passa a expor).
    assert.deepEqual(bancada.gravacoes, ['123456789:SegredoBemFormado'])
    assert.deepEqual(bancada.handlesGravados, ['meu_bot'])
  })

  it('a fonte efetiva e `env`: 409 token-por-env SEM sondar nem gravar (shadowing transparente)', async () => {
    const bancada = criarBancada({ fonte: () => 'env' as const })
    const resposta = await bancada.enviar(UI_PATH_TOKEN, {
      metodo: 'POST',
      token: bancada.token(),
      corpo: { token: '123456789:SegredoQueOEnvIriaSombrear' },
    })
    assert.equal(resposta.status, 409)
    assert.equal(resposta.corpo.erro, 'token-por-env')
    assert.ok(typeof resposta.corpo.aviso === 'string' && resposta.corpo.aviso.length > 0)
    // NENHUM efeito: nem sonda (o getMe nao e chamado), nem gravacao — logo o
    // handle nao pode ficar "committed" por um token que nao chegou a valer.
    assert.deepEqual(bancada.sondaCalls, [])
    assert.deepEqual(bancada.gravacoes, [])
    assert.deepEqual(bancada.handlesGravados, [])
    // O token nunca e ecoado.
    assert.equal(resposta.texto.includes('SegredoQueOEnvIriaSombrear'), false)
  })

  it('O TOKEN NUNCA e ecoado no corpo — nem no 200 nem nas recusas', async () => {
    const segredo = '123456789:SegredoQueNaoPodeVazar'
    const bancada = criarBancada()
    for (const corpo of [{ token: segredo }, { token: 'lixo-sem-dois-pontos' }, {}]) {
      const resposta = await bancada.enviar(UI_PATH_TOKEN, {
        metodo: 'POST',
        token: bancada.token(),
        corpo,
      })
      assert.equal(resposta.texto.includes(segredo), false, 'o token vazou no corpo')
    }
  })
})

describe('GET /__guard-ui/api/token-state — so o estado, nunca o valor', () => {
  it('projeta configurado + handle + fonte sem o token', () => {
    const resposta = projetarEstadoToken({ configurado: true, handle: 'meu_bot', fonte: 'secrets' })
    assert.deepEqual(resposta, { configurado: true, handle: 'meu_bot', fonte: 'secrets' })
  })

  it('handle nulo NAO vira campo presente (o UI trata null como ausencia)', () => {
    const resposta = projetarEstadoToken({ configurado: false, handle: null, fonte: 'nenhum' })
    assert.deepEqual(resposta, { configurado: false, fonte: 'nenhum' })
  })

  it('a rota GET le o estado injetado e nao rebenta sem CSRF', async () => {
    const bancada = criarBancada({ estado: () => ({ configurado: true, handle: 'meu_bot', fonte: 'env' }) })
    const resposta = await bancada.enviar(UI_PATH_TOKEN_STATE)
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.configurado, true)
    assert.equal(resposta.corpo.fonte, 'env')
  })

  it('a fonte do 200 do POST casa com a que o token-state reporta depois (honestidade do fluxo)', async () => {
    // Fonte efetiva `secrets`: o POST grava e responde fonte:'secrets'; o
    // token-state (mesma fonte) reporta a MESMA — a rota nunca diz "ok" por um
    // token que o /token-state depois contradiz.
    const bancada = criarBancada({
      fonte: () => 'secrets' as const,
      estado: () => ({ configurado: true, handle: 'meu_bot', fonte: 'secrets' }),
    })
    const post = await bancada.enviar(UI_PATH_TOKEN, {
      metodo: 'POST',
      token: bancada.token(),
      corpo: { token: '123456789:SegredoBemFormado' },
    })
    assert.equal(post.status, 200)
    assert.equal(post.corpo.fonte, 'secrets')
    const estado = await bancada.enviar(UI_PATH_TOKEN_STATE)
    assert.equal(estado.corpo.fonte, 'secrets')
  })
})

describe('GET /__guard-ui/api/access — quem/quanto acessa', () => {
  it('devolve totalConexoes, totalSessoes e a lista redigida', async () => {
    const resposta = await criarBancada().enviar(UI_PATH_ACCESS)
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.totalConexoes, 2)
    assert.equal(resposta.corpo.conexoesAtivas, 2)
    assert.equal(resposta.corpo.totalSessoes, 1)
    const sessoes = resposta.corpo.sessoes as Array<Record<string, unknown>>
    assert.equal(sessoes.length, 1)
    // Hash short (16 hex), nunca o id em claro; ip nulo quando nao confiavel.
    assert.equal(sessoes[0]?.hash, 'a'.repeat(16))
    assert.equal(sessoes[0]?.ip, null)
    assert.equal(sessoes[0]?.userAgent, 'Meu-Navegador/1.0')
    assert.equal(resposta.corpo.ipConfiavel, false)
  })

  it('projeta com ip presente quando confiavel e ip normalizado p/ null quando ausente', () => {
    const projecao = projetarAcesso({
      conexoesAtivas: 5,
      totalSessoes: 2,
      ipConfiavel: true,
      sessoes: [
        { hash: '1'.repeat(16), criadaEm: 1, ultimoUsoEm: 1, ip: '203.0.113.7', userAgent: 'A/1' },
        { hash: '2'.repeat(16), criadaEm: 1, ultimoUsoEm: 1 },
      ],
    } satisfies UiAcessoBruto)
    const sessoes = projecao.sessoes as Array<Record<string, unknown>>
    assert.equal(sessoes[0]?.ip, '203.0.113.7')
    assert.equal(sessoes[1]?.ip, null)
    assert.equal(sessoes[1]?.userAgent, null)
  })
})

describe('GET /__guard-ui/api/privacidade — a checagem AO VIVO de descoberta', () => {
  it('projeta ok+handle (encontrável), ok+null (não encontrável) e ok:false (indisponível)', () => {
    // Encontrável.
    assert.deepEqual(projetarPrivacidade({ ok: true, handle: 'meu_bot', fonte: 'secrets' }), {
      ok: true,
      handle: 'meu_bot',
      fonte: 'secrets',
    })
    // Não encontrável (getMe real confirmou sem username).
    assert.deepEqual(projetarPrivacidade({ ok: true, handle: null, fonte: 'secrets' }), {
      ok: true,
      handle: null,
      fonte: 'secrets',
    })
    // Indisponível — NUNCA vira verde.
    assert.deepEqual(projetarPrivacidade({ ok: false, erro: 'indisponivel' }), {
      ok: false,
      erro: 'indisponivel',
    })
  })

  it('a rota GET devolve o resultado da operacao AO VIVO, sem CSRF e sem token', async () => {
    const chamadas: boolean[] = []
    const bancada = criarBancada({
      privacidade: async (forcar) => {
        chamadas.push(forcar === true)
        return { ok: true, handle: 'meu_bot', fonte: 'secrets' }
      },
    })
    const resposta = await bancada.enviar(UI_PATH_PRIVACIDADE)
    assert.equal(resposta.status, 200)
    assert.deepEqual(resposta.corpo, { ok: true, handle: 'meu_bot', fonte: 'secrets' })
    assert.equal(resposta.texto.includes('meu_bot'), true)
    // GET sem CSRF: sem token no pedido, devolve o handle (público), nunca o token.
    assert.deepEqual(chamadas, [false], 'sem forcar (poll automático) passa forcar=false')
  })

  it('handle null — o getMe real confirmou que o bot NAO tem @username (verde legitimo)', async () => {
    const bancada = criarBancada({
      privacidade: async () => ({ ok: true, handle: null, fonte: 'secrets' }),
    })
    const resposta = await bancada.enviar(UI_PATH_PRIVACIDADE)
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.handle, null)
    assert.equal(resposta.corpo.ok, true)
  })

  it('getMe falhou -> ok:false indisponivel (o painel NAO inventa estado verde)', async () => {
    const bancada = criarBancada({
      privacidade: async () => ({ ok: false, erro: 'indisponivel' }),
    })
    const resposta = await bancada.enviar(UI_PATH_PRIVACIDADE)
    assert.equal(resposta.status, 200)
    assert.deepEqual(resposta.corpo, { ok: false, erro: 'indisponivel' })
    assert.ok('handle' in resposta.corpo === false, 'sem handle por cima de um erro')
  })

  it('`forcar=true` na query contorna o cache (botão "Verificar de novo")', async () => {
    const chamadas: boolean[] = []
    const bancada = criarBancada({
      privacidade: async (forcar) => {
        chamadas.push(forcar === true)
        return { ok: true, handle: null, fonte: 'secrets' }
      },
    })
    const resposta = await bancada.enviar(`${UI_PATH_PRIVACIDADE}?forcar=true`)
    assert.equal(resposta.status, 200)
    assert.deepEqual(chamadas, [true], 'a query forcar=true tem de chegar à operação')
  })

  it('sem token configurado: ok + handle null + fonte nenhum (o painel mostra "não encontrável")', async () => {
    const bancada = criarBancada({
      privacidade: async () => ({ ok: true, handle: null, fonte: 'nenhum' }),
    })
    const resposta = await bancada.enviar(UI_PATH_PRIVACIDADE)
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.ok, true)
    assert.equal(resposta.corpo.handle, null)
    assert.equal(resposta.corpo.fonte, 'nenhum')
  })
})