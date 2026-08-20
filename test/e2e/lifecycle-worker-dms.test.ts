/**
 * =============================================================================
 * T6.4 -- SIGKILL NO HOST -> NENHUM WORKER ORFAO: o dead-man's switch por pipe.
 * =============================================================================
 *
 * O worker do Telegram corre `detached` com `stdio.stdin: 'pipe'`. Quando o
 * processo host (o DSH) e morto com SIGKILL, o disposer NAO CORRE -- nem o
 * abort, nem o tree-kill. O que corre e o nucleo, que fecha o descritor; o
 * worker ve EOF no stdin e termina-se a si proprio (DEAD_MANS_SWITCH_EXIT_CODE,
 * `worker/ipc.ts`). E a UNICA defesa que sobrevive a um SIGKILL.
 *
 * AS PERGUNTAS FALSIFICAVEIS DE T6.4, RESPONDIDAS AQUI:
 *
 *   1. "mede o NETO ou so o filho direto?" -- aqui o filho e o worker, e o que
 *      se mede e ele (nao ha neto no worker); a arvore do CLOUDFLARED (com
 *      neto) esta em lifecycle-orphan-sweep.test.ts.
 *
 *   2. "o SIGKILL e mesmo SIGKILL?" -- SIM: o host e morto com
 *      kill(pid, 'SIGKILL') e o evento 'exit' reporta signal === 'SIGKILL',
 *      exitCode === null. Um SIGTERM com handler daria exitCode 0, signal null.
 *
 *   3. "so roda em Linux?" -- os: [linux, darwin]; win32 salta (sem POSIX).
 *
 *   4. "ESRCH 'nao existe' vs 'nao e lider'?" -- antes do SIGKILL verifica-se
 *      com ps que o worker e lider do proprio grupo e sessao (detached), e
 *      depois do SIGKILL verifica-se que ele DEIXOU DE EXISTIR (ps undefined).
 *      Nenhuma das duas coisas se infere de ESRCH.
 *
 * O CENARIO E CONSTRUIDO PARA NAO TER OUTRA EXPLICACAO: o worker e detached
 * (nao morre pelo grupo do pai), mata-se o pid POSITIVO (o grupo do worker nao
 * e alvejado) e o worker tem um setInterval que o manteria vivo para sempre.
 * A unica causa possivel de morte e o EOF no stdin.
 *
 * CRITERIO DE ACEITE GLOBAL: zero processos remanescentes da suite.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import { DEAD_MANS_SWITCH_EXIT_CODE } from '../../worker/ipc.ts'
import { isAlive, waitFor } from '../integration/proc/seat.ts'

const POSIX_REASON =
  'dead-man\'s switch POSIX; o package.json declara os: [linux, darwin].'

const HOST_FIXTURE = fileURLToPath(new URL('../integration/proc/fixtures/host-eof.ts', import.meta.url))

/** Teto do criterio de aceite: o worker morre em menos de 2 s. */
const LIMITE_MS = 2000

const evidencias = mkdtempSync(join(tmpdir(), 'dsh-guard-e2e-dms-'))
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
  for (const pid of vivos) {
    if (isAlive(pid)) matarSePreciso(pid)
  }
  for (const filho of filhos) {
    if (filho.pid !== undefined && isAlive(filho.pid)) matarSePreciso(filho.pid)
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 200))
  rmSync(evidencias, { recursive: true, force: true })

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
})

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

interface Par {
  host: ChildProcess
  workerPid: number
  saida(): number | undefined
}

async function arrancarPar(env: NodeJS.ProcessEnv = {}): Promise<Par> {
  const ficheiroEvidencia = join(evidencias, `saida-${String(filhos.length)}-${String(Date.now())}`)
  const host = spawn(process.execPath, [HOST_FIXTURE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_TESTE_EVIDENCIA: ficheiroEvidencia, ...env },
  })
  filhos.push(host)

  let buffer = ''
  const workerPid = await new Promise<number>((resolve, reject) => {
    const prazo = setTimeout(() => reject(new Error('o host nunca publicou o pid do worker')), 10_000)
    host.stdout.on('data', (chunk: Buffer): void => {
      buffer += chunk.toString()
      const match = /WORKER=(\d+)/u.exec(buffer)
      if (match?.[1] !== undefined) {
        clearTimeout(prazo)
        resolve(Number(match[1]))
      }
    })
  })

  vivos.add(workerPid)
  await waitFor(() => isAlive(workerPid))
  return {
    host,
    workerPid,
    saida: (): number | undefined => {
      try {
        const match = /EXIT=(-?\d+)/u.exec(readFileSync(ficheiroEvidencia, 'utf8'))
        return match?.[1] === undefined ? undefined : Number(match[1])
      } catch {
        return undefined
      }
    },
  }
}

/**
 * SIGKILL no host, e a prova de que o sinal foi MESMO SIGKILL: o evento 'exit'
 * do ChildProcess reporta (code null, signal 'SIGKILL'). Um SIGTERM com handler
 * daria (code 0, signal null) -- a pergunta falsificavel 2 de T6.4.
 */
async function matarHostComSIGKILL(host: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  process.kill(host.pid as number, 'SIGKILL')
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    host.on('exit', (code, signal) => resolve({ code, signal }))
  })
}

/** Mede quantos ms o worker levou a desaparecer depois do SIGKILL no host. */
async function cronometrar(host: ChildProcess, workerPid: number): Promise<number> {
  const inicio = process.hrtime.bigint()
  await matarHostComSIGKILL(host)
  await waitFor(() => !isAlive(workerPid), { timeoutMs: LIMITE_MS + 3000, stepMs: 5 })
  return Number(process.hrtime.bigint() - inicio) / 1e6
}

describe("SIGKILL no host -> nenhum worker orfao", { skip: process.platform === 'win32' ? POSIX_REASON : false }, () => {
  it('o worker morre pelo EOF em menos de 2 s (medido), e deixa de existir na tabela', async (t) => {
    const par = await arrancarPar()
    const { host, workerPid } = par
    assert.equal(isAlive(workerPid), true, 'o worker tem de estar vivo antes')
    assert.notEqual(host.pid, undefined)

    // Antes do SIGKILL: o worker e lider do PROPRIO grupo e da propria sessao
    // (detached == setsid), filho do host. E isto que torna o EOF a unica causa
    // possivel de morte.
    const factos = ps(workerPid)
    assert.notEqual(factos, undefined)
    assert.equal(factos?.pgid, workerPid, 'o worker tem de ser lider do seu grupo')
    assert.equal(factos?.sid, workerPid, 'e da sua sessao')
    assert.equal(factos?.ppid, host.pid, 'e filho do host enquanto o host vive')

    const decorridoMs = await cronometrar(host, workerPid)
    const morreu = !isAlive(workerPid)

    t.diagnostic(
      `dead-mans switch: worker morto ${decorridoMs.toFixed(1)} ms apos o SIGKILL, ` +
        `codigo ${String(par.saida())}`,
    )
    assert.equal(morreu, true, 'o worker sobreviveu ao host: o dead-mans switch nao disparou')
    assert.equal(par.saida(), DEAD_MANS_SWITCH_EXIT_CODE, 'e saiu pelo caminho previsto (EXIT=0)')
    assert.ok(decorridoMs < LIMITE_MS, `criterio: < ${String(LIMITE_MS)} ms; medido ${decorridoMs.toFixed(1)} ms`)

    // "Nenhum worker orfao": o pid NAO pode continuar na tabela de processos.
    assert.equal(ps(workerPid), undefined, 'o pid nao pode continuar na tabela')
  })

  it('o SIGKILL e MESMO SIGKILL: o host morre com signal SIGKILL, nao com um handler', async () => {
    const par = await arrancarPar()

    const saida = await matarHostComSIGKILL(par.host)
    assert.equal(saida.signal, 'SIGKILL', 'o exit event tem de reportar o sinal que matou')
    assert.equal(saida.code, null, 'um processo morto por sinal nao tem exit code')

    await waitFor(() => !isAlive(par.workerPid), { timeoutMs: LIMITE_MS + 3000, stepMs: 5 })
    assert.equal(ps(par.workerPid), undefined)
  })

  it('o switch aguenta o adversario silencioso `pause`: o worker morre na mesma', async (t) => {
    // process.stdin.pause() e uma linha perfeitamente normal de se escrever no
    // worker real; sem defesa, desarmava o EOF e o bot ficava orfao a falar com
    // a internet. O switch tem de sobreviver-lhe.
    const par = await arrancarPar({ DSH_TESTE_MODO: 'pause' })
    const decorridoMs = await cronometrar(par.host, par.workerPid)

    t.diagnostic(
      `modo 'pause': worker morto ${decorridoMs.toFixed(1)} ms apos o SIGKILL, ` +
        `codigo ${String(par.saida())}`,
    )
    assert.equal(isAlive(par.workerPid), false, `com 'pause' o switch ficou desarmado`)
    assert.ok(decorridoMs < LIMITE_MS, `medido ${decorridoMs.toFixed(1)} ms`)
    // "Deixou de existir" NAO chega: um 'error' sem ouvinte tambem mata o
    // processo. So EXIT=0 prova que ele saiu POR ONDE devia.
    assert.equal(par.saida(), DEAD_MANS_SWITCH_EXIT_CODE, `com 'pause' o worker nao saiu pelo switch`)
  })
})
