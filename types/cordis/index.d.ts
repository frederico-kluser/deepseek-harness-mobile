/**
 * Declaracoes locais para `@deepseek-ai/cordis` (Cordis v4, tal como embebido
 * no DeepSeek Harness v0.1).
 *
 * O pacote e "vendored" no monorepo do DSH e NAO e publicado no npm publico;
 * os seus tipos sao resolvidos via `compilerOptions.paths`.
 *
 * IMPORTANTE: este ficheiro e um MODULO real (tem `export`), e nao um
 * `declare module` ambiente global. So assim e que
 *
 *   declare module '@deepseek-ai/cordis' {
 *     interface Events { 'http/auth-check'(...): Promise<boolean> }
 *   }
 *
 * escrito a partir de `src/index.ts` funciona como *module augmentation*.
 */
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessService } from '@deepseek-ai/dsh-host-subprocess'

/* -------------------------------------------------------------------------- */
/* Utilitarios                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Funcao de anulacao. O Cordis acumula disposers na Fiber ativa e executa-os
 * em ordem estritamente inversa a instanciacao (LIFO) quando a Fiber transita
 * para DISPOSED.
 *
 * GARANTIA REAL DO TIPO (nao inflacionar): o retorno declarado e `void`, o que
 * o compilador so usa para IGNORAR o valor devolvido -- nao para o proibir.
 * Por bivariancia de retorno `void` do TypeScript,
 *
 *   ctx.effect(async () => { ... })        // REJEITADO: `Promise` nao e funcao
 *   ctx.effect(() => async () => { ... })  // COMPILA: disposer `async` passa
 *
 * ou seja, o tipo impede que a FUNCAO PRODUTORA seja assincrona, mas NAO
 * consegue impedir um disposer assincrono. A sincronia do disposer e uma
 * exigencia do MOTOR em tempo de execucao, nao uma garantia verificada: um
 * disposer que devolva uma `Promise` e tratado como ja concluido, e a ordem
 * LIFO de erradicacao quebra em silencio. Devolver `Promise` daqui e um bug
 * que nenhum `tsc` apanha.
 */
export type Disposer = () => void

/**
 * Extracao de parametros SEM a restricao `extends (...args: any) => any` do
 * `Parameters<T>` da lib. E indispensavel porque `Events` nasce VAZIA e
 * augmentavel: para um `K` generico, `Events[K]` e um acesso indexado diferido
 * que nao satisfaz eagerly a restricao do utilitario nativo.
 */
export type EventArgs<F> = F extends (...args: infer A) => unknown ? A : never

/** Extracao do tipo de retorno, tambem sem restricao eager. */
export type EventResult<F> = F extends (...args: never[]) => infer R ? R : never

/* -------------------------------------------------------------------------- */
/* Eventos                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mapa global de eventos tipados. Nasce VAZIA por desenho: cada plugin
 * declara os seus eventos por *module augmentation*.
 *
 * @example
 * declare module '@deepseek-ai/cordis' {
 *   interface Events {
 *     'http/auth-check'(req: IncomingMessage, next: () => Promise<boolean>): Promise<boolean>
 *   }
 * }
 */
export interface Events {}

/** Nome de qualquer evento declarado em {@link Events}. */
export type EventName = keyof Events

/* -------------------------------------------------------------------------- */
/* Servicos                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Mapa global de servicos injetaveis. Augmentavel: cada pacote host acrescenta
 * a sua costura de capacidade. As chaves aqui presentes tornam-se propriedades
 * de {@link Context} (ex.: `ctx.webServer`, `ctx.subprocess`) porque
 * `interface Context extends Services`.
 */
export interface Services {
  webServer: WebServer
  subprocess: SubprocessService
}

/** Nome de qualquer servico declarado em {@link Services}. */
export type ServiceName = keyof Services

/**
 * Forma aceite por `ctx.intercept`: um objeto parcial cujas chaves sao
 * membros do servico alvo `S`.
 *
 * Cada metodo e aceite em DUAS formas equivalentes (o Cordis liga o servico
 * alvo tanto ao `this` do interceptor como ao primeiro argumento):
 *
 *  1. `metodo(this: S, ...argsOriginais)`  -> usa `this.metodo(...)`
 *  2. `metodo(target: S, ...argsOriginais)` -> usa `target.metodo(...)`
 *
 * Em ambas, o TIPO DE RETORNO continua a ser o do metodo original, o que
 * forca a devolucao do disposer nativo e preserva a reversibilidade.
 *
 * NOTA (explicit > implicit): por o tipo alvo ser uma uniao de assinaturas,
 * os parametros do interceptor TEM de ser anotados explicitamente.
 */
export type InterceptMethods<S> = {
  [K in keyof S]?: S[K] extends (...args: infer A) => infer R
    ? ((this: S, ...args: A) => R) | ((this: S, target: S, ...args: A) => R)
    : S[K]
}

/* -------------------------------------------------------------------------- */
/* Logger                                                                      */
/* -------------------------------------------------------------------------- */

/** Logger com escopo explicito, exposto em `ctx.logger`. */
export interface Logger {
  info(scope: string, message: string, ...rest: unknown[]): void
  warn(scope: string, message: string, ...rest: unknown[]): void
  error(scope: string, message: string, ...rest: unknown[]): void
  debug(scope: string, message: string, ...rest: unknown[]): void
}

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * O contexto partilhado do Cordis. Herda de {@link Services} para que todos os
 * servicos injetados fiquem acessiveis como propriedades tipadas
 * (`ctx.webServer`, `ctx.subprocess`, ...). Como `Services` e augmentavel, o
 * `extends` propaga automaticamente novos servicos para o `Context`.
 */
export interface Context extends Services {
  /** Logger com escopo. */
  logger: Logger

  /**
   * Deriva um contexto cujo servico `name` tem os metodos indicados
   * sobrepostos. E o unico ponto seguro para envolver `registerFallback`
   * ANTES de o `dsh-host-frontend-static` montar o SPA routing.
   *
   * @example
   * ctx.intercept('webServer', {
   *   registerFallback(this: WebServer, originalHandler: WebRoute['handler']) {
   *     return this.registerFallback(secure)
   *   },
   * })
   */
  intercept<K extends ServiceName>(name: K, methods: InterceptMethods<Services[K]>): Context

  /**
   * Despacho *around-middleware*. Cada ouvinte recebe os parametros do evento
   * seguidos do invocador de continuacao `next()`. Omitir `next()` instaura um
   * curto-circuito (veto) irreversivel na cascata.
   */
  waterfall<K extends EventName>(
    name: K,
    ...args: EventArgs<Events[K]>
  ): Promise<Awaited<EventResult<Events[K]>>>

  /**
   * Despacho concorrente: aguarda o retorno exaustivo de TODOS os subscritores.
   * Reter indefinidamente um retorno congela o subsistema envolvido.
   */
  parallel<K extends EventName>(name: K, ...args: EventArgs<Events[K]>): Promise<void>

  /** Subscreve um evento. Devolve o disposer da subscricao. */
  on<K extends EventName>(name: K, listener: Events[K]): Disposer

  /**
   * Encapsula um recurso alocado (processo nativo, observador de ficheiros,
   * agendador) no contexto temporal da Fiber.
   *
   * A funcao produtora tem de devolver um {@link Disposer}, e isso o tipo
   * verifica (uma produtora `async` e rejeitada). Que o proprio disposer seja
   * SINCRONO e exigencia do motor -- precisa de garantir a ordem LIFO de
   * erradicacao sem intercalar microtasks -- mas NAO e verificavel pelo tipo:
   * ver a nota em {@link Disposer}.
   */
  effect(fn: () => Disposer): Disposer

  /** Obtem um servico injetado, ou `undefined` se ainda nao estiver disponivel. */
  get<K extends ServiceName>(name: K): Services[K] | undefined
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Classe base minima para publicar uma nova costura de capacidade em
 * {@link Services}. Registar a instancia sob `name` disponibiliza-a como
 * `ctx[name]` para os plugins que a declararem em `inject`.
 */
export abstract class Service<C extends Context = Context> {
  protected ctx: C
  readonly name: string
  constructor(ctx: C, name: string)
  /** Ciclo de vida: chamado quando a Fiber do servico arranca. */
  start?(): void | Promise<void>
  /** Ciclo de vida: chamado quando a Fiber do servico e descartada. */
  stop?(): void | Promise<void>
}
