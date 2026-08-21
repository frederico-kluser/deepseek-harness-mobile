/**
 * `pnpm package:check` (terceira etapa) - valida o conteudo do tarball REAL.
 *
 * O QUE FAZ
 *   Roda `pnpm pack`, descompacta o .tgz produzido num diretorio temporario e
 *   afirma, NOS DOIS SENTIDOS, o conjunto canonico de 09 §D13 / 06 §8.3:
 *
 *     CONTEM    dist/index.js, dist/index.d.ts, dist/worker/telegram-bot.js,
 *               dist/bin/dsh-guard-setup.js (o alvo do campo `bin`, 06 §9.2),
 *               cordis.patch.yml, README.md, LICENSE, CHANGELOG.md
 *     NAO CONTEM src/, types/, test/, docs/, .env
 *
 *   Falha de forma explicita tanto se faltar um ficheiro obrigatorio como se um
 *   dos prefixos proibidos aparecer - nao ha verificacao so de um lado.
 *
 * PORQUE `pnpm pack` E NAO `npm pack --dry-run`
 *   `--dry-run` lista o que o npm calcularia; correr o pack real e descompacta-lo
 *   prova a realidade: o .tgz existe, descomprime, e o que esta dentro e o que o
 *   consumidor recebe. Confirmar que `files` inclui `dist` e que `dist/` estar no
 *   .gitignore nao causa surpresa e exatamente o que este script verifica.
 *
 * DEPENDENCIAS DO SISTEMA
 *   Usa o `tar` de linha de comandos (disponivel em linux/darwin, os sistemas
 *   suportados pelo package.json).
 *
 * USO:
 *   node scripts/check-tarball.mjs        # corre o pack e verifica
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Ficheiros que o tarball TEM de conter (09 §D13, 06 §8.3, 04 §10 item 4). */
const REQUIRED = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/worker/telegram-bot.js',
  'dist/bin/dsh-guard-setup.js', // o alvo do campo `bin` (06 §9.2, item 10 do smoke)
  'dist/src/contracts/ipc.js', // o UNICO ficheiro de dist/src exigido em runtime:
  // `worker/ipc.ts` importa `../src/contracts/ipc.ts`, que o tsconfig.worker.json
  // (rootDir \".\") emite para dist/src/contracts/ipc.js. Regressar a emissao
  // (ou mudar o import) sem este ficheiro teria de falhar aqui.
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
]

/** Prefixos que o tarball NAO pode conter (06 §8.3). */
const FORBIDDEN_PREFIXES = ['src/', 'types/', 'test/', 'docs/', '.env']

function fail(message) {
  console.error('check-tarball.mjs: FALHOU - ' + message)
  process.exitCode = 1
}

try {
  const work = mkdtempSync(join(tmpdir(), 'dsh-check-tarball-'))
  // `pnpm pack --pack-destination <dir>` imprime o CAMINHO ABSOLUTO do .tgz na
  // ultima linha do stdout (depois do banner "Tarball Contents"). Reutiliza-se
  // esse caminho tal-qual; a unica salvaguarda e existir exactamente um .tgz.
  const out = execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8' })
  const lines = (out || '').replace(/\r\n/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean)
  const printed = lines.filter((s) => s.endsWith('.tgz')).pop()
  let tgzPath
  if (printed) {
    tgzPath = join(printed) // normaliza; j\u00e1 vem absoluto quando \u00e9 o pack real
  } else {
    const files = readdirSync(work).filter((f) => f.endsWith('.tgz'))
    if (files.length !== 1) throw new Error('esperado 1 .tgz no destino, encontrados: ' + files.join(', '))
    tgzPath = join(work, files[0])
  }
  execFileSync('tar', ['-xzf', tgzPath, '-C', work], { encoding: 'utf8' })
  const base = join(work, 'package')
  if (!existsSync(base)) throw new Error('tarball sem raiz package/ em: ' + tgzPath)

  const present = new Set()
  const walk = (p) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else present.add(full.slice(base.length + 1).replace(/\\/g, '/'))
    }
  }
  walk(base)

  for (const required of REQUIRED) {
    if (!present.has(required)) fail('faltou ' + required + ' no tarball')
    else console.log('ok  CONTEM  ' + required)
  }

  const violations = [...present].filter((p) => FORBIDDEN_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix)))
  for (const v of violations) fail('nao podia conter ' + v + ' (prefixo proibido)')

  if (process.exitCode) {
    console.error('check-tarball.mjs: verificadas ' + present.size + ' entradas em ' + tgzPath + '. Consultar a lista acima.')
  } else {
    console.log('ok  check-tarball.mjs: ' + present.size + ' entradas verificadas em ' + tgzPath)
  }
  rmSync(work, { recursive: true, force: true })
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
