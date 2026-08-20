/**
 * DECLARACOES DE TERCEIROS QUE FALTAM AO grammY 1.45.1.
 *
 *   >>> ATENCAO: ISTO **NAO** E ARTEFACTO DE EMISSAO. NAO APAGAR. <<<
 *   O `eslint.config.js` e o `.oxlintrc.json` ignoram `worker/**\/*.d.ts`
 *   descrevendo-os como "artefactos de emissao commitados lado a lado com o
 *   fonte" — este ficheiro NAO e um deles: e FONTE, esta no git, e sem ele
 *   `pnpm typecheck` e `pnpm build` ficam vermelhos. Apaga-lo por arrumacao
 *   quebra o gate.
 *
 * Este ficheiro NAO tem codigo: existe para que `pnpm typecheck` (que corre com
 * `skipLibCheck: false`, por decisao deste repositorio) consiga ler os `.d.ts`
 * do grammY sem os `paths` do projeto e sem a `lib` do DOM.
 *
 * TRES BURACOS MEDIDOS, e a razao de cada um:
 *
 *  1. `node-fetch` — o grammY 1.45.1 importa-o em `out/shim.node.d.ts` mas
 *     declara `@types/node-fetch` apenas em `devDependencies`, ou seja o pacote
 *     publicado nao traz tipos para ele. Sem isto: `TS7016`.
 *
 *     >>> NAO se instala `@types/node-fetch` para resolver isto. D23 autoriza
 *     >>> UMA dependencia (`grammy`), e a disciplina de supply chain deste
 *     >>> projeto nao se relaxa por um tipo. Um `declare module` de uma linha
 *     >>> faz o mesmo trabalho com zero superficie nova — e o `node-fetch` fica
 *     >>> `any` de propósito: NAO o usamos, e tipa-lo bem seria fingir que ele
 *     >>> faz parte da nossa API.
 *
 *  2. `Body` / `BodyInit` — globais da `lib.dom`, usados em
 *     `out/convenience/frameworks.d.ts` nos adaptadores de Cloudflare Workers e
 *     Worktop. Este projeto declara `lib: ["ES2023"]` e nao tem (nem quer) o
 *     DOM: o worker corre em Node e NENHUM desses adaptadores e importado.
 *     `unknown` e a declaracao honesta — `unknown & T` e `T`, portanto as
 *     interseccoes em que eles aparecem continuam a significar o que
 *     significavam.
 *
 * `Headers` e `Response`, que aparecem nos mesmos ficheiros, NAO estao aqui: o
 * `@types/node` 24 ja os declara globalmente (undici). Declara-los outra vez
 * seria colisao.
 */

declare module 'node-fetch'

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- ambiente, nao codigo
type Body = unknown
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- ambiente, nao codigo
type BodyInit = unknown
