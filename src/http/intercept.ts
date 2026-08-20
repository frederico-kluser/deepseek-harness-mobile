/**
 * =============================================================================
 * A BARREIRA: troca de dono do despacho no `node:http.Server` do `webServer`.
 * =============================================================================
 *
 * PORQUE NAO `ctx.intercept('webServer', { register, registerFallback, ... })`,
 * que era o que este ficheiro deveria fiar segundo o plano: porque
 * `ctx.intercept` NAO envolve metodos de servico. O corpo publicado
 * (`cordis@4.0.1`, `src/context.ts:141-145`) e
 *
 *     intercept(name, config) {
 *       const intercept = Object.create(this[symbols.intercept])
 *       intercept[name] = config
 *       return this.extend({ [symbols.intercept]: intercept })
 *     }
 *
 * -- FUSAO DE CONFIGURACAO por servico, herdada pelos plugins carregados abaixo.
 * A sobrecarga `intercept(name: string, config: any): this` fazia a chamada
 * errada COMPILAR EM SILENCIO. Pior: `grep -c resolveConfig` no `lib/index.js`
 * publicado do `webServer` devolve 0 -- para este servico a config de intercept
 * e inerte ate como config. Medido: passou-se um `register` que lanca se for
 * chamado; nunca e chamado, e `/api/state` responde 200.
 *
 * O MECANISMO QUE FUNCIONA (S12, medido: 35 assercoes, 7 rotas reais
 * 200 -> 401 -> 200 atraves do disposer; referencia executavel em
 * `scripts/spike/intercept/barreira.mjs`):
 *
 *   1. resolver o `node:http.Server` interno (`src/dsh/adapter.ts`);
 *   2. capturar `listeners('request')` e `listeners('upgrade')`;
 *   3. `removeAllListeners` e instalar UM listener de cada que DECIDE e so entao
 *      DELEGA aos capturados;
 *   4. disposer SINCRONO que reinstala exatamente os originais.
 *
 * PORQUE COBRE OS TRES CAMINHOS: o roteador do `WebServer` (`match()` ->
 * `fallback`) e a tabela de `upgrades` vivem TODOS por baixo destes dois
 * listeners. Guardar o listener guarda `register` (exact e prefix),
 * `registerFallback` e `registerUpgrade` de uma so vez, sem conhecer rota
 * nenhuma -- e por isso guarda tambem as rotas registadas DEPOIS da instalacao.
 *
 * PORQUE NAO HA EXIGENCIA DE ORDEM DE CARREGAMENTO: o `EventEmitter` resolve a
 * lista de listeners a CADA evento e as rotas vivem nas tabelas por baixo.
 * Instalar depois de toda a gente ja ter registado funciona na mesma. Isso
 * importa porque `dsh-base@0.1.0-rc.7/cordis.patch.yml:12-13` diz literalmente
 * "Row order carries no load semantics".
 *
 * PORQUE NAO `prependListener`: o `EventEmitter` do Node NAO TEM VETO -- um
 * listener prepended corre primeiro mas nao impede os seguintes. Para BLOQUEAR e
 * preciso ser o dono do despacho.
 * =============================================================================
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import type { WebRequestHandler, WebUpgradeHandler } from '../dsh/adapter.ts'
import { GuardError } from '../errors.ts'
import type { GuardLogger } from '../logging/logger.ts'

/**
 * Marca de posse gravada nos listeners instalados.
 *
 * `Symbol.for` (registo global) e nao `Symbol()`: duas copias deste modulo
 * carregadas por caminhos diferentes tem de reconhecer a marca uma da outra --
 * caso contrario a recusa de empilhamento nao funciona exatamente no cenario em
 * que e precisa.
 */
export const BARRIER_OWNER_MARK = Symbol.for('dsh-guard.barreira.dono')

/** Os dois envelopes de politica que a barreira instala. */
export interface BarrierWrappers {
  /** Recebe o despacho original de `request` e devolve o despacho guardado. */
  wrapRequest(delegate: WebRequestHandler): WebRequestHandler
  /** Recebe o despacho original de `upgrade` e devolve o despacho guardado. */
  wrapUpgrade(delegate: WebUpgradeHandler): WebUpgradeHandler
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void
type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

function isOwnedByBarrier(listener: unknown): boolean {
  return (listener as Record<symbol, unknown> | null)?.[BARRIER_OWNER_MARK] === true
}

function markAsOwned<T extends object>(listener: T): T {
  Object.defineProperty(listener, BARRIER_OWNER_MARK, { value: true })
  return listener
}

/**
 * Instala a barreira. SINCRONA, e o disposer devolvido tambem e sincrono.
 *
 * REGRA Q-2 vs. o host: `Fiber.effect` documenta que os disposers "may be async,
 * in which case unloading awaits them". Este projeto NAO usa essa tolerancia --
 * o disposer e sincrono por regra (05-QUALIDADE-CODIGO.md Q-2), porque a ordem
 * LIFO sem intercalar microtasks e o que impede uma Fiber PENDING de instalar
 * uma segunda barreira antes de a primeira ter saido. A divergencia esta
 * registada, nao silenciada.
 *
 * @throws {GuardError} `BARRIER_UNAVAILABLE` se o servidor nao tiver despacho de
 * `request` (o `WebServer` ainda nao inicializou) -- nunca degradar para "sem
 * barreira".
 * @throws {GuardError} `BARRIER_ALREADY_INSTALLED` se ja houver uma barreira.
 */
export function installAuthBarrier(
  server: Server,
  wrappers: BarrierWrappers,
  log: GuardLogger,
): () => void {
  const originalRequest = server.listeners('request') as RequestListener[]
  const originalUpgrade = server.listeners('upgrade') as UpgradeListener[]

  if (originalRequest.length === 0) {
    throw new GuardError(
      'BARRIER_UNAVAILABLE',
      'o node:http.Server nao tem listener `request` -- o WebServer ainda nao inicializou. ' +
        'Instalar a barreira aqui deixaria o despacho original a descoberto quando ele chegasse.',
    )
  }

  /**
   * RECUSA DE EMPILHAMENTO. Duas barreiras de Fibers distintas podem ser
   * dispostas fora de ordem LIFO; a reversao da primeira reinstalaria o despacho
   * original a correr EM PARALELO com a segunda. O resultado medido nao e so "a
   * barreira desapareceu": e dupla escrita no mesmo `res`, que levanta um
   * `ERR_HTTP_HEADERS_SENT` NAO CAPTURAVEL pelo cliente e derruba o processo.
   * Recusar na INSTALACAO fecha a classe inteira do problema.
   */
  for (const listener of [...originalRequest, ...originalUpgrade]) {
    if (isOwnedByBarrier(listener)) {
      throw new GuardError(
        'BARRIER_ALREADY_INSTALLED',
        'ja existe uma barreira instalada neste node:http.Server. Empilhar duas e recusado ' +
          'porque uma reversao fora de ordem LIFO reinstalaria o despacho original em ' +
          'paralelo com a barreira de cima (dupla resposta ao mesmo `res`).',
      )
    }
  }

  /** Fail-closed do caminho HTTP: nenhuma excecao pode virar pedido servido. */
  const failClosedHttp = (res: ServerResponse, error: unknown): void => {
    log.error(
      'Falha nao tratada no despacho guardado; pedido recusado: ' +
        `${error instanceof Error ? error.message : String(error)}`,
    )
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('Acesso Intercetado: falha interna do portao.\n')
  }

  const guardedRequest = wrappers.wrapRequest((req, res) => {
    for (const listener of originalRequest) listener.call(server, req, res)
  })

  /**
   * O listener instalado e SINCRONO por assinatura (`'request'` do
   * `EventEmitter` ignora o retorno), mas a politica e assincrona. Uma promessa
   * rejeitada aqui seria uma `unhandledRejection` -- no Node 24 isso derruba o
   * processo hospedeiro. Absorve-se e fecha-se.
   */
  const onRequest: RequestListener = (req, res) => {
    let outcome: void | Promise<void>
    try {
      outcome = guardedRequest(req, res)
    } catch (error) {
      failClosedHttp(res, error)
      return
    }
    if (outcome instanceof Promise) {
      void outcome.catch((error: unknown) => {
        failClosedHttp(res, error)
      })
    }
  }

  /**
   * O listener de `upgrade` so entra se JA EXISTIA algum. Medido no Node 24: um
   * servidor com ZERO listeners de `upgrade` NAO destroi o socket -- o pedido
   * cai no caminho `request` (que a barreira ja guarda). Instalar um listener
   * onde nao havia nenhum mudaria a semantica do servidor e, pior, um upgrade
   * AUTORIZADO seria delegado a uma lista vazia e ficaria pendurado.
   */
  const guardsUpgrade = originalUpgrade.length > 0

  const guardedUpgrade = guardsUpgrade
    ? wrappers.wrapUpgrade((req, socket, head) => {
        for (const listener of originalUpgrade) listener.call(server, req, socket, head)
      })
    : undefined

  const onUpgrade: UpgradeListener | undefined =
    guardedUpgrade === undefined
      ? undefined
      : (req, socket, head) => {
          let outcome: void | Promise<void>
          try {
            outcome = guardedUpgrade(req, socket, head)
          } catch {
            socket.destroy()
            return
          }
          if (outcome instanceof Promise) {
            void outcome.catch(() => {
              socket.destroy()
            })
          }
        }

  markAsOwned(onRequest)
  if (onUpgrade !== undefined) markAsOwned(onUpgrade)

  server.removeAllListeners('request')
  server.on('request', onRequest)

  if (onUpgrade !== undefined) {
    server.removeAllListeners('upgrade')
    server.on('upgrade', onUpgrade)
  }

  log.info(
    `Barreira instalada no despacho: request(${originalRequest.length} originais), ` +
      `upgrade(${guardsUpgrade ? `${originalUpgrade.length} originais` : 'nao existia, nao instalado'}).`,
  )

  let reverted = false

  return (): void => {
    if (reverted) return
    reverted = true

    /**
     * VERIFICACAO DE POSSE. So se restaura se o despacho ainda for nosso. Se
     * outro dono tomou conta entretanto, reinstalar os originais poria dois
     * despachos a responder ao mesmo `res`. Nesse caso remove-se apenas o que e
     * nosso e FALHA-SE ALTO -- uma resposta duplicada e pior do que um erro
     * visivel.
     */
    const nowRequest = server.listeners('request')
    const nowUpgrade = onUpgrade === undefined ? [] : server.listeners('upgrade')
    const stillOursRequest = nowRequest.length === 1 && nowRequest[0] === onRequest
    const stillOursUpgrade =
      onUpgrade === undefined || (nowUpgrade.length === 1 && nowUpgrade[0] === onUpgrade)

    server.removeListener('request', onRequest)
    if (onUpgrade !== undefined) server.removeListener('upgrade', onUpgrade)

    if (!stillOursRequest || !stillOursUpgrade) {
      const failure = new GuardError(
        'BARRIER_OWNERSHIP_LOST',
        'o despacho ja nao era nosso no momento da reversao ' +
          `(listeners request=${nowRequest.length}, upgrade=${nowUpgrade.length}). ` +
          'Os listeners originais NAO foram reinstalados, para nao duplicar o despacho.',
      )
      // Regista ANTES de lancar: um disposer que lanca interrompe a cadeia de
      // teardown da Fiber, e os disposers ainda por correr nunca chegariam a
      // reportar nada. A mensagem tem de chegar ao operador mesmo assim.
      log.error(failure.message)
      throw failure
    }

    for (const listener of originalRequest) server.on('request', listener)
    if (onUpgrade !== undefined) {
      for (const listener of originalUpgrade) server.on('upgrade', listener)
    }
  }
}
