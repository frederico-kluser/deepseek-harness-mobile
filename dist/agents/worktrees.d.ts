/**
 * =============================================================================
 * A CRIACAO DE WORKTRETS GIT — a capacidade `worktree.create` (/worktree).
 * =============================================================================
 *
 * O dono pede `/worktree <nome> [base]`; o HOST cria uma worktree git ISOLADA
 * para a tarefa correr sem tocar no checkout principal. Este modulo e so isso:
 * um comando `git worktree add` por CHILD PROCESS, com erros honestos e sem
 * NUNCA destruir nada que exista.
 *
 * ---------------------------------------------------------------------------
 * O LAYOUT (contrato: `<BASE_DIR>/../<repo>-worktrees/<nome>`)
 * ---------------------------------------------------------------------------
 * `BASE_DIR` e a raiz de trabalho do harness — o `cwd` do agente-raciz vivo
 * (a MESMA fonte que o dispatch de subagentes usa como workspace:
 * `src/agents/registry.ts`, `parent.session.header.cwd`). `<repo>` e o
 * `basename(BASE_DIR)`. As worktrees nascem entao como IRMAOS do projeto:
 *
 *     <BASE_DIR>/../<repo>-worktrees/<nome>
 *
 * que, para BASE_DIR=/home/u/Proj/repo, da /home/u/Proj/repo-worktrees/<nome> —
 * o mesmo padrao que o orquestrador deste repo usa para as suas worktrees.
 * DECISAO REGISTADA: "ou melhor encaixe, documenta" — o layout de irmaos e o
 * escolhido porque (a) segue a formula do contrato, (b) mantem as worktrees
 * FORA da arvore do git (o `git status` do projeto nao as ve) e (c) nao exige
 * nenhuma chave de config nova. O caminho e ABSOLUTO e so serve para
 * `meta.cwd` de sessoes (`src/agents/chats.ts`) — NUNCA para mensagens ao dono
 * (S3: um caminho absoluto numa mensagem que sai da maquina divulga o layout
 * do disco).
 *
 * ---------------------------------------------------------------------------
 * SEGURANCA / HONESTIDADE
 * ---------------------------------------------------------------------------
 * - NOME: gramatica FECHADA `/^[a-z0-9-]{1,40}$/` (o MESMO regex do codec,
 *   `src/ipc/channel.ts:337-338`, e do contrato congelado). O worker ja a
 *   valida; aqui e a REVALIDACAO de host (S6 — defesa em profundidade).
 * - BASE: texto limpo <= 256 (higiene do transporte e do codec,
 *   `src/ipc/channel.ts:514`); aqui valida-se alem disso a higiene de REF do
 *   git (sem espacos, sem controlo, sem `-` inicial — bloqueia inject de
 *   opcoes via positional —, sem `..`, sem `@{`, sem sufixo `.lock`). O
 *   comando corre SEM shell (`argv` do `SubprocessSpawnSpec`, que "is never
 *   shell-interpreted" — espelho em `types/dsh-subprocess/types.d.ts`), logo a
 *   inject de comando nao existe; o que se defende e a inject de OPCOES.
 * - NUNCA destruir: se o caminho ja existe, o resultado e `WORKTREE_ALREADY_EXISTS`
 *   (o run de tarefa responde `noop` ao dono — "ja estava no estado pedido").
 *   Nenhum `git worktree remove/prune`, nenhum `rm`, em nenhhum caminho.
 * - SUBPROCESSO: o padrao do repo (`src/proc/*`) — o assento `ctx.subprocess`
 *   (`spawn(spec: SubprocessSpawnSpec) -> SubprocessHandle`, o mesmo de
 *   `src/proc/supervisor.ts:264`), com `graceMs` + `terminate()` tree-scoped e
 *   o `AbortSignal` do run a matar o `git` no cancelamento. `env` e minimo:
 *   `GIT_TERMINAL_PROMPT=0` para o git NUNCA ficar pendurado num prompt de
 *   credenciais (um child pendurado e um run 'running' eterno).
 * - PRAZO: o chamador manda o `signal` (cancel do run); alem dele ha um teto
 *   proprio ({@link WORKTREE_TIMEOUT_MS}) — "caller owns deadlines", mas um
 *   `git` pendurado num FS lento nao pode viver para sempre.
 * - ERROS: vocabulario FECHADO {@link WorktreeErrorCode} (`WORKTREE_*`, no
 *   estilo dos codigos estaveis de `src/errors.ts`), mensagem PT e S3-segura
 *   (sem caminhos), diagnostico bruto no campo `detail` — SO para o log.
 * =============================================================================
 */
import type { SubprocessHandle, SubprocessSpawnSpec } from '../dsh/adapter.ts';
import type { GuardLogger } from '../logging/logger.ts';
/**
 * Condicoes de `criar`, cada uma distinguivel por programa. FECHADO: um codigo
 * novo e mudanca de contrato (o summary do run e a UI renderizam por codigo).
 *
 *   - `WORKTREE_INVALID_NAME`      — nome fora de `/^[a-z0-9-]{1,40}$/`;
 *   - `WORKTREE_INVALID_BASE`      — ref de partida fora da higiene de ref;
 *   - `WORKTREE_ALREADY_EXISTS`    — o caminho ja existe; NADA foi destruido;
 *   - `WORKTREE_UNAVAILABLE`       — harness sem subprocesso/raiz de trabalho;
 *   - `WORKTREE_GIT_FAILED`        — o `git worktree add` saiu != 0 (ou o
 *                                    spawn falhou); `detail` leva o stderr;
 *   - `WORKTREE_CANCELLED`         — o `signal` do chamador abortou em curso;
 *   - `WORKTREE_TIMEOUT`           — o `git` nao terminou no prazo proprio.
 */
export type WorktreeErrorCode = 'WORKTREE_INVALID_NAME' | 'WORKTREE_INVALID_BASE' | 'WORKTREE_ALREADY_EXISTS' | 'WORKTREE_UNAVAILABLE' | 'WORKTREE_GIT_FAILED' | 'WORKTREE_CANCELLED' | 'WORKTREE_TIMEOUT';
/**
 * Erro honesto da criacao de worktree.
 *
 * `message` e MOSTRAVEL (vai para o `summary` do run, que o Telegram mostra):
 * por isso e S3-segura — nunca caminho absoluto, nunca segredo, nunca o stderr
 * cru do git (que cita caminhos). O diagnostico bruto viaja em `detail`, que SO
 * vai para o log local.
 */
export declare class WorktreeError extends Error {
    readonly name = "WorktreeError";
    readonly code: WorktreeErrorCode;
    /** Diagnostico bruto (pode conter caminhos): SO o log o pode ver (S3). */
    readonly detail: string | undefined;
    constructor(code: WorktreeErrorCode, mensagem: string, detail?: string);
}
/**
 * A gramatica FECHADA do nome: `/^[a-z0-9-]{1,40}$/`. O MESMO regex do codec
 * (`src/ipc/channel.ts:337-338`) e do contrato congelado — copiado de
 * proposito (revalidacao de host = defesa em profundidade; um codec avariado
 * nao chega a mandar o `git` correr).
 */
export declare function nomeDeWorktreeValido(nome: unknown): nome is string;
/** Teto da ref de partida (a higiene de TRANSPORTE e `src/ipc/channel.ts:140`). */
export declare const LIMITE_BASE_CHARS = 256;
/**
 * Higiene de REF do git para a base de partida (alem da higiene de transporte
 * `texto limpo <= 256`, que o codec ja fez em `src/ipc/channel.ts:514`):
 * minusculas/maiusculas/digitos/`._/-`, 1..256, sem `-` inicial (inject de
 * opcoes no positional), sem `..`, sem `@{`, sem `/` inicial ou final, sem
 * `.` inicial nem sufixo `.lock` (as regras duras do `git check-ref-format`).
 * `HEAD` (o default) passa; `feature/x` passa; `--upload-pack=x` NAO passa.
 */
export declare function baseDeWorktreeValida(base: unknown): base is string;
/** A ref de partida quando o dono nao indica nenhuma. */
export declare const BASE_PREDEFINIDA = "HEAD";
/** Grace da terminacao do `git` (SIGTERM -> graceMs -> SIGKILL, tree-scoped). */
export declare const WORKTREE_GRACE_MS = 5000;
/** Teto do `git worktree add` (um FS lento nao pode manter um run eterno). */
export declare const WORKTREE_TIMEOUT_MS = 60000;
/**
 * O assento de subprocessos, no corte consumido: e o `SubprocessRuntime` do
 * harness (`ctx.subprocess`, `types/dsh-subprocess/index.d.ts:49,80`), que
 * `src/proc/supervisor.ts:264` ja usa como `ctx.subprocess.spawn(spec)`.
 * Aqui e um tipo proprio para o teste injetar o duble SEM fingir o Context.
 */
export interface AssentoDeSubprocesso {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}
export interface WorktreeDeps {
    /** O assento `ctx.subprocess` — LAZY (a doutrina de `src/agents/registry.ts`). */
    readonly subprocess: () => AssentoDeSubprocesso | undefined;
    /**
     * `BASE_DIR` ABSOLUTO — a raiz de trabalho do harness (o cwd do agente-raciz
     * vivo; ver o cabecalho). Ausente => `WORKTREE_UNAVAILABLE` (fail-closed:
     * sem raiz nao ha git que valha).
     */
    readonly baseDir: () => string | undefined;
    readonly log: GuardLogger;
}
export interface PedidoDeWorktree {
    /** Nome curto (gramatica fechada) — vira `guard/<nome>` e `<repo>-worktrees/<nome>`. */
    readonly nome: string;
    /** Ref de partida opcional (default {@link BASE_PREDEFINIDA}). */
    readonly base?: string | undefined;
}
export interface WorktreeCriada {
    readonly nome: string;
    /** A branch criada: `guard/<nome>` (a `guard/` do contrato). */
    readonly branch: string;
    /** A ref de partida efetiva. */
    readonly base: string;
    /** Caminho ABSOLUTO da worktree — para `meta.cwd` de sessao; nunca para mensagens (S3). */
    readonly caminho: string;
}
export interface WorktreeService {
    /** O caminho ABSOLUTO onde o `nome` vive (ou viveria) — compose pura. */
    caminhoDe(nome: string): string;
    /** `true` quando ja ha algo nesse caminho (o pre-check "nunca destruir"). */
    existe(nome: string): boolean;
    /**
     * Cria a worktree: `git worktree add --branch guard/<nome> <caminho> <base>`.
     * LANCA {@link WorktreeError} — sempre com codigo estavel e mensagem S3-segura.
     */
    criar(pedido: PedidoDeWorktree, opts?: {
        readonly signal?: AbortSignal | undefined;
    }): Promise<WorktreeCriada>;
}
/**
 * A formula do contrato `<BASE_DIR>/../<repo>-worktrees/<nome>`, numa funcao
 * pura (e o unico sitio onde ela vive — `chats.ts` resolve o cwd da sessao por
 * aqui, nunca recompoe a formula).
 */
export declare function caminhoDeWorktree(baseDir: string, nome: string): string;
export declare function criarServicoDeWorktrees(deps: WorktreeDeps): WorktreeService;
//# sourceMappingURL=worktrees.d.ts.map