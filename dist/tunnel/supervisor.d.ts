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
import type { Server } from 'node:http';
import type { AuditSink } from '../contracts/auth.ts';
import type { StateStore } from '../contracts/state.ts';
import type { TunnelConfig, TunnelDiscovery, TunnelReadiness, TunnelSnapshot } from '../contracts/tunnel.ts';
import type { Context } from '../dsh/adapter.ts';
import { type SupervisorDeps } from '../proc/supervisor.ts';
import { type ProbeTransport } from './probe.ts';
/** Timeout do warmup. `>= 30_000` por contrato (a URL levou 6-7 s em T0.2). */
export declare const DEFAULT_WARMUP_TIMEOUT_MS = 60000;
export interface TunnelSupervisorOptions {
    readonly ctx: Context;
    readonly config: TunnelConfig;
    /** PROVA de posse da origem, resolvida a CADA tentativa (`originPortOfOwnServer`). */
    resolveOrigin(): Server;
    /** Porta livre para o servidor de metricas. Escolhida por nos, nunca pelo default. */
    allocateMetricsPort(): number;
    /** `newCanaryToken`: sufixo aleatorio do canario (CSPRNG real, fixo no teste). */
    readonly probe: {
        readonly transport: ProbeTransport;
        newCanaryToken(): string;
        readonly apiReadPath?: string | undefined;
    };
    readonly discovery: TunnelDiscovery;
    readonly readiness: TunnelReadiness;
    readonly store: StateStore;
    /**
     * A ALLOWLIST VIVA DE `Host` E DE `Origin` — o `TunnelOriginRegistry` de T3.3
     * (`src/http/session-auth.ts`), visto so pelo lado que ESCREVE.
     *
     * >>> SEM ISTO O PRODUTO NAO FUNCIONA PELO TUNEL. <<< L2.5 (`Host`) e a
     * allowlist de `Origin` do handshake de WebSocket sao construidas a partir de
     * `tunnelOrigin.current()`. Ate a costura da Onda 3 o UNICO publicador era o
     * consumo do `RestrictExposureIntent`, que RETIRA a origem: ninguem a punha,
     * logo o nome publico do tunel nunca constava da allowlist e o gate recusava
     * com 403 tudo o que vinha pela borda.
     *
     * >>> E A RETIRADA VALE TANTO COMO A ENTRADA. <<< Uma entrada morta nesta
     * allowlist e um BYPASS: um nome `*.trycloudflare.com` derrubado volta a ser
     * distribuido a outra pessoa, e um `Host` com o hostname antigo continuaria a
     * passar L2.5 depois de o nome deixar de nos pertencer. E por isso que a
     * publicacao nao esta escrita a mao em cada transicao mas DERIVADA do estado
     * observado — ver `syncTunnelOrigin` em {@link createTunnelSupervisor}.
     *
     * Tipo ESTRUTURAL e nao importado, como `sessions` aqui ao lado: `src/tunnel`
     * nao passa a depender de `src/http` por causa de um metodo.
     */
    readonly tunnelOrigin: {
        publish(origin: string | undefined): void;
    };
    /** Ponto de enganche da invalidacao; a fiacao no gate e de T3.3. */
    readonly sessions: {
        revokeAll(): void;
    };
    readonly audit: AuditSink;
    notifyOwner(message: string): void;
    readonly proc?: SupervisorDeps | undefined;
    readonly warmupTimeoutMs?: number | undefined;
}
export interface TunnelSupervisor {
    /**
     * Corre o probe e, SO se ele passar, faz `spawn`. NUNCA rejeita (uma recusa e um
     * snapshot em `FAILED`). Chamadas concorrentes partilham a MESMA promessa.
     */
    start(): Promise<TunnelSnapshot>;
    /** Paragem limpa e explicita. Sincrona. */
    stop(): void;
    /** Disposer SINCRONO e idempotente (Q-2). LIFO: TTL, processo, pidfile. */
    dispose(): void;
    snapshot(): TunnelSnapshot;
}
export declare function createTunnelSupervisor(options: TunnelSupervisorOptions): TunnelSupervisor;
//# sourceMappingURL=supervisor.d.ts.map