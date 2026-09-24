/**
 * =============================================================================
 * UNICO ponto do repositorio que toca a API do DSH.
 * =============================================================================
 *
 * PORQUE UM SO FICHEIRO: uma breaking change do host passa a ser a edicao de um
 * ficheiro, e nao uma caca a `import` espalhados por vinte modulos. Item de
 * aceite da Onda 1: `grep -rl '@deepseek-ai/' src` tem de devolver so este
 * caminho. Todo o resto do `src/**` fala com o host atraves dos tipos e das
 * funcoes REEXPORTADOS daqui.
 *
 * REGRA Q-1 -- a fonte da API e o `.d.ts` do tarball, nunca prosa. Os
 * especificadores `@deepseek-ai/*` resolvem, por `paths` do `tsconfig.json`,
 * para os espelhos byte-exatos em `types/**`, verificados por
 * `test/contract/dsh-types.test.ts` (CONTRACT-001..009).
 *
 * NOMES QUE ESTAO CERTOS E NAO SE MEXEM (medicao da Onda 0 contra as 9 versoes
 * publicadas): o servico chama-se `webServer` e a classe `WebServer` de
 * `0.1.0-rc.3` ate `0.1.0-rc.8`; `httpServer`/`HttpServerService` so existiu em
 * `0.0.1-rc.1`/`rc.2`, uma linha morta cuja etiqueta `latest` esta estagnada.
 * Este projeto esta pinado em `0.1.0-rc.7`.
 * =============================================================================
 */
import { Server } from 'node:http';
import { GuardError } from "../errors.js";
/* ========================================================================== */
/* Acesso ao servidor node:http por baixo do servico                          */
/* ========================================================================== */
/**
 * Localiza o `node:http.Server` dentro do servico `webServer`.
 *
 * PORQUE E PRECISO: a barreira de autenticacao troca o dono do DESPACHO
 * (`src/http/intercept.ts`). O campo chama-se `server` e e `private` APENAS em
 * TypeScript -- no `lib/index.js` publicado e um campo de classe comum
 * (`this.server = createServer(...)`). O varrimento por `instanceof Server`
 * sobre `Object.getOwnPropertyNames` e a rede de seguranca contra uma
 * renomeacao do campo numa versao futura.
 *
 * E o UNICO campo `private` a que este plugin se acopla. A alternativa medida
 * (reescrever as tabelas de rota) acopla a tres ou quatro.
 *
 * FALHA ALTO, sempre: um servidor nao localizavel significa "sem barreira", e
 * "sem barreira" e uma credencial universal. Nunca degradar em silencio.
 */
export function resolveWebServerHttpServer(webServer) {
    if (webServer === undefined || webServer === null) {
        throw new GuardError('BARRIER_UNAVAILABLE', 'o servico webServer nao esta disponivel.');
    }
    const candidate = webServer.server;
    if (candidate instanceof Server)
        return candidate;
    const bag = webServer;
    for (const key of Object.getOwnPropertyNames(webServer)) {
        let value;
        try {
            value = bag[key];
        }
        catch {
            // Um getter que lanca nao e o campo que procuramos.
            continue;
        }
        if (value instanceof Server)
            return value;
    }
    throw new GuardError('BARRIER_UNAVAILABLE', 'nenhum node:http.Server foi encontrado no servico webServer ' +
        `(campos inspecionados: ${Object.getOwnPropertyNames(webServer).join(', ') || 'nenhum'}).`);
}
//# sourceMappingURL=adapter.js.map