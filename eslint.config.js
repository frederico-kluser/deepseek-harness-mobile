/**
 * GATE DE LINT — PASSADA 2 (type-aware).  ESLint 10, flat config.
 * ============================================================================
 *
 * `pnpm lint` == `oxlint . && eslint .`  (09-DECISOES-CANONICAS.md D4).
 * Duas passadas, com divisao de trabalho deliberada:
 *
 *   - `oxlint`  -> gate rapido, 865+ regras sintaticas, 50-100x mais rapido.
 *                  Configurado em `.oxlintrc.json`.
 *   - `eslint`  -> SO as regras que precisam do type checker e as restricoes
 *                  de import especificas deste projeto. Nao habilitamos
 *                  `js.configs.recommended` nem `recommendedTypeChecked`
 *                  inteiro: seria duplicar o que o oxlint ja cobre e pagar
 *                  duas vezes pelo mesmo achado (05-QUALIDADE-CODIGO.md §8).
 *
 * `.eslintrc` foi REMOVIDO no ESLint v10 — nao existe caminho de
 * compatibilidade. Este ficheiro (flat config) e a unica configuracao.
 * ESLint 10.8.1 exige Node `^20.19.0 || ^22.13.0 || >=24`; o repositorio
 * declara `engines.node >= 24`, logo esta dentro.
 *
 * Codigo de saida: `eslint` sai 1 quando ha ERRO e 0 quando so ha warning
 * (nao usamos `--max-warnings`, porque o script canonico de D4 nao leva
 * flags). Um achado em `warn` e visivel em toda corrida sem tornar o gate da
 * onda refem de um defeito que ja tem outro dono.
 */

import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

/* -------------------------------------------------------------------------- */
/* Globs                                                                      */
/* -------------------------------------------------------------------------- */

/* ESLint 10 so percorre ficheiros `.js`/`.mjs`/`.cjs` por omissao: os globs de
   TypeScript precisam de ser nomeados por alguma configuracao para o ficheiro
   sequer entrar na corrida. */
const TS = ['**/*.ts', '**/*.mts', '**/*.cts']
const JS = ['**/*.js', '**/*.mjs', '**/*.cjs']

/* -------------------------------------------------------------------------- */
/* Restricoes de import — as duas regras especificas DESTE projeto             */
/* -------------------------------------------------------------------------- */

/**
 * R1 · `@deepseek-ai/dsh-host-subprocess` NAO EXISTE.
 *
 * O pacote da **404 real** no registry npm (erro E1 do catalogo da Onda 0;
 * `test/contract/dsh-types.test.ts` CONTRACT-004 assere-o contra a rede). O
 * nome real do assento de subprocessos e `@deepseek-ai/dsh-subprocess`
 * (+ `-local` para a implementacao). Como o repositorio resolve
 * `@deepseek-ai/*` por `paths` para o espelho em `types/**`, um import deste
 * nome nao falha na instalacao: falha so no consumidor. Esta regra e o que
 * impede o nome de voltar.
 */
const PKG_404 = {
  name: '@deepseek-ai/dsh-host-subprocess',
  message:
    'Pacote INEXISTENTE (404 no registry npm — CONTRACT-004). O assento de ' +
    'subprocessos e `@deepseek-ai/dsh-subprocess` (tipos) / ' +
    '`@deepseek-ai/dsh-subprocess-local` (implementacao). ' +
    'Ver docs/spikes/api-dsh.md.',
}

/**
 * R2 · `@deepseek-ai/*` so no adaptador.
 *
 * `src/dsh/adapter.ts` e o UNICO ponto do repositorio que toca a API do DSH
 * (09-DECISOES-CANONICAS.md D1; 05-QUALIDADE-CODIGO.md §5.5). O criterio de
 * aceite da Onda 1 e literal: `grep -rl '@deepseek-ai/' src` tem de devolver
 * apenas esse ficheiro. Esta regra transforma o criterio num gate.
 *
 * `types/**` fica FORA (globalIgnores): sao espelhos byte-a-byte de tarballs
 * de terceiros, e o smoke de contrato `types/__smoke__.ts` PRECISA de importar
 * `@deepseek-ai/*` — e para isso que ele existe.
 */
const DSH_SCOPE = {
  group: ['@deepseek-ai/*', '@deepseek-ai/*/*'],
  message:
    'A fronteira com o DSH e `src/dsh/adapter.ts`, e so ela (D1 / 05 §5.5). ' +
    'Importe o adaptador, nao o pacote do host.',
}

/** Apenas R1 — vale no repositorio inteiro e dentro do proprio adaptador. */
const ONLY_404_OPTS = { paths: [PKG_404] }
/** R1 + R2 — vale em `src/`, `worker/` e `bin/`. */
const SCOPE_AND_404_OPTS = { paths: [PKG_404], patterns: [DSH_SCOPE] }

/**
 * Selectores de sintaxe proibida.
 *
 * Ficam num `const` porque o bloco transitorio no fim deste ficheiro precisa
 * de os repetir com severidade `warn`: em ESLint, dar so a severidade a uma
 * regra APAGA as opcoes, e `no-restricted-syntax` sem selectores nao reporta
 * nada — um buraco silencioso em vez de um aviso.
 */
const RESTRICTED_SYNTAX = [
  {
    selector: 'CatchClause[body.body.length=0]',
    message: 'catch vazio proibido. Ver 05-QUALIDADE-CODIGO.md §6.3.',
  },
  {
    /* `no-restricted-imports` nao ve `import()` dinamico. Esta e a metade que
       falta da regra R1. */
    selector:
      'ImportExpression > Literal[value=/^@deepseek-ai\\/dsh-host-subprocess/]',
    message:
      'Pacote INEXISTENTE (404 no registry npm — CONTRACT-004). Use ' +
      '`@deepseek-ai/dsh-subprocess`.',
  },
]

export default defineConfig([
  /* ------------------------------------------------------------------ */
  /* O que o lint NAO ve                                                */
  /* ------------------------------------------------------------------ */
  globalIgnores([
    'dist/**',
    'coverage/**',
    /* Espelhos byte-a-byte de tarballs de terceiros, regerados por
       `pnpm types:fetch`. Lintar codigo gerado e ruido: o gate real deles e
       `test/contract/dsh-types.test.ts` (sha256 por ficheiro). */
    'types/**',
    /* Artefactos de emissao commitados lado a lado com o fonte.
       EXCECAO NOMEADA (PREP 5): worker/lib/vendor-shims.d.ts NAO e artefacto
       de emissao — e FONTE (4 linhas de declaracoes ambiente que o grammY
       exige), embora case com o padrao. Nao apagar em limpeza de artefactos. */
    'worker/**/*.js',
    'worker/**/*.d.ts',
    'worker/**/*.js.map',
    'worker/**/*.d.ts.map',
    /* Evidencia congelada dos spikes da Onda 0 (tem package.json proprio). */
    'scripts/spike/**',
  ]),

  /* ------------------------------------------------------------------ */
  /* Parser + plugin, com type-aware ligado — so para TypeScript        */
  /* ------------------------------------------------------------------ */
  {
    name: 'dsh-guard/ts-language',
    files: TS,
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
      parserOptions: {
        /* `projectService` e a forma corrente de ligar as regras type-aware
           (substitui o `project: './tsconfig.json'` manual). Le o
           `tsconfig.json` da raiz, que ja inclui src/, worker/, bin/ e
           test/. */
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      /* Um `eslint-disable` que ja nao suprime nada e mentira documentada. */
      reportUnusedDisableDirectives: 'error',
    },
  },

  /* ------------------------------------------------------------------ */
  /* As regras que valem o custo do type checker                         */
  /* (05-QUALIDADE-CODIGO.md §8, "Regras nao-default que este projeto    */
  /*  exige")                                                            */
  /* ------------------------------------------------------------------ */
  {
    name: 'dsh-guard/type-aware',
    files: TS,
    rules: {
      /* Promessa orfa dentro de um listener = trabalho que desaparece sem
         rasto. Anti-padrao A-4 de 05 §9. */
      '@typescript-eslint/no-floating-promises': 'error',
      /* `async` onde se espera `void` — exatamente a forma de um listener de
         evento do cordis. */
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      /* A maquina de estados do liga/desliga (D7/D29) depende disto. */
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      /* A regra que teria apanhado `!child.killed` — a guarda que tornava o
         tree-kill codigo morto (05 §9, A-2). `warn` por decisao de 05 §8. */
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      /* O type stripping do Node apaga `import type` mas NAO resolve um
         import de VALOR de `@deepseek-ai/*` em runtime (06 §5.1). Manter os
         imports de tipo explicitos e o que impede a quebra silenciosa. */
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
    },
  },

  /* ------------------------------------------------------------------ */
  /* `node:test` devolve Promise por desenho                             */
  /* ------------------------------------------------------------------ */
  {
    /*
     * `test()` e `describe()` do `node:test` devolvem `Promise<void>` e a
     * documentacao do Node diz explicitamente que o valor NAO precisa de ser
     * aguardado no nivel de topo — o runner faz a espera. Com
     * `no-floating-promises` ligado, cada `test(...)` do ficheiro vira erro:
     * 129 dos 131 erros da primeira corrida desta configuracao eram isso, e
     * nenhum era defeito. Como `test()` devolve `Promise<void>` cru, nao ha
     * tipo nomeado para dar a `allowForKnownSafePromises`; desligar a regra
     * em `test/**` e a unica forma honesta.
     *
     * As outras tres regras type-aware (`no-misused-promises`,
     * `await-thenable`, `switch-exhaustiveness-check`) continuam ligadas aqui.
     */
    name: 'dsh-guard/node-test-runner',
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },

  /* ------------------------------------------------------------------ */
  /* R1 — vale no repositorio inteiro, TS e JS                           */
  /* ------------------------------------------------------------------ */
  {
    name: 'dsh-guard/no-phantom-package',
    files: [...TS, ...JS],
    rules: { 'no-restricted-imports': ['error', ONLY_404_OPTS] },
  },

  /* ------------------------------------------------------------------ */
  /* R2 — o adaptador e a unica fronteira com o DSH                      */
  /* ------------------------------------------------------------------ */
  {
    name: 'dsh-guard/dsh-only-in-adapter',
    files: ['src/**/*.ts', 'worker/**/*.ts', 'bin/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', SCOPE_AND_404_OPTS] },
  },
  {
    /* A excecao nomeada. R2 cai aqui — R1 NAO: nem o adaptador pode importar
       um pacote que nao existe. */
    name: 'dsh-guard/adapter-is-the-boundary',
    files: ['src/dsh/adapter.ts'],
    rules: { 'no-restricted-imports': ['error', ONLY_404_OPTS] },
  },

  /* ================================================================== */
  /* BLOCO TRANSITORIO — APAGAR NO COMMIT DE T1.1                        */
  /* ================================================================== */
  /*
   * `src/index.ts` e `test/index.test.ts` sao o monolito pre-refactor da
   * Onda 0. Hoje eles:
   *   - importam `@deepseek-ai/dsh-host-subprocess` (o pacote 404);
   *   - importam `@deepseek-ai/*` fora do adaptador;
   *   - tem dois `catch` vazios (src/index.ts:757 e :1467).
   * Os dois primeiros sao 2 dos 30 erros de `tsc --noEmit` que T1.1 fecha
   * NESTA MESMA onda, dissolvendo ambos os ficheiros na arvore canonica de D1.
   *
   * Deixar as regras em `error` aqui poria `pnpm lint` vermelho por um defeito
   * que nao e do dono deste ficheiro e que ja tem dono declarado. Rebaixar
   * para `warn` mantem o achado VISIVEL em cada corrida sem transformar o
   * gate da onda em refem.
   *
   *   >>> T1.1: ao dissolver `src/index.ts` e apagar `test/index.test.ts`,
   *   >>> APAGUE ESTE BLOCO INTEIRO — e o override homonimo do
   *   >>> `.oxlintrc.json`. Sem isso, `src/index.ts` fica com um buraco
   *   >>> permanente nas duas unicas regras de lint proprias deste projeto.
   */
  {
    name: 'dsh-guard/TRANSITORIO-monolito-onda-0',
    files: ['src/index.ts', 'test/index.test.ts'],
    rules: {
      'no-restricted-imports': ['warn', SCOPE_AND_404_OPTS],
      'no-restricted-syntax': ['warn', ...RESTRICTED_SYNTAX],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
])
