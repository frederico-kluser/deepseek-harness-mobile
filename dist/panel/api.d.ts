/**
 * `GET /__guard/`, `GET /__guard/api/state` e `POST /__guard/api/login`.
 *
 * DONO: T3.4 -> T5.3.
 *
 * ------------------------------------------------------------------------
 * PORQUE O ENVELOPE DE RESPOSTA VIVE AQUI
 * ------------------------------------------------------------------------
 * `PanelResponse` e as respostas constantes (404, 403, 413, 500) sao usadas por
 * `magic.ts`, por `secret.ts` e pelo despachante de `routes.ts`. Se vivessem em
 * `routes.ts` -- que e quem as escreve no socket -- o grafo de modulos ficava
 * CICLICO (`routes -> secret -> routes`), e um ciclo com valores (nao apenas
 * tipos) e uma zona morta temporal a espera de acontecer. Vivendo na folha mais
 * baixa que precisa delas, o grafo e um DAG: `csrf`/`html` -> `api` ->
 * `magic`/`secret` -> `routes`.
 *
 * O 404 SER UMA CONSTANTE PARTILHADA E O CONTROLO, E NAO ARRUMACAO. `PANEL-003`
 * e `PANEL-004` exigem que o 404 de rota inexistente e o 404 de
 * `/__guard/secret` sem `ott` sejam BYTE A BYTE iguais. Com dois literais em
 * dois ficheiros, isso e verdade no dia em que se escreve e mentira na primeira
 * vez que alguem melhora uma das mensagens. Com uma constante, e verdade por
 * construcao.
 *
 * ------------------------------------------------------------------------
 * `GET /api/state` NAO RESPONDE NADA ANTES DO LOGIN
 * ------------------------------------------------------------------------
 * O que ele vazaria e a URL DO TUNEL, que e informacao sensivel de operacao: e
 * o endereco publico da maquina do dono, valido enquanto o tunel viver, e quem
 * varre a internet a procura de quick tunnels precisa exatamente disso. A
 * politica esta na tabela de `routes.ts` (`exige-sessao`) e a projecao aqui
 * REPETE a invariante do contrato: `info` so sai em `READY`. Duas camadas para
 * a mesma promessa, porque uma delas vai ser refatorada um dia.
 *
 * ------------------------------------------------------------------------
 * PORQUE `maskAuditText` E NAO `redact` (revisao adversarial, BAIXA)
 * ------------------------------------------------------------------------
 * QUANDO ESTE FICHEIRO FOI ESCRITO, `src/logging/redact.ts` DECLARAVA no proprio
 * cabecalho o que nao cobria: o `mk` do link magico e O URL DO TUNEL. A versao
 * anterior deste ficheiro chamava a `redact()` "o cinto por cima dos
 * suspensorios" -- e era falso: um `failure.message` com o URL do tunel saia
 * INTACTO por `/__guard/api/state`.
 *
 * A costura da Onda 3 fechou essa lacuna na RAIZ (as formas subiram para
 * `SECRET_SHAPES`), mas a chamada continua a ser a `maskAuditText`, porque ela
 * traz TRES formas a mais que so fazem sentido onde o custo de um falso negativo
 * e o bot ou a credencial do dono -- e uma `failure.message` mostrada ao dono no
 * painel e reenviada por Telegram e exatamente esse sitio. Chamar em vez de
 * copiar, porque uma primitiva de mascaramento duplicada e uma primitiva que
 * diverge.
 *
 * O CAMINHO ABSOLUTO, que a revisao tambem apanhou, chegou a viver aqui numa
 * `maskAbsolutePaths` LOCAL, com a nota de que a casa duravel dela era
 * `SECRET_SHAPES`. A costura da Onda 3 promoveu-a: a forma vive agora em
 * `src/logging/redact.ts` -- ja nao ha remendo local, e `maskAuditText` sozinha
 * cobre as tres coisas (URL do tunel, `mk`, `$HOME`).
 *
 * A REGRA DO CAMINHO MUDOU COM A PROMOCAO, e a mudanca e deliberada: o remendo
 * local comia QUALQUER caminho absoluto com tres segmentos, incluindo
 * `/opt/bin/cloudflared` e `/usr/lib/...`, que sao estrutura de sistema e nao
 * identificam ninguem -- destruia a mensagem de erro para nao vazar nada. A
 * forma promovida mascara o `$HOME` e so ele. O JSDoc dela explica porque.
 */
import type { IncomingMessage } from 'node:http';
import type { AuditEvent, AuditSink, Identity, SecretStore } from '../contracts/auth.ts';
import type { ConfirmService, ControlIntent, ControlResultado } from '../contracts/control.ts';
import type { TunnelSnapshot } from '../contracts/tunnel.ts';
import type { GuardLogger } from '../logging/logger.ts';
import type { FailureTracker } from '../ratelimit/tracker.ts';
import type { RequestOrigin } from '../session/cookie.ts';
import type { GuardSession, GuardSessionStore } from '../session/store.ts';
import type { CsrfGuard } from './csrf.ts';
export interface PanelResponse {
    readonly status: number;
    /** Nomes em minusculas. A ORDEM importa: e ela que torna dois 404 iguais. */
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    /** Uma linha `Set-Cookie`, quando a resposta entrega sessao. */
    readonly setCookie?: string;
}
/** Tudo o que um tratador de rota do painel ve do pedido. */
export interface PanelExchange {
    readonly req: IncomingMessage;
    readonly method: string;
    /** Caminho ja canonicalizado por `canonicalRequestPath`. */
    readonly path: string;
    /** `req.url` cru -- o unico sitio onde a query string ainda existe. */
    readonly rawUrl: string;
    readonly origin: RequestOrigin;
    readonly identity: Identity;
    /** Sessao valida, ou `null`. Nas rotas publicas e quase sempre `null`. */
    readonly session: GuardSession | null;
    /** Id APRESENTADO no cookie, valido ou nao. Serve o anti-fixation. */
    readonly presentedSessionId: string | null;
    /** Corpo ja lido e decomposto pelo despachante. Vazio nos `GET`. */
    readonly fields: ReadonlyMap<string, string>;
    readonly csrf: CsrfGuard;
}
export type PanelHandler = (exchange: PanelExchange) => Promise<PanelResponse>;
/**
 * O 404. UM literal, para o repositorio inteiro.
 *
 * O corpo e deliberadamente anodino: sem nome de plugin, sem versao, sem
 * hostname, sem caminho de ficheiro (PANEL-010). Enumerar versao e o primeiro
 * passo de quem procura CVE, e esta e a unica superficie que um scanner anonimo
 * ve com o tunel de pe.
 */
export declare const NOT_FOUND_RESPONSE: PanelResponse;
/** CSRF em falta ou invalido. Nao e um oraculo de credencial: nao ha credencial. */
export declare const FORBIDDEN_RESPONSE: PanelResponse;
export declare const PAYLOAD_TOO_LARGE_RESPONSE: PanelResponse;
/**
 * Qualquer excecao nao prevista desagua aqui.
 *
 * O corpo e fixo porque a mensagem do erro pode conter QUALQUER coisa -- e o
 * caminho de login manipula o segredo. Nenhum detalhe de erro atravessa o fio;
 * ele vai para o log, ja redigido.
 */
export declare const INTERNAL_ERROR_RESPONSE: PanelResponse;
/**
 * A UNICA resposta que uma credencial recusada produz -- no `login` E no `magic`.
 *
 * `02-SEGURANCA.md` 6.1: segredo errado, segredo certo sem conta provisionada,
 * corpo malformado e campo ausente TEM de ser indistinguiveis. Uma constante
 * unica torna isso verdade por construcao -- nao ha um segundo literal onde
 * introduzir a diferenca. Sem `Retry-After`, sem `429`, sem contagem: qualquer
 * um deles diria ao atacante quanto do orcamento ja gastou.
 *
 * PARTILHADA COM `magic.ts` DE PROPOSITO: `mk` expirado, `mk` ja gasto e `mk`
 * malformado tambem sao a mesma resposta, e tambem sao a mesma resposta que um
 * segredo errado. Tres razoes distintas, uma unica saida observavel.
 */
export declare const CREDENTIAL_DENIED_RESPONSE: PanelResponse;
export declare const OK_JSON_RESPONSE: PanelResponse;
/**
 * Teto do corpo aceite num `POST` do painel.
 *
 * Os corpos reais sao dois campos curtos (`segredo`+`csrf`, `mk`+`csrf`). 4 KiB
 * e folga generosa e ao mesmo tempo o que impede que um `POST` sem fim consuma
 * memoria do processo que hospeda o DSH inteiro.
 */
export declare const MAX_BODY_BYTES = 4096;
export type ParsedBody = {
    readonly ok: true;
    readonly fields: ReadonlyMap<string, string>;
} | {
    readonly ok: false;
    readonly reason: 'too-large' | 'malformed' | 'unsupported';
};
/** Devolve o mapa vazio partilhado -- nunca `undefined`, nunca `null`. */
export declare function emptyFields(): ReadonlyMap<string, string>;
/**
 * Le e decompoe o corpo, com teto de bytes.
 *
 * O teto e verificado A MEDIDA QUE OS PEDACOS CHEGAM, e nao no fim: verificar
 * no fim significa ter aceitado tudo primeiro, que e precisamente o que o teto
 * existe para impedir.
 */
export declare function readRequestBody(req: IncomingMessage, limitBytes?: number): Promise<ParsedBody>;
/**
 * Quanto tempo de SILENCIO fecha uma rajada.
 *
 * Nao e uma janela deslizante: enquanto as recusas continuarem a chegar, a
 * rajada e A MESMA e a contagem nao reinicia. So um intervalo inteiro sem uma
 * unica recusa abre rajada nova. A diferenca decide o limite: com janela
 * deslizante, um atacante ganha `log2(N)` linhas A CADA janela e o ficheiro
 * volta a crescer sem fim; assim, ganha `log2(N)` linhas NO TOTAL.
 */
export declare const AUDIT_BURST_QUIET_MS: number;
/**
 * O porteiro do `AuditSink`. DUAS responsabilidades, ambas nascidas da revisao
 * adversarial, e ambas com o mesmo dono para nao haver caminho por fora.
 *
 * ------------------------------------------------------------------------
 * (A) `append` NUNCA PROPAGA -- e isto foi pedido por escrito
 * ------------------------------------------------------------------------
 * `src/audit/log.ts` deixou a costura enderecada a esta onda, literalmente:
 *
 *   ">>> COSTURA PARA O PREP DA ONDA 3: [...] D9 exige `401` de corpo identico
 *   >>> em toda falha de autenticacao; propagar isto em cru daria um `500` com
 *   >>> texto proprio -- oraculo, e com topologia de disco dentro."
 *
 * `AuditLog.append` LANCA `AuditWriteError` quando o disco enche -- fail-closed
 * deliberado daquele modulo. Sem este porteiro, essa excecao subia ao `catch` do
 * despachante e convertia o 404 do segredo num 500 (que ANUNCIA que a rota
 * existe, e o que ela devolve destrancada e a senha permanente) e o 401 do login
 * num 500 (que mata D9). Medido pela revisao, nao imaginado.
 *
 * A resposta HTTP continua a ser a MESMA CONSTANTE; o erro vai para o log do
 * operador. E vai sem `AuditWriteError.path`, que o proprio modulo marca como
 * NAO APRESENTAVEL -- o log do host tambem nao e sitio para topologia de disco.
 *
 * ------------------------------------------------------------------------
 * (B) RECUSA ANONIMA E AGREGADA, PORQUE O FICHEIRO NAO TEM ROTACAO
 * ------------------------------------------------------------------------
 * `src/audit/log.ts` justifica a AUSENCIA de rotacao com a existencia do
 * limitador:
 *
 *   "SEM ROTACAO, com um numero atras: quem alimenta este ficheiro e o caminho
 *   de autenticacao, ATRAS DO LIMITADOR DE T2.3 -- [...] ~18 KB antes de a
 *   torneira fechar."
 *
 * A versao anterior desta sub-tarefa abriu duas torneiras que NAO estao atras
 * do limitador -- o `ott` invalido e a recusa de CSRF -- e a revisao mediu
 * 1405 e 1845 KiB/s de crescimento a partir de um cliente anonimo, num ficheiro
 * `0600` que por desenho nao pode ser rodado nem truncado. Isso e o disco do
 * dono cheio a partir da internet, e as linhas de seguranca reais afogadas em
 * ruido cujo volume o atacante escolhe.
 *
 * A REGRA, e ela e curta: uma recusa a quem NAO apresentou credencial valida e
 * agregada; tudo o que envolve uma identidade estabelecida, ou que passa pelo
 * limitador, e escrito em cheio.
 *
 * O login e o `magic` FICAM em cheio de proposito -- eles estao atras do
 * limitador, que e exatamente a condicao que o modulo de auditoria invoca, e
 * "registar TODA tentativa de autenticacao" e a entrega daquele ficheiro. O
 * atraso da escada (ate 30 s por tentativa, com jitter) e o que lhes limita o
 * caudal.
 *
 * A ESCADA DE ESCRITA e por LIMIAR EXPONENCIAL: escreve-se na 1a, 2a, 4a, 8a...
 * recusa da rajada. Consequencias, todas desejadas:
 *   - uma sonda isolada continua a produzir a sua linha, na hora;
 *   - N recusas custam `O(log N)` linhas -- mil milhoes de pedidos cabem em ~30;
 *   - a MAGNITUDE fica no registo (o nome leva `_xN`), portanto o operador ve
 *     "houve uma rajada e chegou a 2^k", que e a informacao que interessa.
 *
 * A contagem vai no NOME do evento e nao num campo novo: `AuditEvent` e
 * contrato CONGELADO (`src/contracts/auth.ts`) e `evento` e uma string livre que
 * `format.ts` mascara e limita a 200 caracteres. Acrescentar um campo era
 * contornar o contrato para poupar seis caracteres.
 */
export interface AuditGate {
    /** Escreve sempre. Nunca lanca. */
    append(event: AuditEvent): void;
    /**
     * Recusa a um pedido SEM credencial valida: conta sempre, escreve em
     * `O(log N)`. Nunca lanca.
     */
    recordAnonymousRejection(evento: string): void;
}
export interface AuditGateDeps {
    readonly audit: Pick<AuditSink, 'append'>;
    readonly log: GuardLogger;
    readonly clock: {
        now(): number;
    };
    /** So se muda em teste; o valor de producao e {@link AUDIT_BURST_QUIET_MS}. */
    readonly quietMs?: number;
}
export declare function createAuditGate(deps: AuditGateDeps): AuditGate;
export interface SessionEmissionInput {
    readonly sessions: Pick<GuardSessionStore, 'regenerate'>;
    readonly origin: RequestOrigin;
    readonly presentedSessionId: string | null;
    readonly log: GuardLogger;
}
/**
 * Emite a sessao e a linha `Set-Cookie`, ou falha FECHANDO.
 *
 * A ORIGEM E VERIFICADA ANTES DE A SESSAO NASCER. Se fosse depois, uma origem
 * que nao entrega cookie `Secure` deixava para tras uma sessao valida do lado do
 * servidor que ninguem consegue apresentar -- lixo autenticado a contar para o
 * teto de sessoes vivas.
 *
 * `regenerate` e nao `create`: ele INVALIDA o id que o cliente apresentou antes
 * de emitir o novo. Sem isso, um id plantado no navegador da vitima (por
 * subdominio, por XSS noutra aplicacao, por link) continuaria valido depois de
 * ela autenticar -- que e a definicao de session fixation. O aviso esta escrito
 * no topo de `src/session/store.ts` e e dirigido a esta sub-tarefa.
 */
export declare function emitSession(input: SessionEmissionInput): {
    readonly ok: true;
    readonly setCookie: string;
} | {
    readonly ok: false;
};
export interface PanelPageDeps {
    readonly log: GuardLogger;
}
export declare function createPanelPageHandler(deps: PanelPageDeps): PanelHandler;
export interface StateDeps {
    readonly snapshot: () => TunnelSnapshot;
    /**
     * A SEQUENCIA MONOTONICA DO CONTROLADOR (T5.1) -- a costura de CTL-016/017/019.
     *
     * O painel e PROJECCAO: nao mantem estado proprio alem do ultimo `seq` que
     * viu, e e o `seq` que lhe permite nao re-renderizar um estado repetido e
     * que o teste de paridade (CTL-040) usa para comparar o painel com o bot.
     *
     * OBRIGATORIA, E SEM VALOR POR OMISSAO: sem ela o `tsc` recusa a composicao
     * de T5.1 que se esquecer de a fiar. O snapshot (`TunnelSnapshot`, contrato
     * congelado) nao a carrega -- ela e do controlador, e vem por este campo.
     */
    readonly seq: () => number;
}
/**
 * Projeta o snapshot para o fio.
 *
 * `info` e `expiresAt` SO SAEM EM `READY`, e a verificacao e feita aqui e nao
 * confiada ao produtor. `src/contracts/tunnel.ts` ja diz "presente sse
 * `state === 'READY'`", mas um contrato e uma promessa e isto e uma fronteira:
 * se um dia um supervisor com defeito deixar `info` preenchida em `STARTING`, a
 * URL do tunel sai na resposta. Custa uma linha impedi-lo.
 *
 * O vocabulario que vai no payload e o INGLES de D7. Os rotulos em portugues
 * ficam em `html.ts` e nunca entram aqui.
 */
export declare function projectSnapshot(snapshot: TunnelSnapshot): Record<string, unknown>;
export declare function createStateHandler(deps: StateDeps): PanelHandler;
/** Nome do campo que transporta o segredo. */
export declare const LOGIN_FIELD_NAME = "segredo";
export interface LoginDeps {
    readonly secrets: Pick<SecretStore, 'verify'>;
    readonly sessions: Pick<GuardSessionStore, 'regenerate'>;
    readonly limiter: FailureTracker;
    /** Injetado: em teste nao se espera tempo real (04-TESTES.md 8.1). */
    readonly wait: (ms: number) => Promise<void>;
    /**
     * O PORTEIRO, e nao o sink cru. Ver {@link createAuditGate}: `append` do sink
     * LANCA quando o disco enche, e uma excecao aqui virava um 500 no lugar do
     * 401 identico que D9 exige.
     */
    readonly audit: AuditGate;
    readonly log: GuardLogger;
}
/**
 * A rota que T2.2 NAO entregou de proposito -- a Onda 2 era "primitivas sem
 * fiacao". Esta e a fiacao.
 *
 * TRES PROPRIEDADES QUE O TESTE TEM DE CONSEGUIR FALSIFICAR:
 *
 * 1. NENHUM ORACULO. Todo o caminho que nao termina em sessao devolve
 *    `CREDENTIAL_DENIED_RESPONSE`, a mesma constante, com os mesmos bytes. Campo
 *    ausente vira candidato vazio em vez de um ramo proprio, justamente para
 *    nao existir um ramo proprio.
 * 2. CUSTO CONSTANTE. `runThrottledAttempt` corre a comparacao mesmo quando a
 *    identidade esta banida (`recordVerifiedButDenied`), e o atraso vem da
 *    mesma escada. Responder mais depressa a um banido seria dizer-lhe que
 *    esta banido.
 * 3. ANTI-FIXATION. `emitSession` chama `regenerate` com o id APRESENTADO.
 */
export declare function createLoginHandler(deps: LoginDeps): PanelHandler;
/**
 * O painel e SUPERFICIE, nunca dono do estado (`03-ONDAS.md` 10): estes tres
 * tratadores NAO falam com o supervisor de tunel -- montam um `ControlIntent`
 * (contrato congelado, `src/contracts/control.ts`) e entregam-no ao
 * `dispatch` que T5.1 fia. E o controlador, e so ele, que valida o nonce
 * (CTL-021/022/023), recusa em modo restrito (CTL-015) e mexe no processo.
 */
/** Nome do campo do corpo que transporta o nonce de confirmacao (opaco). */
export declare const TUNNEL_NONCE_FIELD_NAME = "nonce";
/**
 * Estado HTTP de uma recusa do controlador.
 *
 * 409 e NAO 200-com-erro de proposito: uma recusa e um CONFLITO com o estado
 * corrente (CTL-007 `SHUTDOWN_IN_PROGRESS`, CTL-015 `MODO_RESTRITO`, CTL-011
 * `TERMINAL_SEM_RESET`, CTL-021/022 nonce) e o corpo traz o codigo de recusa
 * fechado -- o rotulo em portugues vive em `html.ts` (D7), nunca aqui.
 */
export declare const TUNNEL_ACTION_REFUSAL_STATUS = 409;
export interface TunnelActionDeps {
    /**
     * O emissor do nonce (`ConfirmService.issue`). O CONSUMO (`consume`) e do
     * controlador durante o despacho -- esta superficie emite e transporta o
     * valor OPACO e nunca decide sobre ele (CTL-021/022 sao recusas de
     * despacho). O `Pick` e deliberado: so a metade da costura que esta
     * superficie consome.
     */
    readonly confirm: Pick<ConfirmService, 'issue'>;
    /**
     * O despacho do controlador unico. ACEITA SINCRONO OU ASSINCRONO de
     * proposito: a costura com T5.1 nao depende de a fila do controlador ser
     * `async` ou nao -- `await` funciona nos dois.
     */
    readonly dispatch: (intent: ControlIntent) => ControlResultado | Promise<ControlResultado>;
    /** Relogio injetado (04-TESTES.md 8.1): `at` do intent, nunca `Date.now`. */
    readonly clock: {
        now(): number;
    };
    /** Log do operador. So escreve o ramo inalcancavel (ver os tratadores). */
    readonly log: GuardLogger;
}
/**
 * `POST /__guard/api/tunnel/start/nonce` -- o PASSO 1 do liga em duas etapas.
 *
 * Emite um nonce de confirmacao (TTL 60 s, uso unico, server-side no host) e
 * devolve-o OPACO com a expiracao. A pagina mostra-o como confirmacao e o
 * reenvia no `POST /__guard/api/tunnel/start` final. Emitir nao e mutar: so o
 * `POST` final, com o nonce, despacha (CTL-023: sem nonce nao ha `start`).
 *
 * Nao usa a sessao para alem do gate do despachante: quem aqui chega ja tem
 * sessao valida (a rota e `exige-sessao`), e o nonce nao se vincula a ela --
 * e o `consume` do host que o valida contra a acao.
 */
export declare function createTunnelNonceHandler(deps: TunnelActionDeps): PanelHandler;
/**
 * `POST /__guard/api/tunnel/start` -- o PASSO 2 do liga.
 *
 * Monta o `ControlIntent` e despacha. `requestedBy` e `panel:<id-hash-da-sessao>`
 * (o valor que o audit de T5.4 escreve linha a linha), `requestId` e um ULID
 * NOVO por pedido (a chave de idempotencia de D29) e `at` vem do relogio
 * injetado. O nonce do corpo atravessa OPACO ate ao controlador -- repetido,
 * o controlador RECUSA (CTL-021); o painel nao guarda memoria de nonces.
 */
export declare function createTunnelStartHandler(deps: TunnelActionDeps): PanelHandler;
/**
 * `POST /__guard/api/tunnel/stop` -- o desliga.
 *
 * A acao que REDUZ exposicao NAO exige nonce (CTL-024: em panico, tem de
 * funcionar de primeira); a confirmacao e de INTERFACE, no painel, e o token
 * anti-CSRF vem do despachante para TODOS os `POST` (NIST SP 800-63B-4 5.1.1).
 */
export declare function createTunnelStopHandler(deps: TunnelActionDeps): PanelHandler;
//# sourceMappingURL=api.d.ts.map