/**
 * Token anti-CSRF das rotas POST do painel.
 *
 * DONO: T3.4.
 *
 * ------------------------------------------------------------------------
 * PORQUE EXISTE, SE O COOKIE JA E `__Host-` + `SameSite=Strict`
 * ------------------------------------------------------------------------
 * Duas razoes, e a segunda e a que decide.
 *
 * 1. DEFESA EM PROFUNDIDADE. NIST SP 800-63B-4 5.1.1 e normativo e nao admite
 *    a troca: *"POST/PUT content SHALL contain a session identifier that the RP
 *    SHALL verify to protect against CSRF"*. A OWASP e igualmente direta:
 *    `SameSite` sozinho NAO basta. Um `SameSite=Strict` mal aplicado, um
 *    navegador antigo, uma rota que amanha aceite `GET` -- qualquer um destes
 *    reabre o buraco, e nenhum deles e visivel em revisao de codigo.
 *
 * 2. `POST /__guard/magic` ACONTECE ANTES DE HAVER SESSAO. Nao ha cookie para o
 *    `SameSite` proteger, logo o cookie NAO PODE ser a unica defesa dessa rota.
 *    Isto sozinho ja obriga a que o token exista e a que ele NAO dependa da
 *    sessao -- e e por isso que a assinatura e sobre um "vinculo" arbitrario e
 *    nao sobre um id de sessao.
 *
 * ------------------------------------------------------------------------
 * PORQUE O TOKEN E SEM ESTADO (HMAC), E NAO UMA ENTRADA NUM MAPA
 * ------------------------------------------------------------------------
 * `GET /__guard/magic` TEM DE SER INERTE (D3, MAG-001): um pre-carregamento do
 * cliente de Telegram, de um scanner de antiphishing ou do proprio
 * pre-visualizador de links nao pode custar NADA ao servidor. Um token guardado
 * num mapa transformava cada pre-carregamento numa escrita: ou o mapa cresce sem
 * limite (memoria como alvo), ou ele tem teto e o pre-carregamento passa a
 * DESPEJAR o token que o dono ainda vai usar. As duas saidas sao piores do que
 * o problema.
 *
 * Um HMAC sobre `(vinculo, expiracao)` com uma chave por processo emite sem
 * escrever e verifica sem ler. O `GET` continua a ser uma funcao pura do pedido.
 *
 * ------------------------------------------------------------------------
 * O QUE ESTE TOKEN NAO E -- e a honestidade importa aqui
 * ------------------------------------------------------------------------
 * Ele NAO e uma credencial e nao autentica ninguem. Quem alcanca o servidor
 * pelo lado do servidor (um `curl` de outra maquina) consegue emitir um token
 * para si proprio pedindo qualquer pagina publica nossa. Isso nao e uma falha
 * do desenho: e a definicao de CSRF. O ataque que este token fecha e o do
 * NAVEGADOR DA VITIMA -- uma pagina de terceiros que dispara um `POST` para nos
 * aproveitando a autoridade ambiente do dono. Essa pagina NAO consegue ler a
 * nossa resposta (o navegador bloqueia a leitura entre origens, e nos nao
 * emitimos cabecalho CORS nenhum), logo nao consegue extrair o token.
 * Quem se autentica continua a ser o `mk` ou o segredo, nunca isto.
 */
/**
 * Cabecalho que transporta o token.
 *
 * SEGUNDO CONTROLO DE GRACA: um formulario HTML de outra origem NAO consegue
 * definir um cabecalho proprio -- so `fetch`/`XHR` conseguem, e esses caem no
 * preflight de CORS, que nunca respondemos. O campo de corpo continua aceite
 * porque um `<form>` da NOSSA propria pagina e o caminho que funciona sem
 * JavaScript.
 */
export declare const CSRF_HEADER_NAME = "x-dsh-csrf";
/** Nome do campo equivalente no corpo (`form` ou JSON). */
export declare const CSRF_FIELD_NAME = "csrf";
/**
 * 30 minutos.
 *
 * Curto o bastante para que um token colhido de uma pagina esquecida num
 * separador nao valha um dia inteiro; longo o bastante para que o dono leia o
 * ecra do link magico, decida, e ainda consiga tocar no botao. O `mk` que ele
 * protege ja morre aos 120 s -- este prazo nunca e o limitante do caso feliz.
 */
export declare const CSRF_TTL_MS: number;
/** 256 bits de chave de assinatura, por processo. Nunca sai deste modulo. */
export declare const CSRF_KEY_BYTES = 32;
/**
 * Relogio injetado, estruturalmente igual ao `Clock` de `test/support/clock.ts`.
 * Declarado aqui porque `src/**` nao importa de `test/**`.
 */
export interface CsrfClock {
    now(): number;
}
export interface CsrfDeps {
    readonly clock: CsrfClock;
    /** So se muda em teste; o valor de producao e {@link CSRF_TTL_MS}. */
    readonly ttlMs?: number;
    /**
     * Chave de assinatura. Omitida = 256 bits novos de CSPRNG por processo.
     *
     * A consequencia de ser por processo e deliberada: reiniciar o plugin invalida
     * todos os tokens em voo. Isso e correto -- as sessoes tambem morrem no
     * reinicio (sao em memoria), e o `mk` tambem.
     */
    readonly key?: Uint8Array;
}
export interface CsrfGuard {
    /**
     * Emite um token para um VINCULO.
     *
     * O vinculo e o que impede um token colhido numa rota de valer noutra: nas
     * rotas com sessao e o `idHash` da sessao (nunca o id em claro, que e a
     * credencial portadora); nas rotas publicas e a chave da propria rota.
     */
    issue(binding: string): string;
    /** Verifica em tempo constante. Qualquer duvida devolve `false`. */
    verify(token: unknown, binding: string): boolean;
}
export declare function createCsrfGuard(deps: CsrfDeps): CsrfGuard;
//# sourceMappingURL=csrf.d.ts.map