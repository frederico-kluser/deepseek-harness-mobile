/**
 * =============================================================================
 * T6.4 -- ORCAMENTO DE REINICIO E CIRCUITO ABERTO, com processos REAIS e
 * relogio REAL.
 * =============================================================================
 *
 * O contador de tentativas e o backoff de `src/proc/retry.ts` sao a peca
 * mais facil de testar com relogio injetado -- e os testes unitarios e de
 * integracao ja o fazem. O que ESTE ficheiro prova e o que so se prova com
 * tempo real e processos reais:
 *
 *   - o orcamento ESGOTA de verdade: tres quedas reais e o estado e TERMINAL
 *     (BUDGET_EXHAUSTED), com o tempo de backoff real no meio;
 *   - o CIRCUITO FICA ABERTO: depois do esgotamento, `start()` e
 *     `restart()` sao no-op e NENHUM temporizador ressuscita o processo --
 *     espera-se 2 * maxDelayMs reais e o contador de spawns nao mexeu;
 *   - o reinicio POR INTENCAO (`restart()`) partilha o MESMO orcamento da
 *     terminacao espontanea: tres `restart()` seguidos esgotam-no, e uma
 *     morte espontanea a meio de um ciclo de reinicios consome a mesma contagem;
 *   - o orcamento ZERA depois de uptime saudavel: tres mortes cedo escalam o
 *     atraso; uma instancia que vive `resetAfterMs` zera o contador e a morte
 *     seguinte volta ao atraso INICIAL (medido em milissegundos reais entre
 *     spawns, com margens generosas).
 *
 * A medicao entre spawns usa `performance.now()` no instante de cada spawn e
 * margens largas -- o que se assere e a RELACAO (o atraso apos o reset e o
 * inicial, o seguinte e maior), nao um valor ao milissegundo.
 *
 * CRITERIO DE ACEITE GLOBAL: zero processos remanescentes da suite (o after
 * dispoe os supervisores, mata a arvore e verifica pelos handles ChildProcess).
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { BackoffConfig } from '../../src/config/schema.ts'
import { createProcessSupervisor, type ProcessSupervisor } from '../../src/proc/supervisor.ts'
import {
  isAlive,
  makeBinDir,
  makeRealContext,
  waitFor,
  writeExecutableShim,
  type RealSubprocessService,
} from '../integration/proc/seat.ts'

const POSIX_REASON =
  'ciclo de vida de subprocesso POSIX; o package.json declara os: [linux, darwin].'

const bin = makeBinDir()
const supervisores: ProcessSupervisor[] = []
const servicos: RealSubprocessService[] = []

after(async () => {
  for (const supervisor of supervisores) supervisor.dispose()
  for (const servico of servicos) servico.killAll()
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  bin.cleanup()

  const vivos = servicos
    .flatMap((servico) => servico.children)
    .map((child) => child.pid)
    .filter((pid) => pid > 0 && isAlive(pid))
  assert.deepEqual(
    vivos,
    [],
    `processos deste ficheiro ainda vivos apos a suite: ${vivos.join(', ') || '(nenhum esperado)'}`,
  )
})

/** Sai com 1 passado `FAKE_LIFETIME_MS` (por omissao, 20 ms): o crash-loop. */
const CRASH = writeExecutableShim(
  bin.path,
  'fake-crash',
  "setTimeout(() => process.exit(1), Number(process.env.FAKE_LIFETIME_MS ?? '20'))\n",
)

/** Vive para sempre: e o processo que o `restart()` derruba por intencao. */
const PERPETUO = writeExecutableShim(bin.path, 'fake-perpetuo', 'setInterval(() => {}, 1000)\n')

const BACKOFF: BackoffConfig = {
  initialDelayMs: 250,
  maxDelayMs: 2000,
  maxAttempts: 3,
  resetAfterMs: 60_000,
}

interface Harness {
  supervisor: ProcessSupervisor
  subprocess: RealSubprocessService
  spawnTimes: number[]
}

function makeHarness(
  command: string,
  options: {
    backoff?: BackoffConfig
    lifetimeFor?: (spawnIndex: number) => string
  } = {},
): Harness {
  const { ctx, subprocess } = makeRealContext()
  servicos.push(subprocess)

  const spawnTimes: number[] = []
  const origSpawn = subprocess.spawn.bind(subprocess)
  subprocess.spawn = (spec) => {
    spawnTimes.push(performance.now())
    return origSpawn(spec)
  }

  const supervisor = createProcessSupervisor(
    ctx,
    {
      name: 'processo-de-teste',
      backoff: options.backoff ?? BACKOFF,
      buildSpec: (signal) => ({
        argv: [command],
        cwd: bin.path,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 120,
        signal,
        ...(options.lifetimeFor === undefined
          ? {}
          : { env: { FAKE_LIFETIME_MS: options.lifetimeFor(subprocess.calls.length) } }),
      }),
    },
    // Relogio, agendador, kill e plataforma REAIS: nenhum tempo e fingido aqui.
  )
  supervisores.push(supervisor)

  return { supervisor, subprocess, spawnTimes }
}

describe('orcamento de reinicio e circuito aberto', { skip: process.platform === 'win32' ? POSIX_REASON : false }, () => {
  it('o crash-loop esgota o orcamento; o circuito fica ABERTO e nada o ressuscita', async () => {
    const h = makeHarness(CRASH)
    h.supervisor.start()

    // O orcamento esgota quando as tentativas EXCEDEM maxAttempts: com
    // maxAttempts = 3 sao 4 falhas (a inicial + 3 reinicios) ate BUDGET_EXHAUSTED.
    await waitFor(() => h.supervisor.exhausted, { timeoutMs: 15_000 })
    assert.equal(h.supervisor.failure?.kind, 'BUDGET_EXHAUSTED')
    assert.equal(h.supervisor.attempts, 4)
    assert.equal(h.subprocess.calls.length, 4, 'a inicial mais tres reinicios')
    const spawnsNoTerminal = h.subprocess.calls.length

    // Circuito aberto: espera-se o dobro do atraso maximo real e o contador de
    // spawns nao pode mexer -- nenhum temporizador ficou vivo a ressuscitar.
    await new Promise<void>((resolve) => setTimeout(resolve, BACKOFF.maxDelayMs * 2))
    assert.equal(h.subprocess.calls.length, spawnsNoTerminal, 'sem novo spawn apos esgotado')

    h.supervisor.start()
    h.supervisor.restart('nao ha o que reiniciar')
    await new Promise<void>((resolve) => setTimeout(resolve, 400))
    assert.equal(h.subprocess.calls.length, spawnsNoTerminal, 'o estado terminal e mesmo terminal')
  })

  it('o reinicio POR INTENCAO partilha o orcamento e esgota-o como uma queda', async () => {
    const h = makeHarness(PERPETUO)
    h.supervisor.start()

    const primeiro = h.subprocess.lastChild()
    await waitFor(() => primeiro.pid > 0 && isAlive(primeiro.pid))

    // maxAttempts = 3: esgota-se com QUATRO concluir (o esgotamento acontece
    // quando as tentativas EXCEDEM o maximo). Cada restart derruba a instancia
    // corrente e aguarda-se o reinicio agendado (250-375 ms reais depois).
    for (let vez = 1; vez <= 4; vez += 1) {
      const corrente = h.subprocess.lastChild()
      h.supervisor.restart(`intencao ${String(vez)}`)
      await waitFor(() => !isAlive(corrente.pid), { timeoutMs: 8000 })
      assert.equal(
        h.supervisor.attempts,
        vez,
        `a ${String(vez)}a intencao consome a ${String(vez)}a tentativa`,
      )
      if (vez < 4) {
        await waitFor(() => h.subprocess.calls.length >= vez + 1, { timeoutMs: 8000 })
      }
    }

    await waitFor(() => h.supervisor.exhausted, { timeoutMs: 10_000 })
    assert.equal(h.supervisor.failure?.kind, 'BUDGET_EXHAUSTED')
    assert.equal(h.supervisor.attempts, 4)
    const spawns = h.subprocess.calls.length
    await new Promise<void>((resolve) => setTimeout(resolve, 1500))
    assert.equal(h.subprocess.calls.length, spawns, 'esgotado: nada mais sobe')
  })

  it('morte ESPONTANEA a meio de um ciclo de reinicios consome a MESMA contagem', async () => {
    // maxAttempts = 2: uma intencao + duas quedas espontaneas = 3 tentativas,
    // e 3 > 2 esgota o orcamento UNICO partilhado pelos dois gatilhos.
    const h = makeHarness(PERPETUO, { backoff: { ...BACKOFF, maxAttempts: 2 } })
    h.supervisor.start()

    const primeiro = h.subprocess.lastChild()
    await waitFor(() => primeiro.pid > 0 && isAlive(primeiro.pid))

    // Uma intencao (restart) e depois mortes ESPONTANEAS (SIGKILL de fora).
    h.supervisor.restart('intencao')
    await waitFor(() => h.subprocess.calls.length >= 2, { timeoutMs: 8000 })

    const segundo = h.subprocess.lastChild()
    await waitFor(() => segundo.pid > 0 && isAlive(segundo.pid))
    process.kill(segundo.pid, 'SIGKILL') // o equivalente a um crash real

    await waitFor(() => h.subprocess.calls.length >= 3, { timeoutMs: 8000 })
    assert.equal(h.supervisor.attempts, 2, 'intencao + queda espontanea = duas tentativas, um so orcamento')

    const terceiro = h.subprocess.lastChild()
    await waitFor(() => terceiro.pid > 0 && isAlive(terceiro.pid))
    process.kill(terceiro.pid, 'SIGKILL')

    await waitFor(() => h.supervisor.exhausted, { timeoutMs: 10_000 })
    assert.equal(h.supervisor.attempts, 3)
    assert.equal(h.supervisor.failure?.kind, 'BUDGET_EXHAUSTED')
  })

  it('uptime saudavel (>= resetAfterMs) ZERA o orcamento: a morte seguinte volta ao atraso inicial', async () => {
    // Vidas: 30 ms (acumula tentativa 1), 30 ms (acumula tentativa 2),
    // 1500 ms (>= resetAfterMs 400: ZERA), 30 ms (recomeca a contar).
    const h = makeHarness(CRASH, {
      backoff: { initialDelayMs: 250, maxDelayMs: 2000, maxAttempts: 6, resetAfterMs: 400 },
      lifetimeFor: (spawnIndex) => (spawnIndex === 2 ? '1500' : '30'),
    })
    h.supervisor.start()

    // Cinco spawns: os quatro acima mais o reinicio apos a quarta morte.
    await waitFor(() => h.subprocess.calls.length >= 5, { timeoutMs: 20_000 })

    // ATRASOS reais entre spawns, com a vida conhecida de cada instancia
    // subtraida (30 ms para as curtas, 1500 ms para a que zera o orcamento):
    //   d1: 250-375 (tentativa 1)     d2: 500-750 (tentativa 2)
    //   d3: 250-375 (RESET aconteceu) d4: 500-750 (a contar de novo)
    // Com noUncheckedIndexedAccess os indices sao number | undefined; os
    // cinco spawns ja foram esperados acima, logo 0..4 existem de certeza e o
    // cast e seguranca declarada, nao suposicao.
    const i1 = (h.spawnTimes[1] as number) - (h.spawnTimes[0] as number)
    const i2 = (h.spawnTimes[2] as number) - (h.spawnTimes[1] as number)
    const i3 = (h.spawnTimes[3] as number) - (h.spawnTimes[2] as number)
    const i4 = (h.spawnTimes[4] as number) - (h.spawnTimes[3] as number)
    const d1 = i1 - 30
    const d2 = i2 - 30
    const d3 = i3 - 1500
    const d4 = i4 - 30

    assert.ok(d1 >= 200 && d1 <= 700, `d1 (primeira) fora de [200,700]: ${String(d1)}`)
    assert.ok(d2 > d1, `d2 tem de escalar sobre d1 (d1=${String(d1)}, d2=${String(d2)})`)
    assert.ok(
      d3 >= 200 && d3 <= 700,
      `d3 apos o uptime saudavel tem de voltar ao atraso INICIAL; medido ${String(d3)} ms ` +
        '(sem o reset, seria a tentativa 3: 1000-1500 ms)',
    )
    assert.ok(d4 > d3, `d4 tem de recomecar a escalar (d3=${String(d3)}, d4=${String(d4)})`)

    h.supervisor.dispose()
  })
})
