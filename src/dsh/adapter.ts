/**
 * =============================================================================
 * UNICO ponto do repositorio que toca a API do DSH.
 * =============================================================================
 *
 * PORQUE UM SO FICHEIRO: uma breaking change do host passa a ser a edicao de um
 * ficheiro, e nao uma caca a `import` espalhados por vinte modulos. Item de
 * aceite da Onda 1: `grep -rl '@deepseek-ai/' src` tem de devolver so este
 * caminho. Todo o resto do `src/**` fala com o host atraves dos tipos e das
 * funcoes REEXPORTADOS daqui.
 *
 * REGRA Q-1 -- a fonte da API e o `.d.ts` do tarball, nunca prosa. Os
 * especificadores `@deepseek-ai/*` resolvem, por `paths` do `tsconfig.json`,
 * para os espelhos byte-exatos em `types/**`, verificados por
 * `test/contract/dsh-types.test.ts` (CONTRACT-001..009).
 *
 * NOMES QUE ESTAO CERTOS E NAO SE MEXEM (medicao da Onda 0 contra as 9 versoes
 * publicadas): o servico chama-se `webServer` e a classe `WebServer` de
 * `0.1.0-rc.3` ate `0.1.0-rc.8`; `httpServer`/`HttpServerService` so existiu em
 * `0.0.1-rc.1`/`rc.2`, uma linha morta cuja etiqueta `latest` esta estagnada.
 * Este projeto esta pinado em `0.1.0-rc.7`.
 * =============================================================================
 */

import { Server } from 'node:http'

import type { IncomingMessage } from 'node:http'
import type { Context, Disposable } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

import { GuardError } from '../errors.ts'

/* ========================================================================== */
/* Reexportacao dos tipos do host                                             */
/* ========================================================================== */

export type {
  Context,
  Disposable,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  WebRoute,
  WebServer,
  WebUpgradeRoute,
}

/**
 * Assinatura de um handler de rota HTTP.
 *
 * NAO existe um tipo exportado `WebHandler`/`WebUpgradeHandler` no pacote real
 * (era invencao dos `types/**` antigos deste repositorio). O que existe e o
 * campo `handler` de `WebRoute`/`WebUpgradeRoute` -- e e dele que se deriva.
 */
export type WebRequestHandler = WebRoute['handler']

/** Assinatura de um handler de handshake `Connection: Upgrade`. */
export type WebUpgradeHandler = WebUpgradeRoute['handler']

/**
 * Enderecos de bind que o `WebServer` aceita.
 *
 * E uma UNIAO DE LITERAIS (`'127.0.0.1' | '0.0.0.0'`), nao `string`: o
 * compilador conhece o conjunto inteiro, o que torna a allowlist de bind
 * exaustiva em tempo de compilacao (ver `src/config/bind.ts`).
 */
export type BindHost = WebServer['host']

/* ========================================================================== */
/* Eventos tipados (module augmentation)                                      */
/* ========================================================================== */

/**
 * Expansao estatica global do mapa `Events`. E isto que da VALIDACAO PELO
 * COMPILADOR aos despachos: `ctx.waterfall('http/auth-check', req, next)` so
 * compila porque a assinatura abaixo existe. `Events` nasce vazia no Cordis e
 * cada plugin declara os eventos que emite/consome.
 *
 * Vive AQUI, e nao em `src/index.ts`, pela mesma razao que tudo o resto neste
 * ficheiro: `declare module '@deepseek-ai/cordis'` nomeia um pacote do host.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode waterfall */
    'http/auth-check'(req: IncomingMessage, next: () => Promise<boolean>): Promise<boolean>
    /** @mode waterfall */
    'security/permission-elevate'(command: string, next: () => Promise<boolean>): Promise<boolean>
  }
}

/* ========================================================================== */
/* Acesso ao servidor node:http por baixo do servico                          */
/* ========================================================================== */

/**
 * Localiza o `node:http.Server` dentro do servico `webServer`.
 *
 * PORQUE E PRECISO: a barreira de autenticacao troca o dono do DESPACHO
 * (`src/http/intercept.ts`). O campo chama-se `server` e e `private` APENAS em
 * TypeScript -- no `lib/index.js` publicado e um campo de classe comum
 * (`this.server = createServer(...)`). O varrimento por `instanceof Server`
 * sobre `Object.getOwnPropertyNames` e a rede de seguranca contra uma
 * renomeacao do campo numa versao futura.
 *
 * E o UNICO campo `private` a que este plugin se acopla. A alternativa medida
 * (reescrever as tabelas de rota) acopla a tres ou quatro.
 *
 * FALHA ALTO, sempre: um servidor nao localizavel significa "sem barreira", e
 * "sem barreira" e uma credencial universal. Nunca degradar em silencio.
 */
export function resolveWebServerHttpServer(webServer: WebServer | undefined | null): Server {
  if (webServer === undefined || webServer === null) {
    throw new GuardError('BARRIER_UNAVAILABLE', 'o servico webServer nao esta disponivel.')
  }

  const candidate = (webServer as unknown as { readonly server?: unknown }).server
  if (candidate instanceof Server) return candidate

  const bag = webServer as unknown as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(webServer)) {
    let value: unknown
    try {
      value = bag[key]
    } catch {
      // Um getter que lanca nao e o campo que procuramos.
      continue
    }
    if (value instanceof Server) return value
  }

  throw new GuardError(
    'BARRIER_UNAVAILABLE',
    'nenhum node:http.Server foi encontrado no servico webServer ' +
      `(campos inspecionados: ${Object.getOwnPropertyNames(webServer).join(', ') || 'nenhum'}).`,
  )
}
