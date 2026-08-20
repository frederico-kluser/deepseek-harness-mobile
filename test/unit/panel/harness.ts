/**
 * BANCADA das rotas `/__guard/*`. Ficheiro sem sufixo `.test.ts`: e material de
 * teste, nao uma suite.
 *
 * PRINCIPIOS QUE ESTA BANCADA IMPOE A TODOS OS TESTES DE T3.4:
 *
 *  - RELOGIO INJETADO. Nenhum teste espera tempo real. O TTL do `mk` sao 120 s e
 *    o do `ott` sao 10 minutos; ambos se atravessam com `clock.advance()`.
 *  - PORTAS EFEMERAS. `listen(0)` sempre. Uma porta fixa colide com a suite a
 *    correr em paralelo e transforma um teste correto em flake.
 *  - PRIMITIVAS REAIS. Sessoes, `mk`, `ott` e verificacao de segredo sao os
 *    modulos de producao da Onda 2, nao dubles. O que se dubla e o que esta
 *    FORA da fronteira desta sub-tarefa: o estado em disco, o log e o snapshot
 *    do tunel.
 *  - `res.sendDate = false`. O `Date` e emitido pelo `node:http`, muda a cada
 *    segundo e nao faz parte de nenhuma decisao do painel. Deixa-lo ligado
 *    transformava a comparacao "404 byte a byte" numa asercao sobre o relogio.
 */

import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import type { Config } from '../../../src/config/schema.ts'
import type { PersistedState, StateStore } from '../../../src/contracts/state.ts'
import type { TunnelSnapshot } from '../../../src/contracts/tunnel.ts'
import type { GuardLogger } from '../../../src/logging/logger.ts'
import type { PanelDeps, PanelRouteFactory } from '../../../src/panel/routes.ts'

import { DEFAULT_RATE_LIMIT_POLICY } from '../../../src/ratelimit/policy.ts'
import { createFailureTracker, type FailureTracker } from '../../../src/ratelimit/tracker.ts'
import { createOneTimeTokenStore, type OneTimeTokenStore } from '../../../src/secret/ott.ts'
import { createSecretStore, type SecretStoreHandle } from '../../../src/secret/store.ts'
import { createMagicStore, type MagicStore } from '../../../src/session/magic.ts'
import { createSessionStore, type GuardSessionStore } from '../../../src/session/store.ts'
import { createCsrfGuard, type CsrfGuard } from '../../../src/panel/csrf.ts'
import { createPanelRouter } from '../../../src/panel/routes.ts'
import {
  createRequestOriginResolver,
  createTunnelOriginRegistry,
  type TunnelOriginRegistry,
} from '../../../src/http/session-auth.ts'
import { FakeClock } from '../../support/clock.ts'
import { makeConfig } from '../../support/fixtures.ts'

/** `StateStore` em memoria. O disco nao e o que T3.4 esta a provar. */
function createMemoryStateStore(): StateStore {
  let estado: PersistedState = { version: 1, desiredState: 'STOPPED' }
  return {
    read: (): PersistedState => ({ ...estado }),
    update: (fn: (s: PersistedState) => PersistedState): void => {
      estado = fn({ ...estado })
    },
  }
}

export const SNAPSHOT_PARADO: TunnelSnapshot = { state: 'STOPPED', attempts: 0 }

/** URL de tunel usada nos testes. Distinta o bastante para procurar por substring. */
export const URL_DO_TUNEL = 'https://bancada-de-teste-t34.trycloudflare.com'

export const SNAPSHOT_ONLINE: TunnelSnapshot = {
  state: 'READY',
  attempts: 0,
  info: { url: URL_DO_TUNEL, startedAt: 1_000, mode: 'quick' },
  expiresAt: 3_600_000,
}

export interface Bancada {
  readonly clock: FakeClock
  /** A `Config` que o resolutor de origem consulta (eixo `exposure`). */
  readonly config: Config
  /** O registo REAL de T3.3. `publish()` simula o tunel a subir e a cair. */
  readonly tunnelOrigin: TunnelOriginRegistry
  readonly sessions: GuardSessionStore
  readonly magic: MagicStore
  readonly ott: OneTimeTokenStore
  readonly limiter: FailureTracker
  readonly csrf: CsrfGuard
  readonly secrets: SecretStoreHandle
  readonly deps: PanelDeps
  /** Eventos de auditoria recolhidos, por ordem. */
  readonly eventos: AuditEvent[]
  /** Atrasos que o limitador pediu, por ordem. Nenhum e realmente esperado. */
  readonly esperas: number[]
  readonly logs: string[]
  /** Snapshot que `deps.snapshot()` devolve. Mutavel de proposito. */
  estado: TunnelSnapshot
  /** Segredo canonico que `GET /__guard/secret` mostra. `null` = nada a mostrar. */
  segredo: string | null
  /** Sobe o servidor em porta efemera e devolve-a. */
  servir(routes?: PanelRouteFactory): Promise<number>
  fechar(): Promise<void>
}

export interface OpcoesBancada {
  /** Provisiona um segredo e devolve a forma canonica em `bancada.segredo`. */
  readonly comSegredo?: boolean
  readonly estado?: TunnelSnapshot
  /** Eixos da `Config` que o resolutor de origem le. Omitido: `exposure` ausente. */
  readonly config?: Partial<Config>
  /** Origem publica a publicar no registo do tunel, como o supervisor faria. */
  readonly tunnelOrigin?: string
  /** Substitui pedacos de `PanelDeps` (por exemplo `resolveOrigin`). */
  readonly deps?: Partial<PanelDeps>
}

export function criarBancada(opcoes: OpcoesBancada = {}): Bancada {
  const clock = new FakeClock(1_700_000_000_000)
  const config = makeConfig(opcoes.config)
  const tunnelOrigin = createTunnelOriginRegistry()
  if (opcoes.tunnelOrigin !== undefined) tunnelOrigin.publish(opcoes.tunnelOrigin)
  const sessions = createSessionStore({ clock })
  const magic = createMagicStore({ clock })
  const ott = createOneTimeTokenStore({ clock })
  const csrf = createCsrfGuard({ clock })
  const secrets = createSecretStore({ state: createMemoryStateStore(), sessions })
  const limiter = createFailureTracker({
    policy: DEFAULT_RATE_LIMIT_POLICY,
    now: () => clock.now(),
    // Jitter fixo: o atraso passa a ser funcao so do numero de falhas, que e o
    // que os testes comparam. `Math.random` aqui era um flake por construcao.
    random: () => 0.5,
    maxTrackedIdentities: 16,
  })

  const eventos: AuditEvent[] = []
  const esperas: number[] = []
  const logs: string[] = []
  const log: GuardLogger = {
    info: (m) => void logs.push(`info ${m}`),
    warn: (m) => void logs.push(`warn ${m}`),
    error: (m) => void logs.push(`error ${m}`),
    debug: (m) => void logs.push(`debug ${m}`),
  }

  let servidor: Server | undefined

  const bancada: Bancada = {
    clock,
    config,
    tunnelOrigin,
    sessions,
    magic,
    ott,
    limiter,
    csrf,
    secrets,
    eventos,
    esperas,
    logs,
    estado: opcoes.estado ?? SNAPSHOT_PARADO,
    segredo: null,
    deps: {
      log,
      audit: { append: (evento: AuditEvent): void => void eventos.push(evento) },
      realm: 'Secure DSH Interface',
      snapshot: (): TunnelSnapshot => bancada.estado,
      clock,
      secrets,
      sessions,
      magic,
      ott,
      reveal: (): string | null => bancada.segredo,
      limiter,
      csrf,
      /**
       * O RESOLUTOR DE T3.3, INJETADO -- e nao o default local que o painel
       * tinha.
       *
       * Este e o ponto de composicao do painel nesta arvore (o produto ainda nao
       * monta `/__guard/*`; isso e T5.3). A condicao correcta e
       * `exposure.mode === 'tunnel'` E o pedido ter chegado pelo nome publico do
       * tunel -- por isso a bancada tem `config` e `tunnelOrigin`, que sao
       * exatamente as duas coisas que o painel nao conhece.
       */
      resolveOrigin: createRequestOriginResolver({ config, tunnelOrigin }),
      wait: async (ms: number): Promise<void> => {
        esperas.push(ms)
      },
      ...opcoes.deps,
    },

    async servir(routes?: PanelRouteFactory): Promise<number> {
      const router =
        routes === undefined
          ? createPanelRouter(bancada.deps)
          : createPanelRouter(bancada.deps, routes)

      const alvo = createServer((req, res) => {
        res.sendDate = false
        void router(req, res)
      })
      servidor = alvo

      await new Promise<void>((resolve) => alvo.listen(0, '127.0.0.1', resolve))
      return (alvo.address() as AddressInfo).port
    },

    async fechar(): Promise<void> {
      limiter.dispose()
      sessions.dispose()
      magic.dispose()
      ott.dispose()
      const alvo = servidor
      servidor = undefined
      if (alvo === undefined) return
      await new Promise<void>((resolve) => alvo.close(() => resolve()))
    },
  }

  if (opcoes.comSegredo === true) {
    // `provision()` devolve o painel de apresentacao (texto agrupado + QR). O
    // que a rota do segredo mostra e a forma CANONICA; extrai-se do painel a
    // primeira linha, sem hifens, que e exatamente o que `canonicalizeSecret`
    // faria a partir dela.
    const painel = secrets.provision().display
    bancada.segredo = (painel.split('\n', 1)[0] ?? '').replaceAll('-', '')
  }

  return bancada
}

/* ========================================================================== */
/* Cliente HTTP                                                               */
/* ========================================================================== */

export interface Resposta {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  readonly setCookie: readonly string[]
}

export interface PedidoOpcoes {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly cookie?: string
}

export function pedir(port: number, path: string, opcoes: PedidoOpcoes = {}): Promise<Resposta> {
  return new Promise<Resposta>((resolve, reject) => {
    const headers: Record<string, string> = { ...opcoes.headers }
    if (opcoes.cookie !== undefined) headers['cookie'] = opcoes.cookie
    if (opcoes.body !== undefined && headers['content-type'] === undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
    }

    const req = request(
      { host: '127.0.0.1', port, path, method: opcoes.method ?? 'GET', headers },
      (res) => {
        const pedacos: Buffer[] = []
        res.on('data', (d: Buffer) => void pedacos.push(d))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(pedacos).toString('utf8'),
            setCookie: res.headers['set-cookie'] ?? [],
          }),
        )
      },
    )
    req.on('error', reject)
    if (opcoes.body !== undefined) req.write(opcoes.body)
    req.end()
  })
}

/**
 * Pedido por SOCKET CRU, para comparar respostas BYTE A BYTE.
 *
 * `request()` do `node:http` normaliza a linha de estado, minuscula e reordena
 * cabecalhos e esconde o enquadramento. "Byte a byte" so e uma afirmacao
 * verificavel se os bytes forem lidos do fio -- e a mesma tecnica que
 * `test/security/ratelimit-oracle.test.ts` ja usa.
 */
export function pedirCru(port: number, bruto: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(bruto)
    })
    const pedacos: Buffer[] = []
    socket.on('data', (d: Buffer) => void pedacos.push(d))
    socket.on('error', reject)
    socket.on('end', () => resolve(Buffer.concat(pedacos).toString('utf8')))
  })
}

/** Monta um `GET` cru, com `Connection: close` para o socket terminar. */
export function getCru(alvo: string): string {
  return `GET ${alvo} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`
}

/** Monta um `POST` cru com corpo `form-urlencoded`. */
export function postCru(alvo: string, corpo: string, cabecalhos: readonly string[] = []): string {
  const linhas = [
    `POST ${alvo} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/x-www-form-urlencoded',
    `Content-Length: ${Buffer.byteLength(corpo, 'utf8')}`,
    ...cabecalhos,
  ]
  return `${linhas.join('\r\n')}\r\n\r\n${corpo}`
}

/** Extrai o valor de `__Host-dsh_sid` de uma lista de `Set-Cookie`. */
export function sessaoDoCookie(setCookie: readonly string[]): string | undefined {
  for (const linha of setCookie) {
    const igual = linha.indexOf('=')
    if (igual === -1) continue
    if (linha.slice(0, igual) !== '__Host-dsh_sid') continue
    const fim = linha.indexOf(';')
    return linha.slice(igual + 1, fim === -1 ? undefined : fim)
  }
  return undefined
}
