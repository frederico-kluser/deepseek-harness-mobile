/**
 * =============================================================================
 * T6.4 -- VARREDURA DE PIDFILE NO BOOT: o orfao da execucao anterior e
 * derrubado ANTES de qualquer outra inicializacao (02-SEGURANCA 9).
 * =============================================================================
 *
 * O cenario inteiro, com processos e ficheiros REAIS:
 *
 *   execucao anterior: um `cloudflared` (duble congelado em forma de script,
 *   com um NETO vivo) corre `detached`, e o `state.json` regista
 *   `tunnel: { pid, startedAt }`. O host morre com SIGKILL -- o orfao
 *   sobrevive (e por isso a varredura existe) e e reparentado pelo SUBREAPER
 *   mais proximo (systemd --user), NAO necessariamente o PID 1.
 *
 *   boot seguinte: a varredura (`sweepOrphanTunnel` de `src/tunnel/pidfile.ts`
 *   com `defaultOrphanSweepDeps`, o caminho real de producao) corre ANTES de
 *   mais nada, le o registo do disco, identifica o processo por /proc e derruba
 *   a ARVORE -- o NETO inclui.
 *
 * AS QUATRO PERGUNTAS FALSIFICAVEIS DE T6.4, RESPONDIDAS AQUI:
 *
 *   1. "o teste de orfao mede o NETO ou so o filho direto?" -- o neto. O orfao
 *      tem um filho vivo; cada cenario de derrube assere a morte do NETO, nao
 *      so a do pid registado: uma varredura que matasse so o filho direto
 *      deixaria a URL publica de pe por tras de um neto reparentado.
 *
 *   2. "o SIGKILL no host e mesmo SIGKILL?" -- sim: o host e morto com
 *      kill(pid, 'SIGKILL') e o evento 'exit' do ChildProcess reporta
 *      signal === 'SIGKILL', exitCode === null. Um SIGTERM com handler daria
 *      exitCode 0.
 *
 *   3. "so roda em Linux?" -- os: [linux, darwin] no package.json. Em darwin
 *      /proc nao existe e o identificador devolve null: a varredura entao
 *      derruba na duvida (fail-closed), e este ficheiro assere isso como
 *      comportamento legitimo. So o cenario de reutilizacao de pid (leitura do
 *      starttime em /proc) e exclusivamente Linux e salta em darwin.
 *
 *   4. "ESRCH 'nao existe' vs ESRCH 'nao e lider de grupo'?" -- o orfao e
 *      sempre arrancado `detached` (lider do proprio grupo), exatamente como
 *      o assento real faz; o kill ao GRUPO e o que leva o neto. Sem detached o
 *      -pid falharia com ESRCH e o neto sobreviveria -- coberto em
 *      tree-kill-real.test.ts.
 *
 * CRITERIO DE ACEITE GLOBAL: zero processos remanescentes da suite (o after
 * mata a arvore inteira e verifica pelos handles ChildProcess).
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import { createStateStore } from '../../src/state/store.ts'
// A varredura em si corre no BOOT-HELPER (processo novo, imports absolutos
// para o src real) -- ver o ficheiro gerado abaixo. Aqui so se importa o tipo
// do veredito, para tipar o resultado que o helper imprime.
import type { OrphanSweepOutcome } from '../../src/tunnel/pidfile.ts'
import { readProcessStartMs } from '../../src/proc/introspect.ts'

const POSIX_REASON =
  'varredura de orfao POSIX; o package.json declara os: [linux, darwin].'

/** Raiz do repositorio (a worktree), para o helper de boot importar o src real. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const bin = mkdtempSync(join(tmpdir(), 'dsh-guard-e2e-orphan-'))
const vivos = new Set<number>()
const filhos: ChildProcess[] = []

function matarSePreciso(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    void error
  }
}

after(async () => {
  // Mata TUDO o que este ficheiro criou: os pids rastreados E os handles
  // diretos (um host vivo com um pipe aberto segura o event loop do teste).
  for (const pid of vivos) {
    if (isAlive(pid)) matarSePreciso(pid)
  }
  for (const filho of filhos) {
    if (filho.pid !== undefined && isAlive(filho.pid)) matarSePreciso(filho.pid)
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 200))

  const pendentes = filhos.filter((filho) => filho.exitCode === null && filho.signalCode === null)
  assert.deepEqual(
    pendentes.map((filho) => filho.pid),
    [],
    'handles ChildProcess deste ficheiro sem saida observada apos a suite',
  )
  const vivosAinda = [...vivos].filter((pid) => isAlive(pid))
  vivos.clear()
  filhos.length = 0
  assert.deepEqual(
    vivosAinda,
    [],
    `pids deste ficheiro ainda vivos apos a suite: ${vivosAinda.join(', ') || '(nenhum esperado)'}`,
  )
  rmSync(bin, { recursive: true, force: true })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 10_000, stepMs = 10 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
  return predicate()
}

interface PsFacts {
  pid: number
  ppid: number
  pgid: number
  sid: number
}

function ps(pid: number): PsFacts | undefined {
  try {
    const linha = execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,sid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
    if (linha === '') return undefined
    const [p, pp, pg, s] = linha.split(/\s+/u).map(Number)
    if (p === undefined || pp === undefined || pg === undefined || s === undefined) return undefined
    return { pid: p, ppid: pp, pgid: pg, sid: s }
  } catch {
    return undefined
  }
}

/** Filhos diretos de um pid (para descobrir o NETO sem depender de ecos). */
function filhosDe(pid: number): number[] {
  try {
    const out = execFileSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' }).trim()
    if (out === '') return []
    return out.split('\n').map(Number).filter((p) => p > 0)
  } catch {
    return []
  }
}

/* ========================================================================== */
/* Os executaveis de teste                                                    */
/* ========================================================================== */

/**
 * Duble do `cloudflared`: arranca `detached`, fica vivo e cria um NETO nao-
 * detached (que partilha o grupo). A varredura reconhece-o por `argv[1] ===
 * scriptPath` (o ramo de interpretador de `looksLikeCloudflared`) -- o MESMO
 * caminho pelo qual o boot reconhece um binaryPath que seja um script.
 */
const CF_SCRIPT = join(bin, 'fake-cloudflared.mjs')
writeFileSync(
  CF_SCRIPT,
  [
    "import { createServer } from 'node:http'",
    "import { spawn } from 'node:child_process'",
    "const neto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    "const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })",
    "server.listen(0, '127.0.0.1')",
    'setInterval(() => {}, 1000)',
  ].join('\n') + '\n',
  'utf8',
)

/** O HOST da execucao anterior: spawna o orfao detached e fica vivo. */
const HOST_SCRIPT = join(bin, 'host-anterior.mjs')
writeFileSync(
  HOST_SCRIPT,
  [
    "import { spawn } from 'node:child_process'",
    "const script = process.env['CF_SCRIPT'] ?? ''",
    "const cf = spawn(process.execPath, [script, '--metrics', '127.0.0.1:0'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })",
    'cf.stderr?.resume()',
    "console.log('CF=' + String(cf.pid))",
    'setInterval(() => {}, 1000)',
  ].join('\n') + '\n',
  'utf8',
)

/**
 * O BOOT SEGUINTE, num processo NOVO: corre a varredura real ANTES de qualquer
 * outra inicializacao e imprime o resultado em JSON no stdout.
 */
const BOOT_HELPER = join(bin, 'boot-helper.ts')
writeFileSync(
  BOOT_HELPER,
  [
    "import { join } from 'node:path'",
    `import { createStateStore } from '${REPO_ROOT}src/state/store.ts'`,
    `import { defaultOrphanSweepDeps, sweepOrphanTunnel } from '${REPO_ROOT}src/tunnel/pidfile.ts'`,
    "const dir = process.env['SWEEP_DIR'] ?? ''",
    "const expected = process.env['SWEEP_EXPECTED'] ?? ''",
    "const store = createStateStore({ paths: { dir, file: join(dir, 'state.json') } })",
    'const log = {',
    "  info: (m: string): void => { process.stderr.write('sweep-info ' + m + '\\n') },",
    "  warn: (m: string): void => { process.stderr.write('sweep-warn ' + m + '\\n') },",
    '}',
    'const resultado = sweepOrphanTunnel(',
    "  defaultOrphanSweepDeps(store.store, log, expected === '' ? undefined : expected),",
    ')',
    "console.log(JSON.stringify({ outcome: resultado.outcome, pid: resultado.record?.pid }))",
  ].join('\n') + '\n',
  'utf8',
)

/** Arranca um orfao detached (com neto) e devolve o pid dele. */
async function arrancarOrfao(): Promise<number> {
  const cf = spawn(process.execPath, [CF_SCRIPT, '--metrics', '127.0.0.1:0'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (cf.pid === undefined) throw new Error('orfao sem pid')
  vivos.add(cf.pid)
  filhos.push(cf)
  await waitFor(() => isAlive(cf.pid as number))
  await waitFor(() => filhosDe(cf.pid as number).length > 0)
  return cf.pid as number
}

/** Espera o neto do orfao e devolve-lhe o pid. */
async function netoDo(pid: number): Promise<number> {
  // O neto nasce DENTRO do script do orfao, alguns ms apos o spawn: espera-se
  // que apareca na tabela (ps --ppid) em vez de o ler uma unica vez.
  const apareceu = await waitFor(() => filhosDe(pid).length > 0)
  assert.equal(apareceu, true, `o orfao ${String(pid)} tem de criar um neto`)
  const netos = filhosDe(pid)
  assert.notEqual(netos[0], undefined)
  const netoPid = netos[0] as number
  vivos.add(netoPid)
  await waitFor(() => isAlive(netoPid))
  return netoPid
}

interface BootResult {
  outcome: OrphanSweepOutcome
  pid?: number
}

/** Corre o boot-helper (processo NOVO) e devolve o veredito da varredura. */
async function correrBoot(dir: string, expectedCommand?: string): Promise<BootResult> {
  const saida = await new Promise<string>((resolve, reject) => {
    const boot = spawn(
      process.execPath,
      [BOOT_HELPER],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SWEEP_DIR: dir,
          SWEEP_EXPECTED: expectedCommand ?? '',
        },
      },
    )
    filhos.push(boot)
    let stdout = ''
    let stderr = ''
    boot.stdout.on('data', (chunk: Buffer): void => {
      stdout += chunk.toString()
    })
    boot.stderr.on('data', (chunk: Buffer): void => {
      stderr += chunk.toString()
    })
    boot.on('exit', (code) => {
      if (code !== 0) reject(new Error(`boot-helper saiu com ${String(code)}: ${stderr}`))
      else resolve(stdout)
    })
    boot.on('error', reject)
  })
  const json = saida.trim().split('\n').at(-1)
  if (json === undefined) throw new Error('boot-helper nao imprimiu JSON')
  const parsed = JSON.parse(json) as BootResult
  // O vocabulario do veredito e fechado; `includes` evita a comparacao que o
  // compilador prova redundante (o tipo ja exaure os quatro valores).
  const VALIDOS: readonly OrphanSweepOutcome[] = ['none', 'gone', 'foreign', 'killed']
  assert.ok(VALIDOS.includes(parsed.outcome), `outcome desconhecido: ${json}`)
  return parsed
}

/* ========================================================================== */
/* A suite                                                                     */
/* ========================================================================== */

describe('varredura de pidfile no boot', { skip: process.platform === 'win32' ? POSIX_REASON : false }, () => {
  it('boot limpo: sem registo no state.json, outcome `none`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-state-'))
    const store = createStateStore({ paths: { dir, file: join(dir, 'state.json') } })
    store.store.read()
    store.dispose()

    const resultado = await correrBoot(dir)
    assert.equal(resultado.outcome, 'none')
    rmSync(dir, { recursive: true, force: true })
  })

  it('registo de um pid ja morto: outcome `gone`, nada e matado', async () => {
    const efemero = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    filhos.push(efemero)
    const pidMorto = efemero.pid as number
    await waitFor(() => !isAlive(pidMorto))

    const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-state-'))
    const store = createStateStore({ paths: { dir, file: join(dir, 'state.json') } })
    store.store.update((state) => ({ ...state, tunnel: { pid: pidMorto, startedAt: Date.now(), mode: 'quick' } }))
    store.dispose()

    const resultado = await correrBoot(dir)
    assert.equal(resultado.outcome, 'gone')
    rmSync(dir, { recursive: true, force: true })
  })

  it('pid ocupado por OUTRO programa: outcome `foreign`, o processo NAO e morto', async () => {
    // Um processo que NAO e o nosso tunel: a varredura identifica-o por /proc
    // e recusa-se a matar -- matar seria derrubar um processo do utilizador.
    const alheio = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    if (alheio.pid === undefined) throw new Error('sem pid')
    vivos.add(alheio.pid)
    filhos.push(alheio)
    await waitFor(() => isAlive(alheio.pid as number))

    const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-state-'))
    const store = createStateStore({ paths: { dir, file: join(dir, 'state.json') } })
    store.store.update((state) => ({
      ...state,
      tunnel: { pid: alheio.pid as number, startedAt: Date.now(), mode: 'quick' },
    }))
    store.dispose()

    const resultado = await correrBoot(dir)
    assert.equal(resultado.outcome, 'foreign')
    assert.equal(isAlive(alheio.pid as number), true, 'o processo alheio tem de sobreviver')

    matarSePreciso(alheio.pid)
    rmSync(dir, { recursive: true, force: true })
  })

  it('orfao de uma execucao anterior (com NETO): derrubado no boot, neto incluido', async () => {
    const orfaoPid = await arrancarOrfao()
    const netoPid = await netoDo(orfaoPid)
    const factos = ps(orfaoPid)
    assert.notEqual(factos, undefined)
    assert.equal(factos?.pgid, orfaoPid, 'o orfao tem de ser lider do grupo (detached)')
    assert.equal(ps(netoPid)?.pgid, orfaoPid, 'o neto tem de partilhar o grupo')

    // A execucao anterior deixou o registo no disco.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-state-'))
    const store = createStateStore({ paths: { dir, file: join(dir, 'state.json') } })
    store.store.update((state) => ({
      ...state,
      tunnel: { pid: orfaoPid, startedAt: Date.now(), mode: 'quick' },
    }))
    store.dispose()

    const resultado = await correrBoot(dir, CF_SCRIPT)
    assert.equal(resultado.outcome, 'killed')

    // A ARVORE morreu: o pid registado E o neto. So matar o filho direto
    // deixaria a URL publica viva por tras de um neto reparentado.
    const orfaoMorto = await waitFor(() => !isAlive(orfaoPid))
    const netoMorto = await waitFor(() => !isAlive(netoPid))
    assert.equal(orfaoMorto, true)
    assert.equal(netoMorto, true, 'o NETO tem de morrer com o grupo: a varredura e tree-scoped')
    assert.equal(ps(netoPid), undefined)

    // O registo foi limpo do disco.
    const store2 = createStateStore({ paths: { dir, file: join(dir, 'state.json') } })
    assert.equal(store2.store.read().tunnel, undefined, 'o registo do orfao tem de ser apagado')
    store2.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('SIGKILL no host -> orfao sobrevive e e reparentado pelo SUBREAPER; o boot seguinte derruba-o', async (t) => {
    // A execucao anterior: um HOST que spawna o tunel detached.
    const host = spawn(process.execPath, [HOST_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CF_SCRIPT },
    })
    filhos.push(host)

    let eco = ''
    const orfaoPid = await new Promise<number>((resolve, reject) => {
      const prazo = setTimeout(() => reject(new Error('o host nunca publicou o pid do tunel')), 10_000)
      host.stdout.on('data', (chunk: Buffer): void => {
        eco += chunk.toString()
        const match = /CF=(\d+)/u.exec(eco)
        if (match?.[1] !== undefined) {
          clearTimeout(prazo)
          resolve(Number(match[1]))
        }
      })
    })
    vivos.add(orfaoPid)
    const netoPid = await netoDo(orfaoPid)

    // Enquanto o host vive, o orfao e seu filho.
    const antes = ps(orfaoPid)
    assert.notEqual(antes, undefined)
    assert.equal(antes?.ppid, host.pid, 'o tunel e filho do host enquanto o host vive')

    // O registo da execucao anterior esta no disco.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-state-'))
    const store = createStateStore({ paths: { dir, file: join(dir, 'state.json') } })
    store.store.update((state) => ({
      ...state,
      tunnel: { pid: orfaoPid, startedAt: Date.now(), mode: 'quick' },
    }))
    store.dispose()

    // SIGKILL REAL no host: o exit event prova-o (signal SIGKILL, exitCode null).
    process.kill(host.pid as number, 'SIGKILL')
    const saida = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      host.on('exit', (code, signal) => resolve({ code, signal }))
    })
    assert.equal(saida.signal, 'SIGKILL', 'o host tem de ter morrido PELO SIGKILL (e nao por um handler)')
    assert.equal(saida.code, null)

    // O orfao SOBREVIVE (detached) e e reparentado: o nucleo entrega-o ao
    // SUBREAPER mais proximo (systemd --user numa sessao de utilizador), NAO
    // necessariamente ao PID 1. Mede-se o reparenting; nunca se assere um pai
    // fixo.
    const reparentado = await waitFor(() => {
      const factos = ps(orfaoPid)
      return factos !== undefined && factos.ppid !== (host.pid as number)
    })
    assert.equal(reparentado, true, 'o orfao tem de sobreviver ao host e mudar de pai')
    const depois = ps(orfaoPid)
    assert.notEqual(depois, undefined)
    assert.equal(isAlive(orfaoPid), true, 'o orfao esta VIVO apos o SIGKILL: e por isso que a varredura existe')
    assert.notEqual(depois?.ppid, process.pid, 'e nao e adotado pelo processo de teste')

    let nomeNovoPai = '?'
    const novoPai = depois?.ppid ?? 0
    try {
      nomeNovoPai = execFileSync('ps', ['-o', 'comm=', '-p', String(novoPai)], { encoding: 'utf8' }).trim()
    } catch (error) {
      void error
    }
    t.diagnostic(
      `SIGKILL no host: o tunel orfao ficou reparentado para pid ${String(novoPai)} (${nomeNovoPai})` +
        ' -- o subreaper mais proximo, nao necessariamente o PID 1',
    )

    // O BOOT SEGUINTE (um processo NOVO) corre a varredura e derruba o orfao.
    const resultado = await correrBoot(dir, CF_SCRIPT)
    assert.equal(resultado.outcome, 'killed')
    const morreu = await waitFor(() => !isAlive(orfaoPid))
    const netoMorreu = await waitFor(() => !isAlive(netoPid))
    assert.equal(morreu, true, 'o orfao tem de morrer no boot seguinte')
    assert.equal(netoMorreu, true, 'e o neto com ele')

    rmSync(dir, { recursive: true, force: true })
  })

  it('mesmo programa, INSTANCIA POSTERIOR (pid reciclado): NAO e morto (leitura do starttime)', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('a leitura do starttime e /proc/<pid>/stat, exclusiva do Linux; em darwin a varredura derruba na duvida')
      return
    }

    const orfaoPid = await arrancarOrfao()
    // A varredura so pode distinguir "mesma instancia" de "instancia nova" se a
    // calibracao do starttime estiver fiavel neste processo de teste.
    assert.notEqual(readProcessStartMs(orfaoPid), null, 'calibracao do starttime indisponivel')

    // O registo diz que o tunel arrancou ha DOIS minutos; o processo que agora
    // ocupa o pid arrancou DEPOIS do registo -> e outra instancia, nao a nossa.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-state-'))
    const store = createStateStore({ paths: { dir, file: join(dir, 'state.json') } })
    store.store.update((state) => ({
      ...state,
      tunnel: { pid: orfaoPid, startedAt: Date.now() - 120_000, mode: 'quick' },
    }))
    store.dispose()

    const resultado = await correrBoot(dir, CF_SCRIPT)
    assert.equal(resultado.outcome, 'foreign', 'a instancia posterior e alheia: nao se mata')
    assert.equal(isAlive(orfaoPid), true, 'o processo posterior tem de sobreviver')

    matarSePreciso(orfaoPid)
    const neto = filhosDe(orfaoPid)[0]
    if (neto !== undefined) matarSePreciso(neto)
    rmSync(dir, { recursive: true, force: true })
  })
})
