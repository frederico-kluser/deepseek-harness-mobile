/**
 * Caminho de release (`package.json` scripts + `scripts/check-tarball.mjs`) --
 * guarda de regressao da REMOCAO DO PROVEDOR DISCORD (HIGH-1 da revisao
 * adversarial da onda 1): artefactos compilados STALE de um modulo ja apagado
 * (`dist/worker/providers/discord/**` -- 8 modulos + 8 sourcemaps, mtimes
 * antigos) sobreviviam ao `build:all` (o `tsc` so escreve o que a fonte ainda
 * declara, nunca apaga o que la esta) e iao no tarball publicado, com o gate
 * `pnpm package:check` a passar verde por cima deles.
 *
 * Duas defesas, afirmadas aqui:
 *   1. `clean` (apaga `dist/` e `lib/`) corre ANTES da compilacao em
 *      `build:all` -- o caminho que `prepublishOnly` usa (os hooks de build do
 *      install/pack, `prepare`/`prepack`, foram REMOVIDOS de proposito: o pnpm
 *      11 bloqueia-os em git-deps e impedia o install-by-link),
 *      ou seja, todo o caminho do artefato compila para uma arvore limpa
 *      (its 1-2, leitura direta da configuracao);
 *   2. FORBIDDEN_PREFIXES do verificador do tarball rejeita
 *      `dist/worker/providers/discord/` e `lib/worker/providers/discord/` --
 *      se os restos compilados voltarem por qualquer outro caminho,
 *      `pnpm package:check` FALHA em vez de publicar a remocao falsa
 *      (it 3 guarda o contrato; its 4-5 correm o GATE REAL).
 *
 * Os its 4-5 executam o PROPRIO `scripts/check-tarball.mjs` contra um artefacto
 * craftado: um mini-pacote em tmpdir (sem scripts de lifecycle -- um `prepack`
 * de build limparia os restos antes de o verificador os ver) levando o script
 * copiado byte-a-byte em runtime, porque o ROOT do script e a raiz do pacote
 * onde ele vive. NAO ha matcher reimplementado neste ficheiro: sabotar o
 * matcher real (ex.: `p === prefix.slice(0, -1)`) deixa o gate cego e o it 5
 * fica VERMELHO (prova por mutacao registada no handoff da onda 2).
 *
 * AMBIENTE (guarda dos its 4-5): o gate real chama `pnpm pack` e descompacta o
 * .tgz (tar). Sem `pnpm`/`tar` no PATH os casos reprovavam em ENOENT --
 * vermelho de AMBIENTE, nao de comportamento (o gate nem chegava a correr e o
 * it 5 nunca via a mensagem canonica). A guarda SALTA com o motivo nomeado em
 * vez de reprovar em silencio.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as {
  scripts: Record<string, string>
}
const gateSource = readFileSync(new URL('scripts/check-tarball.mjs', ROOT), 'utf8')

/**
 * Espelho da lista REQUIRED do gate -- o craft so prova o matcher se for um
 * tarball VALIDO; se a lista REQUIRED do gate crescer, o caso verde (it 4)
 * reprova e este craft acompanha-a.
 */
const REQUIRED_CRAFT = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/worker/telegram-bot.js',
  'dist/bin/dsh-guard-setup.js',
  'lib/client.js',
  'dist/src/contracts/ipc.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
]

/** Os restos que o repro da revisao encontrava no tarball publicado. */
const RESTOS_DISCORD = [
  'dist/worker/providers/discord/adapter.js',
  'dist/worker/providers/discord/adapter.js.map',
]

/**
 * O adaptador TELEGRAM VIVO que o tarball real SEMPRE leva -- assercao
 * trasplantada da versao 1 do teste ("`dist/worker/providers/telegram/adapter.js`
 * NAO e proibido"): o artefacto craftado leva-o, e o caso verde so passa com
 * exit 0 COM esta entrada presente. Um prefixo largo que proiba o provedor
 * vivo (ex.: `dist/worker/providers/` -- mutacao C do handoff) reprova o caso
 * verde em vez de passar em silencio.
 */
const ENTRADA_VIVA = 'dist/worker/providers/telegram/adapter.js'

/** Extrai o LITERAL `FORBIDDEN_PREFIXES` do verificador (a semantica e
 * afirmada pelos its 4-5, que correm o script real -- aqui nao ha regras
 * proprias, so o contrato do artefato). */
function forbiddenPrefixes(): string[] {
  const block = /const FORBIDDEN_PREFIXES = \[([\s\S]*?)\]/.exec(gateSource)
  assert.ok(block, 'scripts/check-tarball.mjs deixou de declarar FORBIDDEN_PREFIXES')
  return [...(block[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '')
}

/** Mini-pacote craftado em tmpdir: package.json sem lifecycle + REQUIRED + a
 * entrada viva do adaptador telegram + (opcional) restos do discord + o
 * proprio script do gate. */
function craftarArtefacto(comRestosDiscord: boolean): string {
  const raiz = mkdtempSync(join(tmpdir(), 'dsh-prova-gate-'))
  writeFileSync(
    join(raiz, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-guard-prova-gate',
        version: '0.0.0',
        type: 'module',
        files: ['dist', 'lib', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md'],
      },
      null,
      2,
    ),
  )
  const ficheiros = [...REQUIRED_CRAFT, ENTRADA_VIVA, ...(comRestosDiscord ? RESTOS_DISCORD : [])]
  for (const f of ficheiros) {
    mkdirSync(dirname(join(raiz, f)), { recursive: true })
    writeFileSync(join(raiz, f), '')
  }
  mkdirSync(join(raiz, 'scripts'), { recursive: true })
  cpSync(new URL('scripts/check-tarball.mjs', ROOT), join(raiz, 'scripts/check-tarball.mjs'))
  return raiz
}

/** Corre o script real do gate na raiz craftada (ele mesmo chama `pnpm pack`
 * e descompacta o .tgz -- de ponta a ponta, como no `package:check`). */
function correrGate(raiz: string): { codigo: number; saida: string } {
  try {
    const saida = execFileSync(process.execPath, ['scripts/check-tarball.mjs'], {
      cwd: raiz,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { codigo: 0, saida }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { codigo: e.status ?? -1, saida: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/**
 * As ferramentas que o GATE REAL precisa no PATH (`pnpm pack` + descompactacao
 * tar). Devolve o motivo do SALTO quando falta alguma: um ENOENT aqui reprovaria
 * os its 4-5 sem que o gate chegasse a correr -- vermelho de ambiente, nao de
 * comportamento (e o it 5 nunca veria a mensagem canonica).
 */
function motivoDeSaltoDoGate(): string | undefined {
  for (const ferramenta of ['pnpm', 'tar']) {
    try {
      execFileSync(ferramenta, ['--version'], { stdio: 'ignore' })
    } catch {
      return `ambiente sem ${ferramenta} no PATH — o gate real precisa de pnpm (pack) e tar (descompactar)`
    }
  }
  return undefined
}

const SALTO_DO_GATE = motivoDeSaltoDoGate()

describe('caminho de release — o artefato nunca arrasta restos de modulos removidos', () => {
  it('clean apaga dist/ e lib/', () => {
    const clean = pkg.scripts['clean']
    assert.ok(clean, 'falta o script `clean`')
    assert.match(clean, /\brm -rf\b/, 'clean tem de apagar de forma determinica')
    assert.match(clean, /\bdist\b/, 'clean tem de apagar dist/')
    assert.match(clean, /\blib\b/, 'clean tem de apagar lib/ (bundle do cliente)')
  })

  it('build:all limpa ANTES de compilar e o unico hook de lifecycle passa por ele', () => {
    const buildAll = pkg.scripts['build:all']
    assert.ok(buildAll, 'falta o script `build:all`')
    const iClean = buildAll.indexOf('clean')
    const iBuild = buildAll.search(/\bbuild\b/)
    assert.ok(iClean >= 0, 'build:all nao chama `clean`')
    assert.ok(iBuild > iClean, 'build:all tem de limpar ANTES de compilar')
    // `prepare`/`prepack` estao AUSENTES de proposito: hooks de build correm no
    // install de um git-dep e o pnpm 11 bloqueia-os
    // (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED em `pnpm add github:...`) — era
    // EXATAMENTE isto que impedia o install-by-link. O artefacto compilado e
    // commitado no git; guarda completa em test/unit/scripts/install-by-link.test.ts.
    for (const hook of ['prepare', 'prepack']) {
      assert.equal(
        pkg.scripts[hook],
        undefined,
        `${hook} tem de estar AUSENTE — bloqueia o install por link (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED)`,
      )
    }
    // `prepublishOnly` e o UNICO caminho de build que chega ao tarball
    // publicado e so corre no `pnpm publish` (nunca para dependencias) — tem de
    // passar por build:all (limpeza determinica antes do build).
    assert.ok(
      (pkg.scripts['prepublishOnly'] ?? '').includes('build:all'),
      'prepublishOnly tem de passar por build:all (limpeza determinica antes do build)',
    )
  })

  it('o contrato do gate proibe restos compilados do provedor discord (dist/ e lib/)', () => {
    const prefixes = forbiddenPrefixes()
    assert.ok(
      prefixes.includes('dist/worker/providers/discord/'),
      'FORBIDDEN_PREFIXES tem de proibir dist/worker/providers/discord/ (8 modulos + sourcemaps stale)',
    )
    assert.ok(
      prefixes.includes('lib/worker/providers/discord/'),
      'FORBIDDEN_PREFIXES tem de proibir o espelho obsoleto lib/worker/providers/discord/',
    )
  })

  it('gate real: aprova o artefacto limpo COM o adaptador telegram vivo presente (entrada nao-proibida)', (t) => {
    if (SALTO_DO_GATE !== undefined) return t.skip(SALTO_DO_GATE)
    const raiz = craftarArtefacto(false)
    try {
      assert.ok(existsSync(join(raiz, ENTRADA_VIVA)), `o craft tem de levar ${ENTRADA_VIVA} (adaptador vivo)`)
      const { codigo, saida } = correrGate(raiz)
      assert.equal(
        codigo,
        0,
        `gate devia aprovar o tarball limpo COM ${ENTRADA_VIVA} presente -- reprova-lo seria proibir o provedor VIVO (mutacao C?); saida: ${saida}`,
      )
      assert.ok(!saida.includes('FALHOU'), `nao havia violacoes a reportar; saida: ${saida}`)
      assert.match(saida, /check-tarball\.mjs: \d+ entradas verificadas/, `gate devia ter corrido; saida: ${saida}`)
    } finally {
      rmSync(raiz, { recursive: true, force: true })
    }
  })

  it('gate real: reprova os restos do provedor discord com a mensagem canonica', (t) => {
    if (SALTO_DO_GATE !== undefined) return t.skip(SALTO_DO_GATE)
    const raiz = craftarArtefacto(true)
    try {
      const { codigo, saida } = correrGate(raiz)
      assert.equal(
        codigo,
        1,
        `gate devia reprovar dist/worker/providers/discord/** (matcher real sabotado?); saida: ${saida}`,
      )
      assert.ok(
        saida.includes('nao podia conter dist/worker/providers/discord/adapter.js (prefixo proibido)'),
        `a rejeicao tem de nomear o resto proibido; saida: ${saida}`,
      )
    } finally {
      rmSync(raiz, { recursive: true, force: true })
    }
  })
})
