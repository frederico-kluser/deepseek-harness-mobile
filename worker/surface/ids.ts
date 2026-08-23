/**
 * NORMALIZACAO E VALIDACAO DE IDENTIDADE NEUTRA — funcoes PURAS que cada
 * provedor usa para converter as suas chaves brutas no formato canonico de
 * {@link SurfaceIdentity}.
 *
 * DONO: onda 1 (contrato neutro da superficie). LEITURA LIVRE nos ficheiros
 * de referencia (`worker/auth/allowlist.ts` — a privacidade dos eixos `from`
 * e `chat`; `worker/auth/pairing.ts` — o dono); ESCRITA PROIBIDA neles.
 *
 * ===========================================================================
 * PORQUE EXISTE UM MODULO SO DE FUNCOES DE ID
 * ===========================================================================
 * O contrato (`./contract.ts`) diz que `userKey`/`chatKey` sao STRINGS nunca
 * vazias, mas isso e um TIPO — o que obriga um `string` nao vazio no runtime e
 * a normalizacao, e a normalizacao nao pode viver em cada adaptador sob pena
 * de cada um normalizar a seu jeito. Este modulo e o UNICO ponto que decide
 * o que conta como uma chave utilizavel:
 *
 *   - {@link normalizeKey} faz o `trim` e a validacao de nao vazio — o mesmo
 *     espirito do `parseCommand` de `worker/auth/pairing.ts` (o `trim` antes de
 *     decidir) e da guarda de nao-vazio do Telegram;
 *   - {@link normalizeIdentity} combina os dois eixos e devolve `undefined`
 *     quando QUALQUER um falha — um evento sem `userKey` ou sem `chatKey` nao
 *     existe (ver a nota dos dois eixos em `./contract.ts`).
 *
 * A normalizacao aqui e intencionalmente minima (trim + nao vazio): nao tenta
 * validar o FORMATO de uma chave de um provedor especifico (um numero de
 * Telegram, um url de Matrix, um id de Slack). Cada adaptador e livre de exigir
 * mais, mas NAO MENOS — um adaptador que produz uma chave com espacos brancos
 * ou vazia viola este contrato no runtime.
 *
 * ===========================================================================
 * FUNCOES PURAS E COLOCADAS, NAO CONSTRUTORES DE ESTADO
 * ===========================================================================
 * Tal como `worker/auth/allowlist.ts` faz a decisao pura devolver um veredito
 * em vez de fazer I/O, este modulo NAO guarda estado nenhum: recebe uma string,
 * devolve o canonico. Quem precisa de POLIR o formato de um provedor faz isso
 * ANTES de chamar {@link normalizeKey}, aqui dentro so se aplica a regra comum.
 */

import type { SurfaceIdentity } from './contract.ts'

/**
 * Normaliza e valida UMA chave de identidade (user ou chat).
 *
 * Devolve a chave aparada quando nao vazia. `undefined` quando `value` nao e
 * string, ou e so espaco em branco. O `trim` acontece ANTES da validacao --
 * uma string de so espacos viraria uma chave vazia se o nao-vazio fosse checado
 * apos o trimm.
 *
 * POR QUE `trim` E NAO VALIDAR O `value` CRU: um id fornecido com espacos
 * brancos a volta e, na pratica, um erro de configuracao ou de preenchimento de
 * cast ainda em producao; o contrato prefere arquiva-lo a propagar uma chave
 * que nao casa com a allowlist. O mesmo `trim` que `worker/auth/pairing.ts`
 * faz ao argumento de `/parear`.
 */
export function normalizeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const aparado = value.trim()
  return aparado.length === 0 ? undefined : aparado
}

/**
 * Combina os DOIS eixos numa {@link SurfaceIdentity} valida, ou devolve
 * `undefined`. Falha quando QUALQUER eixo falha.
 *
 * POR QUE `undefined` E NAO UMA EXCECAO: um evento sem identidade completa
 * NAO e um erro de configuracao — e um update mal formado de um canal que o
 * nucleo deve descartar sem derrubar (TG-014). Devolver `undefined` obriga o
 * chamador a decidir o que fazer com o evento invalido, em vez de atirar um
 * throw que mataria o worker por causa de um campo novo de um provedor.
 */
export function normalizeIdentity(
  userKey: unknown,
  chatKey: unknown,
): SurfaceIdentity | undefined {
  const u = normalizeKey(userKey)
  const c = normalizeKey(chatKey)
  if (u === undefined || c === undefined) return undefined
  return { userKey: u, chatKey: c }
}

/**
 * O predicado de identidade VALIDA: `true` sse {@link normalizeIdentity}
 * aceita os dois eixos. Existe para quem tem de decidir sem carregar a
 * identidade — a mesma intencao do `isTelegramId` de `worker/auth/allowlist.ts`
 * (nao expor os ids; responder `has`).
 */
export function isValidIdentity(value: unknown): value is SurfaceIdentity {
  if (typeof value !== 'object' || value === null) return false
  const candidato = value as Partial<SurfaceIdentity>
  return normalizeKey(candidato.userKey) !== undefined && normalizeKey(candidato.chatKey) !== undefined
}