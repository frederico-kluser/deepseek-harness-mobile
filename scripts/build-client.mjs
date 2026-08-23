#!/usr/bin/env node
/**
 * build-client.mjs — compila `client/index.ts` para `lib/client.js` no formato
 * closure-factory do harness DSH:
 *
 *   window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     ... código do plugin ...
 *     exports.apply = apply; exports.inject = inject;
 *     return module.exports;
 *   } });
 *
 * O `require` injetado no factory resolve as PALAVRAS SEED do module table do
 * harness (react, react/jsx-runtime, @deepseek-ai/cordis,
 * @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives). Por
 * isso `react` (e cordis, se usado) ficam EXTERNOS no bundle — NUNCA inline —
 * para o browser ver a MESMA instância do shell.
 *
 * Sem dependência do toolchain do monorepo do harness: esbuild é o único devDep
 * novo. O build lê o `name` do package.json como `id` do registro (entry name
 * == package name, contrato de `@deepseek-ai/dsh-client-modules`).
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const id = pkg.name

// Palavras seed do harness (packages/client/web/src/seed.ts + platform.ts).
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const result = await build({
  entryPoints: [resolve(root, 'client/index.ts')],
  outfile: resolve(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  external: EXTERNAL,
  minify: false,
  sourcemap: true,
  banner: {
    js: [
      `window.__ModuleLoader__.load({`,
      `\tid: ${JSON.stringify(id)},`,
      `\tfactory: (require) => {\n` +
      `\t\tvar module = { exports: {} };\n` +
      `\t\tvar exports = module.exports;`,
    ].join('\n'),
  },
  footer: {
    js: [
      `\treturn module.exports;`,
      `\t}`,
      `});`,
    ].join('\n'),
  },
  write: false,
})

mkdirSync(resolve(root, 'lib'), { recursive: true })
const jsPath = resolve(root, 'lib/client.js')
const outJs = result.outputFiles.find((f) => f.path === jsPath)
let code = outJs ? outJs.text : result.outputFiles[0]?.text
if (code === undefined) throw new Error('esbuild produced no JS output')
writeFileSync(jsPath, code)
// O mapa sai como ficheiro irmão (esbuild nomeia-o pela `outfile` + `.map`).
const outMap = result.outputFiles.find((f) => f.path === `${jsPath}.map`)
if (outMap) writeFileSync(`${jsPath}.map`, outMap.text)

// Sanidade: o bundle deve registrar o factory com o id do pacote.
if (!code.includes(`id: ${JSON.stringify(id)}`)) {
  throw new Error(`bundle não declara o id ${JSON.stringify(id)}`)
}

console.log(`[build-client] ${jsPath} (${code.length} bytes)`)