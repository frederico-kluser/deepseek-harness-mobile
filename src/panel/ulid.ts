/**
 * ULID — o formato do `requestId` do `ControlIntent` (`09-DECISOES-CANONICAS.md`
 * D29; `src/contracts/control.ts`).
 *
 * DONO: T5.3 -> Onda 6 (Frente 3).
 *
 * ---------------------------------------------------------------------------
 * UMA SO IMPLEMENTACAO EM SRC/ — A MONOTONICA
 * ---------------------------------------------------------------------------
 * A Onda 6 (Frente 3, revisor do diff integrado) colapsou as DUAS fabricas do
 * `requestId` (esta, nao-monotonica, e a de `src/ui-contrib/ulid.ts`,
 * monotonica) numa UNICA: `createUlidFactory` vive em `src/ulid.ts` (a folha
 * partilhada da arvore, visivel a T5.3 e a T5.5) e
 * este modulo re-exporta-a. O que resta AQUI e o `newUlid` de conveniencia
 * one-shot — o chamador congelado `src/panel/api.ts` gera um id por pedido com
 * `newUlid(deps.clock.now())` — que DELEGA na fabrica canonica: a unicidade e
 * a dos 80 bits de CSPRNG e a forma e a MESMA de toda a superficie. Quem
 * precisar de ordem cronologica (rajadas do mesmo milissegundo) segura a
 * fabrica (`createUlidFactory`) com o relogio injetado — e o que a UI nativa
 * faz; a paridade entre os dois modulos e presa por teste (identidade da
 * funcao).
 *
 * O `random` injetavel e a costura de teste (04-TESTES.md 8.1): a producao usa
 * CSPRNG (`randomBytes`), e o teste fixa os bytes para provar determinismo.
 */

import { createUlidFactory } from '../ulid.ts'

export { createUlidFactory } from '../ulid.ts'

/**
 * Gera UM ULID de 26 caracteres para o instante dado (conveniencia one-shot
 * do painel; delega na fabrica canonica de `src/ulid.ts`).
 *
 * `now` e epoch ms do relogio INJETADO (nunca `Date.now` aqui dentro — a
 * superficie recebe o relogio por dependencia, 04-TESTES.md 8.1).
 */
export function newUlid(
  now: number,
  random?: () => Uint8Array,
): string {
  return createUlidFactory(() => now, random)()
}
