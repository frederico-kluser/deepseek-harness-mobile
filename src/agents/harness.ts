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

/* ========================================================================== */
/* EMENDA ONDA-2-CONTRATO-CAPACIDADES — os espelhos das CAPACIDADES NOVAS      */
/* ========================================================================== */
/**
 * Sessoes, submissao de chat e metricas — o corte MINIMO estrutural para
 * `chat.new` (uma sessao que CORRE um chat), `worktree.create` e o
 * `AgentRunReport.metrics` de `src/contracts/ipc.ts`.
 *
 * Fonte: o checkout do harness em `/home/ondokai/Projects/deepseek-harness`
 * (SOMENTE LEITURA), consultado e VERIFICADO neste commit — cada tipo abaixo
 * cita o seu file:line. Regra deste ficheiro: NUNCA inventar a API do harness;
 * o que o checkout nao confirmou fica registado como LACUNA (ver
 * {@link HarnessSessionSubmitFace}) em vez de ser inventado. ZERO imports de
 * `@deepseek-ai/*` — so tipos estruturais.
 */

/* --- 1. CRIACAO DE SESSAO (`ctx.sessions.create`) ------------------------- */

/**
 * A metadata de criacao de uma sessao (`CreateSessionOptions.meta`, espelho de
 * `packages/core/session/src/types.ts:150-157`; o `SessionHeader` que ela dobra
 * e `packages/core/session/src/types.ts:93`). O `cwd` tem de ser um caminho
 * ABSOLUTO — o store LANCA com `meta.cwd` relativo (`create` em
 * `packages/core/session/src/index.ts:958-968`, o `@throws` verificado) — e e
 * por isso que `chat.new`/`worktree.create` o compõem a partir do worktree.
 */
export interface HarnessSessionCreateMeta {
  /** Diretorio absoluto de trabalho da sessao (obrigatorio na pratica; ver acima). */
  readonly cwd?: string | undefined
  /** Sessao de onde esta nasceu (linhagem de fork/seed). */
  readonly parentSession?: string | undefined
  /** Epoch ms de criacao (o store preenche quando ausente). */
  readonly createdAt?: number | undefined
  /** `true` quando a sessao nasce com um prefixo herdado (fork). */
  readonly isSeeded?: boolean | undefined
  /** Classificacao de filho de subagente (so `'subagent'` no harness). */
  readonly origin?: 'subagent' | undefined
  /** Profundidade de delegacao (ausente = nivel topo). */
  readonly delegationDepth?: number | undefined
  /** Id do preset de agente com que a sessao foi composta. */
  readonly agentPreset?: string | undefined
}

/**
 * As opcoes de `create` (`CreateSessionOptions` de
 * `packages/core/session/src/types.ts:137`). Corte consumido: `meta`. O
 * original tambem tem `seed`/`inheritedEventCount` (:139/:145) — replay/fork —
 * que NAO sao consumidos por estas capacidades.
 */
export interface HarnessCreateSessionOptions {
  readonly meta?: HarnessSessionCreateMeta | undefined
}

/**
 * A sessao criada (`Session` do core — `packages/core/session/src/index.ts`),
 * no corte consumido: o `id` basta para a costura das ondas 3-4.
 */
export interface HarnessSession {
  readonly id: string
}

/**
 * O servico `ctx.sessions` (`SessionStore`, registado com `super(ctx,
 * 'sessions')` em `packages/core/session/src/index.ts:936`; classe em :908).
 * `create(id?, options?)` e `packages/core/session/src/index.ts:969` — "the
 * live session, already entered and announced"; omitindo `id`, o store cunha
 * `session-<n>`. LANCA com id duplicado, metadata invalida ou `meta.cwd`
 * relativo.
 */
export interface HarnessSessionsService {
  create(id?: string, options?: HarnessCreateSessionOptions): HarnessSession
}

/* --- 2. O CAMINHO DE SUBMISSAO (o chat CORRE de verdade) ------------------ */

/**
 * O resultado de um Remote call (`RemoteResult` de
 * `packages/typert/protocol/src/types.ts:75-77`). NOTA DE CORTE (como em
 * {@link HarnessPromptContentPart}): o contrato real tipa `error` como
 * `RemoteFailure` (`packages/typert/protocol/src/types.ts:64-77`, erro em :77)
 * — aqui alarga-se a `unknown`, direcao FAIL-SAFE que obriga a narrowing antes
 * de tocar no erro. NAO congelar "RemoteResult.error e unknown" como facto do
 * harness: o facto e `error: RemoteFailure`.
 */
export type HarnessRemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/**
 * Uma parte do conteudo de um prompt (`PromptContentPart` de
 * `packages/api/session-controller/src/types.ts:75-83`), no corte consumido:
 * texto e o essencial; `image`/`file` espelham a forma (os tipos de media e o
 * receipt sao branded no harness — aqui viajam string).
 */
export type HarnessPromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: string
    readonly data: string
    readonly name?: string | undefined
  }
  | { readonly type: 'file'; readonly receiptId: string }

/**
 * O input de `beginSubmission` (`BeginSubmissionInput` de
 * `packages/api/session-controller/src/client/contract/session.ts:32`), no
 * corte consumido: `mode` + `text` (o original tambem tem `attachments` e
 * `onRetire` — nao consumidos).
 */
export interface HarnessBeginSubmissionInput {
  /** `'queue'` acrescenta um turno; `'steer'` intercepta o que corre. */
  readonly mode: 'queue' | 'steer'
  /** O texto do prompt, exactamente como `prompt()` o vai enviar. */
  readonly text: string
}

/**
 * O handle de uma submissao (`SubmissionHandle` de
 * `packages/api/session-controller/src/client/contract/session.ts:44`):
 * `requestId` (:46) e a identidade do RPC do prompt (`SessionRequestId`,
 * branded — `packages/api/session-controller/src/types.ts:376`) e `abandon()`
 * (:48) e a saida pre-prompt quando o chamador nao chega a chamar `prompt()`.
 */
export interface HarnessSubmissionHandle {
  readonly requestId: string
  abandon(): void
}

/**
 * O caminho de SUBMISSAO de uma sessao — "beginSubmission equivalente", o que
 * faz o chat CORRER de verdade (espelho de `ISession` de
 * `packages/api/session-controller/src/client/contract/session.ts:63-92`;
 * `beginSubmission` em :77 e `prompt` em :86-92, com retorno
 * `Promise<RemoteResult<{ accepted: true }>>`).
 *
 * >>> LACUNA REGISTADA (NAO INVENTADA). <<< O `ctx.sessions.create()` devolve o
 * `Session` do CORE (`packages/core/session/src/index.ts:969`), que NAO expoe
 * `beginSubmission` — o espelho acima e o `ISession` do session-controller
 * (contrato de cliente). COMO o host compoe/obtem uma face de submissao em
 * processo (a partir de uma sessao criada ou de um agente vivo) e uma costura
 * das ondas 3-4, com o `user-rpc`/inbox do agente no fim do caminho
 * (`SessionPromptRequest`, `packages/api/session-controller/src/types.ts:313`);
 * nada disso foi decidido nem inventado aqui.
 */
export interface HarnessSessionSubmitFace {
  /** Regista o eco local ANTES do prompt; devolve a identidade que `prompt` leva. */
  beginSubmission(input: HarnessBeginSubmissionInput): HarnessSubmissionHandle
  /**
   * Envia o prompt para a sessao: `'queue'` acrescenta um turno, `'steer'`
   * intercepta o que corre. `requestId` e o do `beginSubmission` — um prompt
   * identificado que falha reforma o eco.
   */
  prompt(
    content: readonly HarnessPromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<HarnessRemoteResult<{ readonly accepted: true }>>
}

/* --- 3. AS METRICAS (session-stats + os eventos de usage) ----------------- */

/**
 * As metricas de sessao inteira (`SessionStatsProjection` de
 * `packages/session/session-stats/src/types.ts:22-39`): contagens e tempos de
 * parede dobrados do log duradouro completo — `turns`:24 (turnos com pelo
 * menos um `step/end`), `steps`:26 (steps fechados), `llmMs`:28 (`step/start`
 * -> `assistant/message`), `toolMs`:30 (`tool/call` -> `tool/result` por
 * callId), `ttftMs`:32 (step -> primeiro delta nao-vazio, sobre `ttftSteps`),
 * `ttftSteps`:34, `decodeMs`:36 (primeiro token -> `assistant/message`, sobre
 * os steps que tambem reportam output tokens), `decodeTokens`:38. Cada campo e
 * `0` ate ao primeiro evento que contribui. Sao ESTES os nomes que alimentam
 * `AgentRunReport.metrics` (`src/contracts/ipc.ts`).
 */
export interface HarnessSessionStatsProjection {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

/**
 * A contabilizacao de tokens de UMA chamada ao modelo (`TokenUsage` de
 * `packages/llm/llm/src/types.ts:162-176`: `inputTokens`:163, `outputTokens`:164,
 * `totalTokens?`:172, `cacheReadTokens?`:173, `cacheWriteTokens?`:174,
 * `reasoningTokens?`:175).
 *
 * CONTADORES DISJUNTOS (o JSDoc verificado em `packages/llm/llm/src/types.ts:156-161`):
 * `inputTokens` e o input NAO-cacheado; o cache viaja separado em
 * `cacheReadTokens`/`cacheWriteTokens` — NAO existe `cachedTokens` no harness
 * (o nome do pedido inicial foi corrigido para os nomes REAIS).
 */
export interface HarnessTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number | undefined
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
  reasoningTokens?: number | undefined
}

/**
 * O EVENTO de sessao que carrega o usage — o `assistant/message` de
 * `packages/core/session/src/types.ts:321-328` (`usage?: TokenUsage` em :327).
 * O JSDoc verificado (:313-315) e explicito: "Carries the step's `usage` ...
 * (there is no separate usage record)" — o usage NUNCA vem num resultado de
 * subagente (o `SubagentResult` de `packages/subagent/subagent/src/types.ts`
 * nao o tem), vive AQUI. Corte consumido: `turn`/`step`/`usage`; o resto do
 * evento (`message`, `stream`, `interrupted`) nao e consumido.
 */
export interface HarnessSessionUsageEvent {
  readonly turn: number
  readonly step: number
  readonly usage?: HarnessTokenUsage | undefined
}
