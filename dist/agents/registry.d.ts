/**
 * =============================================================================
 * O REGISTRY DE AGENTES — o DISPATCHER da Onda 4.
 * =============================================================================
 *
 * O dono (atraves do bot, Onda 5) dispara um agente do DeepSeek Harness
 * escolhendo uma skill. Este modulo e a UNICA porta de saida: o dispatch
 * passa por allowlist (default deny), teto de runs concorrentes, audit de
 * cada accao, e o disposer mata tudo em LIFO.
 *
 * EFEMERO POR DESENHO: os runs vivem SÓ em memoria — nada disto persiste em
 * `state.json`. Um reinicio do DSH derruba os runs em curso (o disposer
 * cancela-os) e a lista recomeca vazia. Persistir runs exigiria persistir
 * também o que eles estao a fazer, e isso e um contrato novo — nao esta
 * nesta onda.
 *
 * O QUE NAO ESTA AQUI: a superficie (comandos do bot) e da Onda 5; o
 * transporte IPC (intents `agent.*`, mensagem `agent.report`) esta em
 * `src/contracts/ipc.ts`; a fiacao (ctx.subagents/agents/skills) esta em
 * `src/index.ts`. Este modulo recebe GETTERS lazy dos servicos do harness —
 * os mesmos que `authStack()` usa para a pilha de autenticacao: os servicos
 * podem aparecer depois do `apply()`, e uma captura no arranque seria uma
 * corrida. Ausentes no momento do despacho, o despacho e RECUSADO
 * (fail-closed).
 *
 * O PARENT DO RUN: `SubagentStartRequest.parent` e OBRIGATORIO no harness
 * ("The spawning agent. In-process providers derive workspace, lineage, and
 * delegation depth from its durable session state"). O plugin corre no
 * contexto do HOST, fora de qualquer agente — a unica fonte honesta de um
 * agente vivo de topo e `ctx.agents.roots()`. Resolve-se NO MOMENTO do
 * despacho (nunca no arranque): e o agente-racaiz do harness, e o cwd da
 * sessao dele e o workspace em que o filho nasce. Sem agente vivo, o
 * despacho e recusado — nao se inventa um pai.
 *
 * A SKILL ENTRA NO REQUEST COMO CONTEUDO DO PROMPT: `ctx.skills.get(nome,
 * { cwd, signal, scope: parent })` carrega a definicao (o corpo markdown) e
 * `renderHarnessSkill` produz o bloco `<skill_content>` CANONICO — o mesmo
 * que o harness injeta num agente que invoca a skill pelo caminho normal —
 * seguido da instrucao do dono. O `request` NUNCA recebe token de nada: o
 * filho roda com as permissoes do HARNESS, e o unico conteudo nosso e texto
 * (S3: nada de segredos neste pipeline).
 * =============================================================================
 */
import type { AuditSink } from '../contracts/auth.ts';
import type { AgentRunReport } from '../contracts/ipc.ts';
import type { GuardLogger } from '../logging/logger.ts';
import { type ChatService, type PedidoDeChat } from './chats.ts';
import type { ColetorDeMetricas } from './metrics.ts';
import { type PedidoDeWorktree, type WorktreeService } from './worktrees.ts';
import type { HarnessAgentRegistry, HarnessSkillRegistry, HarnessSubagentRuntime } from './harness.ts';
/** O nome do provedor in-process do harness (config `providerName` do spawn). */
export declare const DEFAULT_PROVIDER_NAME = "spawn";
/**
 * Teto do historico em memoria. A lista e efemera e pequena; o teto existe
 * para o relatorio nao crescer sem fim num uso prolongado — o run terminal
 * MAIS ANTIGO sai quando o teto e atingido.
 *
 * E METADE de `MAX_RUNS_PER_REPORT` (o teto do canal, 64) DE PROPOSITO: com o
 * teto de `agents.maxRuns` tambem em 32 (assert), a tabela inteira — 32 vivos
 * + 32 terminais — cabe numa unica mensagem `agent.report`.
 */
export declare const MAX_RUNS_HISTORY = 32;
/**
 * Teto do resumo enviado ao dono. O `summary` vem do texto do MODELO (nunca
 * segredo — S3) e e mostrado no Telegram; o teto e o mesmo espirito do
 * `notify`: uma mensagem curta, nao a resposta inteira.
 */
export declare const MAX_SUMMARY_CHARS = 300;
/** Motivo da RECUSA SINCRONA de um despacho (a resposta do IPC usa-o). */
export type MotivoDeRecusa = 
/** A skill nao esta na allowlist (`config.agents.skills`) — default deny. */
'skill-nao-permitida'
/** O teto de runs concorrentes (`config.agents.maxRuns`) foi atingido. */
 | 'teto-atingido'
/** Harness indisponivel (subagents/agents/skills ausentes) no momento. */
 | 'harness-indisponivel';
export type VereditoDeDespacho = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly motivo: MotivoDeRecusa;
};
/** O pedido de dispatch, montado pela superficie (surface-ipc). */
export interface PedidoDeDespacho {
    /** A skill a disparar (kebab-case; a allowlist decide). */
    readonly skill: string;
    /** A instrucao do dono para o agente. */
    readonly prompt: string;
    /** A origem pre-formatada (`telegram:<id>`) — o que o audit grava. */
    readonly origem: string;
}
/**
 * O rotulo de `skill` de uma tarefa de chat no `AgentRunReport`.
 *
 * PORQUE `'novo-chat'` e nao a intent: o codec do report valida `skill` com a
 * gramatica kebab-case de skill (`buildAgentRun` -> `isSkillName`, a gramatica
 * PUBLICA do harness `^[a-z0-9]+(?:-[a-z0-9]+)*$` em `src/ipc/channel.ts`) —
 * `'chat.new'` tem ponto e rejeitaria a LINHA INTEIRA do report. O rotulo usa
 * o nome do COMANDO que o dono conhece (`/novo-chat`); a NATUREZA do run viaja
 * no campo `kind` (contrato congelado).
 */
export declare const ROTULO_TAREFA_CHAT = "novo-chat";
/** O rotulo de `skill` de uma tarefa de worktree (`/worktree`) — ver {@link ROTULO_TAREFA_CHAT}. */
export declare const ROTULO_TAREFA_WORKTREE = "worktree";
/** O pedido de uma tarefa de worktree (o `worktree.create` + a origem do audit). */
export interface PedidoDeTarefaWorktree extends PedidoDeWorktree {
    /** A origem pre-formatada (`telegram:<id>`) — o que o audit grava. */
    readonly origem: string;
}
/** Motivo de RECUSA SINCRONA de uma tarefa (a resposta do IPC usa-a). */
export type MotivoDeRecusaDeTarefa = 
/** O teto de runs concorrentes (`config.agents.maxRuns`) foi atingido. */
'teto-atingido'
/** Harness indisponivel (chats/worktrees ausentes) ou pedido invalido no host. */
 | 'tarefa-indisponivel';
/**
 * O veredito de uma tarefa. `jaExistia` e o NOOP honesto do `worktree.create`:
 * o worktree pedido ja esta la ("ja estava no estado pedido" — e nada foi
 * destruido, a regra eterna).
 */
export type VereditoDeTarefa = {
    readonly ok: true;
    readonly jaExistia?: boolean;
} | {
    readonly ok: false;
    readonly motivo: MotivoDeRecusaDeTarefa;
};
/**
 * A porta de SAIDA das tarefas novas (chat/worktree) — a mesma disciplina do
 * `AgentRegistry` (veredito sincrono, efeito assincrono, relatorio honesto),
 * numa interface PROPRIA para o contrato de `AgentRegistry` nao mexer: quem
 * so conhece dispatch de subagentes continua a compilar intocado.
 */
export interface TarefasHost {
    /** `chat.new`: cria a sessao e submete o prompt (o efeito corre depois do ack). */
    novoChat(pedido: PedidoDeChat): VereditoDeTarefa;
    /** `worktree.create`: cria a worktree git (o efeito corre depois do ack). */
    novoWorktree(pedido: PedidoDeTarefaWorktree): VereditoDeTarefa;
}
export interface AgentRegistryDeps {
    /** A allowlist de skills disparaveis (config `agents.skills`). VAZIA = nada. */
    readonly skillsPermitidas: readonly string[];
    /** Teto de runs CONCORRENTES (config `agents.maxRuns`; o assert impoe 1..32). */
    readonly maxRuns: number;
    /** O provedor do harness (`'spawn'` — in-process, sessao fresca). */
    readonly providerName: string;
    /** GETTERS LAZY dos servicos — nunca capturados no arranque (ver o cabecalho). */
    readonly subagents: () => HarnessSubagentRuntime | undefined;
    readonly agentesDoHarness: () => HarnessAgentRegistry | undefined;
    readonly skillsDoHarness: () => HarnessSkillRegistry | undefined;
    /** Onde cada despacho/cancelamento/fim e contado. */
    readonly audit: Pick<AuditSink, 'append'>;
    readonly log: GuardLogger;
    /** Relogio injetado (04-TESTES.md 8.1): nunca `Date.now` direto. */
    readonly now: () => number;
    /**
     * Difusao do relatorio ao worker (best-effort — o canal pode estar em
     * baixo). Chamado em CADA transicao terminal: `agent.report` proativo.
     */
    readonly enviarRelatorio?: ((relatorio: AgentRunReport[]) => void) | undefined;
    /**
     * EMENDA ONDA-3-HOST-TAREFAS: o servico de CHATS (a costura de
     * `src/agents/chats.ts`). AUSENTE, `novoChat` recusa (fail-closed).
     */
    readonly chats?: (() => ChatService | undefined) | undefined;
    /** O servico de WORKTRETS (`src/agents/worktrees.ts`). AUSENTE, `novoWorktree` recusa. */
    readonly worktrees?: (() => WorktreeService | undefined) | undefined;
    /**
     * O coletor de METRICAS REAIS (`src/agents/metrics.ts`). AUSENTE, o campo
     * `metrics` do report e OMITIDO — nunca estimado.
     */
    readonly metricas?: (() => ColetorDeMetricas | undefined) | undefined;
}
export interface AgentRegistry {
    /**
     * Decide o despacho de forma SINCRONA e arranca o run em segundo plano.
     *
     * As recusas de POLITICA (allowlist, teto, harness ausente) sao sincronas —
     * a superficie responde-as no proprio tick. O que e assincrono (carregar a
     * skill, o `start()` do harness) corre depois do ack: uma falha ai nao
     * desfaz o ack — o run nasce e termina `failed` com o motivo no `summary`,
     * e o relatorio (difusao) diz a verdade ao dono.
     */
    despachar(pedido: PedidoDeDespacho): VereditoDeDespacho;
    /** A lista COMPLETA para o `agent.report` (vivos + terminais em memoria). */
    estado(): AgentRunReport[];
    /**
     * Cancela um run pelo id CURTO. `false` = id desconhecido (noop idempotente
     * — o mesmo espirito de um `stop` em `STOPPED`).
     */
    cancelar(agentId: string, origem: string): boolean;
    /**
     * Mata TUDO em LIFO (o mais recente primeiro), marca `cancelled` e liberta
     * os handles. SINCRONO: o cancelamento do harness e fire-and-forget (o
     * disposer nao pode devolver Promise — garantia LIFO da Fiber, Q-2).
     */
    dispose(): void;
}
export declare function createAgentRegistry(deps: AgentRegistryDeps): AgentRegistry & TarefasHost;
//# sourceMappingURL=registry.d.ts.map