/**
 * T0.4 / S10 — conduz um navegador headless contra a origem de teste
 * (`cookie-origin.mjs`) e devolve o que ele REENVIOU. Zero dependencia nova:
 * perfil descartavel em `tmpdir`, `spawn` do binario do sistema, sem WebDriver.
 *
 * O que se mede e o reenvio do header `Cookie` na requisicao seguinte — nao o
 * `document.cookie`, que `HttpOnly` torna cego por construcao. Cobre os dois
 * motores (Gecko e Chromium) porque a regra de origem confiavel e do motor.
 *
 * Nunca fala com o harness do operador: a origem sobe em porta efemera propria
 * e o navegador so recebe essa URL. Mata apenas o processo que ele proprio criou.
 *
 * Uso: node scripts/spike/ui/browser-cookie-probe.mjs --motor firefox|chromium
 *      [--host 127.0.0.1] [--binario <caminho>] [--out resultado.json]
 */
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const engine = flag('motor', 'firefox')
const host = flag('host', '127.0.0.1')
const here = dirname(fileURLToPath(import.meta.url))
const outFile = flag('out', undefined)

/** Preferencias de Gecko que desligam primeira-execucao, telemetria e boas-vindas. */
const GECKO_PREFS = [
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("datareporting.policy.firstRunURL", "");',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.sessionstore.resume_from_crash", false);',
  'user_pref("network.cookie.cookieBehavior", 0);',
].join('\n')

/** Como cada motor e arrancado em headless com um perfil descartavel. */
const ENGINES = {
  firefox: {
    binarioPadrao: 'firefox',
    async prepararPerfil(dir) { await writeFile(join(dir, 'user.js'), GECKO_PREFS) },
    argumentos: (perfil, url) => ['--headless', '--no-remote', '--new-instance', '--profile', perfil, url],
  },
  chromium: {
    binarioPadrao: 'brave-browser',
    async prepararPerfil() {},
    argumentos: (perfil, url) => [
      '--headless=new', `--user-data-dir=${perfil}`, '--no-first-run',
      '--no-default-browser-check', '--disable-sync', '--disable-extensions',
      '--disable-gpu', '--virtual-time-budget=15000', url,
    ],
  },
}

const spec = ENGINES[engine]
if (spec === undefined) {
  console.error(`motor desconhecido: ${engine} (use firefox ou chromium)`)
  process.exit(2)
}
const binary = flag('binario', spec.binarioPadrao)

/** Versao exacta do navegador medido — sem isto a medicao nao e citavel. */
async function browserVersion() {
  try {
    const { stdout } = await promisify(execFile)(binary, ['--version'])
    return stdout.trim()
  } catch (error) {
    return `desconhecida (${error.message})`
  }
}

const version = await browserVersion()
console.log(`motor=${engine} binario=${binary} versao=${version}`)

// A origem de teste corre como processo filho e imprime `LISTENING <origem>`.
const origin = spawn(process.execPath, [join(here, 'cookie-origin.mjs'), '--host', host, '--port', '0', '--timeout', '30000'], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
let originOut = ''
const originUrl = await new Promise((resolve, reject) => {
  origin.stdout.setEncoding('utf8')
  origin.stdout.on('data', (chunk) => {
    originOut += chunk
    const line = /^LISTENING (\S+)$/m.exec(originOut)
    if (line !== null) resolve(line[1])
  })
  origin.on('error', reject)
  origin.on('exit', () => { reject(new Error('a origem de teste morreu antes de escutar')) })
})
console.log(`origem de teste: ${originUrl}`)

const profile = await mkdtemp(join(tmpdir(), `dsh-s10-${engine}-`))
await spec.prepararPerfil(profile)
const browser = spawn(binary, spec.argumentos(profile, `${originUrl}/step1`), {
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
})
console.log(`${engine} headless pid=${browser.pid} -> ${originUrl}/step1`)

const code = await new Promise((resolve) => { origin.on('exit', resolve) })
try { process.kill(-browser.pid, 'SIGKILL') } catch { browser.kill('SIGKILL') }
await rm(profile, { recursive: true, force: true })

const payload = originOut.slice(originOut.indexOf('{'))
const measured = payload.startsWith('{') ? JSON.parse(payload) : { erro: 'a origem nao produziu JSON' }
const report = { motor: engine, navegador: version, headless: true, ...measured }
console.log(`\n===== RESULTADO S10 (${engine} / ${version}) =====`)
console.log(JSON.stringify(report, null, 2))
if (outFile !== undefined) await writeFile(outFile, JSON.stringify(report, null, 2))
process.exit(code === 0 ? 0 : 1)
