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
/**
 * O NARROWING obrigarorio do `data: unknown` do envelope de evento (a regra do
 * espelho: nada se congela sem medir). Devolve o corte consumido do
 * `assistant/message`, ou `undefined` para tudo o resto — e para qualquer
 * forma que nao a esperada (fail-safe: evento torto nao e metrica).
 */
export function assistenteDeEvento(evento) {
    if (evento.type !== 'assistant/message')
        return undefined;
    const data = evento.data;
    if (typeof data !== 'object' || data === null)
        return undefined;
    return data;
}
const CAMPOS_DE_USO = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
];
/**
 * Dobra o `usage` de TODOS os eventos `assistant/message` do log: soma real,
 * campo a campo, presente so quando PELO MENOS UM evento o reportou. Um valor
 * nao-finito ou negativo nao conta (o harness so publica contadores validos;
 * aqui e a rede de seguranca contra um evento torto).
 */
export function dobrarUsageDosEventos(eventos) {
    const somas = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
    const visto = {
        inputTokens: false,
        outputTokens: false,
        cacheReadTokens: false,
        cacheWriteTokens: false,
    };
    for (const evento of eventos) {
        const usage = assistenteDeEvento(evento)?.usage;
        if (usage === undefined)
            continue;
        for (const campo of CAMPOS_DE_USO) {
            const valor = usage[campo];
            if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0)
                continue;
            somas[campo] += valor;
            visto[campo] = true;
        }
    }
    const saida = {};
    for (const campo of CAMPOS_DE_USO) {
        if (visto[campo])
            saida[campo] = somas[campo];
    }
    return saida;
}
const CAMPOS_DE_ESTATISTICAS = [
    'turns',
    'steps',
    'llmMs',
    'toolMs',
    'ttftMs',
    'ttftSteps',
    'decodeMs',
    'decodeTokens',
];
/**
 * Projeta o estado `sessionStats` no corte de `AgentRunMetrics`: os 8 campos,
 * cada um presente so se a projecao o trouxer como numero valido. O estado real
 * e um superconjunto (tem `lastTurn`/`openStep`/`pendingCalls` —
 * `packages/session/session-stats/src/projection.ts:57-64`); so os 8 sao
 * consumidos (contrato congelado).
 */
export function metricasDasEstatisticas(stats) {
    const saida = {};
    if (stats === undefined)
        return saida;
    for (const campo of CAMPOS_DE_ESTATISTICAS) {
        const valor = stats[campo];
        if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0)
            continue;
        saida[campo] = valor;
    }
    return saida;
}
export function criarColetorDeMetricas(deps) {
    return {
        daSessao(sessionId) {
            if (sessionId === undefined)
                return undefined;
            try {
                const sessoes = deps.sessoes();
                const projecoes = deps.projecoes();
                if (sessoes === undefined)
                    return undefined;
                const sessao = sessoes.get(sessionId);
                if (sessao === undefined)
                    return undefined;
                // (1) contagens/tempos: a projecao `sessionStats` do harness.
                const estatisticas = metricasDasEstatisticas(projecoes?.stateOf(sessao, 'sessionStats'));
                // (2) tokens: o usage que viaja nos eventos `assistant/message`.
                const uso = dobrarUsageDosEventos(sessao.snapshotEvents());
                const metricas = { ...uso, ...estatisticas };
                return Object.keys(metricas).length === 0 ? undefined : metricas;
            }
            catch (error) {
                // O relatorio NUNCA pode rebentar por uma leitura de metricas: sem
                // leitura, sem metricas (omitido) — e o log conta a historia.
                deps.log.warn(`metricas da sessao ${sessionId} ilegiveis: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
        },
    };
}
//# sourceMappingURL=metrics.js.map