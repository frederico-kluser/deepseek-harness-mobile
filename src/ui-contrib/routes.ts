/**
 * As rotas HTTP da superficie de UI nativa e os seus handlers.
 *
 * O PREFIXO E IRMAO DE `/__guard`, NAO FILHO: `/__guard` e do painel (D5,
 * T3.4 -> T5.3), que o registara como rota `prefix` — um caminho como
 * `/__guard/ui/...` seria engolido pelo despachante do painel e responderia
 * 404 por tabela. `/__guard-ui` e um SEGMENTO distinto: o `match` do host so
 * casa `p` e `p/<algo>` (medido no spike S4), logo nao colide — e a barreira
 * de autenticacao (L3) guarda-o por omissao, sem isencao nenhuma.
 *
 * SETE rotas — a COSTURA da Onda 5 acrescentou o RESET (W3: FAILED so sai por
 * reset humano, CTL-012) com o MESMO padrao de 2 etapas com nonce do LIGAR:
 * `POST /__guard-ui/api/reset` (passo 1, emite o nonce) e
 * `POST /__guard-ui/api/reset/confirm` (passo 2, emite o intent reset).
 * As cinco originais:
 *
 *   GET  /__guard-ui/api/state         — a PROJECCAO: seq + estado + URL (so
 *                                        READY) + expiracao + falha + nota de
 *                                        TTL. E o que o script do cliente
 *                                        poe no DOM por `textContent`.
 *   POST /__guard-ui/api/start         — passo 1 do LIGAR: pede o nonce ao
 *                                        HOST (T5.1) e devolve-o opaco.
 *   POST /__guard-ui/api/start/confirm — passo 2: emite o `ControlIntent`
 *                                        `start` com o nonce transportado
 *                                        opaco; quem valida e o host (S5).
 *   POST /__guard-ui/api/stop          — DESLIGAR: emite `stop` SEM nonce
 *                                        (CTL-024: acao que reduz exposicao).
 *   GET  /__guard-ui/client.js         — o script da superficie, como recurso
 *                                        externo (CSP-friendly).
 *
 * Toda rota POST exige o token anti-CSRF desta superficie (cabecalho
 * `x-dsh-csrf` ou campo `csrf` do corpo) — doutrina NIST SP 800-63B-4 5.1.1.
 * O metodo errado responde 405 (o despacho do host e por caminho, nao por
 * metodo; quem responde ao pedido e este handler).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ControlAction, ControlIntent, ControlResultado, Nonce } from '../contracts/control.ts'
import type { TunnelSnapshot } from '../contracts/tunnel.ts'
import { CSRF_FIELD_NAME, CSRF_HEADER_NAME, type CsrfGuard } from './csrf.ts'
import { createClientScript } from './html.ts'
import { buildControlIntent, projectResultado } from './intents.ts'

export const UI_PREFIX = '/__guard-ui'
export const UI_PATH_STATE = `${UI_PREFIX}/api/state`
export const UI_PATH_START = `${UI_PREFIX}/api/start`
export const UI_PATH_CONFIRM = `${UI_PREFIX}/api/start/confirm`
export const UI_PATH_STOP = `${UI_PREFIX}/api/stop`
export const UI_PATH_RESET = `${UI_PREFIX}/api/reset`
export const UI_PATH_RESET_CONFIRM = `${UI_PREFIX}/api/reset/confirm`
export const UI_PATH_CLIENT = `${UI_PREFIX}/client.js`

/** O vinculo do token anti-CSRF: a superficie inteira. */
export const UI_CSRF_BINDING = 'ui-contrib'

/** Teto do corpo de um POST. Os pedidos desta superficie cabem em 200 bytes. */
const MAX_BODY_BYTES = 4096

export const NOTA_TTL_EXPIRADO = 'TTL expirado'

export type UiContribRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>

export interface UiContribRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: UiContribRequestHandler
}

/**
 * O nucleo da superficie: tudo o que os handlers precisam, injetado por
 * `createNativeUiSurface` (que por sua vez recebe de quem fia a superficie em
 * `src/index.ts`). Os handlers nunca tocam na API do DSH nem no supervisor.
 */
export interface UiContribCore {
  /** A ultima projecao que o broadcast entregou; `undefined` antes da 1.ª. */
  readonly projection: () => TunnelSnapshot | undefined
  /** O ultimo `seq` visto (difusoes fora de ordem sao descartadas antes). */
  readonly seq: () => number
  /** A ultima expiracao READY vista — a base da nota de TTL. */
  readonly lastReady: () => { readonly expiresAt: number } | undefined
  readonly csrf: CsrfGuard
  readonly now: () => number
  readonly requestedBy: string
  readonly requestId: () => string
  readonly issueNonce: (action: ControlAction) => Nonce
  readonly emit: (intent: ControlIntent) => Promise<ControlResultado>
}

/* ========================================================================== */
/* Envelope e leitura do corpo                                                */
/* ========================================================================== */

function json(res: ServerResponse, status: number, corpo: unknown, extra?: Readonly<Record<string, string>>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(JSON.stringify(corpo))
}

function exigeMetodo(req: IncomingMessage, res: ServerResponse, metodo: string): boolean {
  if (req.method === metodo) return true
  json(res, 405, { erro: 'metodo-nao-suportado' }, { allow: metodo })
  return false
}

type CorpoLido =
  | { readonly ok: true; readonly corpo: Record<string, unknown> }
  | { readonly ok: false; readonly erro: 'grande' | 'malformado' }

/**
 * Le o corpo JSON, com teto. Corpo vazio conta como `{}` (o cliente da
 * superficie envia `'{}'` nos POSTs sem payload).
 */
function lerCorpo(req: IncomingMessage): Promise<CorpoLido> {
  return new Promise((resolve) => {
    const pedacos: Buffer[] = []
    let total = 0
    let fechado = false
    const terminar = (resultado: CorpoLido): void => {
      if (fechado) return
      fechado = true
      // O corpo nao e consumido nem destruido — o padrao do painel
      // (`readRequestBody`): a resposta e que fecha o pedido; derrubar o
      // socket aqui mataria a resposta antes de ela sair.
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.removeAllListeners('error')
      resolve(resultado)
    }
    req.on('data', (pedaco: Buffer) => {
      total += pedaco.length
      if (total > MAX_BODY_BYTES) {
        terminar({ ok: false, erro: 'grande' })
        return
      }
      pedacos.push(pedaco)
    })
    req.on('end', () => {
      if (total === 0) {
        terminar({ ok: true, corpo: {} })
        return
      }
      try {
        const bruto: unknown = JSON.parse(Buffer.concat(pedacos).toString('utf8'))
        terminar({
          ok: true,
          corpo: bruto !== null && typeof bruto === 'object' && !Array.isArray(bruto)
            ? (bruto as Record<string, unknown>)
            : {},
        })
      } catch {
        terminar({ ok: false, erro: 'malformado' })
      }
    })
    req.on('error', () => terminar({ ok: false, erro: 'malformado' }))
  })
}

/** O token anti-CSRF: cabecalho ou campo `csrf` do corpo (paridade com o painel). */
function csrfDoPedido(req: IncomingMessage, corpo: Record<string, unknown>): string | undefined {
  const noCabecalho = req.headers[CSRF_HEADER_NAME]
  if (typeof noCabecalho === 'string' && noCabecalho.length > 0) return noCabecalho
  const noCorpo = corpo[CSRF_FIELD_NAME]
  return typeof noCorpo === 'string' && noCorpo.length > 0 ? noCorpo : undefined
}

function csrfValido(core: UiContribCore, req: IncomingMessage, corpo: Record<string, unknown>): boolean {
  const token = csrfDoPedido(req, corpo)
  return token !== undefined && core.csrf.verify(token, UI_CSRF_BINDING)
}

/** Resposta comum de CSRF recusado. 403, nunca 401: o token nao e credencial. */
function recusarCsrf(res: ServerResponse): void {
  json(res, 403, { erro: 'csrf-recusado', motivo: 'recarregue a página e tente de novo' })
}

async function responderIntento(res: ServerResponse, core: UiContribCore, intent: ControlIntent): Promise<void> {
  let resultado: ControlResultado
  try {
    resultado = await core.emit(intent)
  } catch {
    // Nenhum caminho de erro vaza topologia: 500 generico.
    json(res, 500, { erro: 'interno' })
    return
  }
  const projetado = projectResultado(resultado)
  if (projetado.recusa !== undefined) {
    json(res, 409, projetado)
    return
  }
  json(res, 200, projetado)
}

/* ========================================================================== */
/* A projecao (GET /__guard-ui/api/state)                                     */
/* ========================================================================== */

export interface EstadoProjetado {
  readonly seq: number
  /** O estado em ingles, vocabulario do contrato; o rotulo PT e do cliente. */
  readonly estado: TunnelSnapshot['state']
  readonly tentativas: number
  /** Presente sse `estado === 'READY'`. */
  readonly url?: string | undefined
  /** Epoch ms em que o TTL expira. Presente sse `estado === 'READY'`. */
  readonly expiraEm?: number | undefined
  readonly falha: { readonly codigo: string; readonly mensagem: string } | null
  /** A nota de TTL expirado, quando a projecao a pode afirmar. */
  readonly nota: string | null
}

/**
 * Projeta o estado para o corpo da rota. Funcao PURA e exportada: e o coracao
 * da pergunta falsificavel "a URL aparece antes de READY?" — aqui ela nunca
 * sai, mesmo que o snapshot a traga por defeito do supervisor.
 */
export function projetarEstado(input: {
  readonly seq: number
  readonly snapshot: TunnelSnapshot
  readonly lastReady: { readonly expiresAt: number } | undefined
  readonly now: number
}): EstadoProjetado {
  // A nota de TTL (CTL-038): o tunel saiu de READY e o prazo que a ultima
  // projecao READY viu ja passou — o `STOPPED`/`STOPPING` nao traz `failure`,
  // e esta nota e a explicacao em vez de um erro generico. E uma NOTA
  // derivada do que a projecao observou, nao uma afirmacao de causa: um
  // desligar manual depois do prazo mostra-a igualmente.
  const expira =
    input.snapshot.state === 'READY'
      ? (input.snapshot.expiresAt ?? Number.POSITIVE_INFINITY)
      : (input.lastReady?.expiresAt ?? Number.POSITIVE_INFINITY)

  return {
    seq: input.seq,
    estado: input.snapshot.state,
    tentativas: input.snapshot.attempts,
    ...(input.snapshot.state === 'READY' && input.snapshot.info !== undefined
      ? { url: input.snapshot.info.url }
      : {}),
    ...(input.snapshot.state === 'READY' && input.snapshot.expiresAt !== undefined
      ? { expiraEm: input.snapshot.expiresAt }
      : {}),
    falha:
      input.snapshot.failure === undefined
        ? null
        : { codigo: input.snapshot.failure.code, mensagem: input.snapshot.failure.message },
    nota: input.now >= expira ? NOTA_TTL_EXPIRADO : null,
  }
}

export function createStateHandler(core: UiContribCore): UiContribRequestHandler {
  return (req, res) => {
    if (!exigeMetodo(req, res, 'GET')) return
    const snapshot = core.projection()
    if (snapshot === undefined) {
      // Nenhuma difusao chegou ainda: 503 explicito, nunca um estado inventado.
      json(res, 503, { erro: 'sem-estado' })
      return
    }
    json(res, 200, projetarEstado({ seq: core.seq(), snapshot, lastReady: core.lastReady(), now: core.now() }))
  }
}

/* ========================================================================== */
/* LIGAR — duas etapas com nonce emitido pelo host                            */
/* ========================================================================== */

export function createStartHandler(core: UiContribCore): UiContribRequestHandler {
  return async (req, res) => {
    if (!exigeMetodo(req, res, 'POST')) return
    const corpo = await lerCorpo(req)
    if (!corpo.ok) {
      json(res, 400, { erro: corpo.erro === 'grande' ? 'corpo-grande' : 'corpo-invalido' })
      return
    }
    if (!csrfValido(core, req, corpo.corpo)) {
      recusarCsrf(res)
      return
    }
    // O nonce e emitido pelo HOST (ConfirmService de T5.1) e devolvido OPACO:
    // a superficie nao o le, nao o valida e nao o guarda — o script do
    // cliente transporta-o ate ao passo 2.
    const nonce = core.issueNonce('start')
    json(res, 200, { passo: 'confirmar', nonce: nonce.valor, expiraEm: nonce.expiresAt })
  }
}

export function createConfirmHandler(core: UiContribCore): UiContribRequestHandler {
  return async (req, res) => {
    if (!exigeMetodo(req, res, 'POST')) return
    const corpo = await lerCorpo(req)
    if (!corpo.ok) {
      json(res, 400, { erro: corpo.erro === 'grande' ? 'corpo-grande' : 'corpo-invalido' })
      return
    }
    if (!csrfValido(core, req, corpo.corpo)) {
      recusarCsrf(res)
      return
    }
    // S5: quem valida o nonce e o HOST. A superficie transporta-o opaco — e
    // se o corpo nao o trouxer, o host e quem responde NONCE_AUSENTE.
    const bruto = corpo.corpo.nonce
    const nonce = typeof bruto === 'string' ? bruto : undefined
    const intent = buildControlIntent({
      action: 'start',
      requestedBy: core.requestedBy,
      requestId: core.requestId(),
      ...(nonce === undefined ? {} : { nonce }),
      at: core.now(),
    })
    await responderIntento(res, core, intent)
  }
}

/* ========================================================================== */
/* DESLIGAR — reduz exposicao, dispensa nonce (CTL-024)                       */
/* ========================================================================== */

export function createStopHandler(core: UiContribCore): UiContribRequestHandler {
  return async (req, res) => {
    if (!exigeMetodo(req, res, 'POST')) return
    const corpo = await lerCorpo(req)
    if (!corpo.ok) {
      json(res, 400, { erro: corpo.erro === 'grande' ? 'corpo-grande' : 'corpo-invalido' })
      return
    }
    if (!csrfValido(core, req, corpo.corpo)) {
      recusarCsrf(res)
      return
    }
    const intent = buildControlIntent({
      action: 'stop',
      requestedBy: core.requestedBy,
      requestId: core.requestId(),
      at: core.now(),
    })
    await responderIntento(res, core, intent)
  }
}


/* ========================================================================== */
/* RESET — CTL-012/036: a UNICA saida do FAILED, com nonce (CTL-023)          */
/* ========================================================================== */

/**
 * Passo 1 do RESET: emite o nonce para a acao 'reset' no HOST e devolve-o
 * opaco (S5) — o mesmo padrao do LIGAR. A rota so faz sentido em FAILED; em
 * qualquer outro estado o controlador responde noop no passo 2.
 */
export function createResetHandler(core: UiContribCore): UiContribRequestHandler {
  return async (req, res) => {
    if (!exigeMetodo(req, res, 'POST')) return
    const corpo = await lerCorpo(req)
    if (!corpo.ok) {
      json(res, 400, { erro: corpo.erro === 'grande' ? 'corpo-grande' : 'corpo-invalido' })
      return
    }
    if (!csrfValido(core, req, corpo.corpo)) {
      recusarCsrf(res)
      return
    }
    // W3 (revisao T5.5): FAILED so sai por reset humano (CTL-012), e o reset
    // AUMENTA o risco de reabrir a exposicao — exige confirmacao (CTL-023).
    const nonce = core.issueNonce('reset')
    json(res, 200, { passo: 'confirmar', nonce: nonce.valor, expiraEm: nonce.expiresAt })
  }
}

/**
 * Passo 2 do RESET: emite o `ControlIntent` reset com o nonce transportado
 * opaco. Quem valida e o HOST (S5); em FAILED com nonce valido, o controlador
 * transita FAILED -> STOPPED e difunde (CTL-036).
 */
export function createResetConfirmHandler(core: UiContribCore): UiContribRequestHandler {
  return async (req, res) => {
    if (!exigeMetodo(req, res, 'POST')) return
    const corpo = await lerCorpo(req)
    if (!corpo.ok) {
      json(res, 400, { erro: corpo.erro === 'grande' ? 'corpo-grande' : 'corpo-invalido' })
      return
    }
    if (!csrfValido(core, req, corpo.corpo)) {
      recusarCsrf(res)
      return
    }
    const bruto = corpo.corpo.nonce
    const nonce = typeof bruto === 'string' ? bruto : undefined
    const intent = buildControlIntent({
      action: 'reset',
      requestedBy: core.requestedBy,
      requestId: core.requestId(),
      ...(nonce === undefined ? {} : { nonce }),
      at: core.now(),
    })
    await responderIntento(res, core, intent)
  }
}
/* ========================================================================== */
/* O script da superficie (GET /__guard-ui/client.js)                         */
/* ========================================================================== */

export function createClientHandler(_core: UiContribCore): UiContribRequestHandler {
  return (req, res) => {
    if (!exigeMetodo(req, res, 'GET')) return
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(createClientScript())
  }
}
