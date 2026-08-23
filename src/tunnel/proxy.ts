/**
 * =============================================================================
 * O PROXY DO TUNEL -- a superficie guardada do modelo expose-port.
 * =============================================================================
 *
 * ONDA 1 (remocao do login) -> MODELO EXPOSE-PORT (correccao do BLOCK).
 *
 * Antes: o portao envolvia o `node:http.Server` do DSH e decidia "abrir" por
 * `Host` de loopback. Isso era FORJAVEL: um pedido pelo cloudflared (socket
 * `127.0.0.1`, que e trustedRemote) com `Host: 127.0.0.1:3080` passava L2/L2.5
 * e a regra "local" delegava -- 200 sem credencial, expondo ate o
 * `/__guard/secret` pela internet.
 *
 * Agora, o servidor do DSH (upstream) fica ABERTO e SEM gate do plugin; o
 * guarda e este PROXY, um `node:http.Server` PROPRIO em `127.0.0.1:<porta>`.
 * O `cloudflared --url` aponta PARA ESTA porta (o supervisor passa este
 * servidor como `origin`), nunca para o upstream. Todo o request que chega ao
 * proxy veio, por definicao, do tunel -- por isso NENHUM `Host` (nem
 * `127.0.0.1:3080` forjado) dispensa autenticacao.
 *
 * REGRAS (fechadas):
 *   1. `?key=<token>` valido (timing-safe, reutilizavel ate `revogar()`) em GET
 *      -> 302 para a URL LIMPA (sem `key`) + `Set-Cookie` de sessao. A URL de
 *      destino limpa NUNCA leva `key` (HIGH #2: a chave nao viaja no log).
 *   2. sessao valida -> encaminha (reverse-proxy) para o upstream, com `Host`
 *      reescrito e `origin`/`sec-fetch-*` apagados (a cerca do nucleo).
 *   3. mais nada (incluindo QUALQUER Host) -> 401 TEXTO PURO, SEM
 *      `WWW-Authenticate`, SEM delegar.
 *   4. `WebSocket` upgrade: so com sessao; sem sessao, recusa 401 sem desafio.
 *
 * A politica do request/upgrade (sessao-ou-chave, auditoria, modo restrito) e
 * a de `createGuardedHandler`/`createGuardedUpgradeHandler` (`src/http/gate.ts`),
 * com o branch "local abre" REMOVIDO -- o proxy exige autenticacao para tudo.
 * O delegate de sucesso aqui e um REVERSE-PROXY para o upstream.
 * =============================================================================
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import type { Config } from '../config/schema.ts'
import type { Context } from '../dsh/adapter.ts'
import type { GuardLogger } from '../logging/logger.ts'
import type { GateAuth, TunnelOriginRegistry } from '../http/session-auth.ts'
import type { LinkTokenStore } from '../session/link-token.ts'
import { createGuardedHandler, createGuardedUpgradeHandler, type GateDeps } from '../http/gate.ts'

const PROXY_HOST = '127.0.0.1'

/** O que o proxy precisa de saber; a politica vem de `gate.ts`. */
export interface TunnelProxyDeps {
  readonly ctx: Context
  readonly log: GuardLogger
  readonly config: Config
  /** A pilha de autenticacao (sessoes, segredo, restrito, auditoria). */
  readonly auth: () => GateAuth
  /** A origem publica do tunel (allowlist de `Host`/`Origin`). */
  readonly tunnelOrigin: Pick<TunnelOriginRegistry, 'current'>
  /** A chave no link, validada pelo proxy (onda 1). */
  readonly linkToken: Pick<LinkTokenStore, 'verificar'>
  /**
   * Emite uma sessao para o request (regenerate + cookie) e devolve a linha
   * `Set-Cookie`, ou `null` se a origem nao entregar cookie `Secure`.
   */
  readonly issueSession: (req: IncomingMessage, presentedSessionId: string | undefined) => string | null
  /** Porta do UPSTREAM (o servidor do DSH). O proxy reescreve para ela. */
  readonly upstreamPort: number
}

export interface TunnelProxy {
  /** O `node:http.Server` do proxy, em escuta em `127.0.0.1`. */
  readonly server: Server
  /**
   * Sockets ativos do lado cliente do proxy (HTTP e WebSocket `upgraded`).
   * ADITIVO/observabilidade: e a fonte da contagem de `conexoesAtivas` do
   * painel de acesso (GET /__guard-ui/api/access).
   */
  get conexoesAtivas(): number
  /**
   * Destroi TODAS as conexoes do lado cliente do proxy (sockets HTTP e
   * WebSocket `upgraded`) SEM derrubar o listener — o tunel continua de pe.
   * Idempotente, sincrono, nunca lanca. Usado pelo `/rotacionar` para encerrar
   * as conexoes JA ESTABELECIDAS sob o acesso antigo (fail-closed: a autenticacao
   * ja caiu, logo nada que continue ligado pode virar uma sessao reutilizavel).
   */
  encerrarConexoesAtivas(): void
  /** Disposer SINCRONO e idempotente (Q-2). */
  dispose(): void
}

/** A autoridade do upstream (`127.0.0.1:<porta>`), o `Host` reescrito. */
function upstreamAuthority(port: number): string {
  return `${PROXY_HOST}:${String(port)}`
}

/**
 * Encaminha um pedido HTTP autorizado para o upstream.
 *
 * Reescreve `Host` para a autoridade do upstream e apaga as cabecas da cerca
 * de borda do nucleo (`origin`, `sec-fetch-*`) -- o mesmo contrato de
 * `rewriteAuthenticatedTunnelRequest`. O corpo e piped; a resposta e piped de
 * volta. NUNCA lanca ao chamador: um erro de ligacao vira 502.
 */
function reverseProxyRequest(
  upstreamPort: number,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res): void => {
    const headers: Record<string, string | string[] | number | undefined> = { ...req.headers }
    headers['host'] = upstreamAuthority(upstreamPort)
    for (const apagado of ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) {
      delete headers[apagado]
    }
    delete headers['connection']

    const proxy = httpRequest(
      {
        host: PROXY_HOST,
        port: upstreamPort,
        path: req.url ?? '/',
        method: req.method ?? 'GET',
        headers,
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(res)
      },
    )
    proxy.on('error', (): void => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end()
    })
    req.pipe(proxy)
  }
}

/**
 * Encaminha um handshake de WebSocket autorizado para o upstream.
 *
 * `http.request` com `Connection: Upgrade` dispara o evento `upgrade` do lado
 * do cliente; os sockets dos dois lados sao ligados bidirecionalmente. Um erro
 * de ligacao destroi o socket (fail-closed). O proxy nunca responde com um
 * handshake proprio -- so medeia os bytes.
 */
function reverseProxyUpgrade(
  upstreamPort: number,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head): void => {
    const headers: Record<string, string | string[] | number | undefined> = { ...req.headers }
    headers['host'] = upstreamAuthority(upstreamPort)
    headers['connection'] = 'Upgrade'
    headers['upgrade'] = typeof req.headers.upgrade === 'string' ? req.headers.upgrade : 'websocket'
    for (const apagado of ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) {
      delete headers[apagado]
    }

    const proxy = httpRequest({
      host: PROXY_HOST,
      port: upstreamPort,
      path: req.url ?? '/',
      method: req.method ?? 'GET',
      headers,
    })
    proxy.on('upgrade', (upstreamRes, upSocket, upHead): void => {
      // Re-escreve o 101 do upstream para o cliente (o parser do `http.request`
      // consumiu a linha de estado; so o `head` pos-cabecalhos chega aqui).
      const linha = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${
        (upstreamRes.statusCode ?? 101) === 101 ? 'Switching Protocols' : 'Upgrade'
      }\r\n`
      const cab = (Object.entries(upstreamRes.headers) as Array<[string, unknown]>)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
        .join('\r\n')
      socket.write(`${linha}${cab}\r\n\r\n`)
      if (upHead.byteLength > 0) socket.write(upHead)
      if (head.byteLength > 0) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    proxy.on('error', (): void => {
      socket.destroy()
    })
    proxy.end()
  }
}

/**
 * Cria o proxy e poe-o em escuta numa PORTA DEDICADA, com a politica de
 * sessao-ou-chave de `gate.ts` instalada sobre o reverse-proxy.
 *
 * O `server` esta em escuta quando a promessa resolve; o `port` e o alvo do
 * `cloudflared --url`. `dispose()` desliga o listener e fecha os sockets.
 */
/**
 * Cria o proxy e poe-o em escuta numa PORTA DEDICADA, com a politica de
 * sessao-ou-chave de `gate.ts` instalada sobre o reverse-proxy.
 *
 * SINCRONA: o `server` volta logo a escutar (`.listen(0)` nao espera) e a porta
 * e descoberta por `server.address()` quando o supervisor precisar (T3.1
 * verifica `server.listening` antes de lancar o tunel). `dispose()` desliga o
 * listener e fecha os sockets.
 */
export function createTunnelProxy(deps: TunnelProxyDeps): TunnelProxy {
  const gateRequest = createGuardedHandler(proxyGateDeps(deps), reverseProxyRequest(deps.upstreamPort), 'proxy:request')
  const gateUpgrade = createGuardedUpgradeHandler(proxyGateDeps(deps), reverseProxyUpgrade(deps.upstreamPort), 'proxy:upgrade')

  const server = createServer()
  // `createServer()` devolve a instancia; os handlers fecham sobre os delegates
  // do reverse-proxy (ja guardados pelas politicas acima). Envolvidos em
  // listeners void-return: a politica do gate e async e o EventEmitter espera
  // `void` -- a Promise e drenada com `void`.
  server.on('request', (req, res) => {
    void gateRequest(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    void gateUpgrade(req, socket, head)
  })

  // Rastreia TODAS as conexoes do lado cliente do proxy (unicamente no evento
  // `connection` do servidor: sockets keep-alive reutilizados nao emitem novos
  // requests mas continuam a ser a MESMA conexao). E este Set que o rotate usa
  // para encerrar as conexoes JA ESTABELECIDAS sob o acesso antigo — o
  // `closeAllConnections()` do Node NAO fecha sockets `upgraded` (WebSocket
  // `101`), daí o rastreio manual ser obrigatorio.
  const conexoesAtivas = new Set<Duplex>()
  server.on('connection', (socket: Duplex) => {
    conexoesAtivas.add(socket)
    socket.once('close', () => {
      conexoesAtivas.delete(socket)
    })
  })

  // Seta o erro de escuta no log: um proxy que nao sobe nao deve derrubar o
  // host, mas tem de ser visivel (o tunel sem guarda seria um buraco).
  server.on('error', (error: Error) => {
    deps.log.error(
      `proxy do tunel: erro de escuta no loopback: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  server.listen(0, PROXY_HOST)

  return {
    server,
    get conexoesAtivas(): number {
      return conexoesAtivas.size
    },
    encerrarConexoesAtivas(): void {
      // Sincrono e idempotente (Q-2). NUNCA derruba o listener (o tunel fica de
      // pe: o proxy continua a aceitar novas ligacoes com as credenciais novas).
      // NUNCA usa `server.close()` — isso desligaria o listener.
      //
      // `closeAllConnections()` foi RETIRADO DAQUI (Node v24.19.0 medido): apos
      // QUALQUER request HTTP normal atravessar o proxy, `closeAllConnections`
      // derruba o listener para requests HTTP NOVOS (o request seguinte recebe
      // ECONNRESET). O rastreio manual (o Set abaixo, povoado em
      // `server.on('connection')` e alimentado pelo `connection` do servidor)
      // cobre TODOS os sockets aceites — HTTP keep-alive e WebSocket `upgraded`
      // incluidos — pelo que o `socket.destroy()` de cada um e suficiente e e o
      // que garante o contrato.
      for (const socket of conexoesAtivas) {
        if (!socket.destroyed) socket.destroy()
      }
      conexoesAtivas.clear()
    },
    dispose(): void {
      // Sincrono e idempotente (Q-2). `close()` deixa de aceitar; o
      // `closeAllConnections` termina os sockets activos.
      if (!server.listening && server.listenerCount('request') === 0) return
      server.close()
      ;(server as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
    },
  }
}

/** Monta o handler de request guardado sobre o reverse-proxy. */

/** Constroi a politica do portao para a superficie do proxy. */
function proxyGateDeps(deps: TunnelProxyDeps): GateDeps {
  // A `loopbackAuthority` do proxy: um pedido do tunel vem com o `Host` do nome
  // publico e a reescrita leva-o para o proxy (o reverse-proxy reescreve depois
  // para o upstream).
  const authority = `${PROXY_HOST}:0`
  return {
    ctx: deps.ctx,
    log: deps.log,
    config: deps.config,
    auth: deps.auth,
    tunnelOrigin: deps.tunnelOrigin,
    bindHost: PROXY_HOST,
    loopbackAuthority: authority,
    // Sem canal-local-apenas nem isencoes no proxy: TUDO exige sessao ou chave.
    loopbackOnlyPrefixes: [] as readonly string[],
    unauthenticatedPrefixes: [] as readonly string[],
    linkToken: deps.linkToken,
    issueSession: deps.issueSession,
  }
}