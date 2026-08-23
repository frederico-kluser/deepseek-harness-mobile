/**
 * A superficie de UI nativa do DSH (T5.5) — a suite que responde as perguntas
 * falsificaveis da revisao adversarial:
 *
 *  1. O clique EMITE um `ControlIntent` (requestId ULID novo, nonce opaco
 *     quando a acao exige), ou chama o supervisor diretamente? — os testes
 *     do bloco "ligar/desligar" provam o intent; o teste do mapa de
 *     importacoes prova a ausencia de caminho para o supervisor.
 *  2. O disposer REVERTE a contribuicao (tap reversivel — o spike S4 mediu
 *     o mecanismo)? — o bloco "registro e disposer".
 *  3. Em modo restrito, o botao de ligar e recusado e a UI mostra o motivo?
 *     — "a recusa do controlador chega a UI com motivo".
 *  4. A URL do tunel aparece ANTES de READY? — "a URL nunca sai fora de
 *     READY" (projecao) e o tap nao embute a URL (html.test.ts).
 *  5. O mecanismo depende de fio em `src/index.ts`/`cordis.patch.yml` que a
 *     sub-tarefa NAO fez? — sim, e esta reportado no handoff (os deps da
 *     superficie sao o fio; este modulo nao os inventa).
 *
 * Sem socket, sem cloudflared (D10): os handlers sao chamados diretamente
 * com `req`/`res` falsos; o relogio e o FakeClock; o controlador, o
 * ConfirmService e o broadcast sao dublos que REGISTAM as chamadas.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ControlAction, ControlIntent, ControlResultado } from '../../../src/contracts/control.ts'
import type { TunnelSnapshot } from '../../../src/contracts/tunnel.ts'
import {
  createNativeUiSurface,
  UI_REQUESTED_BY,
  type UiContribBroadcast,
  type UiContribDeps,
} from '../../../src/ui-contrib/surface.ts'
import {
  UI_PATH_ACCESS,
  UI_PATH_CLIENT,
  UI_PATH_CONFIRM,
  UI_PATH_CSRF,
  UI_PATH_PAIR,
  UI_PATH_PAIR_STATE,
  UI_PATH_RESET,
  UI_PATH_RESET_CONFIRM,
  UI_PATH_START,
  UI_PATH_STATE,
  UI_PATH_STOP,
  UI_PATH_TELEGRAM,
  UI_PATH_TELEGRAM_CLICK,
  UI_PATH_TOKEN,
  UI_PATH_TOKEN_STATE,
  type UiContribRoute,
} from '../../../src/ui-contrib/routes.ts'
import { FakeClock } from '../../support/clock.ts'

const FORMA_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u

const SNAPSHOT_PARADO: TunnelSnapshot = { state: 'STOPPED', attempts: 0 }

const URL_DO_TUNEL = 'https://s4-spike-medido.trycloudflare.com'

const INICIO = 1_000_000 // o relogio da bancada arranca aqui

const SNAPSHOT_ONLINE: TunnelSnapshot = {
  state: 'READY',
  info: { url: URL_DO_TUNEL, startedAt: INICIO, mode: 'quick' },
  attempts: 0,
  expiresAt: INICIO + 120_000,
}

/* ========================================================================== */
/* Bancada                                                                     */
/* ========================================================================== */

interface RespostaCapturada {
  readonly status: number
  readonly cabecalhos: Readonly<Record<string, string>>
  readonly corpo: Record<string, unknown>
}

interface Bancada {
  readonly clock: FakeClock
  readonly taps: Array<(html: string) => string>
  readonly rotas: Map<string, UiContribRoute>
  readonly emitidos: ControlIntent[]
  readonly noncesPedidos: ControlAction[]
  tapDesmontado: number
  rotaDesmontadas: number
  assinaturaCancelada: number
  resultadoEmit: ControlResultado
  emitLanca: Error | undefined
  ouvir(broadcast: UiContribBroadcast): void
  superficie: () => void
  rota(caminho: string): UiContribRoute
  enviar(
    caminho: string,
    opcoes?: { metodo?: string; token?: string; corpo?: unknown },
  ): Promise<RespostaCapturada>
  tokenDoUltimoTap(): string
  htmlDoUltimoTap(): string
}

function criarBancada(overrides?: Partial<UiContribDeps>): Bancada {
  const clock = new FakeClock(1_000_000)
  const taps: Array<(html: string) => string> = []
  const rotas = new Map<string, UiContribRoute>()
  const emitidos: ControlIntent[] = []
  const noncesPedidos: ControlAction[] = []
  let ouvinte: ((broadcast: UiContribBroadcast) => void) | undefined
  let tapDesmontado = 0
  let rotaDesmontadas = 0
  let assinaturaCancelada = 0
  let resultadoEmit: ControlResultado = { estado: 'STOPPED', idempotente: false }
  let emitLanca: Error | undefined
  let nonceSeq = 0

  const deps: UiContribDeps = {
    tapIndex: (transform) => {
      taps.push(transform)
      return () => {
        tapDesmontado += 1
      }
    },
    registerRoute: (rota) => {
      rotas.set(rota.path, rota)
      return () => {
        rotaDesmontadas += 1
      }
    },
    emit: async (intent) => {
      emitidos.push(intent)
      if (emitLanca !== undefined) throw emitLanca
      return resultadoEmit
    },
    issueNonce: (action) => {
      noncesPedidos.push(action)
      nonceSeq += 1
      return { valor: `nonce-opaco-${nonceSeq}`, expiresAt: clock.now() + 60_000 }
    },
    subscribe: (listener) => {
      ouvinte = listener
      return () => {
        assinaturaCancelada += 1
      }
    },
    now: () => clock.now(),
    botState: () => ({ online: false, motivo: 'sem-chave' }),
    tokenOps: {
      validarFormato: (bruto: string) => bruto.trim().includes(':'),
      fonte: () => 'secrets' as const,
      sondar: async (
        token: string,
      ): Promise<{ ok: true; handle: string } | { ok: false; erro: string }> =>
        token.trim().length > 0 ? { ok: true, handle: 'exemplo_bot' } : { ok: false, erro: 'token-invalido' },
      gravar: () => undefined,
      estado: () => ({ configurado: false, handle: null, fonte: 'nenhum' } as const),
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
    ...overrides,
  }

  const superficie = createNativeUiSurface(deps)

  const tokenDoUltimoTap = (): string => {
    const m = /<meta name="dsh-guard-ui-csrf" content="([^"]+)">/u.exec(htmlDoUltimoTap())
    assert.ok(m !== null, 'o tap nao emitiu token de CSRF')
    const token = m[1]
    assert.equal(typeof token, 'string')
    return token ?? ''
  }

  const htmlDoUltimoTap = (): string => {
    const tap = taps[0]
    assert.ok(tap !== undefined, 'nenhum tap registado')
    return tap('<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  }

  const enviar = async (
    caminho: string,
    opcoes: { metodo?: string; token?: string; corpo?: unknown } = {},
  ): Promise<RespostaCapturada> => {
    const rota = rotas.get(caminho)
    assert.ok(rota !== undefined, `rota nao registada: ${caminho}`)
    const req = new EventEmitter() as unknown as IncomingMessage
    const bruto = req as unknown as { method: string; url: string; headers: Record<string, string>; destroy(): void }
    bruto.method = opcoes.metodo ?? 'GET'
    bruto.url = caminho
    bruto.headers = opcoes.token === undefined ? {} : { 'x-dsh-csrf': opcoes.token }
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
    if (opcoes.corpo !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(opcoes.corpo)))
    }
    req.emit('end')
    await pendente

    return { status, cabecalhos, corpo: corpoTexto === '' ? {} : (JSON.parse(corpoTexto) as Record<string, unknown>) }
  }

  return {
    clock,
    taps,
    rotas,
    emitidos,
    noncesPedidos,
    get tapDesmontado() {
      return tapDesmontado
    },
    get rotaDesmontadas() {
      return rotaDesmontadas
    },
    get assinaturaCancelada() {
      return assinaturaCancelada
    },
    get resultadoEmit() {
      return resultadoEmit
    },
    set resultadoEmit(valor) {
      resultadoEmit = valor
    },
    get emitLanca() {
      return emitLanca
    },
    set emitLanca(valor) {
      emitLanca = valor
    },
    ouvir: (broadcast) => {
      const l = ouvinte
      assert.ok(l !== undefined, 'ninguem assinou o broadcast')
      l(broadcast)
    },
    superficie,
    rota: (caminho) => {
      const r = rotas.get(caminho)
      assert.ok(r !== undefined, `rota nao registada: ${caminho}`)
      return r
    },
    enviar,
    tokenDoUltimoTap,
    htmlDoUltimoTap,
  }
}

/* ========================================================================== */
/* Registro e disposer                                                        */
/* ========================================================================== */

describe('registo da contribuicao', () => {
  it('regista um tap, as rotas (telegram + reset + acesso + csrf) e a assinatura do broadcast', () => {
    const bancada = criarBancada()
    assert.equal(bancada.taps.length, 1)
    assert.deepEqual(
      [...bancada.rotas.keys()].toSorted(),
      [
        UI_PATH_STATE,
        UI_PATH_START,
        UI_PATH_CONFIRM,
        UI_PATH_STOP,
        UI_PATH_RESET,
        UI_PATH_RESET_CONFIRM,
        UI_PATH_CLIENT,
        UI_PATH_TELEGRAM,
        UI_PATH_TELEGRAM_CLICK,
        UI_PATH_TOKEN,
        UI_PATH_TOKEN_STATE,
        UI_PATH_ACCESS,
        UI_PATH_CSRF,
        UI_PATH_PAIR,
        UI_PATH_PAIR_STATE,
      ].toSorted(),
    )
    for (const rota of bancada.rotas.values()) {
      assert.equal(rota.kind, 'exact')
    }
  })

  it('o disposer REVERTE tudo (tap reversivel — a propriedade que o spike S4 mediu)', () => {
    const bancada = criarBancada()
    bancada.superficie()
    assert.equal(bancada.tapDesmontado, 1)
    assert.equal(bancada.rotaDesmontadas, 15, 'as quinze rotas (telegram + token + par + acesso + csrf) sao removidas')
    assert.equal(bancada.assinaturaCancelada, 1)
  })

  it('o disposer e idempotente (LIFE-003) e sincrono (LIFE-005)', () => {
    const bancada = criarBancada()
    bancada.superficie()
    const primeiro = { tap: bancada.tapDesmontado, rotas: bancada.rotaDesmontadas, assinatura: bancada.assinaturaCancelada }
    bancada.superficie()
    assert.deepEqual(
      { tap: bancada.tapDesmontado, rotas: bancada.rotaDesmontadas, assinatura: bancada.assinaturaCancelada },
      primeiro,
    )
  })

  it('falha no registo de uma rota reverte o que ja entrou e propaga (nunca meia contribuicao)', () => {
    const clock = new FakeClock(1_000)
    let rotasRegistadas = 0
    let rotasDesmontadas = 0
    const deps: UiContribDeps = {
      tapIndex: () => () => undefined,
      registerRoute: () => {
        rotasRegistadas += 1
        if (rotasRegistadas === 3) throw new Error('rota duplicada')
        return () => {
          rotasDesmontadas += 1
        }
      },
      emit: async () => ({ estado: 'STOPPED', idempotente: false }),
      issueNonce: () => ({ valor: 'n', expiresAt: 1 }),
      subscribe: () => () => undefined,
      now: () => clock.now(),
      botState: () => ({ online: false, motivo: 'sem-chave' }),
      tokenOps: {
        validarFormato: (bruto: string) => bruto.trim().includes(':'),
        fonte: () => 'secrets' as const,
        sondar: async (
          token: string,
        ): Promise<{ ok: true; handle: string } | { ok: false; erro: string }> =>
          token.trim().length > 0 ? { ok: true, handle: 'exemplo_bot' } : { ok: false, erro: 'token-invalido' },
        gravar: () => undefined,
        estado: () => ({ configurado: false, handle: null, fonte: 'nenhum' } as const),
      },
      pairOps: {
        estado: () => ({ pareado: false }),
        gerar: async () => ({ ok: true, codigo: '123456', expiraEm: 1_000_000_000 }),
      },
      acesso: () => ({
        conexoesAtivas: 0,
        totalSessoes: 0,
        sessoes: [],
        ipConfiavel: false,
      }),
    }
    assert.throws(() => createNativeUiSurface(deps), /rota duplicada/u)
    assert.equal(rotasDesmontadas, 2)
  })
})

/* ========================================================================== */
/* Projecao do estado                                                         */
/* ========================================================================== */

describe('projecao do estado', () => {
  it('estado responde seq + estado + URL + expiracao quando READY', async () => {
    const bancada = criarBancada()
    bancada.ouvir({ seq: 7, snapshot: SNAPSHOT_ONLINE })
    const resposta = await bancada.enviar(UI_PATH_STATE)
    assert.equal(resposta.status, 200)
    assert.deepEqual(resposta.corpo, {
      seq: 7,
      estado: 'READY',
      tentativas: 0,
      url: URL_DO_TUNEL,
      expiraEm: INICIO + 120_000,
      falha: null,
      nota: null,
    })
  })

  it('a URL do tunel NUNCA sai antes de READY', async () => {
    const bancada = criarBancada()
    bancada.ouvir({ seq: 3, snapshot: { state: 'STARTING', attempts: 1 } })
    const resposta = await bancada.enviar(UI_PATH_STATE)
    assert.equal(resposta.status, 200)
    assert.equal(JSON.stringify(resposta.corpo).includes(URL_DO_TUNEL), false)
    assert.equal('url' in resposta.corpo, false)
  })

  it('DEFESA EM PROFUNDIDADE: `info` presente fora de READY e DESCARTADA pela projecao', async () => {
    const bancada = criarBancada()
    bancada.ouvir({
      seq: 4,
      snapshot: {
        state: 'STARTING',
        attempts: 1,
        info: { url: URL_DO_TUNEL, startedAt: 1, mode: 'quick' },
      },
    })
    const resposta = await bancada.enviar(UI_PATH_STATE)
    assert.equal(JSON.stringify(resposta.corpo).includes(URL_DO_TUNEL), false)
  })

  it('difusao fora de ordem (seq nao-crescente) e DESCARTADA — a projecao nao anda para tras', async () => {
    const bancada = criarBancada()
    bancada.ouvir({ seq: 5, snapshot: SNAPSHOT_ONLINE })
    bancada.ouvir({ seq: 3, snapshot: SNAPSHOT_PARADO }) // fora de ordem
    const resposta = await bancada.enviar(UI_PATH_STATE)
    assert.equal(resposta.corpo.seq, 5)
    assert.equal(resposta.corpo.estado, 'READY')
  })

  it('sem difusao ainda, o estado responde 503 explicito — nunca um estado inventado', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_STATE)
    assert.equal(resposta.status, 503)
  })

  it('quando o TTL expira, a projecao mostra a nota em vez de um erro generico (CTL-038)', async () => {
    const bancada = criarBancada()
    bancada.ouvir({ seq: 1, snapshot: SNAPSHOT_ONLINE }) // READY, expiraEm INICIO + 120_000
    bancada.clock.set(INICIO + 200_000) // o prazo passou
    bancada.ouvir({ seq: 2, snapshot: SNAPSHOT_PARADO }) // o controlo agiu
    const resposta = await bancada.enviar(UI_PATH_STATE)
    assert.equal(resposta.corpo.estado, 'STOPPED')
    assert.equal(resposta.corpo.nota, 'TTL expirado')
    assert.equal(resposta.corpo.falha, null)
  })

  it('READY com o prazo ja passado (difusao em atraso) tambem mostra a nota', async () => {
    const bancada = criarBancada()
    bancada.clock.set(INICIO + 200_000)
    bancada.ouvir({ seq: 9, snapshot: SNAPSHOT_ONLINE })
    const resposta = await bancada.enviar(UI_PATH_STATE)
    assert.equal(resposta.corpo.nota, 'TTL expirado')
  })

  it('metodo errado responde 405 com `allow` (o despacho do host e por caminho)', async () => {
    const bancada = criarBancada()
    bancada.ouvir({ seq: 1, snapshot: SNAPSHOT_PARADO })
    const resposta = await bancada.enviar(UI_PATH_STATE, { metodo: 'POST' })
    assert.equal(resposta.status, 405)
    assert.equal(resposta.cabecalhos.allow, 'GET')
  })
})

/* ========================================================================== */
/* LIGAR — duas etapas com nonce emitido pelo host                            */
/* ========================================================================== */

describe('ligar (2 etapas, nonce opaco)', () => {
  it('passo 1: o clique pede o nonce ao HOST e devolve-o opaco', async () => {
    const bancada = criarBancada()
    const token = bancada.tokenDoUltimoTap()
    const resposta = await bancada.enviar(UI_PATH_START, { metodo: 'POST', token, corpo: {} })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.passo, 'confirmar')
    assert.equal(resposta.corpo.nonce, 'nonce-opaco-1')
    assert.equal(resposta.corpo.expiraEm, bancada.clock.now() + 60_000)
    assert.deepEqual(bancada.noncesPedidos, ['start'])
    assert.equal(bancada.emitidos.length, 0, 'o passo 1 nao emite intent')
  })

  it('passo 2: emite ControlIntent com requestId ULID novo, nonce opaco e `at` do relogio', async () => {
    const bancada = criarBancada()
    bancada.resultadoEmit = { estado: 'STARTING', idempotente: false }
    const token = bancada.tokenDoUltimoTap()
    await bancada.enviar(UI_PATH_START, { metodo: 'POST', token, corpo: {} })
    const resposta = await bancada.enviar(UI_PATH_CONFIRM, {
      metodo: 'POST',
      token,
      corpo: { nonce: 'nonce-opaco-1' },
    })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.estado, 'STARTING')
    assert.equal(bancada.emitidos.length, 1)
    const intent = bancada.emitidos[0]
    assert.equal(intent?.action, 'start')
    assert.equal(intent?.requestedBy, UI_REQUESTED_BY)
    assert.equal(intent?.nonce, 'nonce-opaco-1') // opaco: o valor do host, intacto
    assert.ok(intent?.requestId !== undefined)
    assert.match(intent.requestId, FORMA_ULID)
    assert.equal(intent.at, bancada.clock.now())
  })

  it('dois cliques geram requestIds DIFERENTES (chave de idempotencia)', async () => {
    const bancada = criarBancada()
    const token = bancada.tokenDoUltimoTap()
    for (let i = 0; i < 2; i += 1) {
      await bancada.enviar(UI_PATH_START, { metodo: 'POST', token, corpo: {} })
      await bancada.enviar(UI_PATH_CONFIRM, { metodo: 'POST', token, corpo: { nonce: `nonce-opaco-${i + 1}` } })
    }
    assert.equal(bancada.emitidos.length, 2)
    const primeiro = bancada.emitidos[0]?.requestId
    const segundo = bancada.emitidos[1]?.requestId
    assert.ok(primeiro !== undefined && segundo !== undefined)
    assert.notEqual(primeiro, segundo)
  })

  it('start sem nonce no corpo e PASSADO AO HOST — quem decide e o host (S5), nao a superficie', async () => {
    const bancada = criarBancada()
    bancada.resultadoEmit = { estado: 'STOPPED', idempotente: false, recusa: 'NONCE_AUSENTE' }
    const token = bancada.tokenDoUltimoTap()
    const resposta = await bancada.enviar(UI_PATH_CONFIRM, { metodo: 'POST', token, corpo: {} })
    assert.equal(resposta.status, 409)
    assert.equal(resposta.corpo.recusa, 'NONCE_AUSENTE')
    assert.equal(bancada.emitidos.length, 1)
    assert.equal('nonce' in (bancada.emitidos[0] ?? {}), false)
  })

  it('a recusa do controlador chega a UI com codigo e motivo em portugues (CTL-015: modo restrito)', async () => {
    const bancada = criarBancada()
    bancada.resultadoEmit = { estado: 'STOPPED', idempotente: false, recusa: 'MODO_RESTRITO' }
    const token = bancada.tokenDoUltimoTap()
    const resposta = await bancada.enviar(UI_PATH_CONFIRM, {
      metodo: 'POST',
      token,
      corpo: { nonce: 'nonce-opaco-1' },
    })
    assert.equal(resposta.status, 409)
    assert.equal(resposta.corpo.recusa, 'MODO_RESTRITO')
    const motivo = resposta.corpo.motivo
    assert.equal(typeof motivo, 'string')
    assert.ok((motivo as string).includes('Modo restrito'), 'a UI mostra o motivo, nao um erro generico')
  })

  it('`start` em `STOPPING` e recusado com SHUTDOWN_IN_PROGRESS e o motivo chega a UI (D29)', async () => {
    const bancada = criarBancada()
    bancada.resultadoEmit = { estado: 'STOPPING', idempotente: false, recusa: 'SHUTDOWN_IN_PROGRESS' }
    const token = bancada.tokenDoUltimoTap()
    const resposta = await bancada.enviar(UI_PATH_CONFIRM, {
      metodo: 'POST',
      token,
      corpo: { nonce: 'nonce-opaco-1' },
    })
    assert.equal(resposta.status, 409)
    assert.equal(resposta.corpo.recusa, 'SHUTDOWN_IN_PROGRESS')
  })

  it('o resultado READY do controlador projeta a URL (e so em READY)', async () => {
    const bancada = criarBancada()
    bancada.resultadoEmit = { estado: 'READY', idempotente: true, url: URL_DO_TUNEL }
    const token = bancada.tokenDoUltimoTap()
    const resposta = await bancada.enviar(UI_PATH_CONFIRM, {
      metodo: 'POST',
      token,
      corpo: { nonce: 'nonce-opaco-1' },
    })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.url, URL_DO_TUNEL)
    assert.equal(resposta.corpo.idempotente, true)
  })

  it('o `emit` que lanca vira 500 generico — nenhum caminho de erro vaza topologia', async () => {
    const bancada = criarBancada()
    bancada.emitLanca = new Error('detalhe interno do controlador')
    const token = bancada.tokenDoUltimoTap()
    const resposta = await bancada.enviar(UI_PATH_CONFIRM, {
      metodo: 'POST',
      token,
      corpo: { nonce: 'nonce-opaco-1' },
    })
    assert.equal(resposta.status, 500)
    assert.equal(JSON.stringify(resposta.corpo).includes('detalhe interno'), false)
  })
})

/* ========================================================================== */
/* DESLIGAR — reduz exposicao, dispensa nonce                                 */
/* ========================================================================== */

describe('desligar', () => {
  it('o clique emite ControlIntent `stop` SEM nonce (CTL-024: funciona de primeira)', async () => {
    const bancada = criarBancada()
    bancada.resultadoEmit = { estado: 'STOPPING', idempotente: false }
    const token = bancada.tokenDoUltimoTap()
    const resposta = await bancada.enviar(UI_PATH_STOP, { metodo: 'POST', token, corpo: {} })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.estado, 'STOPPING')
    assert.equal(bancada.emitidos.length, 1)
    const intent = bancada.emitidos[0]
    assert.equal(intent?.action, 'stop')
    assert.equal('nonce' in (intent ?? {}), false, 'stop nao transporta nonce')
    assert.ok(intent?.requestId !== undefined)
    assert.match(intent.requestId, FORMA_ULID)
    assert.equal(bancada.noncesPedidos.length, 0, 'nenhum nonce foi pedido ao host')
  })
})
/* ========================================================================== */
/* RESET — W3 (revisao T5.5): FAILED so sai por reset humano (CTL-012)        */
/* ========================================================================== */

describe('reset (2 etapas com nonce — W3/CTL-023)', () => {
  it('passo 1: o clique pede o nonce de RESET ao HOST e devolve-o opaco', async () => {
    const bancada = criarBancada()
    const token = bancada.tokenDoUltimoTap()
    const resposta = await bancada.enviar(UI_PATH_RESET, { metodo: 'POST', token, corpo: {} })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.passo, 'confirmar')
    assert.equal(resposta.corpo.nonce, 'nonce-opaco-1')
    assert.deepEqual(bancada.noncesPedidos, ['reset'], 'o nonce e da acao reset')
  })

  it('passo 2: emite ControlIntent reset com o nonce opaco e requestedBy ui:native', async () => {
    const bancada = criarBancada()
    bancada.resultadoEmit = { estado: 'STOPPED', idempotente: false }
    const token = bancada.tokenDoUltimoTap()
    const primeiro = await bancada.enviar(UI_PATH_RESET, { metodo: 'POST', token, corpo: {} })
    assert.equal(primeiro.status, 200)
    const nonce = primeiro.corpo.nonce
    assert.equal(typeof nonce, 'string')
    const resposta = await bancada.enviar(UI_PATH_RESET_CONFIRM, {
      metodo: 'POST',
      token,
      corpo: { nonce },
    })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.estado, 'STOPPED')
    assert.equal(bancada.emitidos.length, 1)
    const intent = bancada.emitidos[0]
    assert.equal(intent?.action, 'reset')
    assert.equal(intent?.nonce, nonce, 'o nonce viaja opaco ate o host (S5)')
    assert.equal(intent?.requestedBy, 'ui:native')
    assert.match(intent?.requestId ?? '', FORMA_ULID)
  })

  it('a recusa do reset (ex.: nonce invalido) chega a UI com codigo e motivo', async () => {
    const bancada = criarBancada()
    bancada.resultadoEmit = { estado: 'FAILED', idempotente: false, recusa: 'NONCE_INVALIDO' }
    const token = bancada.tokenDoUltimoTap()
    const resposta = await bancada.enviar(UI_PATH_RESET_CONFIRM, { metodo: 'POST', token, corpo: { nonce: 'forjado' } })
    assert.equal(resposta.status, 409)
    assert.equal(resposta.corpo.recusa, 'NONCE_INVALIDO')
    assert.ok(typeof resposta.corpo.motivo === 'string')
  })
})

/* ========================================================================== */
/* CSRF                                                                       */
/* ========================================================================== */

describe('csrf da superficie', () => {
  it('POST sem token e recusado com 403 e NADA e emitido nem pedido', async () => {
    const bancada = criarBancada()
    for (const caminho of [UI_PATH_START, UI_PATH_CONFIRM, UI_PATH_STOP]) {
      const resposta = await bancada.enviar(caminho, { metodo: 'POST', corpo: {} })
      assert.equal(resposta.status, 403, `rota sem token deveria recusar: ${caminho}`)
      assert.equal(resposta.corpo.erro, 'csrf-recusado')
    }
    assert.equal(bancada.emitidos.length, 0)
    assert.equal(bancada.noncesPedidos.length, 0)
  })

  it('token adulterado e recusado com 403', async () => {
    const bancada = criarBancada()
    const token = bancada.tokenDoUltimoTap()
    const meio = Math.floor(token.length / 2)
    const trocado = token[meio] === 'A' ? 'B' : 'A'
    const adulterado = `${token.slice(0, meio)}${trocado}${token.slice(meio + 1)}`
    const resposta = await bancada.enviar(UI_PATH_STOP, { metodo: 'POST', token: adulterado, corpo: {} })
    assert.equal(resposta.status, 403)
    assert.equal(bancada.emitidos.length, 0)
  })

  it('corpo JSON malformado responde 400 sem emitir', async () => {
    const bancada = criarBancada()
    const token = bancada.tokenDoUltimoTap()
    const req = new EventEmitter() as unknown as IncomingMessage
    const bruto = req as unknown as { method: string; url: string; headers: Record<string, string>; destroy(): void }
    bruto.method = 'POST'
    bruto.url = UI_PATH_START
    bruto.headers = { 'x-dsh-csrf': token }
    bruto.destroy = () => undefined
    let status = 0
    const res = {
      writeHead: (s: number): void => {
        status = s
      },
      end: (): void => undefined,
    } as unknown as ServerResponse
    const rota = bancada.rota(UI_PATH_START)
    const pendente = rota.handler(req, res)
    req.emit('data', Buffer.from('{nao-e-json'))
    req.emit('end')
    await pendente
    assert.equal(status, 400)
    assert.equal(bancada.noncesPedidos.length, 0)
  })
})

/* ========================================================================== */
/* Isolamento                                                                 */
/* ========================================================================== */

describe('isolamento da superficie', () => {
  it('o mapa de importacoes nao contem o supervisor, o controlador, o painel nem a API do DSH', () => {
    const raiz = dirname(fileURLToPath(import.meta.url))
    const pasta = join(raiz, '../../../src/ui-contrib')
    const ficheiros = readdirSync(pasta).filter((f) => f.endsWith('.ts'))
    assert.ok(ficheiros.length >= 5, `esperava os modulos da superficie, achei: ${ficheiros.join(', ')}`)

    // A varredura e sobre o TEXTO INTEGRAL de cada ficheiro, nao por linha que
    // comeca por `import` — a revisao reproduziu com probe as CINCO formas de
    // fuga que uma leitura de linha unica deixava passar:
    //   1. import multi-linha (`} from '../tunnel/x.ts'` na linha de
    //      continuacao);
    //   2. `export { x } from '...'` (export-from, sem `import` na linha);
    //   3. `import('...')` dinamico (sem `from`);
    //   4. template literal (`` from `...` ``);
    //   5. `require('...')`.
    // O teste so passa vazio se a varredura NAO ACHAR IMPORT NENHUM — e esse
    // caso e uma falha ("teste cego"), nao um sucesso.
    const importacoes = ficheiros.flatMap((ficheiro) => {
      const fonte = readFileSync(join(pasta, ficheiro), 'utf8')
      const achados: Array<{ ficheiro: string; especificador: string }> = []
      const formas = [
        /\bfrom\s+(['"`])([^'"`\n]+)\1/gu, // import/export-from, incl. template
        /\b(?:import|require)\s*\(\s*(['"`])([^'"`\n]+)\1/gu, // dinamico e require
      ]
      for (const forma of formas) {
        for (const m of fonte.matchAll(forma)) {
          const especificador = m[2]
          if (especificador !== undefined && especificador.length > 0) {
            achados.push({ ficheiro, especificador })
          }
        }
      }
      return achados
    })
    assert.ok(importacoes.length > 0, 'a varredura nao achou import nenhum — o teste estaria cego')

    const proibidos = [
      { padrao: /@deepseek-ai\//u, nome: 'a API do DSH (D1: so o adaptador)' },
      { padrao: /\.\.\/tunnel\//u, nome: 'o supervisor de tunel (src/tunnel/**)' },
      { padrao: /\.\.\/proc\//u, nome: 'o supervisor de processos (src/proc/**)' },
      { padrao: /\.\.\/control\//u, nome: 'o controlador de T5.1 (src/control/**)' },
      { padrao: /\.\.\/panel\//u, nome: 'o painel (src/panel/** — T5.3)' },
      { padrao: /\.\.\/dsh\//u, nome: 'o adaptador (src/dsh/**)' },
    ]
    for (const importacao of importacoes) {
      for (const proibido of proibidos) {
        assert.equal(
          proibido.padrao.test(importacao.especificador),
          false,
          `${importacao.ficheiro} importa ${proibido.nome}: ${importacao.especificador}`,
        )
      }
    }
    // E a unica via para o controlador e o `emit` do contrato, injetado.
    const superficie = readFileSync(join(pasta, 'surface.ts'), 'utf8')
    assert.ok(superficie.includes('deps.emit(intent)') || superficie.includes('emit:'))
  })
})
