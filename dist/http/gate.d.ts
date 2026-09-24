/**
 * =============================================================================
 * `createGuardedHandler`, `createGuardedUpgradeHandler` -- a POLITICA do portao.
 * =============================================================================
 *
 * Estes dois construtores decidem; nao sabem onde estao instalados. Quem os
 * instala e `src/http/intercept.ts` (dono do despacho do `node:http.Server`).
 * Separar as duas coisas e o que permite testar a decisao sem socket e a
 * mecanica sem credencial.
 *
 * -----------------------------------------------------------------------------
 * A ORDEM DAS VERIFICACOES E CONTRATO. INVERTE-LA E REGRESSAO DE SEGURANCA.
 * -----------------------------------------------------------------------------
 *
 *   L2   `trustedRemotes`  -> 403  quem esta do outro lado do socket
 *   L2.5 `Host`            -> 403  por que NOME o recurso foi pedido
 *   L3   sessao/credencial -> 401  quem e
 *
 * Os dois codigos NAO sao intermutaveis, e a diferenca e semantica:
 *
 *   - 403 diz "repetir a credencial NAO ajuda": o pedido nunca chega a
 *     autenticacao. Devolver 401 aqui daria ao atacante um oraculo para
 *     adivinhar credenciais a partir de uma origem que nunca sera aceite;
 *   - 401 diz "identifica-te", e vem com o desafio `WWW-Authenticate`.
 *
 * >>> COM SESSAO ATIVA, `trustedRemotes` CONTINUA A SER AVALIADO ANTES. <<<
 * A sessao e verificada em L3, depois de L2 e de L2.5. Se um cookie valido
 * pudesse curto-circuitar L2, um portador vindo de uma origem recusada passaria
 * a receber 401 em vez de 403 -- e a ordem 403-antes-de-401 perder-se-ia sem que
 * nenhum teste de credencial acusasse.
 *
 * >>> OS DOIS 403 SAO BYTE A BYTE IGUAIS, e isso e deliberado. <<<
 * `denyUntrustedOrigin` e usado tanto para a origem do socket como para o
 * `Host`: distinguir os dois diria ao atacante QUAL das duas camadas o barrou, e
 * portanto qual delas vale a pena atacar a seguir.
 *
 * -----------------------------------------------------------------------------
 * O CORPO DA REQUISICAO NAO E LIDO. NUNCA.
 * -----------------------------------------------------------------------------
 * A decisao usa exclusivamente metodo, URL, cabecalhos e endereco do socket. O
 * comando perigoso viaja no corpo do `POST /api/commands/execute`; ler o corpo
 * no caminho de decisao introduziria consumo de stream, buffering e uma
 * superficie de negacao de servico no ponto exato onde nao pode haver nenhuma.
 * E, num pedido aprovado, o corpo ja consumido nunca chegaria ao despacho
 * original -- o servidor do DSH fecharia o socket com um HTTP 400 opaco.
 * =============================================================================
 */
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config/schema.ts';
import type { Context, WebRequestHandler, WebUpgradeHandler } from '../dsh/adapter.ts';
import type { GuardLogger } from '../logging/logger.ts';
import { type GateAuth, type TunnelOriginRegistry } from './session-auth.ts';
import type { LinkTokenStore } from '../session/link-token.ts';
/** Tudo o que o portao precisa de saber, injetado -- nada resolvido por dentro. */
export interface GateDeps {
    readonly ctx: Context;
    readonly log: GuardLogger;
    readonly config: Config;
    /**
     * As primitivas da Onda 2, obtidas SOB PROCURA.
     *
     * PORQUE UM THUNK E NAO O OBJETO: montar a pilha ABRE FICHEIROS (o
     * `state.json` e o `audit.log`). Faze-lo em `apply()` significaria que
     * carregar o plugin -- num harness que talvez nunca sirva um pedido -- criava
     * ficheiros na casa do operador. O thunk e MEMOIZADO por quem o fornece: a
     * pilha e montada uma vez, no primeiro pedido que precisa de decidir.
     *
     * SE LANCAR, O PORTAO NEGA. Nunca "serve sem portao": ver o `catch` do
     * caminho de decisao.
     */
    readonly auth: () => GateAuth;
    /** Leitura da origem publica do tunel. Barata e sem I/O -- por isso nao e thunk. */
    readonly tunnelOrigin: Pick<TunnelOriginRegistry, 'current'>;
    /** `ctx.webServer.host` -- o endereco por que este servidor responde de facto. */
    readonly bindHost: string;
    /** `host:porta` do bind. Destino da reescrita de `Host` dos pedidos do tunel. */
    readonly loopbackAuthority: string;
    /**
     * Prefixos de CANAL LOCAL APENAS -- recusados com 404 quando o pedido nao
     * chegou por um nome de loopback.
     *
     * ===========================================================================
     * L2.6. EXISTE PORQUE L2 E L2.5 NAO SEPARAM O LOCAL DO REMOTO SOB TUNEL.
     * ===========================================================================
     * O raciocinio que faltava, e que custou um furo real nesta entrega: eu tinha
     * escrito que a isencao de credencial era segura porque "L2 (`trustedRemotes`)
     * e L2.5 (`Host`) continuam a correr". O raciocinio esta certo; a PREMISSA e
     * que estava errada. Sob `cloudflared`, um pedido vindo da internet:
     *
     *   - passa L2, porque quem abre o socket e o `cloudflared`, em `127.0.0.1`;
     *   - passa L2.5, porque a origem do tunel e DELIBERADAMENTE acrescentada a
     *     allowlist de `Host` enquanto ele esta `READY`.
     *
     * As duas camadas defendem de outros processos locais e de DNS rebinding.
     * Nao defendem da internet que o tunel deixa entrar de proposito -- e nao e
     * suposto defenderem. Uma rota "canal local apenas" precisa da sua propria
     * pergunta, e e {@link isLoopbackRequestHost} que a faz.
     *
     * O CASO CONCRETO e `GET /__guard/secret?ott=...`, que entrega o SEGREDO
     * PERSISTENTE em texto claro. `02-SEGURANCA.md` 4.4 e literal:
     * **"Canal local apenas, sem excecao"**, e escreve o endereco com
     * `127.0.0.1`. Nao e ilustracao, e o controlo. O `ott` tem 128 bits, uso
     * unico e 10 minutos -- forca bruta e inviavel --, mas ele e impresso no
     * STDOUT DO TERMINAL: vive em scrollback, em multiplexador, em gravacao de
     * sessao, em captura de ecra. O desenho tolera isso PORQUE a rota so e
     * alcancavel de quem ja esta na maquina. Alcancavel da internet, todo o peso
     * passava para um segredo de 10 minutos que nunca foi desenhado para o
     * carregar sozinho.
     *
     * A RECUSA E 404, NUNCA 403. Um 403 anunciava duas coisas de uma vez: que a
     * rota EXISTE e que o pedido chegou do sitio errado. O 404 sai por
     * {@link denyNotFound}, que e a MESMA funcao que a rota usa para um `ott`
     * invalido -- e e por ser a mesma funcao que os bytes nao podem divergir.
     *
     * ISTO CORRE ANTES DA ISENCAO, e portanto vale tanto para rotas isentas de
     * credencial como para rotas guardadas. Corre nas DUAS superficies -- request
     * e upgrade --, mas a forma de recusar difere e a diferenca esta justificada
     * no proprio ponto: 404 no request (onde ha isencoes e um 403 confirmaria a
     * rota), 401 no upgrade (onde 401 ja e a resposta universal e qualquer outro
     * codigo criaria um sinal novo).
     */
    readonly loopbackOnlyPrefixes: readonly string[];
    /**
     * Prefixos que o portao deixa passar SEM CREDENCIAL.
     *
     * ---------------------------------------------------------------------------
     * SUBSTITUI O PARAMETRO `alwaysGuarded`, QUE ERA DORMENTE (decisao declarada)
     * ---------------------------------------------------------------------------
     * `createGuardedHandler` recebia um booleano `alwaysGuarded` que a raiz de
     * composicao passava sempre como `true` literal, e NENHUMA chave de
     * configuracao o podia mudar. Um controlo que PARECE configuravel e nao e, e
     * pior do que nao existir: um leitor conclui que ha uma politica por rota que
     * nao ha. Foi REMOVIDO.
     *
     * O que existe no lugar e a necessidade REAL que ele fingia servir: o painel
     * `/__guard` precisa de UMA porta sem credencial, senao nunca ha como
     * autenticar -- `POST /__guard/api/login` e o passo que CRIA a sessao. Esta
     * lista e essa porta, e nada mais.
     *
     * A comparacao e por SEGMENTO (`isGuardedPath`, ja canonicalizado): `/x/login`
     * cobre `/x/login` e `/x/login/passo2`, mas NAO cobre `/x/loginX`. A isencao
     * dispensa L3 -- L2, L2.5 e L2.6 continuam a correr.
     *
     * >>> CUIDADO COM A PREMISSA, que ja falhou uma vez. <<< "L2 e L2.5 continuam
     * a correr" NAO significa "isto so e alcancavel localmente": sob tunel elas
     * passam as duas, por desenho. Uma rota isenta de credencial e alcancavel da
     * INTERNET enquanto o tunel estiver de pe. As duas que aqui estao aguentam-no
     * -- `/__guard/magic` existe precisamente para ser aberto do telemovel pelo
     * tunel, e `/__guard/api/login` TEM de ser alcancavel de fora ou nao ha como
     * autenticar. Uma rota que NAO aguente pertence a
     * {@link GateDeps.loopbackOnlyPrefixes}, e nao a esta lista.
     */
    readonly unauthenticatedPrefixes: readonly string[];
    /**
     * A CHAVE NO LINK (`?key=<token>`), validada por este store.
     *
     * Onda 1 (remocao do login): o acesso pelo TUNEL entra por SESSAO ou por
     * esta chave; a chave em si NAO da acesso -- validar aqui e trocar por uma
     * sessao (`issueSession`, mais abaixo), que e como o navegador passa a
     * estar autenticado. `emitir()` e dono da Onda 2 (o bot compoe a URL).
     */
    readonly linkToken: Pick<LinkTokenStore, 'verificar'>;
    /**
     * Emite uma sessao para um request e devolve a linha `Set-Cookie`, ou
     * `null` se a origem NAO entregar cookie `Secure` (ex.: LAN em `http`).
     *
     * E o caminho obrigatorio do fluxo `?key=` do portao: uma chave VALIDA e a
     * antecessora de uma sessao emitida com `regenerate` (anti-fixation) e o
     * cookie correspondente. Fiado em `src/index.ts`, onde a pilha de sessoes e
     * a `Config` existem.
     */
    readonly issueSession: (req: IncomingMessage, presentedSessionId: string | undefined) => string | null;
}
/**
 * Reduz uma origem (`https://host:porta`) a uma CHAVE DE COMPARACAO canonica.
 *
 * >>> ALLOWLIST EXATA, NUNCA "CONTEM". <<< E a diferenca entre recusar e aceitar
 * `Origin: https://evil.com/?x=meudominio.com`, que CONTEM o nosso dominio e nao
 * E o nosso dominio. Compara-se esquema + host + porta, cada um extraido por um
 * parser de URL -- nunca por `includes`, `startsWith` ou expressao regular sobre
 * a string crua.
 *
 * A porta por omissao do esquema e retirada, para que `https://x` e
 * `https://x:443` sejam a mesma origem (que e o que sao).
 */
export declare function canonicalOrigin(raw: string | undefined): string | undefined;
/**
 * As origens de que este servidor aceita um handshake de WebSocket.
 *
 * O tunel entra SE E SO SE estiver `READY`, e SAI quando cai. Uma entrada morta
 * seria uma origem que continua a ser aceite depois de deixar de nos pertencer.
 */
export declare function buildAllowedOrigins(loopbackAuthority: string, tunnelOrigin: string | undefined): readonly string[];
/**
 * Constroi o handler guardado que envolve um despacho original.
 *
 * A SUPERFICIE E GUARDADA INTEIRA, e isso e estrutural: no ponto de despacho
 * existe o `req` (metodo, pathname, cabecalhos) mas NAO a identidade do plugin
 * dono da rota. A unica excecao e {@link GateDeps.unauthenticatedPrefixes}, e o
 * JSDoc dela explica porque existe e porque e minima.
 */
export declare function createGuardedHandler(deps: GateDeps, delegate: WebRequestHandler, surface: string): WebRequestHandler;
/**
 * Constroi o tratador de upgrade guardado (handshake de WebSocket).
 *
 * -----------------------------------------------------------------------------
 * PORQUE ESTA SUPERFICIE E GUARDADA POR INTEIRO, sem olhar a `guardedPrefixes`
 * -----------------------------------------------------------------------------
 * Os WebSockets NAO estao sujeitos a same-origin policy. Qualquer pagina aberta
 * no navegador da maquina pode abrir `ws://127.0.0.1:3080/...` para outra origem
 * sem qualquer permissao -- nao ha preflight, nao ha CORS. E o doc-fonte do DSH
 * regista que o canal de downlink foi migrado de SSE para um WebSocket dedicado:
 * o canal transporta estado do plano de controlo. Deixa-lo fora do portao seria
 * reabrir a #853 por outra porta.
 *
 * -----------------------------------------------------------------------------
 * CWE-1385 -- `Origin` COM ALLOWLIST EXATA
 * -----------------------------------------------------------------------------
 * Precedentes diretos: CVE-2023-26114 no code-server (CVSS 9.3) e CVE-2025-52882
 * nas extensoes do Claude Code. Ambos: handshake de WebSocket aceite a partir de
 * qualquer origem, em servidor de loopback, com execucao de codigo do outro lado.
 *
 * A comparacao e EXATA sobre esquema+host+porta ({@link canonicalOrigin}), nunca
 * "contem": `https://evil.com/?x=meudominio.com` CONTEM o nosso dominio e nao E
 * o nosso dominio.
 *
 * `Origin` AUSENTE nao e recusado aqui -- cai para a credencial. Nao e
 * indulgencia: um NAVEGADOR envia sempre `Origin` no handshake (a norma
 * WebSocket obriga-o e o script nao lhe toca), logo a ausencia significa cliente
 * NAO-navegador, e o ataque de origem cruzada -- que so um navegador consegue
 * montar -- nao se aplica. Recusar com 403 quebraria ainda a sonda
 * `websocket-upgrade` de `src/contracts/tunnel.ts`, cujo caso feliz e "socket
 * destruido OU 401": um 403 fa-la-ia concluir que o gate nao esta armado e o
 * tunel nunca subiria. Sem credencial, um cliente sem `Origin` continua a levar
 * 401 -- que e exatamente o que a sonda espera.
 *
 * -----------------------------------------------------------------------------
 * NAO HA ISENCOES NESTA SUPERFICIE, e a ausencia e a decisao
 * -----------------------------------------------------------------------------
 * {@link GateDeps.unauthenticatedPrefixes} NAO e consultado aqui. As tres portas
 * isentas existem para ANTECEDER a sessao por HTTP -- abrir uma pagina, consumir
 * um `mk`, submeter um formulario. Nenhuma delas e um canal bidirecional, e um
 * WebSocket isento de credencial seria precisamente a #853 por outra porta. Todo
 * o handshake exige credencial, sem excecao. `loopbackOnlyPrefixes`, esse, e
 * consultado -- ver o ponto L2.6 no corpo.
 *
 * NUNCA REJEITA: um erro no caminho de decisao NAO pode resultar em handshake
 * aprovado nem em rejeicao nao capturada no dono do despacho -- fecha-se o
 * socket (fail-closed) e resolve-se.
 */
export declare function createGuardedUpgradeHandler(deps: GateDeps, delegate: WebUpgradeHandler, surface: string): WebUpgradeHandler;
//# sourceMappingURL=gate.d.ts.map