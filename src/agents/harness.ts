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

/**
 * Uma mensagem de conteudo `{ type: 'text', text }` (dsh-llm). O dispatch so
 * emite TEXTO; os outros tipos de bloco nao sao consumidos.
 */
export interface HarnessTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Porque um run de subagente terminou (o vocabulario do harness). */
export type HarnessStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** O resultado terminal de um run (`SubagentResult`). */
export interface HarnessSubagentResult {
  readonly output: readonly HarnessTextBlock[]
  /** NAO-assistant, livre de credenciais; teto 4096 bytes (contrato do harness). */
  readonly diagnostic?: string | undefined
  readonly stopReason: HarnessStopReason
}

/**
 * O handle publicado de um run one-shot (`SubagentRun`): `result` resolve com
 * o resultado terminal e `dispose()` cancela o trabalho restante e liberta o
 * handle ("Consumers await that result and must always dispose").
 */
export interface HarnessSubagentRun {
  readonly id: string
  readonly result: Promise<HarnessSubagentResult>
  dispose(): Promise<void>
}

/**
 * O servico `ctx.subagents` (`SubagentRuntime`), no corte consumido.
 * `start(name, request)` valida capacidades e despacha para o provedor; a
 * Promise REJEITA em falha de arranque (sem run publicado — nada a dispor).
 */
export interface HarnessSubagentRuntime {
  start(name: string, request: HarnessSubagentStartRequest): Promise<HarnessSubagentRun>
}

/**
 * O pedido de um run one-shot (`SubagentStartRequest`), no corte consumido.
 *
 * >>> SEGREDOS: `parent` e o AGENTE de quem o filho herda workspace, linhagem
 * e profundidade; o request NUNCA recebe token nem credencial de nenhum
 * sistema — o filho roda com as permissoes que o HARNESS lhe da. <<<
 */
export interface HarnessSubagentStartRequest {
  /** Rotulo curto persistido com o filho (a skill disparada). */
  readonly label?: string | undefined
  /** O conteudo entregue como mensagem de utilizador do filho. */
  readonly prompt: readonly HarnessTextBlock[]
  /** O agente que spawna (resolvido de `ctx.agents.roots()` no despacho). */
  readonly parent: HarnessAgent
  /** Cancelamento: disparado pelo cancel explicito e pelo disposer. */
  readonly signal: AbortSignal
}

/**
 * O agente vivo (`Agent`), no corte consumido: o `session.header.cwd` e o
 * workspace que o spawn in-process usa como cwd do filho, e o proprio objeto
 * `Agent` serve de `scope` do carregamento de skills.
 */
export interface HarnessAgent {
  readonly id: string
  readonly session: { readonly header: { readonly cwd: string } }
}

/** O servico `ctx.agents` (`AgentRegistry`), no corte consumido. */
export interface HarnessAgentRegistry {
  /** "All live top-level agents in registration order" — o parent do dispatch. */
  roots(): readonly HarnessAgent[]
}

/** A definicao carregada de uma skill (`SkillDefinition`), no corte consumido. */
export interface HarnessSkillDefinition {
  /** Kebab-case (a grammar valida o nome ao carregar). */
  readonly name: string
  readonly description: string
  /** O corpo markdown da skill — o que se injeta no prompt do filho. */
  readonly content: string
}

/** Opcoes de `ctx.skills.get` (`SkillViewOptions`), no corte consumido. */
export interface HarnessSkillViewOptions {
  /** O workspace do AGENTE-PAI (o cwd do filho sera o mesmo). */
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
  /** O agente-pai: o carregamento ve o catalogo na camada DELE. */
  readonly scope?: HarnessAgent | undefined
}

/** O servico `ctx.skills` (`SkillRegistry`), no corte consumido. */
export interface HarnessSkillRegistry {
  get(name: string, options: HarnessSkillViewOptions): Promise<HarnessSkillDefinition | undefined>
}

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
function escapar(valor: string): string {
  return valor.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

export function renderHarnessSkill(skill: HarnessSkillDefinition): string {
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
  ].join('\n')
}
