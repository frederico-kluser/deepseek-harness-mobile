/**
 * Declaracoes locais para `@deepseek-ai/dsh-host-webserver`.
 *
 * O pacote e "vendored" no monorepo do DeepSeek Harness
 * (packages/host/webserver) e NAO e publicado no npm publico, por isso o
 * projeto resolve os seus tipos atraves de `compilerOptions.paths`.
 *
 * Este ficheiro e um MODULO real (tem `export`), nao um `declare module`
 * ambiente: e essa a condicao para que
 * `declare module '@deepseek-ai/dsh-host-webserver' { ... }` funcione como
 * *module augmentation* a partir do codigo do plugin.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * Funcao de anulacao devolvida por todo o registo. E a ancora da
 * "composibilidade temporal" do Cordis: o disposer e SINCRONO e e executado
 * em ordem LIFO quando a Fiber transita para DISPOSED.
 */
export type Disposer = () => void

/**
 * Modo de correspondencia de rota. `'exact'` tem prioridade absoluta;
 * `'prefix'` e resolvido pelo maior comprimento de prefixo.
 */
export type RouteKind = 'exact' | 'prefix'

/** Manipulador HTTP cru (node:http), sem qualquer camada tipo Express. */
export type WebHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Rota registada em `ctx.webServer.register`. */
export interface WebRoute {
  kind: RouteKind
  path: string
  handler: WebHandler
}

/**
 * Manipulador de negociacao de protocolo, com a assinatura nativa do evento
 * `'upgrade'` de `node:http` (`(req, socket, head)`): o socket ja esta
 * destacado do ciclo pedido/resposta, pelo que NAO ha `ServerResponse` -- quem
 * responde escreve os bytes do handshake directamente no `Duplex`.
 *
 * Tipado explicitamente (e nao `(...args: any[]) => void`) por causa da
 * convencao "explicit > implicit" do tsconfig: `any` aqui apagava a unica
 * informacao util da superficie publica.
 */
export type WebUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

/** Rota de negociacao de protocolo (`Connection: Upgrade`), sempre exata. */
export interface WebUpgradeRoute {
  path: string
  handler: WebUpgradeHandler
}

/**
 * Servico `ctx.webServer` injetado pelo pacote `dsh-host-webserver`.
 *
 * Todos os metodos `register*` devolvem um {@link Disposer}; devolver esse
 * disposer e obrigatorio em qualquer interceao, sob pena de quebrar a
 * reversibilidade atomica do Cordis.
 */
export interface WebServer {
  /** Interface de rede a que o servidor esta ligado (ex.: `'127.0.0.1'`, `'0.0.0.0'`). */
  host: string
  /** Porta TCP em escuta. */
  port: number

  /** Regista uma rota exata ou por prefixo. Devolve o disposer do registo. */
  register(route: { kind: RouteKind; path: string; handler: WebRoute['handler'] }): Disposer

  /**
   * Regista o manipulador de contingencia (ultimo recurso). E aqui que o
   * pacote `dsh-host-frontend-static` monta o SPA routing da Web UI, e por
   * isso e este o ponto que uma barreira de autenticacao tem de intercetar.
   */
  registerFallback(handler: WebRoute['handler']): Disposer

  /** Regista um manipulador de `Connection: Upgrade` (ex.: WebSocket). */
  registerUpgrade(route: { path: string; handler: WebUpgradeHandler }): Disposer
}
