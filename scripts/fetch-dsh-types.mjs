/**
 * `pnpm types:fetch` — reconstroi `types/**` a partir dos tarballs npm REAIS.
 *
 * PORQUE EXISTE (regra Q-1 de `05-QUALIDADE-CODIGO.md`: "a prosa nao e a API"):
 * os ficheiros em `types/**` sao COPIA LITERAL dos `.d.ts` publicados pelos
 * pacotes `@deepseek-ai/*`, nunca transcricao de um markdown. Este script e a
 * prova executavel disso -- corre-o e o `git diff` tem de sair vazio.
 *
 * QUAL LINHA DE VERSAO (leia isto antes de mexer nos pinos)
 * --------------------------------------------------------
 * A tag `latest` dos subpacotes `@deepseek-ai/dsh-*` esta ESTAGNADA na linha
 * `0.0.1-rc.*`, que NENHUMA composicao real usa. O harness `@deepseek-ai/dsh`
 * (`latest = 0.1.0-rc.7`) declara `@deepseek-ai/dsh-*: ^0.1.0-rc.7`, e o
 * resolvedor entrega `0.1.0-rc.8` -- a linha `next`. Pinar por `latest` mede
 * a API errada e produz um contrato verde contra codigo que ninguem executa.
 * A justificacao completa, com a tabela de dist-tags, esta em
 * `docs/spikes/api-dsh.md` seccao 1.
 *
 * `@deepseek-ai/cordis` e a excecao: `4.0.1` e simultaneamente `latest` e o
 * que o harness pede (`^4.0.1`).
 *
 * Os pinos abaixo sao EXATOS (D18 de `09-DECISOES-CANONICAS.md`): tudo esta em
 * `rc` e o README upstream avisa "developer preview, expect breaking changes".
 * Cada tarball e verificado por `sha256` antes de qualquer ficheiro ser
 * escrito; um digest diferente aborta sem tocar em `types/`.
 *
 * Uso:
 *   node scripts/fetch-dsh-types.mjs            # verifica e reescreve types/
 *   node scripts/fetch-dsh-types.mjs --check    # so verifica, nao escreve
 */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://registry.npmjs.org'

/** Data da verificacao registada no cabecalho de cada stub. */
const VERIFIED_ON = '2026-08-20'

/** Faixa de rc do DSH que este plugin suporta (`06-REPO-E-CI.md`, "Versoes suportadas"). */
const SUPPORTED_RANGE = '@deepseek-ai/dsh 0.1.0-rc.7 .. rc.9'

/**
 * Pinos exatos + digest do tarball. `files` lista os `.d.ts` copiados de
 * `package/lib/types/` para `types/<dir>/`, na ordem de dependencia.
 *
 * `dsh-subprocess-local` e espelhado mas NAO instalado: depende de `node-pty`
 * e `koffi` (nativos, com `postinstall`) e o plugin nao o importa. Os tres
 * `.d.ts` copiados nao referenciam nenhum dos dois (so `terminal.d.ts` e
 * `windows-inspector.d.ts` o fazem, e ficam de fora).
 */
const PINS = [
  {
    pkg: '@deepseek-ai/cordis',
    version: '4.0.1',
    sha256: '31e96b8e13d5c55bfd4316c08ac8925510e0eed86d48a3a9cc86046623074613',
    dir: 'cordis',
    files: ['index.d.ts', 'context.d.ts', 'events.d.ts', 'fiber.d.ts', 'logger.d.ts', 'reflect.d.ts', 'registry.d.ts', 'service.d.ts', 'utils.d.ts'],
  },
  {
    pkg: '@deepseek-ai/dsh-host-webserver',
    version: '0.1.0-rc.7',
    sha256: 'b5fee946c818859bd19d808b8aea492420a1e57e2a074f2f3a6d16ce943ca545',
    dir: 'dsh-host-webserver',
    files: ['index.d.ts', 'invariant.d.ts'],
  },
  {
    pkg: '@deepseek-ai/dsh-subprocess',
    version: '0.1.0-rc.7',
    sha256: '71d951f6d7f34076c9c8f30f931635e87fb2bed4b7959d46f5522016f0661b72',
    dir: 'dsh-subprocess',
    files: ['index.d.ts', 'types.d.ts', 'invariant.d.ts'],
  },
  {
    pkg: '@deepseek-ai/dsh-subprocess-local',
    version: '0.1.0-rc.7',
    sha256: 'ce00c135e16ef8237f2027a677b71b0c21b5081a07eb6b671c95e78f9742c67f',
    dir: 'dsh-subprocess-local',
    files: ['index.d.ts', 'spawn.d.ts', 'process-inspector.d.ts'],
  },
  {
    pkg: '@deepseek-ai/dsh-host-frontend-static',
    version: '0.1.0-rc.7',
    sha256: 'c0c7364e47f9ad99395a38b0fe801e81cd009ffcada527571fd7e8a51b96ccb5',
    dir: 'dsh-host-frontend-static',
    files: ['index.d.ts', 'invariant.d.ts'],
  },
  {
    pkg: '@deepseek-ai/dsh-home-paths',
    version: '0.1.0-rc.7',
    sha256: 'a496c60906b636f1236b2a9de00217e7f5c85a1547066e733e7bba1795c41484',
    dir: 'dsh-home-paths',
    files: ['index.d.ts', 'invariant.d.ts'],
  },
]

/** URL canonica do tarball de um pino (a mesma que `npm view <p> dist.tarball` devolve). */
const tarballUrl = ({ pkg, version }) => {
  const bare = pkg.slice(pkg.indexOf('/') + 1)
  return `${REGISTRY}/${pkg}/-/${bare}-${version}.tgz`
}

/**
 * Leitor `ustar` minimo. Devolve `Map<caminho, Buffer>` apenas das entradas
 * regulares. Sem dependencias e sem depender do binario `tar` do sistema.
 */
function untar(buf) {
  const out = new Map()
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    const type = String.fromCharCode(header[156] ?? 0)
    const body = off + 512
    if (type === '0' || type === '\0') out.set(name, buf.subarray(body, body + size))
    off = body + Math.ceil(size / 512) * 512
  }
  return out
}

/**
 * Cabecalho exigido por `05-QUALIDADE-CODIGO.md` (seccao "Procedimento
 * obrigatorio"): FONTE + VERIFICADO EM + DIVERGENCIAS DELIBERADAS. Stub sem
 * ele nao passa no review. Acrescentamos o URL e o `sha256` do tarball, que
 * tornam a verificacao reexecutavel por terceiros.
 */
const provenance = (pin, entry) =>
  [
    '/**',
    ` * FONTE: ${pin.pkg}@${pin.version}, package/${entry}`,
    ` * VERIFICADO EM: ${VERIFIED_ON} por T0.1 (Onda 0, spike da API real do DSH)`,
    ' * DIVERGENCIAS DELIBERADAS: nenhuma -- copia byte-a-byte do tarball publicado.',
    ` * TARBALL: ${tarballUrl(pin)}`,
    ` * SHA256 : ${pin.sha256}`,
    ` * FAIXA SUPORTADA: ${SUPPORTED_RANGE} (06-REPO-E-CI.md). Regenerar: \`pnpm types:fetch\`.`,
    ' * NAO EDITAR A MAO: tudo abaixo desta linha e o que o pacote publicou (regra Q-1).',
    ' */',
    '',
  ].join('\n')

const check = process.argv.includes('--check')
let failed = false

for (const pin of PINS) {
  const url = tarballUrl(pin)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${pin.pkg}@${pin.version}: HTTP ${res.status} em ${url}`)
  const tgz = Buffer.from(await res.arrayBuffer())
  const digest = createHash('sha256').update(tgz).digest('hex')
  if (digest !== pin.sha256) throw new Error(`${pin.pkg}@${pin.version}: sha256 ${digest} != pino ${pin.sha256}`)
  console.log(`ok  sha256 ${digest}  ${pin.pkg}@${pin.version}`)

  const entries = untar(gunzipSync(tgz))
  const destDir = join(ROOT, 'types', pin.dir)
  if (!check) await mkdir(destDir, { recursive: true })

  for (const file of pin.files) {
    const src = entries.get(`package/lib/types/${file}`)
    if (src === undefined) throw new Error(`${pin.pkg}@${pin.version}: package/lib/types/${file} ausente no tarball`)
    const body = provenance(pin, `lib/types/${file}`) + src.toString('utf8')
    const dest = join(destDir, file)
    if (check) {
      const current = await readFile(dest, 'utf8').catch(() => null)
      if (current !== body) {
        console.error(`DIVERGE  types/${pin.dir}/${file}`)
        failed = true
      }
      continue
    }
    await writeFile(dest, body)
    console.log(`    -> types/${pin.dir}/${file}`)
  }
}

if (!check) {
  // E1: `@deepseek-ai/dsh-host-subprocess` da 404 no npm. O directorio com esse
  // nome nao pode voltar a existir; CONTRACT-004 assere a inexistencia.
  await rm(join(ROOT, 'types', 'dsh-host-subprocess'), { recursive: true, force: true })
}

if (failed) process.exitCode = 1
