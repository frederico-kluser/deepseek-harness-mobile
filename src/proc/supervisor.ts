/**
 * =============================================================================
 * O UNICO ciclo de vida de processo longo do repositorio.
 * =============================================================================
 *
 * `createProcessSupervisor` supervisiona QUALQUER processo de longa duracao
 * contra o assento REAL (`spawn(spec: SubprocessSpawnSpec) -> SubprocessHandle`).
 * O worker do Telegram (`./worker.ts`) e o `cloudflared`
 * (`../tunnel/supervisor.ts`) sao duas INSTANCIACOES desta funcao, nao duas
 * copias dela.
 *
 * PORQUE GENERALIZAR E NAO DUPLICAR (pergunta falsificavel 1 de T3.1): se
 * ficarem dois blocos de backoff no repositorio, a generalizacao e ficticia — a
 * correccao seguinte entra num e nao no outro, e o supervisor que ficar para tras
 * volta a ter o bug que o outro ja nao tem. A decisao de orcamento e backoff vive
 * inteira em `./retry.ts`, e so la: `grep -rn 'computeBackoffDelay' src` mostra a
 * definicao (`./backoff.ts`) e UMA chamada (`./retry.ts`).
 *
 * O QUE ESTE FICHEIRO E, entao: a composicao. Ele sabe fazer `spawn`, largar um
 * handle matando a arvore, ligar os streams ao log, e distinguir "morreu sozinho"
 * de "nos matamo-lo". Tudo o resto e de outro modulo.
 *
 * REQUISITO DURO DE CONCORRENCIA (Q-5): nenhuma funcao aqui faz `await` de uma
 * operacao dependente da rede ou do reinicio. O tratador de terminacao e
 * SINCRONO e o reagendamento e *fire-and-forget* via `setTimeout`.
 *
 * DIVERGENCIA DOCUMENTADA -- EVENTO TERMINAL: toda a logica pendura no FECHO do
 * processo, nunca na saida. No `child_process` cru isso e `'close'`; aqui e a
 * promessa `done` do assento, que colapsa `'exit'` e `'error'` num so caminho.
 * Medido (`08-PESQUISA-E-FONTES.md`, facto 520): num `ENOENT` a sequencia e
 * `error -> close` e `'exit'` NUNCA dispara — `child.pid === undefined`,
 * `child.killed === false`, `close` recebe `(-2, null)`. Um supervisor que espera
 * por `'exit'` trava para sempre no modo de falha mais comum (binario ausente /
 * PATH errado). E `'spawn'` NAO e readiness: a doc do Node avisa que ele dispara
 * "regardless of whether an error occurs within the spawned process".
 *
 * A divergencia do ORCAMENTO ESGOTADO (estado terminal observavel em vez do
 * auto-desregisto que a API do Cordis nao oferece) esta em `./retry.ts`, junto do
 * codigo que a implementa. A divergencia do TREE-KILL (a guarda `!child.killed`
 * que tornava o kill do grupo codigo morto) esta em `./tree-kill.ts`.
 * =============================================================================
 */

import type { BackoffConfig } from '../config/schema.ts'
import type { Context, SubprocessHandle, SubprocessSpawnSpec } from '../dsh/adapter.ts'
import { createGuardLogger, type GuardLogger } from '../logging/logger.ts'
import { redact } from '../logging/redact.ts'
import { classifyNonRetryable, type ProcessFailure } from './failure.ts'
import { createRestartBudget, type RestartBudgetHooks } from './retry.ts'
import { defaultClockDeps, type ClockDeps } from './scheduler.ts'
import { attachStreamLogging } from './stream-log.ts'
import { treeKill, type TreeKillDeps } from './tree-kill.ts'

export { createWorkerSupervisor, type WorkerSupervisor } from './worker.ts'

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
/* O que distingue um processo supervisionado de outro                        */
/* ========================================================================== */

/** Ganchos do ciclo de vida. Todos SINCRONOS, por Q-5. */
export interface SupervisedProcessHooks extends RestartBudgetHooks {
  /** Corre logo apos cada `spawn`. E aqui que o pid vai para o pidfile. */
  onSpawned?(handle: SubprocessHandle): void
}

/** Descricao completa de um processo a supervisionar. */
export interface SupervisedProcess extends SupervisedProcessHooks {
  /**
   * Nome CURTO, para o log e para a mensagem accionavel (`'worker'`,
   * `'cloudflared'`). NUNCA o `argv`: o `argv` traz caminhos absolutos e a
   * mensagem de falha pode ser mostrada ao dono.
   */
  readonly name: string
  readonly backoff: BackoffConfig
  /**
   * Monta o spec de UMA tentativa. E chamado a cada `spawn`, e nao uma vez, para
   * que um valor que muda entre tentativas (uma porta de metricas nova, a posse
   * do servidor de origem) seja resolvido no instante em que e usado.
   *
   * Lancar `SpawnSpecError` aqui e recusar a configuracao: o supervisor entra em
   * estado terminal `INVALID_SPEC` e NAO faz `spawn` nenhum.
   */
  buildSpec(signal: AbortSignal): SubprocessSpawnSpec
  /**
   * Segredos a redigir das linhas de stdout/stderr encaminhadas para o log.
   *
   * FORNECEDOR e nao lista, pela mesma razao que `openAuditLog` o e: o conjunto
   * muda DEPOIS do arranque. Ver {@link StreamLogOptions.secrets}.
   */
  readonly secrets?: (() => readonly string[]) | undefined
}

/* ========================================================================== */
/* Supervisor                                                                 */
/* ========================================================================== */

/** Superficie publica do supervisor. `dispose` e SINCRONO por contrato (Q-2). */
export interface ProcessSupervisor {
  /** Arranca o processo imediatamente (primeira instanciacao). */
  start(): void
  /**
   * REINICIO POR INTENCAO: derruba a instancia corrente e reagenda pelo MESMO
   * caminho de orcamento e backoff da terminacao espontanea.
   *
   * PORQUE ESTA NA SUPERFICIE GENERICA e nao no consumidor: o tunel precisa dele
   * quando o warmup falha (o processo esta vivo mas a URL nunca apareceu) e a
   * Onda 5 precisa dele para o `/ligar` explicito. Se cada consumidor o
   * implementasse, cada um teria a SUA contagem e `maxAttempts` deixaria de
   * significar alguma coisa.
   */
  restart(reason: string): void
  /** Disposer SINCRONO: cancela reinicio, aborta e faz tree-kill. */
  dispose(): void
  /** Reinicios ja consumidos do orcamento (observabilidade/testes). */
  readonly attempts: number
  /** Estado TERMINAL: a recuperacao cessou de vez. */
  readonly exhausted: boolean
  /** Causa do estado terminal, quando ha um. */
  readonly failure: ProcessFailure | undefined
  /** Sinal do ciclo de vida: abortado no disposer. */
  readonly signal: AbortSignal
}

/** Cria o supervisor de um processo longo. */
export function createProcessSupervisor(
  ctx: Context,
  target: SupervisedProcess,
  deps: SupervisorDeps = defaultSupervisorDeps,
): ProcessSupervisor {
  const { name } = target
  const log: GuardLogger = createGuardLogger(ctx)
  const secrets = (): readonly string[] => target.secrets?.() ?? []

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
  let disposed = false
  let started = false
  /** Instante do `spawn` da instancia corrente. Base do calculo de uptime. */
  let currentStartedAt = 0

  const isCancelled = (): boolean => disposed || abortController.signal.aborted

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

  const budget = createRestartBudget({
    name,
    backoff: target.backoff,
    scheduler: deps.scheduler,
    random: deps.random,
    log,
    hooks: target,
    isCancelled,
    runAttempt: (): void => {
      spawnOnce()
    },
  })

  function spawnOnce(): void {
    if (isCancelled() || budget.exhausted) return

    // Substituicao segura: o filho e o temporizador anteriores sao libertados
    // ANTES de existir um novo, para que nunca haja dois fora de contabilidade.
    releaseCurrentHandle()
    budget.cancelPending()

    const startedAt = deps.now()
    currentStartedAt = startedAt

    let spec: SubprocessSpawnSpec
    try {
      // O spec e montado A CADA tentativa, com o `signal` do ciclo de vida: a
      // intencao de anulacao transita nativamente para a arvore do filho.
      spec = target.buildSpec(abortController.signal)
    } catch (error) {
      // Recusa de CONFIGURACAO, antes de existir processo nenhum. Nao consome
      // orcamento: tentar de novo com a mesma configuracao da o mesmo resultado.
      // `conclude` trata isto como nao-retryable e entra em estado terminal.
      const detail = error instanceof Error ? error.message : String(error)
      log.error(`Nao foi possivel montar o arranque de ${name}: ${redact(detail, secrets())}`)
      budget.conclude(`Arranque de ${name} recusado na montagem do spec.`, coerceSpecError(error), 0)
      return
    }

    // Regista o argv EFETIVO, e nao `command + args`: era a diferenca entre os
    // dois que escondia a ausencia do entrypoint no supervisor do worker.
    log.info(`Alocando subprocesso isolado de longa duracao: ${redact(spec.argv.join(' '), secrets())}`)

    const spawned = ctx.subprocess.spawn(spec)
    handle = spawned

    // DESARME POR INSTANCIA. `done` e uma unica promessa e so assenta uma vez,
    // pelo que a duplicacao que esta bandeira evitava ('error' + 'exit' na mesma
    // instancia, no `child_process` cru) ja nao e sequer expressavel pelo tipo.
    // Fica como latch barato e para tornar a intencao legivel.
    let settled = false

    /**
     * Caminho UNICO de terminacao: a saida normal (`done` resolve) e a falha de
     * spawn (`done` rejeita).
     *
     * PORQUE UNIFICADO: antes so se escutava `'exit'`. Com `command` ou `cwd`
     * inexistente o `child_process` emitia `error(ENOENT) -> close(code=-2)` e
     * nunca `'exit'` -- medido: uma linha de log e o processo PERMANENTEMENTE
     * morto, sem reinicio, sem consumir `maxAttempts` e sem sinal ao operador.
     */
    const handleTermination = (description: string, cause?: unknown): void => {
      if (settled) return
      settled = true

      detachStreamListeners?.()
      detachStreamListeners = undefined

      // Desligamento intencional (disposer ja correu, ou o sinal de abort ja foi
      // emitido): a Fiber esta a ser descartada, NAO se reinicia nada.
      if (isCancelled()) {
        log.info(`${name} terminado a pedido do disposer; sem reinicio.`)
        target.onTerminated?.({ description, willRetry: false })
        return
      }

      /**
       * Este handle ja foi substituido: a sua morte pertence ao ciclo anterior.
       * Sem esta guarda, um filho largado por `releaseCurrentHandle()` levava
       * consigo uma tentativa do orcamento e agendava um SEGUNDO reinicio,
       * ficando dois processos vivos. E tambem o que torna `restart()` seguro.
       */
      if (handle !== spawned) return

      budget.conclude(description, cause, deps.now() - startedAt)
    }

    /**
     * O CONSUMIDOR DURAVEL DOS STREAMS, e a ordem em que ele aparece e contrato.
     *
     * Ele e ligado AQUI -- antes de `onSpawned`, portanto antes de qualquer
     * leitor oportunista que o gancho instale -- e so e desligado em
     * `handleTermination` (fecho do processo) ou em `releaseCurrentHandle()`
     * (substituicao/disposer). Nunca ha, entre o `spawn` e o fecho, um instante
     * em que ninguem esteja a drenar.
     *
     * PORQUE ISSO E UM REQUISITO E NAO UMA CONVENIENCIA: `TunnelDiscovery`
     * (`../tunnel/discover.ts`) le `stderr` como leitor OPORTUNISTA -- poe e
     * tira so o listener dele, e nao faz `resume()` ao sair, para nao descartar
     * em silencio o log de arranque que ESTE consumidor tem de registar. Se o
     * unico leitor fosse o dele, o `stderr` ficava sem quem o drenasse assim que
     * a URL aparecesse.
     *
     * MEDIDO nesta arvore: um filho que escreve em `stderr` sem leitor para de
     * progredir depois de 190 464 bytes (buffer do pipe do SO, 64 KiB por
     * omissao no Linux, mais a fila interna do Node). Um `cloudflared` verboso
     * enche isso e CONGELA no `write` -- sem erro, sem log e sem sinal.
     */
    detachStreamListeners = attachStreamLogging(spawned, { name, log, secrets })

    // O gancho corre DEPOIS de os ouvintes estarem ligados e ANTES de qualquer
    // terminacao poder ser observada: e onde o pid entra no pidfile e onde o
    // `stderr` e entregue a descoberta de URL.
    target.onSpawned?.(spawned)

    void spawned.done.then(
      (outcome): void => {
        handleTermination(
          `${name} encerrado (code=${String(outcome.exitCode)} signal=${String(outcome.signal)}).`,
        )
      },
      (error: unknown): void => {
        const message = redact(error instanceof Error ? error.message : String(error), secrets())

        // Anulacao intencional: registar isto como `logger.error` produzia um
        // erro FALSO em cada desligamento limpo do plugin -- ruido que treina o
        // operador a ignorar erros a serio.
        if (isCancelled()) {
          log.debug(`${name} abortado a pedido do disposer: ${message}`)
          handleTermination('Anulacao intencional.')
          return
        }

        log.error(`Falha na costura de subprocesso: ${message}`)
        handleTermination(`Falha ao alocar o ${name}: ${message}.`, error)
      },
    )
  }

  /**
   * Arranque UNICO. `start()` repetido nao instancia um segundo processo: o ciclo
   * de vida deste supervisor tem exatamente um filho vivo de cada vez, e a
   * reentrancia acidental (dois `ctx.effect`, um `start()` manual em cima do
   * arranque do `apply`) deixava o primeiro filho fora de qualquer disposer.
   */
  const start = (): void => {
    if (started) {
      log.warn('start() repetido ignorado: o supervisor ja tem um processo.')
      return
    }
    started = true
    spawnOnce()
  }

  const restart = (reason: string): void => {
    if (isCancelled() || budget.exhausted || !started) return

    // A instancia corrente e derrubada ANTES de se decidir o reinicio: sem isto
    // ficariam dois processos vivos assim que o temporizador disparasse. A morte
    // dela, quando chegar, cai na guarda `handle !== spawned` e nao conta duas vezes.
    releaseCurrentHandle()
    budget.conclude(reason, undefined, deps.now() - currentStartedAt)
  }

  const dispose = (): void => {
    // Reentrancia: o Cordis nao repete disposers, mas um `dispose()` manual
    // seguido do descarte da Fiber e cenario plausivel. Tudo o que se segue corre
    // UMA so vez, pelo que chamar o disposer 2x ou 3x nao lanca nem mata duas
    // vezes de forma observavel.
    if (disposed) return
    disposed = true

    log.info(`Descarregando o plugin; abortando ${name}...`)

    // (a) Cancelar o reinicio pendente ANTES de matar, para nao correr o risco de
    //     o temporizador disparar entre o kill e o fim do disposer.
    budget.cancelPending()

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
    restart,
    dispose,
    signal: abortController.signal,
    get attempts(): number {
      return budget.attempts
    },
    get exhausted(): boolean {
      return budget.exhausted
    },
    get failure(): ProcessFailure | undefined {
      return budget.failure
    },
  }
}

/**
 * Garante que um erro vindo do construtor de spec chega ao orcamento como
 * NAO-RETRYABLE.
 *
 * PORQUE NAO SE CONFIA SO NO TIPO: `buildSpec` e codigo do consumidor e pode
 * lancar um `TypeError` por defeito de programacao. Um defeito de programacao
 * tambem nao melhora na tentativa seguinte — reiniciar dez vezes um spec que nao
 * compila e so ruido. O que muda e a mensagem, e por isso a classificacao
 * original e preservada quando existe.
 */
function coerceSpecError(error: unknown): unknown {
  if (classifyNonRetryable(error) !== undefined) return error
  const detail = error instanceof Error ? error.message : String(error)
  return Object.assign(new Error(detail), { code: 'EINVAL', cause: error, __spec: true })
}
