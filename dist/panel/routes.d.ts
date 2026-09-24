/**
 * Registro das rotas `/__guard/*` e a politica por rota da tabela de D5.
 *
 * DONO: T3.4 -> T5.3.
 *
 * ==========================================================================
 * O CONTROLO MAIS IMPORTANTE DESTE FICHEIRO: A ISENCAO E ENUMERADA
 * ==========================================================================
 * `isGuardedPath` guarda `/__guard` INTEIRO. A tabela abaixo e a UNICA fonte de
 * excecao a essa guarda, e cada excecao e UMA LINHA VISIVEL. Nao ha padrao, nao
 * ha prefixo, nao ha "rotas que comecam por" -- ha uma lista.
 *
 * A PROPRIEDADE QUE ISTO COMPRA, e que o teste central de
 * `test/security/panel-exemptions.test.ts` falsifica: uma rota NOVA acrescentada
 * a `panelRoutes()` sem tocar na tabela NASCE GUARDADA. A politica e procurada
 * pela CHAVE `<METODO> <caminho>` e a ausencia responde `'exige-sessao'`. Repare
 * que a politica NAO e um campo do objeto de rota: se fosse, quem escrevesse a
 * rota escreveria tambem a sua propria isencao, e a revisao teria de a apanhar
 * por leitura em vez de por construcao.
 *
 * PORQUE TAO DURO. Esta e a unica superficie do sistema alcancavel da internet
 * SEM credencial. Um furo por omissao aqui anula todas as outras camadas: o
 * gate, o limitador, o segredo, a sessao. E por isso que o teste vive em
 * `test/security/` e nao em `test/unit/`.
 *
 * PORQUE UM `Map` E NAO UM OBJETO. Com um objeto literal, `tabela['constructor']`
 * devolve um valor VERDADEIRO herdado do prototipo -- e uma consulta de politica
 * que devolve lixo verdadeiro em vez de `undefined` e um buraco que nao aparece
 * em revisao nenhuma. `Map` nao tem prototipo a consultar.
 *
 * ==========================================================================
 * SEM BOTOES DE LIGA/DESLIGA
 * ==========================================================================
 * `POST /__guard/api/tunnel/start|stop` sao de T5.3, na Onda 5, e por isso NAO
 * estao nem na tabela nem em `panelRoutes()`. Isso nao e omissao: enquanto nao
 * existirem, um pedido a esses caminhos cai no 404 comum -- que e o
 * comportamento correcto para uma rota que nao existe.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditSink, Identity, SecretStore } from '../contracts/auth.ts';
import type { ConfirmService, ControlIntent, ControlResultado } from '../contracts/control.ts';
import type { TunnelSnapshot } from '../contracts/tunnel.ts';
import type { GuardLogger } from '../logging/logger.ts';
import type { FailureTracker } from '../ratelimit/tracker.ts';
import type { OneTimeTokenStore } from '../secret/ott.ts';
import type { RequestOrigin } from '../session/cookie.ts';
import type { MagicStore } from '../session/magic.ts';
import type { GuardSessionStore } from '../session/store.ts';
import type { CsrfGuard } from './csrf.ts';
import type { AuditGate, PanelHandler, PanelResponse } from './api.ts';
/** Prefixo canonico do plugin. `/__mobile` e `/__gate` estao MORTOS (D5). */
export declare const PANEL_PREFIX = "/__guard";
export declare const PANEL_PATH_ROOT = "/__guard";
export declare const PANEL_PATH_STATE = "/__guard/api/state";
export declare const PANEL_PATH_LOGIN = "/__guard/api/login";
export declare const PANEL_PATH_MAGIC = "/__guard/magic";
export declare const PANEL_PATH_SECRET = "/__guard/secret";
export declare const PANEL_PATH_TUNNEL_START = "/__guard/api/tunnel/start";
export declare const PANEL_PATH_TUNNEL_STOP = "/__guard/api/tunnel/stop";
export declare const PANEL_PATH_TUNNEL_START_NONCE = "/__guard/api/tunnel/start/nonce";
/**
 * `'publica'` = fora do gate, com o controlo que a substitui escrito na tabela.
 * `'exige-sessao'` = sem sessao valida nao passa. E o valor por OMISSAO.
 */
export type PanelPolicy = 'publica' | 'exige-sessao';
/** Metodos que o painel serve. Um pedido com outro metodo nao casa rota nenhuma. */
export type PanelMethod = 'GET' | 'POST';
/**
 * Chave da tabela. Metodo E caminho, porque a politica difere por metodo: o
 * `GET /__guard/magic` e inerte e publico, e o `POST` homonimo consome.
 *
 * O caminho passa por `canonicalRequestPath` dos DOIS lados -- na construcao da
 * chave e na consulta -- para que `/__guard/`, `//__guard`, `/__GUARD` e
 * `/x/../__guard` nao possam designar uma entrada diferente da que a tabela
 * declara.
 */
export declare function routeKeyOf(method: string, path: string): string;
export declare const PANEL_ROUTE_POLICY: ReadonlyMap<string, PanelPolicy>;
/**
 * A politica de uma rota. AUSENTE DA TABELA => `'exige-sessao'`.
 *
 * Este `??` e o desenho inteiro em dois caracteres: o default e FECHADO. Trocar
 * por `'publica'` faria toda rota futura nascer aberta, e nada no compilador
 * acusaria.
 */
export declare function policyForRouteKey(key: string): PanelPolicy;
export declare function policyForRoute(method: string, path: string): PanelPolicy;
/** As chaves ISENTAS do gate, para o teste de superficie as comparar por conjunto. */
export declare function panelPublicRouteKeys(): readonly string[];
export interface PanelRoute {
    readonly method: PanelMethod;
    /** Caminho canonico. Comparado com `canonicalRequestPath(req.url)`. */
    readonly path: string;
    readonly handler: PanelHandler;
}
/**
 * Evento da recusa de CSRF.
 *
 * UM NOME SO, PARA TODAS AS ROTAS. Antes, `POST /__guard/magic` mapeava a
 * recusa de CSRF para `magic.crawler-suspect` -- e a revisao adversarial
 * mostrou que isso era ruido disfarcado de alarme: um `POST` sem token
 * normalmente nem `mk` traz, ou seja, o evento disparava onde nao havia nada a
 * proteger. O sinal de `crawler-suspect` vive agora em `magic.ts`, com o `mk`
 * em mao e antes de o consumir.
 */
export declare const CSRF_REJECTION_EVENT = "painel_csrf_recusado";
export interface PanelDeps {
    readonly log: GuardLogger;
    readonly audit: Pick<AuditSink, 'append'>;
    readonly snapshot: () => TunnelSnapshot;
    readonly secrets: Pick<SecretStore, 'verify'>;
    readonly sessions: Pick<GuardSessionStore, 'regenerate' | 'validate'>;
    readonly magic: Pick<MagicStore, 'consume'>;
    readonly ott: Pick<OneTimeTokenStore, 'consume'>;
    /** Ver `SecretRevealDeps` em `secret.ts`. `null` = nada para mostrar. */
    readonly reveal: () => string | null;
    readonly limiter: FailureTracker;
    readonly csrf: CsrfGuard;
    /**
     * Relogio do porteiro de auditoria (`04-TESTES.md` 8.1). E o que torna a
     * janela de rajada testavel sem esperar cinco minutos.
     */
    readonly clock: {
        now(): number;
    };
    /**
     * >>> A COSTURA COM T5.1, OBRIGATORIA E SEM VALOR POR OMISSAO. <<<
     *
     * O painel e SUPERFICIE (`03-ONDAS.md` 10): nunca chama o supervisor de
     * tunel. Toda acao vira `ControlIntent` despachada pelo controlador unico
     * de T5.1, e o estado que o painel projeta carrega o `seq` do broadcast
     * dele. Os tres campos sao o que T5.1 fia em `src/index.ts` -- obrigatorios
     * para que o `tsc` RECUSE uma composicao que se esqueca deles.
     */
    readonly seq: () => number;
    readonly confirm: Pick<ConfirmService, 'issue'>;
    readonly dispatch: (intent: ControlIntent) => ControlResultado | Promise<ControlResultado>;
    /** Espera do limitador. Injetada em teste; nunca se espera tempo real. */
    readonly wait?: (ms: number) => Promise<void>;
    /** Ver {@link defaultIdentify}. */
    readonly identify?: (req: IncomingMessage) => Identity;
    /**
     * A ORIGEM EFETIVA DO PEDIDO (`{ scheme, host }`), que e o que
     * `serializeSessionCookie` exige para decidir se pode sequer emitir a sessao.
     *
     * >>> OBRIGATORIA, E SEM VALOR POR OMISSAO. <<< Havia aqui um
     * `defaultResolveOrigin` local que decidia "host nao-loopback => acredito no
     * `X-Forwarded-Proto`". A condicao era LARGA DEMAIS e por isso errada: uma
     * instalacao em LAN (`192.168.1.5:3080`, sem tunel nenhum) e nao-loopback e
     * NAO tem borda a frente -- ali o cabecalho e escrito por qualquer maquina do
     * segmento, e a medicao que o legitima (R10, `docs/spikes/cloudflared.md:155`:
     * a borda da Cloudflare SOBRESCREVE `X-Forwarded-Proto`, o cliente enviou
     * `http` e a origem viu `https`) e sobre a BORDA, nao sobre "vir de fora".
     *
     * A implementacao correcta e `createRequestOriginResolver`
     * (`src/http/session-auth.ts`, reexportada por `src/index.ts`): a condicao
     * dela e `exposure.mode === 'tunnel'` **E** o pedido ter chegado pelo nome
     * publico do tunel. Ela precisa da `Config` e do registo da origem do tunel,
     * que o painel nao tem por que conhecer -- dai a injeccao.
     *
     * PORQUE NAO FICA UM DEFAULT "SEGURO" NO LUGAR: um default aqui e uma decisao
     * de seguranca tomada por quem NAO tem a informacao para a tomar, e o campo
     * opcional garantia que um dia alguem compunha o painel sem reparar. Sendo
     * obrigatoria, o `tsc` recusa a composicao que se esqueca dela.
     */
    readonly resolveOrigin: (req: IncomingMessage) => RequestOrigin;
}
/**
 * As rotas do painel nesta onda.
 *
 * ESTA LISTA NAO DECIDE POLITICA. Ela diz o que existe; a tabela diz o que e
 * publico. Acrescentar uma entrada aqui e so isso: uma rota nova, guardada.
 */
export declare function panelRoutes(deps: PanelDeps, audit: AuditGate): readonly PanelRoute[];
/** Escreve o envelope. UNICO sitio que toca no `ServerResponse` deste modulo. */
export declare function writePanelResponse(res: ServerResponse, response: PanelResponse): void;
/** Fabrica da lista de rotas. Ver o parametro `routes` de {@link createPanelRouter}. */
export type PanelRouteFactory = (deps: PanelDeps, audit: AuditGate) => readonly PanelRoute[];
/**
 * Constroi o tratador HTTP do painel.
 *
 * @param routes FABRICA, e nao lista. O default e {@link panelRoutes}; o teste
 * de superficie passa `(d, g) => [...panelRoutes(d, g), rotaNova]` para provar
 * que uma rota ausente da tabela nasce GUARDADA. E fabrica e nao lista porque o
 * porteiro de auditoria tem de ser UM SO -- as rotas e o despachante partilham a
 * contagem de rajada, e dois porteiros dariam ao atacante o dobro das linhas.
 */
export declare function createPanelRouter(deps: PanelDeps, routes?: PanelRouteFactory): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
//# sourceMappingURL=routes.d.ts.map