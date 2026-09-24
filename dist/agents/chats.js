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
import { isAbsolute } from 'node:path';
import { assistenteDeEvento } from "./metrics.js";
import { nomeDeWorktreeValido } from "./worktrees.js";
import { createUlidFactory } from "../ulid.js";
/* ========================================================================== */
/* Validacao (S6 host — a mesma "texto limpo" do codec)                        */
/* ========================================================================== */
/** Teto do prompt: o do CONTRATO CONGELADO (`prompt: string limpo <=4096`). */
export const LIMITE_PROMPT_CHARS = 4096;
/**
 * "Texto limpo" na semantica EXATA do codec (`isCleanText` de
 * `src/ipc/channel.ts:269-276`): nao vazio, dentro do teto, sem NENHUM
 * caractere de controlo (< 0x20 ou 0x7f — o `\n` incluido). Revalidado aqui
 * em host (S6): o worker ja recusou, o codec ja recusou, e mesmo assim o
 * efeito so corre com um prompt desta forma.
 */
export function promptDeChatValido(prompt) {
    if (typeof prompt !== 'string')
        return false;
    if (prompt.length === 0 || prompt.length > LIMITE_PROMPT_CHARS)
        return false;
    for (let i = 0; i < prompt.length; i += 1) {
        const code = prompt.charCodeAt(i);
        if (code < 0x20 || code === 0x7f)
            return false;
    }
    return true;
}
/**
 * Erro honesto da tarefa de chat. `message` e S3-segura (mostravel ao dono);
 * `detail` e diagnostico bruto SO para o log; `sessionId` viaja quando a
 * sessao CHEGOU a nascer (a lacuna da submissao e o caso canonico).
 */
export class ChatError extends Error {
    name = 'ChatError';
    code;
    detail;
    sessionId;
    // Campos a mao (strip-only mode — a mesma regra de `src/errors.ts`).
    constructor(code, mensagem, opts) {
        super(mensagem);
        this.code = code;
        this.detail = opts?.detail;
        this.sessionId = opts?.sessionId;
    }
}
/**
 * O texto mostravel de uma recusa do harness, MAPEADO PELO `code` do
 * `RemoteError` (`packages/typert/protocol/src/types.ts:64-77`): a mensagem
 * crua do harness (`gateway/internal` concatena `String(error)`) pode citar
 * caminhos e NUNCA sobe (S3). Codigos conhecidos ganham texto accionavel; o
 * resto cai no generico honesto ("detalhe no log").
 */
export function textoDeRecusaDeSubmissao(error) {
    const code = typeof error === 'object' && error !== null ? error.code : undefined;
    switch (code) {
        case 'session/model-unavailable':
            return 'nenhum adaptador serve o modelo desta sessao; escolha um modelo na Web UI e tente de novo.';
        case 'session/not-found':
            return 'o harness nao encontrou a sessao criada.';
        case 'session/agent-busy':
            return 'o agente recusou o prompt (ocupado ou indisponivel neste momento).';
        case 'gateway/bad-request':
            return 'o conteudo do prompt foi recusado pelo harness.';
        case 'session/attachment-invalid':
            return 'o harness recusou o conteudo do prompt.';
        default:
            return 'falha ao submeter o prompt (detalhe no log do plugin).';
    }
}
export function criarServicoDeChats(deps) {
    const ulid = createUlidFactory(deps.now);
    /** O cwd ABSOLUTO da sessao: o worktree indicado, ou a raiz de trabalho. */
    const resolverCwd = (pedido) => {
        if (pedido.worktree !== undefined) {
            if (!nomeDeWorktreeValido(pedido.worktree)) {
                // Revalidacao S6: fora da gramatica fechada nao e "indisponivel" — e
                // NOME INVALIDO (um codigo proprio, nunca um motivo enganoso).
                throw new ChatError('CHAT_WORKTREE_INVALIDO', 'o nome do worktree indicado e invalido (so minusculas, digitos e hifen; 1..40).');
            }
            const worktrees = deps.worktrees();
            if (worktrees === undefined) {
                throw new ChatError('CHAT_HARNESS_AUSENTE', 'o worktree indicado nao esta disponivel nesta instalacao.');
            }
            if (!worktrees.existe(pedido.worktree)) {
                // A worktree e criada pelo `/worktree`; o chat NUNCA a cria sozinho
                // (a criacao e uma capacidade com nonce proprio).
                throw new ChatError('CHAT_WORKTREE_INEXISTENTE', `o worktree "${pedido.worktree}" ainda nao existe; cria-o primeiro com /worktree.`);
            }
            return worktrees.caminhoDe(pedido.worktree);
        }
        const baseDir = deps.baseDir();
        if (baseDir === undefined) {
            throw new ChatError('CHAT_HARNESS_AUSENTE', 'o harness nao esta disponivel para criar chats (sem raiz de trabalho).');
        }
        return baseDir;
    };
    return {
        async criar(pedido, opts) {
            // 1. VALIDACAO (S6 host) antes de tocar no harness.
            if (!promptDeChatValido(pedido.prompt)) {
                throw new ChatError('CHAT_PROMPT_INVALIDO', 'o prompt e invalido (texto limpo, 1..4096 caracteres).');
            }
            const cwd = resolverCwd(pedido);
            if (!isAbsolute(cwd)) {
                // `sessions.create` LANCA com `meta.cwd` relativo
                // (`packages/core/session/src/index.ts:958-968`): falha-se ANTES, com
                // um codigo honesto nosso em vez do throw do store.
                throw new ChatError('CHAT_CWD_INVALIDO', 'o diretorio de trabalho do chat nao e absoluto.');
            }
            const sessoes = deps.sessoes();
            if (sessoes === undefined) {
                throw new ChatError('CHAT_HARNESS_AUSENTE', 'o harness nao esta disponivel para criar chats.');
            }
            // 2. A SESSAO REAL (`ctx.sessions.create`) — cwd ABSOLUTO no meta.
            let sessionId;
            try {
                const sessao = sessoes.create(undefined, { meta: { cwd } });
                sessionId = sessao.id;
            }
            catch (error) {
                throw new ChatError('CHAT_SESSAO_FALHOU', 'nao foi possivel criar a sessao do chat (detalhe no log do plugin).', { detail: String(error) });
            }
            // 3. A SUBMISSAO — a face do session-controller (a costura do topo). Se
            //    ela nao existir nesta composicao, a LACUNA e reportada com o id da
            //    sessao para o dono continuar NA WEB UI — nunca se inventa submissao.
            const controlador = deps.controlador();
            if (controlador === undefined) {
                throw new ChatError('CHAT_SUBMISSAO_INDISPONIVEL', `sessao criada, mas a submissao nao esta disponivel nesta composicao; ` +
                    `continua o chat na Web UI (sessao ${sessionId}).`, { sessionId });
            }
            const requestId = ulid();
            const request = {
                requestId,
                sessionId,
                // `'queue'` = o primeiro turno de um chat novo (o `followup` do
                // harness: "Queue an ordinary follow-up turn and wake the driver").
                mode: 'queue',
                content: [{ type: 'text', text: pedido.prompt }],
            };
            try {
                await controlador.prompt(request, opts?.signal ?? new AbortController().signal);
            }
            catch (error) {
                const recusa = typeof error === 'object' && error !== null && 'code' in error
                    ? 'CHAT_SUBMISSAO_RECUSADA'
                    : 'CHAT_SUBMISSAO_FALHOU';
                throw new ChatError(recusa, textoDeRecusaDeSubmissao(error), {
                    detail: String(error),
                    sessionId,
                });
            }
            deps.log.info(`chat criado e prompt submetido (sessao ${sessionId}).`);
            return { sessionId, requestId };
        },
        async aguardarQuiete(sessionId) {
            const controlador = deps.controlador();
            if (controlador === undefined) {
                throw new ChatError('CHAT_HARNESS_AUSENTE', 'o harness nao esta disponivel para acompanhar o chat.', { sessionId });
            }
            let resolvido;
            try {
                resolvido = await controlador.resolveAgent(sessionId);
            }
            catch (error) {
                // `resolveAgent` nao deve lancar (devolve `{ error }`), mas um throw do
                // harness nao pode virar um erro sem dono: e um agente indisponivel.
                throw new ChatError('CHAT_AGENTE_INDISPONIVEL', 'o agente do chat nao ficou disponivel (detalhe no log do plugin).', { detail: String(error), sessionId });
            }
            if ('error' in resolvido) {
                throw new ChatError('CHAT_AGENTE_INDISPONIVEL', 'o agente do chat nao ficou disponivel (detalhe no log do plugin).', { detail: String(resolvido.error), sessionId });
            }
            // `whenIdle` (`packages/core/agent/src/runtime-types.ts:191`): resolve
            // quando a atividade do agente atinge a quiescencia — o fim do turno que
            // o nosso prompt abriu (e de qualquer trabalho que se tenha juntado).
            await resolvido.agent.whenIdle();
        },
        cancelar(sessionId) {
            const controlador = deps.controlador();
            if (controlador === undefined)
                return;
            try {
                controlador.cancel({ sessionId });
            }
            catch (error) {
                // Best-effort (o padrao de `src/agents/registry.ts`): um cancelamento
                // avariado nao pode rebentar o cancel do run.
                deps.log.error(`falha ao cancelar o turno do chat ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
        ultimaResposta(sessionId) {
            try {
                const sessao = deps.sessoes()?.get(sessionId);
                if (sessao === undefined)
                    return undefined;
                const eventos = sessao.snapshotEvents();
                for (let i = eventos.length - 1; i >= 0; i -= 1) {
                    const evento = eventos[i];
                    if (evento === undefined)
                        continue;
                    const dados = assistenteDeEvento(evento);
                    const blocos = dados?.message?.content;
                    if (blocos === undefined)
                        continue;
                    const texto = blocos
                        .filter((bloco) => bloco.type === 'text' && typeof bloco.text === 'string')
                        .map((bloco) => bloco.text)
                        .join(' ')
                        .trim();
                    if (texto.length > 0)
                        return texto;
                }
                return undefined;
            }
            catch (error) {
                deps.log.warn(`nao foi possivel ler a resposta do chat ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
        },
    };
}
//# sourceMappingURL=chats.js.map