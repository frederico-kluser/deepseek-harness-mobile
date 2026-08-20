/**
 * `src/tunnel/pidfile.ts` -- registo do processo e varredura de orfao no boot.
 *
 * UM TUNEL ORFAO E UMA URL PUBLICA VIVA SEM GATE POR TRAS. O `cloudflared` sobe
 * `detached: true`, que e precisamente o que o faz sobreviver quando o DSH morre
 * de forma abrupta, e o dead-man's switch por pipe herdado NAO cobre o caso de a
 * maquina reiniciar.
 *
 * O `StateStore` e REAL (diretorio temporario descartavel): o que se quer provar
 * e que o registo sobrevive a uma volta completa pelo disco, e isso um duble em
 * memoria nao prova.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { StateStore } from '../../../src/contracts/state.ts'
import { createStateStore } from '../../../src/state/store.ts'
import {
  clearTunnelProcess,
  looksLikeCloudflared,
  readProcessCmdline,
  readTunnelProcess,
  recordTunnelProcess,
  recoverTunnelAtBoot,
  sweepOrphanTunnel,
  type OrphanSweepDeps,
} from '../../../src/tunnel/pidfile.ts'
import type { TtlEffects } from '../../../src/tunnel/ttl.ts'
import { makeTempStateDir, type TempStateDir } from '../../support/state-dir.ts'

const dirs: TempStateDir[] = []

after(() => {
  for (const dir of dirs) dir.cleanup()
})

function freshStore(): StateStore {
  const dir = makeTempStateDir()
  dirs.push(dir)
  return createStateStore({ paths: { dir: dir.path, file: dir.statePath } }).store
}

interface SweepHarness {
  deps: OrphanSweepDeps
  kills: Array<[number, string]>
  logs: string[]
}

function makeSweepDeps(
  store: StateStore,
  options: { alive?: boolean; cmdline?: string | null; startedAt?: number | null } = {},
): SweepHarness {
  const kills: Array<[number, string]> = []
  const logs: string[] = []

  return {
    kills,
    logs,
    deps: {
      store,
      platform: 'linux',
      kill: (pid: number, signal: NodeJS.Signals): void => {
        kills.push([pid, signal])
      },
      isAlive: (): boolean => options.alive ?? true,
      identify: (): string | null =>
        options.cmdline === undefined ? '/usr/bin/cloudflared tunnel --url http://127.0.0.1:1' : options.cmdline,
      startedAtOf: (): number | null => options.startedAt ?? null,
      log: {
        info: (message: string): void => {
          logs.push(message)
        },
        warn: (message: string): void => {
          logs.push(message)
        },
      },
    },
  }
}

describe('o que se persiste e `pid`/`startedAt`, NUNCA a URL', () => {
  it('sobrevive a uma volta completa pelo disco', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1_700_000, mode: 'quick' })

    assert.deepEqual(readTunnelProcess(store), { pid: 4242, startedAt: 1_700_000, mode: 'quick' })
  })

  it('o esquema persistido nao tem sequer campo para a URL', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 7, startedAt: 1, mode: 'named' })

    // A URL do quick tunnel e efemera e muda a cada arranque; um valor velho
    // entrega um link morto com confianca.
    const persisted = store.read().tunnel as unknown as Record<string, unknown>
    assert.deepEqual(Object.keys(persisted).toSorted(), ['mode', 'pid', 'startedAt'])
  })

  it('a paragem limpa APAGA o registo -- so assim o boot seguinte nao varre um pid alheio', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1, mode: 'quick' })
    clearTunnelProcess(store)

    assert.equal(readTunnelProcess(store), undefined)
  })
})

describe('identificacao do processo antes de matar (risco de reutilizacao de pid)', () => {
  it('reconhece o cloudflared por caminho, por nome nu e em maiusculas', () => {
    assert.equal(looksLikeCloudflared('/usr/bin/cloudflared tunnel --url x'), true)
    assert.equal(looksLikeCloudflared('cloudflared tunnel'), true)
    assert.equal(looksLikeCloudflared('/home/x/.local/bin/CloudflareD run'), true)
  })

  it('NAO confunde com outro programa que tenha o nome no meio de um argumento', () => {
    // Se a regra fosse "contem a palavra", a varredura matava o editor do
    // utilizador por ele ter o ficheiro de configuracao aberto.
    assert.equal(looksLikeCloudflared('/usr/bin/vim /etc/cloudflared.yml'), false)
    assert.equal(looksLikeCloudflared('node servidor.js'), false)
    assert.equal(looksLikeCloudflared(''), false)
  })

  it('um binario com nome VERSIONADO e reconhecido pelo `binaryPath` configurado', () => {
    const versionado = '/opt/cloudflared/bin/cloudflared-2026.7.3'
    // Sem esta regra o proprio tunel seria classificado como "pid alheio" e a
    // varredura deixaria VIVA a URL publica que ela existe para derrubar: um
    // controlo de seguranca a falhar para ABERTO por causa do nome de um ficheiro.
    assert.equal(looksLikeCloudflared(`${versionado} tunnel --url x`), false, 'a regra generica nao o apanha')
    assert.equal(looksLikeCloudflared(`${versionado} tunnel --url x`, versionado), true)
  })

  it('o `expectedCommand` e ancorado no PROGRAMA, nunca "contem o texto"', () => {
    /*
     * A versao anterior fazia `cmdline.includes(expected)` e era MAIS FRACA do
     * que a regra generica que veio reforcar. Cada linha abaixo devolvia `true`
     * e mandava `SIGTERM` + `SIGKILL` ao GRUPO, sem graca, de um processo do
     * utilizador. O teste que aqui estava so experimentava `/usr/bin/psql`
     * contra `/opt/bin/cloudflared-x` — uma asercao que nao podia falhar para o
     * risco que anunciava.
     */
    // `binaryPath` e OPCIONAL, logo um nome nu e um valor legitimo.
    assert.equal(looksLikeCloudflared('vim /etc/cloudflared.yml', 'cloudflared'), false)
    assert.equal(looksLikeCloudflared('/usr/bin/vim /etc/cloudflared.yml', 'cloudflared'), false)
    // O instalador do utilizador MENCIONA o caminho exato do binario, duas vezes.
    assert.equal(
      looksLikeCloudflared('cp /tmp/dl/cloudflared /usr/bin/cloudflared', '/usr/bin/cloudflared'),
      false,
    )
    assert.equal(
      looksLikeCloudflared('tar -xzf cloudflared.tgz -C /usr/bin/cloudflared', '/usr/bin/cloudflared'),
      false,
    )
    assert.equal(looksLikeCloudflared('/usr/bin/psql -h localhost', '/opt/bin/cloudflared-x'), false)
    assert.equal(looksLikeCloudflared('/usr/bin/psql -h localhost', '   '), false)
  })

  it('mas um `binaryPath` que seja um script com `#!` continua a ser reconhecido', () => {
    // O nucleo poe o INTERPRETADOR em `argv[0]` e o script em `argv[1]`. Sem este
    // caso, a varredura recusava-se a derrubar o NOSSO tunel nesse arranjo — de
    // novo uma falha para ABERTO. Em `argv[1]` a comparacao e por igualdade
    // EXATA: la ja nao esta o programa, esta um dado.
    const script = '/opt/guard/bin/cloudflared-wrapper'
    assert.equal(looksLikeCloudflared(`/bin/sh ${script} tunnel --url x`, script), true)
    assert.equal(looksLikeCloudflared(`/bin/sh /outro/${'cloudflared-wrapper'} tunnel`, script), false)
  })

  it('le a linha de comando do proprio processo por /proc (ou devolve null onde nao ha)', () => {
    const cmdline = readProcessCmdline(process.pid)
    if (process.platform === 'linux') {
      assert.equal(typeof cmdline, 'string')
      assert.equal((cmdline ?? '').includes('node'), true)
    }
    // Um pid que nao existe nunca da excepcao: da "nao da para identificar".
    assert.equal(readProcessCmdline(2 ** 30), null)
  })
})

describe('varredura de orfao no boot', () => {
  it('sem registo nao faz nada', () => {
    const store = freshStore()
    const harness = makeSweepDeps(store)

    assert.deepEqual(sweepOrphanTunnel(harness.deps), { outcome: 'none', record: undefined })
    assert.deepEqual(harness.kills, [])
  })

  it('registo de um processo que ja nao existe: limpa e NAO mata', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1, mode: 'quick' })
    const harness = makeSweepDeps(store, { alive: false })

    assert.equal(sweepOrphanTunnel(harness.deps).outcome, 'gone')
    assert.deepEqual(harness.kills, [])
    assert.equal(readTunnelProcess(store), undefined)
  })

  it('pid VIVO e identificado como cloudflared: SIGTERM ao grupo e depois SIGKILL ao grupo', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1, mode: 'quick' })
    const harness = makeSweepDeps(store)

    assert.equal(sweepOrphanTunnel(harness.deps).outcome, 'killed')
    // O sinal NEGATIVO alveja o GRUPO: e o que apanha os netos. Ver a divergencia
    // documentada em `src/proc/tree-kill.ts`.
    assert.deepEqual(harness.kills, [
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ])
    assert.equal(readTunnelProcess(store), undefined)
  })

  it('binario VERSIONADO: identificado pelo `binaryPath` configurado, e derrubado', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1, mode: 'quick' })
    const versionado = '/opt/cloudflared/bin/cloudflared-2026.7.3'
    const harness = makeSweepDeps(store, { cmdline: `${versionado} tunnel --url http://127.0.0.1:1` })
    const deps: OrphanSweepDeps = { ...harness.deps, expectedCommand: versionado }

    assert.equal(sweepOrphanTunnel(deps).outcome, 'killed')
    assert.equal(harness.kills.length, 2)
  })

  it('pid REUTILIZADO por outro programa: NAO mata, e limpa o registo', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1, mode: 'quick' })
    const harness = makeSweepDeps(store, { cmdline: '/usr/bin/psql -h localhost' })

    assert.equal(sweepOrphanTunnel(harness.deps).outcome, 'foreign')
    assert.deepEqual(harness.kills, [], 'matar seria derrubar um processo do utilizador')
    assert.equal(readTunnelProcess(store), undefined)
  })

  it('F5: MESMO programa, OUTRA instancia (arrancou depois do registo): NAO mata', () => {
    const store = freshStore()
    // O registo diz que o nosso tunel abriu no instante 1000.
    recordTunnelProcess(store, { pid: 4242, startedAt: 1000, mode: 'quick' })
    // O pid esta agora ocupado por um `cloudflared` LEGITIMO do utilizador, com o
    // tunel de producao dele por tras, arrancado muito depois.
    const harness = makeSweepDeps(store, {
      cmdline: '/usr/bin/cloudflared tunnel run o-tunel-de-producao-do-utilizador',
      startedAt: 1000 + 3_600_000,
    })

    const result = sweepOrphanTunnel(harness.deps)

    // A identificacao por `cmdline` responde "e outro PROGRAMA?" e aqui diria que
    // nao. A hora de arranque responde "e outra INSTANCIA?" — e e ela que salva o
    // tunel do utilizador de um SIGKILL ao grupo, sem graca nenhuma.
    assert.equal(result.outcome, 'foreign')
    assert.deepEqual(harness.kills, [])
    assert.equal(readTunnelProcess(store), undefined)
  })

  it('F5: arranque DENTRO da folga e o nosso proprio processo, e e derrubado', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1000, mode: 'quick' })
    // O registo e escrito milissegundos DEPOIS de o processo existir, portanto o
    // arranque real e sempre um pouco ANTERIOR ao valor gravado.
    const harness = makeSweepDeps(store, { startedAt: 1000 - 40 })

    assert.equal(sweepOrphanTunnel(harness.deps).outcome, 'killed')
    assert.equal(harness.kills.length, 2)
  })

  it('F5: hora de arranque indisponivel nao impede a derrubada (so acrescenta recusas)', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1000, mode: 'quick' })
    const harness = makeSweepDeps(store, { startedAt: null })

    assert.equal(sweepOrphanTunnel(harness.deps).outcome, 'killed')
  })

  it('identificacao INDISPONIVEL: mata na mesma, e o compromisso e deliberado', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1, mode: 'quick' })
    const harness = makeSweepDeps(store, { cmdline: null })

    // Do outro lado da balanca esta uma URL publica sem autenticacao a servir o
    // Harness. "Na duvida, deixa aberto" nao e uma opcao neste plugin.
    assert.equal(sweepOrphanTunnel(harness.deps).outcome, 'killed')
    assert.equal(harness.kills.length, 2)
  })

  it('NUNCA mata o proprio host nem o pid 1', () => {
    // `pid <= 0` nem sequer chega aqui: o esquema do `state.json` (T2.5) recusa
    // persistir um `tunnel.pid` que nao seja inteiro >= 1, e foi medido a tentar.
    // A guarda deste modulo continua a existir como defesa em profundidade, para
    // o dia em que o esquema afrouxar ou o registo vier de outra fonte.
    for (const pid of [process.pid, 1]) {
      const store = freshStore()
      recordTunnelProcess(store, { pid, startedAt: 1, mode: 'quick' })
      const harness = makeSweepDeps(store)

      const result = sweepOrphanTunnel(harness.deps)
      assert.equal(result.outcome, 'foreign', `pid ${String(pid)}`)
      // Matar o GRUPO do proprio host derrubaria o DSH inteiro.
      assert.deepEqual(harness.kills, [], `pid ${String(pid)}`)
    }
  })

  it('em win32 nao ha grupo POSIX: nao se chama `process.kill(-pid)`', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1, mode: 'quick' })
    const harness = makeSweepDeps(store)
    const deps: OrphanSweepDeps = { ...harness.deps, platform: 'win32' }

    assert.equal(sweepOrphanTunnel(deps).outcome, 'killed')
    assert.deepEqual(harness.kills, [])
  })
})

describe('recuperacao no boot: varredura MAIS o veredito do TTL persistido', () => {
  function makeEffects(): { effects: TtlEffects; order: string[] } {
    const order: string[] = []
    return {
      order,
      effects: {
        stopTunnel: (): void => {
          order.push('stopTunnel')
        },
        revokeAllSessions: (): void => {
          order.push('revokeAllSessions')
        },
        audit: (): void => {
          order.push('audit')
        },
        notifyOwner: (): void => {
          order.push('notifyOwner')
        },
      },
    }
  }

  const log = { info: (): void => {}, error: (): void => {} }

  it('orfao VIVO cujo prazo JA PASSOU: derruba, invalida sessoes, audita e avisa', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1_000, mode: 'quick' })
    const harness = makeSweepDeps(store)
    const { effects, order } = makeEffects()

    const result = recoverTunnelAtBoot({
      sweep: harness.deps,
      ttlMinutes: 60,
      now: () => 1_000 + 3_600_001,
      effects,
      log,
    })

    assert.equal(result.sweep.outcome, 'killed')
    assert.equal(result.ttl, 'expirado')
    assert.deepEqual(order, ['stopTunnel', 'revokeAllSessions', 'audit', 'notifyOwner'])
    assert.equal(harness.kills.length, 2, 'o processo foi mesmo derrubado')
  })

  it('orfao VIVO ainda dentro do prazo: derruba na mesma E invalida as sessoes', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1_000, mode: 'quick' })
    const harness = makeSweepDeps(store)
    const { effects, order } = makeEffects()

    const result = recoverTunnelAtBoot({
      sweep: harness.deps,
      ttlMinutes: 60,
      now: () => 1_000 + 60_000,
      effects,
      log,
    })

    assert.equal(result.sweep.outcome, 'killed')
    assert.equal(result.ttl, 'dentro-do-prazo')
    // Nao basta matar o processo: os cookies emitidos pela janela anterior
    // sobreviveriam para a janela seguinte.
    assert.deepEqual(order, ['revokeAllSessions', 'audit', 'notifyOwner'])
  })

  it('sem registo nenhum: arranque limpo, sem efeito nenhum', () => {
    const store = freshStore()
    const harness = makeSweepDeps(store)
    const { effects, order } = makeEffects()

    const result = recoverTunnelAtBoot({ sweep: harness.deps, ttlMinutes: 60, now: () => 0, effects, log })

    assert.equal(result.ttl, 'sem-registo')
    assert.deepEqual(order, [])
  })

  it('registo obsoleto (processo ja morto) dentro do prazo: nada a invalidar', () => {
    const store = freshStore()
    recordTunnelProcess(store, { pid: 4242, startedAt: 1_000, mode: 'quick' })
    const harness = makeSweepDeps(store, { alive: false })
    const { effects, order } = makeEffects()

    const result = recoverTunnelAtBoot({
      sweep: harness.deps,
      ttlMinutes: 60,
      now: () => 1_000 + 60_000,
      effects,
      log,
    })

    assert.equal(result.sweep.outcome, 'gone')
    assert.deepEqual(order, [])
  })
})
