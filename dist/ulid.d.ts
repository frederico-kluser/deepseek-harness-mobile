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
/**
 * Fabrica de ULIDs monotonico-cronologicos sobre um relogio injetado.
 *
 * Ordem estrita: o timestamp NUNCA recua — se o relogio andar para tras, a
 * fabrica usa o ultimo timestamp + 1 (o `requestId` so precisa de ser unico e
 * crescente; corrigir o relogio do mundo real nao e trabalho dela). A fonte
 * de aleatoriedade e INJETAVEL (`random`; por omissao, CSPRNG) — a costura de
 * teste de 04-TESTES.md 8.1: o teste fixa os bytes para provar determinismo.
 */
export declare function createUlidFactory(now: () => number, random?: () => Uint8Array): () => string;
//# sourceMappingURL=ulid.d.ts.map