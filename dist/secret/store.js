/**
 * `SecretStore`: provisiona, verifica e roda o segredo do dono.
 *
 * SO O DIGEST VAI A DISCO, e NUNCA por `fs` deste modulo. Este ficheiro nao
 * importa `node:fs` -- a escrita passa toda pelo `StateStore` de T2.5, que e o
 * UNICO writer do `state.json` em todo o repositorio (invariante congelada com
 * `src/contracts/state.ts`). E dele tambem o modo 0600 do ficheiro e a recusa de
 * carregar um estado mais frouxo do que isso; duplicar aqui um `chmod` seria
 * fingir uma garantia que nao e desta camada.
 *
 * O SEGREDO EM CLARO NUNCA E CAMPO. Ele existe como variavel LOCAL de
 * `install()`, o tempo de ser hasheado e embrulhado para apresentacao, e sai de
 * ambito no retorno. Nao ha propriedade no objeto devolvido, nao ha cache, nao
 * ha log -- nem em nivel `debug` (Q-4). O que o chamador recebe e `display`, que
 * ele MOSTRA e nao guarda.
 */
import { toSecretDigest } from "../brand.js";
import { generateSecret, renderSecretPanel } from "./generate.js";
import { digestSecret, verifySecret } from "./verify.js";
/** Ja existe segredo: substitui-lo em silencio trocaria a senha do dono sem aviso. */
export class SecretAlreadyProvisionedError extends Error {
    name = 'SecretAlreadyProvisionedError';
}
export function createSecretStore(deps) {
    /**
     * Le o digest persistido.
     *
     * Um digest presente mas malformado LANCA (via `toSecretDigest`) em vez de
     * virar `undefined`. Silenciar seria transformar "estado corrompido" em
     * "ainda nao ha segredo", e o passo seguinte de um instalador seria
     * provisionar um segredo NOVO por cima -- trocando a senha do dono por causa
     * de um byte trocado.
     */
    const readDigest = () => {
        const persisted = deps.state.read().secretDigest;
        return persisted === undefined ? undefined : toSecretDigest(persisted);
    };
    const install = () => {
        const secret = generateSecret();
        const digest = digestSecret(secret);
        deps.state.update((previous) => ({ ...previous, secretDigest: digest }));
        return { display: renderSecretPanel(secret) };
    };
    return {
        hasSecret: () => readDigest() !== undefined,
        provision: () => {
            if (readDigest() !== undefined) {
                throw new SecretAlreadyProvisionedError('ja existe um segredo provisionado; para o substituir use rotate(), que invalida as sessoes vivas');
            }
            return install();
        },
        verify: (candidate) => verifySecret(candidate, readDigest()),
        /**
         * ROTACAO: revoga PRIMEIRO, publica depois.
         *
         * Se a ordem fosse a inversa e a escrita do estado falhasse a meio, ficavam
         * sessoes vivas emitidas sob o segredo antigo com um digest novo ja em
         * disco. Nesta ordem, a falha deixa o sistema no estado mais fechado
         * possivel: ninguem autenticado e o segredo antigo ainda valido para
         * recomecar.
         */
        rotate: () => {
            deps.sessions.revokeAll();
            return install();
        },
    };
}
//# sourceMappingURL=store.js.map