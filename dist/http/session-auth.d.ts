/**
 * =============================================================================
 * O MECANISMO DE AUTENTICACAO DO PORTAO
 * =============================================================================
 *
 * DONO: T3.3. Este ficheiro sabe DECIDIR se um pedido esta autenticado; nao sabe
 * escrever respostas (isso e `src/http/responses.ts`) nem onde esta instalado
 * (isso e `src/http/intercept.ts`). O portao (`src/http/gate.ts`) usa-o.
 *
 * -----------------------------------------------------------------------------
 * O QUE NAO ESTA AQUI, E DE PROPOSITO
 * -----------------------------------------------------------------------------
 * A ROTA `POST /__guard/api/login` E DE T3.4. Este modulo entrega o MECANISMO
 * de sessao dentro do portao -- ler o cookie, valida-lo, e deixar passar. Quem
 * EMITE a sessao e a rota, que chama `SessionStore.regenerate(idApresentado)`
 * (anti-fixation) depois de a credencial ser aceite. Construir aqui a rota seria
 * duas sub-tarefas a escrever o mesmo caminho.
 *
 * -----------------------------------------------------------------------------
 * A ORDEM DAS VERIFICACOES E CONTRATO
 * -----------------------------------------------------------------------------
 * Quem impoe a ordem e o portao, e ela e: perimetro de rede (403) -> `Host`
 * (403) -> autenticacao (401). ESTE modulo so e chamado depois das duas
 * primeiras terem passado. Isso importa para uma propriedade concreta: uma
 * sessao valida NAO curto-circuita `trustedRemotes`. Se curto-circuitasse, um
 * portador de cookie vindo de uma origem recusada receberia 401 em vez de 403 --
 * e o 403 e a resposta que diz "repetir a credencial nao ajuda". A ordem
 * 403-antes-de-401 perder-se-ia sem que nenhum teste de credencial acusasse.
 * =============================================================================
 */
import type { IncomingMessage } from 'node:http';
import type { AuditEvent, AuditSink, Identity, SecretStore } from '../contracts/auth.ts';
import type { StateStore } from '../contracts/state.ts';
import type { ExposureConfig } from '../contracts/tunnel.ts';
import { type Config } from '../config/schema.ts';
import { type AuditLog } from '../audit/log.ts';
import type { GuardLogger } from '../logging/logger.ts';
import { type RateLimitPolicy } from '../ratelimit/policy.ts';
import { type RestrictExposureIntent, type RestrictedMode } from '../ratelimit/restricted.ts';
import { type FailureTracker } from '../ratelimit/tracker.ts';
import { type SecretStoreHandle } from '../secret/store.ts';
import { type Clock, type GuardSession, type GuardSessionStore } from '../session/store.ts';
/**
 * O UNICO cabecalho de IP em que se acredita, e so quando
 * `exposure.trustEdgeHeaders` o autoriza (ver `mayTrustEdgeClientIp`).
 *
 * A justificacao medida esta em `src/config/schema.ts`, em `mayTrustEdgeClientIp`.
 * O resumo que tem de ficar ao lado do nome: a borda da Cloudflare RECUSA (403,
 * `error code: 1000`) o pedido em que o cliente envia este cabecalho, logo o
 * valor que chega a origem nunca e escolhido pelo cliente. `X-Forwarded-For` e
 * ACRESCENTADO ao valor do cliente e portanto e FORJAVEL -- nao esta aqui, nao
 * pode vir a estar, e `X-Real-Ip` tambem nao.
 */
export declare const EDGE_CLIENT_IP_HEADER = "cf-connecting-ip";
/**
 * O cabecalho de ESQUEMA da borda. MEDIDO, e a medicao inverte a letra de tres
 * documentos.
 *
 * `02-SEGURANCA.md:615`, `01-ARQUITETURA.md:1361` e `04-TESTES.md` SESS-007
 * chamam-lhe "forjavel". Os tres foram escritos ANTES da medicao. O caso R10 de
 * `docs/spikes/cloudflared.md:155` mediu contra a borda real: um pedido enviado
 * com `X-Forwarded-Proto: http` chega a origem como `X-Forwarded-Proto: https`
 * -- **SOBRESCRITO**. Vale a medicao, pelo mesmo criterio que tornou
 * `CF-Connecting-IP` confiavel e `X-Forwarded-For` nao.
 *
 * >>> A LISTA DE CABECALHOS DE BORDA ACREDITADOS TEM EXATAMENTE DOIS ELEMENTOS. <<<
 * `x-forwarded-for` (ACRESCENTADO ao valor do cliente) e `x-real-ip` continuam
 * PROIBIDOS em todos os modos. Ver {@link TRUSTED_EDGE_HEADERS}.
 */
export declare const EDGE_FORWARDED_PROTO_HEADER = "x-forwarded-proto";
/**
 * Os DOIS -- e so dois -- cabecalhos que a borda pode decidir por nos.
 *
 * Cada um esta aqui por uma MEDICAO, nao por parecer razoavel:
 *
 *   `cf-connecting-ip`   S2  a borda RECUSA (403, `error code: 1000`) o pedido
 *                            em que o cliente o envia -- o valor que chega
 *                            nunca e escolhido pelo cliente;
 *   `x-forwarded-proto`  R10 a borda SOBRESCREVE o valor do cliente.
 *
 * `x-forwarded-for` foi medido no MESMO ficheiro e e ACRESCENTADO (valor
 * forjado primeiro, IP real por ultimo): quem ler o primeiro elemento deixa o
 * atacante escolher o proprio IP. `x-real-ip` nao foi medido de todo. Nenhum dos
 * dois entra, e acrescentar um terceiro elemento a esta lista exige uma medicao
 * nova, nao uma analogia.
 */
export declare const TRUSTED_EDGE_HEADERS: readonly ["cf-connecting-ip", "x-forwarded-proto"];
/**
 * Onde vive a resposta a "qual e, AGORA, a origem publica deste servidor?".
 *
 * PORQUE UM REGISTO E NAO UMA CHAVE DE CONFIGURACAO: a URL de um quick tunnel e
 * ALEATORIA a cada arranque e NAO E PERSISTIDA (`src/contracts/state.ts` diz
 * porque: e efemera). Nao ha ficheiro nenhum de onde a ler.
 *
 * ENTRA em `READY` e SAI quando o tunel cai -- e isso e uma propriedade de
 * seguranca, nao arrumacao: um nome `*.trycloudflare.com` derrubado volta a ser
 * distribuido a outra pessoa, e uma entrada morta nesta allowlist e um nome que
 * continua a ser aceite depois de deixar de nos pertencer.
 *
 * PUBLICADORES: o supervisor do tunel (T3.1) em `READY` e na queda, e o consumo
 * do intent de MODO RESTRITO (`onRestrictExposure`, neste ficheiro), que a
 * retira imediatamente. Nao ha estado global de modulo -- o registo e criado
 * pela raiz de composicao e vive dentro do `ctx.effect` dela.
 */
export interface TunnelOriginRegistry {
    /** A origem publica (`https://...`) enquanto o tunel esta `READY`. */
    current(): string | undefined;
    /** `undefined` retira a origem da allowlist. Idempotente. */
    publish(origin: string | undefined): void;
}
export declare function createTunnelOriginRegistry(): TunnelOriginRegistry;
/**
 * Os eventos que o portao regista.
 *
 * PROVISORIO POR DECLARACAO: `src/audit/events.ts` e o vocabulario FECHADO e e
 * de T5.4. Ate la os nomes vivem aqui, num sitio so, para que a migracao seja
 * uma renomeacao e nao uma cacada por literais espalhados.
 */
export declare const AUTH_EVENTS: {
    readonly sessao: "auth_sessao";
    readonly credencial: "auth_credencial";
    readonly modoRestrito: "auth_modo_restrito";
    readonly segredoIndisponivel: "auth_segredo_indisponivel";
    readonly exposicaoRestrita: "exposicao_restrita";
};
/**
 * O QUE **NAO** E AUDITADO, E PORQUE ISSO E UMA DECISAO DE SEGURANCA.
 *
 * As recusas de PERIMETRO -- origem fora de `trustedRemotes` (403), `Host`
 * forjado (403), `Origin` fora da allowlist no upgrade (403) -- e os pedidos
 * ANONIMOS nao produzem linha de auditoria. Elas ficam no log do operador
 * (`log.warn`), que e rotativo e nao governa decisao nenhuma.
 *
 * A razao e a auditoria ser FAIL-CLOSED: um log que nao consegue escrever faz o
 * portao NEGAR TUDO. Uma linha por pedido recusado, num caminho que qualquer
 * pessoa alcanca sem credencial e sem limite, deixa encher o volume com um `for`
 * -- e o controlo virava a arma. O que E auditado sao as TENTATIVAS DE
 * AUTENTICACAO, e essas passam obrigatoriamente pelo limitador, cujo atraso
 * interno poe um tecto ao ritmo com que alguem consegue produzir linhas.
 */
/** As primitivas da Onda 2, ligadas ao portao. Nada e resolvido por dentro. */
export interface GateAuth {
    readonly secrets: Pick<SecretStore, 'verify'>;
    readonly sessions: Pick<GuardSessionStore, 'validate'>;
    readonly limiter: FailureTracker;
    readonly audit: AuditSink;
    readonly restricted: RestrictedMode;
    readonly tunnelOrigin: Pick<TunnelOriginRegistry, 'current'>;
    /**
     * Consome o `RestrictExposureIntent` de `src/ratelimit/restricted.ts`. A Onda
     * 2 DECIDE e PERSISTE; derrubar a exposicao e desta camada.
     */
    readonly onRestrictExposure: (intent: RestrictExposureIntent) => void;
    /**
     * O atraso INTERNO do limitador. Injetavel para o teste nao esperar 30 s --
     * e so por isso. Nunca vira `Retry-After` (seria o oraculo que D9 proibe).
     */
    readonly wait: (ms: number) => Promise<void>;
}
/**
 * A sessao APRESENTADA neste pedido, se houver uma valida.
 *
 * `readSessionCookie` ja recusa duplicados (cookie shadowing), nome com caixa
 * errada e valor fora do alfabeto base64url. O que sobra aqui e perguntar ao
 * store -- e o store e que sabe de expiracao.
 *
 * NAO LANCA: o `SessionStore` devolve `null` mesmo depois de disposto, porque um
 * pedido em voo durante a desmontagem tem de levar 401 e nao derrubar o host.
 */
export declare function readPresentedSession(req: IncomingMessage, sessions: Pick<GuardSessionStore, 'validate'>): GuardSession | null;
/**
 * O pedido APRESENTA alguma credencial?
 *
 * ===========================================================================
 * A DISTINCAO QUE IMPEDE UM AUTO-DoS, E QUE FOI MEDIDA A DOER
 * ===========================================================================
 * Um pedido ANONIMO -- sem `Authorization` e sem cookie de sessao -- NAO e uma
 * tentativa de autenticacao. E o que o navegador faz dezenas de vezes ao abrir a
 * SPA: `index.html`, o bundle, o `favicon.ico`, cada asset. Trata-los como
 * tentativas falhadas tem tres consequencias, todas medidas nesta suite:
 *
 *   1. AUTO-DoS DO DONO. A partir da 5a, cada asset passa a esperar a escada
 *      (1 s, 2 s, 4 s, 8 s, ...). Carregar a propria interface tornava-se
 *      impossivel -- a corrida da suite de integracao passou de <1 s para 17 s
 *      so com isto;
 *   2. MODO RESTRITO POR ACIDENTE. ~100 assets levam o contador de conta ao teto
 *      NIST, o que ACENDE o modo restrito e DERRUBA o tunel. Abrir a pagina
 *      derrubaria a exposicao;
 *   3. DISCO CHEIO COMO ARMA. Com a auditoria fail-closed, uma linha por pedido
 *      anonimo deixa qualquer pessoa encher o volume do log com um `for` -- e um
 *      log cheio faz o portao NEGAR TUDO. O controlo virava a arma.
 *
 * Isto NAO abre um oraculo. As tres razoes que `02-SEGURANCA.md` 6.1 manda
 * tornar indistinguiveis -- "sem sessao", "sessao expirada", "segredo errado" --
 * continuam a produzir o MESMO 401, com os mesmos bytes: o que muda e apenas se
 * o atraso INTERNO corre, e quem escolheu nao apresentar credencial ja sabe que
 * nao a apresentou. Um atacante que ADIVINHA tem forcosamente de apresentar
 * alguma coisa, e ai e contado e atrasado como antes.
 *
 * Um cookie APRESENTADO E INVALIDO conta como tentativa: adivinhar um id de
 * sessao e forca bruta como qualquer outra.
 */
export declare function presentsCredential(req: IncomingMessage): boolean;
/**
 * A identidade contra a qual o limitador conta falhas.
 *
 * `ip` so aparece quando `mayTrustEdgeClientIp` autoriza -- e, enquanto
 * `exposure.trustEdgeHeaders` for `false`, isso e NUNCA. E por isso que
 * `Identity.ip` e opcional no contrato congelado: sem borda provada, nao ha IP
 * de confianca e o balde colapsa para `session` ou `global`
 * (`resolveIdentityBucket`).
 */
export declare function resolveRequestIdentity(req: IncomingMessage, input: {
    readonly exposure: ExposureConfig;
    readonly viaTunnel: boolean;
    readonly session: GuardSession | null;
}): Identity;
/**
 * A senha apresentada em `Authorization: Basic`.
 *
 * PORQUE SO A SENHA: o utilizador do Basic e fixo (`dsh`) e nao e segredo -- o
 * `cordis.patch.yml` di-lo. O que se compara com o digest e a senha, e e o
 * `SecretStore` quem canonicaliza (tracos, espacos, caixa) e compara em tempo
 * constante. Devolve `''` quando nao ha nada: uma string vazia nunca casa com um
 * digest de 32 bytes, e o caminho continua a ter o mesmo custo.
 */
export declare function presentedSecret(authorizationHeader: string | undefined): string;
/**
 * Regista uma linha de auditoria. Devolve `false` se NAO conseguiu registar.
 *
 * ---------------------------------------------------------------------------
 * A COSTURA ENTRE O FAIL-CLOSED DA AUDITORIA E O 401 UNICO (pendencia herdada)
 * ---------------------------------------------------------------------------
 * `AuditLog.append` LANCA `AuditWriteError` com o disco cheio, e isso e
 * deliberado: um portao que serve pedidos que nao consegue registar esta a
 * mentir sobre a sua unica funcao. Mas a excecao NAO pode subir pelo caminho de
 * autenticacao. Se subisse, a barreira converteria-a num `500` com corpo
 * proprio -- e o atacante passaria a distinguir "credencial errada" (401) de
 * "disco cheio" (500). Isso e um oraculo, e D9 exige o CONTRARIO: TODA falha de
 * autenticacao produz o MESMO `401`, corpo e cabecalhos incluidos.
 *
 * Portanto a excecao e MAPEADA, nunca engolida: fica no log do operador (com o
 * caminho, que e informacao dele) e vira `false`, que o portao le como "nega".
 * Resultado observavel: um 401 IDENTICO, byte a byte, ao de credencial errada.
 *
 * `AuditWriteError.path` NAO ENTRA na mensagem: T2.4 tirou-o de proposito da
 * `message` e po-lo num campo marcado como nao-apresentavel (topologia de
 * disco). Ele vai para o log local -- que e stderr do dono -- e nunca para um
 * corpo HTTP.
 * ---------------------------------------------------------------------------
 */
export declare function recordAudit(auth: Pick<GateAuth, 'audit'>, log: GuardLogger, event: AuditEvent): boolean;
/**
 * Compara a credencial apresentada. SINCRONA (e o `verify` de
 * `runThrottledAttempt`), corre EXATAMENTE UMA VEZ e NUNCA LANCA.
 *
 * DOIS LADOS, SEM CURTO-CIRCUITO. O `|` bit a bit (e nao `||`) e deliberado: com
 * `||` o segundo lado deixaria de correr quando o primeiro acertasse, e o tempo
 * de resposta passaria a dizer QUAL dos dois casou. Assim os dois correm sempre
 * e o custo e o mesmo:
 *
 *   1. `config.encodedAuthString` -- a credencial ESTATICA do manifesto. Hoje
 *      esta normalmente ausente (D19: credencial nao vive em ficheiro
 *      versionavel) e a ausencia significa "ninguem passa por aqui";
 *   2. `SecretStore.verify` -- o segredo de 256 bits gerado pelo plugin, cujo
 *      digest vive no `state.json`. E este o caminho normal do produto.
 *
 * ---------------------------------------------------------------------------
 * PENDENCIA HERDADA: `SecretStore.verify()` PROPAGA `StateError`
 * ---------------------------------------------------------------------------
 * `verify()` le o disco a cada chamada e propaga `StateError` em vez de devolver
 * `false`. Sem tratamento, cada tentativa de forca bruta produziria um `500` --
 * simultaneamente um ORACULO (distingue-se de 401) e um amplificador.
 *
 * DECISAO: MAPEAR PARA `false` E AUDITAR. Nao ha cache do digest, e a razao e
 * dura -- a cache exigiria invalidacao ENTRE PROCESSOS, porque quem chama
 * `rotate()` e o `bin/dsh-guard-setup` (T4.1), que e OUTRO processo. Uma cache
 * que falhe essa invalidacao aceita o segredo ANTIGO depois da rotacao. Trocar
 * um amplificador de DoS -- que ja esta limitado, ver abaixo -- por uma
 * credencial revogada que continua a entrar e a troca errada.
 *
 * PORQUE O AMPLIFICADOR JA ESTA LIMITADO: este `verify` so corre DENTRO de
 * `runThrottledAttempt`, e o atraso interno corre ANTES dele. O atacante nao
 * consegue produzir mais leituras do que a escada de atraso lhe permite -- e ela
 * chega a 30 s por tentativa. O `read`+`parse` por tentativa e o custo de UMA
 * tentativa, nao de um ciclo livre.
 *
 * E `false` e a direccao certa por outra razao ainda: do ponto de vista de quem
 * tenta, "nao ha segredo provisionado" e "nao consegui ler o segredo" tem de ser
 * indistinguiveis, e ambos tem de negar.
 */
export declare function verifyPresentedCredential(input: {
    readonly req: IncomingMessage;
    readonly config: Config;
    readonly auth: Pick<GateAuth, 'secrets' | 'audit'>;
    readonly log: GuardLogger;
    readonly staticCredentialMatches: (header: string | undefined) => boolean;
}): boolean;
export interface AuthenticationInput {
    readonly req: IncomingMessage;
    readonly auth: GateAuth;
    readonly config: Config;
    readonly log: GuardLogger;
    /** Comparacao da credencial ESTATICA do manifesto (`verifyBasicAuth`, ligado pelo portao). */
    readonly staticCredentialMatches: (header: string | undefined) => boolean;
}
export interface AuthenticationOutcome {
    readonly authorized: boolean;
    /** O pedido chegou pelo NOME publico do tunel (nao pelo loopback). */
    readonly viaTunnel: boolean;
    /** A sessao que autorizou o pedido, quando foi ela. */
    readonly session: GuardSession | null;
}
/**
 * Autentica um pedido. **NUNCA LANCA** e **NUNCA devolve `true` num `catch`**.
 *
 * DUAS PORTAS, NESTA ORDEM:
 *
 *   1. SESSAO -- um cookie `__Host-dsh_sid` valido. Nao consome tentativa do
 *      limitador: nao ha nada a adivinhar, o id ja e uma credencial portadora de
 *      256 bits e o store e que sabe se expirou;
 *   2. CREDENCIAL -- Basic estatico OU o segredo do dono, sempre atraves de
 *      `runThrottledAttempt`: atraso ANTES da comparacao, comparacao exatamente
 *      uma vez, veredito depois.
 *
 * O QUE NAO ACONTECE AQUI, e tem de continuar a nao acontecer: o CORPO da
 * requisicao nao e lido, nem tocado. O comando perigoso viaja no corpo do
 * `POST /api/commands/execute`; le-lo no caminho de decisao introduziria consumo
 * de stream, buffering e uma superficie de negacao de servico exatamente no
 * ponto onde nao pode haver nenhuma -- e, nos pedidos aprovados, o corpo ja
 * consumido nunca chegaria ao despacho original.
 */
export declare function authenticateRequest(input: AuthenticationInput): Promise<AuthenticationOutcome>;
/**
 * Reescreve `Host` para o loopback e APAGA `origin`/`sec-fetch-*`.
 *
 * =============================================================================
 * >>> ISTO DESARMA O ANTI-REBINDING DO NUCLEO. LEIA ANTES DE MEXER. <<<
 * =============================================================================
 *
 * O QUE FOI MEDIDO (spike T0.4, `docs/spikes/superficie-ui.md` 6): com o `Host`
 * a valer `*.trycloudflare.com`, o nucleo do DSH devolve **403 em `/api`** e
 * **recusa os dois WebSockets**; com `Host: 127.0.0.1` devolve 404 (o `/api` a
 * dizer que nao conhece o metodo -- ou seja, a cerca DEIXOU passar). A causa e
 * `resolveLanTrust`, que deriva `trustedHosts` apenas de literais IPv4 de LAN e
 * dos `--trusted-host` explicitos: um hostname `*.trycloudflare.com` NUNCA e
 * derivado. Sem `--trusted-host <hostname-do-tunel>` o tunel serve a SPA e o
 * PLANO DE CONTROLO FICA MORTO.
 *
 * A CONTRAPARTIDA, escrita porque tem de estar escrita: apagar `Origin` e
 * `sec-fetch-*` e fingir loopback RETIRA a cerca anti-rebinding do nucleo. A
 * partir daqui **a garantia passa a ser sustentada pela camada L2.5 deste
 * plugin** (`src/http/host-header.ts`), que valida o `Host` REAL contra uma
 * allowlist exata ANTES de qualquer reescrita, e pela validacao de `Origin` no
 * handshake de WebSocket. Se alguem desligar a L2.5, esta funcao passa a ser um
 * buraco -- as duas coisas andam juntas ou nenhuma delas anda.
 *
 * PORQUE ISTO SO CORRE DEPOIS DE AUTENTICAR: um pedido nao autenticado nunca
 * chega ao despacho original, logo nunca precisa da reescrita. Reescrever antes
 * seria entregar ao nucleo, ja disfarcado de loopback, exatamente o pedido que
 * o portao ainda ia recusar.
 *
 * PORQUE SO PARA PEDIDOS DO TUNEL: um pedido de loopback ja tem o `Host` certo
 * e o `Origin` certo -- mexer nele so podia partir o que ja funciona.
 *
 * A ALTERNATIVA CONSIDERADA E REJEITADA: passar `--trusted-host <hostname>` ao
 * DSH. Nao serve para um quick tunnel -- o hostname e ALEATORIO a cada arranque
 * e o `--trusted-host` e um argumento do processo do host, decidido antes de o
 * tunel existir. Ficaria para o modo `named`, onde o hostname e estavel; e
 * exatamente por isso que a reescrita e condicional e nao incondicional.
 */
export declare function rewriteAuthenticatedTunnelRequest(req: IncomingMessage, loopbackAuthority: string): void;
/**
 * Espera o atraso INTERNO do limitador.
 *
 * `unref()` porque um atraso pendente nao pode ser a razao de o processo do host
 * nao conseguir sair: o pedido que estava a ser atrasado ia levar 401 de
 * qualquer forma.
 */
export declare function delay(ms: number): Promise<void>;
/** Teto de baldes vivos do limitador. Ver "MEMORIA" em `src/ratelimit/tracker.ts`. */
export declare const MAX_TRACKED_IDENTITIES = 1024;
export interface GateAuthStackOptions {
    readonly log: GuardLogger;
    readonly tunnelOrigin: TunnelOriginRegistry;
    /** Relogio injetado (`04-TESTES.md` 8.1). Omitido: relogio de parede. */
    readonly clock?: Clock | undefined;
    /** Politica de limite. Omitida: a politica ADOTADA, ja validada no load. */
    readonly policy?: RateLimitPolicy | undefined;
    /** Diretorio de estado ja resolvido -- e por aqui que o teste injecta um temporario. */
    readonly stateDir?: string | undefined;
    /** Caminho do log de auditoria -- idem. */
    readonly auditPath?: string | undefined;
    /** Atraso injetavel, para o teste nao esperar 30 s. */
    readonly wait?: ((ms: number) => Promise<void>) | undefined;
}
/** O que a raiz de composicao recebe: as dependencias do portao mais o disposer. */
export interface GateAuthStack {
    readonly auth: GateAuth;
    /**
     * O `StateStore` que TODA a pilha partilha. Exposto porque T4.1 (o CLI que
     * provisiona e roda o segredo) e T3.4 (a rota de login) precisam do MESMO
     * writer -- `src/contracts/state.ts` congela que ha exatamente um.
     */
    readonly state: StateStore;
    readonly secrets: SecretStoreHandle;
    readonly sessions: GuardSessionStore;
    readonly restricted: RestrictedMode;
    readonly audit: AuditLog;
    readonly limiter: FailureTracker;
    /** Q-2: SINCRONO, LIFO, idempotente. */
    dispose(): void;
}
/**
 * Monta as primitivas da Onda 2 e devolve-as ja ligadas.
 *
 * PORQUE AQUI E NAO EM `src/index.ts`: T3.4 (rota de login) e T4.1 (CLI de
 * arranque) precisam EXATAMENTE do mesmo conjunto -- o mesmo `SessionStore` que
 * o portao valida, o mesmo `SecretStore` que ele compara, o mesmo `StateStore`
 * que e o unico writer. Duas montagens paralelas dariam dois `SessionStore` e um
 * cookie emitido por um nunca validaria no outro.
 *
 * FAIL-CLOSED NA MONTAGEM: se qualquer peca nao subir, a excecao SOBE. Quem
 * chama (a raiz de composicao) transforma-a em "nega tudo" -- nunca em "serve
 * sem portao".
 */
export declare function createGateAuthStack(options: GateAuthStackOptions): GateAuthStack;
/**
 * Deriva a ORIGEM EFETIVA do pedido (`{ scheme, host }`), que e o que
 * `serializeSessionCookie` exige para decidir se pode sequer emitir a sessao.
 *
 * ---------------------------------------------------------------------------
 * A CONDICAO E O MODO, NAO O HOST. Esta e a correccao que este ficheiro traz.
 * ---------------------------------------------------------------------------
 * A tentacao natural e escrever "se o host nao e loopback, entao estamos atras
 * de uma borda, entao confio no `X-Forwarded-Proto`". As duas coisas NAO sao a
 * mesma:
 *
 *   uma instalacao em LAN (`192.168.1.5:3080`, SEM tunel nenhum) e nao-loopback
 *   e NAO tem borda. Ali o cabecalho e escrito por qualquer maquina do segmento,
 *   e a medicao R10 -- que e sobre a borda da Cloudflare -- nao diz nada sobre
 *   esse caso.
 *
 * A condicao correta e `exposure.mode === 'tunnel'` E o pedido ter CHEGADO pelo
 * nome publico do tunel. E a mesma forma de `mayTrustEdgeClientIp`, e por uma
 * razao so: a garantia e da BORDA, logo a pergunta e sempre "este pedido passou
 * pela borda?" e nunca "este pedido parece vir de fora?".
 *
 * ---------------------------------------------------------------------------
 * PORQUE ISTO **NAO** EXIGE `exposure.trustEdgeHeaders`, e o IP exige
 * ---------------------------------------------------------------------------
 * A assimetria e deliberada e vale a pena ser dita, porque parece inconsistencia
 * e nao e. `trustEdgeHeaders` governa a IDENTIDADE do cliente: um IP forjado
 * escolhe o balde do rate limit e a linha do audit log -- e ESCALADA. O esquema
 * nao e identidade: o pior que um esquema forjado produz e um cookie que o
 * navegador recusa (o prefixo `__Host-` exige `Secure`) e um
 * `assertTrustworthyOrigin` que falha ALTO. E negacao de funcao, nao escalada, e
 * cai do lado seguro sozinho.
 *
 * Exigir `trustEdgeHeaders: true` aqui teria o efeito INVERSO do pretendido:
 * com o default (`false`), o esquema pelo tunel seria derivado do socket
 * (`http`), a origem `https://x.trycloudflare.com` deixaria de ser reconhecida,
 * e o login pelo telemovel deixava de funcionar -- sem uma linha de erro que o
 * explicasse.
 *
 * ---------------------------------------------------------------------------
 * PARA QUEM CONSOME: `PanelDeps.resolveOrigin` (T3.4)
 * ---------------------------------------------------------------------------
 * T3.4 deixou a derivacao INJETAVEL de proposito. E esta a implementacao a
 * injetar: ela tem a `Config` e o registo da origem do tunel, que o painel nao
 * tem por que conhecer.
 */
export declare function createRequestOriginResolver(deps: {
    readonly config: Config;
    readonly tunnelOrigin: Pick<TunnelOriginRegistry, 'current'>;
}): (req: IncomingMessage) => {
    readonly scheme: string;
    readonly host: string;
};
//# sourceMappingURL=session-auth.d.ts.map