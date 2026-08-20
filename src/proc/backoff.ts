/**
 * `computeBackoffDelay` -- puro, sem I/O, com o gerador aleatorio injetado.
 */

import type { BackoffConfig } from '../config/schema.ts'

/**
 * Calcula o atraso antes da tentativa `attempt` (1 = primeiro reinicio).
 *
 * Base: `initialDelayMs * 2^(attempt-1)`, saturada em `maxDelayMs` -- os valores
 * nominais documentados do DSH sao 500 ms e 10.000 ms
 * (`reconnect.initialDelayMs` / `reconnect.maxDelayMs` do cliente MCP). O teto
 * evita latencias impraticaveis depois de longos periodos fora do ar; a
 * progressao evita a reinterrogacao compulsiva que satura o event loop.
 *
 * O JITTER E SOMADO POR CIMA DA BASE, NUNCA SUBTRAIDO DELA. Esta e uma correcao
 * deliberada face a variante "equal jitter" (`base/2 + random*base/2`) usada
 * antes: com ela, o atraso da PRIMEIRA tentativa caia para 250 ms com `random()`
 * proximo de 0 -- metade do `initialDelayMs: 500` que o DSH prescreve como base
 * cronologica inicial imposta. Um piso abaixo do minimo documentado e um
 * crash-loop mais agressivo do que o configurado, exatamente no cenario em que o
 * worker esta a falhar de imediato.
 *
 * Contrato desta funcao, agora verdadeiro para QUALQUER `random()`:
 *
 *   base <= atraso <= min(base * 1.5, maxDelayMs)
 *
 * ou seja, o piso e a base nominal (`initialDelayMs` na primeira tentativa) e o
 * teto absoluto continua a ser `maxDelayMs`, com saturacao. Com
 * `random() === 0` a sequencia degenera exatamente na progressao nominal
 * (500, 1000, 2000, ..., 10000, 10000), o que torna a funcao verificavel de
 * forma determinista nos testes.
 *
 * PORQUE HA JITTER DE TODO: sem ele, N instancias do DSH que percam o mesmo
 * servico remoto voltam TODAS no mesmo milissegundo (*thundering herd*),
 * reconstruindo a sobrecarga que o backoff pretendia dissipar. Nota honesta: na
 * saturacao (base ja igual a `maxDelayMs`) o teto absorve a margem de jitter e o
 * atraso volta a ser deterministico -- e o preco de manter `maxDelayMs` como
 * limite duro, e nao um descuido.
 */
export function computeBackoffDelay(
  attempt: number,
  backoff: BackoffConfig,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  const base = Math.min(backoff.initialDelayMs * 2 ** exponent, backoff.maxDelayMs)
  const jitter = random() * (base / 2)

  return Math.round(Math.min(base + jitter, backoff.maxDelayMs))
}
