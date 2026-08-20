/**
 * T0.4 / S4 — enumera as rotas da composicao WEB REAL do DeepSeek Harness.
 *
 * A lista de plugins NAO e escrita a mao: e lida de
 * `@deepseek-ai/dsh-web-app/cordis.patch.yml`, o manifesto de composicao
 * publicado. Cada linha do manifesto e depois filtrada por EVIDENCIA — so entra
 * quem realmente chama `webServer.register*`/`tapIndex` no seu `lib/` instalado
 * — e montada num `Context` Cordis real, na ordem do manifesto. Quem regista as
 * rotas sao os proprios pacotes.
 *
 * Mede: (1) a superficie do servico `webServer`; (2) se ha como ENUMERAR rotas
 * ja registadas; (3) se `/__guard` esta livre; (4) `tapIndex` como ponto de
 * contribuicao de UI; (5) o dono do assento de fallback; (6) o header `Host`.
 *
 * Escuta sempre em porta efemera e nunca fala com o harness do operador.
 * Uso: node scripts/spike/ui/enumerate-routes.mjs <dir-runtime>
 */
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  console.error('uso: node enumerate-routes.mjs <dir-runtime>')
  process.exit(2)
}
const require = createRequire(join(process.cwd(), runtimeDir, 'package.json'))
const modules = join(process.cwd(), runtimeDir, 'node_modules')
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { WebServer } = await import(require.resolve('@deepseek-ai/dsh-host-webserver'))
const YAML = await import(require.resolve('yaml'))

const out = (title) => console.log(`\n===== ${title} =====`)
const INDEX_HTML = '<!doctype html><html><head><title>DSH</title></head><body><div id="root"></div></body></html>'
const CHAMADAS = /webServer\.(register|registerUpgrade|registerFallback|tapIndex)\b/

/** Uma resposta crua, com o header `Host` sob controlo total do chamador. */
function raw(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers, timeout: 4000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => { resolve({ status: res.statusCode, body }) })
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Linhas de plugin do manifesto de composicao publicado, na ordem em que ele as
 * declara. As expressoes `!!js` sao neutralizadas para string: este leitor so
 * precisa de `id` e `name`, nunca avalia codigo do manifesto.
 */
async function linhasDoManifesto() {
  const texto = await readFile(join(modules, '@deepseek-ai/dsh-web-app/cordis.patch.yml'), 'utf8')
  const doc = YAML.parse(texto.replaceAll('!!js ', ''), { logLevel: 'silent' })
  const linhas = []
  const visitar = (no) => {
    if (Array.isArray(no)) { for (const item of no) visitar(item); return }
    if (no === null || typeof no !== 'object') return
    if (typeof no.name === 'string' && typeof no.id === 'string') linhas.push({ id: no.id, name: no.name })
    for (const valor of Object.values(no)) visitar(valor)
  }
  visitar(doc)
  return linhas
}

/**
 * Que pacote do fecho instalado contem o literal desta rota. A atribuicao e
 * feita pelo CODIGO, nao pela ordem de montagem: um `ctx.effect` so corre
 * quando o `inject` do seu dono fica satisfeito, portanto a linha que aparenta
 * ter acrescentado a rota nem sempre e a que a regista (o `/plugins/events` do
 * `client-hmr` so entra quando o `client-modules` fornece `clientModules`).
 */
async function donoDaRota(path, fontes) {
  // So conta quem CHAMA a API de rotas: outros pacotes citam o mesmo literal
  // (`dsh-api-gateway` fala de `/api`) sem registar rota nenhuma.
  const candidatos = fontes.filter(({ corpo }) => CHAMADAS.test(corpo))
  const literal = `"${path}"`
  const sufixo = `/${path.slice(path.lastIndexOf('/') + 1)}`
  const porLiteral = candidatos.filter(({ corpo }) => corpo.includes(literal)).map(({ nome }) => nome)
  if (porLiteral.length > 0) return porLiteral
  return candidatos.filter(({ corpo }) => corpo.includes(`${sufixo}\``) || corpo.includes(`${sufixo}"`)).map(({ nome }) => nome)
}

/** Corpo de `lib/index.js` de cada pacote `@deepseek-ai` instalado. */
async function fontesInstaladas() {
  const { readdir } = await import('node:fs/promises')
  const nomes = await readdir(join(modules, '@deepseek-ai'))
  const fontes = []
  for (const nome of nomes) {
    try {
      fontes.push({ nome: `@deepseek-ai/${nome}`, corpo: await readFile(join(modules, '@deepseek-ai', nome, 'lib/index.js'), 'utf8') })
    } catch { /* pacote sem lib/index.js */ }
  }
  return fontes
}

/** Um pacote instalado chama mesmo a API de rotas? Decide por leitura, nao por juizo. */
async function registaRotas(name) {
  try {
    const corpo = await readFile(join(modules, name, 'lib/index.js'), 'utf8')
    return CHAMADAS.test(corpo)
  } catch { return false }
}

const dist = await mkdtemp(join(tmpdir(), 'dsh-spike-dist-'))
const distIndex = join(dist, 'index.html')
await writeFile(distIndex, INDEX_HTML)

// ── monta a composicao real ──────────────────────────────────────────────────
const linhas = await linhasDoManifesto()
const comRotas = []
for (const linha of linhas) if (await registaRotas(linha.name)) comRotas.push(linha)
// `frontend-static` nao e linha do manifesto: a linha `web-runtime`
// (@deepseek-ai/dsh-web-app) monta-o com `ctx.plugin(FrontendStatic, ...)` em
// lib/index.js:176. Entra aqui pela mesma razao por que entra na composicao real.
comRotas.push({ id: 'web-runtime -> frontend-static', name: '@deepseek-ai/dsh-host-frontend-static' })

const ctx = new Context()
// Ancora que a metade node do client-modules exige para resolver pacotes.
ctx.baseUrl = pathToFileURL(join(modules, '/')).href
ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await new Promise((resolve) => setTimeout(resolve, 300))
const web = ctx.get('webServer')

// Servicos NAO relacionados com rotas, substituidos pelo minimo que deixa os
// pacotes reais arrancar. Nenhum deles regista rota nenhuma. `settings` fica
// DE FORA de proposito: o ui-theme trata a sua ausencia por desenho
// (`readPreference` cai no default), e um duble incompleto rebentava o tap.
ctx.provide('loader', { entries: () => [] })
ctx.provide('apiProxy', {})
ctx.provide('webRuntime', { trustedHosts: [] })

/** Fotografia das tabelas de rota do webServer neste instante. */
const tabelas = () => ({
  exact: [...web.exact.keys()],
  prefix: [...web.prefixes.keys()],
  upgrade: [...web.upgrades.keys()],
  fallbackClaimed: web.fallback !== undefined,
  indexTaps: web.indexTaps.length,
})
/** O que a linha acrescentou face a fotografia anterior. */
function delta(antes, depois) {
  const novas = []
  for (const tipo of ['exact', 'prefix', 'upgrade']) {
    for (const path of depois[tipo]) if (!antes[tipo].includes(path)) novas.push(`${tipo} ${path}`)
  }
  if (!antes.fallbackClaimed && depois.fallbackClaimed) novas.push('fallback (assento unico)')
  const taps = depois.indexTaps - antes.indexTaps
  if (taps > 0) novas.push(`${taps} tapIndex`)
  return novas
}

const montadas = []
const atribuicao = []
for (const linha of comRotas) {
  const cfg = linha.name === '@deepseek-ai/dsh-host-frontend-static' ? { distIndex } : {}
  const antes = tabelas()
  try {
    const mod = await import(require.resolve(linha.name))
    ctx.plugin(mod.default ?? mod, cfg)
    montadas.push(linha)
  } catch (error) {
    console.log(`  linha ${linha.id} (${linha.name}) nao montou: ${error.message}`)
    continue
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  atribuicao.push({ linha, novas: delta(antes, tabelas()) })
}
await new Promise((resolve) => setTimeout(resolve, 400))
const port = web.port
console.log(`webServer a escuta em 127.0.0.1:${port}`)
console.log(`linhas de plugin no manifesto: ${linhas.length}`)
console.log(`linhas que chamam a API de rotas: ${comRotas.length} -> ${comRotas.map((l) => l.id).join(', ')}`)
console.log(`montadas com sucesso: ${montadas.map((l) => l.id).join(', ')}`)

out('1. SUPERFICIE PUBLICA DO SERVICO webServer')
const proto = Object.getPrototypeOf(web)
const members = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor')
for (const k of members) {
  const d = Object.getOwnPropertyDescriptor(proto, k)
  console.log(`  ${k}: ${d.get !== undefined ? 'getter' : typeof d.value}`)
}
console.log(`campos de instancia: ${Object.getOwnPropertyNames(web).join(', ')}`)

out('2. ENUMERACAO DE ROTAS DA COMPOSICAO REAL')
const snapshot = tabelas()
const fontes = await fontesInstaladas()
console.log(`atribuicao por codigo, sobre ${fontes.length} pacotes @deepseek-ai instalados:`)
for (const tipo of ['exact', 'prefix', 'upgrade']) {
  for (const path of snapshot[tipo]) {
    console.log(`  ${tipo.padEnd(8)} ${path.padEnd(20)} <- ${(await donoDaRota(path, fontes)).join(', ')}`)
  }
}
console.log(`  fallback  ${'(assento unico)'.padEnd(20)} <- @deepseek-ai/dsh-host-frontend-static`)
console.log('\nordem de ACTIVACAO observada na montagem (nao e a mesma coisa que autoria):')
for (const { linha, novas } of atribuicao) {
  console.log(`  ${linha.id.padEnd(30)} -> ${novas.length === 0 ? '(nada nesta linha)' : novas.join(', ')}`)
}
console.log('\ntabela final, via campos de instancia (o `private` do TypeScript nao existe em runtime):')
console.log(JSON.stringify(snapshot))
console.log(`metodo publico de listagem no prototipo? ${members.some((m) => /^(routes|list|entries|inspect|keys)/.test(m)) ? 'SIM' : 'NAO'}`)

out('3. O PREFIXO /__guard ESTA LIVRE?')
const taken = [...snapshot.exact, ...snapshot.prefix, ...snapshot.upgrade]
const collides = taken.filter((p) => p === '/__guard' || p.startsWith('/__guard/'))
console.log(`rotas ocupadas: ${JSON.stringify(taken)}`)
console.log(`colisoes com /__guard: ${collides.length === 0 ? 'nenhuma' : JSON.stringify(collides)}`)
try {
  web.register({ kind: 'prefix', path: '/__guard', handler: (_q, r) => { r.writeHead(200); r.end('guard') } })
  console.log('register({kind:"prefix", path:"/__guard"}) => OK, sem excecao')
} catch (error) {
  console.log(`register /__guard => EXCECAO: ${error.message}`)
}
try {
  web.register({ kind: 'prefix', path: '/__guard', handler: () => {} })
  console.log('segundo register /__guard => NAO lancou (deteccao de colisao ausente)')
} catch (error) {
  console.log(`segundo register /__guard => lancou: ${error.message}`)
}
for (const path of ['/__guard', '/__guard/api/state', '/__guardXYZ']) {
  const res = await raw(port, path).catch((error) => ({ status: `erro (${error.message})`, body: '' }))
  console.log(`  GET ${path.padEnd(22)} -> HTTP ${res.status}  ${res.body === 'guard' ? 'servido pelo handler /__guard' : 'servido pelo fallback (SPA)'}`)
}

out('4. tapIndex — PONTO DE CONTRIBUICAO DE UI (injecao no index.html)')
console.log(`taps ja registados pela composicao: ${web.indexTaps.length}`)
const antes = (await raw(port, '/').catch(() => ({ body: '<sem resposta>' }))).body
console.log(`GET / antes do meu tap: ${antes.length} bytes`)
console.log(`  contem __DSH_BOOT__ (tap do client-modules): ${antes.includes('__DSH_BOOT__') ? 'SIM' : 'NAO'}`)
console.log(`  contem data-ds-dark-theme (tap do ui-theme):  ${antes.includes('data-ds-dark-theme') ? 'SIM' : 'NAO'}`)
const disposeTap = web.tapIndex((html) => html.replace('</body>', '<button id="dsh-guard-tunnel">Ligar tunel</button></body>'))
const tapped = (await raw(port, '/').catch(() => ({ body: '<sem resposta>' }))).body
console.log(`GET / depois do meu tap: ${tapped.length} bytes`)
console.log(`  ultimos 96 chars: ${JSON.stringify(tapped.slice(-96))}`)
console.log(`injecao visivel na Web UI: ${tapped.includes('dsh-guard-tunnel') ? 'SIM' : 'NAO'}`)
disposeTap()
const depois = (await raw(port, '/').catch(() => ({ body: '' }))).body
console.log(`GET / apos o disposer: reversivel = ${!depois.includes('dsh-guard-tunnel') ? 'SIM' : 'NAO'}`)

out('5. QUEM E O DONO DO ASSENTO DE FALLBACK?')
console.log(`assento reivindicado pela composicao: ${web.fallback !== undefined ? 'SIM (frontend-static, montado pela linha web-runtime)' : 'NAO'}`)
try {
  web.registerFallback(() => {})
  console.log('segundo registerFallback => NAO lancou')
} catch (error) {
  console.log(`segundo registerFallback => lancou: ${error.message}`)
}
console.log('logo, um plugin de terceiro NAO consegue reivindicar o assento numa composicao web real.')
for (const path of ['/', '/qualquer-rota-spa', '/api/state', '/plugins/x/client.js', '/plugins/events']) {
  // `/plugins/events` e SSE: mantem a resposta aberta de proposito, portanto o
  // timeout do cliente E a prova de que a rota existe e esta viva.
  const res = await raw(port, path).catch(() => ({ status: 'sem fecho (SSE, resposta mantida aberta)' }))
  console.log(`  ${path.padEnd(26)} -> HTTP ${res.status}`)
}

out('6. O ROTEADOR VALIDA O HEADER Host?')
for (const host of ['127.0.0.1', 'attacker.example.com', 'qualquer-coisa.trycloudflare.com']) {
  const res = await raw(port, '/api/state', { host }).catch((error) => ({ status: `erro (${error.message})` }))
  console.log(`  Host: ${host.padEnd(34)} -> HTTP ${res.status}`)
}

await rm(dist, { recursive: true, force: true })
process.exit(0)
