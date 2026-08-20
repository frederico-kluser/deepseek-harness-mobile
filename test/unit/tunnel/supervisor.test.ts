/**
 * `src/tunnel/supervisor.ts` -- a composicao: probe ANTES do spawn, pidfile, TTL.
 *
 * A PERGUNTA FALSIFICAVEL 6 DE T3.1 E LITERALMENTE ESTA: *"o probe roda antes ou
 * depois do `spawn`? Force o gate a ficar desarmado e prove que o `spawn` NUNCA
 * acontece."* E o que os casos TUN-020..TUN-025 aqui fazem, e a asercao e sempre
 * a mesma: `ctx.subprocess.calls.length === 0`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import type { StateStore } from '../../../src/contracts/state.ts'
import type {
  ProbeId,
  TunnelConfig,
  TunnelDiscovery,
  TunnelDiscoveryInput,
  TunnelReadiness,
} from '../../../src/contracts/tunnel.ts'
import {
  createTunnelOriginRegistry,
  type TunnelOriginRegistry,
} from '../../../src/http/session-auth.ts'
import { createStateStore } from '../../../src/state/store.ts'
import { readTunnelProcess } from '../../../src/tunnel/pidfile.ts'
import { decideOnResume, TunnelTtlError } from '../../../src/tunnel/ttl.ts'
import type { ProbeRequest, ProbeTransport, ProbeTransportResult } from '../../../src/tunnel/probe.ts'
import { createTunnelSupervisor, type TunnelSupervisor } from '../../../src/tunnel/supervisor.ts'
import { FakeScheduler, makeSupervisorDeps, type ScheduledTask } from '../../support/child-double.ts'
import { FakeClock } from '../../support/clock.ts'
import { FakeContext } from '../../support/ctx-double.ts'
import { flush } from '../../support/fixtures.ts'
import { makeTempStateDir, type TempStateDir } from '../../support/state-dir.ts'

const URL_DO_DUBLE = 'https://exemplo-duble-do-tunel.trycloudflare.com'

const cleanups: Array<() => void> = []
after(() => {
  for (const cleanup of cleanups) cleanup()
})

function freshStore(): StateStore {
  const dir: TempStateDir = makeTempStateDir()
  cleanups.push(() => dir.cleanup())
  return createStateStore({ paths: { dir: dir.path, file: dir.statePath } }).store
}

/** Servidor de origem REAL numa porta EFEMERA: nunca 3080, nunca porta fixa. */
async function ownOrigin(): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  cleanups.push(() => server.close())
  return server
}

interface Harness {
  supervisor: TunnelSupervisor
  /** O registo REAL de T3.3 -- e ele que o gate consulta em L2.5. */
  tunnelOrigin: TunnelOriginRegistry
  /** Tudo o que foi publicado, por ordem. `undefined` = retirada da allowlist. */
  publicadas: Array<string | undefined>
  /** Uma entrada por chamada a `discover()`. Ver o teste de uma-por-spawn. */
  descobertas: TunnelDiscoveryInput[]
  ctx: FakeContext
  scheduler: FakeScheduler
  clock: FakeClock
  store: StateStore
  audited: AuditEvent[]
  notices: string[]
  revocations: number[]
  kills: Array<[number, string]>
  probeCalls: ProbeRequest[]
}

async function makeHarness(
  options: {
    probeResults?: Partial<Record<ProbeId, ProbeTransportResult>>
    config?: Partial<TunnelConfig>
    auditThrows?: boolean
    discoveryFails?: boolean
    /** Segura a descoberta ate o teste a soltar (para observar `STARTING`). */
    discoveryGate?: { release: () => void }
    /** URL que a descoberta devolve. Por omissao, a do dublê `quick`. */
    discoveredUrl?: string
  } = {},
): Promise<Harness> {
  const ctx = new FakeContext()
  ctx.subprocess.pid = 5150
  const scheduler = new FakeScheduler()
  const clock = new FakeClock(1_000)
  const { deps, kills } = makeSupervisorDeps(scheduler, { now: () => clock.now() })
  const store = freshStore()
  const audited: AuditEvent[] = []
  const notices: string[] = []
  const revocations: number[] = []
  const probeCalls: ProbeRequest[] = []
  const tunnelOrigin = createTunnelOriginRegistry()
  const publicadas: Array<string | undefined> = []
  const descobertas: TunnelDiscoveryInput[] = []
  const origin = await ownOrigin()

  const transport: ProbeTransport = {
    send(request: ProbeRequest): Promise<ProbeTransportResult> {
      probeCalls.push(request)
      return Promise.resolve(options.probeResults?.[request.probe] ?? { kind: 'response', status: 401 })
    },
  }

  let releaseDiscovery: () => void = () => {}
  const gate =
    options.discoveryGate === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          releaseDiscovery = resolve
        })
  if (options.discoveryGate !== undefined) options.discoveryGate.release = () => releaseDiscovery()

  const discovery: TunnelDiscovery = {
    discover: async (input: TunnelDiscoveryInput): Promise<{ url: string; via: 'metrics' | 'stderr' }> => {
      descobertas.push(input)
      await gate
      if (options.discoveryFails === true) throw new Error('a URL nunca apareceu')
      return { url: options.discoveredUrl ?? URL_DO_DUBLE, via: 'metrics' }
    },
  }

  const readiness: TunnelReadiness = {
    waitUntilUsable: (): Promise<{ usable: boolean; status: number | null }> =>
      Promise.resolve({ usable: true, status: 401 }),
  }

  const supervisor = createTunnelSupervisor({
    ctx: ctx.asContext(),
    config: {
      mode: 'quick',
      ttlMinutes: 60,
      binaryPath: '/opt/bin/cloudflared',
      ...options.config,
    },
    resolveOrigin: (): Server => origin,
    allocateMetricsPort: (): number => 37_373,
    probe: { transport, newCanaryToken: (): string => 'canario-fixo' },
    discovery,
    readiness,
    store,
    // O registo REAL, embrulhado para o teste ver a ORDEM das publicacoes. O
    // embrulho delega: o que o gate leria e o mesmo que o supervisor escreveu.
    tunnelOrigin: {
      publish: (url: string | undefined): void => {
        publicadas.push(url)
        tunnelOrigin.publish(url)
      },
    },
    sessions: {
      revokeAll: (): void => {
        revocations.push(clock.now())
      },
    },
    audit: {
      append: (event: AuditEvent): void => {
        if (options.auditThrows === true) throw new Error('disco cheio')
        audited.push(event)
      },
    },
    notifyOwner: (message: string): void => {
      notices.push(message)
    },
    proc: deps,
  })

  return {
    supervisor,
    tunnelOrigin,
    publicadas,
    descobertas,
    ctx,
    scheduler,
    clock,
    store,
    audited,
    notices,
    revocations,
    kills,
    probeCalls,
  }
}

function findTask(scheduler: FakeScheduler, delayMs: number): ScheduledTask {
  const task = scheduler.scheduled.find((candidate) => candidate.delayMs === delayMs)
  if (task === undefined) throw new Error(`nenhuma tarefa agendada para ${String(delayMs)} ms`)
  return task
}

function runTask(task: ScheduledTask): void {
  task.fired = true
  task.callback()
}

/* ========================================================================== */
/* O PROBE CORRE ANTES DO SPAWN                                               */
/* ========================================================================== */

describe('o probe e PRE-CONDICAO de STOPPED -> STARTING, nao readiness', () => {
  const casos: ReadonlyArray<{ id: string; probe: ProbeId; result: ProbeTransportResult }> = [
    { id: 'TUN-020', probe: 'spa-fallback', result: { kind: 'response', status: 200 } },
    { id: 'TUN-021', probe: 'api-rpc', result: { kind: 'response', status: 200 } },
    { id: 'TUN-022', probe: 'websocket-upgrade', result: { kind: 'response', status: 101 } },
    { id: 'TUN-023', probe: 'unguarded-canary', result: { kind: 'response', status: 404 } },
    { id: 'TUN-025', probe: 'spa-fallback', result: { kind: 'error', reason: 'timeout' } },
  ]

  for (const caso of casos) {
    it(`${caso.id}: sonda \`${caso.probe}\` reprova -> NENHUM spawn, estado FAILED, mensagem nomeia a sonda`, async () => {
      const h = await makeHarness({ probeResults: { [caso.probe]: caso.result } })

      const snapshot = await h.supervisor.start()

      // >>> A ASERCAO QUE RESPONDE A PERGUNTA 6 DA REVISAO ADVERSARIAL <<<
      assert.equal(h.ctx.subprocess.calls.length, 0, 'o cloudflared NAO pode ter sido spawnado')
      assert.equal(snapshot.state, 'FAILED')
      assert.equal(snapshot.info, undefined, 'nunca ha URL a divulgar fora de READY')
      assert.equal(snapshot.failure?.code, 'PROBE_FAILED')
      assert.equal(snapshot.failure?.probe, caso.probe)
      assert.equal(snapshot.failure?.message.includes(caso.probe), true)
      // O dono e avisado, e a mensagem que lhe chega nomeia a sonda.
      assert.equal(h.notices.length, 1)
      assert.equal(h.notices[0]?.includes(caso.probe), true)
      // Nada foi escrito no pidfile: nao ha processo nenhum a registar.
      assert.equal(readTunnelProcess(h.store), undefined)

      h.supervisor.dispose()
    })
  }

  it('as QUATRO sondas correm antes de qualquer spawn, e nenhuma leva credencial', async () => {
    const h = await makeHarness({ probeResults: { 'spa-fallback': { kind: 'response', status: 200 } } })
    await h.supervisor.start()

    assert.equal(h.probeCalls.length, 4)
    for (const call of h.probeCalls) {
      const headers = Object.keys(call.headers).map((key) => key.toLowerCase())
      assert.equal(headers.includes('authorization'), false)
    }
    h.supervisor.dispose()
  })

  it('auditoria indisponivel -> o tunel NAO sobe (sem prova nao ha subida)', async () => {
    const h = await makeHarness({ auditThrows: true })

    const snapshot = await h.supervisor.start()

    assert.equal(h.ctx.subprocess.calls.length, 0)
    assert.equal(snapshot.state, 'FAILED')
    assert.equal(snapshot.failure?.code, 'PROBE_FAILED')
    h.supervisor.dispose()
  })
})

describe('TUN-024: as quatro passam -> o tunel sobe e a decisao vai para auditoria', () => {
  it('regista o resultado das QUATRO mais a decisao final', async () => {
    const h = await makeHarness()

    const snapshot = await h.supervisor.start()

    assert.equal(snapshot.state, 'STARTING')
    assert.equal(h.ctx.subprocess.calls.length, 1, 'agora sim, ha spawn')

    const eventos = h.audited.map((event) => event.evento)
    for (const probe of ['spa-fallback', 'api-rpc', 'websocket-upgrade', 'unguarded-canary']) {
      assert.equal(
        eventos.some((evento) => evento.includes(probe)),
        true,
        `falta o registo da sonda ${probe}`,
      )
    }
    assert.equal(eventos.at(-1), 'tunel_probe_decisao')
    assert.equal(h.audited.at(-1)?.resultado, 'permitido')
    // O codigo observado entra no nome do evento: seis meses depois, "o probe
    // passou" nao diz o que foi medido; "401" diz.
    assert.equal(eventos.some((evento) => evento.endsWith(':401')), true)

    h.supervisor.dispose()
  })

  it('o argv do spawn e o seguro: --metrics fixo, sem --loglevel debug, sem --token', async () => {
    const h = await makeHarness()
    await h.supervisor.start()

    const argv = h.ctx.subprocess.calls[0]?.argv ?? []
    assert.equal(argv.join(' ').includes('--metrics 127.0.0.1:37373'), true)
    assert.equal(argv.join(' ').includes('--loglevel debug'), false)
    assert.equal(argv.includes('--token'), false)
    // SUP-015: `graceMs` explicito no spec -- o assento nao aplica defaults.
    assert.equal(h.ctx.subprocess.calls[0]?.graceMs, 3000)
    assert.equal(h.ctx.subprocess.calls[0]?.signal instanceof AbortSignal, true)

    h.supervisor.dispose()
  })

  it('o pidfile e escrito no spawn e apagado na paragem limpa', async () => {
    const h = await makeHarness()
    await h.supervisor.start()

    assert.deepEqual(readTunnelProcess(h.store), { pid: 5150, startedAt: 1_000, mode: 'quick' })

    h.supervisor.stop()
    assert.equal(readTunnelProcess(h.store), undefined)
  })

  it('so transita para READY depois da URL E do readiness', async () => {
    // A descoberta fica SEGURA: sem isto, com dubles que resolvem de imediato, o
    // warmup completa dentro do mesmo dreno de microtasks e `STARTING` nunca e
    // observavel — o teste passaria sem provar a ordem.
    const porta = { release: (): void => {} }
    const h = await makeHarness({ discoveryGate: porta })
    await h.supervisor.start()

    assert.equal(h.supervisor.snapshot().state, 'STARTING')
    assert.equal(h.supervisor.snapshot().info, undefined, 'nunca ha URL fora de READY')
    assert.equal(h.ctx.subprocess.calls.length, 1, 'o processo ja subiu...')

    porta.release()
    await flush()
    await flush()

    const snapshot = h.supervisor.snapshot()
    assert.equal(snapshot.state, 'READY')
    assert.equal(snapshot.info?.url, URL_DO_DUBLE)
    assert.equal(snapshot.expiresAt, 1_000 + 3_600_000)

    h.supervisor.dispose()
  })
})

/* ========================================================================== */
/* TTL                                                                        */
/* ========================================================================== */

describe('TTL: derruba o tunel e invalida as sessoes', () => {
  it('TUN-016: relogio avancado alem de ttlMinutes -> processo morto e estado STOPPED', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()
    assert.equal(h.supervisor.snapshot().state, 'READY')

    h.clock.advance(3_600_000)
    runTask(findTask(h.scheduler, 3_600_000))

    assert.equal(h.supervisor.snapshot().state, 'STOPPED')
    assert.equal(h.supervisor.snapshot().info, undefined)
    // O processo foi mesmo derrubado: `terminate()` do assento MAIS o kill do
    // GRUPO (`-pid`), que e o que apanha os netos.
    assert.equal(h.ctx.subprocess.lastChild().terminateCalls >= 1, true)
    assert.deepEqual(h.kills, [[-5150, 'SIGKILL']])
    assert.equal(readTunnelProcess(h.store), undefined, 'o registo tem de sair com o processo')
  })

  it('TUN-017: TODAS as sessoes emitidas sao invalidadas na expiracao', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()

    assert.deepEqual(h.revocations, [], 'ainda nao')

    h.clock.advance(3_600_000)
    runTask(findTask(h.scheduler, 3_600_000))

    // Sem isto, o cookie emitido pelo tunel velho continuaria a autenticar no
    // tunel seguinte: o prazo teria fechado a porta e deixado a chave.
    assert.equal(h.revocations.length, 1)
  })

  it('TUN-018: o aviso ao dono e emitido DEPOIS do registo em auditoria', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    const auditadosAntes = h.audited.length

    h.clock.advance(3_600_000)
    runTask(findTask(h.scheduler, 3_600_000))

    const expiracao = h.audited.slice(auditadosAntes)
    assert.equal(expiracao.length, 1)
    assert.equal(expiracao[0]?.evento.startsWith('tunel_ttl_expirado'), true)
    assert.equal(h.notices.length, 1)
    // O aviso e o passo que pode falhar (rede); a auditoria nao pode depender
    // dele. A ordem esta congelada em `applyTtlExpiry` e verificada em ttl.test.ts.
    assert.equal(h.notices[0]?.includes('expirou'), true)
    assert.equal(h.notices[0]?.includes('http'), false, 'a URL nao viaja para o Telegram')
  })

  it('TUN-026: um `/status` (leitura do snapshot) NAO estende o TTL', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()
    const prazo = h.supervisor.snapshot().expiresAt

    for (let i = 0; i < 30; i += 1) {
      h.clock.advance(60_000)
      assert.equal(h.supervisor.snapshot().expiresAt, prazo, 'ler estado nao pode mover o prazo')
    }
    // Nenhum temporizador novo nasceu: so um `start` explicito abre janela nova.
    assert.equal(h.scheduler.scheduled.filter((t) => t.delayMs === 3_600_000).length, 1)

    h.supervisor.dispose()
  })

  it('o TTL vem da config e nao tem default no codigo: `0` LANCA na construcao', async () => {
    // Q-3, fail loud at LOAD: recusa-se antes de existir supervisor, e nao no
    // `start()`. Assim `start()` continua a nunca rejeitar — uma recusa e sempre
    // um `TunnelSnapshot` em `FAILED`, nunca uma excepcao a subir.
    await assert.rejects(async () => makeHarness({ config: { ttlMinutes: 0 } }), TunnelTtlError)
    await assert.rejects(async () => makeHarness({ config: { ttlMinutes: 481 } }), TunnelTtlError)
  })
})

/* ========================================================================== */
/* F1: concorrencia                                                           */
/* ========================================================================== */

describe('dois `start()` no mesmo tick sobem UM tunel, nao dois', () => {
  it('OBRIGATORIO: dois `start()` sem `await` => UM spawn, UM pidfile, UM TTL', async () => {
    const h = await makeHarness()

    // Sem `await` entre eles: e este o cenario que a guarda de estado nao cobria,
    // porque ela era lida ANTES do `await` do probe e o estado so mudava DEPOIS.
    const [a, b] = await Promise.all([h.supervisor.start(), h.supervisor.start()])

    assert.equal(h.ctx.subprocess.calls.length, 1, 'dois cloudflared = uma URL publica invisivel')
    assert.equal(h.scheduler.scheduled.filter((t) => t.delayMs === 3_600_000).length, 1)
    assert.deepEqual(a, b, 'os dois chamadores veem o MESMO tunel')

    // E o pidfile aponta para o unico processo que existe.
    assert.equal(readTunnelProcess(h.store)?.pid, h.ctx.subprocess.lastChild().pid)

    h.supervisor.dispose()
  })

  it('tres `start()` concorrentes partilham a MESMA promessa (idempotencia durante o probe)', async () => {
    const h = await makeHarness()

    const p1 = h.supervisor.start()
    const p2 = h.supervisor.start()
    const p3 = h.supervisor.start()
    assert.equal(p1, p2)
    assert.equal(p2, p3)

    await Promise.all([p1, p2, p3])
    assert.equal(h.ctx.subprocess.calls.length, 1)
    h.supervisor.dispose()
  })

  it('e o `dispose()` mata TUDO o que ficou: nenhum processo fora da contabilidade', async () => {
    const h = await makeHarness()
    await Promise.all([h.supervisor.start(), h.supervisor.start()])
    await flush()

    h.supervisor.dispose()

    // O modo de falha original: o segundo `start()` sobrescrevia `proc` e o
    // primeiro cloudflared nunca era morto — nem pelo disposer (que so conhece o
    // corrente), nem pela varredura de boot (que so le o registo sobrescrito).
    const pidsSpawnados = h.ctx.subprocess.children.map((child) => child.pid)
    const pidsMortos = h.kills.map(([pid]) => -pid)
    assert.deepEqual(pidsSpawnados.filter((pid) => !pidsMortos.includes(pid)), [])
    assert.equal(h.scheduler.pending.length, 0, 'nenhum temporizador sobrevive ao disposer')
  })

  it('um `start()` depois de o anterior concluir abre janela NOVA e re-corre o probe', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    assert.equal(h.probeCalls.length, 4)

    h.supervisor.stop()
    await h.supervisor.start()

    // Cada `STOPPED -> STARTING` e uma pre-condicao nova: 8 sondas, 2 spawns.
    assert.equal(h.probeCalls.length, 8)
    assert.equal(h.ctx.subprocess.calls.length, 2)
    h.supervisor.dispose()
  })
})

/* ========================================================================== */
/* F2: o TTL nao desliza com o reinicio                                       */
/* ========================================================================== */

describe('o TTL e da JANELA, nao do ultimo spawn', () => {
  it('uma queda aos 59 min NAO renova o prazo', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    const prazoOriginal = h.supervisor.snapshot().expiresAt
    assert.equal(prazoOriginal, 1_000 + 3_600_000)

    // 59 minutos depois o processo cai e e reiniciado.
    h.clock.advance(59 * 60_000)
    h.ctx.subprocess.lastChild().settle({ exitCode: 1, signal: null })
    await flush()
    h.scheduler.runLast()
    await flush()

    assert.equal(h.ctx.subprocess.calls.length, 2, 'houve mesmo reinicio')
    // ANTES: o prazo saltava de 3601000 para 7141000 — mais 59 minutos de
    // exposicao por cada queda banal. Um cloudflared que reinicia uma vez por
    // hora tinha TTL infinito, que e a ameaca T10 que o `ttl.ts` cita.
    assert.equal(h.supervisor.snapshot().expiresAt, prazoOriginal, 'o prazo NAO pode mover')
    assert.equal(
      h.scheduler.scheduled.filter((task) => task.delayMs === 3_600_000).length,
      1,
      'um so temporizador de TTL na janela inteira',
    )

    h.supervisor.dispose()
  })

  it('dez ciclos com uptime saudavel (orcamento zera) continuam dentro do MESMO prazo', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    const prazoOriginal = h.supervisor.snapshot().expiresAt

    for (let i = 0; i < 10; i += 1) {
      // Uptime saudavel: o orcamento zera, logo este ciclo nunca esgota.
      h.clock.advance(5 * 60_000)
      h.ctx.subprocess.lastChild().settle({ exitCode: 1, signal: null })
      await flush()
      h.scheduler.runLast()
      await flush()
    }

    assert.equal(h.ctx.subprocess.calls.length, 11)
    assert.equal(h.supervisor.snapshot().attempts, 1, 'o orcamento zerou por uptime saudavel')
    // ANTES: +9,83 h alem do TTL de 60 min.
    assert.equal(h.supervisor.snapshot().expiresAt, prazoOriginal)

    h.supervisor.dispose()
  })

  it('o `startedAt` PERSISTIDO tambem nao desliza: o veredito de boot continua a expirar', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    const gravadoInicial = readTunnelProcess(h.store)?.startedAt

    h.clock.advance(59 * 60_000)
    h.ctx.subprocess.lastChild().settle({ exitCode: 1, signal: null })
    await flush()
    h.scheduler.runLast()
    await flush()

    const gravadoDepois = readTunnelProcess(h.store)
    // O que muda no reinicio e o `pid`, e SO ele.
    assert.equal(gravadoDepois?.startedAt, gravadoInicial, 'o startedAt gravado nao pode mover')
    assert.equal(gravadoDepois?.pid, h.ctx.subprocess.lastChild().pid)

    // ANTES: o veredito de boot passava de {expired:true, overdueMs:60000} — a
    // janela REAL — para {expired:false, remainingMs:3480000}, o valor gravado.
    const agora = 1_000 + 61 * 60_000
    assert.deepEqual(decideOnResume(gravadoDepois?.startedAt ?? 0, 60, agora), {
      expired: true,
      overdueMs: 60_000,
    })

    h.supervisor.dispose()
  })
})

/* ========================================================================== */
/* Falhas do processo                                                         */
/* ========================================================================== */

describe('falha do processo projetada no vocabulario do tunel', () => {
  it('ENOENT -> FAILED com BINARY_NOT_FOUND e mensagem accionavel, sem reinicio', async () => {
    const h = await makeHarness()
    await h.supervisor.start()

    h.ctx.subprocess
      .lastChild()
      .fail(Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }))
    await flush()

    const snapshot = h.supervisor.snapshot()
    assert.equal(snapshot.state, 'FAILED')
    assert.equal(snapshot.failure?.code, 'BINARY_NOT_FOUND')
    assert.equal(snapshot.failure?.retryable, false)
    assert.equal(snapshot.failure?.message.includes('pkg.cloudflare.com'), true)
    assert.equal(h.scheduler.pending.length, 0, 'nenhum reinicio agendado')
    assert.equal(readTunnelProcess(h.store), undefined)
    assert.equal(h.notices.at(-1)?.includes('cloudflared'), true)

    h.supervisor.dispose()
  })

  it('queda com orcamento -> DEGRADED, sem divulgar URL', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()
    assert.equal(h.supervisor.snapshot().state, 'READY')

    h.ctx.subprocess.lastChild().settle({ exitCode: 1, signal: null })
    await flush()

    const snapshot = h.supervisor.snapshot()
    assert.equal(snapshot.state, 'DEGRADED')
    assert.equal(snapshot.info, undefined, 'DEGRADED nunca divulga URL')
    assert.equal(snapshot.failure?.retryable, true)
    assert.equal(snapshot.attempts, 1)

    h.supervisor.dispose()
  })

  it('warmup que nunca conclui -> DEGRADED e reinicio POR INTENCAO, consumindo orcamento', async () => {
    const h = await makeHarness({ discoveryFails: true })
    await h.supervisor.start()
    await flush()
    await flush()

    const snapshot = h.supervisor.snapshot()
    assert.equal(snapshot.state, 'DEGRADED')
    assert.equal(snapshot.failure?.code, 'READINESS_TIMEOUT')
    // Um processo vivo e INUTIL tem de consumir tentativa: senao o `maxAttempts`
    // nunca contaria este caso e o ciclo correria para sempre.
    assert.equal(snapshot.attempts, 1)

    h.supervisor.dispose()
  })
})

describe('disposer', () => {
  it('e SINCRONO, idempotente, e nao deixa temporizador vivo', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()

    const resultado: unknown = h.supervisor.dispose()
    h.supervisor.dispose()
    h.supervisor.dispose()

    assert.equal(resultado, undefined)
    assert.equal(typeof (resultado as { then?: unknown } | undefined)?.then, 'undefined')
    assert.equal(h.scheduler.pending.length, 0, 'nenhum temporizador sobrevive')
    // Chamar 3x = 1 kill.
    assert.deepEqual(h.kills, [[-5150, 'SIGKILL']])
    assert.equal(h.supervisor.snapshot().state, 'STOPPED')
  })
})

/* ========================================================================== */
/* EMENDA 2 DA COSTURA -- A ORIGEM DO TUNEL E PUBLICADA, E RETIRADA            */
/* ========================================================================== */

/**
 * A allowlist de `Host` (L2.5) e a de `Origin` do handshake de WebSocket sao
 * construidas a partir de `tunnelOrigin.current()`. Ate esta costura o UNICO
 * publicador era o consumo do `RestrictExposureIntent`, que RETIRA a origem --
 * ninguem a punha. Consequencia medida no produto: com o tunel em `READY`, o
 * gate recusava com 403 tudo o que chegava pela borda.
 *
 * OS DOIS SENTIDOS SAO IGUALMENTE OBRIGATORIOS. Uma entrada MORTA na allowlist
 * e um BYPASS: um nome `*.trycloudflare.com` derrubado volta a ser distribuido
 * a outra pessoa, e um `Host` com o hostname antigo continuaria a passar L2.5.
 * O caso-controlo ponta-a-ponta (o perimetro do gate a aceitar e a recusar o
 * MESMO pedido) esta em `test/integration/tunnel/origem-publicada.test.ts`.
 */
describe('EMENDA 2: `READY` publica a origem; sair de `READY` retira-a', () => {
  it('publica a URL em READY e retira-a na paragem limpa', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()

    assert.equal(h.supervisor.snapshot().state, 'READY')
    assert.equal(h.tunnelOrigin.current(), URL_DO_DUBLE, 'READY tem de POR a origem na allowlist')

    h.supervisor.stop()

    assert.equal(h.tunnelOrigin.current(), undefined, 'entrada morta na allowlist e bypass')
    h.supervisor.dispose()
  })

  it('a QUEDA do processo retira a origem, mesmo com reinicio a caminho', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()
    assert.equal(h.tunnelOrigin.current(), URL_DO_DUBLE)

    h.ctx.subprocess.lastChild().settle({ exitCode: 1, signal: null })
    await flush()

    assert.equal(h.supervisor.snapshot().state, 'DEGRADED')
    assert.equal(h.tunnelOrigin.current(), undefined, 'DEGRADED nao pode manter o nome publico vivo')
    h.supervisor.dispose()
  })

  it('a EXPIRACAO DO TTL retira a origem -- e e o primeiro efeito a acontecer', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()
    assert.equal(h.tunnelOrigin.current(), URL_DO_DUBLE)

    runTask(findTask(h.scheduler, 60 * 60 * 1_000))

    assert.equal(h.supervisor.snapshot().state, 'STOPPED')
    assert.equal(h.tunnelOrigin.current(), undefined)
    h.supervisor.dispose()
  })

  it('o DISPOSER retira a origem: um plugin descarregado nao deixa allowlist para tras', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()
    assert.equal(h.tunnelOrigin.current(), URL_DO_DUBLE)

    h.supervisor.dispose()

    assert.equal(h.tunnelOrigin.current(), undefined)
  })

  it('o probe fail-closed que reprova NUNCA chega a publicar nada', async () => {
    const h = await makeHarness({ probeResults: { 'spa-fallback': { kind: 'response', status: 200 } } })

    await h.supervisor.start()

    assert.equal(h.supervisor.snapshot().state, 'FAILED')
    assert.equal(h.tunnelOrigin.current(), undefined)
    // Nem sequer um `publish(url)` seguido de `publish(undefined)`: nao houve
    // processo, nao houve URL, e a allowlist nunca viu o nome.
    assert.equal(
      h.publicadas.some((valor) => valor !== undefined),
      false,
    )
    h.supervisor.dispose()
  })

  it('a ULTIMA publicacao de um ciclo completo e SEMPRE a retirada', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()
    h.supervisor.dispose()

    assert.equal(h.publicadas.includes(URL_DO_DUBLE), true, 'a URL chegou a entrar')
    assert.equal(h.publicadas.at(-1), undefined, 'e a ultima palavra e sempre a retirada')
  })
})

/* ========================================================================== */
/* EMENDA 3 DA COSTURA -- QUEM DRENA O `stderr` DO `cloudflared`               */
/* ========================================================================== */

/**
 * `discover()` (T3.2) e leitor OPORTUNISTA: poe e tira so o listener dele, e o
 * `dispose()` NAO faz `resume()` de proposito -- faze-lo descartaria em silencio
 * o log de arranque. O consumidor DURAVEL e o de `src/proc/stream-log.ts`
 * (`redact()` + logger), ligado por `createProcessSupervisor` no `spawn`, ANTES
 * de `onSpawned` e portanto antes de `discover()`.
 *
 * O MODO DE FALHA SE NINGUEM DRENAR, medido nesta arvore: um filho que escreve
 * em `stderr` sem leitor para de progredir depois de 190 464 bytes (buffer do
 * pipe do SO -- 64 KiB por omissao no Linux -- mais a fila interna do Node). Um
 * `cloudflared` verboso enche isso e CONGELA no `write`: sem erro, sem log e sem
 * sinal nenhum.
 *
 * ESTES CASOS SAO A CONFIRMACAO PEDIDA: o supervisor JA liga o consumidor, e
 * estes testes falham se alguem o desligar.
 */
describe('EMENDA 3: o `stderr` e drenado antes, durante e depois de `discover()`', () => {
  it('o log de ARRANQUE (antes de a URL aparecer) e registado, e nao descartado', async () => {
    const porta = { release: (): void => {} }
    const h = await makeHarness({ discoveryGate: porta })
    await h.supervisor.start()

    // A descoberta ainda esta a decorrer: e exatamente a janela em que o
    // `cloudflared` real escreve o banner de arranque.
    h.ctx.subprocess.lastChild().stderr.write('INF banner de arranque do cloudflared\n')
    await flush()

    assert.equal(h.ctx.logger.has('warn', 'banner de arranque do cloudflared'), true)
    porta.release()
    await flush()
    h.supervisor.dispose()
  })

  it('DEPOIS de `discover()` largar o listener, o `stderr` continua a ser consumido', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()
    assert.equal(h.supervisor.snapshot().state, 'READY', 'a descoberta ja terminou e ja fez dispose')

    const stderr = h.ctx.subprocess.lastChild().stderr
    // >>> A ASERCAO DE MECANISMO. <<< O leitor oportunista ja se removeu; se o
    // consumidor duravel nao existisse, este numero era ZERO e o pipe do SO
    // enchia ate o `cloudflared` bloquear no `write`.
    assert.ok(stderr.listenerCount('data') >= 1, 'ninguem esta a drenar o stderr')
    assert.equal(stderr.isPaused(), false)

    stderr.write('ERR o tunel escreveu isto depois da descoberta\n')
    await flush()

    assert.equal(h.ctx.logger.has('warn', 'depois da descoberta'), true)
    h.supervisor.dispose()
  })

  it('o que e drenado passa por `redact()`: a URL do tunel nao chega ao log', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()

    h.ctx.subprocess.lastChild().stderr.write(`INF |  ${URL_DO_DUBLE}  |\n`)
    await flush()

    const tudo = h.ctx.logger.entries.map((entrada) => entrada.message).join('\n')
    assert.equal(tudo.includes(URL_DO_DUBLE), false, 'a URL do tunel e a capacidade, nao um endereco')
    assert.equal(tudo.includes('trycloudflare'), false)
    assert.equal(h.ctx.logger.has('warn', '[REDACTED]'), true, 'houve corte, e ele e visivel')
    h.supervisor.dispose()
  })

  it('o consumidor sai de cena no FECHO do processo, nao antes', async () => {
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()
    const stderr = h.ctx.subprocess.lastChild().stderr
    assert.ok(stderr.listenerCount('data') >= 1)

    h.ctx.subprocess.lastChild().settle({ exitCode: 0, signal: null })
    await flush()

    assert.equal(stderr.listenerCount('data'), 0, 'fechado o processo, o listener e removido')
    h.supervisor.dispose()
  })

  it('UMA `discover()` por processo SPAWNADO -- um retry e `stderr` NOVO', async () => {
    // `discover()` nao e reentrante por desenho. Um reinicio e processo novo,
    // com `stderr` novo, e portanto uma chamada nova -- nunca uma segunda
    // chamada sobre o MESMO fluxo.
    const h = await makeHarness({ discoveryFails: true })
    await h.supervisor.start()
    await flush()
    await flush()

    assert.equal(h.descobertas.length, 1)
    assert.equal(h.ctx.subprocess.calls.length, 1)

    // O reinicio POR INTENCAO do warmup falhado: um spawn novo.
    h.scheduler.runLast()
    await flush()
    await flush()

    assert.equal(h.ctx.subprocess.calls.length, 2, 'houve um segundo processo')
    assert.equal(h.descobertas.length, 2, 'e exatamente uma descoberta por processo')
    assert.notEqual(
      h.descobertas[0]?.stderr,
      h.descobertas[1]?.stderr,
      'a segunda descoberta NAO pode receber o `stderr` do processo anterior',
    )
    assert.equal(h.descobertas[1]?.stderr, h.ctx.subprocess.children[1]?.stderr)

    h.supervisor.dispose()
  })
})

/* ========================================================================== */
/* DEFEITO 1 -- O `cloudflared` CORRIA COM `secrets: []`                      */
/* ========================================================================== */

/**
 * `SECRET_SHAPES` cobre `*.trycloudflare.com`, que e o modo `quick`. Em
 * `mode: 'named'` NAO HA FORMA A QUE AGARRAR: o hostname e o dominio do proprio
 * dono e o token e um segredo opaco. Os dois so podem ser cortados pela camada
 * LITERAL do `redact()` -- e era precisamente essa que o supervisor do tunel nao
 * alimentava.
 *
 * O TOKEN E O CASO GRAVE. Entregamo-lo por `--token-file` de proposito para ele
 * nao viver em `argv` (TUN-014); depois nao o davamos ao redator. Bastava o
 * `cloudflared` ecoa-lo em `stderr` -- um erro de parsing, um aviso de expiracao
 * -- para ele ir inteiro para o log do operador.
 */
describe('DEFEITO 1: os literais do named tunnel chegam ao `redact()`', () => {
  const TOKEN = 'eyJhIjoiZmFrZS1uYW1lZC10dW5uZWwtdG9rZW4tcXVlLW5hby1wb2RlLXZhemFyIn0'
  const URL_DO_DONO = 'https://tunel.dominio-do-proprio-dono.pt'

  /** Ficheiro `0600` com o token, como o contrato manda. */
  function tokenFileCom(conteudo: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-token-'))
    const ficheiro = join(dir, 'named.token')
    writeFileSync(ficheiro, `${conteudo}\n`, { mode: 0o600 })
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return ficheiro
  }

  const configNamed = (tokenFile: string): Partial<TunnelConfig> => ({
    mode: 'named',
    tokenFile,
  })

  it('o TOKEN ecoado em `stderr` nao chega ao log', async () => {
    const h = await makeHarness({
      config: configNamed(tokenFileCom(TOKEN)),
      discoveredUrl: URL_DO_DONO,
    })
    await h.supervisor.start()
    await flush()
    await flush()

    h.ctx.subprocess.lastChild().stderr.write(`ERR failed to parse token ${TOKEN}\n`)
    await flush()

    const tudo = h.ctx.logger.entries.map((entrada) => entrada.message).join('\n')
    assert.equal(tudo.includes(TOKEN), false, 'o token do named tunnel foi para o log')
    assert.equal(h.ctx.logger.has('warn', '[REDACTED]'), true, 'houve corte, e ele e visivel')
    // Mascarar nao pode virar apagar: o operador tem de saber O QUE falhou.
    assert.equal(h.ctx.logger.has('warn', 'failed to parse token'), true)
    h.supervisor.dispose()
  })

  it('o HOSTNAME do dono nao chega ao log -- nenhuma FORMA o adivinha', async () => {
    const h = await makeHarness({
      config: configNamed(tokenFileCom(TOKEN)),
      discoveredUrl: URL_DO_DONO,
    })
    await h.supervisor.start()
    await flush()
    await flush()
    assert.equal(h.supervisor.snapshot().state, 'READY')

    h.ctx.subprocess.lastChild().stderr.write(`INF route ${URL_DO_DONO}/api ready\n`)
    await flush()

    const tudo = h.ctx.logger.entries.map((entrada) => entrada.message).join('\n')
    assert.equal(tudo.includes('dominio-do-proprio-dono'), false, 'o dominio do dono saiu no log')
    h.supervisor.dispose()
  })

  it('FORNECEDOR e nao captura: um token RODADO no disco e o que passa a ser cortado', async () => {
    // A prova de que a lista nao e capturada no arranque. O token roda no disco,
    // o processo reinicia, e o redator tem de cortar o NOVO -- que e o que o
    // `cloudflared` vivo recebeu.
    const ficheiro = tokenFileCom(TOKEN)
    const h = await makeHarness({ config: configNamed(ficheiro), discoveredUrl: URL_DO_DONO })
    await h.supervisor.start()
    await flush()
    await flush()

    const TOKEN_NOVO = 'eyJhIjoidG9rZW4tcm9kYWRvLWRlcG9pcy1kby1hcnJhbnF1ZS1kby1wbHVnaW4ifQ'
    writeFileSync(ficheiro, `${TOKEN_NOVO}\n`, { mode: 0o600 })

    // Queda + reinicio: processo novo, leitura nova.
    h.ctx.subprocess.lastChild().settle({ exitCode: 1, signal: null })
    await flush()
    h.scheduler.runLast()
    await flush()
    await flush()

    assert.equal(h.ctx.subprocess.calls.length, 2, 'houve um segundo processo')
    h.ctx.subprocess.lastChild().stderr.write(`ERR token rejected: ${TOKEN_NOVO}\n`)
    await flush()

    const tudo = h.ctx.logger.entries.map((entrada) => entrada.message).join('\n')
    assert.equal(tudo.includes(TOKEN_NOVO), false, 'o token NOVO nao foi cortado')
    h.supervisor.dispose()
  })

  it('em `quick` a URL NAO entra na camada literal -- ela nao e segredo (02-SEGURANCA 2.2)', async () => {
    // A forma em `SECRET_SHAPES` ja a corta no log; duplica-la no literal so
    // tirava legibilidade. O que se prova aqui e a AUSENCIA da duplicacao: o
    // ficheiro do token nem sequer e lido em `quick`.
    const h = await makeHarness()
    await h.supervisor.start()
    await flush()
    await flush()

    assert.equal(h.supervisor.snapshot().state, 'READY')
    // E a URL continua a nao chegar ao log -- pela FORMA, que e a camada certa.
    h.ctx.subprocess.lastChild().stderr.write(`INF ${URL_DO_DUBLE}\n`)
    await flush()
    const tudo = h.ctx.logger.entries.map((entrada) => entrada.message).join('\n')
    assert.equal(tudo.includes('trycloudflare'), false)
    h.supervisor.dispose()
  })
})
