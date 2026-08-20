/**
 * Ciclo de vida do `cloudflared` — uma INSTANCIACAO de `createProcessSupervisor`.
 *
 * O que este ficheiro NAO tem: backoff, jitter, orcamento, tree-kill,
 * `AbortController` de ciclo de vida — e tudo de `src/proc/**`, partilhado byte a
 * byte com o supervisor do worker. O que ele TEM e a politica so do tunel: PROBE
 * FAIL-CLOSED como pre-condicao de `STOPPED -> STARTING` (`./probe.ts`), PIDFILE
 * (`./pidfile.ts`), TTL (`./ttl.ts`) e `argv`/spec seguros (`./args.ts`).
 *
 * Descoberta e readiness sao INJETADOS (contrato congelado, implementados por
 * T3.2). Readiness responde "a URL ja e utilizavel?" e corre DEPOIS; o probe
 * responde "o gate esta armado?" e corre ANTES — confundir as duas expos o DSH
 * real durante ~40 s. A maquina de intencoes (D29) e de T5.1; o que esta aqui e o
 * minimo para o estado observado nunca mentir: nunca `READY` sem URL, nunca `info`
 * fora de `READY`, nunca um `cloudflared` fora da contabilidade do disposer.
 */

import type { Server } from 'node:http'

import type { AuditSink } from '../contracts/auth.ts'
import type { StateStore } from '../contracts/state.ts'
import type {
  TunnelConfig,
  TunnelDiscovery,
  TunnelFailure,
  TunnelInfo,
  TunnelReadiness,
  TunnelSnapshot,
  TunnelState,
} from '../contracts/tunnel.ts'
import type { Context, SubprocessHandle, SubprocessSpawnSpec } from '../dsh/adapter.ts'
import { createGuardLogger, type GuardLogger } from '../logging/logger.ts'
import type { ProcessFailure } from '../proc/failure.ts'
import {
  createProcessSupervisor,
  defaultSupervisorDeps,
  type ProcessSupervisor,
  type SupervisorDeps,
} from '../proc/supervisor.ts'
import { buildCloudflaredSpec, DEFAULT_TUNNEL_BACKOFF, toTunnelFailure } from './args.ts'
import { clearTunnelProcess, recordTunnelProcess } from './pidfile.ts'
import { auditProbeDecision, runGateProbe, type ProbeTransport } from './probe.ts'
import {
  assertValidTtlMinutes,
  createTtlEffects,
  createTunnelTtl,
  type TtlEffects,
  type TunnelTtl,
} from './ttl.ts'

/** Timeout do warmup. `>= 30_000` por contrato (a URL levou 6-7 s em T0.2). */
export const DEFAULT_WARMUP_TIMEOUT_MS = 60_000

export interface TunnelSupervisorOptions {
  readonly ctx: Context
  readonly config: TunnelConfig
  /** PROVA de posse da origem, resolvida a CADA tentativa (`originPortOfOwnServer`). */
  resolveOrigin(): Server
  /** Porta livre para o servidor de metricas. Escolhida por nos, nunca pelo default. */
  allocateMetricsPort(): number
  /** `newCanaryToken`: sufixo aleatorio do canario (CSPRNG real, fixo no teste). */
  readonly probe: {
    readonly transport: ProbeTransport
    newCanaryToken(): string
    readonly apiReadPath?: string | undefined
  }
  readonly discovery: TunnelDiscovery
  readonly readiness: TunnelReadiness
  readonly store: StateStore
  /** Ponto de enganche da invalidacao; a fiacao no gate e de T3.3. */
  readonly sessions: { revokeAll(): void }
  readonly audit: AuditSink
  notifyOwner(message: string): void
  readonly proc?: SupervisorDeps | undefined
  readonly warmupTimeoutMs?: number | undefined
}

export interface TunnelSupervisor {
  /**
   * Corre o probe e, SO se ele passar, faz `spawn`. NUNCA rejeita (uma recusa e um
   * snapshot em `FAILED`). Chamadas concorrentes partilham a MESMA promessa.
   */
  start(): Promise<TunnelSnapshot>
  /** Paragem limpa e explicita. Sincrona. */
  stop(): void
  /** Disposer SINCRONO e idempotente (Q-2). LIFO: TTL, processo, pidfile. */
  dispose(): void
  snapshot(): TunnelSnapshot
}

export function createTunnelSupervisor(options: TunnelSupervisorOptions): TunnelSupervisor {
  const { config, store } = options
  const log: GuardLogger = createGuardLogger(options.ctx)
  const procDeps: SupervisorDeps = options.proc ?? defaultSupervisorDeps
  const warmupTimeoutMs = options.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS

  // Q-3, FAIL LOUD AT LOAD: `ttlMinutes` invalido LANCA na construcao e nao no
  // `start()` — assim `start()` continua a nunca rejeitar.
  assertValidTtlMinutes(config.ttlMinutes)

  let state: TunnelState = 'STOPPED'
  let info: TunnelInfo | undefined
  let failure: TunnelFailure | undefined
  let proc: ProcessSupervisor | undefined
  let ttl: TunnelTtl | undefined
  let warmup: AbortController | undefined
  let unlinkWarmup: (() => void) | undefined
  let probeAbort: AbortController | undefined
  /** O reinicio corrente veio de um warmup falhado, e nao de uma queda. */
  let warmupFailed = false
  /** Instante em que a JANELA abriu — nao o do ultimo `spawn`. Ver `onSpawned`. */
  let windowStartedAt = 0
  /** `start()` em curso. Ver {@link start}: sem isto, dois sobem dois tuneis. */
  let inFlightStart: Promise<TunnelSnapshot> | undefined
  let disposed = false
  const snapshot = (): TunnelSnapshot => ({
    state,
    // A URL so e divulgada em `READY` — o contrato torna impossivel entrega-la a
    // partir de `STARTING` ou de `DEGRADED`, e esta projeccao respeita-o.
    info: state === 'READY' ? info : undefined,
    failure,
    attempts: proc?.attempts ?? 0,
    expiresAt: state === 'READY' ? ttl?.expiresAt : undefined,
  })

  /** Apaga o registo sem deixar uma falha de disco derrubar um disposer. */
  const forgetProcessRecord = (): void => {
    try {
      clearTunnelProcess(store)
    } catch (error) {
      log.error(
        `nao foi possivel apagar o registo do tunel no estado: ${
          error instanceof Error ? error.message : String(error)
        }. O boot seguinte vai varrer um pid que ja nao e nosso.`,
      )
    }
  }

  const cancelWarmup = (): void => {
    // O ouvinte de abort e REMOVIDO, nao so esquecido: sao ate `maxAttempts + 1`
    // warmups no MESMO `AbortSignal`, e o `EventTarget` do Node avisa a partir do
    // decimo — ruido que treina o operador a ignorar avisos.
    unlinkWarmup?.()
    unlinkWarmup = undefined
    warmup?.abort()
    warmup = undefined
  }

  /** Derruba o processo e devolve o estado a `STOPPED`. Sincrono, idempotente. */
  const teardown = (reason: string): void => {
    if (proc === undefined && state === 'STOPPED') return
    state = 'STOPPING'
    log.info(`A derrubar o tunel: ${reason}`)
    cancelWarmup()
    // LIFO: o TTL foi armado DEPOIS do processo, entao e cancelado ANTES dele.
    ttl?.dispose()
    ttl = undefined
    proc?.dispose()
    proc = undefined
    forgetProcessRecord()
    info = undefined
    state = 'STOPPED'
  }

  const ttlEffects: TtlEffects = createTtlEffects({
    stopTunnel: (): void => {
      teardown('o TTL expirou')
    },
    sessions: options.sessions,
    audit: options.audit,
    notifyOwner: options.notifyOwner.bind(options),
  })

  /* -- Warmup: descoberta da URL e readiness, DEPOIS de o processo subir -- */
  const failWarmup = (detail: string): void => {
    if (disposed || proc === undefined) return
    failure = {
      code: 'READINESS_TIMEOUT',
      message:
        'o tunel subiu mas nunca ficou utilizavel a tempo. A tentar de novo automaticamente; ' +
        'se persistir, verifique a ligacao a Internet desta maquina.',
      retryable: true,
    }
    state = 'DEGRADED'
    // Reinicio POR INTENCAO pelo MESMO orcamento da queda espontanea: um processo
    // vivo e inutil consome tentativa, senao o `maxAttempts` nao conta este caso.
    warmupFailed = true
    proc.restart(`Warmup do tunel falhou: ${detail}.`)
  }

  const beginWarmup = (handle: SubprocessHandle, metricsPort: number, spawnedAt: number): void => {
    const controller = new AbortController()
    warmup = controller

    // O sinal do ciclo de vida aborta o warmup: sem isto, o polling esperava o
    // deadline inteiro por uma URL que ja nao vai chegar.
    const onLifecycleAbort = (): void => controller.abort()
    const lifecycle = proc?.signal
    lifecycle?.addEventListener('abort', onLifecycleAbort, { once: true })
    unlinkWarmup = (): void => lifecycle?.removeEventListener('abort', onLifecycleAbort)

    void (async (): Promise<void> => {
      try {
        const discovered = await options.discovery.discover({
          metricsPort,
          // `stderr`, nao `stdout`: medido, o `cloudflared` deixa `stdout` com
          // ZERO bytes e escreve o banner da URL em `stderr`.
          stderr: handle.stderr ?? null,
          signal: controller.signal,
          timeoutMs: warmupTimeoutMs,
        })
        const outcome = await options.readiness.waitUntilUsable({
          url: discovered.url,
          signal: controller.signal,
          timeoutMs: warmupTimeoutMs,
        })
        if (controller.signal.aborted || disposed) return
        if (!outcome.usable) {
          failWarmup(`a URL respondeu ${String(outcome.status)} e nao ficou utilizavel`)
          return
        }
        info = { url: discovered.url, startedAt: spawnedAt, mode: config.mode }
        failure = undefined
        state = 'READY'
        log.info(`Tunel pronto (URL obtida via ${discovered.via}).`)
      } catch (error) {
        if (controller.signal.aborted || disposed) return
        failWarmup(error instanceof Error ? error.message : String(error))
      }
    })()
  }

  /* -- O processo -------------------------------------------------------- */
  const createProcess = (): ProcessSupervisor => {
    // A porta e escolhida UMA vez por janela de tunel: mudar de porta entre
    // reinicios deixaria a descoberta a ler o servidor de metricas anterior.
    const metricsPort = options.allocateMetricsPort()

    return createProcessSupervisor(
      options.ctx,
      {
        name: 'cloudflared',
        backoff: config.backoff ?? DEFAULT_TUNNEL_BACKOFF,
        buildSpec: (signal: AbortSignal): SubprocessSpawnSpec =>
          buildCloudflaredSpec({
            config,
            metricsPort,
            // Posse da origem verificada NO INSTANTE DO USO, a cada tentativa.
            origin: options.resolveOrigin(),
            signal,
          }),
        onSpawned: (handle: SubprocessHandle): void => {
          /**
           * >>> O `startedAt` NAO DESLIZA COM O REINICIO. <<<
           *
           * Este gancho corre em TODOS os spawns. Gravar `now()` aqui — e re-armar
           * o TTL dele — dava prazo NOVO a cada queda: medido, uma queda aos 59 min
           * empurrava o prazo de 3601000 para 7141000, e 10 ciclos com uptime
           * saudavel (o orcamento zera, o ciclo nunca esgota) davam +9,83 h. Um
           * `cloudflared` que reinicia de hora a hora tinha TTL INFINITO — a ameaca
           * T10 do `./ttl.ts`, e era fechar o `renew()` na API e deixa-lo aberto no
           * ciclo de vida do processo. Muda o `pid`, e so ele.
           */
          recordTunnelProcess(store, {
            pid: handle.pid,
            startedAt: windowStartedAt,
            mode: config.mode,
          })
          beginWarmup(handle, metricsPort, windowStartedAt)
        },
        onTerminated: (event): void => {
          cancelWarmup()
          info = undefined
          if (!event.willRetry) return
          state = 'DEGRADED'
          // A causa PRECISA sobrevive a generica: quando o reinicio veio de um
          // warmup falhado, `READINESS_TIMEOUT` diz o que aconteceu e
          // `PROCESS_EXITED` diria uma coisa que nao aconteceu.
          if (warmupFailed) {
            warmupFailed = false
            return
          }
          failure = {
            code: 'PROCESS_EXITED',
            message: 'o tunel caiu e vai ser reiniciado automaticamente.',
            retryable: true,
          }
        },
        onFailed: (processFailure: ProcessFailure): void => {
          state = 'FAILED'
          failure = toTunnelFailure(processFailure)
          forgetProcessRecord()
          ttl?.dispose()
          ttl = undefined
          options.notifyOwner(failure.message)
        },
      },
      procDeps,
    )
  }

  /* -- start(): o probe primeiro, o spawn depois ------------------------- */
  const runStart = async (): Promise<TunnelSnapshot> => {
    /**
     * >>> O PROBE CORRE AQUI, ANTES DE EXISTIR QUALQUER `spawn`. <<<
     *
     * Se corresse depois nao seria fail-closed: a janela de exposicao ja estaria
     * aberta e o controlo seria um relatorio em vez de um portao. O controlador e
     * proprio do probe, para o disposer poder aborta-lo a meio.
     */
    probeAbort = new AbortController()
    const result = await runGateProbe({
      transport: options.probe.transport,
      canaryToken: options.probe.newCanaryToken(),
      signal: probeAbort.signal,
      apiReadPath: options.probe.apiReadPath,
    })

    // O `await` acima e um ponto de suspensao: o disposer pode ter corrido entre
    // o inicio do probe e esta linha, e sem esta leitura um plugin ja descarregado
    // ainda spawnava o tunel.
    if (disposed) return snapshot()

    try {
      auditProbeDecision(options.audit, result)
    } catch (error) {
      // Nao consigo registar a decisao => nao subo (ver `auditProbeDecision`).
      failure = {
        code: 'PROBE_FAILED',
        message:
          'o tunel NAO subiu: nao foi possivel registar em auditoria a verificacao do portao. ' +
          'Sem registo nao ha prova de que a verificacao aconteceu, e sem prova o tunel nao abre.',
        retryable: false,
      }
      state = 'FAILED'
      log.error(`Auditoria do probe falhou: ${error instanceof Error ? error.message : String(error)}`)
      options.notifyOwner(failure.message)
      return snapshot()
    }

    if (!result.passed) {
      // `STOPPED -> FAILED`, SEM passar por `STARTING`: nunca houve processo.
      failure = result.failure
      state = 'FAILED'
      log.error(`Probe fail-closed reprovou; o tunel NAO sobe. ${failure?.message ?? ''}`)
      if (failure !== undefined) options.notifyOwner(failure.message)
      return snapshot()
    }

    // REDE DE SEGURANCA: nenhum caminho substitui `proc`, `ttl` ou o registo em
    // disco sem LIBERTAR o anterior — sobrepor a variavel deixava um `cloudflared`
    // vivo que nem o disposer nem a varredura de boot alcancavam.
    if (proc !== undefined || ttl !== undefined) {
      teardown('havia um tunel anterior por libertar antes de abrir janela nova')
    }

    failure = undefined
    state = 'STARTING'
    // A JANELA abre AQUI, e uma so vez. E este instante que vai para o disco e
    // que arma o TTL; os spawns seguintes herdam-no em vez de o renovar.
    windowStartedAt = procDeps.now()
    ttl = createTunnelTtl({
      ttlMinutes: config.ttlMinutes,
      scheduler: procDeps.scheduler,
      now: procDeps.now,
      effects: ttlEffects,
      log,
    })
    ttl.arm(windowStartedAt)
    proc = createProcess()
    proc.start()
    return snapshot()
  }

  /**
   * A INTENCAO E MARCADA ANTES DO `await` — dai uma promessa em curso, e nao uma
   * bandeira lida no topo. A guarda de estado sozinha NAO serve: e lida antes do
   * `await` do probe e o estado so muda depois dele.
   *
   * MEDIDO antes desta correccao: dois `start()` no mesmo tick faziam 2 spawns
   * (`pids [6001, 6002]`) e o segundo sobrescrevia `proc`, `ttl` e o pidfile do
   * primeiro sem os libertar — `state.json` com 6002, kills apos `dispose()` so
   * `[[-6002]]`, 1 temporizador de TTL orfao a derrubar o tunel errado. O 6001
   * ficava publico e fora do alcance de TODO controlo: do disposer (so conhece o
   * `proc` corrente), da varredura de boot (so le o registo sobrescrito) e do TTL.
   * A exposicao de ~40 s do incidente original, mas permanente e invisivel.
   */
  const start = (): Promise<TunnelSnapshot> => {
    if (disposed) return Promise.resolve(snapshot())
    if (inFlightStart !== undefined) return inFlightStart
    if (state !== 'STOPPED' && state !== 'FAILED') return Promise.resolve(snapshot())

    const running = runStart().finally((): void => {
      inFlightStart = undefined
    })
    inFlightStart = running
    return running
  }

  return {
    start,
    stop: (): void => {
      teardown('paragem pedida')
    },
    dispose: (): void => {
      if (disposed) return
      disposed = true
      probeAbort?.abort()
      teardown('o plugin esta a ser descarregado')
    },
    snapshot,
  }
}
