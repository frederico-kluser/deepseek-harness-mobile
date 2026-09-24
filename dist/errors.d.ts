/**
 * Hierarquia de erro tipada + codigos estaveis (05-QUALIDADE-CODIGO.md 6.1).
 *
 * PORQUE UM CODIGO E NAO SO UMA MENSAGEM: a mensagem e para o operador e muda
 * quando a redaccao melhora; o codigo e para o programa (testes, auditoria,
 * futuros ouvintes) e nao pode mudar sem ser uma quebra deliberada.
 */
/**
 * Nome do PLUGIN (identidade do modulo perante o motor Cordis).
 *
 * PORQUE VIVE AQUI e nao em `src/index.ts`: e usado como PREFIXO de toda a
 * mensagem de erro de configuracao (`[<nome>] config.x ...`), e `src/index.ts`
 * importa `src/config/**`. Declarar a constante na raiz de composicao criava um
 * ciclo `index -> config/assert -> index` cujo unico efeito seria uma zona
 * morta temporal na inicializacao do modulo. `src/index.ts` reexporta-a como
 * `name`, que e o que o motor le.
 *
 * NOTA: nao confundir com o `id` usado no `cordis.patch.yml`
 * (`guard-messenger`). O `id` identifica a ENTRADA de configuracao
 * numa camada de patch; o `name` identifica o pacote/modulo a resolver.
 */
export declare const PLUGIN_NAME = "dsh-guard-messenger";
/**
 * Codigos estaveis. Cada um corresponde a uma condicao que o operador tem de
 * conseguir distinguir sem ler prosa.
 */
export type GuardErrorCode = 
/** O `node:http.Server` do `webServer` nao e localizavel: sem ele nao ha barreira. */
'BARRIER_UNAVAILABLE'
/** Ja existe uma barreira instalada neste servidor; empilhar duas e recusado. */
 | 'BARRIER_ALREADY_INSTALLED'
/** Na reversao, o despacho ja nao e nosso: os originais NAO foram reinstalados. */
 | 'BARRIER_OWNERSHIP_LOST';
/**
 * Erro do plugin com codigo legivel por programa.
 *
 * A `message` publica ja vem prefixada com o nome do plugin, porque estes erros
 * sobem para o log do DSH no meio do de outros plugins e um erro sem dono e um
 * erro que ninguem investiga.
 */
export declare class GuardError extends Error {
    readonly name = "GuardError";
    readonly code: GuardErrorCode;
    constructor(code: GuardErrorCode, detail: string);
}
//# sourceMappingURL=errors.d.ts.map