/**
 * IDs com marca (branded IDs) e os seus construtores validadores.
 *
 * CONGELADO no COMMIT PREP 2. Leitura livre, escrita proibida na Onda 2.
 *
 * PORQUE ISTO E UM CONTRATO DE PREP, e nao entrega de uma sub-tarefa: tres
 * sub-tarefas de duas ondas diferentes precisam destes mesmos tipos —
 * T2.1 do `SecretDigest`, T2.2 do `SessionId`, T5.1 do `Nonce`. Se cada uma
 * declarasse os seus, existiriam tres definicoes divergentes do mesmo conceito
 * e o compilador nao acusaria: `string` e compativel com `string`.
 *
 * PORQUE MARCA, e nao `string` nua (`05-QUALIDADE-CODIGO.md` 1.4): estes
 * valores atravessam fronteiras onde trocar um pelo outro e um bug SILENCIOSO
 * — passar um `Nonce` onde se espera um `SessionId` compila sem uma palavra.
 * A marca e apenas de tipo: em runtime continua a ser uma string, custo zero.
 *
 * NOTA DE RUNTIME: `node --test` corre `.ts` em strip-only mode. Nada aqui
 * pode emitir codigo — sem `enum`, sem `namespace`, sem parameter properties.
 * `declare const` de simbolo unico e apagado na emissao, logo e seguro.
 */
declare const brandSessionId: unique symbol;
declare const brandNonce: unique symbol;
declare const brandSecretDigest: unique symbol;
/** Identificador opaco de sessao: >=128 bits de CSPRNG (ASVS 7.2.3). */
export type SessionId = string & {
    readonly [brandSessionId]: true;
};
/** Nonce de confirmacao de 2 etapas: server-side, TTL 60 s, uso unico. */
export type Nonce = string & {
    readonly [brandNonce]: true;
};
/** Hex de `sha256(segredo)` — 64 caracteres. NUNCA o segredo em claro. */
export type SecretDigest = string & {
    readonly [brandSecretDigest]: true;
};
/** Erro de construcao de um ID com marca. */
export declare class BrandError extends Error {
    readonly name = "BrandError";
}
/**
 * Constroi um `SessionId`.
 *
 * VALIDA, nao apenas converte: um construtor que so fizesse `as SessionId`
 * daria a marca a qualquer string e a garantia seria decorativa.
 */
export declare function toSessionId(value: string): SessionId;
/** Constroi um `Nonce`. Mesmo piso de entropia do `SessionId`. */
export declare function toNonce(value: string): Nonce;
/** Constroi um `SecretDigest`. Exige hex minusculo de 64 caracteres. */
export declare function toSecretDigest(value: string): SecretDigest;
export {};
//# sourceMappingURL=brand.d.ts.map