/**
 * `createWorkerSupervisor` -- ciclo de vida do processo filho de longa duracao,
 * contra o assento REAL (`spawn(spec: SubprocessSpawnSpec) -> SubprocessHandle`).
 *
 * REQUISITO DURO DE CONCORRENCIA (Q-5): nenhuma funcao aqui faz `await` de uma
 * operacao dependente da rede ou do reinicio. O tratador de terminacao e
 * SINCRONO e o reagendamento e *fire-and-forget* via `setTimeout`.
 *
 * DIVERGENCIA DOCUMENTADA -- ORCAMENTO ESGOTADO: a tabela do cliente MCP descreve
 * `reconnect.maxAttempts` como cessando a recuperacao E "desregistando ativamente
 * o plugin". A superficie tipada desta distribuicao NAO expoe auto-desregisto:
 * `Context` oferece `intercept`, `waterfall`, `parallel`, `on`, `effect` e `get`
 * -- nada que remova a propria Fiber. Em vez de inventar API inexistente,
 * implementa-se o que a superficie permite: um ESTADO TERMINAL explicito e
 * observavel (`supervisor.exhausted`) mais um erro inequivoco no log. Ver
 * README.md, "Divergencias assumidas".
 */

import {
  PACKAGED_WORKER_ENTRYPOINT,
  resolveWorkerCwd,
  type Config,
} from '../config/schema.ts'
import type { Context, SubprocessHandle, SubprocessSpawnSpec } from '../dsh/adapter.ts'
import { createGuardLogger, type GuardLogger } from '../logging/logger.ts'
import { redact } from '../logging/redact.ts'
import { computeBackoffDelay } from './backoff.ts'
import { defaultClockDeps, type ClockDeps, type TimerHandle } from './scheduler.ts'
import { buildWorkerEnv } from './env.ts'
import { treeKill, type TreeKillDeps } from './tree-kill.ts'

/* ========================================================================== */
/* Dependencias injetaveis                                                    */
/* ========================================================================== */

/**
 * Tudo o que o supervisor vai buscar ao mundo exterior: o TEMPO
 * ({@link ClockDeps}, de `scheduler.ts`) e o SINAL ({@link TreeKillDeps}, de
 * `tree-kill.ts`). Nenhuma das duas costuras e definida aqui -- o supervisor
 * compoe-as, que e o que ele e.
 */
export interface SupervisorDeps extends ClockDeps, TreeKillDeps {}

/** Dependencias reais (processo Node corrente). */
export const defaultSupervisorDeps: SupervisorDeps = {
  ...defaultClockDeps,
  platform: process.platform,
  kill: (pid: number, signal: NodeJS.Signals): void => {
    process.kill(pid, signal)
  },
}

/* ========================================================================== */
/* Supervisor                                                                 */
/* ========================================================================== */

/** Superficie publica do supervisor. `dispose` e SINCRONO por contrato. */
export interface WorkerSupervisor {
  /** Arranca o worker imediatamente (primeira instanciacao). */
  start(): void
  /** Disposer SINCRONO: cancela reinicio, aborta e faz tree-kill. */
  dispose(): void
  /** Reinicios ja consumidos do orcamento (observabilidade/testes). */
  readonly attempts: number
  /** Estado TERMINAL: `maxAttempts` esgotou e a recuperacao cessou de vez. */
  readonly exhausted: boolean
}

/** Cria o supervisor do processo filho. */
export function createWorkerSupervisor(
  ctx: Context,
  config: Config,
  deps: SupervisorDeps = defaultSupervisorDeps,
): WorkerSupervisor {
  const { worker } = config
  const { backoff } = worker
  const log: GuardLogger = createGuardLogger(ctx)

  /**
   * Um unico AbortController para todo o ciclo de vida: o assento reage-lhe
   * iniciando a escalada de terminacao sobre a ARVORE ("also triggered by the
   * spec's abort signal"), e ele serve tambem de marcador para distinguir
   * "morreu sozinho" de "nos matamo-lo".
   */
  const abortController = new AbortController()

  let handle: SubprocessHandle | undefined
  /** Remove os ouvintes de stream que ESTE supervisor pos no handle corrente. */
  let detachStreamListeners: (() => void) | undefined
  let restartTimer: TimerHandle | undefined
  let attempts = 0
  let disposed = false
  let started = false
  let exhausted = false

  /** Cancela (e esquece) o temporizador de reinicio pendente, se existir. */
  const clearRestartTimer = (): void => {
    if (restartTimer === undefined) return
    deps.scheduler.clearTimeout(restartTimer)
    restartTimer = undefined
  }

  /**
   * Larga o handle corrente: desliga os ouvintes de stream, pede a terminacao ao
   * assento e mata a arvore.
   *
   * PORQUE EXISTE (e nao se limita a `handle = spawned`): sobrepor a variavel sem
   * libertar o valor anterior tirava o filho antigo da contabilidade do disposer.
   * Sondado: com dois `start()`, `filhos=2` mas `kills=[[-222,...]]` -- o
   * primeiro nunca era morto. Chamada UMA VEZ por instancia, o que mantem o
   * `dispose()` idempotente.
   */
  const releaseCurrentHandle = (): void => {
    const current = handle
    handle = undefined

    detachStreamListeners?.()
    detachStreamListeners = undefined

    if (current === undefined) return

    // `terminate()` e idempotente e no-op quando a arvore ja desapareceu.
    current.terminate()
    treeKill(current, { platform: deps.platform, kill: deps.kill })
  }

  const spawnOnce = (): void => {
    if (disposed || abortController.signal.aborted || exhausted) return

    // Substituicao segura: o filho e o temporizador anteriores sao libertados
    // ANTES de existir um novo, para que nunca haja dois fora de contabilidade.
    releaseCurrentHandle()
    clearRestartTimer()

    const startedAt = deps.now()

    /**
     * ARGV: `[command, entrypoint, ...args]` -- o entrypoint e ANTEPOSTO aqui e
     * NAO vem do manifesto. Nao pode vir: um caminho relativo no
     * `cordis.patch.yml` resolveria contra o `cwd` do HOST (o workspace do
     * utilizador) e o absoluto so e conhecido em runtime. As tres decisoes
     * canonicas dizem a mesma frase: *"O `argv` do spawn resolve
     * `dist/worker/telegram-bot.js` relativo a `import.meta.url`, nunca por
     * `cwd`."*
     *
     * `worker.command` e `process.execPath` (o MESMO Node do host, sem depender
     * do `PATH`) e `worker.args` sao argumentos EXTRA, valor normal `[]`. Montar
     * `[command, ...args]` -- como esta linha fazia -- dava, com o manifesto
     * real, `argv: ['/caminho/para/node']`: um REPL do Node, nao o worker.
     */
    const argv: readonly string[] = [worker.command, PACKAGED_WORKER_ENTRYPOINT, ...worker.args]

    // Regista o argv EFETIVO, e nao `command + args`: era a diferenca entre os
    // dois que escondia a ausencia do entrypoint.
    log.info(`Alocando subprocesso isolado de longa duracao: ${argv.join(' ')}`)

    /**
     * ARMADILHA CRITICA, HOJE RESOLVIDA PELO ASSENTO -- registada porque a
     * decisao continua a valer. O tree-kill faz `process.kill(-pid, 'SIGKILL')`,
     * e o `-pid` do POSIX so designa um grupo se o filho for LIDER DO SEU
     * PROPRIO GRUPO, o que exigia `detached: true` (`setsid`). Sem a flag, `-pid`
     * nao correspondia a grupo nenhum, a chamada falhava com ESRCH, o `catch`
     * engolia o erro e o tree-kill NAO ACONTECIA: os netos do worker sobreviviam
     * a transicao da Fiber como zumbis. `SubprocessSpawnSpec` NAO tem campo
     * `detached` e nao precisa: o handle e, por contrato, "a live child process
     * rooted in its own process tree", e a implementacao local faz `detached`
     * para poder sinalizar o grupo. Deixou de ser flag nossa; passou a ser
     * garantia do assento de que dependemos.
     */
    const spec: SubprocessSpawnSpec = {
      argv,
      cwd: resolveWorkerCwd(config),
      // Isolamento dos canais stdio: o worker nao satura o terminal do DSH e
      // stdin fica fechado (um long-poller nao le do operador). `'pipe'` entrega
      // os `Readable` crus, que e o que o encaminhamento para o log usa.
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      // Janela de cortesia da escalada SIGTERM -> grace -> SIGKILL do assento.
      graceMs: worker.graceMs,
      // A intencao de anulacao transita nativamente para a arvore do filho.
      signal: abortController.signal,
      // Ambiente CONSTRUIDO a partir de uma allowlist, nunca herdado inteiro:
      // `process.env` levava `ADMIN_USER`/`ADMIN_PASS` do plano de controlo para
      // dentro do worker. Ver `buildWorkerEnv`.
      env: buildWorkerEnv(process.env, worker.token),
    }

    const spawned = ctx.subprocess.spawn(spec)
    handle = spawned

    // DESARME POR INSTANCIA. `done` e uma unica promessa e so assenta uma vez,
    // pelo que a duplicacao que esta bandeira evitava ('error' + 'exit' na mesma
    // instancia, no `child_process` cru) ja nao e sequer expressavel pelo tipo.
    // Fica como latch barato e para tornar a intencao legivel.
    let settled = false

    // Q-4: o worker e um cliente HTTP do Telegram e a API poe o token DENTRO do
    // caminho do URL. Uma unica mensagem de erro de rede impressa pelo bot punha
    // o token em claro no log do plano de controlo. Ver `src/logging/redact.ts`.
    const onStdout = (chunk: Buffer): void => {
      log.debug(`[Worker STDOUT]: ${redact(chunk.toString().trim(), [worker.token])}`)
    }

    const onStderr = (chunk: Buffer): void => {
      log.warn(`[Worker STDERR]: ${redact(chunk.toString().trim(), [worker.token])}`)
    }

    /**
     * ABSORVEDOR OBRIGATORIO. Um `EventEmitter` que emite `'error'` SEM ouvinte
     * LANCA no processo hospedeiro. Antes o emissor em risco era o
     * `ChildProcess`; agora o handle nao e emissor (a falha viaja em `done`, que
     * tem SEMPRE tratador de rejeicao ligado abaixo) e os emissores em risco sao
     * os dois `Readable` -- um EPIPE neles derrubava o DSH inteiro. NAO sao
     * removidos no desarme, exatamente como o anterior nao era.
     */
    const absorbStreamError = (error: Error): void => {
      log.debug(`[Worker STREAM]: ${error.message}`)
    }

    /**
     * Caminho UNICO de terminacao: a saida normal (`done` resolve) e a falha de
     * spawn (`done` rejeita).
     *
     * PORQUE UNIFICADO: antes so se escutava `'exit'`. Com `command` ou `cwd`
     * inexistente o `child_process` emitia `error(ENOENT) -> close(code=-2)` e
     * nunca `'exit'` -- medido: uma linha de log e o worker PERMANENTEMENTE
     * morto, sem reinicio, sem consumir `maxAttempts` e sem sinal ao operador. O
     * assento colapsa os dois casos numa promessa, e ambos percorrem o mesmo
     * caminho de backoff/orcamento.
     */
    const handleTermination = (description: string): void => {
      if (settled) return
      settled = true

      detachStreamListeners?.()
      detachStreamListeners = undefined

      // Desligamento intencional (disposer ja correu, ou o sinal de abort ja foi
      // emitido): a Fiber esta a ser descartada, NAO se reinicia nada.
      if (disposed || abortController.signal.aborted) {
        log.info('Worker terminado a pedido do disposer; sem reinicio.')
        return
      }

      /**
       * Este handle ja foi substituido: a sua morte pertence ao ciclo anterior.
       * Sem esta guarda, um filho largado por `releaseCurrentHandle()` levava
       * consigo uma tentativa do orcamento e agendava um SEGUNDO reinicio,
       * ficando dois workers vivos. Com um unico gatilho (a propria terminacao) a
       * guarda quase nunca dispara; existe para o gatilho INDEPENDENTE que a Onda
       * 5 acrescenta (reinicio por intencao, `/ligar`), e o teste exercita-a
       * assim -- segundo `spawnOnce` sem terminacao do primeiro.
       */
      if (handle !== spawned) return

      // Uptime saudavel zera o orcamento: uma falha isolada ao fim de horas nao
      // deve gastar o orcamento reservado a crash-loops.
      const uptimeMs = deps.now() - startedAt
      if (uptimeMs >= backoff.resetAfterMs) attempts = 0

      attempts += 1

      if (attempts > backoff.maxAttempts) {
        // Orcamento finito esgotado: cessa-se a recuperacao e entra-se em ESTADO
        // TERMINAL (ver a divergencia no cabecalho deste ficheiro). Falhar alto e
        // visivelmente e melhor do que reiniciar para sempre em silencio.
        exhausted = true
        log.error(
          `Orcamento de reinicios esgotado (${backoff.maxAttempts}). ${description} ` +
            'Recuperacao automatica CESSADA em definitivo (estado terminal): ' +
            'o worker NAO volta a arrancar ate o plugin ser recarregado a mao. ' +
            'Esta distribuicao do Cordis nao expoe auto-desregisto do plugin.',
        )
        return
      }

      const delayMs = computeBackoffDelay(attempts, backoff, deps.random)

      log.warn(
        `${description} Reinicio ${attempts}/${backoff.maxAttempts} ` +
          `agendado para daqui a ${delayMs} ms.`,
      )

      // RE-VERIFICACAO IMEDIATAMENTE ANTES DE AGENDAR. `disposed` foi lido no
      // inicio deste tratador, mas entre esse instante e este ha logging (e, num
      // host real, ouvintes de terceiros) que pode desencadear o descarte da
      // Fiber. Sem esta segunda leitura, o disposer ja teria feito o seu
      // `clearTimeout` e mesmo assim ficaria um temporizador vivo a ressuscitar o
      // worker depois de DISPOSED.
      if (disposed || abortController.signal.aborted) return

      /**
       * REAGENDAMENTO FIRE-AND-FORGET -- e AQUI que mora o requisito duro (Q-5).
       * Este tratador retorna IMEDIATAMENTE: nunca `await sleep(...)`, nunca
       * espera pelo worker dentro de um ouvinte do Cordis. `ctx.parallel` aguarda
       * o retorno EXAUSTIVO de todos os subscritores e `ctx.waterfall` bloqueia a
       * cascata inteira -- reter um retorno a espera da rede congela o subsistema
       * e interrompe o ciclo de deducao do agente. (Precedente no proprio DSH: o
       * downlink em SSE esgotava as ~6 sessoes por origem do HTTP/1.1; a correcao
       * foi migrar para um WebSocket dedicado.)
       *
       * O handle e guardado e o disposer faz `clearTimeout` -- de outro modo,
       * descarregar o plugin deixaria um temporizador pendurado a ressuscitar o
       * worker depois da Fiber ja estar DISPOSED.
       */
      clearRestartTimer()
      restartTimer = deps.scheduler.setTimeout((): void => {
        restartTimer = undefined
        spawnOnce()
      }, delayMs)
    }

    detachStreamListeners = (): void => {
      spawned.stdout?.removeListener('data', onStdout)
      spawned.stderr?.removeListener('data', onStderr)
    }

    spawned.stdout?.on('data', onStdout)
    spawned.stderr?.on('data', onStderr)
    spawned.stdout?.on('error', absorbStreamError)
    spawned.stderr?.on('error', absorbStreamError)

    void spawned.done.then(
      (outcome): void => {
        handleTermination(
          `Worker encerrado (code=${String(outcome.exitCode)} signal=${String(outcome.signal)}).`,
        )
      },
      (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error)

        // Anulacao intencional: registar isto como `logger.error` produzia um
        // erro FALSO em cada desligamento limpo do plugin -- ruido que treina o
        // operador a ignorar erros a serio.
        if (disposed || abortController.signal.aborted) {
          log.debug(`Worker abortado a pedido do disposer: ${message}`)
          handleTermination('Anulacao intencional.')
          return
        }

        log.error(`Falha na costura de subprocesso: ${message}`)
        handleTermination(`Falha ao alocar o worker: ${message}.`)
      },
    )
  }

  /**
   * Arranque UNICO. `start()` repetido nao instancia um segundo worker: o ciclo
   * de vida deste supervisor tem exatamente um filho vivo de cada vez, e a
   * reentrancia acidental (dois `ctx.effect`, um `start()` manual em cima do
   * arranque do `apply`) deixava o primeiro filho fora de qualquer disposer.
   */
  const start = (): void => {
    if (started) {
      log.warn('start() repetido ignorado: o supervisor ja tem um worker.')
      return
    }
    started = true
    spawnOnce()
  }

  const dispose = (): void => {
    // Reentrancia: o Cordis nao repete disposers, mas um `dispose()` manual
    // seguido do descarte da Fiber e cenario plausivel. Tudo o que se segue corre
    // UMA so vez, pelo que chamar o disposer 2x ou 3x nao lanca nem mata duas
    // vezes de forma observavel.
    if (disposed) return
    disposed = true

    log.info('Descarregando o plugin; abortando processo filho...')

    // (a) Cancelar o reinicio pendente ANTES de matar, para nao correr o risco de
    //     o temporizador disparar entre o kill e o fim do disposer.
    clearRestartTimer()

    // (b) O sinal de abort inicia, no assento, a escalada de terminacao sobre a
    //     arvore, e marca para o tratador de terminacao que a saida foi
    //     intencional.
    abortController.abort()

    // (c) Tree-kill de ultima instancia. NAO se espera por `waitForExit()`: o
    //     disposer e sincrono por regra do projeto (Q-2). O host TOLERA
    //     disposers assincronos ("they may be async, in which case unloading
    //     awaits them"); nos nao usamos essa tolerancia.
    releaseCurrentHandle()
  }

  return {
    start,
    dispose,
    get attempts(): number {
      return attempts
    },
    get exhausted(): boolean {
      return exhausted
    },
  }
}
