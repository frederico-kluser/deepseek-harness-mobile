/**
 * `canonicalizePermissionToken`, `requestsDeniedPermission` -- deteccao de
 * pedidos de elevacao para permissoes recusadas.
 */

import { safeDecodeURIComponent } from '../http/path.ts'

/**
 * Reduz um token a uma forma canonica comparavel.
 *
 * As quatro normalizacoes correspondem, uma a uma, a evasoes que a versao
 * anterior deixava passar (todas verificadas):
 *
 *   1. percent-decoding iterado -> `danger%2Dfull%2Daccess` e
 *      `danger%252Dfull%252Daccess` colapsam em `danger-full-access`;
 *   2. caixa -> `DANGER-FULL-ACCESS`;
 *   3. separadores equivalentes (`_`, `.`, `+`, espaco em branco) reescritos
 *      como `-` -> `danger_full_access`, `danger.full.access` e
 *      `danger+full+access` (o `+` e a grafia de espaco em corpos
 *      `application/x-www-form-urlencoded`);
 *   4. pontuacao nas BORDAS removida -> `.danger-full-access` e
 *      `danger-full-access.`.
 *
 * O que NAO se normaliza (de proposito): pontuacao INTERIOR que nao seja
 * separador. `danger-full-access-audit` continua a ser um token distinto, e tem
 * de continuar: e uma permissao diferente e captura-la seria um falso positivo
 * que quebraria fluxos legitimos.
 */
export function canonicalizePermissionToken(rawToken: string): string {
  let value = rawToken

  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = safeDecodeURIComponent(value)
    if (decoded === value) break
    value = decoded
  }

  value = value.toLowerCase().replace(/[\s._+]+/gu, '-')

  // Pontuacao nas bordas: tudo o que nao seja alfanumerico e descartado nas
  // extremidades (o interior fica intacto, ver nota acima).
  value = value.replace(/^[^a-z0-9]+/u, '').replace(/[^a-z0-9]+$/u, '')

  return value
}

/**
 * Deteta se um comando pede uma permissao recusada.
 *
 * A analise e por TOKEN e nao por `includes()` de substring: `includes` daria
 * falso positivo em `danger-full-access-audit` e falso negativo perante
 * espacamento diferente. Devolve a permissao encontrada (para o registo de
 * auditoria) ou `undefined`.
 *
 * O `%` entra no alfabeto de token de proposito: sem ele,
 * `danger%2Dfull%2Daccess` era PARTIDO em tres tokens (`danger`, `2dfull`,
 * `2daccess`) e nenhum casava com a agulha. Com o `%` dentro do token, a
 * descodificacao em {@link canonicalizePermissionToken} reconstitui a palavra.
 * As proprias entradas de `deniedPermissions` passam pela mesma canonicalizacao,
 * para que escrever `danger_full_access` no YAML continue a barrar
 * `danger-full-access`.
 */
export function requestsDeniedPermission(
  command: string,
  deniedPermissions: readonly string[],
): string | undefined {
  const tokens = new Set(
    command
      .split(/[^A-Za-z0-9._%+-]+/u)
      .map((token) => canonicalizePermissionToken(token))
      .filter((token) => token.length > 0),
  )

  for (const permission of deniedPermissions) {
    const needle = canonicalizePermissionToken(permission)
    if (needle.length > 0 && tokens.has(needle)) return permission
  }

  return undefined
}
