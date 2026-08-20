/**
 * `src/tunnel/supervisor.ts` -- a composicao: probe ANTES do spawn, pidfile, TTL.
 *
 * A PERGUNTA FALSIFICAVEL 6 DE T3.1 E LITERALMENTE ESTA: *"o probe roda antes ou
 * depois do `spawn`? Force o gate a ficar desarmado e prove que o `spawn` NUNCA
 * acontece."* E o que os casos TUN-020..TUN-025 aqui fazem, e a asercao e sempre
 * a mesma: `ctx.subprocess.calls.length === 0`.
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import type { StateStore } from '../../../src/contracts/state.ts'
import type {
  ProbeId,
  TunnelConfig,
  TunnelDiscovery,
  TunnelReadiness,
} from '../../../src/contracts/tunnel.ts'
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
    discover: async (): Promise<{ url: string; via: 'metrics' | 'stderr' }> => {
      await gate
      if (options.discoveryFails === true) throw new Error('a URL nunca apareceu')
      return { url: URL_DO_DUBLE, via: 'metrics' }
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

  return { supervisor, ctx, scheduler, clock, store, audited, notices, revocations, kills, probeCalls }
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
