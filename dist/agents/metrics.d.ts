/**
 * =============================================================================
 * AS METRICAS REAIS POR TAREFA — o `AgentRunReport.metrics` (contrato aditivo).
 * =============================================================================
 *
 * ZERO metrica inventada: cada campo do `AgentRunMetrics`
 * (`src/contracts/ipc.ts`) vem de uma fonte REAL do harness, medida no seu
 * checkout (FONTE PRIMARIA), e o que nao existe e OMITIDO — nunca estimado:
 *
 *   1. CONTAGENS E TEMPOS (`turns`/`steps`/`llmMs`/`toolMs`/`ttftMs`/
 *      `ttftSteps`/`decodeMs`/`decodeTokens`) — a projecao `sessionStats` do
 *      harness (`SessionStatsProjection`,
 *      `packages/session/session-stats/src/types.ts:22-39`), lida em processo
 *      por `ctx.sessionProjections.stateOf(session, 'sessionStats')`
 *      (`packages/session/session-projection/src/index.ts:319-327`; a unidade e
 *      registada pelo plugin `session-stats` em
 *      `packages/session/session-stats/src/index.ts:18-29` e o estado dela e um
 *      SUPERCONJUNTO da projecao — `packages/session/session-stats/src/projection.ts:57-64`).
 *      Projecao nao registada (composicao sem o `session-stats`) = os 8 campos
 *      OMITIDOS, nunca zeros fabricados.
 *   2. TOKENS (`inputTokens`/`outputTokens`/`cacheReadTokens`/
 *      `cacheWriteTokens`) — o `TokenUsage` que viaja NO EVENTO
 *      `assistant/message` (`usage?: TokenUsage`,
 *      `packages/core/session/src/types.ts:321-328` — "Carries the step's
 *      `usage` ... (there is no separate usage record)"; forma em
 *      `packages/llm/llm/src/types.ts:156-176`). CONTADORES DISJUNTOS:
 *      `inputTokens` e o input NAO-cacheado e o cache viaja em
 *      `cacheReadTokens`/`cacheWriteTokens`. Cada campo so aparece se PELO
 *      MENOS UM evento o tiver reportado (um adapter que nao reporta usage
 *      nao produz zeros — produz ausencia). NUNCA vem no resultado de um
 *      subagente (`SubagentResult`, `packages/subagent/subagent/src/types.ts`,
 *      nao tem usage — facto congelado do contrato).
 *
 * QUEM TEM METRICAS:
 *   - tarefas de CHAT: a sessao criada por `chat.new` (leitura em tempo real a
 *     cada `agent.report`);
 *   - tarefas de WORKTREE: nada de medir numa criacao de diretorio — o bloco e
 *     OMITIDO (ausente = "o host nao mediu");
 *   - runs de SUBAGENTE (`agent.dispatch`): o handle `SubagentRun` expoe
 *     `id: SessionId` — "For a local run, this MUST equal the published child
 *     session id" (`packages/subagent/subagent/src/types.ts:308-314`) — logo,
 *     para o provedor in-process `spawn`, as metricas do FILHO sao lidas da
 *     sessao dele pela MESMA via. Um provedor remoto (id que nao e sessao) ou
 *     uma sessao ja descartada devolvem `undefined` -> OMITIDO, nunca estimado.
 *
 * S3: metricas sao numeros — nada aqui viaja para mensagens.
 * =============================================================================
 */
import type { AgentRunMetrics } from '../contracts/ipc.ts';
import type { HarnessSessionEvent, HarnessSessionProjections, HarnessSessionsService, HarnessSessionStatsProjection, HarnessSessionUsageEvent } from './harness.ts';
import type { GuardLogger } from '../logging/logger.ts';
/**
 * O `data` de um evento `assistant/message`, no corte consumido (o espelho
 * {@link HarnessSessionUsageEvent} de `src/agents/harness.ts`).
 */
export type DadosDoAssistant = HarnessSessionUsageEvent;
/**
 * O NARROWING obrigarorio do `data: unknown` do envelope de evento (a regra do
 * espelho: nada se congela sem medir). Devolve o corte consumido do
 * `assistant/message`, ou `undefined` para tudo o resto — e para qualquer
 * forma que nao a esperada (fail-safe: evento torto nao e metrica).
 */
export declare function assistenteDeEvento(evento: HarnessSessionEvent): DadosDoAssistant | undefined;
/** Os 4 contadores de tokens, cada um PRESENTE so se reportado. */
export interface UsoDobrado {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
}
/**
 * Dobra o `usage` de TODOS os eventos `assistant/message` do log: soma real,
 * campo a campo, presente so quando PELO MENOS UM evento o reportou. Um valor
 * nao-finito ou negativo nao conta (o harness so publica contadores validos;
 * aqui e a rede de seguranca contra um evento torto).
 */
export declare function dobrarUsageDosEventos(eventos: readonly HarnessSessionEvent[]): UsoDobrado;
/**
 * Projeta o estado `sessionStats` no corte de `AgentRunMetrics`: os 8 campos,
 * cada um presente so se a projecao o trouxer como numero valido. O estado real
 * e um superconjunto (tem `lastTurn`/`openStep`/`pendingCalls` —
 * `packages/session/session-stats/src/projection.ts:57-64`); so os 8 sao
 * consumidos (contrato congelado).
 */
export declare function metricasDasEstatisticas(stats: HarnessSessionStatsProjection | undefined): Partial<AgentRunMetrics>;
export interface MetricasDeps {
    /** `ctx.sessions` — LAZY (a doutrina de `src/agents/registry.ts`). */
    readonly sessoes: () => HarnessSessionsService | undefined;
    /** `ctx.sessionProjections` — o registry de projecoes do harness. */
    readonly projecoes: () => HarnessSessionProjections | undefined;
    readonly log: GuardLogger;
}
export interface ColetorDeMetricas {
    /**
     * As metricas REAIS da tarefa ligada a `sessionId`, no instante da chamada.
     * `undefined` = nada medido (sessao ausente, projecao ausente, sem usage) —
     * o campo `metrics` do report fica entao OMITIDO. NUNCA lanca.
     */
    daSessao(sessionId: string | undefined): AgentRunMetrics | undefined;
}
export declare function criarColetorDeMetricas(deps: MetricasDeps): ColetorDeMetricas;
//# sourceMappingURL=metrics.d.ts.map