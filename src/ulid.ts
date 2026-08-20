/**
 * ULID monotonico — a UNICA implementacao do `requestId` do `ControlIntent`
 * em `src/` (`09-DECISOES-CANONICAS.md` D29; `src/contracts/control.ts`).
 *
 * DONO: Onda 6, Frente 3 (revisor do diff integrado). `src/panel/ulid.ts` e
 * `src/ui-contrib/ulid.ts` IMPORTAM A MESMA fabrica daqui — duas implementacoes
 * do mesmo contrato eram duas verdades a divergir (WARNING do revisor). A
 * 3.ª copia em `worker/commands/router.ts` e imposta pela fronteira do worker
 * (processo separado, pacote separado) e NAO se toca.
 *
 * PORQUE UMA FOLHA DE TOPO E NAO `src/control/ulid.ts`: a superficie de UI
 * nativa (T5.5) e ISOLADA do controlador, do painel, do supervisor e da API
 * do DSH (teste de isolamento em `test/unit/ui-contrib/surface.test.ts`). O
 * `requestId` e partilhado pelas duas superficies, logo a fabrica tem de viver
 * numa folha que AMBAS podem ver — a mesma posicao de `errors.ts`/`brand.ts`.
 * O painel (T5.3) importa `src/panel/ulid.ts`; a UI nativa importa
 * `src/ui-contrib/ulid.ts`; os dois re-exportam DAQUI.
 *
 * O contrato exige que `requestId` seja um ULID GERADO PELA SUPERFICIE: e a
 * CHAVE DE IDEMPOTENCIA (D29) — repetido, o controlador devolve o resultado da
 * primeira execucao (CTL-020). Duas superficies a gerarem o mesmo valor seria
 * colisao; duas chamadas da MESMA superficie a gerarem o mesmo valor seria
 * idempotencia fantasma: um segundo clique que parece ter sido aceite sem ter
 * acontecido.
 *
 * ESTRUTURA (especificacao ULID): 48 bits de timestamp em ms (big-endian) +
 * 80 bits aleatorios, codificados em base32 de Crockford, 26 caracteres. O
 * alfabeto de Crockford (0-9 A-Z sem I, L, O, U) e o da especificacao — a
 * mesma escolha de base32 sem caracteres ambiguos que o projeto ja usa para
 * o segredo (`src/secret/generate.ts`).
 *
 * MONOTONICIDADE (regra "monotonic ULID"): dois ULIDs gerados no MESMO
 * milissegundo incrementam a parte aleatoria em vez de a re-sortear. Sem
 * isto, dois `requestId` da mesma rajada de cliques podem nascer fora de
 * ordem cronologica e a fila de intents de T5.1 veria chaves nao-crescentes.
 * O relogio e INJETADO (`now`), pela mesma regra que `test/support/clock.ts`
 * impoe a todo o projeto: nenhum teste espera tempo real.
 *
 * Zero dependencias: `node:crypto` e tudo o que o padrao exige.
 */

import { randomBytes } from 'node:crypto'

/** Base32 de Crockford: sem I, L, O, U (a especificacao ULID). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const MASK_48 = (1n << 48n) - 1n
const MASK_80 = (1n << 80n) - 1n

/** Quantos bytes de CSPRNG alimentam os 80 bits aleatorios. */
const RANDOM_BYTES = 10

/** 5 bits por caractere; `chars` e o numero de caracteres a emitir. */
function encodeBase32(value: bigint, chars: number): string {
  let out = ''
  let v = value
  for (let i = 0; i < chars; i += 1) {
    out = String.fromCharCode(ALPHABET.charCodeAt(Number(v & 31n))) + out
    v >>= 5n
  }
  return out
}

/**
 * Fabrica de ULIDs monotonico-cronologicos sobre um relogio injetado.
 *
 * Ordem estrita: o timestamp NUNCA recua — se o relogio andar para tras, a
 * fabrica usa o ultimo timestamp + 1 (o `requestId` so precisa de ser unico e
 * crescente; corrigir o relogio do mundo real nao e trabalho dela). A fonte
 * de aleatoriedade e INJETAVEL (`random`; por omissao, CSPRNG) — a costura de
 * teste de 04-TESTES.md 8.1: o teste fixa os bytes para provar determinismo.
 */
export function createUlidFactory(
  now: () => number,
  random: () => Uint8Array = () => randomBytes(RANDOM_BYTES),
): () => string {
  let lastMs = -1
  let lastRandom = 0n

  return function ulid(): string {
    let ms = Math.floor(now())

    // Relogio andou para tras: nunca repetir timestamp.
    if (ms < lastMs) ms = lastMs + 1

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
    aleatorio &= MASK_80

    // Mesmo milissegundo: incrementa a parte aleatoria (monotonic ULID).
    if (ms === lastMs) {
      aleatorio = (lastRandom + 1n) & MASK_80
      if (aleatorio === 0n) ms += 1 // a parte aleatoria enrolou: sobe o ms
    }

    lastMs = ms
    lastRandom = aleatorio

    return encodeBase32(BigInt(ms) & MASK_48, 10) + encodeBase32(aleatorio, 16)
  }
}
