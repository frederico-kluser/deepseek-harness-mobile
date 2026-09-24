/**
 * Token anti-CSRF das rotas POST da superficie de UI nativa do DSH.
 *
 * DONO: T5.5 (esta sub-tarefa). O painel tem o SEU proprio em
 * `src/panel/csrf.ts` (T3.4 -> T5.3); este e o da terceira superficie, com a
 * MESMA doutrina e o MESMO formato, mas independente de proposito:
 *
 *   (a) `src/panel/**` e de OUTRA sub-tarefa desta onda — acoplar a superficie
 *       ao ficheiro de T5.3 seria uma dependencia entre worktrees paralelas;
 *   (b) o vinculo deste guard e o da superficie ('ui-contrib'), nao o de uma
 *       rota do painel.
 *
 * A DOUTRINA (igual a do painel): NIST SP 800-63B-4 5.1.1 — "POST/PUT content
 * SHALL contain a session identifier that the RP SHALL verify" — e a OWASP:
 * `SameSite` sozinho NAO basta. O gate ja exige credencial para SERVIR a
 * pagina onde os botoes vivem (a Web UI do DSH esta atras da barreira), mas o
 * ataque que este token fecha e o do NAVEGADOR DA VITIMA: uma pagina de
 * terceiros a disparar um POST contra a URL do tunel aproveitando a autoridade
 * ambiente do dono. Essa pagina nao consegue LER a nossa resposta (sem CORS),
 * logo nao consegue extrair o token da rota `GET /__guard-ui/api/csrf` (HIGH-2,
 * a unica fonte desde que o chrome da home saiu).
 *
 * SEM ESTADO (HMAC sobre (vinculo, expiracao), chave por processo), pela
 * MESMA razao do painel: cada emissao e um GET barato e stateless, e um token
 * guardado num mapa transformaria cada fetch numa escrita.
 *
 * O TOKEN NAO E CREDENCIAL: quem alcanca o servidor pelo lado do servidor
 * consegue emitir um token para si proprio. E a definicao de CSRF — o que o
 * token fecha e a extracao por leitura de resposta, nao a posse do servidor.
 */
/** Cabecalho que transporta o token (o mesmo nome do painel). */
export declare const CSRF_HEADER_NAME = "x-dsh-csrf";
/** Nome do campo equivalente no corpo JSON. */
export declare const CSRF_FIELD_NAME = "csrf";
/**
 * 30 minutos — o mesmo prazo do painel. Curto o bastante para que um token
 * colhido de uma pagina esquecida num separador nao valha um dia inteiro;
 * longo o bastante para o dono ler o ecra e tocar no botao.
 */
export declare const CSRF_TTL_MS: number;
/** 256 bits de chave de assinatura, por processo. Nunca sai deste modulo. */
export declare const CSRF_KEY_BYTES = 32;
/** Relogio injetado, estruturalmente igual ao `Clock` de `test/support/clock.ts`. */
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
     * A consequencia de ser por processo e deliberada: reiniciar o plugin
     * invalida todos os tokens em voo. Isso e correto — as sessoes tambem morrem
     * no reinicio (sao em memoria).
     */
    readonly key?: Uint8Array;
}
export interface CsrfGuard {
    /**
     * Emite um token para um VINCULO.
     *
     * O vinculo e o que impede um token colhido num sitio de valer noutro: para
     * a superficie, o vinculo e a propria superficie ('ui-contrib') — o mesmo
     * token vale nas quatro rotas POST dela, e so nelas.
     */
    issue(binding: string): string;
    /** Verifica em tempo constante. Qualquer duvida devolve `false`. */
    verify(token: unknown, binding: string): boolean;
}
export declare function createCsrfGuard(deps: CsrfDeps): CsrfGuard;
//# sourceMappingURL=csrf.d.ts.map