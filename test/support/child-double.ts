/**
 * DUBLES DO CICLO DE VIDA DE PROCESSO: `SubprocessHandle`, o servico
 * `ctx.subprocess` e o agendador injetavel.
 *
 * CASA TEMPORARIA -- o layout canonico poe isto em `test/support/**`, que e
 * PREP-OWNED e so existe a partir do COMMIT PREP 2. Ficheiro sem sufixo
 * `.test.ts`: nao e executado como suite.
 */

import { PassThrough } from 'node:stream'

import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '../../src/dsh/adapter.ts'
import type { Scheduler, TimerHandle } from '../../src/proc/scheduler.ts'
import type { SupervisorDeps } from '../../src/proc/supervisor.ts'

/**
 * Duble de `SubprocessHandle` FIEL ao assento real no que interessa ao ciclo de
 * vida.
 *
 * PORQUE ISTO IMPORTA (achado A-HIGH): a versao anterior deste duble tinha
 * `killed = false` fixo e IGNORAVA o `AbortSignal`. A suite exercitava assim um
 * estado que NAO EXISTE em producao, e o teste do tree-kill passava apenas
 * porque o duble mentia -- prova por mutacao: remover a guarda `current.killed`
 * do disposer deixava 49/49 testes a passar, apesar de essa guarda tornar o
 * tree-kill codigo morto e deixar netos orfaos.
 *
 * O assento real ja nem sequer expoe `killed`, `kill()`, `on()` ou
 * `removeListener()`: o que o duble antigo modelava era um `ChildProcess` do
 * `node:child_process`, e nao a superficie publicada. O que o assento faz de
 * verdade, e que este duble replica:
 *   - o `AbortSignal` do spec inicia a terminacao ("also triggered by the spec's
 *     abort signal"), pelo que abortar CHAMA `terminate()`;
 *   - `terminate()` e idempotente e tree-scoped em todas as plataformas;
 *   - `done` resolve com os factos de saida e REJEITA apenas em falha de spawn.
 *
 * O que NAO se replica (de proposito): a resolucao automatica de `done`, que no
 * assento real depende do processo. Cada teste chama `settle()`/`fail()` quando
 * quer -- tal como o duble anterior obrigava a emitir `'exit'` a mao.
 */
export class FakeSubprocessHandle {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  /**
  * `stdin` do filho: um pipe REAL, para o sentido host -> worker ser
  * observavel (a EMENDA-COSTURA-5 envia pairing.owner no boot — 8c). O
  * assento real entrega `Readable | Writable`; aqui um PassThrough acumula o
  * que o host escreve.
  */
  readonly stdin = new PassThrough()
  /** Linhas JSONL que o host escreveu no stdin (observabilidade do duble). */
  readonly stdinLines: string[] = []
  readonly collected = {}
  readonly done: Promise<SubprocessOutcome>
  /** Chamadas a `terminate()` (observabilidade do duble). */
  terminateCalls = 0

  private settleDone!: (outcome: SubprocessOutcome) => void
  private failDone!: (error: unknown) => void
  private isSettled = false

  readonly pid: number

  // Campo a mao, nao "parameter property": `node --test` corre `.ts` em
  // strip-only mode e essa sintaxe emite codigo.
  constructor(pid: number, signal?: AbortSignal | undefined) {
    this.pid = pid
    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      this.settleDone = resolve
      this.failDone = reject
    })

    signal?.addEventListener('abort', (): void => {
      this.terminate()
    })
    this.stdin.on('data', (chunk: Buffer) => {
      for (const linha of chunk.toString('utf8').split('\n')) {
        if (linha.trim() !== '') this.stdinLines.push(linha)
      }
    })
  }

  terminate(): void {
    this.terminateCalls += 1
  }

  waitForExit(): Promise<boolean> {
    return this.done.then(
      () => true,
      () => true,
    )
  }

  /** O processo fechou com estes factos de saida. */
  settle(outcome: SubprocessOutcome): void {
    if (this.isSettled) return
    this.isSettled = true
    this.settleDone(outcome)
  }

  /** Falha de nivel de spawn: `done` REJEITA (nunca resolve). */
  fail(error: unknown): void {
    if (this.isSettled) return
    this.isSettled = true
    this.failDone(error)
  }

  asHandle(): SubprocessHandle {
    return this as unknown as SubprocessHandle
  }
}

/** Duble do servico abstrato `ctx.subprocess` (`SubprocessRuntime`). */
export class FakeSubprocessService {
  /** pid atribuido aos filhos criados. `-1` e o valor de "o spawn falhou". */
  pid = -1
  readonly calls: SubprocessSpawnSpec[] = []
  readonly children: FakeSubprocessHandle[] = []

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const child = new FakeSubprocessHandle(this.pid, spec.signal)
    this.calls.push(spec)
    this.children.push(child)
    return child.asHandle()
  }

  lastChild(): FakeSubprocessHandle {
    const child = this.children[this.children.length - 1]
    if (child === undefined) throw new Error('nenhum subprocesso foi criado')
    return child
  }
}

/* ========================================================================== */
/* Agendador falso                                                            */
/* ========================================================================== */

export interface ScheduledTask {
  id: number
  delayMs: number
  callback: () => void
  cleared: boolean
  /** Ja disparou. Um temporizador que disparou deixou de estar VIVO. */
  fired: boolean
}

export class FakeScheduler implements Scheduler {
  readonly scheduled: ScheduledTask[] = []
  readonly clearedIds: number[] = []
  private nextId = 1

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const task: ScheduledTask = { id: this.nextId++, delayMs, callback, cleared: false, fired: false }
    this.scheduled.push(task)
    return task
  }

  clearTimeout(handle: TimerHandle): void {
    const task = handle as ScheduledTask
    task.cleared = true
    this.clearedIds.push(task.id)
  }

  /** Temporizadores VIVOS: agendados, por cancelar e ainda por disparar. */
  get pending(): ScheduledTask[] {
    return this.scheduled.filter((task) => !task.cleared && !task.fired)
  }

  runLast(): void {
    const task = this.scheduled[this.scheduled.length - 1]
    if (task === undefined) throw new Error('nenhuma tarefa agendada')
    if (task.cleared) throw new Error('tarefa ja cancelada')
    task.fired = true
    task.callback()
  }

  delays(): number[] {
    return this.scheduled.map((task) => task.delayMs)
  }
}

export function makeSupervisorDeps(
  scheduler: FakeScheduler,
  overrides: Partial<SupervisorDeps> = {},
): { deps: SupervisorDeps; kills: Array<[number, string]>; clock: { value: number } } {
  const kills: Array<[number, string]> = []
  const clock = { value: 0 }

  const deps: SupervisorDeps = Object.assign(
    {
      scheduler,
      // `random() === 0` e o caso determinista da PROGRESSAO NOMINAL: o jitter e
      // somado POR CIMA da base (piso = initialDelayMs), em vez de subtraido dela
      // (piso = initialDelayMs/2).
      random: (): number => 0,
      now: (): number => clock.value,
      platform: 'linux' as NodeJS.Platform,
      kill: (pid: number, signal: NodeJS.Signals): void => {
        kills.push([pid, signal])
      },
    },
    overrides,
  )

  return { deps, kills, clock }
}
