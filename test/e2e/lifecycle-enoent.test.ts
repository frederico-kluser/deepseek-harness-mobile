/**
 * =============================================================================
 * T6.4 -- ENOENT NAO VIRA LOOP: falha deterministica de spawn, com processos
 * REAIS, relogio REAL e o assento real de subprocessos.
 * =============================================================================
 *
 * Um binario ausente (ENOENT) ou sem bit de execucao (EACCES) nao melhora na
 * decima tentativa. O orcamento de reinicios NAO pode ser gasto neles, e um
 * temporizador NAO pode ressuscitar um processo que nunca existiu. Este
 * ficheiro prova as duas coisas contra o sistema operativo real:
 *
 *   - a classificacao chega ao estado TERMINAL sem consumir orcamento
 *     (attempts === 0, exhausted === true);
 *   - NADA volta a acontecer depois: espera-se `2 * maxDelayMs` reais e o
 *     contador de spawns nao mexeu; `start()` e `restart()` sao no-op
 *     (circuito aberto).
 *
 * E PROVA-SE TAMBEM O FACTO MEDIDO (08 §8, facto 520): a sequencia de eventos
 * de um ENOENT no child_process cru e `error -> close`, e `'exit'` NUNCA
 * dispara (exitCode -2, pid undefined). O assento real regista a sequencia
 * exata em `child.events` -- e ela e asserida aqui, porque um supervisor que
 * pendurasse a terminacao em `'exit'` ficaria preso para sempre exatamente
 * no modo de falha mais comum.
 *
 * CRITERIO DE ACEITE GLOBAL: zero processos remanescentes depois da suite
 * (`pgrep -f 'cloudflared|fake-cloudflared|telegram-bot'` vazio no after).
 * Neste ficheiro nunca chega a existir processo nenhum -- o que se assere e
 * que nada foi instanciado.
 */

import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import type { BackoffConfig } from '../../src/config/schema.ts'
import { createProcessSupervisor, type ProcessSupervisor } from '../../src/proc/supervisor.ts'
import {
  isAlive,
  makeBinDir,
  makeRealContext,
  waitFor,
  type RealSubprocessService,
} from '../integration/proc/seat.ts'

const BACKOFF: BackoffConfig = {
  initialDelayMs: 250,
  maxDelayMs: 2000,
  maxAttempts: 3,
  resetAfterMs: 60_000,
}

const POSIX_REASON =
  'ciclo de vida de subprocesso POSIX; o package.json declara os: [linux, darwin].'

const bin = makeBinDir()
const supervisores: ProcessSupervisor[] = []

/**
 * Processos de OUTRAS suites (worktrees irmas a correr em paralelo, o proprio
 * DSH da maquina) vivem ao lado dos nossos: um pgrep de maquina inteira nao e
 * asserivel. O criterio de aceite e por-suite: zero processos do QUE ESTE
 * FICHEIRO criou, verificado com o vocabulario do produto no after abaixo.
 */
const servicos: RealSubprocessService[] = []

after(() => {
  for (const supervisor of supervisores) supervisor.dispose()
  for (const servico of servicos) servico.killAll()
  bin.cleanup()

  // Criterio de aceite (T6.4): zero processos remanescentes da SUITE. Aqui
  // nunca chega a existir processo nenhum (ENOENT/EACCES nem instanciam) --
  // o que se assere e que nenhum filho do assento ficou vivo.
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

/** O binario que existe mas NAO tem bit de execucao (EACCES). */
const SEM_EXECUCAO = join(bin.path, 'sem-bit-de-execucao')
writeFileSync(SEM_EXECUCAO, '#!/bin/sh\necho oi\n', 'utf8')
chmodSync(SEM_EXECUCAO, 0o600)

/** O binario que NAO existe (ENOENT). */
const INEXISTENTE = join(bin.path, 'este-binario-nao-existe')

interface Harness {
  supervisor: ProcessSupervisor
  subprocess: RealSubprocessService
}

function makeHarness(command: string): Harness {
  const { ctx, subprocess } = makeRealContext()
  servicos.push(subprocess)

  const supervisor = createProcessSupervisor(
    ctx,
    {
      name: 'processo-de-teste',
      backoff: BACKOFF,
      buildSpec: (signal) => ({
        argv: [command],
        cwd: bin.path,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 120,
        signal,
      }),
    },
    // Relogio, agendador, kill e plataforma REAIS: nenhum tempo e fingido aqui.
  )
  supervisores.push(supervisor)

  return { supervisor, subprocess }
}

describe('ENOENT nao vira loop', { skip: process.platform === 'win32' ? POSIX_REASON : false }, () => {
  it('binario inexistente: BINARY_NOT_FOUND, zero orcamento consumido, evento terminal `error -> close` sem `exit`', async () => {
    const h = makeHarness(INEXISTENTE)
    h.supervisor.start()

    const child = h.subprocess.lastChild()
    await child.done.catch(() => undefined)
    await waitFor(() => h.supervisor.exhausted)

    // O FACTO MEDIDO (08 §8, facto 520): num ENOENT a sequencia e error ->
    // close e 'exit' NUNCA dispara. Quem pendura em 'exit' fica preso para
    // sempre -- e este assento REAL regista os eventos exatos.
    assert.deepEqual(child.events, ['error', 'close'])
    assert.equal(child.events.includes('exit'), false)

    assert.equal(h.supervisor.failure?.kind, 'BINARY_NOT_FOUND')
    assert.equal(h.supervisor.exhausted, true, 'estado TERMINAL imediato')
    assert.equal(h.supervisor.attempts, 0, 'a causa nao-retryable NAO consome orcamento')
  })

  it('ENOENT nao agenda NENHUM reinicio: o spawn nao se repete em 2*maxDelayMs', async () => {
    const h = makeHarness(INEXISTENTE)
    h.supervisor.start()

    await waitFor(() => h.supervisor.exhausted)
    const spawnsAposTerminal = h.subprocess.calls.length

    // Se houvesse um temporizador vivo a ressuscitar o processo, ele disparava
    // dentro de maxDelayMs. Espera-se o dobro: nada acontece.
    await new Promise<void>((resolve) => setTimeout(resolve, BACKOFF.maxDelayMs * 2))
    assert.equal(h.subprocess.calls.length, spawnsAposTerminal, 'sem novo spawn: ENOENT nao vira loop')
  })

  it('com o circuito aberto, start() e restart() nao instanciam mais nada', async () => {
    const h = makeHarness(INEXISTENTE)
    h.supervisor.start()
    await waitFor(() => h.supervisor.exhausted)
    const spawns = h.subprocess.calls.length

    h.supervisor.start()
    h.supervisor.restart('nao ha o que reiniciar')
    await new Promise<void>((resolve) => setTimeout(resolve, 400))

    assert.equal(h.subprocess.calls.length, spawns, 'o estado terminal e mesmo terminal')
  })

  it('ficheiro sem bit de execucao: BINARY_NOT_EXECUTABLE, sem loop', async () => {
    const h = makeHarness(SEM_EXECUCAO)
    h.supervisor.start()

    await waitFor(() => h.supervisor.exhausted)
    assert.equal(h.supervisor.failure?.kind, 'BINARY_NOT_EXECUTABLE')
    assert.equal(h.supervisor.attempts, 0)
    const spawns = h.subprocess.calls.length

    await new Promise<void>((resolve) => setTimeout(resolve, BACKOFF.maxDelayMs * 2))
    assert.equal(h.subprocess.calls.length, spawns, 'EACCES tambem nao vira loop')
  })

  it('nada do que falhou deixou processo vivo (o proprio critério de aceite)', async () => {
    const h = makeHarness(INEXISTENTE)
    h.supervisor.start()
    await waitFor(() => h.supervisor.exhausted)

    for (const child of h.subprocess.children) {
      if (child.pid > 0) assert.equal(isAlive(child.pid), false)
    }
    assert.equal(h.subprocess.children.length, 1)
  })
})
