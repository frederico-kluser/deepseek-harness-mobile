/**
 * `SessionStore`: emissao, lookup, expiracao (inatividade 60 min, absoluto 8 h)
 * e disposer sincrono. PURO -- nenhuma rota HTTP vive aqui (03-ONDAS.md 7).
 *
 * DONO: T2.2.
 *
 * ------------------------------------------------------------------------
 * O QUE ESTE MODULO E, E O QUE NAO E
 * ------------------------------------------------------------------------
 * E o dono do CICLO DE VIDA da sessao: quem a emite, quem a valida, quando ela
 * morre. Nao sabe o que e um pedido HTTP, nao le cabecalhos e nao decide
 * resposta -- isso e do portao (T3.3) e das rotas (T3.4). A Onda 2 e
 * "primitivas sem fiacao" por construcao: construir o modulo e ligar o modulo
 * sao etapas separadas, e misturar as duas colapsa o paralelismo da onda.
 *
 * ------------------------------------------------------------------------
 * INVARIANTE: SO EXISTE SESSAO AUTENTICADA
 * ------------------------------------------------------------------------
 * Este store NUNCA emite sessao anonima. Um id so nasce DEPOIS de a credencial
 * ter sido verificada (segredo, Basic ou `mk` do link magico). Isso e metade da
 * defesa contra SESSION FIXATION; a outra metade e `regenerate()`, que destroi
 * o id que o cliente APRESENTOU antes de emitir o novo. Um atacante que planta
 * um cookie de sessao no navegador da vitima (via subdominio, via XSS noutra
 * aplicacao, via link) nao ganha nada: no instante em que a vitima autentica,
 * o id plantado deixa de existir do lado do servidor.
 *
 * >>> T3.4: chame SEMPRE `regenerate(idApresentado)` no caminho de login.
 * >>> `create()` existe porque o contrato congelado o exige e e apenas o alias
 * >>> de `regenerate(undefined)` -- usa-lo quando o cliente APRESENTOU um id e
 * >>> deixar a fixacao viva.
 *
 * ------------------------------------------------------------------------
 * O ID NAO E GUARDADO EM CLARO
 * ------------------------------------------------------------------------
 * O mapa e indexado por `sha256(id)` em hex; o id em claro existe uma unica vez
 * -- no instante da emissao -- e a partir dai so o cliente o tem. Tres
 * consequencias, todas deliberadas:
 *   1. um despejo de memoria do processo nao entrega sessoes vivas;
 *   2. `validate()` devolve como `id` a PROPRIA string apresentada pelo
 *      chamador, ja com marca -- nao ha copia do lado do servidor para vazar;
 *   3. o `idHash` que vai para o log de auditoria (`AuditEvent.sessao_id_hash`)
 *      nasce aqui, e nao no modulo de audit, para que nenhum outro ficheiro
 *      precise de tocar no id em claro para o poder correlacionar.
 *
 * Q-4 (segredo nunca em argv/log/mensagem/disco em claro) vale para o id de
 * sessao: ele E uma credencial portadora. Nenhuma mensagem de erro deste
 * ficheiro inclui o valor apresentado.
 */
import { inspect } from 'node:util';
import type { SessionId } from '../brand.ts';
import type { Session, SessionStore } from '../contracts/auth.ts';
/**
 * 32 bytes = 256 bits de CSPRNG.
 *
 * O piso normativo e 128: ASVS 5.0 **7.2.3** -- *"Verify that if reference
 * tokens are used to represent user sessions, they are unique and generated
 * using a cryptographically secure pseudo-random number generator (CSPRNG) and
 * possess at least 128 bits of entropy"*. 256 bits e folga barata (43 octetos
 * em base64url) e alinha com o tamanho do segredo de T2.1.
 */
export declare const SESSION_ID_BYTES = 32;
/** Inatividade: 60 min sem uso e a sessao morre (02-SEGURANCA.md 10.3). */
export declare const SESSION_IDLE_TIMEOUT_MS: number;
/** Teto absoluto: 8 h desde a emissao, com ou sem atividade. */
export declare const SESSION_ABSOLUTE_TIMEOUT_MS: number;
/**
 * Teto de sessoes vivas.
 *
 * DEFESA EM PROFUNDIDADE, NAO O CONTROLO PRIMARIO: so um login BEM-SUCEDIDO
 * cria sessao, e o caminho de login e limitado por T2.3. O teto existe para o
 * caso em que o dono (ou um script dele) autentica em ciclo e deixa sessoes
 * vivas a acumular durante 8 h. Ao encher, morre a sessao com o uso mais
 * antigo -- a que estava mais perto de expirar por inatividade de qualquer
 * forma.
 */
export declare const SESSION_MAX_LIVE = 64;
/**
 * Relogio injetado (D6, 04-TESTES.md 8.1).
 *
 * A interface e declarada AQUI e nao importada de `test/support/clock.ts`
 * porque `src/**` nao pode depender de `test/**`. A tipagem estrutural do
 * TypeScript faz o `FakeClock` do prep encaixar sem qualquer adaptador -- e e
 * com ele que os testes forcam 60 min e 8 h sem esperar 8 h e sem contaminar a
 * suite inteira com um `Date.now()` global falsificado.
 */
export interface Clock {
    now(): number;
}
/** Relogio de producao. */
export declare const systemClock: Clock;
/** A forma redigida de uma sessao: tudo menos o portador. */
export interface RedactedSession {
    readonly id: string;
    readonly criadaEm: number;
    readonly ultimoUsoEm: number;
    readonly idHash: string;
}
/**
 * Sessao viva, com o hash curto que o log de auditoria consome.
 *
 * AS DUAS REDACCOES NAO SAO OPCIONAIS, e uma so nao chega. O `id` que este
 * objeto carrega E a credencial portadora -- hashear as chaves do mapa para que
 * um despejo de memoria nao entregue sessoes e depois devolver ao chamador um
 * objeto liso que qualquer serializador despeja inteiro seria fechar a porta e
 * deixar a janela aberta. Sao dois caminhos DISTINTOS e ambos foram medidos:
 *
 *   JSON.stringify(sessao)  -> fechado por `toJSON()`
 *   util.inspect(sessao)    -> fechado por `[inspect.custom]`
 *
 * O segundo e o que apanha `console.log(sessao)`, `console.error` e o
 * formatador de qualquer logger que receba o objeto em vez da string -- que e o
 * habito mais comum de todos, e por isso o caminho de fuga mais provavel.
 * Quem precisa mesmo do id tem de o pedir pelo nome (`sessao.id`), que e um
 * gesto deliberado e revistavel; o que nao pode e o id sair por acidente.
 */
export interface GuardSession extends Session {
    /**
     * Primeiros 16 hex de `sha256(id)`: 64 bits de um digest resistente a
     * pre-imagem sobre um valor de 256 bits. Serve para correlacionar linhas de
     * log entre si; NAO permite reconstruir o id.
     */
    readonly idHash: string;
    toJSON(): RedactedSession;
    [inspect.custom](): RedactedSession;
}
export interface SessionStoreDeps {
    readonly clock: Clock;
    /**
     * Fonte de aleatoriedade. So se injeta em teste -- o default e
     * `crypto.randomBytes`. `Math.random` NAO e um CSPRNG e nao pode aparecer
     * aqui em caminho nenhum (SESS-001).
     */
    readonly randomBytes?: (size: number) => Uint8Array;
}
/**
 * O store concreto. Estende o contrato congelado em vez de o alterar: o
 * contrato fixa o minimo que o portao consome (`create`/`validate`/`revokeAll`)
 * e nao podia crescer no meio da onda sem parar as cinco sub-tarefas.
 */
export interface GuardSessionStore extends SessionStore {
    /** Alias de contrato para `regenerate(undefined)`. Ver o aviso no topo. */
    create(): SessionId;
    /**
     * ANTI-FIXATION. Invalida `previousId` (se existir) e emite um id novo.
     * Chamado APOS a credencial ser aceite, nunca antes.
     *
     * O PARAMETRO ADITIVO `metadados` guarda, no nascimento da sessao, o que
     * o acesso monitoring precisa e nao esta noutro sitio: o `user-agent` do
     * pedido que autenticou e o IP (SO quando a borda o garante — ver
     * `src/http/session-auth.ts` e `mayTrustEdgeClientIp`). Omitir continua a
     * emitir sessao sem metadados — aditivo, nao quebra chamadores existentes.
     */
    regenerate(previousId: string | undefined, metadados?: RegistroDeAcesso): SessionId;
    validate(id: string): GuardSession | null;
    /** Logout: invalida do lado do SERVIDOR, nao apenas apaga o cookie. */
    revoke(id: string): boolean;
    /** Rotacao de segredo, queda do tunel, modo restrito. */
    revokeAll(): void;
    /** Disposer SINCRONO (Q-2). Idempotente. */
    dispose(): void;
    /** Sessoes vivas (sem varrer expiradas). Observabilidade e teste. */
    readonly live: number;
    /**
     * PROJECCAO DE ACESSO — lista as sessoes vivas com o minimo de que o
     * painel de metricas precisa. ADITIVO a `live`: devolve SEMPRE o `idHash`
     * (digest, nunca o portador), os instantes e os metadados de acesso quando
     * foram capturados. Nao vaza o id em claro nem o `?key`.
     */
    listar(): ReadonlyArray<RegistroDeSessao>;
}
/** O que o acesso monitoring captura no nascimento de uma sessao. */
export interface RegistroDeAcesso {
    /** `User-Agent` do pedido que criou a sessao. Nunca emitida a altura (curta). */
    readonly userAgent?: string | undefined;
    /**
     * IP normalizado do cliente, SO quando `mayTrustEdgeClientIp` o garante
     * (`exposure.trustEdgeHeaders` + tunel + borda). Ausente = `undefined`.
     */
    readonly ip?: string | undefined;
}
/** Uma sessao sob a forma redigida que o painel de acesso consome. */
export interface RegistroDeSessao {
    /** `sha256(id)` — nunca o id em claro, nunca o `?key`. */
    readonly idHash: string;
    readonly criadaEm: number;
    readonly ultimoUsoEm: number;
    /** Presente sse capturado no nascimento; caso contrario `undefined`. */
    readonly userAgent?: string | undefined;
    /** Presente sse confiavel; caso contrario `undefined`. */
    readonly ip?: string | undefined;
}
/**
 * Constroi o store.
 *
 * @param deps relogio obrigatorio; fonte de bytes so em teste.
 */
export declare function createSessionStore(deps: SessionStoreDeps): GuardSessionStore;
//# sourceMappingURL=store.d.ts.map