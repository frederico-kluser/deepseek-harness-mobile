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
import type { SecretStore, SessionStore } from '../contracts/auth.ts';
import type { StateStore } from '../contracts/state.ts';
/**
 * Dependencias injetadas.
 *
 * `sessions` NAO E OPCIONAL de proposito. Uma rotacao que nao invalida as
 * sessoes vivas deixa o portador de um cookie antigo a entrar com o segredo que
 * acabou de ser revogado -- o modo de falha exato que a pergunta falsificavel 4
 * de T2.1 procura. Torna-lo obrigatorio faz o compilador recusar a fiacao
 * incompleta em vez de a deixar passar em silencio.
 */
export interface SecretStoreDeps {
    readonly state: StateStore;
    readonly sessions: Pick<SessionStore, 'revokeAll'>;
}
/** Ja existe segredo: substitui-lo em silencio trocaria a senha do dono sem aviso. */
export declare class SecretAlreadyProvisionedError extends Error {
    readonly name = "SecretAlreadyProvisionedError";
}
/**
 * O `SecretStore` do contrato mais `hasSecret()`.
 *
 * PORQUE MAIS UM METODO: o contrato congelado tem exatamente tres, e continua a
 * ser satisfeito. Mas o CLI de arranque (T4.1) precisa de decidir entre
 * `provision()` e `rotate()` ANTES de chamar um deles, e a unica alternativa
 * seria chamar `provision()` e apanhar a excecao -- controlo de fluxo por
 * excecao para uma pergunta que e um booleano.
 */
export interface SecretStoreHandle extends SecretStore {
    /** `true` se ja ha digest persistido. */
    hasSecret(): boolean;
}
export declare function createSecretStore(deps: SecretStoreDeps): SecretStoreHandle;
//# sourceMappingURL=store.d.ts.map