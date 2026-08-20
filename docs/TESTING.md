# TESTING.md — notas de operação da suíte (criado por T6.3)

Este ficheiro regista as notas que não pertencem ao corpo de 04-TESTES.md —
nomeadamente o veredito do spike de T6.3 sobre o Stryker e o limite do
tap-runner com `node:test`.

## Stryker + node:test — veredito do spike (T6.3)

O spike de 1 h (registado em docs/mutantes.md) mediu `@stryker-mutator/core@10.0.0`
com `@stryker-mutator/tap-runner@10.0.0` nesta matriz (Node 24, pnpm 11, TS em
strip-only mode). Conclusão: **suporte funcional via tap-runner**, com um limite
que tem de ser conhecido por quem ler os relatórios:

- O Stryker **não tem runner nativo para `node:test`** (feature request #5421
  aberta, sem implementação). O caminho documentado é o **tap-runner**, que
  executa o runner nativo do Node como produtor de TAP.
- O tap-runner vê cada FICHEIRO de teste como uma unidade (o dry-run conta
  "1 test" por ficheiro). Consequência: `coverageAnalysis: 'perTest'` reporta
  falsos `no-cov`; a config deste repositório usa **`coverageAnalysis: 'all'`**
  (suite inteira por mutante — mais lento, correcto).
- Mutações em código de NÍVEL DE MÓDULO (ex.: remover o `assertRateLimitPolicy`
  de load) fazem o processo de teste morrer ao importar → contabilizadas como
  ERROS, não como mortos. Aceite: `break: null`.
- **O score de ferramenta NÃO é critério de aceite.** O critério é o checklist
  manual de 50 mutantes em docs/mutantes.md (48/50 mortos por teste dirigido,
  2/50 com justificativa escrita de não-matabilidade). O job noturno de mutação
  roda com `break` desligado e não bloqueia PR.

## Execução

```bash
pnpm test:mutation   # stryker run (job noturno, break null, incremental)
```

## test:cov e a suite de seguranca (decisao registada)

O script `test:cov` passou a incluir `test/security/**/*.test.ts` nos globs de
EXECUCAO (o `--test-coverage-exclude='test/**'` so exclui os ficheiros de teste
do RELATORIO, nao da execucao). Razao: 04-TESTES 6 declara a suite de seguranca
"em todo push, bloqueia merge" — um gate mandatorio. Medir cobertura sem a correr
subestima precisamente os modulos com os pisos mais rigidos (src/http, src/control:
95/90/100 em 04-TESTES 11.1). Medido: `src/http/gate.ts` passa de 77% para 91.76%
de branches e `src/http/host-header.ts` de 87.39% para 96.43% quando a suite de
seguranca entra na medicao.

LIMITE REGISTADO: o piso GLOBAL de funcoes (95%) nao e atingido (93.83%) — e um
estado PRE-EXISTENTE do baseline PREP-6 (verificado por stash: HEAD tambem sai 1),
causado por ficheiros fora do escopo exclusivo de T6.3: `src/index.ts` (55.26%
funcoes; 04-TESTES 11.2 diz explicitamente "nao perseguir" a cobertura da raiz de
composicao), `worker/telegram-bot.ts` (50%) e `worker/lib/clock.ts` (60%).
T6.3 nao pode tocar em `src/**`, `worker/**` nem `test/unit/**`. A catraca
(scripts/coverage-ratchet.mjs) e pendencia de outra onda (ci.yml).
