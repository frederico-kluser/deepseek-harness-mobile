/**
 * =============================================================================
 * O DEAD-MAN'S SWITCH, MEDIDO -- nao afirmado.
 * =============================================================================
 *
 * CRITERIO DE ACEITE (`src/contracts/ipc.ts`, propriedade 2 do canal):
 * `SIGKILL` no processo host -> worker morto em MENOS DE 2 SEGUNDOS.
 *
 * PORQUE ISTO PRECISA DE TRES PROCESSOS REAIS. O mecanismo depende do NUCLEO:
 * morto o pai com `SIGKILL`, e o sistema operativo que fecha os descritores
 * dele, e e esse fecho que faz o `stdin` do filho chegar a EOF. Nenhum duble
 * modela isso -- um `PassThrough` que se fecha a mando do teste prova a REACCAO
 * do worker (`test/unit/worker/ipc.test.ts`) mas nao prova que o EOF chega.
 *
 * O CENARIO E CONSTRUIDO PARA NAO TER OUTRA EXPLICACAO:
 *   - o worker e `detached`, logo NAO morre pelo grupo do pai;
 *   - mata-se `pid` e nao `-pid`, logo o grupo do worker nao e alvejado;
 *   - o worker tem um `setInterval` que o mantem vivo para sempre.
 * Sobra uma unica causa possivel de morte: o EOF no `stdin`.
 *
 * >>> NAO COPIAR A DECISAO DA ONDA 3. <<< La ficou registado que o dead-man's
 * switch por pipe "nao servia" para o `cloudflared`. A razao era ESPECIFICA: o
 * mecanismo exige que o filho COOPERE, e um binario de terceiros nao coopera. O
 * worker do Telegram e codigo NOSSO -- aqui o controlo e exigivel, e este
 * ficheiro exige-o.
 *
 * MEDIDO nesta arvore: 10,5 a 18,1 ms isolado (6 corridas) e ate ~62 ms dentro
 * da suite completa, onde o corredor de testes disputa CPU. O numero e IMPRESSO
 * por `t.diagnostic()` a cada corrida, porque um numero que so aparece quando o
 * teste falha nao e uma medicao, e um alarme.
 *
 * >>> A CONDICAO DA PROMESSA, porque um numero sem condicao e propaganda. <<<
 * "< 2 s" vale COM O EVENT LOOP LIVRE. O mecanismo e a entrega de um evento
 * `'end'`, e um evento so e entregue quando o loop volta. Com o worker preso em
 * JavaScript SINCRONO a morte espera pelo fim do bloco -- medido pela revisao,
 * um bloqueio de 3 s deu 2790,1 ms. Isso e INERENTE (nao ha como interromper JS
 * sincrono) e nao ha defesa possivel do lado do canal; o que ha e a obrigacao de
 * o dizer. O ultimo caso deste ficheiro mede-o.
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import { DEAD_MANS_SWITCH_EXIT_CODE } from '../../../worker/ipc.ts'
import { isAlive, waitFor } from './seat.ts'

const HOST_FIXTURE = fileURLToPath(new URL('./fixtures/host-eof.ts', import.meta.url))

/** Teto do criterio de aceite. */
const LIMITE_MS = 2000

const vivos: number[] = []
const hosts: ChildProcess[] = []
const evidencias = mkdtempSync(join(tmpdir(), 'dsh-guard-dms-'))

after(() => {
  rmSync(evidencias, { recursive: true, force: true })
  // Rede de seguranca: nenhum teste deste ficheiro pode deixar processo atras.
  for (const child of hosts) {
    if (child.pid !== undefined) matarSePreciso(child.pid)
  }
  for (const pid of vivos) matarSePreciso(pid)
})

function matarSePreciso(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    void error
  }
}

/** `ps` de um pid, ou `undefined` quando ele ja nao existe. */
function ps(pid: number): { ppid: number; pgid: number; sid: number } | undefined {
  try {
    const linha = execFileSync('ps', ['-o', 'ppid=,pgid=,sess=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
    const [ppid, pgid, sid] = linha.split(/\s+/u).map(Number)
    if (ppid === undefined || pgid === undefined || sid === undefined) return undefined
    return { ppid, pgid, sid }
  } catch {
    return undefined
  }
}

interface Par {
  host: ChildProcess
  workerPid: number
  /** Tudo o que o worker escreveu em `stderr`, encaminhado pelo host. */
  diagnostico(): string
  /** Codigo de saida que o worker registou no disco, ou `undefined`. */
  saida(): number | undefined
}

/** Arranca o host de medicao e devolve-o com o pid do worker que ele criou. */
async function arrancarPar(env: NodeJS.ProcessEnv = {}): Promise<Par> {
  const ficheiroEvidencia = join(evidencias, `saida-${String(hosts.length)}-${String(Date.now())}`)
  const host = spawn(process.execPath, [HOST_FIXTURE], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_TESTE_EVIDENCIA: ficheiroEvidencia, ...env },
  })
  hosts.push(host)

  let diagnostico = ''
  host.stderr?.on('data', (chunk: Buffer): void => {
    diagnostico += chunk.toString()
  })

  let buffer = ''
  const workerPid = await new Promise<number>((resolve, reject) => {
    const prazo = setTimeout(() => reject(new Error('o host nunca publicou o pid do worker')), 10_000)
    host.stdout?.on('data', (chunk: Buffer): void => {
      buffer += chunk.toString()
      const match = /WORKER=(\d+)/u.exec(buffer)
      if (match?.[1] !== undefined) {
        clearTimeout(prazo)
        resolve(Number(match[1]))
      }
    })
  })

  vivos.push(workerPid)
  await waitFor(() => isAlive(workerPid))
  return {
    host,
    workerPid,
    diagnostico: (): string => diagnostico,
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

/** Mata o host e devolve quantos ms o worker levou a desaparecer. */
async function cronometrar(host: ChildProcess, workerPid: number): Promise<number> {
  const inicio = process.hrtime.bigint()
  // `pid` POSITIVO: mata-se SO o host. Com `-pid` o grupo dele morria junto e a
  // medicao nao dizia nada sobre o EOF.
  process.kill(host.pid as number, 'SIGKILL')
  await waitFor(() => !isAlive(workerPid), { timeoutMs: 10_000, stepMs: 5 })
  return Number(process.hrtime.bigint() - inicio) / 1e6
}

describe("SIGKILL no host -> o worker termina-se em menos de 2 s (medido)", () => {
  it('o worker morre pelo EOF, e o tempo e MEDIDO e nao presumido', async (t) => {
    const par = await arrancarPar()
    const { host, workerPid } = par
    assert.equal(isAlive(workerPid), true, 'o worker tem de estar vivo antes')
    assert.notEqual(host.pid, undefined)

    const decorridoMs = await cronometrar(host, workerPid)
    const morreu = !isAlive(workerPid)

    // A MEDICAO E REPORTADA, e nao so asserida: um numero que so aparece quando
    // o teste falha nao e uma medicao, e um alarme.
    t.diagnostic(
      `dead-mans switch: worker morto ${decorridoMs.toFixed(1)} ms apos o SIGKILL, ` +
        `codigo ${String(par.saida())}`,
    )

    assert.equal(morreu, true, 'o worker sobreviveu ao host: o dead-mans switch nao disparou')
    assert.equal(par.saida(), DEAD_MANS_SWITCH_EXIT_CODE, 'e saiu pelo caminho previsto')
    assert.ok(
      decorridoMs < LIMITE_MS,
      `criterio de aceite: < ${String(LIMITE_MS)} ms; medido ${decorridoMs.toFixed(1)} ms`,
    )
  })

  it('e o worker fica MESMO morto -- nao reparentado e vivo', async () => {
    const { host, workerPid } = await arrancarPar()

    /**
     * O QUE A ONDA 3 MEDIU SOBRE REPARENTING, e porque este teste NAO assere
     * `ppid === 1`: um orfao e adotado pelo SUBREAPER mais proximo, que numa
     * sessao de utilizador e o `systemd --user`. Medido nesta arvore: o pai
     * passou a ser o pid 1880026, `/usr/lib/systemd/systemd --user`. Um teste
     * que exigisse `ppid === 1` falharia aqui e passaria num contentor -- ou
     * seja, mediria a topologia da maquina e nao o comportamento do codigo.
     *
     * O que se assere e o que interessa: o processo DEIXOU DE EXISTIR.
     */
    process.kill(host.pid as number, 'SIGKILL')
    await waitFor(() => !isAlive(workerPid), { timeoutMs: LIMITE_MS + 3000, stepMs: 5 })

    assert.equal(ps(workerPid), undefined, 'o pid nao pode continuar na tabela de processos')
    assert.equal(isAlive(workerPid), false)
  })

  /**
   * F3 -- OS DOIS ADVERSARIOS SILENCIOSOS.
   *
   * Cada um destes e UMA LINHA em `worker/telegram-bot.ts` (que e de T4.2, nao
   * desta sub-tarefa) e, sem defesa, cada um desarmava a unica protecao que
   * sobrevive a um `SIGKILL` no DSH -- deixando o bot a falar com a internet sem
   * ninguem a supervisiona-lo. Medido antes da defesa: com `pause()`, o worker
   * sobrevivia indefinidamente (8 s de observacao, sem morrer).
   */
  for (const modo of ['pause', 'dispose']) {
    it(`o switch aguenta \`${modo}\`: o worker morre na mesma, em menos de 2 s`, async (t) => {
      const par = await arrancarPar({ DSH_TESTE_MODO: modo })
      const decorridoMs = await cronometrar(par.host, par.workerPid)

      t.diagnostic(
        `modo '${modo}': worker morto ${decorridoMs.toFixed(1)} ms apos o SIGKILL, ` +
          `codigo ${String(par.saida())}`,
      )
      assert.equal(isAlive(par.workerPid), false, `com '${modo}' o switch ficou desarmado`)
      assert.ok(decorridoMs < LIMITE_MS, `medido ${decorridoMs.toFixed(1)} ms`)
      // "Deixou de existir" NAO chega: um `'error'` sem ouvinte tambem mata o
      // processo, e com o switch desarmado. So `EXIT=0` prova que ele saiu POR
      // ONDE devia.
      assert.equal(
        par.saida(),
        DEAD_MANS_SWITCH_EXIT_CODE,
        `com '${modo}' o worker nao saiu pelo dead-mans switch`,
      )
    })
  }

  /**
   * F4 -- A CONDICAO DA PROMESSA, ESCRITA E MEDIDA.
   *
   * "< 2 s" vale COM O EVENT LOOP LIVRE. O mecanismo e um evento `'end'`, e um
   * evento so e entregue quando o event loop volta -- nao ha forma de
   * interromper JavaScript sincrono, e nao existe defesa possivel para isto do
   * lado do canal. O que existe e a obrigacao de NAO PROMETER o que nao se
   * cumpre: com um bloqueio sincrono de N ms, a morte chega em ~N ms.
   *
   * Medido pela revisao com um bloqueio de 3 s: 2790,1 ms. Aqui usa-se 400 ms
   * para nao pagar 3 s de suite a cada corrida -- o que se prova e a RELACAO,
   * nao um valor.
   */
  it('F4: com o event loop preso em JS sincrono, a morte espera pelo loop', async (t) => {
    const BLOQUEIO_MS = 400
    const par = await arrancarPar({
      DSH_TESTE_MODO: 'bloqueio',
      DSH_TESTE_BLOQUEIO_MS: String(BLOQUEIO_MS),
    })

    // Mata-se assim que o worker anuncia que VAI bloquear, para que o SIGKILL
    // caia com o loop preso -- e nao por sorte de temporizacao.
    await waitFor(() => par.diagnostico().includes('BLOQUEIO'), { timeoutMs: 10_000, stepMs: 2 })
    const decorridoMs = await cronometrar(par.host, par.workerPid)

    t.diagnostic(
      `bloqueio sincrono de ${String(BLOQUEIO_MS)} ms -> worker morto ` +
        `${decorridoMs.toFixed(1)} ms apos o SIGKILL`,
    )
    assert.equal(isAlive(par.workerPid), false, 'ainda assim tem de morrer')
    assert.equal(par.saida(), DEAD_MANS_SWITCH_EXIT_CODE, 'e sai pelo caminho previsto')
    /**
     * PISO ABSOLUTO, e nao `BLOQUEIO_MS * 0.5`: uma asercao que escala com a
     * constante nao consegue notar que a constante mudou -- por mutacao,
     * `BLOQUEIO_MS = 0` passava na mesma e o teste deixava de medir seja o que
     * for. 200 ms e metade do bloqueio configurado e ~4x a medicao OCIOSA deste
     * mesmo ficheiro (46-97 ms), pelo que nao ha como passar por acidente.
     */
    assert.equal(BLOQUEIO_MS, 400, 'o piso abaixo depende deste valor')
    assert.ok(
      decorridoMs >= 200,
      `a morte NAO foi adiada pelo bloqueio (${decorridoMs.toFixed(1)} ms): ` +
        'se isto falhar, a premissa desta medicao mudou',
    )
  })

  it('antes do SIGKILL, worker e host sao lideres do seu PROPRIO grupo e sessao', async () => {
    const { host, workerPid } = await arrancarPar()

    const doWorker = ps(workerPid)
    assert.notEqual(doWorker, undefined)
    // `detached: true` == `setsid(2)`: sem isto, `process.kill(-pid)` nao
    // designa grupo nenhum e o tree-kill do disposer nao existe. O `stdin` em
    // `'pipe'` NAO mexeu nisto -- e a resposta medida a pergunta da revisao.
    assert.equal(doWorker?.pgid, workerPid, 'o worker tem de ser lider do seu grupo')
    assert.equal(doWorker?.sid, workerPid, 'e da sua sessao')
    assert.equal(doWorker?.ppid, host.pid, 'e filho do host enquanto o host vive')

    process.kill(host.pid as number, 'SIGKILL')
    await waitFor(() => !isAlive(workerPid), { timeoutMs: LIMITE_MS + 3000, stepMs: 5 })
  })
})
