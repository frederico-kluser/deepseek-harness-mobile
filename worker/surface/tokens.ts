/**
 * REQUEST ID (ULID) e tokens OPAQUE da superficie neutra (onda 2 — nucleo).
 *
 * Port fiel da seccao "REQUEST ID (ULID) E TOKENS OPAQUE" de
 * `worker/commands/router.ts` (DONO de referencia: T5.2). Separado em ficheiro
 * proprio porque tanto `core.ts` (requestId + tokens) como `actions.ts`
 * (gerarTokenOpaque) o usam — viver em core.ts criaria um acoplamento
 * core->actions que este ficheiro desfaz sem custo.
 *
 * ===========================================================================
 * REQUESID COMO ULID — A CHAVE DE IDEMPOTENCIA DO CONTROLO (D29)
 * ===========================================================================
 * O ULID de 26 caracteres (48 bits de timestamp + 80 bits de CSPRNG via
 * `node:crypto` `randomBytes`) e a CHAVE DE IDEMPOTENCIA do `ControlIntent`
 * (D29): repetido, o host devolve o resultado da primeira execucao. O relogio e
 * INJETADO (parametro `agora`) — nenhum modulo deste worker chama `Date.now()`
 * directamente (`worker/lib/clock.ts`).
 *
 * ===========================================================================
 * O TOKEN OPAQUE TEM A FORMA DO NONCE DO HOST (S5)
 * ===========================================================================
 * `gerarTokenOpaque` produz `randomBytes(8).toString('base64url')` — a mesma
 * forma do nonce do host. E OPACO (S5) e NUNCA logado (S3): o worker gera-o
 * para os botoes de `emergency` (accao que REDUZ exposicao, CTL-024, em que o
 * host nao consome o token) e apenas o TRANSPORTA nos restantes. O valor nunca
 * sai para o log por construcao — nao ha aqui nenhum `log`.
 */

import { randomBytes } from 'node:crypto'

/** Alfabeto Crockford base32 do ULID (sem I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ULID de 26 caracteres: 48 bits de timestamp (relogio INJETADO) + 80 bits de
 * CSPRNG. E a CHAVE DE IDEMPOTENCIA do `ControlIntent` (D29).
 */
export function gerarRequestId(agora: number): string {
  const tempo = BigInt(agora)
  const aleatorio = BigInt(`0x${randomBytes(10).toString('hex')}`)
  let valor = (tempo << 80n) | aleatorio
  let saida = ''
  for (let i = 0; i < 26; i += 1) {
    saida = CROCKFORD[Number(valor & 31n)] + saida
    valor >>= 5n
  }
  return saida
}

/** Token opaco com a FORMA do nonce do host (`randomBytes(8).toString('base64url')`). */
export function gerarTokenOpaque(): string {
  return randomBytes(8).toString('base64url')
}