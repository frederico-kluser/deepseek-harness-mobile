/**
 * ASSENTO DE SUBPROCESSOS REAL, para os testes de integracao.
 *
 * Ficheiro sem sufixo `.test.ts`: nao e executado como suite.
 *
 * PORQUE EXISTE. O repositorio tem os TIPOS de `@deepseek-ai/dsh-subprocess`
 * (espelho byte-a-byte em `types/**`) mas nao a IMPLEMENTACAO
 * (`-local` nao esta instalado). Os testes unitarios usam o duble de
 * `test/support/child-double.ts`, que so assenta `done` quando o teste manda —
 * e isso e exatamente o que NAO serve para responder a pergunta falsificavel 4
 * de T3.1: *"o codigo pendura em `'close'` ou em `'exit'`?"*. Essa pergunta so
 * tem resposta contra processos REAIS.
 *
 * Este assento e, portanto, a versao minima e honesta do contrato publicado:
 *
 *   - `done` resolve NO FECHO com os factos de saida e rejeita APENAS em falha
 *     de nivel de spawn;
 *   - `terminate()` escala `SIGTERM -> graceMs -> SIGKILL` sobre a ARVORE, e e
 *     idempotente;
 *   - o filho e `detached`, ou seja LIDER DO SEU PROPRIO GRUPO — sem isso o
 *     `-pid` do POSIX nao designa grupo nenhum e o tree-kill nao acontece.
 *
 * >>> A LINHA QUE IMPORTA ESTA EM `settleOn('close')`. <<<
 * Medido (`08-PESQUISA-E-FONTES.md`, facto 520): num `ENOENT` a sequencia e
 * `error -> close` e `'exit'` NUNCA dispara. Quem assentasse o resultado no
 * `'exit'` ficava pendurado para sempre no modo de falha mais comum. Aqui
 * `'error'` SO CLASSIFICA a causa; quem termina a promessa e sempre o `'close'`.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  Context,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '../../../src/dsh/adapter.ts'
import type { AuditEvent } from '../../../src/contracts/auth.ts'
import type { StateStore } from '../../../src/contracts/state.ts'
import { createStateStore } from '../../../src/state/store.ts'
import {
  createTunnelOriginRegistry,
  type TunnelOriginRegistry,
} from '../../../src/http/session-auth.ts'
import { createTunnelSupervisor, type TunnelSupervisor } from '../../../src/tunnel/supervisor.ts'
import { FakeScheduler, makeSupervisorDeps } from '../../support/child-double.ts'
import { FakeClock } from '../../support/clock.ts'
import { createFakeLogger, type FakeLoggerService } from '../../support/ctx-double.ts'
import { makeTempStateDir } from '../../support/state-dir.ts'

export class RealSubprocessHandle {
  readonly child: ChildProcess
  readonly done: Promise<SubprocessOutcome>
  /** Ordem EXATA dos eventos do `ChildProcess`. E a evidencia dos casos SUP-0xx. */
  readonly events: string[] = []
  /** Estado de `child.killed` lido em varios instantes (SUP-011). */
  readonly killedSamples: Array<{ at: string; killed: boolean }> = []

  private terminated = false
  private killTimer: NodeJS.Timeout | undefined
  private readonly graceMs: number

  constructor(spec: SubprocessSpawnSpec) {
    this.graceMs = spec.graceMs
    this.child = nodeSpawn(spec.argv[0] ?? '', spec.argv.slice(1), {
      cwd: spec.cwd,
      // `detached: true` faz do filho o LIDER DO SEU PROPRIO GRUPO (`setsid(2)`).
      // Sem isto, `process.kill(-pid)` falha com ESRCH e o tree-kill nao existe.
      detached: true,
      /**
       * O `stdio` vem do SPEC, e nao fixo aqui — foi a Onda 4 que o obrigou:
       * o worker do Telegram passou a pedir `stdin: 'pipe'` (canal JSONL +
       * dead-man's switch) e o `cloudflared` continua em `'ignore'`. Um assento
       * que ignorasse o campo tornava o teste cego exatamente para a diferenca
       * que a onda introduziu.
       *
       * Modo `collect` nao e suportado por este assento minimo: nenhum consumidor
       * do repositorio o pede, e implementa-lo aqui seria dublar API por dublar.
       */
      stdio: [
        spec.stdio.stdin === 'pipe' ? 'pipe' : 'ignore',
        spec.stdio.stdout === 'pipe' ? 'pipe' : 'ignore',
        spec.stdio.stderr === 'pipe' ? 'pipe' : 'ignore',
      ],
      env: { ...process.env, ...spec.env } as NodeJS.ProcessEnv,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })

    let spawnError: Error | undefined
    let didSpawn = false

    this.child.on('spawn', (): void => {
      didSpawn = true
      this.events.push('spawn')
    })
    this.child.on('exit', (): void => {
      this.events.push('exit')
    })
    this.child.on('error', (error: Error): void => {
      this.events.push('error')
      // "rejects only for spawn-level failures": um erro DEPOIS do `'spawn'`
      // (tipicamente o `AbortError` do sinal) nao e falha de spawn.
      if (!didSpawn) spawnError = error
    })

    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      // >>> TUDO PENDURA AQUI. <<< `'close'` e o unico evento terminal
      // universal: "will always emit after 'exit' was already emitted, or
      // 'error' if the child process failed to spawn".
      this.child.on('close', (code, signal): void => {
        this.events.push('close')
        if (this.killTimer !== undefined) clearTimeout(this.killTimer)
        this.killTimer = undefined
        if (spawnError !== undefined) {
          reject(spawnError)
          return
        }
        resolve({ exitCode: code, signal })
      })
    })
  }

  get pid(): number {
    // `-1` e o valor que o contrato manda publicar quando o spawn falhou.
    return this.child.pid ?? -1
  }

  get stdout(): NodeJS.ReadableStream | undefined {
    return this.child.stdout ?? undefined
  }

  get stderr(): NodeJS.ReadableStream | undefined {
    return this.child.stderr ?? undefined
  }

  /** Presente sse o spec pediu `stdin: 'pipe'` — e o sentido host -> worker. */
  get stdin(): NodeJS.WritableStream | undefined {
    return this.child.stdin ?? undefined
  }

  readonly collected = {}

  sampleKilled(at: string): void {
    this.killedSamples.push({ at, killed: this.child.killed })
  }

  /** `SIGTERM` ao GRUPO -> `graceMs` -> `SIGKILL` ao GRUPO. Idempotente. */
  terminate(): void {
    if (this.terminated) return
    this.terminated = true

    const { pid } = this
    if (pid <= 0) return

    signalGroup(pid, 'SIGTERM')
    this.killTimer = setTimeout(() => {
      signalGroup(pid, 'SIGKILL')
    }, this.graceMs)
    // O temporizador nao pode segurar o event loop do teste depois de tudo feito.
    this.killTimer.unref()
  }

  waitForExit(): Promise<boolean> {
    return this.done.then(
      () => true,
      () => true,
    )
  }

  asHandle(): SubprocessHandle {
    return this as unknown as SubprocessHandle
  }
}

/** `-pid` alveja o GRUPO inteiro. ESRCH significa "ja nao existe": objetivo cumprido. */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    void error
  }
}

/** Servico `ctx.subprocess` assente em processos REAIS. */
export class RealSubprocessService {
  readonly calls: SubprocessSpawnSpec[] = []
  readonly children: RealSubprocessHandle[] = []

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = new RealSubprocessHandle(spec)
    this.calls.push(spec)
    this.children.push(handle)
    return handle.asHandle()
  }

  lastChild(): RealSubprocessHandle {
    const child = this.children.at(-1)
    if (child === undefined) throw new Error('nenhum subprocesso foi criado')
    return child
  }

  /** Rede de seguranca: nenhum teste pode deixar processo vivo atras de si. */
  killAll(): void {
    for (const child of this.children) {
      if (child.pid > 0) signalGroup(child.pid, 'SIGKILL')
    }
  }
}

/** `true` enquanto o pid existir. Usa `kill(pid, 0)`, que nao entrega sinal. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Espera ATIVA e curta por uma condicao. Nenhum teste espera tempo fixo. */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5000, stepMs = 10 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
  return predicate()
}

/* ========================================================================== */
/* Contexto e binarios de teste                                               */
/* ========================================================================== */

/**
 * Contexto minimo com `ctx.subprocess` REAL.
 *
 * Nao se reutiliza `FakeContext` de `test/support/**` porque o campo
 * `subprocess` dele e `readonly` e aponta para o duble em memoria — e o que se
 * quer aqui e precisamente o oposto: processos de verdade.
 */
export function makeRealContext(): {
  ctx: Context
  subprocess: RealSubprocessService
  logger: FakeLoggerService
} {
  const subprocess = new RealSubprocessService()
  const logger = createFakeLogger()
  const ctx = { subprocess, logger } as unknown as Context
  return { ctx, subprocess, logger }
}

/**
 * Escreve um EXECUTAVEL de teste e devolve o caminho.
 *
 * PORQUE UM INVOLUCRO `sh` E NAO `node -e`: `tunnel.binaryPath` e UM caminho, e
 * `buildCloudflaredArgv` poe-no em `argv[0]` seguido dos argumentos FIXOS do
 * `cloudflared`. Nao ha por onde meter "o interpretador mais o script". O
 * involucro faz `exec`, o que PRESERVA O PID — o processo que fica e o `node`,
 * com o nome do script no `argv`, que e o que a varredura de orfao identifica.
 *
 * O nome do ficheiro contem `fake-cloudflared` DE PROPOSITO: e assim que
 * `pgrep -f fake-cloudflared` e `looksLikeCloudflared()` o reconhecem, e e assim
 * que nenhum teste precisa do `cloudflared` verdadeiro (D10).
 */
export function writeExecutableShim(dir: string, name: string, scriptBody: string): string {
  const script = join(dir, `${name}.mjs`)
  writeFileSync(script, scriptBody, 'utf8')

  const shim = join(dir, name)
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, 'utf8')
  chmodSync(shim, 0o700)
  return shim
}

/** Caminho do dublê CONGELADO (`test/bin/fake-cloudflared.mjs`), como executavel. */
export function fakeCloudflaredBinary(dir: string): string {
  const duble = fileURLToPath(new URL('../../bin/fake-cloudflared.mjs', import.meta.url))
  const shim = join(dir, 'fake-cloudflared')
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${duble}' "$@"\n`, 'utf8')
  chmodSync(shim, 0o700)
  return shim
}

/** Diretorio temporario descartavel para os executaveis de teste. */
export function makeBinDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'dsh-guard-bin-'))
  return { path, cleanup: (): void => rmSync(path, { recursive: true, force: true }) }
}

/* ========================================================================== */
/* Harness do supervisor do tunel                                             */
/* ========================================================================== */

/**
 * PORQUE ESTE HARNESS VIVE EM `test/integration/proc/` E NAO EM
 * `test/integration/tunnel/`: a fronteira de T3.1 nomeia os ficheiros de
 * `test/integration/tunnel/` UM A UM (`supervisor`, `ttl`, `probe`, `pidfile`) e
 * concede `test/integration/proc/**` inteiro. Um auxiliar partilhado pelos tres
 * primeiros nao tem, portanto, casa do lado do tunel — e triplicar 60 linhas de
 * montagem seria pior do que a arrumacao imperfeita.
 */

/** Reserva uma porta livre soltando-a a seguir. Nunca uma porta fixa. */
export async function reserveEphemeralPort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('sem porta')
  return address.port
}

export interface TunnelHarness {
  supervisor: TunnelSupervisor
  /** O registo REAL de T3.3, o mesmo que o gate consulta em L2.5. */
  tunnelOrigin: TunnelOriginRegistry
  subprocess: RealSubprocessService
  scheduler: FakeScheduler
  clock: FakeClock
  store: StateStore
  logger: FakeLoggerService
  audited: AuditEvent[]
  notices: string[]
  revocations: number[]
  metricsPort: number
  originPort: number
  dispose(): void
}

export interface TunnelHarnessOptions {
  /** Caminho do executavel. Por omissao, o dublê CONGELADO. */
  binaryPath?: string
  ttlMinutes?: number
  env?: NodeJS.ProcessEnv
  /** Sondas: por omissao todas devolvem 401 (gate armado). */
  probeStatus?: number
}

/**
 * Monta o supervisor do tunel com PROCESSOS REAIS e relogio INJETADO.
 *
 * O `cloudflared` verdadeiro NUNCA entra aqui (D10): o executavel e o dublê
 * congelado, e a origem e um servidor que este proprio harness abriu numa porta
 * efemera — nunca a 3080, nunca uma porta que o teste nao possua.
 */
export async function makeTunnelHarness(options: TunnelHarnessOptions = {}): Promise<TunnelHarness> {
  const { ctx, subprocess, logger } = makeRealContext()
  const scheduler = new FakeScheduler()
  const clock = new FakeClock(1_000)
  const { deps } = makeSupervisorDeps(scheduler, { now: () => clock.now() })

  const stateDir = makeTempStateDir()
  const storeHandle = createStateStore({ paths: { dir: stateDir.path, file: stateDir.statePath } })

  const bin = makeBinDir()
  const binaryPath = options.binaryPath ?? fakeCloudflaredBinary(bin.path)
  const metricsPort = await reserveEphemeralPort()

  const origin = createServer((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()))
  const originAddress = origin.address()
  if (originAddress === null || typeof originAddress === 'string') throw new Error('sem porta')

  const audited: AuditEvent[] = []
  const notices: string[] = []
  const revocations: number[] = []
  const tunnelOrigin = createTunnelOriginRegistry()

  const supervisor = createTunnelSupervisor({
    ctx,
    config: { mode: 'quick', ttlMinutes: options.ttlMinutes ?? 60, binaryPath },
    resolveOrigin: () => origin,
    allocateMetricsPort: () => metricsPort,
    probe: {
      transport: {
        send: (): Promise<{ kind: 'response'; status: number }> =>
          Promise.resolve({ kind: 'response', status: options.probeStatus ?? 401 }),
      },
      newCanaryToken: () => 'canario-de-integracao',
    },
    // Descoberta MINIMA sobre o servidor de metricas REAL do dublê: e ela que
    // prova que a porta que passamos em `--metrics` e a porta que o processo
    // abriu. A implementacao de producao e de T3.2.
    discovery: {
      discover: async (input) => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          try {
            const response = await fetch(`http://127.0.0.1:${String(input.metricsPort)}/quicktunnel`)
            const body = (await response.json()) as { hostname?: string }
            if (typeof body.hostname === 'string') {
              // O endpoint devolve o hostname SEM esquema; prefixar e do consumidor.
              return { url: `https://${body.hostname}`, via: 'metrics' as const }
            }
          } catch (error) {
            void error
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
        throw new Error('a URL nunca apareceu')
      },
    },
    readiness: {
      waitUntilUsable: () => Promise.resolve({ usable: true, status: 401 }),
    },
    store: storeHandle.store,
    tunnelOrigin,
    sessions: { revokeAll: () => revocations.push(clock.now()) },
    audit: { append: (event: AuditEvent) => audited.push(event) },
    notifyOwner: (message: string) => notices.push(message),
    proc: deps,
    warmupTimeoutMs: 5000,
  })

  return {
    supervisor,
    tunnelOrigin,
    subprocess,
    scheduler,
    clock,
    logger,
    store: storeHandle.store,
    audited,
    notices,
    revocations,
    metricsPort,
    originPort: originAddress.port,
    dispose: (): void => {
      supervisor.dispose()
      subprocess.killAll()
      origin.close()
      storeHandle.dispose()
      stateDir.cleanup()
      bin.cleanup()
    },
  }
}
