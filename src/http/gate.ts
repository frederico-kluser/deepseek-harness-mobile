/**
 * `createGuardedHandler`, `createGuardedUpgradeHandler` -- a POLITICA do portao.
 *
 * Estes dois construtores decidem; nao sabem onde estao instalados. Quem os
 * instala e `src/http/intercept.ts` (dono do despacho do `node:http.Server`).
 * Separar as duas coisas e o que permite testar a decisao sem socket e a
 * mecanica sem credencial.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import type { Config } from '../config/schema.ts'
import type { Context, WebRequestHandler, WebUpgradeHandler } from '../dsh/adapter.ts'
import type { GuardLogger } from '../logging/logger.ts'
import { verifyBasicAuth } from './auth-basic.ts'
import { isTrustedRemote } from './origin.ts'
import { isGuardedPath } from './path.ts'
import { challengeBasicAuth, denyUntrustedOrigin, denyUpgrade } from './responses.ts'

/** Tudo o que o portao precisa de saber, injetado -- nada resolvido por dentro. */
export interface GateDeps {
  readonly ctx: Context
  readonly log: GuardLogger
  readonly config: Config
}

/**
 * Constroi o handler guardado que envolve um despacho original.
 *
 * DECISAO DELIBERADA -- NAO SE CONSOME O CORPO DA REQUISICAO.
 * A decisao de autorizacao usa exclusivamente metodo, URL, cabecalhos e endereco
 * do socket. Ler o corpo para inspecionar o payload RPC obrigaria a consumir o
 * stream; se depois o pedido fosse recusado, a leitura ficaria a meio e o
 * servidor web do DSH fecharia o socket registando um HTTP 400 -- transformando
 * um "401 legivel" num erro opaco. Alem disso, o corpo ja consumido nunca
 * chegaria ao handler original nos pedidos aprovados.
 *
 * @param alwaysGuarded `true` -> a superficie e guardada INTEIRA, decidido na
 * instalacao. Nenhuma inspeccao do `req.url` pode desactivar a barreira: e este
 * o comportamento que ja hoje barra `//api`, `/API` e afins, e nao pode
 * regredir. E o valor com que a barreira de despacho e montada, porque no ponto
 * de despacho nao existe identidade de rota -- so o `req`.
 *
 * `false` -> a barreira aplica-se por PEDIDO, e so aos pedidos cujo caminho real
 * cai sob um prefixo declarado. Mantido porque e a forma que a politica por rota
 * do painel `/__guard` (Onda 3, D5) vai precisar.
 */
export function createGuardedHandler(
  deps: GateDeps,
  delegate: WebRequestHandler,
  surface: string,
  alwaysGuarded: boolean,
): WebRequestHandler {
  const { ctx, log, config } = deps

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // ---- (0) Este pedido esta sob guarda? ---------------------------------
    // Defesa em profundidade sobre o `req.url` REAL e normalizado
    // (percent-decoding, `//`, `\`, `.`/`..`, caixa).
    if (!alwaysGuarded && !isGuardedPath(req.url, config.guardedPrefixes)) {
      await delegate(req, res)
      return
    }

    // ---- (a) Perimetro de rede: quem esta do outro lado do socket? --------
    if (!isTrustedRemote(req.socket.remoteAddress, config.trustedRemotes)) {
      log.warn(
        `[${surface}] Origem nao confiada recusada: ` +
          `${String(req.socket.remoteAddress)} -> ${String(req.method)} ${String(req.url)}`,
      )
      denyUntrustedOrigin(res)
      return
    }

    // ---- (b) Barreira de autenticacao, avaliada em cascata ----------------
    // O `next` terminal repete a verificacao da credencial: assim a politica
    // permanece FAIL-CLOSED mesmo que nenhum ouvinte esteja registado (por
    // exemplo, se outra Fiber tiver removido o nosso).
    const isAuthorized = await ctx.waterfall(
      'http/auth-check',
      req,
      async (): Promise<boolean> =>
        verifyBasicAuth(req.headers.authorization, config.encodedAuthString),
    )

    if (!isAuthorized) {
      log.warn(
        `[${surface}] 401 em ${String(req.method)} ${String(req.url)} ` +
          '(credencial ausente ou invalida).',
      )
      challengeBasicAuth(res, config.realm)
      return
    }

    // ---- (c) Aprovado: o controlo transita para o despacho original -------
    await delegate(req, res)
  }
}

/**
 * Constroi o tratador de upgrade guardado (handshake de WebSocket).
 *
 * PORQUE ESTA SUPERFICIE TAMBEM PRECISA DE PORTAO -- e porque e guardada
 * INTEIRA, sem olhar a `guardedPrefixes`: os WebSockets NAO estao sujeitos a
 * same-origin policy. Qualquer pagina aberta no navegador da maquina pode abrir
 * `ws://127.0.0.1:3080/...` para outra origem sem qualquer permissao (nao ha
 * preflight, nao ha CORS). E o doc-fonte do DSH regista que o canal de downlink
 * foi migrado de SSE para um WebSocket dedicado -- ou seja, o canal e relevante
 * e transporta estado do plano de controlo. Deixa-lo fora do portao seria
 * reabrir a #853 por outra porta.
 *
 * A decisao e a mesma do caminho HTTP (origem -> credencial) e usa exatamente as
 * mesmas primitivas; so a forma de RECUSAR e diferente, porque aqui nao ha
 * `ServerResponse`.
 *
 * NUNCA REJEITA: um erro no caminho de decisao NAO pode resultar em handshake
 * aprovado nem em rejeicao nao capturada no dono do despacho -- fecha-se o
 * socket (fail-closed) e resolve-se.
 */
export function createGuardedUpgradeHandler(
  deps: GateDeps,
  delegate: WebUpgradeHandler,
  surface: string,
): WebUpgradeHandler {
  const { ctx, log, config } = deps

  return async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    try {
      if (!isTrustedRemote(req.socket.remoteAddress, config.trustedRemotes)) {
        log.warn(
          `[${surface}] Upgrade recusado (origem nao confiada): ` +
            `${String(req.socket.remoteAddress)} -> ${String(req.url)}`,
        )
        denyUpgrade(socket, 403, config.realm)
        return
      }

      const isAuthorized = await ctx.waterfall(
        'http/auth-check',
        req,
        async (): Promise<boolean> =>
          verifyBasicAuth(req.headers.authorization, config.encodedAuthString),
      )

      if (!isAuthorized) {
        log.warn(
          `[${surface}] Upgrade recusado (credencial ausente ou invalida) em ` +
            `${String(req.url)}.`,
        )
        denyUpgrade(socket, 401, config.realm)
        return
      }

      await delegate(req, socket, head)
    } catch (error) {
      log.error(
        `[${surface}] Erro ao avaliar o upgrade; socket destruido: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      socket.destroy()
    }
  }
}
