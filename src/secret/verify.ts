/**
 * Digest do segredo e comparacao em TEMPO CONSTANTE.
 *
 * ============================================================================
 * NOTA DE HONESTIDADE NORMATIVA -- porque SHA-256 e nao Argon2id
 * ============================================================================
 * Circula o argumento de que "a ASVS 6.5.2 autoriza hash rapido para segredo
 * com >= 112 bits". ELE NAO SE APLICA AQUI. O texto de 6.5.2 (ASVS 5.0) e:
 * "Verify that, when being stored in the application's backend, LOOKUP SECRETS
 * with less than 112 bits of entropy [...] are hashed with an approved password
 * storage hashing algorithm [...]. A standard hash function can be used if the
 * secret has 112 bits of entropy or more." Ele vive no capitulo V6.5, "General
 * MULTI-FACTOR AUTHENTICATION requirements", e "lookup secret" e um termo com
 * dono: sao os codigos de recuperacao de MFA. Este segredo nao e um segundo
 * fator: e a credencial. A norma e SILENTE para este caso, e citar 6.5.2 como
 * autorizacao seria esticar o texto para caber na decisao ja tomada.
 *
 * A justificacao correta e de PRIMEIROS PRINCIPIOS, e sustenta-se sozinha:
 *
 *   1. O segredo tem 256 bits de CSPRNG e NAO E ESCOLHIDO POR NINGUEM. Nao ha
 *      dicionario, nao ha reutilizacao, nao ha padrao humano. Um ataque offline
 *      sobre o digest tem de percorrer 2^255 hipoteses em media -- e
 *      computacionalmente impossivel, com ou sem KDF. O que um KDF acrescenta e
 *      um fator constante sobre um numero que ja e inatingivel.
 *   2. Um KDF caro AQUI e um vetor de negacao de servico. Argon2id nos
 *      parametros recomendados pela OWASP (m=19456 KiB, t=2, p=1) custa 19 MiB
 *      de memoria POR TENTATIVA. Numa rota de login exposta por tunel, isso e um
 *      amplificador de CPU e memoria que o atacante controla -- risco que a
 *      propria OWASP nomeia na sua folha de senhas.
 *
 * QUANDO ISTO MUDA, e nao e "se": no dia em que o UTILIZADOR puder escolher a
 * senha, Argon2id passa a ser OBRIGATORIO (m=19456, t=2, p=1), porque ai existe
 * dicionario e existe reutilizacao. O spike S11 confirmou que `crypto.argon2` e
 * `crypto.argon2Sync` sao NATIVOS a partir do Node 24.7.0 e o `engines.node`
 * deste pacote ja e `>=24` -- o caminho esta aberto, apenas fora do escopo de
 * T2.1. Este comentario e o marcador dessa fronteira.
 * ============================================================================
 *
 * PORQUE COMPARAR DIGESTS E NUNCA O SEGREDO CRU: `crypto.timingSafeEqual`
 * LANCA `RangeError` com buffers de comprimentos diferentes. Comparar material
 * cru obrigaria a testar o comprimento primeiro -- e esse ramo (ou a excecao)
 * vazaria o COMPRIMENTO do segredo guardado. Reduzir os dois lados a SHA-256 da
 * sempre 32 bytes, e a comparacao passa a ser total e de duracao independente
 * da entrada. E a mesma decisao ja tomada em `src/http/auth-basic.ts`.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import { toSecretDigest, type SecretDigest } from '../brand.ts'
import { canonicalizeSecret } from './canonical.ts'

/** SHA-256: 32 bytes. E este numero fixo que torna a comparacao total. */
export const SECRET_DIGEST_BYTES = 32

/** Erro de digest malformado. Fail loud: um digest invalido nao vira "sem segredo". */
export class SecretDigestError extends Error {
  override readonly name = 'SecretDigestError'
}

/** Bytes de `sha256(forma canonica)`. Sempre 32, para qualquer entrada. */
function digestBytes(secret: string): Buffer {
  return createHash('sha256').update(canonicalizeSecret(secret), 'utf8').digest()
}

/** Digest hexadecimal do segredo, na forma que `PersistedState.secretDigest` guarda. */
export function digestSecret(secret: string): SecretDigest {
  return toSecretDigest(digestBytes(secret).toString('hex'))
}

/**
 * Compara o candidato com o digest guardado, em tempo constante.
 *
 * SEM DIGEST GUARDADO, NINGUEM PASSA. O retorno antecipado nao e canal temporal
 * util: "ainda nao foi provisionado segredo" e um facto de configuracao, nao um
 * segredo, e o caminho rapido nao depende de nenhum byte apresentado. E a mesma
 * direcao de `verifyBasicAuth` sem credencial configurada.
 */
export function verifySecret(candidate: string, expected: SecretDigest | undefined): boolean {
  if (expected === undefined) return false
  const stored = Buffer.from(expected, 'hex')
  if (stored.length !== SECRET_DIGEST_BYTES) {
    throw new SecretDigestError(
      `digest guardado tem ${stored.length} bytes, esperados ${SECRET_DIGEST_BYTES} (sha256 em hex de 64 caracteres)`,
    )
  }
  return timingSafeEqual(digestBytes(candidate), stored)
}
