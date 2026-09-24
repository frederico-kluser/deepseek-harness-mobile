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
export const PLUGIN_NAME = 'dsh-guard-messenger';
/**
 * Erro do plugin com codigo legivel por programa.
 *
 * A `message` publica ja vem prefixada com o nome do plugin, porque estes erros
 * sobem para o log do DSH no meio do de outros plugins e um erro sem dono e um
 * erro que ninguem investiga.
 */
export class GuardError extends Error {
    name = 'GuardError';
    code;
    // Campo declarado e atribuido a mao, e nao uma "parameter property": o
    // `node --test` corre os `.ts` em STRIP-ONLY MODE, que recusa essa sintaxe
    // (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) porque ela EMITE codigo em vez de so
    // apagar tipos. A mesma regra vale para `enum` e `namespace`.
    constructor(code, detail) {
        super(`[${PLUGIN_NAME}] ${code}: ${detail}`);
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map