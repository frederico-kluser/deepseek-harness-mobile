/**
 * ORFAOS: com o `state.json` a registar um `cloudflared` VIVO de uma execucao
 * anterior, o boot mata-o ANTES de qualquer outra inicializacao
 * (`02-SEGURANCA.md` 9, criterio de aceite 10.2).
 *
 * PORQUE E UM TESTE DE INTEGRACAO E NAO UNITARIO: a afirmacao e sobre o SISTEMA
 * OPERATIVO. "O supervisor chamou `kill`" nao e a mesma coisa que "o processo
 * deixou de existir", e a diferenca e um tunel publico vivo sem portao por tras.
 * Aqui o processo e real, o `state.json` e um ficheiro de verdade, e a
 * verificacao final e `kill(pid, 0)` a lancar ESRCH.
 *
 * O processo orfao e um dublê com o nome `fake-cloudflared` — nunca o
 * `cloudflared` verdadeiro (D10).
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { createStateStore } from '../../../src/state/store.ts'
import {
  defaultOrphanSweepDeps,
  readTunnelProcess,
  recordTunnelProcess,
  recoverTunnelAtBoot,
  sweepOrphanTunnel,
} from '../../../src/tunnel/pidfile.ts'
import type { TtlEffects } from '../../../src/tunnel/ttl.ts'
import { makeTempStateDir, type TempStateDir } from '../../support/state-dir.ts'
import { isAlive, makeBinDir, signalGroup, waitFor } from '../proc/seat.ts'

const bin = makeBinDir()
const dirs: TempStateDir[] = []
const orfaos: number[] = []

after(() => {
  for (const pid of orfaos) signalGroup(pid, 'SIGKILL')
  for (const dir of dirs) dir.cleanup()
  bin.cleanup()
})

/**
 * Dublê do orfao: um `sh` de duas linhas, NAO o `cloudflared` verdadeiro (D10).
 *
 * O FICHEIRO CHAMA-SE `cloudflared` DE PROPOSITO. A varredura identifica o
 * processo pelo NOME antes de o matar (mitigacao de reutilizacao de pid), e um
 * dublê chamado outra coisa nao exercitaria esse caminho — passaria pelo ramo
 * "identificacao indisponivel" e o teste provaria menos do que parece.
 *
 * Sem `exec`: assim `argv` fica `['/bin/sh', '<dir>/cloudflared']` e e essa a
 * linha que `/proc/<pid>/cmdline` devolve.
 *
 * `detached: true` E O PONTO do cenario: e precisamente o que faz o orfao
 * sobreviver quando o dono morre, e e por isso que o pidfile existe.
 */
const ORFAO = join(bin.path, 'cloudflared')
writeFileSync(ORFAO, "#!/bin/sh\nprintf 'PRONTO\\n'\nwhile true; do sleep 1; done\n", 'utf8')
chmodSync(ORFAO, 0o700)

async function subirOrfao(): Promise<number> {
  const child = spawn(ORFAO, [], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const pid = await new Promise<number>((resolve, reject) => {
    child.stdout.once('data', () => resolve(child.pid ?? -1))
    child.once('error', reject)
  })
  // O pai deste teste nao vai esperar por ele: o objectivo e ficar um processo
  // vivo que ninguem supervisiona, que e o estado real de um orfao.
  child.unref()
  orfaos.push(pid)
  return pid
}

function novoEstado() {
  const dir = makeTempStateDir()
  dirs.push(dir)
  const handle = createStateStore({ paths: { dir: dir.path, file: dir.statePath } })
  return handle.store
}

const logSilencioso = { info: (): void => {}, warn: (): void => {}, error: (): void => {} }

/**
 * Dependencias REAIS da varredura, com o `binaryPath` configurado — que e o que
 * T3.3 vai ligar em producao.
 *
 * ELE E OBRIGATORIO NESTE CENARIO, e a razao e instrutiva: o dublê e um script
 * com `#!`, portanto o nucleo poe `/bin/sh` em `argv[0]` e o caminho do script em
 * `argv[1]`. A regra generica olha para o PROGRAMA e nao reconheceria isto —
 * corretamente, porque o programa e o `sh`. E o `expectedCommand` que fecha o
 * caso, e o teste passa a exercitar exatamente o ramo que existe para ele.
 */
function sweepDepsReais(store: ReturnType<typeof novoEstado>) {
  return defaultOrphanSweepDeps(store, logSilencioso, ORFAO)
}

describe('varredura de orfao no boot, com processo REAL', () => {
  it('o boot derruba o `cloudflared` orfao registado e limpa o registo', async () => {
    const pid = await subirOrfao()
    const store = novoEstado()
    recordTunnelProcess(store, { pid, startedAt: Date.now(), mode: 'quick' })

    assert.equal(isAlive(pid), true, 'o orfao tem de estar vivo antes do boot')

    const result = sweepOrphanTunnel(sweepDepsReais(store))

    assert.equal(result.outcome, 'killed')
    // A VERIFICACAO E DO SISTEMA OPERATIVO, nao do nosso contador.
    assert.equal(await waitFor(() => !isAlive(pid), { timeoutMs: 4000 }), true)
    assert.equal(readTunnelProcess(store), undefined)
  })

  it('a identificacao por `/proc/<pid>/cmdline` reconhece o processo antes de o matar', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('sem /proc nesta plataforma')
      return
    }
    const pid = await subirOrfao()
    const store = novoEstado()
    recordTunnelProcess(store, { pid, startedAt: Date.now(), mode: 'quick' })

    const deps = sweepDepsReais(store)
    const cmdline = deps.identify(pid)

    // `/proc/<pid>/cmdline` traz o argv separado por NUL; a identificacao le-o e
    // reconhece o programa ANTES de entregar sinal nenhum.
    assert.equal(typeof cmdline, 'string')
    assert.equal((cmdline ?? '').includes('cloudflared'), true)

    // F5, contra o sistema operativo: a hora de arranque real esta a segundos do
    // instante em que este teste gravou o registo.
    const arranque = deps.startedAtOf(pid)
    assert.notEqual(arranque, null)
    assert.ok(Math.abs((arranque ?? 0) - Date.now()) < 60_000)

    assert.equal(sweepOrphanTunnel(deps).outcome, 'killed')
    assert.equal(await waitFor(() => !isAlive(pid), { timeoutMs: 4000 }), true)
  })

  it('um pid REUTILIZADO por outro programa NAO e morto', async () => {
    const store = novoEstado()
    // O proprio processo de teste faz de "programa que herdou o pid": ele existe,
    // esta vivo, e a sua linha de comando nao e a de um cloudflared.
    const outro = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = outro.pid ?? -1
    orfaos.push(pid)
    outro.unref()
    await waitFor(() => isAlive(pid))

    recordTunnelProcess(store, { pid, startedAt: Date.now(), mode: 'quick' })
    const result = sweepOrphanTunnel(sweepDepsReais(store))

    assert.equal(result.outcome, 'foreign')
    assert.equal(isAlive(pid), true, 'matar seria derrubar um processo do utilizador')
    assert.equal(readTunnelProcess(store), undefined, 'o registo obsoleto sai na mesma')

    signalGroup(pid, 'SIGKILL')
  })
})

describe('recuperacao completa no boot: orfao derrubado E sessoes invalidadas', () => {
  it('prazo ja vencido enquanto a maquina estava desligada: os quatro efeitos, na ordem', async () => {
    const pid = await subirOrfao()
    const store = novoEstado()
    // Um `startedAt` de ha muito tempo: e o unico vestigio de que houve um tunel,
    // porque um `setTimeout` morre com o event loop e um reboot leva-o consigo.
    const startedAt = Date.now() - 10 * 60 * 60 * 1000
    recordTunnelProcess(store, { pid, startedAt, mode: 'quick' })

    const ordem: string[] = []
    const effects: TtlEffects = {
      stopTunnel: (): void => void ordem.push('stopTunnel'),
      revokeAllSessions: (): void => void ordem.push('revokeAllSessions'),
      audit: (): void => void ordem.push('audit'),
      notifyOwner: (): void => void ordem.push('notifyOwner'),
    }

    const result = recoverTunnelAtBoot({
      sweep: {
        ...sweepDepsReais(store),
        /*
         * A maquina esteve DESLIGADA dez horas. Nao ha como fazer um processo
         * arrancar no passado, entao o instante de arranque e injetado — e tem de
         * ser coerente com o cenario, porque a varredura agora recusa derrubar um
         * pid ocupado por um processo que arrancou DEPOIS do registo (F5). Injetar
         * o valor coerente e o que mantem o teste a medir o que diz medir; deixar
         * o valor real (agora) mediria o caso oposto.
         */
        startedAtOf: () => startedAt,
      },
      ttlMinutes: 60,
      now: () => Date.now(),
      effects,
      log: logSilencioso,
    })

    assert.equal(result.sweep.outcome, 'killed')
    assert.equal(result.ttl, 'expirado')
    assert.deepEqual(ordem, ['stopTunnel', 'revokeAllSessions', 'audit', 'notifyOwner'])
    // NAO BASTA MATAR O PROCESSO: os cookies emitidos pela janela anterior
    // sobreviveriam para a janela seguinte se `revokeAllSessions` nao corresse.
    assert.equal(await waitFor(() => !isAlive(pid), { timeoutMs: 4000 }), true)
  })

  it('orfao ainda dentro do prazo tambem cai, e as sessoes tambem', async () => {
    const pid = await subirOrfao()
    const store = novoEstado()
    recordTunnelProcess(store, { pid, startedAt: Date.now(), mode: 'quick' })

    const ordem: string[] = []
    const result = recoverTunnelAtBoot({
      sweep: sweepDepsReais(store),
      ttlMinutes: 480,
      now: () => Date.now(),
      effects: {
        stopTunnel: (): void => void ordem.push('stopTunnel'),
        revokeAllSessions: (): void => void ordem.push('revokeAllSessions'),
        audit: (): void => void ordem.push('audit'),
        notifyOwner: (): void => void ordem.push('notifyOwner'),
      },
      log: logSilencioso,
    })

    assert.equal(result.ttl, 'dentro-do-prazo')
    // Ele estava vivo SEM o portao por tras: o plugin que o instala so agora
    // esta a arrancar. O aviso e outro porque o motivo e outro.
    assert.deepEqual(ordem, ['revokeAllSessions', 'audit', 'notifyOwner'])
    assert.equal(await waitFor(() => !isAlive(pid), { timeoutMs: 4000 }), true)
  })
})
