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
import { type IncomingMessage, type Server } from 'node:http';
import type { Config } from '../config/schema.ts';
import type { Context } from '../dsh/adapter.ts';
import type { GuardLogger } from '../logging/logger.ts';
import type { GateAuth, TunnelOriginRegistry } from '../http/session-auth.ts';
import type { LinkTokenStore } from '../session/link-token.ts';
/** O que o proxy precisa de saber; a politica vem de `gate.ts`. */
export interface TunnelProxyDeps {
    readonly ctx: Context;
    readonly log: GuardLogger;
    readonly config: Config;
    /** A pilha de autenticacao (sessoes, segredo, restrito, auditoria). */
    readonly auth: () => GateAuth;
    /** A origem publica do tunel (allowlist de `Host`/`Origin`). */
    readonly tunnelOrigin: Pick<TunnelOriginRegistry, 'current'>;
    /** A chave no link, validada pelo proxy (onda 1). */
    readonly linkToken: Pick<LinkTokenStore, 'verificar'>;
    /**
     * Emite uma sessao para o request (regenerate + cookie) e devolve a linha
     * `Set-Cookie`, ou `null` se a origem nao entregar cookie `Secure`.
     */
    readonly issueSession: (req: IncomingMessage, presentedSessionId: string | undefined) => string | null;
    /** Porta do UPSTREAM (o servidor do DSH). O proxy reescreve para ela. */
    readonly upstreamPort: number;
}
export interface TunnelProxy {
    /** O `node:http.Server` do proxy, em escuta em `127.0.0.1`. */
    readonly server: Server;
    /**
     * Sockets ativos do lado cliente do proxy (HTTP e WebSocket `upgraded`).
     * ADITIVO/observabilidade: e a fonte da contagem de `conexoesAtivas` do
     * painel de acesso (GET /__guard-ui/api/access).
     */
    get conexoesAtivas(): number;
    /**
     * Destroi TODAS as conexoes do lado cliente do proxy (sockets HTTP e
     * WebSocket `upgraded`) SEM derrubar o listener — o tunel continua de pe.
     * Idempotente, sincrono, nunca lanca. Usado pelo `/rotacionar` para encerrar
     * as conexoes JA ESTABELECIDAS sob o acesso antigo (fail-closed: a autenticacao
     * ja caiu, logo nada que continue ligado pode virar uma sessao reutilizavel).
     */
    encerrarConexoesAtivas(): void;
    /** Disposer SINCRONO e idempotente (Q-2). */
    dispose(): void;
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
export declare function createTunnelProxy(deps: TunnelProxyDeps): TunnelProxy;
//# sourceMappingURL=proxy.d.ts.map