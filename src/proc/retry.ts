/**
 * =============================================================================
 * O UNICO BLOCO DE ORCAMENTO E BACKOFF DO REPOSITORIO.
 * =============================================================================
 *
 * "Uma tentativa acabou. O que se faz agora?" — sair de vez (causa nao-retryable
 * ou orcamento esgotado) ou reagendar com recuo exponencial.
 *
 * PORQUE E UM MODULO PROPRIO, e nao codigo dentro do supervisor: a pergunta
 * falsificavel de T3.1 e literalmente *"o supervisor foi generalizado ou
 * duplicado? Se ha dois blocos de backoff no repositorio, a generalizacao e
 * ficticia."* Com a decisao isolada aqui, a verificacao vira um comando:
 * `grep -rn 'computeBackoffDelay' src` mostra a DEFINICAO (`./backoff.ts`) e uma
 * UNICA chamada (este ficheiro). O worker do Telegram e o `cloudflared` partilham
 * este contador; nao ha um segundo sitio onde uma correccao possa faltar.
 *
 * PARTILHA ENTRE OS DOIS GATILHOS: a terminacao ESPONTANEA e o reinicio POR
 * INTENCAO (`ProcessSupervisor.restart`) chamam ambos {@link RestartBudget.conclude}.
 * Se o segundo tivesse contagem propria, `maxAttempts` deixaria de significar
 * alguma coisa: um ciclo de reinicios por intencao correria para sempre sem nunca
 * esgotar orcamento nenhum.
 */

import type { BackoffConfig } from '../config/schema.ts'
import type { GuardLogger } from '../logging/logger.ts'
import { computeBackoffDelay } from './backoff.ts'
import {
  classifyNonRetryable,
  describeNonRetryable,
  spawnErrno,
  type ProcessFailure,
} from './failure.ts'
import type { Scheduler, TimerHandle } from './scheduler.ts'

/** Ganchos que o orcamento notifica. Todos SINCRONOS, por Q-5. */
export interface RestartBudgetHooks {
  onTerminated?(info: { readonly description: string; readonly willRetry: boolean }): void
  onFailed?(failure: ProcessFailure): void
  onRetryScheduled?(info: { readonly attempt: number; readonly delayMs: number }): void
}

export interface RestartBudgetDeps {
  /** Nome CURTO do processo. Entra na mensagem que pode ser mostrada ao dono. */
  readonly name: string
  readonly backoff: BackoffConfig
  readonly scheduler: Scheduler
  readonly random: () => number
  readonly log: GuardLogger
  readonly hooks: RestartBudgetHooks
  /** `true` quando a Fiber ja foi descartada: nada mais pode ser agendado. */
  isCancelled(): boolean
  /** O que correr quando o atraso passar. */
  runAttempt(): void
}

export interface RestartBudget {
  /**
   * Conclui uma tentativa.
   *
   * @param description texto ja pronto para o log.
   * @param cause erro que causou a terminacao, quando houve um (classifica o
   * nao-retryable). `undefined` = saida sem erro observavel.
   * @param uptimeMs quanto tempo a instancia que acabou esteve viva.
   */
  conclude(description: string, cause: unknown, uptimeMs: number): void
  /** Cancela (e esquece) o reinicio pendente. Idempotente. */
  cancelPending(): void
  /** Reinicios ja consumidos do orcamento. */
  readonly attempts: number
  /** Estado TERMINAL: a recuperacao cessou de vez. */
  readonly exhausted: boolean
  /** Causa do estado terminal, quando ha um. */
  readonly failure: ProcessFailure | undefined
}

export function createRestartBudget(deps: RestartBudgetDeps): RestartBudget {
  const { backoff, name, log, hooks } = deps

  let attempts = 0
  let exhausted = false
  let failure: ProcessFailure | undefined
  let restartTimer: TimerHandle | undefined

  const cancelPending = (): void => {
    if (restartTimer === undefined) return
    deps.scheduler.clearTimeout(restartTimer)
    restartTimer = undefined
  }

  /**
   * Entra em ESTADO TERMINAL.
   *
   * DIVERGENCIA DOCUMENTADA (nao "corrigir" de volta): a tabela do cliente MCP
   * descreve `reconnect.maxAttempts` como cessando a recuperacao E "desregistando
   * ativamente o plugin". A superficie tipada desta distribuicao NAO expoe
   * auto-desregisto: `Context` oferece `intercept`, `waterfall`, `parallel`, `on`,
   * `effect` e `get` -- nada que remova a propria Fiber. Em vez de inventar API
   * inexistente, implementa-se o que a superficie permite: um ESTADO TERMINAL
   * explicito e observavel (`exhausted`) mais um erro inequivoco no log. Falhar
   * alto e visivelmente e melhor do que reiniciar para sempre em silencio. Ver
   * README.md, "Divergencias assumidas".
   */
  const enterTerminalState = (terminal: ProcessFailure, logLine: string): void => {
    exhausted = true
    failure = terminal
    log.error(logLine)
    hooks.onFailed?.(terminal)
  }

  const conclude = (description: string, cause: unknown, uptimeMs: number): void => {
    /**
     * NAO-RETRYABLE SAI DO LOOP IMEDIATAMENTE, antes de tocar no orcamento.
     * `ENOENT` (binario ausente / fora do `PATH`) e `EACCES` (sem bit de
     * execucao) nao melhoram a decima tentativa; gastar o orcamento neles so
     * atrasa a mensagem que ja estava na primeira falha, e enche o log de
     * "reinicio agendado" que faz o operador procurar instabilidade quando o
     * problema e uma instalacao em falta.
     */
    const kind = cause === undefined ? undefined : classifyNonRetryable(cause)
    if (kind !== undefined) {
      hooks.onTerminated?.({ description, willRetry: false })
      enterTerminalState(
        { kind, message: describeNonRetryable(kind, name), retryable: false, errno: spawnErrno(cause) },
        `${description} Causa NAO-RETRYABLE (${kind}): a recuperacao automatica ` +
          'CESSA de imediato (estado terminal) sem consumir orcamento, porque ' +
          'tentar de novo produz exatamente o mesmo resultado.',
      )
      return
    }

    /**
     * O ORCAMENTO ZERA SO APOS UPTIME SAUDAVEL, e NUNCA "a cada sucesso".
     *
     * A diferenca separa um supervisor correcto de um que reinicia para sempre:
     * se o contador zerasse a cada arranque bem sucedido, um processo que morre
     * de forma fiavel aos cinco minutos reiniciaria indefinidamente, com o
     * backoff sempre de volta ao valor inicial e o `maxAttempts` sem qualquer
     * efeito. A janela e `resetAfterMs` — uma falha isolada ao fim de horas nao
     * gasta o orcamento reservado a crash-loops.
     */
    if (uptimeMs >= backoff.resetAfterMs) attempts = 0

    attempts += 1

    if (attempts > backoff.maxAttempts) {
      hooks.onTerminated?.({ description, willRetry: false })
      enterTerminalState(
        {
          kind: 'BUDGET_EXHAUSTED',
          message:
            `${name} falhou ${String(backoff.maxAttempts)} vezes seguidas e a recuperacao ` +
            'automatica parou. Verifique o diagnostico e volte a ligar quando estiver corrigido.',
          retryable: false,
        },
        `Orcamento de reinicios esgotado (${String(backoff.maxAttempts)}). ${description} ` +
          'Recuperacao automatica CESSADA em definitivo (estado terminal): ' +
          `o ${name} NAO volta a arrancar ate o plugin ser recarregado a mao. ` +
          'Esta distribuicao do Cordis nao expoe auto-desregisto do plugin.',
      )
      return
    }

    const delayMs = computeBackoffDelay(attempts, backoff, deps.random)

    hooks.onTerminated?.({ description, willRetry: true })

    log.warn(
      `${description} Reinicio ${String(attempts)}/${String(backoff.maxAttempts)} ` +
        `agendado para daqui a ${String(delayMs)} ms.`,
    )

    // RE-VERIFICACAO IMEDIATAMENTE ANTES DE AGENDAR. `isCancelled()` foi lido no
    // inicio do tratador de terminacao, mas entre esse instante e este ha logging
    // (e, num host real, ouvintes de terceiros) que pode desencadear o descarte da
    // Fiber. Sem esta segunda leitura, o disposer ja teria feito o seu
    // `cancelPending()` e mesmo assim ficaria um temporizador vivo a ressuscitar o
    // processo depois de DISPOSED.
    if (deps.isCancelled()) return

    hooks.onRetryScheduled?.({ attempt: attempts, delayMs })

    /**
     * REAGENDAMENTO FIRE-AND-FORGET -- e AQUI que mora o requisito duro (Q-5).
     * `conclude` retorna IMEDIATAMENTE: nunca `await sleep(...)`, nunca espera
     * pelo processo dentro de um ouvinte do Cordis. `ctx.parallel` aguarda o
     * retorno EXAUSTIVO de todos os subscritores e `ctx.waterfall` bloqueia a
     * cascata inteira -- reter um retorno a espera da rede congela o subsistema e
     * interrompe o ciclo de deducao do agente. (Precedente no proprio DSH: o
     * downlink em SSE esgotava as ~6 sessoes por origem do HTTP/1.1.)
     *
     * O handle e guardado e o disposer faz `cancelPending()` -- de outro modo,
     * descarregar o plugin deixaria um temporizador pendurado a ressuscitar o
     * processo depois da Fiber ja estar DISPOSED.
     */
    cancelPending()
    restartTimer = deps.scheduler.setTimeout((): void => {
      restartTimer = undefined
      deps.runAttempt()
    }, delayMs)
  }

  return {
    conclude,
    cancelPending,
    get attempts(): number {
      return attempts
    },
    get exhausted(): boolean {
      return exhausted
    },
    get failure(): ProcessFailure | undefined {
      return failure
    },
  }
}
