/**
 * Stryker 10.0.0 — mutation testing de NIGHTLY, com break desligado.
 *
 * VEREDITO DO SPIKE DE T6.3 (registado em docs/mutantes.md): o Stryker NAO tem
 * runner nativo para node:test (issue #5421 aberta) e o runner oficial de
 * "tap" e o caminho DOCUMENTADO para ele — o doc do tap-runner nomeia o runner
 * nativo do Node como produtor de TAP suportado desde v7.0. Medido nesta matriz
 * (Node 24.15, pnpm 11.7, TS em strip-only mode):
 *
 *   - src/ratelimit/policy.ts (134 mutantes) com os testes de politica e de
 *     tracker: 92 mortos, 0 no-cov, coverageAnalysis 'all';
 *   - src/http/gate.ts + path.ts (314 mutantes) com as suites de seguranca e de
 *     integracao do portao: 160 mortos, 82 no-cov legitimos (codigo exercitado
 *     so por suites nao incluidas naquela execucao), 2 erros.
 *
 * LIMITACOES DECLARADAS, e por isso esta config usa-as de forma honesta:
 *
 *   - PER-TEST coverage NAO esta disponivel: o tap-runner ve cada FICHEIRO como
 *     uma unidade de teste (o dry-run conta "1 test" por ficheiro), logo
 *     coverageAnalysis 'perTest' reporta falsos no-cov. Usa-se 'all': a suite
 *     inteira corre por mutante. Mais lento, correcto.
 *   - Mutacoes em codigo de NIVEL DE MODULO (ex.: apagar o assertRateLimitPolicy
 *     de load) fazem o processo de teste morrer ao importar, contabilizadas como
 *     ERROS, nao como mortos. Aceite: break null e o job nao bloqueia PR.
 *   - O score de ferramenta NAO e criterio de aceite (04-TESTES 7.2/7.3). O
 *     criterio e o checklist manual de 50 mutantes em docs/mutantes.md.
 *
 * incremental ligado para CI: a segunda execucao so reavalia o delta.
 */
export default {
  plugins: ['@stryker-mutator/tap-runner'],
  testRunner: 'tap',
  tap: {
    testFiles: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/security/**/*.test.ts',
      'test/contract/**/*.test.ts',
    ],
    // Bail assim que um teste do ficheiro falha: o mutante esta morto, nao ha
    // razao para gastar o resto da suite.
    forceBail: true,
  },
  mutate: [
    'src/**/*.ts',
    'worker/**/*.ts',
    '!src/index.ts',
  ],
  coverageAnalysis: 'all',
  // Thresholds normativos do plano (04-TESTES 7.3): informam, nunca quebram.
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 60000,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  concurrency: 4,
  incremental: true,
  incrementalFile: 'node_modules/.cache/stryker-incremental.json',
  reporters: ['clear-text', 'html', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
}
