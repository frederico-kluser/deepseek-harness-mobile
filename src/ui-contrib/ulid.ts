/**
 * ULID monotonico — fabrica do `requestId` da superficie de UI nativa.
 *
 * >>> NAO HA IMPLEMENTACAO AQUI (Onda 6, Frente 3). <<< A UNICA fabrica do
 * `requestId` em `src/` vive em `src/ulid.ts` (a folha partilhada, fora das
 * regioes que esta superficie nao pode ver); este modulo re-exporta-a
 * para a superficie de UI nativa (`src/ui-contrib/surface.ts`) continuar a
 * importar do MESMO caminho. Duas implementacoes do mesmo contrato eram duas
 * verdades a divergir — a paridade entre os dois modulos e presa por teste
 * (identidade da funcao em `test/unit/ui-contrib/ulid.test.ts`).
 *
 * O contrato (`src/contracts/control.ts`, PREP 5) exige que `requestId` seja
 * um ULID GERADO PELA SUPERFICIE: e a CHAVE DE IDEMPOTENCIA (D29) — repetido,
 * o controlador devolve o resultado da primeira execucao (CTL-020). Ver o
 * cabecalho da fabrica para a forma (26 caracteres Crockford), a monotonicidade
 * (regra "monotonic ULID") e o relogio injetado.
 */

export { createUlidFactory } from '../ulid.ts'
