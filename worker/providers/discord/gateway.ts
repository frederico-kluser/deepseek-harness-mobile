/**
 * O LOOP DO GATEWAY do adaptador discord — WebSocket NATIVO do Node (>= 24
 * tem o client `WebSocket` global), SEM SDK e SEM dependencia nova.
 *
 * ===========================================================================
 * O FLUXO (doc oficial de gateway, confirmado na implementacao)
 * ===========================================================================
 *   1. URL: `GET /gateway/bot` (REST, Bearer) devolve `{url, shards}` — ou a
 *      URL injetada (`gatewayUrl`, duble de teste). O proprio servidor devolve
 *      a url completa com `v=10&encoding=json`; o `READY` ainda traz um
 *      `resume_gateway_url` para as retomadas (usado quando presente);
 *   2. `Hello` (op 10) traz `d.heartbeat_interval` (ms): o primeiro heartbeat
 *      sai com JITTER (`intervalo * random(0..1)`, doc oficial) e depois a
 *      cada intervalo; cada heartbeat envia `d` = o ultimo `s` (seq);
 *   3. sem `session_id` -> `Identify` (op 2) com `{token, intents,
 *      properties:{os,browser,device}}`; com `session_id` -> `Resume` (op 6)
 *      com `{token, session_id, seq}` — eventos perdidos re-playam e o
 *      `RESUMED` fecha o arranque;
 *   4. `READY` (op 0, t=READY) guarda `d.session_id` e `d.resume_gateway_url`;
 *   5. op 11 (heartbeat ack) mantem a conexao viva; sem ack dentro de
 *      `grace * intervalo` o loop fecha (4000) e RESUME — o zombie morre;
 *   6. op 7 (reconnect) e op 9 (invalid session, `d=true`) -> fecha e resume;
 *      op 9 com `d=false` -> fecha e IDENTIFICA de novo (a sessao morreu);
 *   7. close com 1000/1001 -> sessao invalidada, re-identify; close 4000-4009
 *      (ou rede, 1006) -> resume; close 4004 (auth), 4013 (intent invalido) e
 *      4014 (intent desaprovado) -> FATAL `GATEWAY_UNAUTHORIZED` (espelho do
 *      401 do telegram, exit 12) — ZERO reconexoes;
 *   8. reconexao com backoff exponencial (1,2,4,...,30 s, no relogio injetado).
 *
 * PRAZO DE ARRANQUE: espelho do `DEFAULT_BOOT_TIMEOUT_MS` do telegram (45 s).
 * Se o gateway nao chegar a `READY`/`RESUMED` a tempo, o loop encerra com
 * `BOOT_TIMEOUT` (exit 14) — a politica de reinicio e do supervisor do host.
 *
 * O `onDispatch` recebe CADA payload `{op,t,s,d}` do gateway; quem traduz para
 * o contrato neutro e o adapter (`parse.ts`), nunca este modulo.
 *
 * O handle devolvido por {@link iniciarGateway} e o que o adapter usa no
 * `stop()`: `parar()` marca o encerramento e fecha o socket com 1000 — a
 * sessao e invalidada de proposito (estamos a desligar, nao a reconectar).
 */

import type { ClienteDiscord } from './cliente.ts'
import { DiscordApiError } from './cliente.ts'
import type { ProviderErrorCode, TimeSource, WorkerLogger } from './interno.ts'
import { ProviderError, WORKER_EXIT, describeForLog, systemTime } from './interno.ts'

/** Gateway opcodes (doc oficial de opcodes-and-status-codes). */
export const OP = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const)

/** Close codes do gateway (doc oficial de opcodes-and-status-codes). */
export const CLOSE = Object.freeze({
  /** Normal closure — INVALIDA a sessao; a proxima conexao identifica de novo. */
  NORMAL: 1000,
  /** Going away — INVALIDA a sessao (mesmo tratamento do 1000). */
  GOING_AWAY: 1001,
  /** Abnormal closure (rede) — resume possivel. */
  ABNORMAL: 1006,
  /** Unknown error — resume possivel. */
  UNKNOWN_ERROR: 4000,
  /** Authentication failed — FATAL: o token do identify e incorrecto. */
  AUTHENTICATION_FAILED: 4004,
  /** Invalid seq no resume — resume possivel (recomeca do identify). */
  INVALID_SEQ: 4007,
  /** Rate limited — resume possivel. */
  RATE_LIMITED: 4008,
  /** Session timed out — resume possivel (recomeca do identify). */
  SESSION_TIMED_OUT: 4009,
  /** Invalid intent(s) — FATAL: intents mal calculados. */
  INVALID_INTENTS: 4013,
  /** Disallowed intent(s) — FATAL: intent privilegiado nao aprovado. */
  DISALLOWED_INTENTS: 4014,
} as const)

/** Escalada de espera entre reconexoes (ms, relogio injetado). */
export const DEFAULT_BACKOFF_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])

/** Prazo de arranque: espelho do `DEFAULT_BOOT_TIMEOUT_MS` do telegram. */
export const DEFAULT_BOOT_TIMEOUT_MS = 45_000

/** Prazo para a conexao abrir e para o Hello chegar. */
export const CONNECT_TIMEOUT_MS = 10_000

/** Zombie detection: sem ack em `grace * intervalo`, fecha e resume. */
export const HEARTBEAT_ACK_GRACE = 2

/**
 * Prazo de espera pelo 'close' do websocket apos um encerramento PEDIDO por
 * nos (stop/prazo de boot): um peer que nao completa o close handshake (rede
 * morta, servidor mudo) nao pode segurar o outcome para sempre. O socket fica
 * orfao e o processo sai por ele mesmo (nada o segura apos o exit).
 */
export const CLOSE_WAIT_MS = 1_500

/** Os intents que este bot declara no identify (doc oficial de intents). */
export const INTENTS = Object.freeze({
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const)

/**
 * O minimo que este bot precisa para LER mensagens: guild e DM (texto
 * incluido). `MESSAGE_CONTENT` e PRIVILEGIADO: tem de estar ativo no portal
 * do desenvolvedor (close 4014 se nao estiver) — documentado para o operador.
 */
export const INTENTS_DO_BOT: number =
  INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT

export interface GatewayDeps {
  readonly token: string
  readonly log: WorkerLogger
  readonly time?: TimeSource
  readonly intents?: number
  /** Cliente REST (para o `GET /gateway/bot` quando `gatewayUrl` ausente). */
  readonly cliente: ClienteDiscord
  /** URL do gateway injetada (duble de teste). Omitida: via `/gateway/bot`. */
  readonly gatewayUrl?: string
  /** Construtor WebSocket injetavel (duble). Omitido: o global do Node 24. */
  readonly WebSocketCtor?: typeof WebSocket
  /** Jitter do primeiro heartbeat (0..1). Omitido: `Math.random` (doc oficial). */
  readonly jitter?: () => number
  /** Escalada de backoff em ms. Omitida: {@link DEFAULT_BACKOFF_MS}. */
  readonly backoffMs?: readonly number[]
  readonly bootTimeoutMs?: number
  readonly heartbeatGrace?: number
}

/** Como o loop do gateway terminou. */
export type GatewayOutcome =
  | { readonly kind: 'stopped'; readonly exitCode: number }
  | {
      readonly kind: 'fatal'
      readonly code: ProviderErrorCode
      readonly exitCode: number
      readonly error: unknown
    }

/** O handle que o adapter usa para parar o gateway. */
export interface GatewayRoda {
  /** Resolve quando o loop parar ou falhar de forma terminal. */
  readonly outcome: Promise<GatewayOutcome>
  /** Encerra o loop e fecha o socket (sessao invalidada de proposito). */
  readonly parar: () => void
}

/** O que uma sessao devolveu ao loop principal. */
type VereditoDeSessao = 'fatal' | 'parado' | 'continuar'

function isObject(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null
}

function lerNumero(valor: unknown): number | undefined {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : undefined
}

/**
 * Inicia o loop do gateway. Resolve `outcome` quando o loop parar (`parar()`)
 * ou falhar de forma terminal (401/4013/4014/BOOT_TIMEOUT).
 *
 * `onDispatch` recebe cada payload do gateway; uma falha na entrega NAO mata
 * o loop (S4) — quem trata e o adapter.
 */
export function iniciarGateway(
  deps: GatewayDeps,
  onDispatch: (payload: unknown) => void,
): GatewayRoda {
  const time = deps.time ?? systemTime
  const log = deps.log
  const intents = deps.intents ?? INTENTS_DO_BOT
  const backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS
  const jitter = deps.jitter ?? Math.random
  const bootTimeoutMs = deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
  const grace = deps.heartbeatGrace ?? HEARTBEAT_ACK_GRACE
  const WS = deps.WebSocketCtor ?? WebSocket
  const segredosDe = (): readonly string[] => [deps.token]

  let parado = false
  let arrancou = false
  let fatal: ProviderError | undefined
  let sessionId: string | undefined
  let resumeUrl: string | undefined
  let seq: number | undefined
  let sock: WebSocket | undefined

  const fecharSock = (code: number, motivo: string): void => {
    const atual = sock
    if (atual !== undefined && atual.readyState === WebSocket.OPEN) {
      try {
        atual.close(code, motivo)
      } catch (error) {
        log.debug('close do websocket falhou (ja fechado?)', { detail: describeForLog(error) })
      }
    }
  }

  const parar = (): void => {
    if (parado) return
    parado = true
    // 1000 INVALIDA a sessao de proposito: estamos a desligar, nao a
    // reconectar — o supervisor do host e quem decide a proxima vida.
    fecharSock(CLOSE.NORMAL, 'paragem')
  }

  /** UMA sessao: conecta, Hello, heartbeat, identify/resume, dispatches. */
  async function correrUmaSessao(): Promise<VereditoDeSessao> {
    // 1. A URL do gateway: injetada (duble) ou via GET /gateway/bot (REST).
    let url = deps.gatewayUrl
    if (url === undefined) {
      try {
        url = (await deps.cliente.getGatewayBot()).url
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 401) {
          fatal = new ProviderError(
            WORKER_EXIT.UNAUTHORIZED,
            'GATEWAY_UNAUTHORIZED',
            'o token foi recusado pelo GET /gateway/bot (HTTP 401): revogado ou errado. ' +
              'O processo SAI: reiniciar cegamente nao resolve um token recusado.',
            { cause: error },
          )
          log.error(fatal.message, { code: fatal.reason, exit_code: fatal.code })
          return 'fatal'
        }
        // Rede/proxy: o backoff do loop volta a tentar; o prazo de boot cobre.
        log.warn('falha ao obter a URL do gateway; nova tentativa com backoff', {
          detail: describeForLog(error, segredosDe()),
        })
        return 'continuar'
      }
    }
    if (parado) return 'parado'
    if (fatal !== undefined) return 'fatal'

    // Em modo resume, a doc manda usar o `resume_gateway_url` do READY.
    const urlDeConexao = sessionId !== undefined && resumeUrl !== undefined ? resumeUrl : url

    // 2. Abre o WebSocket. O undici nao expoe detalhe no 'error' — o 'close'
    // vem a seguir e e ele que classifica.
    const novaSessao = new WS(urlDeConexao)
    sock = novaSessao

    const aberta = new Promise<'aberta' | 'falhou'>((resolve) => {
      const aoAbrir = (): void => {
        limpar()
        resolve('aberta')
      }
      const aoFecharCedo = (): void => {
        limpar()
        resolve('falhou')
      }
      const prazo = setTimeout(() => {
        limpar()
        fecharSock(CLOSE.UNKNOWN_ERROR, 'timeout de conexao')
        resolve('falhou')
      }, CONNECT_TIMEOUT_MS)
      function limpar(): void {
        clearTimeout(prazo)
        novaSessao.removeEventListener('open', aoAbrir)
        novaSessao.removeEventListener('close', aoFecharCedo)
      }
      novaSessao.addEventListener('open', aoAbrir)
      novaSessao.addEventListener('close', aoFecharCedo)
    })
    if ((await aberta) === 'falhou') {
      if (fatal !== undefined) return 'fatal'
      return parado ? 'parado' : 'continuar'
    }

    // 3. OS LISTENERS DA SESSAO INSTALAM-SE AGORA, ANTES DO HELLO: o close
    // pode chegar em qualquer instante, e o WebSocket do undici PERDE o evento
    // se o listener nao estiver instalado — o `fechada` ficaria pendurado para
    // sempre e o outcome nunca resolveria. Um so par de listeners cobre o
    // Hello, os dispatches e o close (o Hello tambem resolve a promessa).
    let resolverHello: ((intervalo: number | undefined) => void) | undefined
    let resolverFechada: (() => void) | undefined
    const hello = new Promise<number | undefined>((resolve) => {
      resolverHello = resolve
    })
    const fechada = new Promise<void>((resolve) => {
      resolverFechada = resolve
    })
    const prazoDoHello = setTimeout(() => {
      resolverHello?.(undefined)
    }, CONNECT_TIMEOUT_MS)
    const aoMessage = (ev: MessageEvent): void => {
      const intervalo = lerHello(novaSessao, ev)
      if (intervalo !== undefined) {
        clearTimeout(prazoDoHello)
        resolverHello?.(intervalo)
      }
      tratarMensagem(ev)
    }
    const aoClose = (ev: CloseEvent): void => {
      clearTimeout(prazoDoHello)
      resolverHello?.(undefined)
      tratarClose(ev.code)
      resolverFechada?.()
    }
    novaSessao.addEventListener('message', aoMessage)
    novaSessao.addEventListener('close', aoClose)

    const intervalo = await hello
    if (intervalo === undefined) {
      fecharSock(CLOSE.UNKNOWN_ERROR, 'hello ausente')
      // Ja decidimos sair desta sessao: se o peer nao completar o close
      // handshake, o prazo curto garante a saida do loop (socket orfao).
      await Promise.race([fechada, time.sleep(CLOSE_WAIT_MS)])
      if (fatal !== undefined) return 'fatal'
      return parado ? 'parado' : 'continuar'
    }

    // 4. Heartbeat: primeiro com JITTER (doc oficial), depois periodico; um
    // vigia de ack (zombie) fecha a sessao se o ack nao vier a tempo.
    let aguardandoAck = false
    const enviarHeartbeat = (): void => {
      if (novaSessao.readyState !== WebSocket.OPEN) return
      novaSessao.send(JSON.stringify({ op: OP.HEARTBEAT, d: seq ?? null }))
    }
    const jitterDelay = Math.round(intervalo * Math.min(Math.max(jitter(), 0), 1))
    const primeiroHeartbeat = setTimeout(enviarHeartbeat, jitterDelay)
    const heartbeats = setInterval(enviarHeartbeat, intervalo)
    const vigiaDeAck = setInterval(() => {
      if (aguardandoAck) {
        // Nenhum ack desde o ultimo heartbeat: a conexao morreu (zombie).
        fecharSock(CLOSE.UNKNOWN_ERROR, 'heartbeat sem ack')
        return
      }
      aguardandoAck = true
    }, intervalo * grace)

    // 5. Identify (op 2) ou Resume (op 6) — a decisao e por `sessionId`.
    if (sessionId !== undefined) {
      novaSessao.send(
        JSON.stringify({
          op: OP.RESUME,
          d: { token: deps.token, session_id: sessionId, seq: seq ?? null },
        }),
      )
      log.info('gateway: a retomar a sessao anterior (resume)', { session: sessionId })
    } else {
      novaSessao.send(
        JSON.stringify({
          op: OP.IDENTIFY,
          d: {
            token: deps.token,
            intents,
            properties: {
              os: process.platform,
              browser: 'dsh-guard-messenger',
              device: 'dsh-guard-messenger',
            },
          },
        }),
      )
      log.info('gateway: identify enviado', { intents })
    }

    // 6. Espera o close da sessao (os listeners ja estao instalados no passo 3).
    // COM A CONEXAO VIVA, espera-se o close SEM prazo — e o batimento normal
    // da sessao (o servidor fecha, ou o stop() pede). O prazo curto so vale
    // quando o encerramento foi PEDIDO por nos (parado/fatal): ai, um peer
    // que nao completa o close handshake nao pode segurar o outcome.
    if (parado || fatal !== undefined) {
      await Promise.race([fechada, time.sleep(CLOSE_WAIT_MS)])
    } else {
      await fechada
    }

    // Limpa os timers do heartbeat (a sessao acabou).
    clearTimeout(primeiroHeartbeat)
    clearTimeout(prazoDoHello)
    clearInterval(heartbeats)
    clearInterval(vigiaDeAck)

    if (fatal !== undefined) return 'fatal'
    if (parado) return 'parado'
    return 'continuar'

    // --- helpers locais da sessao -------------------------------------------

    function tratarMensagem(ev: MessageEvent): void {
      const dados = typeof ev.data === 'string' ? ev.data : undefined
      if (dados === undefined) return
      let payload: unknown
      try {
        payload = JSON.parse(dados)
      } catch {
        log.warn('payload nao-JSON do gateway; descartado sem excecao', {
          detail: describeForLog(dados, segredosDe()),
        })
        return
      }
      if (!isObject(payload)) return
      const op = lerNumero(payload.op)

      if (op === OP.DISPATCH) {
        const s = lerNumero(payload.s)
        if (s !== undefined) seq = s
        const t = payload.t
        if (t === 'READY' && isObject(payload.d)) {
          const sid = payload.d.session_id
          if (typeof sid === 'string' && sid !== '') sessionId = sid
          const rug = payload.d.resume_gateway_url
          if (typeof rug === 'string' && rug !== '') resumeUrl = rug
          if (!arrancou) {
            arrancou = true
            log.info('gateway pronto (READY): a receber eventos', { session: sessionId })
          }
        }
        if (t === 'RESUMED' && !arrancou) {
          arrancou = true
          log.info('sessao retomada (RESUMED): a receber eventos')
        }
        onDispatch(payload)
        return
      }

      if (op === OP.HEARTBEAT_ACK) {
        aguardandoAck = false
        return
      }

      if (op === OP.HEARTBEAT) {
        // O servidor pediu um heartbeat imediato (doc oficial).
        enviarHeartbeat()
        return
      }

      if (op === OP.RECONNECT) {
        // O servidor manda fechar e retomar (resume) a sessao.
        fecharSock(CLOSE.UNKNOWN_ERROR, 'reconnect pedido pelo servidor')
        return
      }

      if (op === OP.INVALID_SESSION) {
        // d=true: a sessao pode ser retomada; d=false: morreu, identify novo.
        if (payload.d !== true) {
          sessionId = undefined
          seq = undefined
        }
        fecharSock(CLOSE.UNKNOWN_ERROR, 'sessao invalida')
        return
      }
    }

    function tratarClose(code: number): void {
      if (fatal !== undefined || parado) return
      if (
        code === CLOSE.AUTHENTICATION_FAILED ||
        code === CLOSE.INVALID_INTENTS ||
        code === CLOSE.DISALLOWED_INTENTS
      ) {
        const motivo =
          code === CLOSE.AUTHENTICATION_FAILED
            ? 'o token do identify foi recusado (close 4004): revogado ou errado'
            : code === CLOSE.INVALID_INTENTS
              ? 'intents invalidos (close 4013): a soma de bits nao e um intents valido'
              : 'intent privilegiado nao aprovado (close 4014): ative o MESSAGE_CONTENT no portal do desenvolvedor'
        fatal = new ProviderError(
          WORKER_EXIT.UNAUTHORIZED,
          'GATEWAY_UNAUTHORIZED',
          `${motivo}. O processo SAI: zero reconexoes para um veredito de token.`,
        )
        log.error(fatal.message, { code: fatal.reason, exit_code: fatal.code, close: code })
        return
      }
      if (code === CLOSE.NORMAL || code === CLOSE.GOING_AWAY) {
        // Sessao invalidada: a proxima conexao identifica de novo.
        sessionId = undefined
        seq = undefined
        log.info('gateway fechou (1000/1001): a sessao foi invalidada; a proxima conexao identifica de novo')
        return
      }
      // 4000-4009 (e 1006 de rede): resume possivel — o loop reconecta e
      // retoma a sessao (ou identifica de novo se nao houver sessao).
      log.warn('gateway fechou; a reconectar (resume da sessao)', {
        close: code,
        session: sessionId,
      })
    }
  }

  // O PRAZO DE ARRANQUE: se o primeiro READY/RESUMED nao chegar a tempo, o
  // loop encerra com BOOT_TIMEOUT (espelho do telegram — exit 14). O timer e
  // `unref()`ado: se o event loop esvaziar sozinho, nada o segura.
  const prazoBoot = setTimeout(() => {
    if (arrancou || parado) return
    fatal = new ProviderError(
      WORKER_EXIT.BOOT_TIMEOUT,
      'BOOT_TIMEOUT',
      `o gateway nao chegou a READY/RESUMED em ${bootTimeoutMs} ms`,
    )
    parado = true
    fecharSock(CLOSE.NORMAL, 'boot timeout')
  }, bootTimeoutMs)
  prazoBoot.unref()

  // O LOOP PRINCIPAL: sessao tras sessao, com backoff entre elas.
  const outcome = (async (): Promise<GatewayOutcome> => {
    let tentativa = 0
    for (;;) {
      const veredito = await correrUmaSessao()
      if (veredito === 'fatal' || veredito === 'parado' || fatal !== undefined) break
      const espera = backoffMs[Math.min(tentativa, backoffMs.length - 1)] ?? backoffMs[0] ?? 1_000
      tentativa += 1
      log.debug('gateway: nova tentativa com backoff', { tentativa, espera_ms: espera })
      await time.sleep(espera)
      if (parado) break
    }

    clearTimeout(prazoBoot)

    if (fatal !== undefined) {
      log.error(fatal.message, { code: fatal.reason, exit_code: fatal.code })
      // O `code` do outcome e a CAUSA legivel (o `ProviderError.reason`); o
      // `exitCode` e o NUMERICO (o `ProviderError.code`) — o boot generico
      // classifica por este ultimo, lendo o campo, sem instanceof de provedor.
      // O cast e honesto: `reason` e sempre um dos valores do vocabulario
      // fechado (construido com esse literal nos tres sitios de fatal).
      return {
        kind: 'fatal',
        code: fatal.reason as ProviderErrorCode,
        exitCode: fatal.code,
        error: fatal,
      }
    }
    return { kind: 'stopped', exitCode: WORKER_EXIT.OK }
  })()

  return { outcome, parar }
}

/** Le o `heartbeat_interval` do Hello (op 10), em ms. */
function lerHello(sock: WebSocket, ev: MessageEvent): number | undefined {
  const dados = typeof ev.data === 'string' ? ev.data : undefined
  if (dados === undefined) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(dados)
  } catch {
    return undefined
  }
  if (!isObject(payload) || payload.op !== OP.HELLO) return undefined
  if (!isObject(payload.d)) return undefined
  const intervalo = lerNumero(payload.d.heartbeat_interval)
  if (intervalo === undefined || intervalo <= 0) return undefined
  return intervalo
}
