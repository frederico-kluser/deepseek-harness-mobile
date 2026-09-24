/**
 * =============================================================================
 * A FORMA do `state.json` (`version: 1`), a migracao, e a familia de erros.
 * =============================================================================
 *
 * DONO: T2.5. Implementa `PersistedState` de `src/contracts/state.ts`
 * (CONGELADO no COMMIT PREP 2 — leitura livre, escrita proibida).
 *
 * PORQUE A VALIDACAO E ESTRITA, CAMPO A CAMPO, E NAO UM `as PersistedState`.
 * Este ficheiro guarda o `secretDigest` (a senha do dono, em hash) e o
 * `pairing` (quem manda no bot). Um `JSON.parse(...) as PersistedState` daria
 * ao compilador uma certeza que o disco nao tem: qualquer edicao a mao, qualquer
 * escrita parcial de uma versao anterior, qualquer ficheiro trocado entrava
 * como se fosse valido e so rebentava — ou pior, NAO rebentava — tres camadas
 * a frente. Aqui, o que nao casa exatamente com a forma, LANCA.
 *
 * PORQUE CHAVE DESCONHECIDA E ERRO, e nao "ignora-se". `store.update()` reescreve
 * o ficheiro INTEIRO a partir do que este modulo devolve. Se uma chave que nao
 * conhecemos fosse silenciosamente descartada na leitura, a primeira escrita a
 * seguir APAGAVA-A do disco. E para isso que serve o `version`: a mudanca de
 * forma passa por uma migracao escrita, nao por tolerancia silenciosa.
 *
 * PORQUE UMA CLASSE DE ERRO PROPRIA e nao um codigo novo em `src/errors.ts`:
 * `GuardErrorCode` e a uniao dos codigos da BARREIRA e `src/errors.ts` nao e
 * ficheiro desta sub-tarefa (`03-ONDAS.md` 7: T2.5 possui `src/state/**`).
 * `StateError` vive na camada mais baixa do modulo para que `paths.ts` e
 * `store.ts` a possam lancar sem ciclo de import.
 *
 * Strip-only mode (`node --test` corre estes `.ts` sem os compilar): sem `enum`,
 * sem `namespace`, sem parameter properties. O `code` e campo atribuido a mao.
 */
import type { PersistedState } from '../contracts/state.ts';
/** Codigos estaveis. O operador distingue a causa sem ler prosa. */
export type StateErrorCode = 
/** Caminho de estado inutilizavel (relativo, por exemplo). */
'STATE_PATH_INVALID'
/** O diretorio de estado nao e um diretorio real nosso (link, ficheiro). */
 | 'STATE_DIR_UNSAFE'
/** O `state.json` esta legivel por grupo/outros: recusa-se a carregar. */
 | 'STATE_MODE_TOO_OPEN'
/** O caminho de estado pertence a outro utilizador. */
 | 'STATE_NOT_OWNED'
/** O conteudo existe e nao e um estado valido. NUNCA se recomeca do zero. */
 | 'STATE_CORRUPT'
/** Escrito por uma versao do plugin que este binario nao sabe ler. */
 | 'STATE_VERSION_UNSUPPORTED'
/** A escrita atomica falhou; o ficheiro de destino nao foi tocado. */
 | 'STATE_WRITE_FAILED'
/** O ficheiro existe e nao foi possivel abri-lo (EACCES, EIO, ...). */
 | 'STATE_READ_FAILED'
/** Uso depois do disposer sincrono (Q-2). */
 | 'STATE_STORE_DISPOSED'
/** `update()` chamado de dentro do proprio callback de `update()`. */
 | 'STATE_REENTRANT_UPDATE';
export declare class StateError extends Error {
    readonly name = "StateError";
    readonly code: StateErrorCode;
    constructor(code: StateErrorCode, detail: string);
}
/**
 * A mensagem ACIONAVEL do estado corrompido.
 *
 * `02-SEGURANCA.md` 9 e explicito sobre o anti-padrao: "recriar em silencio:
 * geraria segredo novo sem o dono saber". Recomecar do zero apagaria o
 * `secretDigest` e o `pairing` — na pratica, trocaria a senha do dono e o dono
 * do bot sem que ninguem tenha pedido. Logo: para-se, diz-se ONDE, PORQUE e
 * QUAL e o passo seguinte, e o apagar e um ato DELIBERADO de um humano.
 *
 * O conteudo do ficheiro NUNCA entra na mensagem (Q-4): ela vai para o log do
 * host, ao lado do de outros plugins.
 */
export declare function corruptStateError(source: string, reason: string): StateError;
/** A unica versao que este binario escreve. */
export declare const CURRENT_STATE_VERSION = 1;
/**
 * O estado de um primeiro arranque.
 *
 * `desiredState: 'STOPPED'` e fail-closed: um plugin instalado de fresco NAO
 * abre exposicao nenhuma antes de alguem mandar. `READY` por omissao seria
 * subir tunel a primeira vez que o harness arrancasse.
 */
export declare function emptyState(): PersistedState;
/**
 * Le o `provider` persistido como o enum FECHADO do contrato (D3).
 *
 * AUSENTE NAO E ERRO: o campo e ADITIVO (`PersistedState.provider` opcional) e
 * ausente significa `telegram` — um `state.json` v1 sem o campo continua valido
 * e le no default fechado (D3). PRESENTE tem de ser um dos literais fechados,
 * sob pena de corrupcao; hoje so `telegram`, e um provedor futuro acrescenta um
 * literal AQUI em sintonia com o enum do contrato — nunca em silencio.
 */
export declare const PROVIDER_LITERALS: readonly string[];
/**
 * Le um valor cru (ja desserializado) como `PersistedState` da versao corrente.
 *
 * Hoje ha uma versao so, e por isso a "migracao" e um despacho com um ramo. A
 * forma importa mais do que o conteudo: quando existir `version: 2`, o ramo
 * `case 1` passa a converter em vez de validar, e o ficheiro v1 no disco de
 * alguem continua a arrancar. Sem o despacho, a alternativa historica e sempre
 * a mesma: "nao percebi, comeco do zero".
 */
export declare function migrateState(raw: unknown, source: string): PersistedState;
/**
 * Valida um `PersistedState` ja na versao corrente e devolve uma COPIA normalizada.
 *
 * Usado nos DOIS sentidos: ao ler o disco e ao aceitar o valor devolvido pelo
 * callback de `store.update()`. O store e o unico writer do repositorio; se ele
 * nao validar a saida, o unico writer passa a ser tambem o unico ponto por onde
 * lixo entra no ficheiro sem ninguem ver.
 */
export declare function parsePersistedState(value: unknown, source: string): PersistedState;
/**
 * Bytes a escrever. Ordem de chaves FIXA e `\n` final.
 *
 * A ordem nao e estetica: `JSON.stringify` emite as chaves pela ordem de
 * insercao do objeto, e um objeto construido de forma diferente a cada escrita
 * produziria ficheiros com bytes diferentes e conteudo igual — o que torna
 * impossivel afirmar "o destino NAO foi tocado" por comparacao de bytes, que e
 * exatamente a prova de atomicidade que os testes fazem.
 *
 * As chaves opcionais AUSENTES nao sao escritas como `null`: `null` e um valor,
 * e a leitura estrita recusa-o. Ausente e ausente.
 */
export declare function serializeStateDocument(state: PersistedState): string;
/**
 * Texto do disco -> `PersistedState`.
 *
 * Um ficheiro VAZIO (ou so espacos) e CORRUPCAO, nao "primeiro arranque". A
 * ausencia de estado e a ausencia do FICHEIRO — isso `store.read()` trata. Um
 * ficheiro de zero bytes so aparece se alguem o truncou, e tratar truncagem
 * como "novo" e a porta exata para trocar a senha do dono em silencio.
 */
export declare function parseStateDocument(text: string, source: string): PersistedState;
//# sourceMappingURL=schema.d.ts.map