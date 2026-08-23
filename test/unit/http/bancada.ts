/**
 * BANCADA do portao fiado -- as primitivas da Onda 2 montadas sobre um
 * diretorio de estado descartavel e um log de auditoria descartavel.
 *
 * Ficheiro SEM sufixo `.test.ts`: nao e executado como suite.
 *
 * PORQUE NAO VIVE EM `test/support/**`: essa arvore e PREP-OWNED e congelada
 * desde o COMMIT PREP 2 (leitura livre, escrita proibida). Esta bancada e da
 * sub-tarefa que fia o portao, e vive na arvore dela.
 *
 * NENHUM teste daqui invoca o `cloudflared` real (D10): a "origem do tunel" e
 * uma string publicada no registo, exatamente como o supervisor faria.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IncomingMessage } from 'node:http'

import type { Config } from '../../../src/config/schema.ts'
import type { GateDeps } from '../../../src/http/gate.ts'
import {
  createGateAuthStack,
  createRequestOriginResolver,
  createTunnelOriginRegistry,
  type GateAuthStack,
  type TunnelOriginRegistry,
} from '../../../src/http/session-auth.ts'
import { assertTrustworthyOrigin, serializeSessionCookie } from '../../../src/session/cookie.ts'
import { createLinkTokenStore } from '../../../src/session/link-token.ts'
import { LOOPBACK_ONLY_PREFIXES } from '../../../src/index.ts'
import { createGuardLogger } from '../../../src/logging/logger.ts'
import { digestSecret } from '../../../src/secret/verify.ts'
import { FakeClock } from '../../support/clock.ts'
import { FakeContext } from '../../support/ctx-double.ts'
import { makeConfig } from '../../support/fixtures.ts'

/** Um instante plausivel: o relogio de sessao e de parede, nao monotonico. */
export const T0 = 1_764_000_000_000

/** O segredo do dono usado em toda a bancada. NAO e o `encodedAuthString`. */
export const OWNER_SECRET = 'K7QF-2M9X-4TZP-9WQ2-8BND-3XKR-7MPV'

/** Origem publica de um tunel FALSO. Nenhum `cloudflared` e invocado (D10). */
export const FAKE_TUNNEL_ORIGIN = 'https://marks-organization-moved-coupons.trycloudflare.com'

export interface RequestSpec {
  readonly method?: string
  readonly url?: string
  readonly remoteAddress?: string | undefined
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Um `IncomingMessage` SEM QUALQUER API DE STREAM.
 *
 * E o teste de "o portao nao le o corpo" embutido em todos os outros: se
 * qualquer caminho de decisao chamasse `on('data')`, `read()` ou `for await`,
 * TODA a bancada rebentava.
 */
export function pedido(spec: RequestSpec = {}): IncomingMessage {
  const headers: Record<string, string> = { host: '127.0.0.1:3080', ...spec.headers }
  return {
    method: spec.method ?? 'GET',
    url: spec.url ?? '/',
    headers,
    socket: { remoteAddress: 'remoteAddress' in spec ? spec.remoteAddress : '127.0.0.1' },
  } as unknown as IncomingMessage
}

/** `Authorization: Basic` com o utilizador fixo `dsh` e a senha dada. */
export function basic(password: string, user = 'dsh'): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

export interface Bancada {
  readonly ctx: FakeContext
  readonly config: Config
  readonly gate: GateDeps
  readonly stack: GateAuthStack
  readonly tunnelOrigin: TunnelOriginRegistry
  readonly clock: FakeClock
  readonly auditPath: string
  /** Emite uma sessao valida e devolve o cabecalho `Cookie` que a apresenta. */
  emitirSessao(): string
  /** A chave no link (onda 1). `undefined` antes de criada. */
  readonly linkStore: ReturnType<typeof createLinkTokenStore>
  cleanup(): void
}

export interface BancadaOptions {
  readonly config?: Partial<Config>
  /** `true` provisiona o digest de {@link OWNER_SECRET} no `state.json`. */
  readonly comSegredo?: boolean
  /**
   * Apaga `encodedAuthString`. E o estado NORMAL do produto (D19: a credencial
   * nao vive num ficheiro versionavel), e nao um caso de borda.
   */
  readonly semCredencialEstatica?: boolean
  /** Publica uma origem de tunel READY. */
  readonly tunnelReady?: boolean
  readonly unauthenticatedPrefixes?: readonly string[]
  /** Rotas de CANAL LOCAL APENAS. Default: as reais do plugin. */
  readonly loopbackOnlyPrefixes?: readonly string[]
  /** `host:porta` do bind. Os testes com servidor REAL usam a porta efemera. */
  readonly loopbackAuthority?: string
}

export function bancada(options: BancadaOptions = {}): Bancada {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-gate-'))
  const auditPath = join(dir, 'audit.log')
  const clock = new FakeClock(T0)

  const ctx = new FakeContext()
  const log = createGuardLogger(ctx.asContext())
  const config = makeConfig(options.config)
  if (options.semCredencialEstatica === true) delete config.encodedAuthString
  const tunnelOrigin = createTunnelOriginRegistry()

  const stack = createGateAuthStack({
    log,
    tunnelOrigin,
    clock,
    stateDir: dir,
    auditPath,
    // O atraso interno e injetado a zero: o que se prova nos testes do portao e
    // o VEREDITO e os bytes, nunca o cronometro (`04-TESTES.md` 5.1.3).
    wait: (): Promise<void> => Promise.resolve(),
  })

  if (options.comSegredo === true) {
    stack.state.update((previous) => ({ ...previous, secretDigest: digestSecret(OWNER_SECRET) }))
  }
  if (options.tunnelReady === true) tunnelOrigin.publish(FAKE_TUNNEL_ORIGIN)

  const linkStore = createLinkTokenStore({ clock })

  const gate: GateDeps = {
    ctx: ctx.asContext(),
    log,
    config,
    auth: () => stack.auth,
    tunnelOrigin,
    bindHost: '127.0.0.1',
    loopbackAuthority: options.loopbackAuthority ?? '127.0.0.1:3080',
    loopbackOnlyPrefixes: options.loopbackOnlyPrefixes ?? LOOPBACK_ONLY_PREFIXES,
    unauthenticatedPrefixes: options.unauthenticatedPrefixes ?? [],
    linkToken: { verificar: (c) => linkStore.verificar(c) },
    // O mesmo padrao da fiacao em src/index.ts: resolver a origem efetiva,
    // recusar emitir onde o cookie Secure nao chega, e regenerate (anti-fixation).
    // O PROXY e a entrada do TUNEL (HTTPS), logo o esquema e forcado a `https`.
    issueSession: (req: IncomingMessage, presentedId: string | undefined): string | null => {
      const origem = createRequestOriginResolver({ config, tunnelOrigin })(req)
      try {
        assertTrustworthyOrigin({ scheme: 'https', host: origem.host })
      } catch {
        return null
      }
      const id = stack.sessions.regenerate(presentedId)
      return serializeSessionCookie(id, { scheme: 'https', host: origem.host })
    },
  }

  return {
    ctx,
    config,
    gate,
    stack,
    tunnelOrigin,
    clock,
    auditPath,
    emitirSessao(): string {
      return `__Host-dsh_sid=${stack.sessions.create()}`
    },
    linkStore,
    cleanup(): void {
      stack.dispose()
      linkStore.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
