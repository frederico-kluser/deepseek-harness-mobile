/**
 * =============================================================================
 * O CHAT REAL — a capacidade `chat.new` (/novo-chat, /novo-chat-wt).
 * =============================================================================
 *
 * O dono pede `/novo-chat <prompt>` (ou `/novo-chat-wt <worktree> <prompt>`); o
 * HOST cria UMA sessao do harness e SUBMETE o prompt inicial — o chat corre de
 * verdade. Este modulo e a costura da LACUNA registada em
 * `src/agents/harness.ts` ({@link HarnessSessionSubmitFace}).
 *
 * ---------------------------------------------------------------------------
 * A COSTURA (o caminho REAL medido no checkout do harness — FONTE PRIMARIA)
 * ---------------------------------------------------------------------------
 * O `ctx.sessions.create()` devolve o `Session` do CORE, que NAO expoe
 * `beginSubmission` (esse e o `ISession` de CLIENTE — o eco local de UI do
 * browser, `packages/api/session-controller/src/client/contract/session.ts:32-92`).
 * O caminho de submissao em processo — o fim do `SessionPromptRequest`
 * (`packages/api/session-controller/src/types.ts:313-321`) — e o handler de
 * HOST:
 *
 *   `ctx.sessionController.prompt(request, signal)`
 *   (`packages/api/session-controller/src/index.ts:346-350`)
 *     -> `SessionCommandController.prompt` (`.../commands.ts:299`)
 *       -> resolve o agente vivo/retoma a sessao criada
 *          (`.../agent.ts:170-172` -> `ctx.agents.resume`, :437 e :469;
 *          `observeSession` le sessoes ATTACHADAS —
 *          `packages/session-query/session-query/src/observation.ts:104-117`)
 *       -> `UserMessage` com source `user-rpc` (`{ kind: 'user', rpcId }`,
 *          commands.ts:327-331; augmentacao `MessageSourceMap` em
 *          `packages/api/session-controller/src/types.ts:378-383`)
 *       -> inbox do agente: `agent.followup(message)` / `agent.steer(message)`
 *          (commands.ts:360-361; verbos em
 *          `packages/core/agent/src/runtime-types.ts:222-231`).
 *
 * O `requestId` e "Client-minted" (types.ts:314) — em processo o host
 * cunha-o com a ULID do repo (`src/ulid.ts`). `mode: 'queue'` e o primeiro
 * turno de um chat novo (o `followup` do harness e "Queue an ordinary
 * follow-up turn and wake the driver" — runtime-types.ts:218-222).
 *
 * LACUNA RESTANTE (registada, nao inventada): numa composicao SEM o servico
 * `sessionController` a submissao em processo nao e alcancavel por este ctx —
 * a sessao e criada na mesma e o run reporta o id para o dono CONTINUAR NA
 * WEB UI ({@link ChatError} `CHAT_SUBMISSAO_INDISPONIVEL`). Nunca se inventa
 * uma submissao alternativa.
 *
 * ---------------------------------------------------------------------------
 * S3 / HONESTIDADE
 * ---------------------------------------------------------------------------
 * As mensagens de erro que sobem ao `summary` (Telegram) sao compostas pelo
 * host e nunca carregam caminhos, segredos nem o texto cru do erro do harness
 * (`gateway/internal` do harness concatena `String(error)`, que pode citar
 * caminhos — mapeia-se pelo `code`, e o bruto vai para o log).
 * =============================================================================
 */
import type { HarnessSessionController, HarnessSessionsService } from './harness.ts';
import type { WorktreeService } from './worktrees.ts';
import type { GuardLogger } from '../logging/logger.ts';
/** Teto do prompt: o do CONTRATO CONGELADO (`prompt: string limpo <=4096`). */
export declare const LIMITE_PROMPT_CHARS = 4096;
/**
 * "Texto limpo" na semantica EXATA do codec (`isCleanText` de
 * `src/ipc/channel.ts:269-276`): nao vazio, dentro do teto, sem NENHUM
 * caractere de controlo (< 0x20 ou 0x7f — o `\n` incluido). Revalidado aqui
 * em host (S6): o worker ja recusou, o codec ja recusou, e mesmo assim o
 * efeito so corre com um prompt desta forma.
 */
export declare function promptDeChatValido(prompt: unknown): prompt is string;
/**
 * Condicoes de `criar`/`aguardarQuiete`, FECHADAS e estaveis:
 *
 *   - `CHAT_PROMPT_INVALIDO`         — prompt fora de "texto limpo <= 4096";
 *   - `CHAT_WORKTREE_INVALIDO`       — nome de worktree fora de
 *                                      `/^[a-z0-9-]{1,40}$/` (revalidacao S6);
 *   - `CHAT_WORKTREE_INEXISTENTE`    — `/novo-chat-wt` aponta a um worktree
 *                                      que NAO existe (a worktree e criada
 *                                      pelo `/worktree`; o chat nao a cria);
 *   - `CHAT_CWD_INVALIDO`            — `meta.cwd` nao absoluto (o store do
 *                                      harness LANCA com relativo —
 *                                      `packages/core/session/src/index.ts:958-968`);
 *   - `CHAT_HARNESS_AUSENTE`         — services do harness ausentes;
 *   - `CHAT_SESSAO_FALHOU`           — `sessions.create` lancou;
 *   - `CHAT_SUBMISSAO_INDISPONIVEL`  — LACUNA: sessao criada mas sem face de
 *                                      submissao nesta composicao (o run
 *                                      reporta o id para continuar na Web UI);
 *   - `CHAT_SUBMISSAO_RECUSADA`      — o harness recusou o prompt (erro de
 *                                      negocio, mapeado pelo `code`);
 *   - `CHAT_SUBMISSAO_FALHOU`        — falha desconhecida na submissao;
 *   - `CHAT_AGENTE_INDISPONIVEL`     — `resolveAgent` nao devolveu agente.
 */
export type ChatErrorCode = 'CHAT_PROMPT_INVALIDO' | 'CHAT_WORKTREE_INVALIDO' | 'CHAT_WORKTREE_INEXISTENTE' | 'CHAT_CWD_INVALIDO' | 'CHAT_HARNESS_AUSENTE' | 'CHAT_SESSAO_FALHOU' | 'CHAT_SUBMISSAO_INDISPONIVEL' | 'CHAT_SUBMISSAO_RECUSADA' | 'CHAT_SUBMISSAO_FALHOU' | 'CHAT_AGENTE_INDISPONIVEL';
/**
 * Erro honesto da tarefa de chat. `message` e S3-segura (mostravel ao dono);
 * `detail` e diagnostico bruto SO para o log; `sessionId` viaja quando a
 * sessao CHEGOU a nascer (a lacuna da submissao e o caso canonico).
 */
export declare class ChatError extends Error {
    readonly name = "ChatError";
    readonly code: ChatErrorCode;
    readonly detail: string | undefined;
    readonly sessionId: string | undefined;
    constructor(code: ChatErrorCode, mensagem: string, opts?: {
        readonly detail?: string | undefined;
        readonly sessionId?: string | undefined;
    });
}
/**
 * O texto mostravel de uma recusa do harness, MAPEADO PELO `code` do
 * `RemoteError` (`packages/typert/protocol/src/types.ts:64-77`): a mensagem
 * crua do harness (`gateway/internal` concatena `String(error)`) pode citar
 * caminhos e NUNCA sobe (S3). Codigos conhecidos ganham texto accionavel; o
 * resto cai no generico honesto ("detalhe no log").
 */
export declare function textoDeRecusaDeSubmissao(error: unknown): string;
export interface PedidoDeChat {
    /** O prompt inicial — o que o chat VAI CORRER (ja validado em S6). */
    readonly prompt: string;
    /** O worktree onde a sessao nasce (`/novo-chat-wt`); ausente = raiz de trabalho. */
    readonly worktree?: string | undefined;
    /** A origem pre-formatada (`telegram:<id>`) — o que o audit grava. */
    readonly origem: string;
}
export interface ChatCriado {
    /** O id da sessao criada (`session-<n>` quando se deixa o store cunhar). */
    readonly sessionId: string;
    /** O `requestId` cunhado para a submissao (`user-rpc.rpcId` no harness). */
    readonly requestId: string;
}
export interface ChatService {
    /**
     * Cria a sessao (cwd ABSOLUTO) e submeta o prompt inicial. LANCA
     * {@link ChatError}; `CHAT_SUBMISSAO_INDISPONIVEL` carrega o `sessionId` da
     * sessao criada (a lacuna documentada — o dono continua na Web UI).
     */
    criar(pedido: PedidoDeChat, opts?: {
        readonly signal?: AbortSignal | undefined;
    }): Promise<ChatCriado>;
    /** Espera a quiescencia do agente (`whenIdle`) — o fim do turno submetido. */
    aguardarQuiete(sessionId: string): Promise<void>;
    /** Cancela o turno ativo (best-effort: NUNCA lanca). */
    cancelar(sessionId: string): void;
    /** A ultima resposta do assistente (para o `summary`); sem texto = `undefined`. */
    ultimaResposta(sessionId: string): string | undefined;
}
export interface ChatDeps {
    /** `ctx.sessions` — LAZY (a doutrina de `src/agents/registry.ts`). */
    readonly sessoes: () => HarnessSessionsService | undefined;
    /** `ctx.sessionController` — a face de submissao (a costura acima). */
    readonly controlador: () => HarnessSessionController | undefined;
    /** O servico de worktrees (so `caminhoDe`/`existe` — o chat NUNCA cria worktrees). */
    readonly worktrees: () => Pick<WorktreeService, 'caminhoDe' | 'existe'> | undefined;
    /** `BASE_DIR` ABSOLUTO — o cwd de um chat fora de worktree. */
    readonly baseDir: () => string | undefined;
    readonly log: GuardLogger;
    /** Relogio injetado (a ULID do `requestId` nunca le o relogio a frio). */
    readonly now: () => number;
}
export declare function criarServicoDeChats(deps: ChatDeps): ChatService;
//# sourceMappingURL=chats.d.ts.map