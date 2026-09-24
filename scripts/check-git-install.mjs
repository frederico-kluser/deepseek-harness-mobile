/**
 * `pnpm package:check` (quarta etapa) - prova de PONTA A PONTA do install-by-link.
 *
 * O QUE FAZ
 *   Reproduz, de forma CONTIDA e sem rede, o que `dsh plugin add
 *   github:frederico-kluser/dsh-guard-messenger` faz: um `pnpm add` de uma
 *   dependencia git dentro de um projeto consumidor com o mesmo layout do
 *   perfil DSH (`packages: [.], nodeLinker: hoisted, autoInstallPeers: false`).
 *
 *   1. copia os ficheiros RASTREADOS pelo git (`git ls-files`) para um repo
 *      sintetico em tmpdir - ou seja, exatamente o que um clone/codeload do
 *      GitHub entrega (nada de `dist/`/`lib/` gitignored, nada de `node_modules`);
 *   2. `pnpm add git+file://<repo-sintetico>` num consumidor limpo, SEM
 *      `allowBuilds` no pnpm-workspace.yaml (como nas instalacoes reais);
 *   3. afirma que o pacote instalado CONTEM os artefactos compilados e o
 *      `dsh.bundle.patch` que o `dsh plugin add` precisa para ativar a bundle.
 *
 * PORQUE ISTO EXISTE (a causa raiz que este gate fecha)
 *   O pacote ja viveu com `prepare`/`prepack` a correr `build:all` no install e
 *   `dist/`/`lib/` gitignorados. Nesse desenho o install-by-link e impossivel:
 *   o artefacto de um git-dep so leva o que esta no git (sem build nao ha
 *   `dist/`), e com build hooks o pnpm 11 LANCA
 *   `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` porque so executa build scripts de
 *   dependencias com entrada em `allowBuilds` (chave pinada ao SHA - cada push
 *   volta a bloquear). Medido nas duas variantes: `prepack` sozinho ja bloqueia.
 *   A solucao e o padrao de `dsh-worktree-jump`: artefacto compilado COMMITADO
 *   no git e zero hooks de build. Este script prova o contrato inteiro; a
 *   guarda estatica (hooks ausentes + entrypoints rastreados) vive em
 *   test/unit/scripts/install-by-link.test.ts.
 *
 * DEPENDENCIAS DO SISTEMA
 *   `git` (repo sintetico) e `pnpm` (add no consumidor). A resolucao das
 *   dependencias de runtime do pacote (grammy) usa a store/registry do pnpm -
 *   como o `test:contract`, que tambem fala com o registry.
 *
 * USO:
 *   node scripts/check-git-install.mjs   # corre o ciclo e verifica
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Ficheiros que a instalacao TEM de entregar (entrypoints + worker + bundle). */
const REQUIRED = [
  'package.json',
  'dist/index.js', // main + exports["."].default
  'dist/index.d.ts', // types + exports["."].types
  'lib/client.js', // exports["./client"].default (dsh.client)
  'lib/client.d.ts', // exports["./client"].types
  'dist/bin/dsh-guard-setup.js', // alvo do campo `bin`
  'dist/worker/telegram-bot.js', // entry do worker (subprocesso)
  'dist/src/contracts/ipc.js', // importado por worker/ipc.ts
  'cordis.patch.yml', // alvo de dsh.bundle.patch
]

function fail(message) {
  console.error('check-git-install.mjs: FALHOU - ' + message)
  process.exitCode = 1
}

/** Copia os ficheiros RASTREADOS pelo git para `destino` (a visao de um clone). */
function copiarArvoreGit(destino) {
  const lista = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean)
  if (lista.length === 0) throw new Error('`git ls-files` vazou - sem ficheiros rastreados nao ha o que instalar')
  for (const rel of lista) {
    const origem = join(ROOT, rel)
    if (!existsSync(origem)) throw new Error(`rastreado pelo git mas ausente no disco: ${rel}`)
    const alvo = join(destino, rel)
    mkdirSync(dirname(alvo), { recursive: true })
    copyFileSync(origem, alvo)
  }
  return lista.length
}

let work
try {
  work = mkdtempSync(join(tmpdir(), 'dsh-git-install-'))
  const repo = join(work, 'plugin')
  const consumidor = join(work, 'consumer')
  mkdirSync(repo)
  mkdirSync(consumidor)

  const total = copiarArvoreGit(repo)
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync(
    'git', ['-C', repo, '-c', 'user.email=repro@localhost', '-c', 'user.name=repro', 'commit', '-qm', 'arvore rastreada'],
    { stdio: 'ignore' },
  )

  // O mesmo layout que o `dsh plugin add` usa (perfil DSH: operations.ts corre o
  // pnpm no diretorio do perfil, que declara este pnpm-workspace.yaml).
  writeFileSync(join(consumidor, 'package.json'), JSON.stringify({ name: 'repro-consumidor', private: true }, undefined, 2) + '\n')
  writeFileSync(join(consumidor, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

  let saida = ''
  let codigo = 0
  try {
    saida = execFileSync('pnpm', ['add', `git+file://${repo}`], {
      cwd: consumidor, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUSKY: '0' },
    })
  } catch (err) {
    codigo = err.status ?? -1
    saida = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  if (codigo !== 0) {
    fail(
      'o install por link REPROVOU (exit ' + codigo + ').\n' +
      'Se a saida acima nomeia ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED, o pacote voltou a declarar ' +
      'um hook de build (`prepare`/`prepack`/`postinstall`): o pnpm 11 bloqueia build scripts de ' +
      'git-deps sem entrada `allowBuilds` (chave pinada ao SHA - reinstalar volta a falhar). ' +
      'O contrato e: ZERO hooks de build e artefactos `dist/`+`lib/` commitados no git.\n' +
      'Saida do pnpm:\n' + saida.slice(-2000),
    )
    process.exit(1)
  }

  const instalado = join(consumidor, 'node_modules', 'dsh-guard-messenger')
  if (!existsSync(instalado)) {
    fail('o pnpm terminou 0 mas nao instalou node_modules/dsh-guard-messenger')
    process.exit(1)
  }
  for (const required of REQUIRED) {
    if (!existsSync(join(instalado, required))) fail('faltou ' + required + ' na instalacao por link')
    else console.log('ok  CONTEM  ' + required)
  }

  // A ativacao da bundle: `dsh plugin add` so marca a bundle se o manifesto
  // instalado declarar `dsh.bundle.patch` (operations.ts: bundleManifest()).
  const manifest = JSON.parse(readFileSync(join(instalado, 'package.json'), 'utf8'))
  const patch = manifest.dsh?.bundle?.patch
  if (patch !== './cordis.patch.yml') {
    fail(`dsh.bundle.patch instalado devia ser "./cordis.patch.yml", veio ${JSON.stringify(patch)} — o dsh plugin add nao ativaria a bundle`)
  } else {
    console.log('ok  ATIVA    dsh.bundle.patch -> ' + patch)
  }

  if (process.exitCode) {
    console.error('check-git-install.mjs: verificados ' + REQUIRED.length + ' alvos da instalacao por link.')
  } else {
    console.log('ok  check-git-install.mjs: install por link funcional (' + total + ' ficheiros no git, sem allowBuilds)')
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
} finally {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
}
