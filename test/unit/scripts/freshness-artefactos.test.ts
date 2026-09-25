/**
 * FRESHNESS DOS ARTEFACTOS COMMITADOS (MED-2 da revisao integrada da onda 4).
 *
 * O CONTRATO (o hole que este gate fecha): artefactos `dist/`+`lib/` no git +
 * zero hooks de build + gates so de PRESENCA = o caminho primario (install por
 * link) podia servir artefactos STALE com todos os gates verdes. Repro: mudar
 * uma string em `worker/surface/text.ts` SEM rebuild — `pnpm test`,
 * `test:security`, `test:e2e` e o antigo `package:check` ficavam verdes, mas o
 * plugin instalado entregava o texto ANTIGO (o tarball de um git-dep leva o
 * que esta commitado). O comando que o `CONTRIBUTING.md` sugeria como "check de
 * sincronia" (nao-promessa) passou a GATE:
 *
 *   `check:freshness` = `pnpm run build:all && git diff --exit-code dist lib`
 *                       + `git status --porcelain` vazio sobre `dist`/`lib`
 *
 * e e o PRIMEIRO passo do `package:check` — sempre ativo, sem opt-in por env
 * (o caminho primario serve os artefactos commitados; um stale e o caso que
 * mais facilmente passa nos gates de presenca).
 *
 * PORQUE O `git status --porcelain` ALEM DO `git diff`: o `git diff` nao ve
 * ficheiros NOVOS — um modulo novo da fonte emite um `dist/` novo que ficaria
 * untracked e o gate passava enquanto a instalacao por link servia uma arvore
 * sem o modulo. O porcelain cobre alterados, staged e novos EMITIDOS PELO
 * BUILD. FORA DO ALCANCE do gate, por medicao: um ficheiro criado A MAO em
 * dist/ que o build nao emita e apagado pelo `clean` do `build:all` antes do
 * porcelain e nunca chega ao pacote (o tarball passa pelo clean e o git-dep so
 * serve `git ls-files`) — nao reprova e nao precisa de reprovar.
 *
 * Esta guarda e ESTATICA (le o `package.json`, nao corre o build — ~6s de tsc
 * x3 nao pertencem a `pnpm test`); o comportamento do gate e provado por
 * mutacao no handoff (mudar fonte sem rebuild -> gate reprova; rebuild ->
 * verde).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url))
const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('freshness dos artefactos — dist/lib commitados tem de ser EXATAMENTE o que o build produz', () => {
  it('check:freshness rebuilda e reprova qualquer divergencia dos artefactos commitados', () => {
    const fresco = pkg.scripts['check:freshness']
    assert.ok(fresco, 'falta o script `check:freshness` — sem gate de freshness os artefactos stale passam verdes')
    const iBuild = fresco.indexOf('build:all')
    const iDiff = fresco.indexOf('git diff --exit-code dist lib')
    assert.ok(iBuild >= 0, 'check:freshness tem de correr `build:all` (rebuild deterministico, clean primeiro)')
    assert.ok(iDiff > iBuild, 'check:freshness tem de difar dist/lib DEPOIS do rebuild (a frescura compara com o commit)')
    // O `git diff` nao ve ficheiros novos: sem o porcelain vazio, um modulo
    // novo emitia um dist/ untracked e o gate passava com a instalacao por
    // link a servir uma arvore sem o modulo.
    assert.ok(
      fresco.includes('git status --porcelain'),
      'check:freshness tem de exigir dist/lib sem alteracoes NEM ficheiros novos (git status --porcelain vazio)',
    )
    // Sem escape por variavel de ambiente: o gate e SEMPRE ativo (um opt-in
    // tipo FRESHNESS=1 deixaria o caminho de release principal sem o gate).
    assert.ok(!fresco.includes('FRESHNESS='), 'check:freshness nao pode ser opt-in por env — tem de ser sempre ativo')
  })

  it('o gate e OBRIGATORIO e PRIMEIRO no package:check — e o publish passa por ele', () => {
    const check = pkg.scripts['package:check'] ?? ''
    assert.ok(
      check.trimStart().startsWith('pnpm run check:freshness'),
      `package:check tem de comecar pelo gate de freshness (artefactos frescos antes dos gates de artefacto); veio: ${check}`,
    )
    // O `prepublishOnly` e o unico caminho de build que chega ao tarball
    // publicado; passando por `package:check`, o release nao publica artefactos
    // stale.
    assert.ok(
      (pkg.scripts['prepublishOnly'] ?? '').includes('package:check'),
      'prepublishOnly tem de passar por package:check (o release corre o gate de freshness)',
    )
  })
})
