/**
 * =============================================================================
 * O ASSENTO DE SUBAGENTES DO HARNESS — tipos ESTRUTURAIS (espelho minimo).
 * =============================================================================
 *
 * ESTE FICHEIRO E O UNICO PONTO QUE DESCREVE A API DO HARNESS QUE A ONDA 4
 * CONSOME. NAO importa nenhum pacote `@deepseek-ai/*`: o plugin NAO depende
 * destes pacotes (zero deps novas — regra da onda), logo nao ha `.d.ts` de
 * tarball para espelhar em `types/**` (regra Q-1). O que ha e o FONTE do
 * harness, consultado em `/Volumes/Ext2TB/Projects/deepseek-harness`
 * (SOMENTE LEITURA), pinado aqui por ficheiro:
 *
 *   - `packages/subagent/subagent/src/types.ts`      — `SubagentStartRequest`,
 *     `SubagentRun`, `SubagentResult`, `SubagentStopReason` (e a gramatica do
 *     `parent: Agent` — "The spawning agent. In-process providers derive
 *     workspace, lineage, and delegation depth from its durable session
 *     state.") e `packages/subagent/subagent/src/index.ts` — o servico
 *     `ctx.subagents` (`SubagentRuntime`, registado com `super(ctx,
 *     'subagents')` — e ESTE o nome que o `inject` de `src/index.ts` usa);
 *   - `packages/subagent/subagent-spawn-in-process/src/index.ts` — o provedor
 *     `spawn`: child AGENTE NOVO, sessao FRESCA, zero contexto do pai
 *     (`inheritsParentContext = false`). Registado por config `providerName`
 *     (default `'spawn'`) — o nome que o registry passa a `start(name, ...)`;
 *   - `packages/core/agent/src/index.ts` — `ctx.agents` (`AgentRegistry`):
 *     `roots(): Agent[]` — "All live top-level agents in registration order"
 *     — e a unica fonte honesta de um `parent` para um plugin do host que nao
 *     corre dentro de nenhum agente;
 *   - `packages/skill/skill/src/index.ts` — `ctx.skills` (`SkillRegistry`):
 *     `get(name, { cwd, signal, scope })` -> `SkillDefinition | undefined`, e
 *     `renderSkillContent` (o bloco `<skill_content>`); a gramatica de nomes
 *     `^[a-z0-9]+(?:-[a-z0-9]+)*$`; o uso `agent.session.header.cwd`/`scope:
 *     agent` vem de `packages/skill/tool-skill/src/index.ts:172-198` (a forma
 *     CANONICA de carregar uma skill para UM agente).
 *
 * Os tipos sao o corte MINIMO consumido — nada mais. Quem os alterar tem de
 * voltar ao fonte acima e medir, nunca adivinhar (regra da onda: "NUNCA
 * invente a API do ctx.subagents").
 * =============================================================================
 */
/* ========================================================================== */
/* O RENDERIZADOR CANONICO DE UMA SKILL (espelho de renderSkillContent)       */
/* ========================================================================== */
/**
 * Renderiza uma skill carregada no bloco `<skill_content>` — o MESMO formato
 * que o harness injeta num agente quando uma skill e invocada
 * (`packages/skill/skill/src/index.ts` `renderSkillContent`). Usar o formato
 * canonico (em vez de colar o markdown cru) e o que torna o comportamento do
 * filho identico ao de um agente que invocou a skill pelo caminho normal.
 */
/** Escapa atributos de markup (o mesmo escape do renderizador do harness). */
function escapar(valor) {
    return valor.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
export function renderHarnessSkill(skill) {
    return [
        `<skill_content name="${escapar(skill.name)}">`,
        '<skill_resources>',
        `Resources for this skill are managed by the harness.`,
        '</skill_resources>',
        '',
        '<skill_instructions>',
        skill.content,
        '</skill_instructions>',
        '</skill_content>',
    ].join('\n');
}
//# sourceMappingURL=harness.js.map