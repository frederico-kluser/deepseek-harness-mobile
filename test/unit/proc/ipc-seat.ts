/**
 * DUBLE DE SUBPROCESSO COM `stdin`, para os testes do canal IPC.
 * Ficheiro sem sufixo `.test.ts`: nao e executado como suite.
 *
 * PORQUE NAO SE REUTILIZA `test/support/child-double.ts`: o duble de la tem
 * `readonly stdin = undefined`, porque ate a Onda 3 nenhum processo do
 * repositorio pedia `stdin: 'pipe'`. `test/support/**` e PREP-OWNED (leitura
 * livre, escrita proibida), e o canal JSONL nao pode ser exercitado contra um
 * handle que nao tem o sentido host -> worker. Este duble e a versao minima que
 * o tem — e continua fiel ao assento real no que interessa:
 *
 *   - `stdin` presente SSE o spec pediu `'pipe'` ("present iff spawned with
 *     `stdin: 'pipe'`"), o que torna a REGRESSAO do `stdio` observavel: voltar a
 *     `'ignore'` deixa o canal sem saida e os testes gritam;
 *   - o `AbortSignal` do spec inicia a terminacao;
 *   - `done` so assenta quando o teste manda.
 */

import { PassThrough } from 'node:stream'

import type {
  Context,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '../../../src/dsh/adapter.ts'
import { createFakeLogger, type FakeLoggerService } from '../../support/ctx-double.ts'

export class HandleComStdio {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  /** Presente SSE o spec pediu `stdin: 'pipe'` — igual ao assento publicado. */
  readonly stdin: PassThrough | undefined
  readonly collected = {}
  readonly done: Promise<SubprocessOutcome>
  readonly pid: number

  terminateCalls = 0

  private settleDone!: (outcome: SubprocessOutcome) => void
  private isSettled = false

  // Campos a mao, nao "parameter properties": strip-only mode recusa a sintaxe.
  constructor(pid: number, spec: SubprocessSpawnSpec) {
    this.pid = pid
    this.stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
    this.done = new Promise<SubprocessOutcome>((resolve) => {
      this.settleDone = resolve
    })
    spec.signal?.addEventListener('abort', (): void => {
      this.terminate()
    })
  }

  terminate(): void {
    this.terminateCalls += 1
  }

  waitForExit(): Promise<boolean> {
    return this.done.then(() => true)
  }

  settle(outcome: SubprocessOutcome): void {
    if (this.isSettled) return
    this.isSettled = true
    this.settleDone(outcome)
  }

  /** O que o host escreveu no `stdin` do filho, desde a ultima leitura. */
  recebido(): string {
    return this.stdin?.read()?.toString() ?? ''
  }

  /** O worker "diz" isto pelo `stdout`. */
  diz(texto: string): void {
    this.stdout.write(texto)
  }

  asHandle(): SubprocessHandle {
    return this as unknown as SubprocessHandle
  }
}

export class ServicoComStdio {
  pid = 4242
  readonly calls: SubprocessSpawnSpec[] = []
  readonly children: HandleComStdio[] = []

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const child = new HandleComStdio(this.pid, spec)
    this.calls.push(spec)
    this.children.push(child)
    return child.asHandle()
  }

  lastChild(): HandleComStdio {
    const child = this.children.at(-1)
    if (child === undefined) throw new Error('nenhum subprocesso foi criado')
    return child
  }
}

export interface ContextoComStdio {
  ctx: Context
  subprocess: ServicoComStdio
  logger: FakeLoggerService
}

/** Contexto minimo: o supervisor generico so usa `ctx.subprocess` e `ctx.logger`. */
export function makeContextoComStdio(): ContextoComStdio {
  const subprocess = new ServicoComStdio()
  const logger = createFakeLogger()
  return { ctx: { subprocess, logger } as unknown as Context, subprocess, logger }
}
