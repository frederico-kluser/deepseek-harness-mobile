/**
 * Install-by-link (`dsh plugin add github:...`) — guarda de regressao da causa
 * raiz que impedia a instalacao do plugin pelo link do GitHub.
 *
 * O CONTRATO (medido, nao deduzido):
 *   1. ZERO hooks de build no `package.json` (`prepare`, `prepack`,
 *      `postinstall`, ...). Um git-dep com hook de build faz o pnpm 11 LANCAR
 *      `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` antes de instalar — so executa
 *      build scripts de dependencias com entrada em `allowBuilds`, e essa chave
 *      e pinada ao SHA do commit (cada push volta a bloquear). Medido nas duas
 *      variantes: `prepack` sozinho ja bloqueia.
 *   2. Os artefactos compilados (`dist/`, `lib/`) estao RASTREADOS pelo git: o
 *      tarball de um git-dep so leva o que o git tem — sem artefacto commitado
 *      a instalacao passa mas entrega um pacote SEM `dist/index.js` (plugin
 *      morto no boot, MissingClientBundleError no `./client`).
 *   3. Os entrypoints (`main`, `types`, `exports`, `bin`) e o alvo de
 *      `dsh.bundle.patch` estao rastreados E cobertos pelo allowlist `files`.
 *   4. repository/bugs/homepage apontam para o repo RENOMEADO
 *      (dsh-guard-messenger) — o instalador por link e o registry leem estes
 *      campos.
 *
 * O ciclo de PONTA A PONTA (pnpm add git+file:// num consumidor limpo, sem
 * allowBuilds) vive em `scripts/check-git-install.mjs` e corre em
 * `pnpm package:check`; este ficheiro guarda o contrato estatico que o mantem
 * verde (barato, sem pnpm nem rede).
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url))
const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
  name: string
  main?: string
  types?: string
  exports?: Record<string, { types?: string; default?: string } | string>
  bin?: Record<string, string> | string
  files?: string[]
  keywords?: string[]
  scripts?: Record<string, string>
  repository?: { url?: string }
  bugs?: { url?: string }
  homepage?: string
  dsh?: { bundle?: { patch?: string } }
}

/**
 * Hooks de lifecycle que o pnpm trata como BUILD SCRIPT de dependencia (e
 * bloqueia sem `allowBuilds` para git-deps). `prepublishOnly`/`prepublish` do
 * publish nao entram aqui: o pnpm nunca os corre para dependencias.
 */
const HOOKS_DE_BUILD = [
  'preinstall', 'install', 'postinstall',
  'prepublish', 'preprepare', 'prepare', 'postprepare',
  'prepack', 'postpack',
]

/** Alvos de entrypoint que a instalacao tem de entregar. */
function alvosDeEntrada(): string[] {
  const alvos: string[] = []
  for (const campo of [pkg.main, pkg.types]) if (typeof campo === 'string') alvos.push(campo)
  for (const valor of Object.values(pkg.exports ?? {})) {
    if (typeof valor === 'string') alvos.push(valor)
    else for (const alvo of [valor.types, valor.default]) if (typeof alvo === 'string') alvos.push(alvo)
  }
  const bin = pkg.bin
  if (typeof bin === 'string') alvos.push(bin)
  else for (const alvo of Object.values(bin ?? {})) alvos.push(alvo)
  if (typeof pkg.dsh?.bundle?.patch === 'string') alvos.push(pkg.dsh.bundle.patch)
  return [...new Set(alvos.map((alvo) => alvo.replace(/^\.\//, '')))].filter((alvo) => alvo !== 'package.json')
}

/** `true` se o allowlist `files` cobre o caminho (dir de topo ou o proprio ficheiro). */
function cobertoPorFiles(caminho: string): boolean {
  const files = pkg.files ?? []
  return files.includes(caminho) || files.includes(caminho.split('/')[0] ?? '')
}

/** Os ficheiros rastreados pelo git — a visao de um clone (o que o git-dep recebe). */
function rastreadosPeloGit(): Set<string> {
  const saida = execFileSync('git', ['-C', RAIZ, 'ls-files'], { encoding: 'utf8' })
  return new Set(saida.split('\n').filter(Boolean))
}

/** O motivo do SALTO quando nao ha git/repo disponivel (vermelho de ambiente, nao de comportamento). */
function motivoDeSalto(): string | undefined {
  try {
    execFileSync('git', ['-C', RAIZ, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
    return undefined
  } catch {
    return 'sem git ou sem repo em ' + RAIZ + ' — a guarda precisa de `git ls-files` (a visao do clone)'
  }
}

const SALTO = motivoDeSalto()

describe('install-by-link — o que `dsh plugin add github:...` exige do repo', () => {
  it('nenhum hook de build no package.json (prepare/prepack bloqueiam o git-dep)', () => {
    for (const hook of HOOKS_DE_BUILD) {
      assert.equal(
        pkg.scripts?.[hook],
        undefined,
        `${hook} tem de estar AUSENTE: o pnpm 11 bloqueia build scripts de git-deps ` +
        '(ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED) e o install-by-link reprova — ' +
        'o artefacto compilado e commitado no git em vez de construido no install',
      )
    }
    // O caminho de publish continua a limpar e reconstruir antes do tarball.
    assert.ok(
      (pkg.scripts?.['prepublishOnly'] ?? '').includes('build:all'),
      'prepublishOnly tem de passar por build:all (o artefacto publicado nasce de arvore limpa)',
    )
  })

  it('os artefactos compilados dist/ e lib/ estao rastreados pelo git (o git-dep nao leva gitignored)', (t) => {
    if (SALTO !== undefined) return t.skip(SALTO)
    const rastreados = rastreadosPeloGit()
    for (const prova of ['dist/index.js', 'dist/worker/telegram-bot.js', 'lib/client.js', 'lib/client.d.ts']) {
      assert.ok(
        rastreados.has(prova),
        `${prova} tem de estar RASTREADO pelo git — o tarball de um git-dep so leva o que o git tem; ` +
        'sem artefacto commitado a instalacao entrega um pacote morto no boot',
      )
    }
  })

  it('todo o alvo de entrypoint esta rastreado E coberto pelo allowlist files', (t) => {
    if (SALTO !== undefined) return t.skip(SALTO)
    const rastreados = rastreadosPeloGit()
    const alvos = alvosDeEntrada()
    assert.ok(alvos.length >= 5, `poucos entrypoints lidos do package.json: ${alvos.join(', ')}`)
    for (const alvo of alvos) {
      assert.ok(rastreados.has(alvo), `${alvo} (entrypoint) nao esta rastreado pelo git — faltaria na instalacao por link`)
      assert.ok(cobertoPorFiles(alvo), `${alvo} (entrypoint) nao esta coberto por "files" — nao entraria no artefacto`)
    }
  })

  it('dsh.bundle.patch esta declarado, rastreado e coberto (sem ele o dsh plugin add nao ativa a bundle)', (t) => {
    const patch = pkg.dsh?.bundle?.patch
    assert.equal(patch, './cordis.patch.yml', 'dsh.bundle.patch tem de apontar para ./cordis.patch.yml (bundle: {} vazio nao ativa nada)')
    if (SALTO !== undefined) return t.skip(SALTO)
    const rastreados = rastreadosPeloGit()
    assert.ok(rastreados.has('cordis.patch.yml'), 'cordis.patch.yml tem de estar rastreado pelo git')
    assert.ok(cobertoPorFiles('cordis.patch.yml'), 'cordis.patch.yml tem de estar coberto por "files"')
  })

  it('repository/bugs/homepage apontam para o repo renomeado dsh-guard-messenger', () => {
    const esperado = 'https://github.com/frederico-kluser/dsh-guard-messenger'
    assert.equal(pkg.name, 'dsh-guard-messenger', 'o nome do pacote nao muda')
    assert.equal(pkg.repository?.url, `git+${esperado}.git`, 'repository.url tem de ser o repo novo')
    assert.equal(pkg.bugs?.url, `${esperado}/issues`, 'bugs.url tem de ser o repo novo')
    assert.equal(pkg.homepage, `${esperado}#readme`, 'homepage tem de ser o repo novo')
    assert.ok(pkg.keywords?.includes('dsh-plugin'), 'keywords tem de levar dsh-plugin (descoberta)')
    assert.ok(pkg.keywords?.includes('deepseek-harness'), 'keywords tem de levar deepseek-harness (descoberta)')
  })
})
