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
 * DUAS rotas do Telegram (OFELINE/ONLINE), acrescidas para o botao da UI:
 *   GET  /__guard-ui/api/telegram      — o estado do bot: `online`+`provider`
 *                                        +`motivo` (offline) ou `online`
 *                                        +`provider`+`handle` (online). O
 *                                        disco e lido pela costura a cada
 *                                        pedido; o token NUNCA sai.
 *   POST /__guard-ui/api/telegram/click — o clique no botao: devolve o TEXTO
 *                                        das instrucoes (conectar se offline,
 *                                        uso se online). Exige CSRF, como todo
 *                                        POST desta superficie.
 *   GET  /__guard-ui/api/csrf       — um token anti-CSRF FRESCO para o bundle
 *                                        (HIGH-2): fonte INDEPENDENTE do meta
 *                                        do indice antigo, para o painel novo.
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
import { passosDoBot, type BotEstado } from './bot-state.ts'

export const UI_PREFIX = '/__guard-ui'
export const UI_PATH_STATE = `${UI_PREFIX}/api/state`
export const UI_PATH_START = `${UI_PREFIX}/api/start`
export const UI_PATH_CONFIRM = `${UI_PREFIX}/api/start/confirm`
export const UI_PATH_STOP = `${UI_PREFIX}/api/stop`
export const UI_PATH_RESET = `${UI_PREFIX}/api/reset`
export const UI_PATH_RESET_CONFIRM = `${UI_PREFIX}/api/reset/confirm`
export const UI_PATH_CLIENT = `${UI_PREFIX}/client.js`
/** O estado Telegram OFFLINE/ONLINE — GET, so le. NUNCA carrega o token. */
export const UI_PATH_TELEGRAM = `${UI_PREFIX}/api/telegram`
/** O clique no botao Telegram — POST, CSRF como as demais escritas. */
export const UI_PATH_TELEGRAM_CLICK = `${UI_PREFIX}/api/telegram/click`
/** O token do bot, configurado VIA INTERFACE — POST, CSRF como as demais. */
export const UI_PATH_TOKEN = `${UI_PREFIX}/api/token`
/** O estado do token (configurado/handle/fonte), SEM o valor — GET. */
export const UI_PATH_TOKEN_STATE = `${UI_PREFIX}/api/token-state`
/**
 * A privacidade do bot AO VIVO (GET): o `getMe` real decide se o bot tem
 * `@username` (encontrável na busca) ou não. GET sem CSRF, como as demais
 * leituras. NUNCA transporta o token.
 */
export const UI_PATH_PRIVACIDADE = `${UI_PREFIX}/api/privacidade`
/** Quem/quanto esta a acessar (sessoes e conexoes do proxy) — GET. */
export const UI_PATH_ACCESS = `${UI_PREFIX}/api/access`
/**
 * O token anti-CSRF FRESCO para o bundle — GET, so le. Nao exige CSRF (e uma
 * leitura, como as demais GETs) e NUNCA transporta credencial: o valor emitido
 * e o mesmo token stateless que o `tapIndex` embute no indice antigo.
 */
export const UI_PATH_CSRF = `${UI_PREFIX}/api/csrf`
/** Inicia o pareamento pelo painel — POST, CSRF como as demais escritas. */
export const UI_PATH_PAIR = `${UI_PREFIX}/api/pair`
/** O estado do pareamento (pareado? handle? código ativo) — GET, só leitura. */
export const UI_PATH_PAIR_STATE = `${UI_PREFIX}/api/pair-state`

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
 * O provedor de mensageria ATIVO — o MESMO union de `src/proc/env.ts`
 * (`ProviderId`), mantido aqui porque a superficie NAO importa `src/proc/**`
 * (regra de isolamento do mapa de importacoes). A costura em `src/index.ts`
 * passa o `ProviderId` real — estruturalmente identico.
 */
export type ProviderDoBot = 'telegram' | 'discord'

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
  /**
   * O estado do BOT OFFLINE/ONLINE, lido do disco a cada pedido pela costura
   * em `src/index.ts` (config.worker.token/secrets.env + state.json pairing).
   * So boleanos e motivos; o token NUNCA passa por aqui.
   */
  readonly botState: () => BotEstado
  /**
   * O PROVEDOR de mensageria ATIVO, fiado pela costura em `src/index.ts`
   * (`config.worker.provider ?? DEFAULT_PROVIDER`). Sai no corpo do
   * GET /__guard-ui/api/telegram para o painel rotular o onboarding por
   * provedor — o cliente cai no default 'telegram' sem este campo.
   */
  readonly provider: ProviderDoBot
  /**
   * Operacoes do panel de token, fiadas pela costura em `src/index.ts`. So
   * chegam aqui como servico injetado (validar/sondar/gravar/estado) — este
   * modulo nao importa `src/telegram/**` nem `bin/**`, e o token NUNCA e
   * logado nem ecoado por este modulo.
   */
  readonly tokenOps: UiTokenOps
  /**
   * Operacoes do pareamento VIA PAINEL, fiadas pela costura em `src/index.ts`.
   * O codigo de 6 digitos NUNCA chega a log por este modulo — a costura o gera
   * com `criarSessaoDePareamento` e so o devolve na resposta de `gerar()`.
   */
  readonly pairOps: UiPairOps
  /**
   * Projecao de acesso, fiada pela costura: a contagem de sockets ativos do
   * proxy do tunel e a lista de sessoes vivas, ja com os metadados de acesso.
   */
  readonly acesso: () => UiAcessoBruto
  readonly csrf: CsrfGuard
  readonly now: () => number
  readonly requestedBy: string
  readonly requestId: () => string
  readonly issueNonce: (action: ControlAction) => Nonce
  readonly emit: (intent: ControlIntent) => Promise<ControlResultado>
}

/**
 * Onde vive o token do bot, para o `token-state` — SEM o valor. `env` = o
 * `config.worker.token` (o host injeta-o por ambiente); `secrets` = o
 * `secrets.env` gravado pelo CLI ou por esta rota.
 */
export type FonteDoToken = 'env' | 'secrets' | 'nenhum'

/** O estado do token que a interface mostra — nunca o valor. */
export interface EstadoDoToken {
  readonly configurado: boolean
  /** O `@handle`, quando o `getMe` o confirmou. Ausente = `null`. */
  readonly handle?: string | null | undefined
  readonly fonte: FonteDoToken
}

/**
 * A checagem AO VIVO de descoberta (cartão "Privacidade"). `ok:true` com
 * `handle` = o bot TEM `@username` (encontrável na busca); `ok:true` com
 * `handle === null` = o `getMe` REAL confirmou que o bot NÃO tem `@username`
 * (genuinamente não encontrável). `ok:false` = o `getMe` falhou (rede/token
 * revogado) — NUNCA inventa estado. O valor do token nunca sai no corpo.
 */
export type UiPrivacidade =
  | { readonly ok: true; readonly handle: string | null; readonly fonte: FonteDoToken }
  | { readonly ok: false; readonly erro: 'indisponivel' }

/**
 * O servico de configuracao do token fiado a superficie. Cada operacao e
 * executada pela costura em `src/index.ts` (que detem `config`, `statePaths` e
 * o supervisor do worker); este modulo so orquestra o HTTP.
 */
export interface UiTokenOps {
  /** Formato `<id numerico>:<segredo>` SEM rede (reusa `validarFormatoDoToken`). */
  readonly validarFormato: (bruto: string) => boolean
  /**
   * A FONTE EFETIVA do token configurado no momento. `'env'` significa que o
   * `config.worker.token` (variavel TELEGRAM_BOT_TOKEN do ambiente) tem
   * PRECEDENCIA sobre o `secrets.env` — neste estado, gravar em `secrets.env`
   * nao muda o bot ate o env mudar. `'secrets'` = o ficheiro e a fonte vigente.
   *
   * O handler usa isto ANTES de sondar/gravar: com a fonte `'env'`, a rota
   * recusa (409 `token-por-env`) em vez de escrever um token que o env vai
   * continuar a sombrear — transparencia, nao mentira.
   */
  readonly fonte: () => FonteDoToken
  /**
   * `getMe` na rede. `ok:true` traz o `@handle`. O token NUNCA volta nesta
   * resposta; `erro` e uma causa acionavel, nunca o token. NAO tem efeito
   * lateral no estado do token (o handle so e "committed" em `gravar`).
   */
  readonly sondar: (
    token: string,
  ) => Promise<{ readonly ok: true; readonly handle: string } | { readonly ok: false; readonly erro: string }>
  /**
   * Grava em `secrets.env` (0600, atomico), reinicia o worker com o token novo
   * e grava o `handle` lembrado pelo token-state — SO SOB SUCESSO. Na falha
   * (excecao), NADA muda: nem a escrita, nem o handle lembrado.
   */
  readonly gravar: (token: string, handle: string) => void
  /** Estado do token (fonte+handle) para o `token-state`; le o disco a cada chamada. */
  readonly estado: () => EstadoDoToken
  /**
   * Checagem AO VIVO de descoberta (cartão "Privacidade"): resolve o token
   * EFETIVO (env → secrets.env) e faz `getMe` na rede para saber se o bot tem
   * `@username`. `handle` `null` = o bot NÃO tem `@username`; `ok:false` = o
   * `getMe` falhou. Com `forcar` (do botão "Verificar de novo"), contorna o
   * cache curto; sem ele, serve um resultado cacheado de ~30s para não bater
   * `getMe` a cada poll do painel. O token nunca é logado nem devolvido.
   */
  readonly privacidade: (forcar?: boolean) => Promise<UiPrivacidade>
}

/**
 * O servico de PAREAMENTO VIA PAINEL fiado a superficie. Cada operacao e
 * executada pela costura em `src/index.ts` (que detem `config`, `statePaths`,
 * o supervisor do worker e a sessao de pareamento em memoria); este modulo so
 * orquestra o HTTP. O CODIGO DE 6 DIGITOS NUNCA e logado nem viaja para o
 * Telegram — so existe no host (memoria) e na resposta a `gerar()`.
 */
export interface UiPairOps {
  /**
   * O estado do pareamento para o `pair-state`: `pareado` + o `@handle` do bot
   * (lido do token-state). Enquanto houver uma sessao de pareamento VIVA em
   * memoria, devolve o `codigo` (por re-exibicao no refresh) e o `expiraEm`.
   */
  readonly estado: () => {
    readonly pareado: boolean
    readonly handle?: string | undefined
    readonly codigo?: string | undefined
    readonly expiraEm?: number | undefined
  }
  /**
   * Gera UM codigo de pareamento novo e envia o `pairing.challenge` ao worker.
   * Devolve `{ok:true,codigo,expiraEm}` (o unico sitio onde o claro existe fora
   * do host) ou `{ok:false,erro}` com uma CAUSA acionavel, NUNCA o codigo.
   */
  readonly gerar: () => Promise<
    | { readonly ok: true; readonly codigo: string; readonly expiraEm: number }
    | { readonly ok: false; readonly erro: 'ja-pareado' | 'sem-token' | 'worker-indisponivel' | 'interno' }
  >
}

/** Uma sessao viva, ja redigida, com os metadados de acesso capturados. */
export interface RegistroAcessoBruto {
  readonly hash: string
  readonly criadaEm: number
  readonly ultimoUsoEm: number
  readonly userAgent?: string | undefined
  readonly ip?: string | undefined
}

/** A fonte de dados do `/api/access`, montada pela costura. */
export interface UiAcessoBruto {
  /** Sockets ativos do lado cliente do proxy do tunel (a fonte de `totalConexoes`). */
  readonly conexoesAtivas: number
  /** Sessoes vivas no `SessionStore`. */
  readonly totalSessoes: number
  /** As sessoes vivas, redigidas. */
  readonly sessoes: ReadonlyArray<RegistroAcessoBruto>
  /** `true` sse o IP da borda e confiavel agora (`exposure.trustEdgeHeaders`). */
  readonly ipConfiavel: boolean
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

/* ========================================================================== */
/* O estado e o clique do Telegram (OFFLINE/ONLINE)                           */
/* ========================================================================== */

/**
 * Projeta o estado do bot para a rota GET. FUNCAO PURA e exportada: e o
 * coracao da pergunta falsificavel "o token sai nesta resposta?" — o corpo so
 * tem `online`+`provider`+`motivo` (offline) ou `online`+`provider`+`handle`
 * (online); o valor do token e injetado na costura e nunca chega ate aqui.
 */
export function projetarEstadoTelegrama(estado: BotEstado, provider: ProviderDoBot): Record<string, unknown> {
  if (!estado.online) return { online: false, provider, motivo: estado.motivo }
  return {
    online: true,
    provider,
    ...(estado.handle === undefined ? {} : { handle: estado.handle }),
  }
}

/**
 * GET /__guard-ui/api/telegram — o estado OFFLINE/ONLINE. SO LE: o motivo
 * aproximado ("sem pareamento" / "sem chave do bot") quando offline, o estado
 * online quando pronto. O disco e lido pela costura a cada pedido.
 */
export function createTelegramHandler(core: UiContribCore): UiContribRequestHandler {
  return (req, res) => {
    if (!exigeMetodo(req, res, 'GET')) return
    json(res, 200, projetarEstadoTelegrama(core.botState(), core.provider))
  }
}

/**
 * POST /__guard-ui/api/telegram/click — o CLIQUE no botao Telegram. E uma
 * ESCRITA (abre o painel de instrucoes), por isso exige o token anti-CSRF da
 * superficie como qualquer outro POST (NIST SP 800-63B-4 5.1.1). Devolve o
 * TEXTO de instrucoes — a rota de conectar (offline) ou dicas de uso (online).
 * O texto nunca traz a chave do bot nem o codigo de pareamento real.
 */
export function createTelegramClickHandler(core: UiContribCore): UiContribRequestHandler {
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
    json(res, 200, { passos: passosDoBot(core.botState()) })
  }
}

/* ========================================================================== */
/* O painel de configuracao do token (POST /api/token)                        */
/* ========================================================================== */

/**
 * Projeta o estado do token para a rota GET. FUNCAO PURA e exportada: e o
 * coracao da pergunta falsificavel "o token sai nesta resposta?" — o corpo
 * so tem `configurado`+`handle`+`fonte`; o valor do token nunca entra aqui.
 */
export function projetarEstadoToken(estado: EstadoDoToken): Record<string, unknown> {
  return {
    configurado: estado.configurado,
    ...(estado.handle === undefined || estado.handle === null ? {} : { handle: estado.handle }),
    fonte: estado.fonte,
  }
}

/**
 * GET /__guard-ui/api/token-state — o estado do token SEM o valor. SO LE; o
 * disco e lido pela costura a cada pedido (`tokenOps.estado`).
 */
export function createTokenStateHandler(core: UiContribCore): UiContribRequestHandler {
  return (req, res) => {
    if (!exigeMetodo(req, res, 'GET')) return
    json(res, 200, projetarEstadoToken(core.tokenOps.estado()))
  }
}

/**
 * Projeta o resultado da checagem de privacidade para a rota GET. FUNCAO PURA
 * e exportada: e o coracao das perguntas falsificaveis "o token sai nesta
 * resposta?" e "o `ok:false` nao vira verde?" — o corpo so tem
 * `ok`+`handle`+`fonte`; o valor do token nunca entra aqui.
 */
export function projetarPrivacidade(resultado: UiPrivacidade): Record<string, unknown> {
  if (!resultado.ok) return { ok: false, erro: 'indisponivel' }
  return { ok: true, handle: resultado.handle, fonte: resultado.fonte }
}

/**
 * GET /__guard-ui/api/privacidade — a privacidade do bot AO VIVO. SO LE (GET
 * sem CSRF, como as demais): a costura resolve o token efetivo e faz `getMe`
 * para decidir se o bot tem `@username`. `handle:null` = bot SEM username
 * (não encontrável); `ok:false` = getMe falhou (nunca inventa estado). O
 * `forcar:true` na query contorna o cache curto da costura (botão "Verificar
 * de novo"). NUNCA devolve nem loga o token.
 */
export function createPrivacidadeHandler(core: UiContribCore): UiContribRequestHandler {
  return async (req, res) => {
    if (!exigeMetodo(req, res, 'GET')) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    const forcar = url.searchParams.get('forcar') === 'true'
    json(res, 200, projetarPrivacidade(await core.tokenOps.privacidade(forcar)))
  }
}

/**
 * POST /__guard-ui/api/token — configura o token do bot VIA INTERFACE.
 *
 * Fluxo (a ordem e contrato — TG-061: FORMATO antes de rede, e a fonte antes
 * de TUDO quando o env manda):
 *   - corpo vazio/token em branco -> 400 `{ok:false,erro:'token-vazio'}`;
 *   - a fonte EFETIVA e `'env'` (variavel TELEGRAM_BOT_TOKEN a mandar) -> 409
 *     `{ok:false,erro:'token-por-env', aviso}`, SEM sondar nem gravar: um token
 *     gravado em `secrets.env` nao mudaria o bot enquanto o env o sombrear;
 *   - formato `<id>:<segredo>` invalido (SEM rede) -> 400
 *     `{ok:false,erro:'formato-invalido'}`;
 *   - `getMe` na rede recusa o token -> 422 `{ok:false,erro:'token-invalido'}`;
 *   - token aceito -> grava em `secrets.env` (0600, atomico), reinicia o
 *     worker com ele e devolve 200 `{ok:true,handle,fonte:'secrets'}`.
 *
 * A FONTE da resposta 200 casa SEMPRE com a que o `/token-state` reporta
 * depois: quando e `'env'` nao se chega a gravar (409), logo so responde 200
 * com `fonte:'secrets'`.
 *
 * NUNCA ecoa o token nem o loga: o corpo so devolve `ok`+`handle`. Exige o
 * token anti-CSRF como qualquer POST da superficie (NIST SP 800-63B-4 5.1.1).
 */
export function createTokenHandler(core: UiContribCore): UiContribRequestHandler {
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
    const bruto = corpo.corpo.token
    if (typeof bruto !== 'string' || bruto.trim().length === 0) {
      json(res, 400, { ok: false, erro: 'token-vazio' })
      return
    }
    // TRANSPARENCIA ANTES DE REDE: se a variavel TELEGRAM_BOT_TOKEN do ambiente
    // for a fonte vigente, um token gravado em `secrets.env` nao mudaria o bot.
    // Recusa-se com instrucao clara em vez de responder `{ok:true}` e o bot
    // continuar com o token antigo (shadowing silencioso).
    if (core.tokenOps.fonte() === 'env') {
      json(res, 409, {
        ok: false,
        erro: 'token-por-env',
        aviso:
          'A variavel TELEGRAM_BOT_TOKEN do ambiente tem precedência e continua a mandar. ' +
          'Remova-a (ou use o token dela) — só então este painel passa a configurar o secrets.env.',
      })
      return
    }
    // O token e aparado UMA vez aqui; `validarFormato` apara de novo por
    // paridade com o CLI. O valor aparado e o que segue para `sondar`/`gravar`.
    const token = bruto.trim()
    if (!core.tokenOps.validarFormato(token)) {
      json(res, 400, { ok: false, erro: 'formato-invalido' })
      return
    }
    const sonda = await core.tokenOps.sondar(token)
    if (!sonda.ok) {
      json(res, 422, { ok: false, erro: 'token-invalido' })
      return
    }
    try {
      core.tokenOps.gravar(token, sonda.handle)
    } catch {
      // Nenhum caminho de erro vaza topologia nem o token: 500 generico.
      json(res, 500, { ok: false, erro: 'interno' })
      return
    }
    json(res, 200, { ok: true, handle: sonda.handle, fonte: 'secrets' })
  }
}

/* ========================================================================== */
/* As metricas de acesso (GET /api/access)                                    */
/* ========================================================================== */

/** Normaliza `undefined` para `null` no corpo — o painel le `null`, nao ausente. */
function ouNull(valor: string | undefined): string | null {
  return valor === undefined ? null : valor
}

/**
 * Projeta a lista de sessoes para a rota GET. FUNCAO PURA e exportada: e o
 * coracao das perguntas falsificaveis "o ?key ou o id em claro saem aqui?" e
 * "o ip vaza quando nao e confiavel?" — o corpo so tem hashes e metadados.
 */
export function projetarAcesso(bruto: UiAcessoBruto): Record<string, unknown> {
  return {
    totalConexoes: bruto.conexoesAtivas,
    totalSessoes: bruto.totalSessoes,
    conexoesAtivas: bruto.conexoesAtivas,
    ipConfiavel: bruto.ipConfiavel,
    sessoes: bruto.sessoes.map((registo) => ({
      hash: registo.hash,
      criadaEm: registo.criadaEm,
      ultimoUsoEm: registo.ultimoUsoEm,
      ip: ouNull(registo.ip),
      userAgent: ouNull(registo.userAgent),
    })),
  }
}

/**
 * GET /__guard-ui/api/access — quem/quanto esta a acessar. SO LE. Aglutina a
 * contagem de sockets ativos do PROXY do tunel (a fonte de `totalConexoes`/
 * `conexoesAtivas`) e a projecao das sessoes vivas do `SessionStore`. Um
 * endpoint de METADADOS de quem acessa: atras da MESMA barreira (loopback/tunel
 * autenticado) e sem nunca expor a `?key`-nem o id de sessao em claro.
 */
export function createAccessHandler(core: UiContribCore): UiContribRequestHandler {
  return (req, res) => {
    if (!exigeMetodo(req, res, 'GET')) return
    json(res, 200, projetarAcesso(core.acesso()))
  }
}

/* ========================================================================== */
/* O pareamento VIA PAINEL (POST /api/pair + GET /api/pair-state)             */
/* ========================================================================== */

/**
 * A mensagem PT-BR amigavel por codigo de erro de /pair. NUNCA vaza o codigo
 * nem o token: cada entrada e uma causa acionavel, sem numeros nem chaves.
 */
const TEXTO_ERRO_PAIR: Readonly<Record<string, string>> = {
  'ja-pareado': 'Este bot já tem um dono. Para trocar o dono, é preciso reset na máquina onde ele roda.',
  'sem-token': 'Configura o token no Passo 1 — só depois dá para parear.',
  'worker-indisponivel': 'O bot não está a correr agora. Confere o painel principal e tenta de novo.',
  interno: 'Algo falhou ao gerar o código. Tenta de novo.',
}

/**
 * GET /__guard-ui/api/pair-state — o estado do pareamento. SO LE: corpo com
 * `pareado` + `handle?` (lido do token-state), e `codigo`/`expiraEm` enquanto
 * houver sessao viva em memoria (re-exibicao no refresh). NUNCA vaza o token.
 */
export function createPairStateHandler(core: UiContribCore): UiContribRequestHandler {
  return (req, res) => {
    if (!exigeMetodo(req, res, 'GET')) return
    const estado = core.pairOps.estado()
    const corpo: Record<string, unknown> = { pareado: estado.pareado }
    if (estado.handle !== undefined) corpo['handle'] = estado.handle
    if (estado.codigo !== undefined && estado.expiraEm !== undefined) {
      corpo['codigo'] = estado.codigo
      corpo['expiraEm'] = estado.expiraEm
    }
    json(res, 200, corpo)
  }
}

/**
 * POST /__guard-ui/api/pair — inicia o pareamento pelo painel.
 *
 * Exige CSRF como qualquer POST desta superficie (NIST SP 800-63B-4 5.1.1).
 * A costura (`core.pairOps.gerar`) gera o codigo com `criarSessaoDePareamento`,
 * envia o digest (`pairing.challenge`) ao worker e guarda a sessao em memoria.
 * Sucesso -> 200 `{codigo, expiraEm}`; ja-pareado/sem-token/worker-indisponivel
 * -> 409 `{erro}` (mensagem amigavel PT-BR); o resto -> 500 `{erro:'interno'}`.
 * O CODIGO NUNCA sai para log: so nesta resposta.
 */
export function createPairHandler(core: UiContribCore): UiContribRequestHandler {
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
    let resultado
    try {
      resultado = await core.pairOps.gerar()
    } catch {
      json(res, 500, { erro: 'interno', mensagem: TEXTO_ERRO_PAIR['interno'] })
      return
    }
    if (!resultado.ok) {
      json(res, 409, {
        erro: resultado.erro,
        mensagem: TEXTO_ERRO_PAIR[resultado.erro] ?? TEXTO_ERRO_PAIR['interno'],
      })
      return
    }
    json(res, 200, { codigo: resultado.codigo, expiraEm: resultado.expiraEm })
  }
}

/* ========================================================================== */
/* O token anti-CSRF fresco (GET /api/csrf — HIGH-2)                          */
/* ========================================================================== */

/**
 * GET /__guard-ui/api/csrf — emite um token anti-CSRF NOVO para o VINCULO da
 * superficie e devolve-o. E o caminho de CSRF INDEPENDENTE do meta do indice
 * antigo, que o bundle novo usa em cad a POST (a fonte mais robusta: um GET
 * barato e stateless a cada escrita, sem depender do `tapIndex`).
 *
 * ATRAS DA MESMA BARREIRA (loopback/tunel autenticado) e SEM exigir CSRF — e
 * uma LEITURA, como as outras GETs desta superficie; o token nao e credencial
 * (quem alcanca o servidor consegue emitir um para si), e a extracao por
 * leitura de resposta e exactamente o que o `SameSite`/CORS fecha para o
 * navegador da vitima. O token devolvido e verificavel com o MESMO
 * `core.csrf.verify(token, UI_CSRF_BINDING)` dos POSTs.
 */
export function createCsrfHandler(core: UiContribCore): UiContribRequestHandler {
  return (req, res) => {
    if (!exigeMetodo(req, res, 'GET')) return
    json(res, 200, { token: core.csrf.issue(UI_CSRF_BINDING) })
  }
}
