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
import type { BackoffConfig } from '../config/schema.ts';
import type { GuardLogger } from '../logging/logger.ts';
import { type ProcessFailure } from './failure.ts';
import type { Scheduler } from './scheduler.ts';
/** Ganchos que o orcamento notifica. Todos SINCRONOS, por Q-5. */
export interface RestartBudgetHooks {
    onTerminated?(info: {
        readonly description: string;
        readonly willRetry: boolean;
    }): void;
    onFailed?(failure: ProcessFailure): void;
    onRetryScheduled?(info: {
        readonly attempt: number;
        readonly delayMs: number;
    }): void;
}
export interface RestartBudgetDeps {
    /** Nome CURTO do processo. Entra na mensagem que pode ser mostrada ao dono. */
    readonly name: string;
    readonly backoff: BackoffConfig;
    readonly scheduler: Scheduler;
    readonly random: () => number;
    readonly log: GuardLogger;
    readonly hooks: RestartBudgetHooks;
    /** `true` quando a Fiber ja foi descartada: nada mais pode ser agendado. */
    isCancelled(): boolean;
    /** O que correr quando o atraso passar. */
    runAttempt(): void;
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
    conclude(description: string, cause: unknown, uptimeMs: number): void;
    /** Cancela (e esquece) o reinicio pendente. Idempotente. */
    cancelPending(): void;
    /** Reinicios ja consumidos do orcamento. */
    readonly attempts: number;
    /** Estado TERMINAL: a recuperacao cessou de vez. */
    readonly exhausted: boolean;
    /** Causa do estado terminal, quando ha um. */
    readonly failure: ProcessFailure | undefined;
}
export declare function createRestartBudget(deps: RestartBudgetDeps): RestartBudget;
//# sourceMappingURL=retry.d.ts.map