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

declare const brandSessionId: unique symbol
declare const brandNonce: unique symbol
declare const brandSecretDigest: unique symbol

/** Identificador opaco de sessao: >=128 bits de CSPRNG (ASVS 7.2.3). */
export type SessionId = string & { readonly [brandSessionId]: true }

/** Nonce de confirmacao de 2 etapas: server-side, TTL 60 s, uso unico. */
export type Nonce = string & { readonly [brandNonce]: true }

/** Hex de `sha256(segredo)` — 64 caracteres. NUNCA o segredo em claro. */
export type SecretDigest = string & { readonly [brandSecretDigest]: true }

/** Erro de construcao de um ID com marca. */
export class BrandError extends Error {
  override readonly name = 'BrandError'
}

const HEX_64 = /^[0-9a-f]{64}$/u

/**
 * Constroi um `SessionId`.
 *
 * VALIDA, nao apenas converte: um construtor que so fizesse `as SessionId`
 * daria a marca a qualquer string e a garantia seria decorativa.
 */
export function toSessionId(value: string): SessionId {
  if (value.length < 22) {
    throw new BrandError(`SessionId curto demais: ${value.length} caracteres (minimo 22 para 128 bits em base64url)`)
  }
  return value as SessionId
}

/** Constroi um `Nonce`. Mesmo piso de entropia do `SessionId`. */
export function toNonce(value: string): Nonce {
  if (value.length < 22) {
    throw new BrandError(`Nonce curto demais: ${value.length} caracteres (minimo 22 para 128 bits em base64url)`)
  }
  return value as Nonce
}

/** Constroi um `SecretDigest`. Exige hex minusculo de 64 caracteres. */
export function toSecretDigest(value: string): SecretDigest {
  if (!HEX_64.test(value)) {
    throw new BrandError('SecretDigest tem de ser hex minusculo de 64 caracteres (sha256)')
  }
  return value as SecretDigest
}
