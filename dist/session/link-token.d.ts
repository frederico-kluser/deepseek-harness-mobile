/**
 * `LinkTokenStore` -- a "chave no link" do portao (onda 1, remocao do login).
 *
 * ------------------------------------------------------------------------
 * O QUE ESTE STORE E
 * ------------------------------------------------------------------------
 * O modelo novo do portao NAO pede credencial ao navegador: o acesso pelo
 * TUNEL entra por SESSAO ou pela CHAVE NO LINK (`GET /?key=<token>`). Este
 * store e o dono dessa chave. O "link do bot" (Onda 2) compoe a URL com
 * `?key=<token>` ao emitir; o portao (`src/http/gate.ts`) valida o candidato
 * com `verificar()`; a rotacao do segredo revoga-o; a queda do tunel e o
 * despareamento podem derrubar tudo com `limparTudo()`.
 *
 * DIFERENCAS DELIBERADAS PARA O `MagicStore` (`src/session/magic.ts`):
 *
 *   - REUTILIZAVEL. O `mk` do link magico e UMA vez (120 s, uso unico); esta
 *     chave vale ATE `revogar()` (rotacao do segredo, fecho do tunel). Nao e
 *     de uso unico: o mesmo link pode autenticar outra sessao.
 *   - TTL NAO OBRIGATORIO. A chave fecha com a rotacao do segredo ou com a
 *     queda da exposicao -- nao com o relogio. `expiraEm` existe na interface
 *     porque a superficie pode querer apresenta-lo, mas esta implementacao
 *     nao impoe prazo (undefined).
 *
 * ------------------------------------------------------------------------
 * Q-4 / Q-2 -- AS MESMAS REGRAS DO MAGIC, ADAPTADAS
 * ------------------------------------------------------------------------
 *   1. O mapa e indexado por `sha256(token)`; o token em claro existe uma
 *      unica vez, no retorno de `emitir()`, e dali so na URL que o dono
 *      recebe. Nunca e campo de nenhum objeto persistido/logado;
 *   2. a verificacao e TIMING-SAFE sobre os digests de 32 bytes (o mesmo
 *      padrao do `verifySecret` de `src/secret/verify.ts` e do `MagicStore`);
 *   3. o token redige-se em `JSON.stringify` e em `util.inspect`
 *      (`[inspect.custom]`), pelos mesmos dois caminhos que o magic fecha;
 *   4. nada em erro deste ficheiro inclui o valor apresentado;
 *   5. disposer SINCRONO e idempotente (Q-2).
 *
 * NENHUMA mensagem deste ficheiro expoe o token em claro.
 */
import { inspect } from 'node:util';
import type { Clock } from './store.ts';
/** 32 bytes = 256 bits de CSPRNG (igual ao id de sessao; piso ASVS 128). */
export declare const LINK_TOKEN_BYTES = 32;
/** Teto de chaves vivas. Uma so por instalacao e o normal; o teto impede uma
 * `emitir()` em ciclo de acumular estado durante horas. */
export declare const LINK_TOKEN_MAX_LIVE = 8;
/** Codifica bytes para base32 (RFC 4648, sem padding na saida por limpeza). */
export declare function encodeBase32(data: Uint8Array): string;
/**
 * Comparacao constante no tempo entre o candidato e TODA a tabela.
 *
 * O `MagicStore` indexa pelo digest e portanto nao precisa de varrer; aqui o
 * padrao e ligeiramente diferente porque ha (normalmente) UM unico token vivo
 * numa instalacao. Varre-se a tabela em tempo constante RELATIVO ao candidato:
 * a comparacao de um digest usa `timingSafeEqual`, e o numero de digests vivos
 * e fixo e pequeno. Nao ha ramo no comprimento dos candidatos: o `digestOf`
 * normaliza qualquer entrada para 64 hex antes de comparar.
 */
export declare function constantTimeContains(vivos: ReadonlyMap<string, true>, candidato: string): boolean;
/** A forma redigida de um token: tudo menos o portador. */
export interface RedactedLinkToken {
    readonly token: string;
    readonly expiraEm: number | undefined;
}
/** Token emitido. Serializar isto NAO revela o `token`, por nenhum caminho. */
export interface LinkToken {
    /** O portador em claro. Viaja NO QUERY da URL (`?key=<token>`). */
    readonly token: string;
    /** Prazo, quando ha (relogio injetado). Esta implementacao nao impoe TTL. */
    readonly expiraEm: number | undefined;
    toJSON(): RedactedLinkToken;
    [inspect.custom](): RedactedLinkToken;
}
export interface LinkTokenStoreDeps {
    readonly clock: Clock;
    readonly randomBytes?: (size: number) => Uint8Array;
}
/**
 * O store concreto, no padrao do `MagicStore`.
 *
 * `emitir()` devolve o token em claro UMA vez e guarda so o digest.
 * `verificar()` e constante no tempo. `revogar()` invalida a chave corrente
 * (rotacao de segredo); `limparTudo()` derruba todas (queda do tunel,
 * despareamento, /emergencia).
 */
export interface LinkTokenStore {
    /** Emite uma chave nova, REUTILIZAVEL ate `revogar()`. NAO usa a antiga. */
    emitir(): LinkToken;
    /** `true` se e exatamente a chave viva, em tempo constante. NUNCA lanca. */
    verificar(candidato: string): boolean;
    /** Invalida a chave corrente (chamado na rotacao do segredo). */
    revogar(): void;
    /** Invalida TUDO (queda do tunel, despareamento, /emergencia). */
    limparTudo(): void;
    /** Disposer SINCRONO (Q-2). Idempotente. */
    dispose(): void;
    readonly live: number;
    toJSON(): string;
    [inspect.custom](): string;
}
export declare function createLinkTokenStore(deps: LinkTokenStoreDeps): LinkTokenStore;
//# sourceMappingURL=link-token.d.ts.map