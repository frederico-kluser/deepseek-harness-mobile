/**
 * ULID -- o formato do `requestId` do `ControlIntent` (`09-DECISOES-CANONICAS.md`
 * D29; `src/contracts/control.ts`).
 *
 * DONO: T5.3.
 *
 * ---------------------------------------------------------------------------
 * PORQUE UM GERADOR PROPRIO, E NAO UMA DEPENDENCIA
 * ---------------------------------------------------------------------------
 * A Onda 5 corre com zero dependencias novas. Um ULID sao 26 caracteres
 * Crockford-base32: 48 bits de relogio + 80 bits de aleatoriedade. O nucleo
 * cabe em 30 linhas e o teste falsifica a forma, o carimbo e a unicidade; uma
 * dependencia de terceiros para isto acrescentaria um `node_modules` inteiro a
 * troco de uma funcao que quem revisa nao pode inspecionar.
 *
 * A CHAVE DE IDEMPOTENCIA (D29) depende de o `requestId` ser UNICO por
 * intencao. A unicidade e a dos 80 bits de CSPRNG, e nao a da monoticidade por
 * milissegundo da spec original -- essa nao e implementada de proposito: duas
 * intencoes do mesmo milissegundo sao duas intencoes DISTINTAS, e o controlador
 * (T5.1) trata a repeticao por idempotencia de ESTADO (CTL-002/003) e por
 * `requestId` literal -- nunca por ordem de chegada.
 *
 * O `random` injetavel e a costura de teste (04-TESTES.md 8.1): a producao usa
 * CSPRNG (`randomBytes`), e o teste fixa os bytes para provar determinismo.
 */

import { randomBytes } from 'node:crypto'

/** Alfabeto Crockford do ULID: sem I, L, O e U, de proposito. */
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Os 48 bits de relogio cabem em 10 caracteres; os 80 de sorte, em 16. */
const TIME_CHARS = 10
const RANDOM_CHARS = 16
const RANDOM_BYTES = 10

/** Codifica em base 32 Crockford, big-endian, com o numero de caracteres fixo. */
function encodeCrockford(valor: bigint, caracteres: number): string {
  let restante = valor
  let saida = ''
  for (let i = 0; i < caracteres; i += 1) {
    saida = ALFABETO[Number(restante & 0x1fn)] + saida
    restante >>= 5n
  }
  return saida
}

/**
 * Gera um ULID de 26 caracteres para o instante dado.
 *
 * `now` e epoch ms do relogio INJETADO (nunca `Date.now` aqui dentro -- a
 * superficie recebe o relogio por dependencia, 04-TESTES.md 8.1).
 */
export function newUlid(
  now: number,
  random: () => Uint8Array = () => randomBytes(RANDOM_BYTES),
): string {
  const bytes = random()
  if (bytes.length < RANDOM_BYTES) {
    throw new Error(
      `aleatoriedade do ULID curta demais: ${String(bytes.length)} bytes (minimo ${String(RANDOM_BYTES)})`,
    )
  }

  let aleatorio = 0n
  for (let i = 0; i < RANDOM_BYTES; i += 1) {
    aleatorio = (aleatorio << 8n) | BigInt(bytes[i] ?? 0)
  }

  return encodeCrockford(BigInt(Math.floor(now)), TIME_CHARS) + encodeCrockford(aleatorio, RANDOM_CHARS)
}
