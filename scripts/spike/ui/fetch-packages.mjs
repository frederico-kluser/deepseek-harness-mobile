/**
 * T0.4 / S4 — monta uma arvore `node_modules` REAL a partir dos tarballs
 * publicados no npm, para que a medicao leia o `.d.ts` e execute o codigo do
 * host, e nao a prosa dos markdowns (anti-padrao A-14 de 05-QUALIDADE-CODIGO).
 *
 * NAO toca em `package.json` nem em `pnpm-lock.yaml` do repositorio: escreve
 * exclusivamente no diretorio de saida passado por argumento.
 *
 * Uso: node scripts/spike/ui/fetch-packages.mjs <destino> <pkg[@versao]>...
 *      (sem versao, resolve a dist-tag `next` e cai para `latest`)
 */
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const REGISTRY = 'https://registry.npmjs.org'

/** Metadados do pacote no registry publico. */
async function metadata(name) {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`)
  if (!res.ok) throw new Error(`registry ${res.status} para ${name}`)
  return res.json()
}

/**
 * Resolve o especificador para a versao concreta a baixar.
 *
 * Um intervalo declarado por um dependente (`^4.2.0`) e honrado pelo major: sem
 * isto, `latest` traz um major novo e a arvore deixa de arrancar — foi o que
 * aconteceu com `js-yaml@5`, cujo build ESM ja nao tem export `default`, contra
 * o `^4.2.0` que os pacotes do harness declaram.
 */
function pickVersion(meta, wanted) {
  if (wanted !== undefined && meta.versions[wanted] !== undefined) return wanted
  const tags = meta['dist-tags'] ?? {}
  const major = /^[~^]?(\d+)\./.exec(wanted ?? '')
  if (major !== null) {
    const compativeis = Object.keys(meta.versions)
      .filter((v) => v.startsWith(`${major[1]}.`) && !v.includes('-'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const melhor = compativeis.at(-1)
    if (melhor !== undefined) return melhor
  }
  const chosen = tags.next ?? tags.latest
  if (chosen === undefined) throw new Error(`sem dist-tag utilizavel para ${meta.name}`)
  return chosen
}

/** Separa `@escopo/nome@versao` em nome e versao. */
function splitSpec(spec) {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return { name: spec, version: undefined }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

/** Baixa e extrai um tarball em `node_modules/<nome>`, devolvendo o package.json. */
async function install(root, name, version) {
  const dest = join(root, 'node_modules', name)
  const stamp = join(dest, 'package.json')
  if (existsSync(stamp)) return JSON.parse(await readFile(stamp, 'utf8'))

  const meta = await metadata(name)
  const chosen = pickVersion(meta, version)
  const tarball = meta.versions[chosen]?.dist?.tarball
  if (tarball === undefined) throw new Error(`sem tarball para ${name}@${chosen}`)

  const res = await fetch(tarball)
  if (!res.ok) throw new Error(`tarball ${res.status} para ${name}@${chosen}`)
  const tmp = join(root, '.tgz', `${name.replace(/[@/]/g, '_')}.tgz`)
  await mkdir(dirname(tmp), { recursive: true })
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()))

  await mkdir(dest, { recursive: true })
  await run('tar', ['xzf', tmp, '-C', dest, '--strip-components=1'])
  console.log(`instalado ${name}@${chosen}`)
  return JSON.parse(await readFile(stamp, 'utf8'))
}

/**
 * Instala o fecho transitivo de `dependencies` E de `peerDependencies`. Os
 * pacotes do harness declaram os irmaos como peers, portanto parar nos peers da
 * raiz deixa a arvore por importar — a composicao real nao arranca assim.
 */
async function installClosure(root, specs) {
  const seen = new Set()
  const queue = specs.map(splitSpec)
  while (queue.length > 0) {
    const { name, version } = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    let pkg
    try {
      pkg = await install(root, name, version)
    } catch (error) {
      console.log(`ignorado ${name}: ${error.message}`)
      continue
    }
    const vizinhos = { ...pkg.dependencies, ...pkg.peerDependencies }
    for (const [dep, intervalo] of Object.entries(vizinhos)) {
      if (!seen.has(dep)) queue.push({ name: dep, version: intervalo })
    }
  }
  return [...seen]
}

const [dest, ...specs] = process.argv.slice(2)
if (dest === undefined || specs.length === 0) {
  console.error('uso: node fetch-packages.mjs <destino> <pkg[@versao]>...')
  process.exit(2)
}
await mkdir(dest, { recursive: true })
await writeFile(join(dest, 'package.json'), JSON.stringify({ name: 'dsh-spike-ui-runtime', private: true, type: 'module' }, null, 2))
const installed = await installClosure(dest, specs)
await rm(join(dest, '.tgz'), { recursive: true, force: true })
console.log(`\n${installed.length} pacotes em ${join(dest, 'node_modules')}`)
