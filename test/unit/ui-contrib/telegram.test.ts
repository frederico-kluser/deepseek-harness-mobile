/**
 * O botao Telegram da superficie de UI nativa do DSH — o estado OFFLINE/ONLINE
 * e o clique que mostra as instrucoes de ligacao.
 *
 * As perguntas falsificaveis desta suite:
 *  - sem token configurado (pareado ou nao) -> OFFLINE `sem-chave`;
 *  - token sim, pareamento nao               -> OFFLINE `sem-pareamento`;
 *  - token E pareamento                      -> ONLINE.
 *  - O TEXTO que a UI mostra NAO vaza segredo: nem a chave do bot, nem o codigo
 *    de pareamento real (o espaco reservado `/<codigo>` nunca e um numero).
 *  - O clique (POST /telegram/click) exige o token anti-CSRF, como qualquer
 *    outro POST da superficie; a rota de estado (GET) e so leitura.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ControlIntent } from '../../../src/contracts/control.ts'
import {
  createNativeUiSurface,
  type UiContribBroadcast,
  type UiContribDeps,
} from '../../../src/ui-contrib/surface.ts'
import { CSRF_HEADER_NAME } from '../../../src/ui-contrib/csrf.ts'
import {
  UI_PATH_TELEGRAM,
  UI_PATH_TELEGRAM_CLICK,
} from '../../../src/ui-contrib/routes.ts'
import {
  COMANDO_DE_PAREAMENTO,
  COMANDO_CLI,
  derivarEstadoDoBot,
  passosDoBot,
  PASSOS_DO_CONECTOR,
  PASSOS_DE_USO,
  type BotEstado,
} from '../../../src/ui-contrib/bot-state.ts'
import { FakeClock } from '../../support/clock.ts'

interface RespostaCapturada {
  readonly status: number
  readonly cabecalhos: Readonly<Record<string, string>>
  readonly corpo: Record<string, unknown>
}

interface Bancada {
  readonly rotas: Map<string, { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }>
  readonly emitidos: ControlIntent[]
  token(): string
  /** Define o estado que o `botState` injetado devolvera. */
  definirTelegrama(estado: BotEstado): void
  enviar(
    caminho: string,
    opcoes?: { metodo?: string; token?: string },
  ): Promise<RespostaCapturada>
}

function criarBancada(): Bancada {
  const clock = new FakeClock(1_000_000)
  const rotas = new Map<string, { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }>()
  const emitidos: ControlIntent[] = []
  let tokenDoTap = ''
  let telegrama: BotEstado = { online: false, motivo: 'sem-chave' }

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
    emit: async (intent) => {
      emitidos.push(intent)
      return { estado: 'STOPPED', idempotente: false }
    },
    issueNonce: () => ({ valor: 'nonce-do-host', expiresAt: clock.now() + 60_000 }),
    subscribe: (listener) => {
      listener({ seq: 1, snapshot: { state: 'STOPPED', attempts: 0 } } satisfies UiContribBroadcast)
      return () => undefined
    },
    now: () => clock.now(),
    botState: () => telegrama,
    tokenOps: {
      validarFormato: (bruto: string) => bruto.trim().includes(':'),
      fonte: () => 'secrets' as const,
      sondar: async (
        token: string,
      ): Promise<{ ok: true; handle: string } | { ok: false; erro: string }> =>
        token.trim().length > 0 ? { ok: true, handle: 'exemplo_bot' } : { ok: false, erro: 'token-invalido' },
      gravar: () => undefined,
      estado: () => ({ configurado: false, handle: null, fonte: 'nenhum' } as const),
      privacidade: async () => ({ ok: true, handle: null, fonte: 'nenhum' } as const),
    },
    pairOps: {
      estado: () => ({ pareado: false }),
      gerar: async () => ({ ok: true, codigo: '123456', expiraEm: clock.now() + 60_000 }),
    },
    acesso: () => ({
      conexoesAtivas: 0,
      totalSessoes: 0,
      sessoes: [],
      ipConfiavel: false,
    }),
  }
  void createNativeUiSurface(deps)

  const enviar = async (
    caminho: string,
    opcoes: { metodo?: string; token?: string } = {},
  ): Promise<RespostaCapturada> => {
    const rota = rotas.get(caminho)
    assert.ok(rota !== undefined, `rota nao registada: ${caminho}`)
    const req = new EventEmitter() as unknown as IncomingMessage
    const bruto = req as unknown as { method: string; url: string; headers: Record<string, string>; destroy(): void }
    bruto.method = opcoes.metodo ?? 'GET'
    bruto.url = caminho
    bruto.headers = opcoes.token === undefined ? {} : { [CSRF_HEADER_NAME]: opcoes.token }
    bruto.destroy = () => undefined

    let status = 0
    let cabecalhos: Record<string, string> = {}
    let corpoTexto = ''
    const res = {
      writeHead: (s: number, h: Record<string, string>): void => {
        status = s
        cabecalhos = h
      },
      end: (corpo?: unknown): void => {
        corpoTexto = typeof corpo === 'string' ? corpo : String(corpo ?? '')
      },
    } as unknown as ServerResponse

    const pendente = rota.handler(req, res)
    req.emit('end')
    await pendente

    return {
      status,
      cabecalhos,
      corpo: corpoTexto === '' ? {} : (JSON.parse(corpoTexto) as Record<string, unknown>),
    }
  }

  return {
    rotas,
    emitidos,
    token: () => {
      assert.ok(tokenDoTap.length > 0, 'o tap nao emitiu token')
      return tokenDoTap
    },
    definirTelegrama: (estado) => {
      telegrama = estado
    },
    enviar,
  }
}

/* ========================================================================== */
/* A DERIVACAO PURA                                                           */
/* ========================================================================== */

describe('derivarEstadoDoBot (pura)', () => {
  const pareamento = { ownerUserId: 1, ownerChatId: 1, pairedAt: 1_000 }

  it('sem token (mesmo pareado) -> OFFLINE sem-chave', () => {
    assert.deepEqual(derivarEstadoDoBot({ tokenConfigurado: false, pairing: pareamento }), {
      online: false,
      motivo: 'sem-chave',
    })
  })

  it('token sem pareamento -> OFFLINE sem-pareamento', () => {
    assert.deepEqual(derivarEstadoDoBot({ tokenConfigurado: true, pairing: undefined }), {
      online: false,
      motivo: 'sem-pareamento',
    })
  })

  it('token E pareamento -> ONLINE', () => {
    assert.deepEqual(derivarEstadoDoBot({ tokenConfigurado: true, pairing: pareamento }), {
      online: true,
    })
  })

  it('sem token e sem pareamento -> OFFLINE sem-chave (a falta da chave manda)', () => {
    assert.deepEqual(derivarEstadoDoBot({ tokenConfigurado: false, pairing: undefined }), {
      online: false,
      motivo: 'sem-chave',
    })
  })
})

/* ========================================================================== */
/* O TEXTO (instrucoes) nao vaza segredo                                      */
/* ========================================================================== */

describe('texto do Telegram sem vazamento', () => {
  it('as instrucoes de ligacao contem os passos, os comandos e o placeholder — NUNCA um codigo real', () => {
    const texto = PASSOS_DO_CONECTOR.map((p) => `${p.titulo}\n${p.texto}`).join('\n')
    assert.ok(texto.includes('@BotFather'))
    assert.ok(texto.includes('/newbot'))
    assert.ok(texto.includes(`${COMANDO_CLI} --pedir-token`))
    assert.ok(texto.includes(`${COMANDO_CLI} --parear`))
    assert.ok(texto.includes(`${COMANDO_DE_PAREAMENTO} <codigo>`))
    // O placeholder nunca traz um numero de pareamento real (PAIR-010 na UI).
    assert.ok(!/[0-9]{6}/u.test(texto), 'nenhum codigo de 6 digitos no texto')
  })

  it('`passosDoBot` distribui conector (offline) e uso (online)', () => {
    assert.equal(passosDoBot({ online: false, motivo: 'sem-chave' }), PASSOS_DO_CONECTOR)
    assert.equal(passosDoBot({ online: true }), PASSOS_DE_USO)
  })

  it('o estado projetado nunca carrega a chave — so online/motivo/handle', async () => {
    const bancada = criarBancada()
    bancada.definirTelegrama({ online: false, motivo: 'sem-pareamento' })
    const resposta = await bancada.enviar(UI_PATH_TELEGRAM)
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.online, false)
    assert.equal(resposta.corpo.motivo, 'sem-pareamento')
    assert.ok(!JSON.stringify(resposta.corpo).includes('AA'))
    bancada.definirTelegrama({ online: true })
    const online = await bancada.enviar(UI_PATH_TELEGRAM)
    assert.equal(online.corpo.online, true)
  })
})

/* ========================================================================== */
/* A ROTA GET de estado                                                       */
/* ========================================================================== */

describe('GET /__guard-ui/api/telegram', () => {
  it('sem metodo GET responde 405', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_TELEGRAM, { metodo: 'POST', token: bancada.token() })
    assert.equal(resposta.status, 405)
  })
})

/* ========================================================================== */
/* O CLIQUE (POST) e o CSRF                                                   */
/* ========================================================================== */

describe('POST /__guard-ui/api/telegram/click', () => {
  it('SEM token anti-CSRF -> 403 csrf-recusado, sem conteudo', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_TELEGRAM_CLICK, { metodo: 'POST' })
    assert.equal(resposta.status, 403)
    assert.equal(resposta.corpo.erro, 'csrf-recusado')
    assert.equal(JSON.stringify(resposta.corpo).includes('passos'), false)
  })

  it('COM token valido -> 200 com os passos do OFFLINE (instrucoes de ligacao)', async () => {
    const bancada = criarBancada()
    bancada.definirTelegrama({ online: false, motivo: 'sem-chave' })
    const resposta = await bancada.enviar(UI_PATH_TELEGRAM_CLICK, { metodo: 'POST', token: bancada.token() })
    assert.equal(resposta.status, 200)
    assert.ok(Array.isArray(resposta.corpo.passos))
    const passos = resposta.corpo.passos as Array<Record<string, unknown>>
    assert.equal(passos.length, PASSOS_DO_CONECTOR.length)
    assert.ok(passos.every((p) => typeof p.titulo === 'string' && typeof p.texto === 'string'))
    // Nem a resposta inteira vaza segredo.
    const bruto = JSON.stringify(resposta.corpo)
    assert.ok(!bruto.includes('AA'), 'nada com forma de token no clique')
    assert.ok(!/[0-9]{6}/u.test(bruto), 'nada com forma de codigo de pareamento no clique')
  })

  it('COM token valido e estado ONLINE -> 200 com as dicas de uso', async () => {
    const bancada = criarBancada()
    bancada.definirTelegrama({ online: true })
    const resposta = await bancada.enviar(UI_PATH_TELEGRAM_CLICK, { metodo: 'POST', token: bancada.token() })
    assert.equal(resposta.status, 200)
    assert.ok(Array.isArray(resposta.corpo.passos))
    assert.equal((resposta.corpo.passos as unknown[]).length, PASSOS_DE_USO.length)
  })

  it('token invalido -> 403 (verificacao em tempo constante recusa)', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_TELEGRAM_CLICK, { metodo: 'POST', token: 'invalido-este-token' })
    assert.equal(resposta.status, 403)
    assert.equal(resposta.corpo.erro, 'csrf-recusado')
  })
})