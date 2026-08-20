/**
 * CONTRACT-001..009 -- testes de contrato da API real do DeepSeek Harness.
 *
 * O QUE ESTES TESTES FAZEM
 *   Comparam os `.d.ts` PUBLICADOS pelos pacotes `@deepseek-ai/*` na versao
 *   PINADA (lidos de `node_modules/`, resolvidos pelo `pnpm-lock.yaml`) com o
 *   espelho local em `types/**`, e afirmam os simbolos exatos de que o plugin
 *   depende. Falham no dia em que a montante divergir do espelho.
 *
 * FAIXA SUPORTADA -- LEIA ANTES DE MEXER NUM PINO
 *   `06-REPO-E-CI.md` fixa `@deepseek-ai/dsh 0.1.0-rc.7 .. rc.9`. A tag
 *   `latest` dos subpacotes `dsh-*` aponta para a publicacao mais ANTIGA
 *   (`0.0.1-rc.1`, 2026-08-10), uma linha morta que ninguem executa; a linha
 *   viva e `0.1.0-rc.*` (`next`). CONTRACT-003 tranca o pino dentro da faixa
 *   precisamente para que este erro nao se repita.
 *
 * ASSERCOES NEGATIVAS -- COMO ESCREVE-LAS SEM CRIAR UM TRINCO
 *   Uma negativa sobre um NOME de simbolo que muda entre linhas transforma o
 *   teste num trinco contra o conserto. Por isso as negativas aqui sao apenas
 *   sobre simbolos com ZERO ocorrencias em TODAS as versoes publicadas
 *   (`WebUpgradeHandler`, `WebHandler`, `RouteKind`, `Disposer`) e sobre
 *   pacotes que dao 404 em todas elas. A guarda contra a linha morta e feita
 *   sobre a VERSAO PINADA, nunca sobre o nome do servico.
 *
 * REDE
 *   So CONTRACT-004 e CONTRACT-008 consultam o registry. Se a rede cair, esses
 *   dois casos ficam SKIP com a razao escrita por extenso -- nunca passam em
 *   falso silencio. Os restantes sete sao offline e deterministicos.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const REGISTRY = 'https://registry.npmjs.org'
const NET_TIMEOUT_MS = 15_000

/** Versoes de `dsh-*` aceites por `06-REPO-E-CI.md` ("Versoes suportadas"). */
const SUPPORTED_DSH = /^0\.1\.0-rc\.(7|8|9)$/

/** Pinos EXATOS (D18). O `sha256` e o do tarball de onde o espelho foi extraido. */
const PINS = {
  cordis: { pkg: '@deepseek-ai/cordis', version: '4.0.1', dir: 'cordis', sha256: '31e96b8e13d5c55bfd4316c08ac8925510e0eed86d48a3a9cc86046623074613', dsh: false },
  webserver: { pkg: '@deepseek-ai/dsh-host-webserver', version: '0.1.0-rc.7', dir: 'dsh-host-webserver', sha256: 'b5fee946c818859bd19d808b8aea492420a1e57e2a074f2f3a6d16ce943ca545', dsh: true },
  subprocess: { pkg: '@deepseek-ai/dsh-subprocess', version: '0.1.0-rc.7', dir: 'dsh-subprocess', sha256: '71d951f6d7f34076c9c8f30f931635e87fb2bed4b7959d46f5522016f0661b72', dsh: true },
  frontendStatic: { pkg: '@deepseek-ai/dsh-host-frontend-static', version: '0.1.0-rc.7', dir: 'dsh-host-frontend-static', sha256: 'c0c7364e47f9ad99395a38b0fe801e81cd009ffcada527571fd7e8a51b96ccb5', dsh: true },
  homePaths: { pkg: '@deepseek-ai/dsh-home-paths', version: '0.1.0-rc.7', dir: 'dsh-home-paths', sha256: 'a496c60906b636f1236b2a9de00217e7f5c85a1547066e733e7bba1795c41484', dsh: true },
  /**
   * Espelhado mas NAO instalado: depende de `node-pty` e `koffi` (nativos, com
   * `postinstall`) e o plugin nao o importa. Sem `node_modules` nao ha como
   * comparar byte-a-byte aqui -- a cobertura deste pacote e o cabecalho de
   * proveniencia (versao + sha256 do tarball) mais `pnpm types:fetch --check`,
   * que rebaixa o tarball e compara. Ver CONTRACT-003 e o relatorio.
   */
  subprocessLocal: { pkg: '@deepseek-ai/dsh-subprocess-local', version: '0.1.0-rc.7', dir: 'dsh-subprocess-local', sha256: 'ce00c135e16ef8237f2027a677b71b0c21b5081a07eb6b671c95e78f9742c67f', dsh: true, tarballOnly: true },
} as const

/** Ficheiros espelhados de cada pacote, por directorio de `types/`. */
const MIRRORED_FILES: Readonly<Record<string, readonly string[] | undefined>> = {
  cordis: ['index.d.ts', 'context.d.ts', 'events.d.ts', 'fiber.d.ts', 'logger.d.ts', 'reflect.d.ts', 'registry.d.ts', 'service.d.ts', 'utils.d.ts'],
  'dsh-host-webserver': ['index.d.ts', 'invariant.d.ts'],
  'dsh-subprocess': ['index.d.ts', 'types.d.ts', 'invariant.d.ts'],
  'dsh-subprocess-local': ['index.d.ts', 'spawn.d.ts', 'process-inspector.d.ts'],
  'dsh-host-frontend-static': ['index.d.ts', 'invariant.d.ts'],
  'dsh-home-paths': ['index.d.ts', 'invariant.d.ts'],
}

type Pin = (typeof PINS)[keyof typeof PINS] & { readonly tarballOnly?: boolean }

const readText = (path: string): string => readFileSync(path, 'utf8')

/** Bytes que o pacote INSTALADO publica para `lib/types/<file>`. */
const published = (pin: Pin, file: string): string =>
  readText(join(ROOT, 'node_modules', pin.pkg, 'lib', 'types', file))

/** Bytes do espelho local, sem o cabecalho de proveniencia de `pnpm types:fetch`. */
const mirrored = (pin: Pin, file: string): string => {
  const raw = readText(join(ROOT, 'types', pin.dir, file))
  const marker = ' */\n'
  const at = raw.indexOf(marker)
  assert.notEqual(at, -1, `espelho types/${pin.dir}/${file} sem cabecalho de proveniencia`)
  const header = raw.slice(0, at)
  assert.match(header, new RegExp(`FONTE: ${pin.pkg.replace('/', '\\/')}@${pin.version.replace(/\./g, '\\.')}`), `types/${pin.dir}/${file}: o cabecalho FONTE nao aponta para o pino`)
  assert.match(header, new RegExp(`SHA256 : ${pin.sha256}`), `types/${pin.dir}/${file}: sha256 do cabecalho difere do pino`)
  return raw.slice(at + marker.length)
}

/** A versao instalada tem de ser EXATAMENTE a pinada, e o manifesto nao pode ter `^`/`~`. */
const assertPinned = (pin: Pin): void => {
  const manifest = JSON.parse(readText(join(ROOT, 'package.json'))) as { devDependencies: Record<string, string> }
  assert.equal(manifest.devDependencies[pin.pkg], pin.version, `${pin.pkg}: devDependencies tem de fixar ${pin.version} exato (D18)`)
  const installed = JSON.parse(readText(join(ROOT, 'node_modules', pin.pkg, 'package.json'))) as { version: string }
  assert.equal(installed.version, pin.version, `${pin.pkg}: instalado ${installed.version}, pino ${pin.version}`)
}

/** Espelho identico ao publicado -- a asseracao que "falha no dia em que o .d.ts real divergir". */
const assertMirrorMatches = (pin: Pin, files: readonly string[]): void => {
  assertPinned(pin)
  for (const file of files) {
    assert.equal(mirrored(pin, file), published(pin, file), `types/${pin.dir}/${file} divergiu de ${pin.pkg}@${pin.version}:lib/types/${file} -- corra \`pnpm types:fetch\``)
  }
}

/**
 * Normaliza a continuacao de comentarios de bloco (`\n     * `) para um espaco.
 * Asserir prosa de JSDoc com a quebra de linha literal transforma uma
 * reformatacao a montante -- sem qualquer mudanca de API -- em vermelho. Onde a
 * garantia SO existe em prosa, comparamos a prosa normalizada.
 */
const prose = (text: string): string => text.replace(/\n\s*\*\s*/g, ' ')

/**
 * Consulta o registry. Devolve o status HTTP, ou `null` quando NAO houve
 * resposta HTTP nenhuma (rede em baixo, DNS, timeout). `null` nunca pode ser
 * lido como "o pacote nao existe": ausencia de rede nao e ausencia de pacote.
 */
const registryStatus = async (name: string): Promise<number | null> => {
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, { method: 'GET', signal: AbortSignal.timeout(NET_TIMEOUT_MS) })
    return res.status
  } catch {
    return null
  }
}

/** `dist-tags` do harness, ou `null` sem resposta HTTP. */
const distTags = async (name: string): Promise<Record<string, string> | null> => {
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, { method: 'GET', signal: AbortSignal.timeout(NET_TIMEOUT_MS) })
    if (!res.ok) return null
    return ((await res.json()) as { 'dist-tags'?: Record<string, string> })['dist-tags'] ?? null
  } catch {
    return null
  }
}

const NET_DOWN = 'SEM RESPOSTA HTTP DO REGISTRY (rede/DNS/timeout). Este caso NAO foi verificado: ausencia de rede nao prova ausencia de pacote.'

/* ------------------------------------------------------------------------- */
/* CONTRACT-001                                                              */
/* ------------------------------------------------------------------------- */

test('CONTRACT-001: dsh-host-webserver declara `interface Context { webServer: WebServer }`', () => {
  const pin = PINS.webserver
  assertMirrorMatches(pin, ['index.d.ts', 'invariant.d.ts'])
  // `dsh-home-paths` nao tem caso proprio entre 001..009; o seu espelho e
  // validado aqui. A cobertura de TODOS os directorios de `types/` -- incluindo
  // o que nao esta instalado -- e verificada em CONTRACT-003.
  assertMirrorMatches(PINS.homePaths, MIRRORED_FILES['dsh-home-paths'] ?? [])

  const dts = published(pin, 'index.d.ts')
  assert.match(dts, /declare module '@deepseek-ai\/cordis' \{\s*interface Context \{\s*webServer: WebServer;\s*\}\s*\}/, 'a augmentation `Context { webServer: WebServer }` desapareceu: o `inject` do plugin deixa de resolver e o portao some em silencio')
  assert.match(dts, /export declare class WebServer extends Service \{/, '`WebServer` deixou de ser a classe exportada do servico')
  assert.match(dts, /export default WebServer;/, '`WebServer` deixou de ser a exportacao por defeito do pacote')
})

/* ------------------------------------------------------------------------- */
/* CONTRACT-002                                                              */
/* ------------------------------------------------------------------------- */

test('CONTRACT-002: WebServer expoe register, registerFallback e registerUpgrade', () => {
  const dts = published(PINS.webserver, 'index.d.ts')

  assert.match(dts, /\n {4}register\(route: WebRoute\): \(\) => void;/, '`register(route: WebRoute): () => void` mudou de forma')
  assert.match(dts, /\n {4}registerFallback\(handler: WebRoute\['handler'\]\): \(\) => void;/, '`registerFallback(handler): () => void` mudou de forma')
  // BLOQUEADOR DE SEGURANCA: sem `registerUpgrade` nao ha como guardar o
  // handshake de WebSocket, que nao esta sujeito a same-origin policy.
  assert.match(dts, /\n {4}registerUpgrade\(route: WebUpgradeRoute\): \(\) => void;/, 'BLOQUEADOR DE SEGURANCA: `registerUpgrade` desapareceu -- sem ele nao ha como guardar o WebSocket')
  assert.match(dts, /\n {4}tapIndex\(transform: \(html: string\) => string\): \(\) => void;/, '`tapIndex` mudou de forma')
  assert.match(dts, /\n {4}applyIndexTaps\(html: string\): string;/, '`applyIndexTaps` mudou de forma')

  // Dono unico do assento de fallback: e por isto que a barreira NAO pode
  // simplesmente reclamar o fallback numa composicao que ja o tem ocupado.
  assert.match(prose(dts), /One owner only — a second registration throws/, 'a garantia de dono unico do assento de fallback desapareceu do contrato')
})

/* ------------------------------------------------------------------------- */
/* CONTRACT-003                                                              */
/* ------------------------------------------------------------------------- */

test('CONTRACT-003: a faixa suportada esta trancada no que ESTA INSTALADO e no lockfile inteiro', () => {
  // (a) GUARDA DA FAIXA sobre a versao EFETIVAMENTE INSTALADA, nao sobre o
  // literal deste ficheiro. `latest` dos subpacotes aponta para a publicacao
  // MAIS ANTIGA (`0.0.1-rc.1`); pinar por `latest` mede uma API que ninguem
  // executa, e foi assim que a primeira passagem desta spike se enganou.
  for (const pin of Object.values(PINS) as Pin[]) {
    if (!pin.dsh) continue
    assert.match(pin.version, SUPPORTED_DSH, `${pin.pkg}@${pin.version}: o PINO deste ficheiro esta fora da faixa 0.1.0-rc.7..rc.9 (06-REPO-E-CI.md)`)
    if (pin.tarballOnly === true) continue
    const installed = (JSON.parse(readText(join(ROOT, 'node_modules', pin.pkg, 'package.json'))) as { version: string }).version
    assert.match(installed, SUPPORTED_DSH, `${pin.pkg}: INSTALADO ${installed}, fora da faixa 0.1.0-rc.7..rc.9. NAO pine por \`latest\`: nesta escala essa tag aponta para a publicacao mais antiga.`)
    assert.equal(installed, pin.version, `${pin.pkg}: instalado ${installed}, pino ${pin.version}`)
  }

  // (b) VARREDURA DO LOCKFILE INTEIRO. Os pinos diretos podem estar certos e o
  // grafo arrastar a linha morta por um PEER resolvido: todos os `dsh-*@0.1.0-rc.8`
  // declaram `peerDependencies: { '@deepseek-ai/dsh-invariants': '^0.1.0-rc.8' }`,
  // e uma resolucao com politica de idade minima a rebaixar para `0.0.1-rc.5`
  // produz um lockfile que NAO satisfaz o proprio peer -- e que a CI instala.
  // Nenhum dos outros oito casos ve isto, porque so olham para os pinos diretos.
  const lock = readText(join(ROOT, 'pnpm-lock.yaml'))
  const dead = [...lock.matchAll(/@deepseek-ai\/[a-z0-9-]+@0\.0\.1-rc\.[0-9]+/g)].map((m) => m[0])
  assert.deepEqual([...new Set(dead)], [], `o pnpm-lock.yaml arrasta a linha morta 0.0.1-rc.* no grafo resolvido (tipicamente por um peer de \`dsh-invariants\`). Apague o lockfile, corra \`pnpm install\` e volte a verificar.`)

  // (c) COBERTURA: todo o directorio sob `types/` tem de ter um pino.
  const dirs = readdirSync(join(ROOT, 'types'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  const covered = new Set<string>((Object.values(PINS) as Pin[]).map((pin) => pin.dir))
  for (const dir of dirs) {
    assert.ok(covered.has(dir), `types/${dir}/ nao tem entrada em PINS: ficaria espelhado sem qualquer guarda`)
    assert.ok(MIRRORED_FILES[dir] !== undefined, `types/${dir}/ nao tem entrada em MIRRORED_FILES`)
  }

  // (d) O pacote nao instalado (`dsh-subprocess-local`) nao pode ser comparado
  // byte-a-byte aqui. Verificamos o que da para verificar offline: cada
  // ficheiro tem cabecalho de proveniencia coerente com o pino (`mirrored()`
  // assere FONTE e SHA256). A igualdade byte-a-byte com o tarball e feita por
  // `pnpm types:fetch --check`, que NAO corre dentro de `pnpm test`.
  for (const file of MIRRORED_FILES['dsh-subprocess-local'] ?? []) {
    const body = mirrored(PINS.subprocessLocal, file)
    assert.ok(body.length > 0, `types/dsh-subprocess-local/${file} ficou vazio`)
  }
  assert.match(mirrored(PINS.subprocessLocal, 'index.d.ts'), /import \{ SubprocessRuntime \} from '@deepseek-ai\/dsh-subprocess';/, 'o espelho de dsh-subprocess-local deixou de usar `SubprocessRuntime`: sinal de pino incoerente entre os dois pacotes do assento')

  // (e) ASSERCOES NEGATIVAS SEGURAS: estes identificadores tem ZERO ocorrencias
  // em TODAS as versoes publicadas dos respectivos pacotes. Nao sao nomes que
  // mudaram de linha -- nunca existiram. Uma negativa sobre um nome que MUDA
  // entre linhas seria um trinco contra o conserto, e por isso nao existe aqui.
  for (const file of MIRRORED_FILES['dsh-host-webserver'] ?? []) {
    const dts = published(PINS.webserver, file)
    assert.doesNotMatch(dts, /\bWebUpgradeHandler\b/, `\`WebUpgradeHandler\` apareceu em ${PINS.webserver.pkg}:lib/types/${file}. Ate agora o handler de upgrade nunca teve tipo nomeado: e \`WebUpgradeRoute['handler']\`.`)
    assert.doesNotMatch(dts, /\bWebHandler\b/, `\`WebHandler\` apareceu em ${PINS.webserver.pkg}:lib/types/${file}. O handler de rota nunca teve tipo nomeado: e \`WebRoute['handler']\`.`)
    assert.doesNotMatch(dts, /export type RouteKind\b/, `\`RouteKind\` apareceu em ${PINS.webserver.pkg}:lib/types/${file}. O nome publicado sempre foi \`WebRouteKind\`.`)
  }
  for (const file of ['index.d.ts', 'context.d.ts', 'events.d.ts', 'fiber.d.ts', 'utils.d.ts']) {
    assert.doesNotMatch(published(PINS.cordis, file), /\bDisposer\b/, `\`Disposer\` apareceu em ${PINS.cordis.pkg}:lib/types/${file}. O tipo publicado do disposer e \`Disposable<T> = () => T\`.`)
  }
})

/* ------------------------------------------------------------------------- */
/* CONTRACT-004  (asseracao NEGATIVA -- erro E1; depende de rede)            */
/* ------------------------------------------------------------------------- */

test('CONTRACT-004: @deepseek-ai/dsh-host-subprocess NAO existe no registry (404)', async (t) => {
  // Parte offline: o nome refutado nao pode voltar a existir no projecto.
  assert.equal(existsSync(join(ROOT, 'types', 'dsh-host-subprocess')), false, 'E1 regrediu: o directorio types/dsh-host-subprocess/ voltou a existir')
  assert.doesNotMatch(tsconfigPaths(), /dsh-host-subprocess/, 'E1 regrediu: um alias para `@deepseek-ai/dsh-host-subprocess` reapareceu em compilerOptions.paths')

  const status = await registryStatus('@deepseek-ai/dsh-host-subprocess')
  if (status === null) {
    t.skip(`CONTRACT-004 (parte de rede): ${NET_DOWN}`)
    return
  }
  assert.equal(status, 404, `E1 regrediu: o registry respondeu ${status} para @deepseek-ai/dsh-host-subprocess. O pacote real e @deepseek-ai/dsh-subprocess (+ -local).`)
})

/**
 * Apenas o bloco `compilerOptions.paths` do `tsconfig.json`. O ficheiro e JSONC
 * e os seus comentarios NOMEIAM simbolos refutados de proposito (para explicar
 * porque nao estao la); as asseracoes negativas leem so o mapeamento efectivo,
 * que e o que o compilador consome.
 */
function tsconfigPaths(): string {
  const raw = readText(join(ROOT, 'tsconfig.json'))
  const block = /"paths":\s*\{([\s\S]*?)\n {4}\}/.exec(raw)
  assert.notEqual(block, null, 'tsconfig.json sem bloco `compilerOptions.paths`')
  return block?.[1] ?? ''
}

/* ------------------------------------------------------------------------- */
/* CONTRACT-005                                                              */
/* ------------------------------------------------------------------------- */

test('CONTRACT-005: dsh-subprocess existe e declara `interface Context { subprocess: SubprocessRuntime }`', () => {
  const pin = PINS.subprocess
  assertMirrorMatches(pin, ['index.d.ts', 'types.d.ts', 'invariant.d.ts'])
  const dts = published(pin, 'index.d.ts')

  assert.match(dts, /declare module '@deepseek-ai\/cordis' \{\s*interface Context \{\s*subprocess: SubprocessRuntime;\s*\}\s*\}/, 'a augmentation `Context { subprocess: SubprocessRuntime }` desapareceu')
  assert.match(dts, /export declare abstract class SubprocessRuntime extends Service \{/, '`SubprocessRuntime` deixou de ser a classe abstracta exportada do assento')
  assert.match(dts, /export default SubprocessRuntime;/, '`SubprocessRuntime` deixou de ser a exportacao por defeito')
})

/* ------------------------------------------------------------------------- */
/* CONTRACT-006  (refuta o erro E3)                                          */
/* ------------------------------------------------------------------------- */

test('CONTRACT-006: spawn(spec: SubprocessSpawnSpec): SubprocessHandle, com argv/cwd/stdio/graceMs obrigatorios', () => {
  const index = published(PINS.subprocess, 'index.d.ts')
  const types = published(PINS.subprocess, 'types.d.ts')

  assert.match(index, /\n {4}abstract spawn\(spec: SubprocessSpawnSpec\): SubprocessHandle;/, 'E3: `spawn` mudou de forma. A forma `spawn(cmd, args, opts)` continua refutada em todas as versoes publicadas.')
  assert.doesNotMatch(index, /spawn\((?:command|cmd)[^)]*,[^)]*,[^)]*\)/, 'E3 regrediu: reapareceu um `spawn(command, args, options)` de tres parametros')

  const spec = /export interface SubprocessSpawnSpec \{([\s\S]*?)\n\}/.exec(types)
  assert.notEqual(spec, null, '`SubprocessSpawnSpec` desapareceu de dsh-subprocess/types.d.ts')
  const body = spec?.[1] ?? ''

  for (const field of ['argv: readonly string[];', 'cwd: string;', 'stdio: SubprocessStdio;', 'graceMs: number;']) {
    assert.ok(body.includes(`\n    ${field}`), `\`SubprocessSpawnSpec.${field.split(':')[0]}\` deixou de ser um campo OBRIGATORIO com a forma \`${field}\``)
  }
  assert.ok(body.includes('\n    signal?: AbortSignal | undefined;'), '`signal` deixou de ser opcional em `SubprocessSpawnSpec`')
  assert.ok(body.includes('\n    env?: NodeJS.ProcessEnv | undefined;'), '`env` deixou de ser opcional em `SubprocessSpawnSpec`')

  // O handle NAO e um ChildProcess: nao ha EventEmitter nem `kill`.
  assert.match(types, /export interface SubprocessHandle \{/, '`SubprocessHandle` desapareceu')
  assert.match(types, /\n {4}terminate\(\): void;/, '`SubprocessHandle.terminate(): void` -- o unico verbo de terminacao -- mudou de forma')
  const handle = /export interface SubprocessHandle \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? ''
  assert.doesNotMatch(handle, /\n {4}(?:on|once|removeListener|kill|killed)\b/, '`SubprocessHandle` ganhou superficie de ChildProcess: a orquestracao do worker nao pode voltar a assumir um EventEmitter')
  assert.match(handle, /\n {4}readonly done: Promise<SubprocessOutcome>;/, '`SubprocessHandle.done` -- o substituto do evento `exit` -- mudou de forma')
})

/* ------------------------------------------------------------------------- */
/* CONTRACT-007                                                              */
/* ------------------------------------------------------------------------- */

test('CONTRACT-007: WebRoute existe e mantem a forma usada pelo portao', () => {
  const dts = published(PINS.webserver, 'index.d.ts')

  assert.match(dts, /export type WebRouteKind = 'exact' \| 'prefix';/, '`WebRouteKind` mudou de forma')
  assert.match(dts, /export interface WebRoute \{[\s\S]*?\n {4}kind: WebRouteKind;[\s\S]*?\n {4}path: string;[\s\S]*?\n {4}handler: \(req: IncomingMessage, res: ServerResponse\) => void \| Promise<void>;\n\}/, '`WebRoute` mudou de forma: e o tipo do conjunto original que sobreviveu intacto a todas as 9 versoes')
  assert.match(dts, /export interface WebUpgradeRoute \{[\s\S]*?\n {4}path: string;[\s\S]*?\n {4}handler: \(req: IncomingMessage, socket: Duplex, head: Buffer\) => void \| Promise<void>;\n\}/, '`WebUpgradeRoute` mudou de forma')
  assert.match(dts, /\n {4}get host\(\): Config\['host'\];/, "`WebServer.host` deixou de ser a uniao literal de `Config['host']`")
  assert.match(dts, /\n {4}host: '127\.0\.0\.1' \| '0\.0\.0\.0';/, "o bind deixou de ser a uniao literal `'127.0.0.1' | '0.0.0.0'`: a verificacao de bind inseguro deixa de ser exaustiva no compilador")
})

/* ------------------------------------------------------------------------- */
/* CONTRACT-008  (erro E4; depende de rede)                                  */
/* ------------------------------------------------------------------------- */

test('CONTRACT-008: dsh-host-frontend-static existe; dsh-host-frontend nao', async (t) => {
  assertMirrorMatches(PINS.frontendStatic, ['index.d.ts', 'invariant.d.ts'])
  assert.match(published(PINS.frontendStatic, 'index.d.ts'), /export declare const name = "frontend-static";/, 'o nome do plugin `frontend-static` mudou')

  const [existing, refuted, tags] = await Promise.all([
    registryStatus('@deepseek-ai/dsh-host-frontend-static'),
    registryStatus('@deepseek-ai/dsh-host-frontend'),
    distTags('@deepseek-ai/dsh'),
  ])
  if (existing === null || refuted === null || tags === null) {
    t.skip(`CONTRACT-008 (parte de rede): ${NET_DOWN}`)
    return
  }
  assert.equal(existing, 200, `@deepseek-ai/dsh-host-frontend-static devia responder 200, respondeu ${existing}`)
  assert.equal(refuted, 404, `E4 regrediu: o registry respondeu ${refuted} para @deepseek-ai/dsh-host-frontend. O pacote real e @deepseek-ai/dsh-host-frontend-static.`)

  // O harness que a faixa suportada persegue. Se `latest` do `dsh` sair da
  // linha `0.1.0-rc.*`, a faixa de `06-REPO-E-CI.md` tem de ser revista ANTES
  // de qualquer re-pino -- e este caso avisa em vez de deixar passar.
  assert.match(tags['latest'] ?? '', /^0\.1\.0-rc\./, `@deepseek-ai/dsh latest = ${tags['latest']}: saiu da linha 0.1.0-rc.*. Reveja a faixa suportada em 06-REPO-E-CI.md antes de mexer nos pinos.`)
})

/* ------------------------------------------------------------------------- */
/* CONTRACT-009                                                              */
/* ------------------------------------------------------------------------- */

test('CONTRACT-009: cordis pinado exporta intercept, waterfall, parallel, effect, Service e o ciclo de vida da Fiber', () => {
  const pin = PINS.cordis
  const files = ['index.d.ts', 'context.d.ts', 'events.d.ts', 'fiber.d.ts', 'logger.d.ts', 'reflect.d.ts', 'registry.d.ts', 'service.d.ts', 'utils.d.ts'] as const
  assertMirrorMatches(pin, files)

  const manifest = JSON.parse(readText(join(ROOT, 'package.json'))) as { peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional: boolean }> }
  assert.equal(manifest.peerDependencies[pin.pkg], '>=4.0.0 <5', 'a faixa de peerDependency do cordis mudou (D18)')
  assert.equal(manifest.peerDependenciesMeta[pin.pkg]?.optional, true, 'o peer do cordis tem de ser opcional (D18)')

  const context = published(pin, 'context.d.ts')
  const events = published(pin, 'events.d.ts')
  const fiber = published(pin, 'fiber.d.ts')
  const service = published(pin, 'service.d.ts')

  // `intercept` -- CONFIGURACAO por servico, nao envolvimento de metodos.
  assert.match(context, /\n {4}intercept<K extends InjectKey>\(name: K, config: /, '`Context.intercept` perdeu a sobrecarga tipada por `InjectKey`')
  assert.match(context, /\n {4}intercept\(name: string, config: any\): this;/, '`Context.intercept(name, config)` mudou de forma')
  assert.doesNotMatch(context, /intercept<[^>]*>\(name: [^,]+, methods:/, '`ctx.intercept` NAO envolve metodos: se ganhar um parametro `methods`, a arquitectura de interceptacao tem de ser reavaliada')

  assert.match(events, /\n {8}waterfall<K extends keyof Events>\(name: K, \.\.\.args: Parameters<Events\[K\]>\): ReturnType<Events\[K\]>;/, '`ctx.waterfall` mudou de forma')
  assert.match(events, /\n {8}parallel<K extends keyof Events>\(name: K, \.\.\.args: Parameters<Events\[K\]>\): Promise<void>;/, '`ctx.parallel` mudou de forma')
  assert.match(events, /\n {8}on<K extends keyof Events>\(name: K, listener: Events\[K\], options\?: boolean \| EventOptions\): \(\) => boolean;/, '`ctx.on` mudou de forma (devolve o disposer `() => boolean`)')
  assert.match(events, /export interface Events \{/, '`Events` deixou de ser a interface augmentavel dos eventos')

  // `effect` chega ao Context por `Pick<Fiber, 'effect'>`.
  assert.match(fiber, /interface Context extends Pick<Fiber, 'effect'> \{/, '`ctx.effect` deixou de ser mixado no Context a partir da Fiber')
  assert.match(fiber, /\n {4}effect\(execute: \(\) => SyncEffect, label\?: string\): Disposable<Promise<void>>;/, '`Fiber.effect` mudou de forma')
  assert.match(fiber, /export type Disposable<T = any> = \(\) => T;/, '`Disposable` -- o tipo real do disposer -- mudou de forma')

  // Ciclo de vida da Fiber com disposers em LIFO.
  assert.match(fiber, /export declare const enum FiberState \{\s*PENDING = 0,\s*LOADING = 1,\s*ACTIVE = 2,\s*FAILED = 3,\s*DISPOSED = 4,\s*UNLOADING = 5\s*\}/, '`FiberState` mudou de forma')
  assert.match(prose(fiber), /Disposers run in reverse registration order when the owning fiber unloads/, 'a garantia LIFO dos disposers desapareceu do contrato da Fiber')
  assert.match(prose(fiber), /run \(in reverse order\) either when the returned disposer is called or when the fiber unloads/, 'a garantia LIFO desapareceu do contrato de `Fiber.effect`')

  assert.match(service, /export declare abstract class Service<out T = never> \{/, '`Service` mudou de forma')
  assert.match(service, /\n {4}constructor\(ctx: Context, name: string\);/, 'o construtor `Service(ctx, name)` mudou de forma')

  const index = published(pin, 'index.d.ts')
  for (const mod of ['./context.ts', './events.ts', './fiber.ts', './logger.ts', './registry.ts', './service.ts', './utils.ts']) {
    assert.ok(index.includes(`export * from '${mod}'`), `o barrel do cordis deixou de reexportar ${mod}`)
  }
})
