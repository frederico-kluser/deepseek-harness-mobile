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
import type { BackoffConfig } from '../config/schema.ts';
import type { Context, SubprocessHandle, SubprocessSpawnSpec } from '../dsh/adapter.ts';
import { type ProcessFailure } from './failure.ts';
import { type RestartBudgetHooks } from './retry.ts';
import { type ClockDeps } from './scheduler.ts';
import { type TreeKillDeps } from './tree-kill.ts';
export { createWorkerSupervisor, type WorkerSupervisor, type WorkerSupervisorOptions, } from './worker.ts';
/**
 * Tudo o que o supervisor vai buscar ao mundo exterior: o TEMPO
 * ({@link ClockDeps}, de `scheduler.ts`) e o SINAL ({@link TreeKillDeps}, de
 * `tree-kill.ts`). Nenhuma das duas costuras e definida aqui -- o supervisor
 * compoe-as, que e o que ele e.
 */
export interface SupervisorDeps extends ClockDeps, TreeKillDeps {
}
/** Dependencias reais (processo Node corrente). */
export declare const defaultSupervisorDeps: SupervisorDeps;
/** Ganchos do ciclo de vida. Todos SINCRONOS, por Q-5. */
export interface SupervisedProcessHooks extends RestartBudgetHooks {
    /** Corre logo apos cada `spawn`. E aqui que o pid vai para o pidfile. */
    onSpawned?(handle: SubprocessHandle): void;
}
/** Descricao completa de um processo a supervisionar. */
export interface SupervisedProcess extends SupervisedProcessHooks {
    /**
     * Nome CURTO, para o log e para a mensagem accionavel (`'worker'`,
     * `'cloudflared'`). NUNCA o `argv`: o `argv` traz caminhos absolutos e a
     * mensagem de falha pode ser mostrada ao dono.
     */
    readonly name: string;
    readonly backoff: BackoffConfig;
    /**
     * Monta o spec de UMA tentativa. E chamado a cada `spawn`, e nao uma vez, para
     * que um valor que muda entre tentativas (uma porta de metricas nova, a posse
     * do servidor de origem) seja resolvido no instante em que e usado.
     *
     * Lancar `SpawnSpecError` aqui e recusar a configuracao: o supervisor entra em
     * estado terminal `INVALID_SPEC` e NAO faz `spawn` nenhum.
     */
    buildSpec(signal: AbortSignal): SubprocessSpawnSpec;
    /**
     * Segredos a redigir das linhas de stdout/stderr encaminhadas para o log.
     *
     * FORNECEDOR e nao lista, pela mesma razao que `openAuditLog` o e: o conjunto
     * muda DEPOIS do arranque. Ver {@link StreamLogOptions.secrets}.
     */
    readonly secrets?: (() => readonly string[]) | undefined;
    /**
     * CANAL DE PROTOCOLO sobre os pipes do filho, quando ele tem um.
     *
     * Recebe o handle acabado de instanciar e devolve o DESARME SINCRONO. Corre no
     * MESMO ponto de {@link attachStreamLogging} e e desarmado no MESMO ponto —
     * fecho do processo ou substituicao/disposer — para que o canal nunca
     * sobreviva ao filho a que pertence.
     *
     * QUANDO PRESENTE, `stdout` DEIXA DE IR PARA O LOG: passa a ser deste
     * consumidor, porque a invariante S2 de `../contracts/ipc.ts` diz que ali so
     * viaja JSONL. `stderr` continua no log, exatamente como antes — e ele que
     * carrega TODO o texto humano do filho.
     *
     * PORQUE UM GANCHO NA SUPERFICIE GENERICA e nao codigo em `./worker.ts`: e
     * aqui que vive a garantia de ordenacao ("ligado antes de `onSpawned`,
     * desligado no fecho") e a garantia de que nunca ha um instante sem quem
     * drene. Um consumidor instalado por fora, em `onSpawned`, herdava so metade
     * dessas garantias.
     */
    readonly attachChannel?: ((handle: SubprocessHandle) => () => void) | undefined;
}
/** Superficie publica do supervisor. `dispose` e SINCRONO por contrato (Q-2). */
export interface ProcessSupervisor {
    /** Arranca o processo imediatamente (primeira instanciacao). */
    start(): void;
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
    restart(reason: string): void;
    /** Disposer SINCRONO: cancela reinicio, aborta e faz tree-kill. */
    dispose(): void;
    /** Reinicios ja consumidos do orcamento (observabilidade/testes). */
    readonly attempts: number;
    /** Estado TERMINAL: a recuperacao cessou de vez. */
    readonly exhausted: boolean;
    /** Causa do estado terminal, quando ha um. */
    readonly failure: ProcessFailure | undefined;
    /** Sinal do ciclo de vida: abortado no disposer. */
    readonly signal: AbortSignal;
}
/** Cria o supervisor de um processo longo. */
export declare function createProcessSupervisor(ctx: Context, target: SupervisedProcess, deps?: SupervisorDeps): ProcessSupervisor;
//# sourceMappingURL=supervisor.d.ts.map